// Shared helpers for the Maana dev harness.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const DEV = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(DEV, '..');
export const FIX = path.join(DEV, 'fixtures');
export const OUT = path.join(DEV, 'out');
export const EXT = path.join(ROOT, 'extension');

/** Find the Chromium executable installed by Playwright (chromium-1243 preferred). */
export function chromiumExe() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  const dirs = fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse();
  const pref = dirs.includes('chromium-1243') ? ['chromium-1243', ...dirs.filter(d => d !== 'chromium-1243')] : dirs;
  for (const d of pref) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const exe = path.join(base, d, sub, 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new Error('No chromium-* with chrome.exe found under ' + base);
}
