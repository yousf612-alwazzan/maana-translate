// Service worker: talks to the LLM providers, caches results, falls back between
// providers, and injects the content scripts on demand.

import { PRESETS, mergeSettings, resolveProvider, isUsable, langInfo } from './lib/presets.js';
import { streamChat, listModels } from './lib/providers.js';
import * as cache from './lib/cache.js';
import { textSystemPrompt, textUserMessage, imageSystemPrompt, imageUserMessage } from './lib/prompts.js';

const CONTENT_FILES = ['src/content/base.js', 'src/content/page.js', 'src/content/manga.js'];

// ---------- settings ----------

let settingsCache = null;
async function getSettings() {
  if (!settingsCache) {
    const { settings } = await chrome.storage.local.get('settings');
    settingsCache = mergeSettings(settings);
  }
  return settingsCache;
}
const cooldownUntil = new Map(); // provider id -> timestamp

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  settingsCache = null;
  cooldownUntil.clear(); // the user may have just fixed a key or a model
});

// ---------- provider selection, cooldowns, concurrency ----------

const slots = new Map(); // provider id -> { n, q }

function candidates(settings, vision) {
  const out = [];
  for (const id of settings.order) {
    const p = resolveProvider(id, settings);
    if (!isUsable(p)) continue;
    const model = vision ? p.visionModel || p.model : p.model;
    if (!model) continue;
    out.push({ ...p, model, reasoningEffort: p.reasoningFor(model) || undefined });
  }
  return out;
}

async function withSlot(p, signal, fn) {
  let s = slots.get(p.id);
  if (!s) slots.set(p.id, (s = { n: 0, q: [] }));
  if (s.n >= p.concurrency) await new Promise((r) => s.q.push(r));
  s.n++;
  try {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return await fn();
  } finally {
    s.n--;
    s.q.shift()?.();
  }
}

const RETRYABLE = new Set(['rate', 'server', 'network']);

function friendly(e, p) {
  const name = p?.name || '';
  switch (e?.kind) {
    case 'noprovider':
      return 'ما في مزود مربوط. افتح الإعدادات وأضف مفتاح.';
    case 'rate':
      return `خلص الحد المسموح عند ${name}. جرّب بعد شوي أو اربط مزود ثاني.`;
    case 'auth':
      return `المفتاح مرفوض عند ${name}. راجعه في الإعدادات.`;
    case 'origin':
      return 'Ollama رافض الإضافة. شغّله مع OLLAMA_ORIGINS=chrome-extension://* (التفاصيل في الإعدادات).';
    case 'network':
      return `ما قدرت أوصل لـ ${name}. تأكد من الاتصال.`;
    case 'refusal':
      return `${name} رفض يترجم هالمحتوى.`;
    default:
      return `${name}: ${e?.message || 'خطأ غير معروف'}`;
  }
}

// Try each usable provider in the user's order. `attempt(p)` streams with one
// provider and returns true when the whole job is finished.
async function runWithFallback({ vision, signal, send }, attempt) {
  const settings = await getSettings();
  if (!settings.consent) return { error: { kind: 'consent', message: 'وافق أول على إرسال المحتوى للمزود من صفحة الإعدادات.' } };
  const list = candidates(settings, vision);
  if (!list.length) return { error: { kind: 'noprovider', message: friendly({ kind: 'noprovider' }) } };

  let lastErr = null;
  let lastP = null;
  for (let round = 0; round < 2; round++) {
    for (const p of list) {
      if ((cooldownUntil.get(p.id) || 0) > Date.now()) continue;
      try {
        const finished = await withSlot(p, signal, () => attempt(p, settings));
        if (finished) return { provider: p.id, model: p.model };
        lastErr = null;
        lastP = p;
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        lastErr = e;
        lastP = p;
        // Rest a failing provider so every following request does not repeat the failure.
        // Limits and outages get the wait the provider asked for; a bad key or model rests longer.
        const wait = RETRYABLE.has(e.kind)
          ? Math.min(Math.max(e.retryAfter || 30, 5), 300)
          : e.kind === 'auth' || e.kind === 'origin' ? 180 : e.kind === 'refusal' ? 0 : 20;
        if (wait) cooldownUntil.set(p.id, Date.now() + wait * 1000);
        const next = list.find((x) => x.id !== p.id && (cooldownUntil.get(x.id) || 0) <= Date.now());
        if (next) {
          const why = e.kind === 'auth' ? `مفتاح ${p.name} مرفوض` : e.kind === 'rate' ? `خلص حد ${p.name}` : `${p.name} ما رد`;
          send({ type: 'info', message: `${why}، أكمل على ${next.name}.` });
        }
      }
    }
    // Everything is cooling down: wait for the soonest one if that is short.
    const soonest = Math.min(...list.map((p) => cooldownUntil.get(p.id) || 0));
    const wait = soonest - Date.now();
    if (round === 0 && wait > 0 && wait <= 12000) {
      await new Promise((r) => setTimeout(r, wait + 200));
      continue;
    }
    break;
  }
  if (lastErr) return { error: { kind: lastErr.kind || 'bad', message: friendly(lastErr, lastP) } };
  return { provider: lastP?.id, model: lastP?.model };
}

