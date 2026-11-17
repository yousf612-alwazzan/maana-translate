// Screenshots of the popup and the settings page for visual review, plus a
// check that nothing is translated before the user has given consent.
// Run: node shot-ui.mjs   (writes dev/out/ui-*.png)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { EXT, OUT, chromiumExe } from './common.mjs';

fs.mkdirSync(OUT, { recursive: true });
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maana-ui-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: chromiumExe(),
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
  viewport: { width: 1100, height: 900 },
  deviceScaleFactor: 1,
  ignoreDefaultArgs: ['--disable-extensions'],
});

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ' :: ' + detail}`);
};

try {
  const worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 10000 }));
  const id = new URL(worker.url()).host;
  const setSettings = (consent) =>
    worker.evaluate((c) =>
      chrome.storage.local.set({
        settings: {
          order: ['gemini', 'groq', 'openrouter', 'ollama', 'anthropic', 'openai', 'custom'],
          providers: {
            gemini: { enabled: true, apiKey: 'demo-key-not-real', model: '', visionModel: '', baseUrl: '' },
            groq: { enabled: true, apiKey: '', model: '', visionModel: '', baseUrl: '' },
            custom: { enabled: true, apiKey: 'x', model: 'm', visionModel: '', baseUrl: 'http://example.com/v1' },
          },
          style: 'fusha',
          extra: '',
          lowThinking: true,
          consent: c,
          autoSites: { 'example.com': 'both' },
          manga: { minSize: 260, sfx: true },
        },
      }), consent);

  const errors = [];
  const watch = (page, name) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  };

  // ---- before consent ----
  await setSettings(false);
  // A real web page: the browser reuses a blank tab when the settings page opens,
  // which would wipe a page built with setContent.
  const site = await ctx.newPage();
  let target = 'https://example.com/';
  try {
    await site.goto(target, { timeout: 15000 });
  } catch {
    target = '';
    await site.goto('data:text/html,<p>The quick brown fox jumps over the lazy dog.</p>');
  }
  const siteUrl = site.url();
  const siteText = await site.evaluate(() => document.body.innerText);
  // The settings page that opens on install would hide whether a new one is opened.
  const isOptions = (p) => p.url().includes('options.html');
  await site.waitForTimeout(500);
  for (const p of ctx.pages()) if (isOptions(p)) await p.close();
  await site.bringToFront();
  const res = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true });
    return globalThis.maana.setMode(tab.id, 'page', true);
  });
  check('translation refused before consent', res && res.needConsent === true, JSON.stringify(res));
  await site.waitForTimeout(600);
  check('page untouched before consent',
    site.url() === siteUrl && (await site.evaluate(() => document.body.innerText)) === siteText && !(await site.$('maana-ui')));
  let opened = false;
  for (let i = 0; i < 10 && !opened; i++) {
    opened = ctx.pages().some(isOptions);
    if (!opened) await site.waitForTimeout(250);
  }
  check('settings page opened to ask for consent', opened);
  for (const p of ctx.pages()) if (isOptions(p)) await p.close();

  const options = await ctx.newPage();
  watch(options, 'options');
  await options.goto(`chrome-extension://${id}/src/options/options.html`);
  await options.waitForSelector('.prov');
  check('consent box shown', await options.isVisible('#consentBox'));
  check('plain-http custom provider flagged', (await options.textContent('.prov:nth-child(7) .state')).includes('https'));
  await options.screenshot({ path: path.join(OUT, 'ui-options-consent.png') });

  const popup = await ctx.newPage();
  watch(popup, 'popup');
  await popup.setViewportSize({ width: 300, height: 470 });
  await popup.goto(`chrome-extension://${id}/src/popup/popup.html`);
  await popup.waitForTimeout(700);
  check('popup shows consent and disables actions', (await popup.isVisible('#consent')) && (await popup.isDisabled('#btnPage')));
  await popup.screenshot({ path: path.join(OUT, 'ui-popup-consent.png'), fullPage: true });

  // ---- give consent through the real button ----
  await options.bringToFront();
  await options.click('#consentBtn');
  await options.waitForTimeout(500);
  const stored = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.consent);
  check('consent saved by the button', stored === true);
  check('consent box hidden after agreeing', !(await options.isVisible('#consentBox')));

  // ---- normal state: no leftover test provider ----
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    delete settings.providers.custom;
    await chrome.storage.local.set({ settings });
  });
  await options.reload();
  await options.waitForSelector('.prov');
  await options.click('.prov:nth-child(1) .toggle');
  await options.screenshot({ path: path.join(OUT, 'ui-options.png'), fullPage: true });
  await options.click('.prov:nth-child(1) .toggle');
  await options.click('.prov:nth-child(4) .toggle');
  await options.screenshot({ path: path.join(OUT, 'ui-options-ollama.png'), fullPage: true });

  // The popup over an ordinary web page: actions enabled, no notices.
  check('opened a normal page for the popup', !!target);
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0]?.id, target);
  await popup.setViewportSize({ width: 300, height: 330 });
  await popup.goto(`chrome-extension://${id}/src/popup/popup.html?tab=${tabId}`);
  await popup.waitForTimeout(1200);
  check('popup consent gone after agreeing', !(await popup.isVisible('#consent')));
  check('popup actions enabled on a normal page', !(await popup.isDisabled('#btnPage')) && !(await popup.isVisible('#msg')));
  await popup.screenshot({ path: path.join(OUT, 'ui-popup.png'), fullPage: true });

  check('no console errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  // A thrown error must fail the run loudly, never pass as "no failed checks".
  failed++;
  console.log('ERROR ' + String((e && e.stack) || e).split('\n').slice(0, 6).join(' | '));
} finally {
  await ctx.close().catch(() => {});
  fs.rmSync(userDir, { recursive: true, force: true });
  console.log(failed ? `${failed} check(s) failed` : 'all UI checks passed');
  process.exitCode = failed ? 1 : 0;
}
