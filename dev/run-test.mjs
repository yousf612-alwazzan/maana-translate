// End-to-end harness for the Maana extension.  Usage: node run-test.mjs   (env: EXT_DIR, HEADED=1, ONLY=page|comic)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { start } from './mock-server.mjs';
import { EXT, FIX, OUT, chromiumExe } from './common.mjs';

const EXT_DIR = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : EXT;
const A = 'http://127.0.0.1:8787';
const ARABIC = /[؀-ۿ]/;
const results = [];
const diag = []; // console errors etc.
let currentTitle = '';

function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''}`);
}
async function section(title, fn) {
  currentTitle = title;
  if (ctx) await boot(); // fresh profile: the extension keeps a persistent translation cache
  console.log(`\n== ${title}`);
  try { await fn(); } catch (e) { check(`${title}: no exception`, false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
  console.error(`No manifest.json in ${EXT_DIR}; the extension has not landed yet.`);
  process.exit(2);
}
for (const f of ['page.html', 'comic.json', 'page1.png', 'strip.png']) if (!fs.existsSync(path.join(FIX, f))) { console.error('Missing fixture ' + f + '; run node make-fixtures.mjs'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const comic = JSON.parse(fs.readFileSync(path.join(FIX, 'comic.json'), 'utf8'));

const servers = await start({});

/* ---------------- browser launch ---------------- */
async function launch(headed) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maana-pw-'));
  const args = [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--no-default-browser-check'];
  if (!headed) args.push('--headless=new');
  const ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: chromiumExe(), headless: false, args, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, ignoreDefaultArgs: ['--disable-extensions'],
  });
  let worker = ctx.serviceWorkers()[0];
  if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
  return { ctx, worker, userDir };
}
let ctx, worker, headed = !!process.env.HEADED;
const swLog = [];
async function boot() {
  if (ctx) await ctx.close().catch(() => { });
  ({ ctx, worker } = await launch(headed));
  if (!worker && !headed) {
    console.log('(no service worker in headless=new, retrying headed)');
    await ctx.close().catch(() => { });
    headed = true;
    ({ ctx, worker } = await launch(true));
  }
  if (!worker) { console.error('FATAL: extension service worker never appeared (extension failed to load: check manifest.json references exist, e.g. popup/options pages).'); await servers.stop(); process.exit(2); }
  worker.on?.('console', m => { if (['error', 'warning'].includes(m.type())) swLog.push(`[sw ${m.type()}] ${m.text()}`); });
}
await boot();
console.log('service worker:', worker.url());
const pageErrors = [];
function watch(page, label) {
  page.on('pageerror', e => pageErrors.push(`[${label} pageerror] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.location().url || '')) pageErrors.push(`[${label} console.error] ${m.text()}`); });
}

/* ---------------- helpers ---------------- */
const mockPost = (p) => fetch(A + p, { method: 'POST' }).then(r => r.json());
const stats = () => fetch(A + '/admin/stats').then(r => r.json());
const settingsFor = (variant) => {
  const mk = base => ({ enabled: true, apiKey: 'x', model: 'mock-text', visionModel: 'mock-vision', baseUrl: base });
  return {
    order: ['groq', 'custom'],
    providers: { groq: { ...mk('http://127.0.0.1:8789/v1'), enabled: variant === 'fallback' }, custom: mk('http://127.0.0.1:8787/v1') },
    style: 'fusha', extra: '', lowThinking: true, consent: true, autoSites: {}, manga: { minSize: 260, sfx: true },
  };
};
const setSettings = s => worker.evaluate(s => chrome.storage.local.set({ settings: s }), s);
const tabIdFor = url => worker.evaluate(async u => { const t = await chrome.tabs.query({ url: u }); return t.length ? t[0].id : null; }, url);
const setMode = (tab, mode, on) => worker.evaluate(([t, m, o]) => globalThis.maana.setMode(t, m, o), [tab, mode, on]);
const getState = tab => worker.evaluate(t => globalThis.maana.getState(t), tab);