// ---------- stream parsers ----------

// Items look like "[[12]] translated text". An item is complete once the next
// marker shows up or the stream ends.
function markerParser(onItem) {
  let buf = '';
  let cur = null;
  const re = /\[\[(\d+)\]\]/;
  const step = (final) => {
    for (;;) {
      const m = re.exec(buf);
      if (cur === null) {
        if (!m) {
          if (final) buf = '';
          else if (buf.length > 40) buf = buf.slice(-40);
          return;
        }
        cur = +m[1];
        buf = buf.slice(m.index + m[0].length);
        continue;
      }
      if (m) {
        onItem(cur, buf.slice(0, m.index).trim());
        cur = +m[1];
        buf = buf.slice(m.index + m[0].length);
        continue;
      }
      if (final) {
        onItem(cur, buf.trim());
        buf = '';
        cur = null;
      }
      return;
    }
  };
  return { push: (d) => { buf += d; step(false); }, end: () => step(true) };
}

// Emits each complete top-level {...} object found in a stream of JSON text.
function jsonObjectParser(onObject) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let cur = '';
  return {
    push(delta) {
      for (const ch of delta) {
        if (depth === 0) {
          if (ch === '{') { depth = 1; cur = '{'; }
          continue;
        }
        cur += ch;
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try { onObject(JSON.parse(cur)); } catch { /* skip a malformed object */ }
            cur = '';
          }
        }
      }
    },
  };
}

// Turn a model's region object into { box:[x1,y1,x2,y2] in 0..1, kind, text }.
function normalizeRegion(obj, w, h) {
  if (!obj || typeof obj !== 'object') return null;
  const text = String(obj.text ?? obj.translation ?? '').trim();
  if (!text) return null;
  let x1, y1, x2, y2;
  const yx = obj.box_2d;
  const xy = obj.bbox_2d || obj.bbox || obj.box;
  if (Array.isArray(yx) && yx.length === 4) [y1, x1, y2, x2] = yx.map(Number);
  else if (Array.isArray(xy) && xy.length === 4) [x1, y1, x2, y2] = xy.map(Number);
  else if (obj.x1 != null) ({ x1, y1, x2, y2 } = obj);
  else return null;
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const max = Math.max(x1, y1, x2, y2);
  let sx = 1000, sy = 1000;
  if (max <= 1.0001) sx = sy = 1; // already 0..1
  else if (max > 1000) { sx = w; sy = h; } // pixel coordinates of the image we sent
  let box = [x1 / sx, y1 / sy, x2 / sx, y2 / sy].map((v) => Math.min(1, Math.max(0, v)));
  if (box[2] < box[0]) box = [box[2], box[1], box[0], box[3]];
  if (box[3] < box[1]) box = [box[0], box[3], box[2], box[1]];
  if (box[2] - box[0] < 0.004 || box[3] - box[1] < 0.004) return null;
  const k = String(obj.type || obj.kind || 'bubble').toLowerCase();
  const kind = ['bubble', 'caption', 'sign', 'sfx'].includes(k) ? k : 'bubble';
  return { box, kind, text };
}

// ---------- request handlers ----------

