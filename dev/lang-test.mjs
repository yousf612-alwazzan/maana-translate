// Checks for "any language to any language":
//   - with Arabic as the target, Arabic text is skipped but Persian (same script) is translated
//   - with English as the target, an Arabic right-to-left page is sent, laid out left-to-right,
//     and restored exactly
//   - the prompt names the chosen language, including one typed by the user
// Run: node lang-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { EXT, FIX, chromiumExe } from './common.mjs';
import { start } from './mock-server.mjs';

fs.writeFileSync(path.join(FIX, 'lang-mixed.html'), `<!doctype html><meta charset="utf-8"><title>Mixed languages</title>
<p id="ar">هذا نص عربي عادي ولا يحتاج إلى ترجمة.</p>
<p id="fa">این یک متن فارسی است که باید ترجمه شود.</p>
<p id="en">This sentence is written in English.</p>
<p id="ja">これは日本語の文章です。</p>`);
fs.writeFileSync(path.join(FIX, 'lang-rtl.html'), `<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8"><title>صفحة عربية</title>
<style>ul{padding:0 30px 0 0}</style>
<h1 id="h">عنوان الصفحة العربية</h1>
<p id="p1">هذه فقرة عربية فيها <a id="a1" href="#x">رابط</a> داخل الجملة.</p>
<ul id="list"><li id="li1">العنصر الأول في القائمة</li><li>العنصر الثاني</li></ul></html>`);