async function waitDone(tab, mode, { timeout = 30000, stable = 3, minTotal = 1, onTick } = {}) {
  const t0 = Date.now(); let ok = 0, st, last = '';
  while (Date.now() - t0 < timeout) {
    st = (await getState(tab))[mode];
    const sig = st && `${st.done}/${st.failed}`;
    const idle = st && st.on && st.total >= minTotal && ('busy' in st ? !st.busy && sig === last : st.done + st.failed >= st.total);
    if (idle && (st.done > 0 || st.failed > 0)) { if (++ok >= stable) return st; } else ok = 0;
    last = sig;
    if (onTick) await onTick();
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${mode} idle; last state ${JSON.stringify(st)}`);
}

async function newPage(url, label, opts = {}) {
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(url, { waitUntil: opts.until || 'domcontentloaded' });
  await page.bringToFront();
  return page;
}

const bodySnapshot = page => page.evaluate(() => {
  const c = document.body.cloneNode(true);
  c.querySelectorAll('maana-ui,maana-ov,#late').forEach(e => e.remove());
  return c.innerHTML;
});

/* ---------------- PAGE TESTS ---------------- */
async function pageScenario(variant) {
  const tag = `page(${variant})`;
  await mockPost('/admin/reset');
  await setSettings(settingsFor(variant));
  const page = await newPage(`${A}/page.html`, tag);
  const url = `${A}/page.html`;
  const tab = await tabIdFor(url);
  check(`${tag}: tab id found`, tab != null, tab);
  // snapshot (before the 1.5s late paragraph) and stash refs
  const before = await bodySnapshot(page);
  const ids = ['lnk1', 'lnk2', 'lnk3', 'lnk4', 'lnk5', 'lnkr', 'lnkd', 'lnks', 'lnkf'];
  const hrefs = await page.evaluate(ids => { window.__refs = {}; const h = {}; for (const i of ids) { const e = document.getElementById(i); window.__refs[i] = e; h[i] = e.getAttribute('href'); } return h; }, ids);
  const untouchedIds = ['code1', 'pre', 'inp', 'ar', 'hidden', 'notrans'];
  const untouched = await page.evaluate(ids => Object.fromEntries(ids.map(i => [i, document.getElementById(i).outerHTML])), untouchedIds);
  const farTop = await page.evaluate(() => document.getElementById('far1').getBoundingClientRect().top + scrollY);
  const pageH = await page.evaluate(() => document.documentElement.scrollHeight);
  check(`${tag}: fixture is tall (about 6 screens) and far paragraph is >3 screens down`, farTop > 3 * 800 + 100 && pageH > 5 * 800, { farTop, pageH });

  await setMode(tab, 'page', true);
  const st = await waitDone(tab, 'page');
  check(`${tag}: state reports done (<=1 failed: the SKIPME unit)`, st.done > 0 && st.failed <= 1 && !st.busy, st);

  // visible text blocks
  const blocks = await page.evaluate(() => {
    const sel = ['h1', '#h2-1', '#h3-1', '#p1', '#p2', '#p3', '#p4', '#li1', '#li2', '#li3', '#oli1', '#oli2', '#oli3', '#th1', '#td1', '#mx1', '#mx2', '#sec2 p', '#sec3 p', '#nav1'];
    const out = {};
    for (const s of sel) {
      const el = document.querySelector(s); if (!el) { out[s] = { missing: true }; continue; }
      const c = el.cloneNode(true);
      c.querySelectorAll('code,pre,[translate="no"],input,script,style').forEach(e => e.remove());
      const txt = c.textContent;
      out[s] = { ar: /[؀-ۿ]/.test(txt), latin: (txt.match(/[A-Za-z]{2,}/g) || []).slice(0, 5), txt: txt.slice(0, 80) };
    }
    return out;
  });
  const near = Object.entries(blocks).filter(([k]) => !/^#sec[23]/.test(k));
  const noAr = near.filter(([, v]) => v.missing || !v.ar).map(([k, v]) => k + (v.txt ? ' ' + JSON.stringify(v.txt) : ''));
  check(`${tag}: visible blocks contain Arabic`, noAr.length === 0, noAr);
  const lat = near.filter(([, v]) => v.latin && v.latin.length).map(([k, v]) => k + ' ' + v.latin.join(','));
  check(`${tag}: no Latin words left in visible blocks`, lat.length === 0, lat);

  const links = await page.evaluate(([ids, hrefs]) => ids.filter(i => ['lnk1', 'lnk2', 'lnk3', 'lnk4', 'lnk5', 'lnkr', 'lnkd', 'lnks'].includes(i)).map(i => {
    const e = document.getElementById(i);
    return { i, same: e === window.__refs[i], href: e && e.getAttribute('href') === hrefs[i], connected: !!e && e.isConnected, text: e ? e.textContent.trim().length : 0 };
  }), [ids, hrefs]);
  check(`${tag}: every <a> is the same element and keeps href`, links.every(l => l.same && l.href && l.connected), links.filter(l => !(l.same && l.href && l.connected)));
  check(`${tag}: links keep non-empty text`, links.every(l => l.text > 0), links.filter(l => !l.text));
  const lnk1 = await page.evaluate(() => document.getElementById('lnk1').textContent);
  check(`${tag}: link text is translated`, ARABIC.test(lnk1), lnk1);

  const after = await page.evaluate(ids => Object.fromEntries(ids.map(i => [i, document.getElementById(i).outerHTML])), untouchedIds);
  for (const i of untouchedIds) check(`${tag}: #${i} untouched`, after[i] === untouched[i], { before: untouched[i].slice(0, 150), after: after[i].slice(0, 150) });

  const special = await page.evaluate(() => ['reorder', 'dropt', 'skip'].map(i => { const e = document.getElementById(i); return { i, txt: e.textContent.slice(0, 90), links: e.querySelectorAll('a').length }; }));
  check(`${tag}: REORDER/DROPTAG/SKIPME paragraphs keep their links`, special.every(s => s.links === 1), special);
  check(`${tag}: REORDER and DROPTAG paragraphs got translated`, ARABIC.test(special[0].txt) && ARABIC.test(special[1].txt), special);
  check(`${tag}: SKIPME paragraph survives (English or untouched, no crash)`, special[2].txt.length > 10, special[2]);
  const errsNow = pageErrors.filter(e => e.includes(tag)).length;
  check(`${tag}: no page errors so far`, errsNow === 0, pageErrors.filter(e => e.includes(tag)));

  const dirs = await page.evaluate(() => Object.fromEntries(['p1', 'p2', 'ul1', 'ol1', 'mx1'].map(i => { const e = document.getElementById(i); return [i, getComputedStyle(e).direction]; })));
  check(`${tag}: lists and paragraphs have direction rtl`, Object.values(dirs).every(d => d === 'rtl'), dirs);
  const dirAttr = await page.evaluate(() => document.getElementById('p1').getAttribute('dir'));
  check(`${tag}: fully translated block has dir="rtl"`, dirAttr === 'rtl', dirAttr);

  // late paragraph
  const lateOk = await page.waitForFunction(() => { const l = document.getElementById('late'); return l && /[؀-ۿ]/.test(l.textContent); }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  check(`${tag}: late paragraph translated`, lateOk, await page.evaluate(() => document.getElementById('late') && document.getElementById('late').textContent));

  const s1 = await stats();
  check(`${tag}: more than one text request`, s1.text > 1, s1);
  check(`${tag}: first text request is small (<= 30 items, ~1500 chars)`, s1.itemCounts[0] <= 30, s1.itemCounts);
  if (variant === 'fallback') check(`${tag}: translation completed through fallback provider`, s1.text >= 1 && st.failed <= 1 && !st.busy, s1);

  // far content
  const farBefore = await page.evaluate(() => document.getElementById('far1').textContent);
  check(`${tag}: far content still English before scrolling`, !ARABIC.test(farBefore), farBefore);
  await page.evaluate(() => document.getElementById('far1').scrollIntoView({ block: 'center' }));
  const farOk = await page.waitForFunction(() => /[؀-ۿ]/.test(document.getElementById('far1').textContent), null, { timeout: 20000 }).then(() => true).catch(() => false);
  check(`${tag}: far content translated after scrolling`, farOk, await page.evaluate(() => document.getElementById('far1').textContent));
  await waitDone(tab, 'page').catch(e => check(`${tag}: done after scroll`, false, String(e)));
  await page.evaluate(() => scrollTo(0, 0));

  // off => restore
  await setMode(tab, 'page', false);
  await sleep(500);
  const restored = await bodySnapshot(page);
  const same = restored === before;
  let firstDiff = '';
  if (!same) { let i = 0; while (i < restored.length && restored[i] === before[i]) i++; firstDiff = `at ${i}: before=${JSON.stringify(before.slice(Math.max(0, i - 60), i + 100))} after=${JSON.stringify(restored.slice(Math.max(0, i - 60), i + 100))}`; }
  check(`${tag}: page off restores original DOM exactly`, same, firstDiff);
  const stOff = (await getState(tab)).page;
  check(`${tag}: state shows page mode off`, !stOff.on, stOff);

  // on again => cache, zero new requests
  const s2 = await stats();
  await setMode(tab, 'page', true);
  await waitDone(tab, 'page').catch(e => check(`${tag}: re-enable done`, false, String(e)));
  await sleep(500);
  const s3 = await stats();
  const arAgain = await page.evaluate(() => /[؀-ۿ]/.test(document.getElementById('p1').textContent));
  check(`${tag}: turning on again restores translation`, arAgain);
  const newReq = s3.itemCounts.slice(s2.itemCounts.length);
  check(`${tag}: turning on again makes no new requests (except at most one 1-item retry of the SKIPME unit)`, s3.vision === s2.vision && newReq.length <= 1 && newReq.every(n => n === 1), { before: s2, after: s3 });
  await page.screenshot({ path: path.join(OUT, `page-after-${variant}.png`), fullPage: true }); // translated state
  await setMode(tab, 'page', false);
  await sleep(400);
  // original state again (screenshots are taken last because Playwright may touch inline styles)
  if (variant === 'direct') await page.screenshot({ path: path.join(OUT, 'page-before.png'), fullPage: true });
  await page.close();
}

/* ---------------- COMIC TESTS ---------------- */
// runs in page; returns per-region result
const COV = ({ spec, imgSel }) => {
  {
    const img = document.querySelector(imgSel);
    const ov = img.nextElementSibling;
    if (!ov || ov.tagName !== 'MAANA-OV') return { error: 'no maana-ov after image', next: ov && ov.tagName };
    const root = ov.shadowRoot; if (!root) return { error: 'maana-ov has no open shadowRoot' };
    const bs = [...root.querySelectorAll('.root .b')];
    const ir = img.getBoundingClientRect();
    const s = ir.width / spec.w, tol = 0.03 * ir.width;
    const rects = bs.map(b => { const r = b.getBoundingClientRect(); return { l: r.left - ir.left, t: r.top - ir.top, r: r.right - ir.left, b: r.bottom - ir.top, kind: b.dataset.kind, txt: (b.querySelector('.t') || {}).textContent || '' }; });
    const used = new Set(); const missing = [];
    spec.regions.forEach((g, gi) => {
      const [x1, y1, x2, y2] = g.box.map(v => v * s);
      let hit = rects.findIndex((r, ri) => !used.has(ri) && r.l <= x1 + tol && r.t <= y1 + tol && r.r >= x2 - tol && r.b >= y2 - tol && (r.r - r.l) < ir.width * 0.9);
      if (hit < 0) missing.push({ gi, want: [x1, y1, x2, y2].map(Math.round), type: g.type }); else used.add(hit);
    });
    const dup = []; // regions covering the same GT twice
    spec.regions.forEach((g, gi) => {
      const [x1, y1, x2, y2] = g.box.map(v => v * s);
      const n = rects.filter(r => r.l <= x1 + tol && r.t <= y1 + tol && r.r >= x2 - tol && r.b >= y2 - tol && (r.r - r.l) < ir.width * 0.9).length;
      if (n > 1) dup.push({ gi, n });
    });
    return { count: bs.length, missing, dup, arabic: rects.filter(r => /[؀-ۿ]/.test(r.txt)).length, kinds: rects.map(r => r.kind), imgW: Math.round(ir.width), tol: Math.round(tol), sample: rects.slice(0, 2).map(r => ({ l: Math.round(r.l), t: Math.round(r.t), r: Math.round(r.r), b: Math.round(r.b) })) };
  }
};
const coverage = (spec, imgSel) => [COV, { spec, imgSel }];
const cov = (page, spec, sel) => page.evaluate(COV, { spec, imgSel: sel });

async function comicScenario(htmlName, label) {
  const tag = `comic(${label})`;
  await mockPost('/admin/reset');
  await setSettings(settingsFor('direct'));
  const page = await newPage(`${A}/${htmlName}`, tag, { until: 'load' });
  const tab = await tabIdFor(`${A}/${htmlName}`);
  check(`${tag}: tab id found`, tab != null, tab);
  await page.screenshot({ path: path.join(OUT, `${label}-before.png`), fullPage: true });
  const nat = await page.evaluate(() => ['p1', 'strip', 'thumb'].map(i => { const e = document.getElementById(i); return [i, e.naturalWidth, e.naturalHeight, e.complete]; }));
  check(`${tag}: images loaded from second origin`, nat.every(n => n[1] > 0), nat);

  await setMode(tab, 'images', true);
  let y = 0;
  const st = await waitDone(tab, 'images', { timeout: 90000, minTotal: 2, onTick: async () => { y += 700; await page.evaluate(y => scrollTo(0, y), y % 7000).catch(() => { }); } });
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(600);
  check(`${tag}: images state done, none failed`, st.done >= 2 && st.failed === 0, st);
  const chip = await page.evaluate(() => !!document.documentElement.querySelector(':scope > maana-ui'));
  check(`${tag}: status chip <maana-ui> present on <html>`, chip);

  const p1 = await cov(page, comic.page1, '#p1');
  check(`${tag}: #p1 has an overlay with ${comic.page1.regions.length} regions`, !p1.error && p1.count === comic.page1.regions.length, p1);
  check(`${tag}: #p1 every region box covers its text (within 3%)`, !p1.error && p1.missing.length === 0, p1.missing || p1);
  check(`${tag}: #p1 overlay text is Arabic`, !p1.error && p1.arabic === p1.count, p1);
  const sp = await cov(page, comic.strip, '#strip');
  check(`${tag}: #strip has each of its ${comic.strip.regions.length} regions exactly once`, !sp.error && sp.count === comic.strip.regions.length && sp.dup.length === 0, sp);
  check(`${tag}: #strip every region box covers its text (within 3%)`, !sp.error && sp.missing.length === 0, sp.missing || sp);
  const ovCount = await page.evaluate(() => ({ total: document.querySelectorAll('maana-ov').length, thumbNext: document.getElementById('thumb').nextElementSibling && document.getElementById('thumb').nextElementSibling.tagName, stripNext: document.getElementById('strip').nextElementSibling.tagName }));
  check(`${tag}: thumbnail has no overlay (2 overlays total)`, ovCount.total === 2 && ovCount.thumbNext !== 'MAANA-OV', ovCount);
  const kinds = [...new Set([...(p1.kinds || []), ...(sp.kinds || [])])];
  check(`${tag}: .b elements carry data-kind`, kinds.length > 0 && kinds.every(k => !!k), kinds);
  const s1 = await stats();
  check(`${tag}: vision requests made (strip sliced into several)`, s1.vision >= 2, s1);
  await page.screenshot({ path: path.join(OUT, `${label}-after.png`), fullPage: true });

  // resize + scroll alignment
  await page.setViewportSize({ width: 900, height: 700 });
  await sleep(700);
  const r1 = await cov(page, comic.page1, '#p1'); const r2 = await cov(page, comic.strip, '#strip');
  check(`${tag}: overlays aligned after window resize`, !r1.error && !r2.error && r1.missing.length === 0 && r2.missing.length === 0 && r1.count === comic.page1.regions.length && r2.count === comic.strip.regions.length, { p1: r1.missing, strip: r2.missing });
  await page.evaluate(() => scrollTo(0, 2500)); await sleep(500);
  const c1 = await cov(page, comic.page1, '#p1'); const c2 = await cov(page, comic.strip, '#strip');
  check(`${tag}: overlays aligned after scrolling`, !c1.error && !c2.error && c1.missing.length === 0 && c2.missing.length === 0, { p1: c1.missing, strip: c2.missing });
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(500);
  const r3 = await cov(page, comic.strip, '#strip');
  check(`${tag}: overlays aligned after resizing back`, !r3.error && r3.missing.length === 0, r3.missing);

  await setMode(tab, 'images', false);
  await sleep(500);
  const left = await page.evaluate(() => document.querySelectorAll('maana-ov').length);
  check(`${tag}: images off removes all overlays`, left === 0, left);
  const stOff = (await getState(tab)).images;
  check(`${tag}: state shows images mode off`, !stOff.on, stOff);
  await page.close();
}

/* ---------------- run ---------------- */
const only = process.env.ONLY;
if (!only || only === 'page') {
  await section('page.html (groq disabled)', () => pageScenario('direct'));
  await section('page.html (groq on port C first, fallback)', () => pageScenario('fallback'));
}
if (!only || only === 'comic') {
  await section('comic.html (direct image URLs)', () => comicScenario('comic.html', 'comic'));
  await section('comic-ref.html (Referer-protected image URLs)', () => comicScenario('comic-ref.html', 'comic-ref'));
}

/* ---------------- summary ---------------- */
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('Failed: ' + failed.map(f => f.name).join('; '));
  const uniq = a => [...new Set(a)];
  if (pageErrors.length) console.log('\nPage console/page errors:\n' + uniq(pageErrors).slice(0, 25).join('\n'));
  if (swLog.length) console.log('\nService worker errors/warnings:\n' + uniq(swLog).slice(0, 25).join('\n'));
}
console.log('Screenshots in ' + OUT);
await ctx.close().catch(() => { });
await servers.stop();
process.exit(failed.length ? 1 : 0);