async function handleText(msg, send, signal) {
  const settings = await getSettings();
  const lang = langInfo(settings);
  const variant = `t2|${lang.key}|${settings.style}|${settings.extra}|`;
  const items = msg.items || [];
  const keys = await Promise.all(items.map((it) => cache.hashKey(variant + it.text)));
  const hits = await cache.getMany(keys);

  let remaining = [];
  items.forEach((it, i) => {
    const hit = hits.get(keys[i]);
    if (typeof hit === 'string') send({ type: 'item', id: it.id, text: hit });
    else remaining.push({ ...it, key: keys[i] });
  });
  if (!remaining.length) return send({ type: 'done', cached: true });

  const system = textSystemPrompt({ lang, style: settings.style, extra: settings.extra });
  const fresh = [];
  const result = await runWithFallback({ vision: false, signal, send }, async (p) => {
    const got = new Set();
    const byId = new Map(remaining.map((it) => [it.id, it]));
    const parser = markerParser((id, text) => {
      const it = byId.get(id);
      if (!it || got.has(id) || !text) return;
      got.add(id);
      fresh.push([it.key, text]);
      send({ type: 'item', id, text });
    });
    try {
      const stream = streamChat(p, {
        system,
        text: textUserMessage(remaining, msg.ctx),
        signal,
        lowThinking: settings.lowThinking,
      });
      for await (const delta of stream) parser.push(delta);
      parser.end();
    } finally {
      remaining = remaining.filter((it) => !got.has(it.id));
    }
    return true; // the model answered; anything it skipped is reported as missing
  });

  if (fresh.length) cache.putMany(fresh);
  send({ type: 'done', ...result, missing: remaining.map((it) => it.id) });
}

async function handleImage(msg, send, signal) {
  const settings = await getSettings();
  const lang = langInfo(settings);
  const key = await cache.hashKey(`i2|${lang.key}|${settings.style}|${settings.extra}|${msg.b64.length}|${msg.b64.slice(0, 20000)}|${msg.b64.slice(-4000)}`);
  const hit = (await cache.getMany([key])).get(key);
  if (Array.isArray(hit)) {
    for (const r of hit) send({ type: 'region', ...r });
    return send({ type: 'done', cached: true });
  }

  const regions = [];
  const result = await runWithFallback({ vision: true, signal, send }, async (p) => {
    regions.length = 0;
    const parser = jsonObjectParser((obj) => {
      const r = normalizeRegion(obj, msg.ctx.w, msg.ctx.h);
      if (!r) return;
      regions.push(r);
      send({ type: 'region', ...r });
    });
    const stream = streamChat(p, {
      system: imageSystemPrompt({ lang, style: settings.style, extra: settings.extra, boxStyle: p.boxStyle }),
      text: imageUserMessage(msg.ctx),
      image: { mime: msg.mime, b64: msg.b64 },
      signal,
      lowThinking: settings.lowThinking,
    });
    for await (const delta of stream) parser.push(delta);
    return true;
  });

  if (!result.error) cache.putMany([[key, regions]]);
  send({ type: 'done', ...result });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'maana') return;
  const aborts = new Map();
  port.onMessage.addListener((msg) => {
    if (msg.type === 'cancel') return void aborts.get(msg.reqId)?.abort();
    const ac = new AbortController();
    aborts.set(msg.reqId, ac);
    const send = (m) => {
      try { port.postMessage({ reqId: msg.reqId, ...m }); } catch { /* tab went away */ }
    };
    const job = msg.type === 'text' ? handleText(msg, send, ac.signal) : handleImage(msg, send, ac.signal);
    job
      .catch((e) => {
        if (e?.name !== 'AbortError') send({ type: 'done', error: { kind: 'bad', message: String(e?.message || e) } });
      })
      .finally(() => aborts.delete(msg.reqId));
  });
  port.onDisconnect.addListener(() => {
    for (const a of aborts.values()) a.abort();
  });
});

// ---------- tabs: inject, toggle, state ----------

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_FILES });
}

const CONSENT_MESSAGE = 'قبل أول ترجمة لازم توافق على إرسال المحتوى للمزود اللي تختاره. فتحت لك صفحة الإعدادات.';

async function setMode(tabId, mode, on) {
  if (on && !(await getSettings()).consent) {
    // Nothing is sent anywhere until the user has agreed in the popup or the settings page.
    chrome.runtime.openOptionsPage();
    return { error: CONSENT_MESSAGE, needConsent: true };
  }
  try {
    await inject(tabId);
  } catch {
    return { error: 'هالصفحة محمية من المتصفح وما تنترجم.' };
  }
  // The content scripts need the target language to know what to skip and which way text runs.
  const lang = langInfo(await getSettings());
  await chrome.tabs.sendMessage(tabId, { cmd: 'set', mode, on, lang }).catch(() => {});
  return { ok: true };
}

async function getState(tabId) {
  try {
    await inject(tabId);
    return await chrome.tabs.sendMessage(tabId, { cmd: 'state' }, { frameId: 0 });
  } catch {
    return { error: 'هالصفحة محمية من المتصفح وما تنترجم.' };
  }
}