await start({});
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maana-lang-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: chromiumExe(),
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
  viewport: { width: 1100, height: 800 },
  ignoreDefaultArgs: ['--disable-extensions'],
});

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ' :: ' + detail}`);
};
const admin = (p, method = 'GET') => fetch('http://127.0.0.1:8787' + p, { method }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 10000 }));
  const configure = (extra) =>
    worker.evaluate((x) =>
      chrome.storage.local.set({
        settings: {
          order: ['custom'],
          providers: { gemini: { enabled: false }, custom: { enabled: true, apiKey: 'x', model: 'mock-text', visionModel: 'mock-vision', baseUrl: 'http://127.0.0.1:8787/v1' } },
          style: 'fusha', extra: '', lowThinking: true, consent: true, autoSites: {}, manga: { minSize: 260, sfx: true },
          ...x,
        },
      }), extra);
  const setMode = (on) => worker.evaluate(async (o) => {
    const [tab] = await chrome.tabs.query({ active: true });
    return globalThis.maana.setMode(tab.id, 'page', o);
  }, on);
  const settle = async () => {
    let last = '';
    let same = 0;
    for (let i = 0; i < 60 && same < 3; i++) {
      await sleep(300);
      const s = JSON.stringify(await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true });
        return (await globalThis.maana.getState(tab.id)).page;
      }));
      same = s === last && !JSON.parse(s).busy ? same + 1 : 0;
      last = s;
    }
    return JSON.parse(last);
  };
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ---- 1. any language into Arabic ----
  await configure({ targetLang: 'ar' });
  await admin('/admin/reset', 'POST');
  await page.goto('http://127.0.0.1:8787/lang-mixed.html');
  await page.bringToFront();
  const arBefore = await page.textContent('#ar');
  await setMode(true);
  let st = await settle();
  let stats = await admin('/admin/stats');
  const sent = stats.itemCounts.reduce((a, b) => a + b, 0);
  check('Arabic target: three non-Arabic paragraphs are sent, the Arabic one is not', sent === 3, `sent ${sent}, state ${JSON.stringify(st)}`);
  check('Arabic paragraph left untouched', (await page.textContent('#ar')) === arBefore);
  check('Persian paragraph is treated as needing translation', (await page.getAttribute('#fa', 'dir')) === 'rtl');
  check('English paragraph translated and laid out right-to-left', /[؀-ۿ]/.test(await page.textContent('#en')) && (await page.getAttribute('#en', 'dir')) === 'rtl');
  check('prompt asks for Arabic', /into Arabic/.test(stats.lastSystem) && /Modern Standard Arabic/.test(stats.lastSystem));
  await setMode(false);

  // ---- 2. Arabic page into English ----
  await configure({ targetLang: 'en' });
  await admin('/admin/reset', 'POST');
  await page.goto('http://127.0.0.1:8787/lang-rtl.html');
  const before = await page.evaluate(() => document.body.innerHTML);
  const linkBefore = await page.evaluate(() => { window.__a = document.querySelector('#a1'); return true; });
  await setMode(true);
  st = await settle();
  stats = await admin('/admin/stats');
  check('English target: Arabic text is sent (not skipped as already translated)', stats.itemCounts.reduce((a, b) => a + b, 0) >= 4, JSON.stringify(stats.itemCounts));
  check('prompt asks for English and drops the Arabic dialect note', /into English/.test(stats.lastSystem) && !/Modern Standard Arabic|Gulf colloquial/.test(stats.lastSystem));
  check('paragraph switched to left-to-right', (await page.getAttribute('#p1', 'dir')) === 'ltr' && (await page.evaluate(() => getComputedStyle(document.querySelector('#p1')).direction)) === 'ltr');
  const pad = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('#list')); return [c.direction, c.paddingLeft, c.paddingRight]; });
  check('list follows: left-to-right with the indent moved to the left', pad[0] === 'ltr' && pad[1] === '30px' && pad[2] === '0px', pad.join(' '));
  check('link is still the same element', linkBefore && (await page.evaluate(() => window.__a === document.querySelector('#a1') && window.__a.isConnected)));
  await setMode(false);
  await sleep(300);
  const after = await page.evaluate(() => document.body.innerHTML.replace(/<maana-ui[\s\S]*?<\/maana-ui>/g, ''));
  let at = 0;
  while (at < before.length && before[at] === after[at]) at++;
  check('original page restored exactly', after === before,
    `differs at ${at}: was ${JSON.stringify(before.slice(Math.max(0, at - 50), at + 70))} now ${JSON.stringify(after.slice(Math.max(0, at - 50), at + 70))}`);

  // ---- 3. changing the language retranslates the same page ----
  await configure({ targetLang: 'ja' });
  await admin('/admin/reset', 'POST');
  await page.goto('http://127.0.0.1:8787/lang-mixed.html');
  await setMode(true);
  await settle();
  stats = await admin('/admin/stats');
  check('Japanese target: the Japanese paragraph is skipped, the other three are sent', stats.itemCounts.reduce((a, b) => a + b, 0) === 3, JSON.stringify(stats.itemCounts));
  check('prompt asks for Japanese', /into Japanese/.test(stats.lastSystem));
  check('a left-to-right target does not force right-to-left', (await page.getAttribute('#en', 'dir')) !== 'rtl');
  await configure({ targetLang: 'ar' });
  await admin('/admin/reset', 'POST');
  await setMode(false);
  await setMode(true);
  st = await settle();
  // These three were already translated into Arabic in part 1, so they come from the saved
  // translations; what matters is that the page is redone for the new language.
  check('switching to Arabic on the same page retranslates it', st.done === 3 && (await page.getAttribute('#ja', 'dir')) === 'rtl' && (await page.getAttribute('#en', 'dir')) === 'rtl', JSON.stringify(st));
  await setMode(false);

  // ---- 4. a language typed by name ----
  await configure({ targetLang: 'other', targetOther: 'Swahili' });
  await admin('/admin/reset', 'POST');
  await page.reload();
  await setMode(true);
  await settle();
  stats = await admin('/admin/stats');
  check('typed language reaches the prompt', /into Swahili/.test(stats.lastSystem));
  check('typed language: nothing is skipped and direction is left alone', stats.itemCounts.reduce((a, b) => a + b, 0) === 4 && (await page.getAttribute('#en', 'dir')) === null, JSON.stringify(stats.itemCounts));
  await setMode(false);

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  failed++;
  console.log('ERROR ' + String((e && e.stack) || e).split('\n').slice(0, 6).join(' | '));
} finally {
  await ctx.close().catch(() => {});
  fs.rmSync(userDir, { recursive: true, force: true });
  console.log(failed ? `${failed} check(s) failed` : 'all language checks passed');
  process.exit(failed ? 1 : 0);
}
