// Page mode: translate the text of the page in place.
//
// The page is cut into "units": runs of consecutive inline nodes inside a block
// element (a paragraph, a list item, a cell, a button label ...). A unit goes to
// the model as one string in which inline elements are numbered placeholders
// (<g1>link text</g1>, <x2/> for icons and line breaks). The translation is then
// written back into the ORIGINAL nodes: text nodes get new values and elements
// are reused, never cloned or removed, so links, listeners and frameworks that
// own the DOM keep working, and the original can be restored exactly.
(() => {
  const M = globalThis.__maana;
  if (!M || M.modes.page) return;

  const LETTER = /\p{L}/u;
  const ANY_LETTER = /\p{L}/gu;

  const IGNORE = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'head', 'title', 'base']);
  const ATOM = new Set(['br', 'wbr', 'img', 'picture', 'svg', 'math', 'code', 'kbd', 'samp', 'var', 'input', 'select',
    'textarea', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed', 'meter', 'progress', 'hr']);
  const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'button', 'cite', 'data', 'del', 'dfn', 'em', 'font', 'i',
    'ins', 'label', 'mark', 'nobr', 'q', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u']);
  const BLOCK_SEL = 'p,div,ul,ol,li,table,tr,td,th,section,article,aside,header,footer,nav,main,h1,h2,h3,h4,h5,h6,' +
    'blockquote,pre,form,fieldset,figure,figcaption,dl,dt,dd,details,summary,hr,address';

  const S = {
    on: false,
    units: [],
    byId: new Map(),
    nextId: 1,
    inflight: 0,
    blocked: false,
    observer: null,
    seen: new WeakSet(),
    attrs: new Map(), // element -> { dir, style } as they were before we touched them
    scanTimer: 0,
    pumpTimer: 0,
  };

  // True when the text is already written in the language we translate into.
  // Only languages with a script of their own can be recognised this way; for the
  // rest the model is asked and returns such text unchanged.
  function alreadyTarget(plain, letters) {
    const L = M.lang;
    if (!L.own) return false;
    const mine = plain.match(L.own)?.length || 0;
    if (mine / letters <= 0.5) return false;
    if (L.notOwn && L.notOwn.test(plain)) return false;
    if (L.must && !L.must.test(plain)) return false;
    return true;
  }

  // ---------- collecting units ----------

  const isOurs = (el) => el.localName.startsWith('maana-');

  function noTranslate(el) {
    return el.getAttribute('translate') === 'no' || el.classList.contains('notranslate') || el.isContentEditable;
  }

  function isAtomEl(el) {
    return ATOM.has(el.localName) || isOurs(el) || noTranslate(el);
  }

  function isInline(el) {
    const ln = el.localName;
    if (ATOM.has(ln) || isOurs(el)) return true;
    if (INLINE.has(ln)) return !el.querySelector(BLOCK_SEL);
    const d = getComputedStyle(el).display;
    return (d.startsWith('inline') || d === 'contents') && !el.querySelector(BLOCK_SEL);
  }

  function hasLetters(node) {
    if (node.nodeType === 3) return LETTER.test(node.nodeValue);
    return node.nodeType === 1 && !isAtomEl(node) && !IGNORE.has(node.localName) && LETTER.test(node.textContent);
  }

  function walk(parent, container) {
    let run = [];
    let hadBlock = false;
    const made = [];
    const flush = () => {
      if (!run.length) return;
      const u = makeUnit(parent, container, run);
      if (u) made.push(u);
      run = [];
    };
    for (let n = parent.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        run.push(n);
      } else if (n.nodeType === 1) {
        const ln = n.localName;
        if (IGNORE.has(ln)) continue;
        if (isInline(n)) {
          run.push(n);
        } else {
          flush();
          hadBlock = true;
          if (ln !== 'pre' && !noTranslate(n)) walk(n, n);
        }
      }
    }
    flush();
    for (const u of made) u.pure = !hadBlock && made.length === 1 && parent === container;
    // Open shadow roots (web components) are separate little documents.
    if (parent.nodeType === 1) {
      for (const el of parent.children) if (el.shadowRoot && !isOurs(el)) walk(el.shadowRoot, el);
    }
  }

  function meaningfulChildren(el) {
    const out = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && !n.nodeValue.trim()) continue;
      if (n.nodeType === 1 || n.nodeType === 3) out.push(n);
    }
    return out;
  }

  function serialize(nodes, u) {
    let out = '';
    for (const n of nodes) {
      if (n.nodeType === 3) {
        out += n.nodeValue.replace(/\s+/g, ' ');
        continue;
      }
      if (n.nodeType !== 1 || IGNORE.has(n.localName)) continue;
      if (isAtomEl(n) || !LETTER.test(n.textContent)) {
        const id = ++u.n;
        u.map.set(id, { kind: 'x', outer: n, inner: n });
        out += `<x${id}/>`;
        continue;
      }
      // <a><span><span>text</span></span></a> needs one tag, not three.
      let inner = n;
      for (;;) {
        const kids = meaningfulChildren(inner);
        if (kids.length === 1 && kids[0].nodeType === 1 && !isAtomEl(kids[0]) && !IGNORE.has(kids[0].localName)) inner = kids[0];
        else break;
      }
      const id = ++u.n;
      u.map.set(id, { kind: 'g', outer: n, inner });
      out += `<g${id}>` + serialize(inner.childNodes, u) + `</g${id}>`;
    }
    return out;
  }

  function makeUnit(parent, container, run) {
    let a = 0;
    let b = run.length - 1;
    while (a <= b && !hasLetters(run[a])) a++;
    while (b >= a && !hasLetters(run[b])) b--;
    if (a > b) return null;
    let nodes = run.slice(a, b + 1);
    if (S.seen.has(nodes[0])) return null;
    for (const n of nodes) S.seen.add(n);

    const u = { id: 0, parent, container, nodes, map: new Map(), n: 0, status: 'new', pure: false, tries: 0 };
    let text = serialize(nodes, u).trim();

    // A unit that is just one wrapper element: work inside it and drop the tag.
    for (;;) {
      const m = /^<g(\d+)>([\s\S]*)<\/g\1>$/.exec(text);
      if (!m) break;
      const ref = u.map.get(+m[1]);
      u.map.delete(+m[1]);
      u.parent = ref.inner;
      u.nodes = Array.from(ref.inner.childNodes);
      u.wrapped = true;
      text = m[2].trim();
    }
    if (!u.nodes.length) return null;

    const plain = text.replace(/<\/?[gx]\d+\/?>/g, '').trim();
    if (plain.length < 2) return null;
    const letters = plain.match(ANY_LETTER)?.length || 0;
    if (!letters) return null;
    if (alreadyTarget(plain, letters)) return null;
    if (/^(https?:\/\/|www\.)\S+$/i.test(plain) || /^\S+@\S+\.\S+$/.test(plain)) return null;

    u.text = text;
    u.plain = plain;
    u.id = S.nextId++;
    S.units.push(u);
    S.byId.set(u.id, u);
    return u;
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === 1 && (IGNORE.has(root.localName) || ATOM.has(root.localName) || isOurs(root) || root.localName === 'pre')) return;
    walk(root, root);
  }

  // ---------- writing a translation back ----------

  function parseTranslation(str, u) {
    const root = { children: [] };
    const stack = [root];
    const used = new Set();
    const re = /<(\/)?([gx])(\d+)\s*(\/)?>/g;
    let last = 0;
    let m;
    const top = () => stack[stack.length - 1];
    const text = (t) => { if (t) top().children.push({ t }); };
    while ((m = re.exec(str))) {
      text(str.slice(last, m.index));
      last = re.lastIndex;
      const closing = !!m[1];
      const id = +m[3];
      const ref = u.map.get(id);
      if (!ref || ref.kind !== m[2]) continue; // a tag the model made up
      if (ref.kind === 'x' || m[4]) {
        if (!closing && !used.has(id)) {
          used.add(id);
          top().children.push({ ref, children: null });
        }
      } else if (!closing) {
        if (used.has(id)) continue;
        used.add(id);
        const node = { ref, children: [] };
        top().children.push(node);
        stack.push(node);
      } else {
        const i = stack.findLastIndex((s) => s.ref === ref);
        if (i > 0) stack.length = i;
      }
    }
    text(str.slice(last));
    return root.children;
  }

  // Put `desired` in order as the children of `parent` that end right before `anchor`.
  function arrange(parent, desired, anchor) {
    let next = anchor && anchor.parentNode === parent ? anchor : null;
    for (let i = desired.length - 1; i >= 0; i--) {
      const d = desired[i];
      if (d.parentNode !== parent || d.nextSibling !== next) parent.insertBefore(d, next);
      next = d;
    }
  }

  function fill(parent, origNodes, tree, anchor, rec) {
    const texts = origNodes.filter((n) => n.nodeType === 3);
    let ti = 0;
    const desired = [];
    for (const node of tree) {
      if (node.t != null) {
        let tn = texts[ti++];
        if (tn) {
          rec.texts.push([tn, tn.nodeValue]);
          tn.nodeValue = node.t;
        } else {
          tn = document.createTextNode(node.t);
          rec.created.push(tn);
          S.seen.add(tn);
        }
        desired.push(tn);
      } else {
        desired.push(node.ref.outer);
        if (node.children) fill(node.ref.inner, Array.from(node.ref.inner.childNodes), node.children, null, rec);
      }
    }
    for (; ti < texts.length; ti++) {
      rec.texts.push([texts[ti], texts[ti].nodeValue]);
      texts[ti].nodeValue = '';
    }
    arrange(parent, desired, anchor);
  }

  function remember(el) {
    if (!S.attrs.has(el)) S.attrs.set(el, { dir: el.getAttribute('dir'), style: el.getAttribute('style') });
  }

  // Give a translated block the writing direction of the target language.
  function setDirection(el) {
    const dir = M.lang.dir;
    if (!dir || !(el instanceof Element) || el === document.body || el === document.documentElement) return;
    const rtl = dir === 'rtl';
    const cs = getComputedStyle(el);
    remember(el);
    if (cs.direction !== dir) el.setAttribute('dir', dir);
    // An explicit alignment to the old starting side would leave the text on the wrong side.
    const wrongSide = rtl ? ['left', '-webkit-left'] : ['right', '-webkit-right'];
    if (wrongSide.includes(cs.textAlign)) el.style.textAlign = rtl ? 'right' : 'left';
    if (el.localName === 'li') {
      // The bullet follows the list item, so the list's indent has to follow too.
      const list = el.parentElement;
      if (list && /^(ul|ol|menu)$/.test(list.localName) && !S.attrs.has(list)) {
        const lcs = getComputedStyle(list);
        if (lcs.direction !== dir) {
          const pl = parseFloat(lcs.paddingLeft) || 0;
          const pr = parseFloat(lcs.paddingRight) || 0;
          remember(list);
          list.setAttribute('dir', dir);
          // A physical indent does not follow the direction by itself: move it to the new starting side.
          const unchanged = (parseFloat(getComputedStyle(list).paddingLeft) || 0) === pl;
          if (unchanged && (rtl ? pl > pr : pr > pl)) {
            list.style.paddingLeft = pr + 'px';
            list.style.paddingRight = pl + 'px';
          }
        }
      }
    }
  }

  // A sentence (direct text, or a single item) takes the target language's direction. A row
  // of separate items such as nav links or a button group keeps its layout.
  function isProse(u) {
    const withLetters = u.nodes.filter(hasLetters);
    return withLetters.length === 1 || withLetters.some((n) => n.nodeType === 3);
  }

  function apply(u, str) {
    if (!u.nodes.length || !u.nodes.every((n) => n.parentNode === u.parent)) {
      u.status = 'stale';
      return false;
    }
    const prose = isProse(u);
    const tree = parseTranslation(str, u);
    const first = u.nodes[0];
    const lastNode = u.nodes[u.nodes.length - 1];
    const lead = first.nodeType === 3 && /^\s/.test(first.nodeValue);
    const trail = lastNode.nodeType === 3 && /\s$/.test(lastNode.nodeValue);
    const anchor = lastNode.nextSibling;

    const rec = { texts: [], created: [], struct: [[u.parent, u.nodes.slice(), anchor]] };
    for (const ref of u.map.values()) {
      if (ref.kind === 'g') rec.struct.push([ref.inner, Array.from(ref.inner.childNodes), null]);
    }

    // A whole block takes the new direction; a lone wrapper beside other blocks only changes itself.
    const target = u.pure ? u.container : u.wrapped ? u.parent : null;
    const rtlBlock = prose && target instanceof Element;
    if (prose && !rtlBlock) {
      // Loose text beside other blocks: isolate it in its own direction without touching the container.
      // (RLI / LRI for a known direction, FSI when the direction is left to the text itself.)
      const open = M.lang.dir === 'rtl' ? '⁧' : M.lang.dir === 'ltr' ? '⁦' : '⁨';
      if (tree[0]?.t != null) tree[0].t = open + tree[0].t;
      else tree.unshift({ t: open });
      const end = tree[tree.length - 1];
      if (end.t != null) end.t += '⁩';
      else tree.push({ t: '⁩' });
    }
    if (lead) {
      if (tree[0]?.t != null) tree[0].t = ' ' + tree[0].t;
      else tree.unshift({ t: ' ' });
    }
    if (trail) {
      const end = tree[tree.length - 1];
      if (end?.t != null) end.t += ' ';
      else tree.push({ t: ' ' });
    }

    S.muted = true;
    try {
      fill(u.parent, u.nodes, tree, anchor, rec);
      if (rtlBlock) setDirection(target);
    } finally {
      S.observer?.takeRecords();
      S.muted = false;
    }
    u.rec = rec;
    u.translation = str;
    u.status = 'done';
    return true;
  }

  function restore(u) {
    const rec = u.rec;
    if (!rec) return;
    for (const tn of rec.created) tn.remove();
    for (const [tn, v] of rec.texts) tn.nodeValue = v;
    for (const [parent, nodes, anchor] of rec.struct) arrange(parent, nodes, anchor);
    u.rec = null;
    u.status = 'held';
  }

  function restoreAttrs() {
    for (const [el, was] of S.attrs) {
      if (was.dir === null) el.removeAttribute('dir');
      else el.setAttribute('dir', was.dir);
      if (was.style === null) {
        // The browser keeps the style attribute in step with el.style lazily. Reading
        // it first makes the two agree, otherwise an empty style="" can reappear later.
        el.getAttribute('style');
        el.removeAttribute('style');
        if (el.getAttribute('style') === '') el.removeAttribute('style');
      } else {
        el.setAttribute('style', was.style);
      }
    }
    S.attrs.clear();
  }

  // ---------- scheduling ----------

  function rectOf(u) {
    const first = u.nodes[0];
    const last = u.nodes[u.nodes.length - 1];
    if (!first.isConnected) return null;
    const range = document.createRange();
    try {
      range.setStartBefore(first);
      range.setEndAfter(last);
    } catch {
      return null;
    }
    const r = range.getBoundingClientRect();
    return r.width || r.height ? r : null;
  }

  function contextBefore(u) {
    const i = S.units.indexOf(u);
    let s = '';
    for (let k = i - 1; k >= 0 && s.length < 500; k--) s = S.units[k].plain + '\n' + s;
    return s.slice(-600).trim();
  }

  function pump() {
    if (!S.on || S.blocked) return;
    const vh = innerHeight;
    const ready = [];
    for (const u of S.units) {
      if (u.status !== 'new') continue;
      const r = rectOf(u);
      if (!r) {
        if (!u.nodes[0].isConnected) u.status = 'stale';
        continue;
      }
      if (r.bottom < -vh * 0.5 || r.top > vh * 3) continue;
      ready.push([r.top, u]);
    }
    ready.sort((x, y) => x[0] - y[0]);

    let i = 0;
    while (i < ready.length && S.inflight < 3) {
      // The very first request is small so the top of the page changes quickly.
      const budget = S.sentAny ? 3600 : 1500;
      const batch = [];
      let size = 0;
      while (i < ready.length && batch.length < 50) {
        const u = ready[i][1];
        if (batch.length && size + u.text.length > budget) break;
        batch.push(u);
        size += u.text.length;
        i++;
      }
      S.sentAny = true;
      send(batch);
    }
    M.ui.refresh();
  }

  async function send(batch) {
    for (const u of batch) u.status = 'sent';
    S.inflight++;
    const res = await M.request(
      {
        type: 'text',
        items: batch.map((u) => ({ id: u.id, text: u.text })),
        ctx: { title: document.title, host: location.hostname, before: contextBefore(batch[0]) },
      },
      (ev) => {
        if (ev.type === 'item') {
          const u = S.byId.get(ev.id);
          if (!u || u.status !== 'sent') return;
          if (S.on) apply(u, ev.text);
          else {
            u.translation = ev.text;
            u.status = 'held';
          }
          M.ui.refresh();
        } else if (ev.type === 'info') {
          M.ui.note(ev.message);
        }
      },
    );
    S.inflight--;
    for (const u of batch) {
      if (u.status !== 'sent') continue;
      u.tries++;
      u.status = !res.error && u.tries < 2 ? 'new' : 'failed';
    }
    if (res.error) {
      // Stop asking until the user acts; otherwise every scroll would repeat the failure.
      S.blocked = true;
      for (const u of batch) if (u.status === 'failed') u.status = 'new';
      M.ui.error(res.error);
      return;
    }
    M.ui.refresh();
    pump();
  }

  const schedulePump = () => {
    clearTimeout(S.pumpTimer);
    S.pumpTimer = setTimeout(pump, 180);
  };

  function onMutations(records) {
    if (S.muted || !S.on) return;
    const roots = new Set();
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && !isOurs(n)) roots.add(n.parentElement || n);
        else if (n.nodeType === 3 && n.parentElement && !S.seen.has(n)) roots.add(n.parentElement);
      }
    }
    if (!roots.size) return;
    clearTimeout(S.scanTimer);
    S.scanTimer = setTimeout(() => {
      if (!S.on) return;
      if (roots.size > 40) scan(document.body);
      else for (const el of roots) if (el.isConnected) scan(el.closest(BLOCK_SEL) || el);
      pump();
    }, 450);
  }

  function start() {
    if (S.langKey !== M.lang.key) {
      // Another target language: forget earlier translations and what was skipped as "already translated".
      S.units = [];
      S.byId.clear();
      S.seen = new WeakSet();
      S.langKey = M.lang.key;
    }
    S.on = true;
    S.blocked = false;
    S.sentAny = false;
    scan(document.body);
    S.muted = true;
    for (const u of S.units) {
      if (u.status === 'held' && u.translation) apply(u, u.translation);
      else if (u.status === 'failed') u.status = 'new';
    }
    S.muted = false;
    if (!S.observer) S.observer = new MutationObserver(onMutations);
    S.observer.observe(document.body, { childList: true, subtree: true });
    addEventListener('scroll', schedulePump, { capture: true, passive: true });
    addEventListener('resize', schedulePump, { passive: true });
    pump();
  }

  function stop() {
    S.on = false;
    S.observer?.disconnect();
    removeEventListener('scroll', schedulePump, { capture: true });
    removeEventListener('resize', schedulePump);
    clearTimeout(S.pumpTimer);
    clearTimeout(S.scanTimer);
    for (let i = S.units.length - 1; i >= 0; i--) restore(S.units[i]);
    restoreAttrs();
    M.ui.clearError();
    M.ui.refresh();
  }

  M.modes.page = {
    set(on) {
      if (on === S.on) {
        if (on && S.blocked) { S.blocked = false; pump(); }
        return;
      }
      if (on) start();
      else stop();
    },
    state() {
      let total = 0, done = 0, failed = 0, sent = 0;
      for (const u of S.units) {
        if (u.status === 'stale') continue;
        total++;
        if (u.status === 'done') done++;
        else if (u.status === 'failed') failed++;
        else if (u.status === 'sent') sent++;
      }
      return { on: S.on, total, done, failed, ready: done + failed + sent, busy: S.inflight > 0 };
    },
  };
})();
