// End-to-end run in a real browser with a real local model (Ollama), for visual
// review: translates idioms.html in place and the first comic page.
// Needs Ollama running with OLLAMA_ORIGINS=chrome-extension://*
// Run: MODEL=<an Ollama model with vision> node real-e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { EXT, OUT, chromiumExe } from './common.mjs';
import { start } from './mock-server.mjs';

const MODEL = process.env.MODEL;
if (!MODEL) {
  console.error('Set MODEL to an Ollama model that can read images, for example: MODEL=qwen3:latest node real-e2e.mjs');
  process.exit(2);
}
await start({});
fs.mkdirSync(OUT, { recursive: true });
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maana-real-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: chromiumExe(),
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
  viewport: { width: 1180, height: 900 },
  ignoreDefaultArgs: ['--disable-extensions'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 10000 }));
  await worker.evaluate((model) =>
    chrome.storage.local.set({
      settings: {
        order: ['ollama'],
        providers: { gemini: { enabled: false }, ollama: { enabled: true, apiKey: '', model, visionModel: model, baseUrl: '' } },
        style: 'fusha', extra: '', lowThinking: true, consent: true, autoSites: {}, manga: { minSize: 260, sfx: true },
      },
    }), MODEL);

  const setMode = (mode, on) => worker.evaluate(async ([m, o]) => {
    const [tab] = await chrome.tabs.query({ active: true });
    return globalThis.maana.setMode(tab.id, m, o);
  }, [mode, on]);
  const state = () => worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true });
    return globalThis.maana.getState(tab.id);
  });
  async function settle(mode, maxMs) {
    const t0 = Date.now();
    let firstDone = 0;
    let last = '';
    let same = 0;
    while (Date.now() - t0 < maxMs) {
      await sleep(500);
      const s = (await state())[mode];
      if (!firstDone && s.done > 0) firstDone = Date.now() - t0;
      const key = JSON.stringify(s);
      same = key === last ? same + 1 : 0;
      last = key;
      if (!s.busy && same >= 3 && s.done + s.failed > 0) break;
    }
    return { firstDone, total: Date.now() - t0, state: JSON.parse(last || '{}') };
  }

  // --- page text ---
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:8787/idioms.html');
  await page.screenshot({ path: path.join(OUT, 'real-idioms-before.png'), fullPage: true });
  await setMode('page', true);
  const r1 = await settle('page', 240000);
  console.log('page:', JSON.stringify(r1));
  const chip = await page.evaluate(() => document.querySelector('maana-ui')?.shadowRoot.querySelector('.msg')?.textContent || '');
  console.log('chip:', chip);
  await page.screenshot({ path: path.join(OUT, 'real-idioms-after.png'), fullPage: true });
  const texts = await page.evaluate(() => [...document.querySelectorAll('p')].slice(0, 12).map((p) => p.textContent.trim()));
  console.log(texts.join('\n'));

  // --- comic page ---
  const comic = await ctx.newPage();
  comic.on('pageerror', (e) => errors.push(e.message));
  await comic.goto('http://127.0.0.1:8787/comic.html');
  await comic.waitForLoadState('load');
  await comic.bringToFront();
  await setMode('images', true);
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < 180000) {
    await sleep(700);
    n = await comic.evaluate(() => {
      const ov = document.querySelector('#p1')?.nextElementSibling;
      if (!ov || ov.localName !== 'maana-ov') return -1;
      const root = ov.shadowRoot.querySelector('.root');
      return root.querySelector('.wait') ? -1 : root.querySelectorAll('.b').length;
    });
    if (n >= 0) break;
  }
  console.log('comic p1 regions:', n, 'in', Date.now() - t0, 'ms');
  await sleep(600);
  await comic.locator('#p1').screenshot({ path: path.join(OUT, 'real-comic-p1.png') });
  const chip2 = await comic.evaluate(() => document.querySelector('maana-ui')?.shadowRoot.querySelector('.msg')?.textContent || '');
  console.log('chip:', chip2);
  if (errors.length) console.log('PAGE ERRORS:', errors.join(' | '));
} finally {
  await ctx.close();
  fs.rmSync(userDir, { recursive: true, force: true });
  process.exit(0);
}
