// Images mode: translate comic / manga pages. Each large image is sent to a
// vision model that returns the text regions with their boxes; the Arabic text
// is then typeset over the original lettering in an overlay that sits right
// after the image in the DOM, so it scrolls, clips and stacks with the image.
(() => {
  const M = globalThis.__maana;
  if (!M || M.modes.images) return;

  const MAX_SIDE = 1568;

  const G = {
    on: false,
    items: new Map(), // image element -> state
    prev: '',
    active: 0,
    blocked: false,
    timer: 0,
    minSize: 260,
    sfx: true,
    pool: M.pool(3),
  };

  const OV_CSS = `
    :host { all: initial; }
    .root {
      position: absolute; inset: 0; container-type: size;
      font-family: "Segoe UI", Tahoma, "Noto Sans", "Noto Naskh Arabic", "Geeza Pro", sans-serif;
    }
    .b {
      position: absolute; box-sizing: border-box;
      display: flex; align-items: center; justify-content: center;
      border-radius: 24% / 28%;
    }
    .b[data-kind="caption"], .b[data-kind="sign"] { border-radius: 3px; }
    .c { position: absolute; display: block; }
    .t {
      display: block; max-width: 100%; text-align: center;
      line-height: 1.3; font-weight: 600; overflow-wrap: break-word;
      border-radius: 6px;
    }
    .b[data-kind="sfx"] { align-items: flex-end; }
    .b[data-kind="sfx"] .t {
      max-width: none; white-space: nowrap; padding: .08em .5em; font-weight: 600;
      background: rgba(15, 15, 16, .8); color: #f3efe4; border-radius: 2px;
      transform: translateY(55%);
    }
    .wait {
      position: absolute; top: 8px; inset-inline-start: 8px;
      padding: 2px 9px; font-size: 12px; line-height: 1.6;
      background: #0f0f10; color: #c8a55a; border: 1px solid #5a4d2e;
    }
  `;

  // ---------- finding images ----------

  function eligible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < G.minSize || r.height < G.minSize) return null;
    if (el.localName === 'img') {
      if (!el.complete || el.naturalWidth < 300 || el.naturalHeight < 300) return null;
      if (!(el.currentSrc || el.src)) return null;
    } else if (el.width < 300 || el.height < 300) {
      return null;
    }
    return r;
  }

  const srcOf = (el) => (el.localName === 'img' ? el.currentSrc || el.src : `canvas:${el.width}x${el.height}`);

  function tick() {
    if (!G.on) return;
    const vh = innerHeight;
    // Drop images that left the page; reset ones whose picture changed (readers that reuse one <img>).
    for (const [el, st] of G.items) {
      if (!el.isConnected) {
        dropOverlay(st);
        G.items.delete(el);
      } else if (st.status !== 'loading' && st.src !== srcOf(el)) {
        dropOverlay(st);
        G.items.delete(el);
      } else if (st.ov) {
        if (st.manual) place(st);
        refit(st);
      }
    }
    const queue = [];
    for (const el of document.querySelectorAll('img, canvas')) {
      let st = G.items.get(el);
      if (st && st.status !== 'new') continue;
      const r = eligible(el);
      if (!r) continue;
      if (!st) G.items.set(el, (st = { el, status: 'new', src: srcOf(el), regions: [] }));
      if (r.bottom > -vh * 0.5 && r.top < vh * 2.5) queue.push([r.top, st]);
    }
    queue.sort((a, b) => a[0] - b[0]);
    for (const [, st] of queue) {
      if (G.active >= 2 || G.blocked) break;
      processImage(st);
    }
  }

  // ---------- reading pixels ----------

  function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  const blobToB64 = (blob) =>
    new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });

  async function loadBitmap(el) {
    if (el.localName === 'canvas') return createImageBitmap(el);
    const src = el.currentSrc || el.src;
    let blob = null;
    // The page can only read its own images; anything on another origin goes through the service worker.
    let local = /^(data|blob):/.test(src);
    try { local = local || new URL(src, location.href).origin === location.origin; } catch { /* odd URL */ }
    if (local) {
      try {
        const res = await fetch(src);
        if (res.ok) blob = await res.blob();
      } catch { /* fall through to the service worker */ }
    }
    if (!blob) {
      const r = await M.ask({ cmd: 'fetchImage', url: src, pageUrl: location.href });
      if (r?.b64) blob = b64ToBlob(r.b64, r.mime);
    }
    if (!blob) throw new Error('unreadable');
    return createImageBitmap(blob);
  }

  // One tile for a normal page; overlapping vertical slices for long webtoon strips.
  async function makeTiles(bmp) {
    const W = bmp.width;
    const H = bmp.height;
    const spans = [];
    if (H <= W * 2.2) {
      spans.push([0, H]);
    } else {
      const th = Math.round(W * 1.6);
      const ov = Math.round(W * 0.3);
      let y = 0;
      for (;;) {
        let h = Math.min(th, H - y);
        if (H - (y + h) < ov) h = H - y;
        spans.push([y, h]);
        if (y + h >= H) break;
        y += h - ov;
      }
    }
    const tiles = [];
    for (let i = 0; i < spans.length; i++) {
      const [y0, h] = spans[i];
      const scale = Math.min(1, MAX_SIDE / Math.max(W, h));
      const cw = Math.max(1, Math.round(W * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = new OffscreenCanvas(cw, ch);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(bmp, 0, y0, W, h, 0, 0, cw, ch);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
      tiles.push({
        i, y0, h, cw, ch, ctx,
        b64: await blobToB64(blob),
        // Share of this tile that the neighbouring tiles also cover.
        ovTop: i > 0 ? (spans[i - 1][0] + spans[i - 1][1] - y0) / h : 0,
        ovBot: i < spans.length - 1 ? (y0 + h - spans[i + 1][0]) / h : 0,
      });
    }
    return tiles;
  }

  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

  // Study the pixels of one text box and prepare to erase its lettering.
  //   bg     the most common colour inside the box (the bubble's fill)
  //   fg     the colour of the lettering
  //   canvas a small transparent image that paints `bg` over the lettering only.
  //          Anything connected to the edge of the box (bubble outline, artwork) is
  //          left alone, so the bubble keeps its shape even when the box is loose.
  //   busy   true when there is no flat fill (text drawn over art): no clean erase.
  // `dpp` = screen pixels per tile pixel at the size the picture is shown.
  function analyse(tile, tb, dpp = 1) {
    const plain = { bg: [255, 255, 255], fg: [20, 20, 20], dark: false, busy: true, canvas: null, cbox: null };
    if (!tile.ctx) return plain;
    const { cw, ch } = tile;
    const bw = (tb[2] - tb[0]) * cw;
    const bh = (tb[3] - tb[1]) * ch;
    // Models rarely box the lettering exactly, so look well past the box. This is safe
    // because whatever reaches the edge of the region (outline, art) is never erased.
    const pad = Math.min(48, Math.max(4, Math.round(Math.min(bw, bh) * 0.32)));
    const X1 = Math.max(0, Math.floor(tb[0] * cw - pad));
    const Y1 = Math.max(0, Math.floor(tb[1] * ch - pad));
    const X2 = Math.min(cw, Math.ceil(tb[2] * cw + pad));
    const Y2 = Math.min(ch, Math.ceil(tb[3] * ch + pad));
    const w = X2 - X1;
    const h = Y2 - Y1;
    if (w < 6 || h < 6 || w * h > 4e6) return plain;
    let d;
    try {
      d = tile.ctx.getImageData(X1, Y1, w, h).data;
    } catch {
      return plain;
    }
    const n = w * h;

    // Most common colour, bucketed to 4 bits per channel, then averaged.
    const hist = new Uint32Array(4096);
    for (let i = 0; i < n; i++) hist[((d[i * 4] >> 4) << 8) | ((d[i * 4 + 1] >> 4) << 4) | (d[i * 4 + 2] >> 4)]++;
    let top = 0;
    for (let k = 1; k < 4096; k++) if (hist[k] > hist[top]) top = k;
    const seed = [((top >> 8) & 15) * 16 + 8, ((top >> 4) & 15) * 16 + 8, (top & 15) * 16 + 8];
    const far = (i, c) => Math.abs(d[i * 4] - c[0]) + Math.abs(d[i * 4 + 1] - c[1]) + Math.abs(d[i * 4 + 2] - c[2]);
    let sr = 0, sg = 0, sb = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      if (far(i, seed) < 60) { sr += d[i * 4]; sg += d[i * 4 + 1]; sb += d[i * 4 + 2]; cnt++; }
    }
    if (!cnt) return plain;
    const bg = [Math.round(sr / cnt), Math.round(sg / cnt), Math.round(sb / cnt)];
    const dark = lum(bg) < 115;

    // 1 = differs from the fill, 0 = fill.
    const mask = new Uint8Array(n);
    let fill = 0;
    for (let i = 0; i < n; i++) {
      if (far(i, bg) > 96) mask[i] = 1;
      else fill++;
    }
    const busy = fill / n < 0.42;
    const out = { bg, fg: dark ? [246, 243, 234] : [20, 20, 20], dark, busy, canvas: null, cbox: null };
    if (busy) return out;

    // 2 = differs AND reaches the edge of the box: outline or artwork, keep it.
    const stack = [];
    const seedEdge = (i) => { if (mask[i] === 1) { mask[i] = 2; stack.push(i); } };
    for (let x = 0; x < w; x++) { seedEdge(x); seedEdge((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seedEdge(y * w); seedEdge(y * w + w - 1); }
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      if (x > 0) seedEdge(i - 1);
      if (x < w - 1) seedEdge(i + 1);
      if (i >= w) seedEdge(i - w);
      if (i < n - w) seedEdge(i + w);
    }

    // 3 = lettering: a shape that differs from the fill, does not reach the edge, and
    // starts inside the model's box (taken slightly wider). Shapes that sit only in the
    // outer margin, such as screentone dots around the bubble, stay untouched.
    const zp = Math.max(3, Math.round(Math.min(bw, bh) * 0.18));
    const zx1 = Math.max(0, Math.floor(tb[0] * cw - zp) - X1);
    const zy1 = Math.max(0, Math.floor(tb[1] * ch - zp) - Y1);
    const zx2 = Math.min(w, Math.ceil(tb[2] * cw + zp) - X1);
    const zy2 = Math.min(h, Math.ceil(tb[3] * ch + zp) - Y1);
    const grab = (i) => { if (mask[i] === 1) { mask[i] = 3; stack.push(i); } };
    for (let y = zy1; y < zy2; y++) {
      for (let x = zx1; x < zx2; x++) {
        grab(y * w + x);
        while (stack.length) {
          const i = stack.pop();
          const px = i % w;
          if (px > 0) grab(i - 1);
          if (px < w - 1) grab(i + 1);
          if (i >= w) grab(i - w);
          if (i < n - w) grab(i + w);
        }
      }
    }

    // Grow the lettering mask before painting. The browser resamples the picture and
    // snaps it to whole pixels, so the margin has to be about 3 screen pixels or thin
    // slivers of the old letters survive along one side.
    const grow = Math.min(9, Math.max(3, Math.ceil(3 / Math.max(0.2, dpp))));
    const rowPass = new Uint8Array(n);
    let fr = 0, fg2 = 0, fb = 0, fc = 0;
    for (let y = 0; y < h; y++) {
      let reach = -1; // last column still covered by a letter pixel to the left
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (mask[i] === 3) {
          fr += d[i * 4]; fg2 += d[i * 4 + 1]; fb += d[i * 4 + 2]; fc++;
          for (let k = Math.max(reach + 1, x - grow); k < x; k++) rowPass[y * w + k] = 1;
          reach = x + grow;
        }
        if (x <= reach) rowPass[i] = 1;
      }
    }
    const img = new ImageData(w, h);
    const o = img.data;
    for (let x = 0; x < w; x++) {
      let reach = -1;
      const paint = (y) => {
        const j = y * w + x;
        if (mask[j] === 1 || mask[j] === 2) return; // outline or artwork: never painted over
        o[j * 4] = bg[0]; o[j * 4 + 1] = bg[1]; o[j * 4 + 2] = bg[2]; o[j * 4 + 3] = 255;
      };
      for (let y = 0; y < h; y++) {
        if (rowPass[y * w + x]) {
          for (let k = Math.max(reach + 1, y - grow); k < y; k++) paint(k);
          reach = y + grow;
        }
        if (y <= reach) paint(y);
      }
    }
    if (fc > 20) {
      // Keep the lettering's own colour when it stands out from the fill.
      const fg = [Math.round(fr / fc), Math.round(fg2 / fc), Math.round(fb / fc)];
      if (Math.abs(lum(fg) - lum(bg)) > 95) out.fg = fg;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').putImageData(img, 0, 0);
    out.canvas = canvas;
    out.cbox = [X1 / cw, Y1 / ch, X2 / cw, Y2 / ch]; // in tile coordinates; mapped to the image by the caller
    return out;
  }

  // ---------- overlay ----------

  const HOST_CSS = 'position:absolute!important;margin:0!important;padding:0!important;border:0!important;' +
    'pointer-events:none!important;z-index:1!important;display:block!important;opacity:1!important;' +
    'transform:none!important;max-width:none!important;max-height:none!important;min-width:0!important;min-height:0!important;';

  // CSS anchor positioning lets the browser glue the overlay to the image during
  // layout, so it can never lag behind when the page reflows.
  const CAN_ANCHOR = CSS.supports('position-anchor', '--a') && CSS.supports('left', 'anchor(left)') &&
    CSS.supports('width', 'anchor-size(width)');
  let anchorSeq = 0;

  function ensureOverlay(st) {
    if (st.ov?.isConnected) return;
    const ov = document.createElement('maana-ov');
    const shadow = ov.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${OV_CSS}</style><div class="root"></div>`;
    const after = st.el.parentElement?.localName === 'picture' ? st.el.parentElement : st.el;
    after.insertAdjacentElement('afterend', ov);
    st.ov = ov;
    st.root = shadow.querySelector('.root');
    st.css = '';
    st.manual = !CAN_ANCHOR;
    if (CAN_ANCHOR) {
      const name = `--maana-ov-${++anchorSeq}`;
      st.hadStyle = st.el.hasAttribute('style');
      st.prevAnchor = st.el.style.getPropertyValue('anchor-name');
      st.el.style.setProperty('anchor-name', st.prevAnchor && st.prevAnchor !== 'none' ? `${st.prevAnchor}, ${name}` : name);
      st.anchored = true;
      ov.style.cssText = HOST_CSS + `position-anchor:${name}!important;left:anchor(left)!important;top:anchor(top)!important;` +
        'width:anchor-size(width)!important;height:anchor-size(height)!important;';
      // Some layouts make the image an invalid anchor; fall back to measuring.
      const a = st.el.getBoundingClientRect();
      const b = ov.getBoundingClientRect();
      if (Math.abs(a.left - b.left) > 1.5 || Math.abs(a.top - b.top) > 1.5 || Math.abs(a.width - b.width) > 1.5 || Math.abs(a.height - b.height) > 1.5) {
        st.manual = true;
      }
    }
    if (st.manual) place(st);
  }

  function dropOverlay(st) {
    st.ov?.remove();
    st.ov = null;
    st.root = null;
    if (st.anchored) {
      st.anchored = false;
      if (st.prevAnchor) st.el.style.setProperty('anchor-name', st.prevAnchor);
      else st.el.style.removeProperty('anchor-name');
      if (!st.hadStyle && !st.el.getAttribute('style')) st.el.removeAttribute('style');
    }
  }

  // Measured placement, for browsers or layouts where anchoring is not available:
  // keep the overlay on top of the image in the coordinates of its containing block.
  function place(st) {
    const ov = st.ov;
    if (!ov?.isConnected) return;
    const ir = st.el.getBoundingClientRect();
    const op = ov.offsetParent;
    let css = HOST_CSS;
    if (!op || ir.width < 2 || ir.height < 2) {
      css += 'visibility:hidden!important;left:0!important;top:0!important;width:1px!important;height:1px!important;';
    } else {
      let left, top;
      if (op === document.body && getComputedStyle(op).position === 'static') {
        left = ir.left + scrollX;
        top = ir.top + scrollY;
      } else {
        const pr = op.getBoundingClientRect();
        left = ir.left - pr.left - op.clientLeft + op.scrollLeft;
        top = ir.top - pr.top - op.clientTop + op.scrollTop;
      }
      css += `left:${left.toFixed(1)}px!important;top:${top.toFixed(1)}px!important;` +
        `width:${ir.width.toFixed(1)}px!important;height:${ir.height.toFixed(1)}px!important;`;
    }
    if (css !== st.css) {
      ov.style.cssText = css;
      st.css = css;
    }
  }

  // Text that could not be sized while the image was hidden gets sized once it shows.
  function refit(st) {
    if (!st.needsFit || !st.root?.clientWidth) return;
    st.needsFit = false;
    for (const r of st.regions) if (r.node) fit(st, r);
  }

  // Largest font size at which the text fits its box, stored in cqw so it scales with the image.
  function fit(st, r) {
    const b = r.node;
    const t = b.firstChild;
    const rootW = st.root.clientWidth;
    const W = b.clientWidth;
    const H = b.clientHeight;
    if (!rootW || !W || !H) {
      st.needsFit = true;
      return;
    }
    const toCq = (px) => ((px / rootW) * 100).toFixed(3) + 'cqw';
    if (r.kind === 'sfx') {
      t.style.fontSize = toCq(Math.min(17, Math.max(10, H * 0.3)));
      return;
    }
    let lo = 7;
    let hi = Math.max(lo, Math.min(H * 0.85, 44));
    const fits = (px) => {
      t.style.fontSize = px + 'px';
      return t.scrollWidth <= W + 1 && t.offsetHeight <= H + 1;
    };
    if (fits(hi)) lo = hi;
    else {
      for (let k = 0; k < 7; k++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
    }
    t.style.fontSize = toCq(lo);
  }

  function render(st, r) {
    if (r.kind === 'sfx' && !G.sfx) return;
    const [x1, y1, x2, y2] = r.box;
    // Grow the patch a little so the edges of the original lettering are covered.
    const px = r.kind === 'sfx' ? 0 : Math.max((x2 - x1) * 0.07, 0.006);
    const py = r.kind === 'sfx' ? 0 : Math.max((y2 - y1) * 0.1, 0.004);
    const L = Math.max(0, x1 - px);
    const T = Math.max(0, y1 - py);
    const R = Math.min(1, x2 + px);
    const B = Math.min(1, y2 + py);
    const b = document.createElement('div');
    b.className = 'b';
    b.dataset.kind = r.kind;
    b.style.cssText = `left:${(L * 100).toFixed(3)}%;top:${(T * 100).toFixed(3)}%;width:${((R - L) * 100).toFixed(3)}%;height:${((B - T) * 100).toFixed(3)}%;`;
    const t = document.createElement('span');
    t.className = 't';
    t.dir = M.lang.dir || 'auto';
    t.textContent = r.text;
    if (r.kind !== 'sfx') {
      const k = r.look;
      const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
      t.style.color = rgb(k.fg);
      if (k.canvas && k.cbox) {
        // The lettering is erased pixel by pixel; the text gets a thin halo of the
        // fill colour so it stays readable if it spills past the bubble.
        const c = k.canvas;
        const [cx1, cy1, cx2, cy2] = k.cbox;
        c.className = 'c';
        c.style.cssText = `left:${(cx1 * 100).toFixed(3)}%;top:${(cy1 * 100).toFixed(3)}%;width:${((cx2 - cx1) * 100).toFixed(3)}%;height:${((cy2 - cy1) * 100).toFixed(3)}%;`;
        st.root.appendChild(c);
        r.cnode = c;
        const halo = rgb(k.bg);
        t.style.textShadow = `0 0 2px ${halo}, 0 0 3px ${halo}, 0 0 4px ${halo}`;
      } else {
        // Text drawn over artwork: a soft plate behind the translation instead.
        const plate = k.dark ? 'rgba(14,14,15,.84)' : 'rgba(255,255,255,.9)';
        b.style.background = plate;
        t.style.background = plate;
      }
    }
    b.appendChild(t);
    st.root.appendChild(b);
    r.node = b;
    fit(st, r);
  }

  function overlap(a, b) {
    const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (w <= 0 || h <= 0) return 0;
    const area = (q) => (q[2] - q[0]) * (q[3] - q[1]);
    return (w * h) / Math.max(1e-9, Math.min(area(a), area(b)));
  }

  function onRegion(st, tile, ev) {
    if (!G.on || !st.ov) return;
    const tb = ev.box;
    const eps = 0.012;
    const cutTop = tile.ovTop > 0 && tb[1] <= eps;
    const cutBot = tile.ovBot > 0 && tb[3] >= 1 - eps;
    // Lettering cut by a slice edge that the neighbouring slice shows whole.
    if (cutTop && tb[3] <= tile.ovTop + eps) return;
    if (cutBot && tb[1] >= 1 - tile.ovBot - eps) return;

    const toImage = (q) => [q[0], (tile.y0 + q[1] * tile.h) / st.H, q[2], (tile.y0 + q[3] * tile.h) / st.H];
    const box = toImage(tb);
    const shown = st.el.getBoundingClientRect().width;
    const look = ev.kind === 'sfx' ? null : analyse(tile, tb, shown > 0 ? shown / tile.cw : 1);
    if (look?.cbox) look.cbox = toImage(look.cbox);
    const r = { box, kind: ev.kind, text: ev.text, cut: cutTop || cutBot, look };

    for (let i = 0; i < st.regions.length; i++) {
      const o = st.regions[i];
      const ov = overlap(o.box, box);
      if (ov < 0.15) continue;
      if (o.cut && r.cut) {
        // Two halves of one tall bubble: join them.
        r.box = [Math.min(o.box[0], box[0]), Math.min(o.box[1], box[1]), Math.max(o.box[2], box[2]), Math.max(o.box[3], box[3])];
        if (o.text.length > r.text.length) r.text = o.text;
        r.cut = false;
      } else if (ov < 0.5 || !o.cut || r.cut) {
        if (ov >= 0.5) return; // same region seen twice: keep the first
        continue;
      }
      o.node?.remove();
      o.cnode?.remove();
      st.regions.splice(i, 1);
      break;
    }
    st.regions.push(r);
    render(st, r);
  }

  function setWait(st, on) {
    if (!st.root) return;
    let w = st.root.querySelector('.wait');
    if (on && !w) {
      w = document.createElement('div');
      w.className = 'wait';
      w.textContent = 'جاري الترجمة';
      st.root.appendChild(w);
    } else if (!on && w) {
      w.remove();
    }
  }

  // ---------- pipeline ----------

  async function processImage(st) {
    st.status = 'loading';
    G.active++;
    M.ui.refresh();
    let tiles = [];
    try {
      const bmp = await loadBitmap(st.el);
      st.W = bmp.width;
      st.H = bmp.height;
      tiles = await makeTiles(bmp);
      bmp.close?.();
      if (!G.on) return;
      ensureOverlay(st);
      setWait(st, true);
      st.regions = [];
      const results = await Promise.all(tiles.map((tile) => G.pool(() => translateTile(st, tile, tiles.length))));
      const err = results.find((r) => r?.error)?.error;
      if (err && !st.regions.length) {
        st.status = 'new';
        G.blocked = true;
        M.ui.error(err);
      } else {
        st.status = 'done';
        const lines = st.regions.filter((r) => r.kind !== 'sfx').map((r) => r.text);
        if (lines.length) G.prev = lines.join(' / ').slice(-500);
      }
    } catch {
      st.status = 'error';
      M.ui.note('في صورة ما قدرت أقرأها من هالموقع');
    } finally {
      for (const tile of tiles) tile.ctx = null;
      setWait(st, false);
      G.active--;
      M.ui.refresh();
      setTimeout(tick, 0);
    }
  }

  async function translateTile(st, tile, count) {
    if (!G.on) return null;
    const res = await M.request(
      {
        type: 'image',
        b64: tile.b64,
        mime: 'image/jpeg',
        ctx: {
          w: tile.cw,
          h: tile.ch,
          slice: count > 1 ? { y0: tile.y0, y1: tile.y0 + tile.h, H: st.H } : null,
          title: document.title,
          prev: G.prev,
        },
      },
      (ev) => {
        if (ev.type === 'region') onRegion(st, tile, ev);
        else if (ev.type === 'info') M.ui.note(ev.message);
      },
    );
    tile.b64 = null;
    return res;
  }

  const onScroll = () => {
    clearTimeout(G.scrollTimer);
    G.scrollTimer = setTimeout(tick, 150);
  };

  async function start() {
    G.on = true;
    G.blocked = false;
    try {
      const { settings } = await chrome.storage.local.get('settings');
      if (settings?.manga) {
        G.minSize = Math.max(120, +settings.manga.minSize || 260);
        G.sfx = settings.manga.sfx !== false;
      }
    } catch { /* defaults are fine */ }
    if (!G.on) return;
    if (G.langKey !== M.lang.key) {
      // Another target language: earlier translations no longer apply.
      G.items.clear();
      G.prev = '';
      G.langKey = M.lang.key;
    }
    // Bring back pages that were already translated before the user switched off.
    for (const st of G.items.values()) {
      if (st.status === 'done' && st.el.isConnected && st.src === srcOf(st.el)) {
        ensureOverlay(st);
        for (const r of st.regions) render(st, r);
      }
    }
    addEventListener('scroll', onScroll, { capture: true, passive: true });
    addEventListener('resize', onScroll, { passive: true });
    G.timer = setInterval(tick, 400);
    tick();
    M.ui.refresh();
  }

  function stop() {
    G.on = false;
    clearInterval(G.timer);
    clearTimeout(G.scrollTimer);
    removeEventListener('scroll', onScroll, { capture: true });
    removeEventListener('resize', onScroll);
    for (const [el, st] of G.items) {
      dropOverlay(st);
      for (const r of st.regions) r.node = r.cnode = null;
      if (st.status !== 'done') G.items.delete(el);
    }
    M.ui.clearError();
    M.ui.refresh();
  }

  M.modes.images = {
    set(on) {
      if (on === G.on) {
        if (on && G.blocked) { G.blocked = false; tick(); }
        return;
      }
      if (on) start();
      else stop();
    },
    state() {
      let total = 0, done = 0, failed = 0;
      for (const st of G.items.values()) {
        total++;
        if (st.status === 'done') done++;
        else if (st.status === 'error') failed++;
      }
      return { on: G.on, total, done, failed, busy: G.active > 0 };
    },
  };
})();
