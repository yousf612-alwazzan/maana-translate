// Shared plumbing for the content scripts: the port to the service worker,
// the small status chip, and the message router. Safe to inject twice.
(() => {
  if (globalThis.__maana) return;
  const M = (globalThis.__maana = { modes: {} });

  // The language being translated INTO. The service worker sends it with every
  // command; the patterns arrive as text and are compiled here.
  const ARABIC = '[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]';
  M.setLang = (l) => {
    if (!l || !l.key) return;
    M.lang = {
      code: l.code,
      key: l.key,
      dir: l.dir || null,
      own: l.own ? new RegExp(l.own, 'g') : null,
      notOwn: l.notOwn ? new RegExp(l.notOwn) : null,
      must: l.must ? new RegExp(l.must) : null,
    };
  };
  M.setLang({ code: 'ar', key: 'ar', dir: 'rtl', own: ARABIC });

  // ---------- port to the service worker ----------

  let port = null;
  let seq = 0;
  const pending = new Map();

  function getPort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: 'maana' });
    port.onMessage.addListener((m) => {
      const h = pending.get(m.reqId);
      if (!h) return;
      if (m.type === 'done') {
        pending.delete(m.reqId);
        h.done(m);
      } else {
        h.event(m);
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      const all = [...pending.values()];
      pending.clear();
      for (const h of all) h.done({ error: { kind: 'network', message: 'انقطع الاتصال بالإضافة. أعد المحاولة.' } });
    });
    return port;
  }

  // Send one job; `onEvent` receives streamed pieces, the promise resolves with the final message.
  M.request = (payload, onEvent) =>
    new Promise((resolve) => {
      const reqId = ++seq;
      pending.set(reqId, { event: onEvent || (() => {}), done: resolve });
      try {
        getPort().postMessage({ ...payload, reqId });
      } catch {
        pending.delete(reqId);
        resolve({ error: { kind: 'reload', message: 'الإضافة تحدّثت. حدّث الصفحة وجرّب مرة ثانية.' } });
      }
    });

  M.ask = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r));
      } catch (e) {
        resolve({ error: String(e) });
      }
    });

  // Run async jobs with a concurrency cap.
  M.pool = (limit) => {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active >= limit || !queue.length) return;
      active++;
      const { fn, resolve } = queue.shift();
      Promise.resolve()
        .then(fn)
        .then(resolve, () => resolve(undefined))
        .finally(() => {
          active--;
          next();
        });
    };
    return (fn) => new Promise((resolve) => { queue.push({ fn, resolve }); next(); });
  };

  // ---------- status chip ----------

  const CHIP_CSS = `
    :host { all: initial; }
    .bar {
      position: fixed; left: 16px; bottom: 16px; z-index: 2147483646;
      display: none; align-items: center; gap: 10px;
      max-width: min(440px, calc(100vw - 32px));
      padding: 7px 10px 7px 8px;
      background: #0f0f10; color: #ebe6da;
      border: 1px solid #3a3528; border-inline-start: 2px solid #c8a55a;
      font: 12.5px/1.5 "Segoe UI", Tahoma, sans-serif; direction: rtl;
      box-shadow: 0 6px 24px rgba(0,0,0,.35);
    }
    .bar.show { display: flex; }
    .bar.err { border-inline-start-color: #c9705e; }
    .msg { flex: 1; min-width: 0; }
    .sub { color: #9c968a; font-size: 11.5px; }
    button {
      all: unset; cursor: pointer; padding: 2px 9px; white-space: nowrap;
      color: #c8a55a; border: 1px solid #5a4d2e; font: inherit; font-size: 12px;
    }
    button:hover { background: #1c1a15; color: #e3c783; }
    button:focus-visible { outline: 1px solid #c8a55a; outline-offset: 1px; }
    button.x { border: 0; color: #8c877c; padding: 2px 4px; font-size: 14px; line-height: 1; }
    button.x:hover { color: #ebe6da; background: none; }
    .spin { width: 9px; height: 9px; flex: none; border: 1.5px solid #5a4d2e; border-top-color: #c8a55a; border-radius: 50%; animation: r .8s linear infinite; }
    .bar:not(.busy) .spin { display: none; }
    @keyframes r { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
  `;

  let chip = null;
  let hideTimer = 0;
  let note = '';
  let noteTimer = 0;
  let lastError = null;
  let dismissed = false;

  function ensureChip() {
    if (chip?.host.isConnected) return chip;
    const host = document.createElement('maana-ui');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CHIP_CSS}</style>
      <div class="bar" role="status" aria-live="polite">
        <span class="spin"></span>
        <span class="msg"><span class="main"></span><span class="sub"></span></span>
        <button class="act" type="button"></button>
        <button class="x" type="button" aria-label="إخفاء">&#x2715;</button>
      </div>`;
    const bar = root.querySelector('.bar');
    const act = root.querySelector('.act');
    root.querySelector('.x').addEventListener('click', () => {
      dismissed = true;
      bar.classList.remove('show');
    });
    act.addEventListener('click', () => {
      if (act.dataset.do === 'options') M.ask({ cmd: 'openOptions' });
      else {
        for (const mode of Object.values(M.modes)) if (mode.state().on) mode.set(false);
      }
    });
    document.documentElement.appendChild(host);
    chip = { host, bar, act, main: root.querySelector('.main'), sub: root.querySelector('.sub') };
    return chip;
  }

  M.ui = {
    // Call after any state change; reads both modes and redraws the chip.
    refresh() {
      const p = M.modes.page?.state();
      const g = M.modes.images?.state();
      const anyOn = p?.on || g?.on;
      if (!anyOn && !lastError) {
        if (chip) chip.bar.classList.remove('show');
        return;
      }
      const c = ensureChip();
      const parts = [];
      let busy = false;
      if (p?.on) {
        busy = busy || p.busy;
        parts.push(p.busy || p.done < p.ready ? `ترجمة الصفحة ${p.done} من ${p.ready}` : 'الصفحة مترجمة');
      }
      if (g?.on) {
        busy = busy || g.busy;
        parts.push(g.busy ? `ترجمة الصور ${g.done} من ${g.total}` : g.total ? `الصور مترجمة (${g.done})` : 'ما لقيت صور كبيرة للترجمة');
      }
      c.main.textContent = lastError ? lastError.message : parts.join(' · ');
      c.sub.textContent = !lastError && note ? ' — ' + note : '';
      c.bar.classList.toggle('busy', busy && !lastError);
      c.bar.classList.toggle('err', !!lastError);
      const needsSetup = lastError && ['noprovider', 'auth', 'origin', 'consent'].includes(lastError.kind);
      c.act.textContent = needsSetup ? 'الإعدادات' : 'الأصل';
      c.act.dataset.do = needsSetup ? 'options' : 'orig';
      c.act.style.display = needsSetup || anyOn ? '' : 'none';
      if (busy || lastError) dismissed = false;
      if (!dismissed) c.bar.classList.add('show');
      clearTimeout(hideTimer);
      if (!busy && !lastError) hideTimer = setTimeout(() => c.bar.classList.remove('show'), 4000);
    },
    error(err) {
      lastError = err;
      M.ui.refresh();
    },
    clearError() {
      lastError = null;
    },
    note(text) {
      note = text;
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => { note = ''; M.ui.refresh(); }, 6000);
      M.ui.refresh();
    },
  };

  // ---------- commands from the service worker ----------

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.cmd === 'set') {
      M.setLang(msg.lang);
      M.ui.clearError();
      M.modes[msg.mode]?.set(!!msg.on);
      reply({ ok: true });
    } else if (msg?.cmd === 'state') {
      reply({ page: M.modes.page?.state() || { on: false }, images: M.modes.images?.state() || { on: false } });
    }
  });
})();
