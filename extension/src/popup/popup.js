import { mergeSettings, LANGS } from '../lib/presets.js';

const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e?.message || e) }));

let tab = null;
let host = '';
let hasProvider = false;
let consent = false;
let timer = 0;

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

async function saveSettings(change) {
  const s = await loadSettings();
  change(s);
  await chrome.storage.local.set({ settings: s });
  return s;
}

function showNotice(text, withButton) {
  $('msgText').textContent = text;
  $('msgBtn').hidden = !withButton;
  $('msg').hidden = false;
}

function paint(state) {
  const page = $('btnPage');
  const images = $('btnImages');
  if (!state || state.error) {
    page.disabled = images.disabled = true;
    $('progress').hidden = true;
    showNotice(state?.error || 'ما قدرت أوصل لهالصفحة.', false);
    return;
  }
  page.disabled = images.disabled = !hasProvider || !consent;
  const p = state.page || {};
  const g = state.images || {};
  page.classList.toggle('on', !!p.on);
  images.classList.toggle('on', !!g.on);
  page.querySelector('.lbl').textContent = p.on ? 'رجّع النص الأصلي' : 'ترجم الصفحة';
  images.querySelector('.lbl').textContent = g.on ? 'أخفِ ترجمة الصور' : 'ترجم الصور';

  const parts = [];
  if (p.on) parts.push(p.busy || p.done < p.ready ? `الصفحة: ${p.done} من ${p.ready}` : `الصفحة: تمت (${p.done})`);
  if (g.on) parts.push(g.busy ? `الصور: ${g.done} من ${g.total}` : g.total ? `الصور: تمت (${g.done})` : 'الصور: ما لقيت صور كبيرة');
  $('progress').textContent = parts.join(' · ');
  $('progress').hidden = !parts.length;
}

async function refresh() {
  if (!tab) return;
  paint(await ask({ cmd: 'state', tabId: tab.id }));
}

async function act(mode) {
  const r = await ask({ cmd: 'toggle', tabId: tab.id, mode });
  if (r?.error) return showNotice(r.error, false);
  await refresh();
}

async function syncAuto(state) {
  if (!host) return;
  const checked = $('auto').checked;
  await saveSettings((s) => {
    if (!checked) {
      delete s.autoSites[host];
      return;
    }
    const p = state?.page?.on;
    const g = state?.images?.on;
    s.autoSites[host] = p && g ? 'both' : g ? 'images' : 'page';
  });
}

async function init() {
  // Normally the popup acts on the tab it was opened over. When the page is opened
  // on its own (for screenshots and tests) the tab can be named with ?tab=<id>.
  const wanted = Number(new URLSearchParams(location.search).get('tab'));
  if (wanted) tab = await chrome.tabs.get(wanted).catch(() => null);
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await loadSettings();
  const status = await ask({ cmd: 'status' });
  const list = status?.providers || [];
  hasProvider = list.length > 0;
  $('provider').textContent = hasProvider
    ? `${list[0].name} · ${list[0].model}` + (list.length > 1 ? ` (+${list.length - 1} احتياط)` : '')
    : 'ما في مزود مربوط';
  $('provider').title = list.map((p) => `${p.name} · ${p.model}`).join('\n');
  consent = settings.consent;
  $('consent').hidden = consent;
  $('consentBtn').addEventListener('click', async () => {
    await saveSettings((s) => { s.consent = true; });
    consent = true;
    $('consent').hidden = true;
    await refresh();
  });
  if (!hasProvider) showNotice('اربط مزود أول: حط مفتاحك من مزود مجاني أو غيره.', true);

  $('style').value = settings.style;

  // Target language: the list, plus a typed language when the user set one in the settings.
  const target = $('target');
  for (const l of LANGS) target.appendChild(new Option(l.name, l.code));
  if (settings.targetLang === 'other' && settings.targetOther.trim()) {
    target.appendChild(new Option(settings.targetOther.trim(), 'other'));
  }
  target.appendChild(new Option('لغة ثانية...', 'more'));
  target.value = settings.targetLang;
  const paintStyleRow = () => { $('styleRow').hidden = target.value !== 'ar'; };
  paintStyleRow();
  target.addEventListener('change', async () => {
    if (target.value === 'more') {
      // Typing a language name needs room: that field lives in the settings page.
      chrome.runtime.openOptionsPage();
      return;
    }
    await saveSettings((s) => { s.targetLang = target.value; });
    paintStyleRow();
    // Whatever is translated right now is redone in the new language.
    const state = await ask({ cmd: 'state', tabId: tab.id });
    for (const mode of ['page', 'images']) {
      if (state?.[mode]?.on) {
        await ask({ cmd: 'setMode', tabId: tab.id, mode, on: false });
        await ask({ cmd: 'setMode', tabId: tab.id, mode, on: true });
      }
    }
    await refresh();
  });
  try {
    const u = new URL(tab.url);
    if (/^https?:$/.test(u.protocol)) host = u.hostname;
  } catch { /* no url */ }
  $('host').textContent = host;
  $('autoRow').hidden = $('host').hidden = !host;
  $('auto').checked = !!settings.autoSites[host];

  $('btnPage').addEventListener('click', () => act('page'));
  $('btnImages').addEventListener('click', () => act('images'));
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('msgBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('style').addEventListener('change', () => saveSettings((s) => { s.style = $('style').value; }));
  $('auto').addEventListener('change', async () => syncAuto(await ask({ cmd: 'state', tabId: tab.id })));

  await refresh();
  timer = setInterval(refresh, 700);
}

addEventListener('unload', () => clearInterval(timer));
init();
