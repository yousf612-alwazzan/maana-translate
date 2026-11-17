import { PRESETS, LANGS, mergeSettings, resolveProvider, isUsable, isSecureUrl } from '../lib/presets.js';

const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e?.message || e) }));

const RELEASES_API = 'https://api.github.com/repos/yousf612-alwazzan/maana-translate/releases/latest';

// "0.10.0" is newer than "0.9.2": compare number by number, not as text.
function isNewer(a, b) {
  const x = a.split('.').map((n) => parseInt(n, 10) || 0);
  const y = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

let settings = null;
let saveTimer = 0;
const open = new Set(); // provider ids whose details are expanded

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ settings });
    const el = $('saved');
    el.textContent = 'انحفظ';
    setTimeout(() => { el.textContent = ''; }, 1400);
  }, 250);
}

function describe(id) {
  const p = resolveProvider(id, settings);
  if (!p.enabled) return { text: 'مطفي', ok: false, usable: false };
  if (p.needsKey && !p.apiKey) return { text: 'ناقص المفتاح', ok: false, usable: false };
  if (!p.baseUrl) return { text: 'ناقص الرابط', ok: false, usable: false };
  if (!isSecureUrl(p.baseUrl)) return { text: 'الرابط لازم https', ok: false, usable: false };
  if (!p.model) return { text: 'ناقص النموذج', ok: false, usable: false };
  return { text: 'جاهز', ok: true, usable: isUsable(p) };
}

function renderProviders() {
  const list = $('providers');
  list.textContent = '';
  const tpl = $('providerTpl');

  settings.order.forEach((id, index) => {
    const preset = PRESETS[id];
    const saved = settings.providers[id];
    const li = tpl.content.firstElementChild.cloneNode(true);
    const q = (sel) => li.querySelector(sel);

    const paintState = () => {
      const d = describe(id);
      q('.state').textContent = d.text;
      q('.state').classList.toggle('ok', d.ok);
      li.classList.toggle('usable', d.usable);
    };

    q('.title').textContent = preset.name;
    q('.tier').textContent = preset.free || id === 'custom' ? '' : 'يحتاج رصيد';
    q('.hint').textContent = preset.hint;
    q('.enabled').checked = !!saved.enabled;
    q('.up').disabled = index === 0;
    q('.down').disabled = index === settings.order.length - 1;

    // Which rows make sense for this provider.
    const editableUrl = id === 'custom' || id === 'ollama';
    q('.url-row').hidden = !editableUrl;
    q('.key-row').hidden = id === 'ollama';
    q('.keyLink').hidden = !preset.keyUrl;
    if (preset.keyUrl) q('.keyLink').href = preset.keyUrl;
    q('.ollama-note').hidden = id !== 'ollama';

    const listId = `models-${id}`;
    q('.models').id = listId;
    q('.model').setAttribute('list', listId);
    q('.visionModel').setAttribute('list', listId);

    q('.baseUrl').value = saved.baseUrl || '';
    q('.baseUrl').placeholder = preset.baseUrl || 'https://example.com/v1';
    q('.apiKey').value = saved.apiKey || '';
    q('.model').value = saved.model || '';
    q('.model').placeholder = preset.model || 'اسم النموذج';
    q('.visionModel').value = saved.visionModel || '';
    if (preset.visionModel && preset.visionModel !== preset.model) q('.visionModel').placeholder = preset.visionModel;

    const bind = (sel, key) => {
      q(sel).addEventListener('input', () => {
        saved[key] = q(sel).value.trim();
        paintState();
        save();
      });
    };
    bind('.baseUrl', 'baseUrl');
    bind('.apiKey', 'apiKey');
    bind('.model', 'model');
    bind('.visionModel', 'visionModel');

    q('.enabled').addEventListener('change', () => {
      saved.enabled = q('.enabled').checked;
      paintState();
      save();
    });

    const setOpen = (on) => {
      q('.prov-body').hidden = !on;
      q('.toggle').setAttribute('aria-expanded', String(on));
      q('.toggle').textContent = on ? 'إخفاء' : 'التفاصيل';
      if (on) open.add(id);
      else open.delete(id);
    };
    q('.toggle').addEventListener('click', () => setOpen(q('.prov-body').hidden));
    setOpen(open.has(id));

    const move = (delta) => {
      const j = index + delta;
      if (j < 0 || j >= settings.order.length) return;
      [settings.order[index], settings.order[j]] = [settings.order[j], settings.order[index]];
      save();
      renderProviders();
      $('providers').children[j]?.querySelector(delta < 0 ? '.up' : '.down')?.focus();
    };
    q('.up').addEventListener('click', () => move(-1));
    q('.down').addEventListener('click', () => move(1));

    q('.show').addEventListener('click', () => {
      const input = q('.apiKey');
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      q('.show').textContent = reveal ? 'إخفاء' : 'إظهار';
    });

    const draft = () => ({
      baseUrl: q('.baseUrl').value.trim(),
      apiKey: q('.apiKey').value.trim(),
      model: q('.model').value.trim(),
      visionModel: q('.visionModel').value.trim(),
    });
    const result = (text, cls) => {
      q('.result').textContent = text;
      q('.result').className = 'result ' + (cls || 'muted');
    };

    q('.fetch').addEventListener('click', async () => {
      result('أجيب القائمة...');
      const r = await ask({ cmd: 'listModels', id, draft: draft() });
      if (r?.error) return result(r.error, 'bad');
      const dl = q('.models');
      dl.textContent = '';
      for (const m of r.models) dl.appendChild(new Option(m, m));
      result(`${r.models.length} نموذج. اكتب أول حرف من الاسم في الخانة واختار.`, 'ok');
    });

    q('.test').addEventListener('click', async () => {
      q('.test').disabled = true;
      result('أختبر...');
      const r = await ask({ cmd: 'test', id, draft: draft() });
      q('.test').disabled = false;
      if (r?.error) return result(r.error, 'bad');
      result('شغّال: ' + (r.text || '').slice(0, 120), 'ok');
    });

    paintState();
    list.appendChild(li);
  });
}

