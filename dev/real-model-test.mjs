// Real-model check with a local Ollama model: meaning-based text translation
// (idioms, inline tags, UI strings) and comic bubble detection against the
// fixture's ground truth.  Run: node real-model-test.mjs [text|image]
import fs from 'node:fs';
import path from 'node:path';
import { FIX } from './common.mjs';
import { streamChat, listModels } from '../extension/src/lib/providers.js';
import { textSystemPrompt, textUserMessage, imageSystemPrompt, imageUserMessage } from '../extension/src/lib/prompts.js';

const which = process.argv[2] || 'both';
const p = { id: 'ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '', model: process.env.MODEL || '', numCtx: 8192 };
const style = process.env.STYLE || 'fusha';
// Target language: TARGET=fr TARGET_NAME=French node real-model-test.mjs
const lang = { code: process.env.TARGET || 'ar', en: process.env.TARGET_NAME || 'Arabic' };

const models = await listModels(p);
console.log('models:', models.join(', '));
if (!p.model) p.model = models.find((m) => /qwen/i.test(m) && !/embed/i.test(m)) || models[0];
console.log('using:', p.model, '| target:', lang.en, '| style:', style);

async function run(req) {
  const t0 = Date.now();
  let first = 0;
  let out = '';
  for await (const d of streamChat(p, { ...req, lowThinking: true })) {
    if (!first) first = Date.now() - t0;
    out += d;
  }
  return { out, first, total: Date.now() - t0 };
}

if (which !== 'image') {
  const items = [
    { id: 1, text: "It's raining cats and dogs, so the picnic is off." },
    { id: 2, text: "Don't worry, the exam will be <g1>a piece of cake</g1> if you read <g2>chapter three</g2>." },
    { id: 3, text: 'He kicked the bucket last winter, and the farm has gone to the dogs ever since.' },
    { id: 4, text: 'Sign in' },
    { id: 5, text: 'Add to cart' },
    { id: 6, text: 'Run <x1/> to install the package, then restart <g2>VS Code</g2>.' },
    { id: 7, text: 'She spilled the beans about the surprise party, and now everyone is walking on eggshells around Tom.' },
    { id: 8, text: 'Break a leg tonight!' },
    { id: 9, text: 'The new phone costs an arm and a leg, but honestly it is worth every penny.' },
  ];
  const r = await run({
    system: textSystemPrompt({ lang, style, extra: '' }),
    text: textUserMessage(items, { title: 'Everyday English idioms', host: 'example.com' }),
  });
  console.log(`\n--- TEXT (first token ${r.first} ms, total ${r.total} ms) ---`);
  for (const it of items) console.log(`[[${it.id}]] ${it.text}`);
  console.log('\n' + r.out.trim());
}

if (which !== 'text') {
  const gt = JSON.parse(fs.readFileSync(path.join(FIX, 'comic.json'), 'utf8')).page1;
  const b64 = fs.readFileSync(path.join(FIX, 'page1.png')).toString('base64');
  const r = await run({
    system: imageSystemPrompt({ lang, style, extra: '', boxStyle: 'xyxy' }),
    text: imageUserMessage({ w: gt.w, h: gt.h, title: 'Bake sale day' }),
    image: { mime: 'image/png', b64 },
  });
  console.log(`\n--- IMAGE (first token ${r.first} ms, total ${r.total} ms) ---`);
  console.log(r.out.trim().slice(0, 3000));

  // Same normalisation as the service worker.
  const found = [];
  for (const m of r.out.matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]);
      const a = o.bbox_2d || o.box_2d || o.bbox || o.box;
      if (!Array.isArray(a) || a.length !== 4) continue;
      let [x1, y1, x2, y2] = o.box_2d ? [a[1], a[0], a[3], a[2]] : a;
      const max = Math.max(x1, y1, x2, y2);
      const sx = max > 1000 ? gt.w : max <= 1 ? 1 : 1000;
      const sy = max > 1000 ? gt.h : max <= 1 ? 1 : 1000;
      found.push({ box: [(x1 / sx) * gt.w, (y1 / sy) * gt.h, (x2 / sx) * gt.w, (y2 / sy) * gt.h], text: o.text, type: o.type });
    } catch { /* skip */ }
  }
  const iou = (a, b) => {
    const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (w <= 0 || h <= 0) return 0;
    const ar = (q) => (q[2] - q[0]) * (q[3] - q[1]);
    return (w * h) / (ar(a) + ar(b) - w * h);
  };
  console.log(`\nregions: model ${found.length}, ground truth ${gt.regions.length}`);
  for (const g of gt.regions) {
    let best = null;
    for (const f of found) if (!best || iou(f.box, g.box) > iou(best.box, g.box)) best = f;
    const v = best ? iou(best.box, g.box) : 0;
    console.log(`IoU ${v.toFixed(2)} | ${g.type.padEnd(7)} | ${g.text.slice(0, 44).padEnd(44)} | ${best && v > 0 ? `[${best.box.map((n) => Math.round(n)).join(',')}] ${best.type} ${best.text}` : '(missed)'}`);
    if (best && v > 0) console.log(`         truth box [${g.box.join(',')}]`);
  }
}