async function toggle(tabId, mode) {
  const st = await getState(tabId);
  if (!st || st.error) return st;
  return setMode(tabId, mode, !st[mode]?.on);
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  const mode = command === 'translate-page' ? 'page' : command === 'translate-images' ? 'images' : null;
  if (!mode) return;
  const target = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (target?.id != null) toggle(target.id, mode);
});

// Sites the user asked to translate automatically.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url || !/^https?:/.test(tab.url)) return;
  const settings = await getSettings();
  const want = settings.autoSites[new URL(tab.url).hostname];
  if (!want) return;
  if (want === 'page' || want === 'both') await setMode(tabId, 'page', true);
  if (want === 'images' || want === 'both') await setMode(tabId, 'images', true);
});

// ---------- image fetch for the content script ----------

let ruleSeq = 0;

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Images on another origin cannot be read by the page. Fetch them here, and if
// the host refuses (hotlink protection), retry with the page as the Referer.
async function fetchImage(url, pageUrl) {
  const get = () => fetch(url, { credentials: 'include' }).catch(() => null);
  let res = await get();
  if ((!res || !res.ok) && pageUrl) {
    const id = 5000 + (ruleSeq++ % 400);
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [id],
        addRules: [{
          id,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: pageUrl }] },
          condition: {
            urlFilter: '|' + new URL(url).origin + '/',
            tabIds: [chrome.tabs.TAB_ID_NONE],
            resourceTypes: ['xmlhttprequest', 'other'],
          },
        }],
      });
      res = await get();
    } finally {
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
    }
  }
  if (!res || !res.ok) throw new Error('image fetch failed' + (res ? ' ' + res.status : ''));
  const blob = await res.blob();
  if (blob.size > 40e6) throw new Error('image too large');
  return { b64: toBase64(await blob.arrayBuffer()), mime: blob.type || 'image/jpeg' };
}

// ---------- one-shot messages from popup, options and content ----------

async function testProvider(id, draft) {
  const settings = await getSettings();
  const base = resolveProvider(id, settings, { ...draft, enabled: true });
  if (!isUsable(base)) throw Object.assign(new Error('ناقص: الرابط أو المفتاح أو اسم النموذج.'), { kind: 'bad' });
  const p = { ...base, reasoningEffort: base.reasoningFor(base.model) || undefined };
  let out = '';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45000);
  try {
    const stream = streamChat(p, {
      system: textSystemPrompt({ lang: langInfo(settings), style: settings.style, extra: settings.extra }),
      text: textUserMessage([{ id: 1, text: 'It was a piece of cake, so we hit the road early.' }], {}),
      signal: ac.signal,
      lowThinking: settings.lowThinking,
    });
    for await (const d of stream) out += d;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('ما رد خلال 45 ثانية.');
    throw new Error(friendly(e, p));
  } finally {
    clearTimeout(timer);
  }
  return out.replace(/\[\[\d+\]\]/g, '').trim();
}

const handlers = {
  async toggle(msg) { return toggle(msg.tabId, msg.mode); },
  async setMode(msg) { return setMode(msg.tabId, msg.mode, msg.on); },
  async state(msg) { return getState(msg.tabId); },
  async fetchImage(msg) { return fetchImage(msg.url, msg.pageUrl); },
  async test(msg) { return { text: await testProvider(msg.id, msg.draft) }; },
  async listModels(msg) {
    const settings = await getSettings();
    const p = resolveProvider(msg.id, settings, { ...msg.draft, enabled: true });
    if (!p?.baseUrl) throw new Error('حط رابط المزود أول.');
    try {
      return { models: await listModels(p) };
    } catch (e) {
      throw new Error(friendly(e, p));
    }
  },
  async clearCache() { await cache.clearAll(); return { ok: true }; },
  async openOptions() { await chrome.runtime.openOptionsPage(); return { ok: true }; },
  async status() {
    const settings = await getSettings();
    const list = candidates(settings, false);
    return { providers: list.map((p) => ({ id: p.id, name: p.name, model: p.model })), style: settings.style, lang: langInfo(settings) };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const fn = handlers[msg?.cmd];
  if (!fn) return false;
  fn(msg).then(
    (r) => reply(r ?? { ok: true }),
    (e) => reply({ error: String(e?.message || e) }),
  );
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  cache.prune();
});

// Used by the automated tests and handy from the service worker console.
globalThis.maana = { setMode, getState, toggle, presets: PRESETS };
