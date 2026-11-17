// End-to-end test of the one-click OpenRouter connect, against the mock in
// mock-server.mjs (which checks the PKCE verifier like the real service).
// Run: node connect-test.mjs   (writes dev/out/ui-connect-*.png)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { EXT, OUT, chromiumExe } from './common.mjs';
import { start } from './mock-server.mjs';

const MOCK = 'http://127.0.0.1:8787';
const KEY = 'sk-or-v1-mock-key-0001';
fs.mkdirSync(OUT, { recursive: true });
const server = await start();
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maana-connect-'));
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
const admin = async (q = '') => (await fetch(`${MOCK}/admin/or${q}`)).json();
const wait = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
};

try {
  const worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 10000 }));
  const id = new URL(worker.url()).host;
  const optionsUrl = `chrome-extension://${id}/src/options/options.html`;
  const errors = [];
  const watch = (page, name) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  };

  // A fresh install that has agreed to sending content but has no key anywhere.
  const pointAtMock = () => worker.evaluate((m) => {
    Object.assign(globalThis.maana.openrouter, { auth: m + '/mock-or/auth', exchange: m + '/mock-or/keys', callback: m + '/mock-or/callback' });
  }, MOCK);
  const resetSettings = () => worker.evaluate(() => chrome.storage.local.set({ settings: { consent: true } }));
  const storedOR = () => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.providers?.openrouter || {});
  await resetSettings();
  await pointAtMock();
  await new Promise((r) => setTimeout(r, 600));
  for (const p of ctx.pages()) if (p.url().includes('options.html')) await p.close();

  // ---- approve ----
  let options = await ctx.newPage();
  watch(options, 'options');
  await options.goto(optionsUrl);
  await options.waitForSelector('.prov');
  check('quick connect box shown when nothing can translate', await options.isVisible('#quick'));
  const orCard = options.locator('.prov', { has: options.locator('.title', { hasText: 'OpenRouter' }) });
  check('OpenRouter card has its connect button', await orCard.locator('.connect').isVisible());
  await options.screenshot({ path: path.join(OUT, 'ui-connect-before.png'), fullPage: true });

  await admin('?mode=ok');
  await options.click('#quickConnect');
  const got = await wait(async () => (await storedOR()).apiKey === KEY);
  check('key from the exchange saved for OpenRouter', !!got, JSON.stringify(await storedOR()));
  check('OpenRouter switched on', (await storedOR()).enabled === true);
  const st = await admin();
  check('auth request used S256 and our label', st.auth?.code_challenge_method === 'S256' && st.auth?.key_label === 'Maana' && !!st.auth?.state);
  check('auth request sent the callback address', st.auth?.callback_url === `${MOCK}/mock-or/callback`);
  check('verifier matched the challenge (mock exchanged once)', st.exchanged === 1 && st.rejected === 0, JSON.stringify(st));
  await wait(async () => !ctx.pages().some((p) => p.url().startsWith(MOCK + '/mock-or/')));
  check('sign-in tab closed afterwards', !ctx.pages().some((p) => p.url().startsWith(MOCK + '/mock-or/')));
  const msgOk = await wait(async () => ((await options.textContent('#connectMsg')) || '').includes('انربط'));
  check('settings page says it is connected', !!msgOk, await options.textContent('#connectMsg'));
  check('quick box hidden once connected', !(await options.isVisible('#quick')));
  check('card button hidden once connected', !(await orCard.locator('.connect').isVisible()));
  check('card shows ready', ((await orCard.locator('.state').textContent()) || '').includes('جاهز'));
  await options.screenshot({ path: path.join(OUT, 'ui-connect-after.png'), fullPage: true });

  // ---- a replayed callback with no pending request does nothing ----
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.providers.openrouter.apiKey = '';
    await chrome.storage.local.set({ settings });
  });
  const stray = await ctx.newPage();
  await stray.goto(`${MOCK}/mock-or/callback?code=whatever&state=x`);
  await stray.waitForTimeout(800);
  check('stray callback ignored', (await storedOR()).apiKey === '' && (await admin()).rejected === 0);
  await stray.close();

  // ---- refused on the sign-in page ----
  await options.reload();
  await options.waitForSelector('.prov');
  await admin('?mode=deny');
  await options.click('#quickConnect');
  const msgDeny = await wait(async () => ((await options.textContent('#connectMsg')) || '').includes('ما تم الربط'));
  check('refusal reported', !!msgDeny, await options.textContent('#connectMsg'));
  check('no key after refusal', (await storedOR()).apiKey === '');

  // ---- an answer that does not carry our state ----
  await admin('?mode=badstate');
  const before = (await admin()).exchanged;
  await options.click('#quickConnect');
  const msgState = await wait(async () => ((await options.textContent('#connectMsg')) || '').includes('ما يطابق'));
  check('state mismatch reported', !!msgState, await options.textContent('#connectMsg'));
  check('state mismatch never reaches the exchange', (await admin()).exchanged === before && (await storedOR()).apiKey === '');

  // ---- settings page closed while signing in: the sign-in tab becomes the settings page ----
  await admin('?mode=hold');
  await options.click('#quickConnect');
  const signIn = await wait(async () => ctx.pages().find((p) => p.url().startsWith(MOCK + '/mock-or/auth')));
  check('sign-in page opened', !!signIn);
  await options.close();
  if (signIn) {
    await signIn.click('#go');
    const landed = await wait(async () => signIn.url().includes('options.html'));
    check('sign-in tab turned into the settings page', !!landed, signIn.url());
    check('key saved after the long way round', !!(await wait(async () => (await storedOR()).apiKey === KEY)));
    const msg = await wait(async () => ((await signIn.textContent('#connectMsg').catch(() => '')) || '').includes('انربط'));
    check('that page says it is connected', !!msg);
    watch(signIn, 'options2');
  }

  check('no console errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  failed++;
  console.log('ERROR ' + String((e && e.stack) || e).split('\n').slice(0, 6).join(' | '));
} finally {
  await ctx.close().catch(() => {});
  await server.stop().catch(() => {});
  fs.rmSync(userDir, { recursive: true, force: true });
  console.log(failed ? `${failed} check(s) failed` : 'all connect checks passed');
  process.exitCode = failed ? 1 : 0;
}