function renderSites() {
  const ul = $('sites');
  ul.textContent = '';
  const hosts = Object.keys(settings.autoSites).sort();
  if (!hosts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'ما في مواقع للحين.';
    ul.appendChild(li);
    return;
  }
  const label = { page: 'الصفحة', images: 'الصور', both: 'الصفحة والصور' };
  for (const host of hosts) {
    const li = document.createElement('li');
    const h = document.createElement('span');
    h.className = 'h ltr';
    h.textContent = host;
    const what = document.createElement('span');
    what.className = 'muted';
    what.textContent = label[settings.autoSites[host]] || '';
    const del = document.createElement('button');
    del.className = 'btn quiet';
    del.type = 'button';
    del.textContent = 'احذف';
    del.addEventListener('click', () => {
      delete settings.autoSites[host];
      save();
      renderSites();
    });
    li.append(h, what, del);
    ul.appendChild(li);
  }
}

async function init() {
  const stored = await chrome.storage.local.get('settings');
  settings = mergeSettings(stored.settings);
  // First visit: open the first provider so the key field is right there.
  if (!stored.settings) open.add(settings.order[0]);

  renderProviders();
  renderSites();

  const paintConsent = () => {
    $('consentBox').hidden = settings.consent;
    $('consentText').textContent = settings.consent
      ? 'وافقت على إرسال المحتوى اللي تطلب ترجمته للمزود اللي تختاره.'
      : 'ما وافقت للحين، فالترجمة موقفة.';
    $('revokeBtn').hidden = !settings.consent;
  };
  $('consentBtn').addEventListener('click', () => { settings.consent = true; save(); paintConsent(); });
  $('revokeBtn').addEventListener('click', () => { settings.consent = false; save(); paintConsent(); });
  paintConsent();

  // Target language: a list, or any language typed by name.
  const target = $('target');
  for (const l of LANGS) target.appendChild(new Option(l.name === l.en ? l.name : `${l.name} · ${l.en}`, l.code));
  target.appendChild(new Option('لغة ثانية (اكتب اسمها)', 'other'));
  target.value = settings.targetLang;
  $('targetOther').value = settings.targetOther;
  const paintLang = () => {
    $('targetOther').hidden = target.value !== 'other';
    $('styleField').hidden = target.value !== 'ar'; // the dialect choice is about Arabic only
  };
  target.addEventListener('change', () => {
    settings.targetLang = target.value;
    paintLang();
    save();
    if (target.value === 'other') $('targetOther').focus();
  });
  $('targetOther').addEventListener('input', () => { settings.targetOther = $('targetOther').value; save(); });
  paintLang();

  for (const radio of document.querySelectorAll('input[name="style"]')) {
    radio.checked = radio.value === settings.style;
    radio.addEventListener('change', () => {
      if (radio.checked) settings.style = radio.value;
      save();
    });
  }
  $('extra').value = settings.extra;
  $('extra').addEventListener('input', () => { settings.extra = $('extra').value; save(); });
  $('lowThinking').checked = settings.lowThinking;
  $('lowThinking').addEventListener('change', () => { settings.lowThinking = $('lowThinking').checked; save(); });
  $('minSize').value = settings.manga.minSize;
  $('minSize').addEventListener('change', () => {
    settings.manga.minSize = Math.min(1200, Math.max(120, +$('minSize').value || 260));
    $('minSize').value = settings.manga.minSize;
    save();
  });
  $('sfx').checked = settings.manga.sfx;
  $('sfx').addEventListener('change', () => { settings.manga.sfx = $('sfx').checked; save(); });

  $('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  $('clearCache').addEventListener('click', async () => {
    await ask({ cmd: 'clearCache' });
    $('cacheMsg').textContent = 'انمسح.';
    setTimeout(() => { $('cacheMsg').textContent = ''; }, 2000);
  });
  $('ver').textContent = chrome.runtime.getManifest().version;

  // The extension is installed from GitHub, so there is no automatic update:
  // this asks GitHub for the newest release number, only when the button is pressed.
  $('checkUpdate').addEventListener('click', async () => {
    const msg = $('updateMsg');
    const link = $('updateLink');
    link.hidden = true;
    msg.className = 'muted';
    msg.textContent = 'أفحص...';
    try {
      const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(String(res.status));
      const latest = String((await res.json()).tag_name || '').replace(/^v/i, '');
      const mine = chrome.runtime.getManifest().version;
      if (!latest) throw new Error('no tag');
      if (isNewer(latest, mine)) {
        msg.className = 'ok';
        msg.textContent = `فيه إصدار جديد: ${latest} (عندك ${mine}).`;
        link.hidden = false;
      } else {
        msg.textContent = `عندك آخر إصدار (${mine}).`;
      }
    } catch {
      msg.className = 'bad';
      msg.textContent = 'ما قدرت أوصل لـ GitHub. جرّب بعدين.';
    }
  });

  // Pick up changes made from the popup while this page is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const next = mergeSettings(changes.settings.newValue);
    if (JSON.stringify(next.autoSites) !== JSON.stringify(settings.autoSites)) {
      settings.autoSites = next.autoSites;
      renderSites();
    }
    if (next.targetLang !== settings.targetLang) {
      settings.targetLang = next.targetLang;
      target.value = next.targetLang;
      paintLang();
    }
    if (next.consent !== settings.consent) {
      settings.consent = next.consent;
      paintConsent();
    }
  });
}

init();
