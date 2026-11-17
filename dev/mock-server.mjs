// Mock LLM + fixture server for the Maana harness. No dependencies.
// Usage: node mock-server.mjs   |   import { start } from './mock-server.mjs'
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const AR_WORDS = ['كتاب', 'بيت', 'شمس', 'قمر', 'ماء', 'نهر', 'جبل', 'وردة', 'طريق', 'سماء', 'خبز', 'حلم', 'مدينة', 'صديق', 'ضوء', 'ريح', 'بحر', 'حديقة', 'قصة', 'نافذة', 'ساعة', 'لحن', 'سفر', 'غيمة'];

function hash(s) { let h = 7; for (const c of s.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

function pseudo(text) {
  return text.split(/(<\/?[gx]\d+\/?>)/).map(part => /^<\/?[gx]\d+\/?>$/.test(part) ? part
    : part.replace(/[A-Za-z]+(?:['’][A-Za-z]+)*/g, w => AR_WORDS[hash(w) % AR_WORDS.length])).join('');
}

function translateItem(text) {
  let out = pseudo(text);
  if (/REORDER/.test(text)) {
    const m = out.match(/<g(\d+)>.*?<\/g\1>/);
    if (m) out = m[0] + ' ' + out.replace(m[0], '').replace(/\s{2,}/g, ' ').trim();
  }
  if (/DROPTAG/.test(text)) out = out.replace(/<\/?[gx]\d+\/?>/g, '');
  return out;
}

function textReply(content) {
  const re = /\[\[(\d+)\]\][ \t]*\n?([^\n]*)/g;
  let m, items = [];
  while ((m = re.exec(content))) items.push({ n: m[1], text: m[2] });
  const lines = [];
  for (const it of items) {
    if (/SKIPME/.test(it.text)) continue;
    lines.push(`[[${it.n}]] ${translateItem(it.text)}`);
  }
  return { reply: lines.join('\n') + '\n', count: items.length };
}

function loadComic() { return JSON.parse(fs.readFileSync(path.join(FIX, 'comic.json'), 'utf8')); }

function visionReply(textPart) {
  const comic = loadComic();
  const size = /Image size:\s*(\d+)\s*x\s*(\d+)/i.exec(textPart);
  const slice = /Slice:\s*rows\s*(\d+)\s*-\s*(\d+)\s*of\s*(\d+)/i.exec(textPart);
  const W = size ? +size[1] : 0, H = size ? +size[2] : 0;
  const isStrip = !!slice || (W && H / W > 2.2);
  const spec = isStrip ? comic.strip : comic.page1;
  const y0 = slice ? +slice[1] : 0, y1 = slice ? +slice[2] : spec.h;
  const sh = y1 - y0;
  const out = [];
  for (const r of spec.regions) {
    const [x1, ya, x2, yb] = r.box;
    if (yb <= y0 || ya >= y1) continue;
    const cy1 = Math.max(ya, y0), cy2 = Math.min(yb, y1);
    const n = v => Math.max(0, Math.min(1000, Math.round(v)));
    out.push({ bbox_2d: [n(x1 / spec.w * 1000), n((cy1 - y0) / sh * 1000), n(x2 / spec.w * 1000), n((cy2 - y0) / sh * 1000)], type: r.type, text: r.ar });
  }
  return JSON.stringify(out);
}

export function start({ portA = 8787, portB = 8788, portC = 8789 } = {}) {
  const stats = { text: 0, vision: 0, failed: 0, items: [] };
  let failLeft = 0;
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };

  const json = (res, code, obj, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors, ...extra }); res.end(JSON.stringify(obj)); };
  const body = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });
  const sendFile = (res, dir, rel, extraHeaders = {}) => {
    const f = path.normalize(path.join(dir, rel));
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, extraHeaders); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...extraHeaders });
    fs.createReadStream(f).pipe(res);
  };

  async function chat(req, res) {
    let payload = {};
    try { payload = JSON.parse(await body(req)); } catch { }
    if (failLeft > 0) { failLeft--; stats.failed++; return json(res, 429, { error: { message: 'rate limited (mock)' } }, { 'Retry-After': '1' }); }
    const msgs = payload.messages || [];
    stats.lastSystem = String((msgs.find(m => m.role === 'system') || {}).content || '');
    const user = [...msgs].reverse().find(m => m.role === 'user') || { content: '' };
    let reply;
    if (Array.isArray(user.content) && user.content.some(p => p.type === 'image_url')) {
      stats.vision++;
      reply = visionReply(user.content.filter(p => p.type === 'text').map(p => p.text).join('\n'));
    } else {
      const content = Array.isArray(user.content) ? user.content.map(p => p.text || '').join('\n') : String(user.content);
      const r = textReply(content);
      stats.text++; stats.items.push(r.count);
      reply = r.reply;
    }
    if (payload.stream === false) {
      return json(res, 200, { choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...cors });
    let i = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (i >= reply.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const chunk = reply.slice(i, i + 12); i += 12;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: chunk } }] })}\n\n`);
      setTimeout(tick, 8);
    };
    tick();
  }

  const A = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (u.pathname === '/v1/models') return json(res, 200, { data: [{ id: 'mock-text' }, { id: 'mock-vision' }] });
    if (u.pathname === '/v1/chat/completions' && req.method === 'POST') return chat(req, res);
    if (u.pathname === '/admin/fail' && req.method === 'POST') { failLeft = +(u.searchParams.get('n') || 1); return json(res, 200, { failing: failLeft }); }
    if (u.pathname === '/admin/stats') return json(res, 200, { text: stats.text, vision: stats.vision, failed: stats.failed, itemCounts: stats.items, lastSystem: stats.lastSystem || '' });
    if (u.pathname === '/admin/reset' && req.method === 'POST') { stats.text = stats.vision = stats.failed = 0; stats.items = []; failLeft = 0; return json(res, 200, { ok: true }); }
    sendFile(res, FIX, decodeURIComponent(u.pathname === '/' ? '/page.html' : u.pathname).slice(1));
  });

  // Port B: images, deliberately without CORS headers.
  const B = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(u.pathname).slice(1);
    if (rel.startsWith('ref/')) {
      rel = rel.slice(4);
      const ref = req.headers.referer || '';
      if (!ref.startsWith('http://127.0.0.1:8787/')) { res.writeHead(403); return res.end('forbidden: bad referer'); }
    }
    if (!/\.png$/.test(rel)) { res.writeHead(404); return res.end('not found'); }
    sendFile(res, FIX, rel);
  });

  // Port C: always 429.
  const C = http.createServer((req, res) => {
    req.resume();
    json(res, 429, { error: { message: 'always rate limited (mock)' } }, { 'Retry-After': '1' });
  });

  const listen = (s, p) => new Promise((ok, bad) => { s.once('error', bad); s.listen(p, '127.0.0.1', ok); });
  return Promise.all([listen(A, portA), listen(B, portB), listen(C, portC)]).then(() => ({
    ports: { portA, portB, portC },
    stop: () => Promise.all([A, B, C].map(s => new Promise(r => { s.closeAllConnections?.(); s.close(r); }))),
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = +(process.env.PORT_A || 8787), b = +(process.env.PORT_B || 8788), c = +(process.env.PORT_C || 8789);
  await start({ portA: a, portB: b, portC: c });
  console.log(`mock server: A http://127.0.0.1:${a}  B http://127.0.0.1:${b}  C http://127.0.0.1:${c}`);
}
