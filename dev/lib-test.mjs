// Tests for sse.js + providers.js against a local mock server. Run: node dev/lib-test.mjs
import http from 'node:http';
import { sseData, ndjsonLines } from '../extension/src/lib/sse.js';
import { streamChat, listModels, ProviderError } from '../extension/src/lib/providers.js';
import { OPENROUTER, randomToken, challengeFor, authUrl, isCallback } from '../extension/src/lib/connect.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS', name); pass++; }
  catch (e) { console.log('FAIL', name, '-', e && e.message); fail++; }
}
function eq(a, b, msg = '') {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg} expected ${y} got ${x}`);
}
function ok(c, msg) { if (!c) throw new Error(msg); }
async function collect(it) { const o = []; for await (const x of it) o.push(x); return o; }
async function rejects(fn) { try { await fn(); } catch (e) { return e; } throw new Error('expected rejection'); }

// Build a Response whose body arrives in the given chunks.
function chunked(chunks) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
  }));
}

// ---------- mock server ----------
let last = null; // last request seen: {url, method, headers, body}
const hits = {}; // per-model request counters

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  (async () => {
    for (const c of chunks) { res.write(c); await new Promise((r) => setTimeout(r, 5)); }
    res.end();
  })();
}
const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
const oc = (s) => ev({ choices: [{ delta: { content: s } }] });

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    last = { url: req.url, method: req.method, headers: req.headers, body };
    const model = body && body.model;
    hits[model] = (hits[model] || 0) + 1;
    const json = (code, o, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };

    // model lists
    if (req.url === '/oa/models') return json(200, { data: [{ id: 'models/gemini-b' }, { id: 'gpt-a' }] });
    if (req.url === '/an/v1/models?limit=1000') return json(200, { data: [{ id: 'claude-z' }, { id: 'claude-a' }] });
    if (req.url === '/ol/api/tags') return json(200, { models: [{ name: 'qwen:7b' }, { name: 'llama3' }] });

    // OpenAI-compatible
    if (req.url === '/oa/chat/completions') {
      switch (model) {
        case 'oa-ok':
          // reasoning fields and a mid-line split chunk
          return sse(res, [
            ev({ choices: [{ delta: { reasoning: 'think', reasoning_content: 'think2' } }] }),
            'data: {"choices":[{"delta":{"con', 'tent":"Hel"}}]}\r\n\r\n',
            oc('lo'), ': keepalive\n\n', 'data: [DONE]\n\n', oc('NEVER'),
          ]);
        case 'oa-429':
          return json(429, { error: { message: 'Slow down' } }, { 'Retry-After': '7' });
        case 'oa-429body':
          return json(429, { error: { message: 'Quota. Please retry in 12.5s.' } });
        case 'oa-401': return json(401, { error: { message: 'bad key' } });
        case 'oa-500': return json(503, { error: { message: 'down' } });
        case 'oa-418': return json(418, { error: { message: 'teapot' } });
        case 'oa-reason':
          if (body.reasoning_effort) return json(400, { error: { message: 'Unknown parameter: reasoning_effort' } });
          return sse(res, [oc('retried'), 'data: [DONE]\n\n']);
        case 'oa-mid':
          return sse(res, [oc('part'), ev({ error: { message: 'overloaded', code: 503 } })]);
        case 'oa-mid-nocode':
          return sse(res, [ev({ error: { message: 'weird' } })]);
      }
    }

    // Anthropic
    if (req.url === '/an/v1/messages') {
      const t = (type, extra) => ev({ type, ...extra });
      switch (model) {
        case 'claude-haiku-5':
        case 'claude-fable-5-x':
        case 'claude-opus-5-5':
          return sse(res, [
            t('message_start', { message: {} }),
            t('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
            t('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'secret' } }),
            t('content_block_start', { index: 1, content_block: { type: 'text' } }),
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"del', 'ta":{"type":"text_delta","text":"Hi"}}\n\n',
            t('content_block_delta', { index: 1, delta: { type: 'text_delta', text: " there" } }),
            t('message_delta', { delta: { stop_reason: 'end_turn' } }),
            t('message_stop', {}),
          ]);
        case 'claude-refuse':
          return sse(res, [
            t('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'no' } }),
            t('message_delta', { delta: { stop_reason: 'refusal' } }),
          ]);
        case 'claude-overload':
          return sse(res, [t('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })]);
        case 'claude-rate':
          return sse(res, [t('error', { error: { type: 'rate_limit_error', message: 'Slow' } })]);
        case 'claude-529': return json(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } });
      }
    }

    // Ollama
    if (req.url === '/ol/api/chat') {
      const line = (o) => JSON.stringify(o) + '\n';
      switch (model) {
        case 'ol-ok':
          return sse(res, [
            line({ message: { role: 'assistant', content: '', thinking: 'hmm' } }),
            line({ message: { content: 'Sa' } }).slice(0, 12), line({ message: { content: 'Sa' } }).slice(12),
            line({ message: { content: 'lam', thinking: 'x' } }),
            line({ done: true, message: { content: '' } }),
          ]);
        case 'ol-403': return json(403, {});
        case 'ol-err': return sse(res, [line({ error: 'model not found' })]);
      }
    }
    json(404, { error: { message: 'no route ' + req.url + ' ' + model } });
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const B = `http://127.0.0.1:${port}`;
const oa = (o = {}) => ({ id: 'oa', kind: 'openai', baseUrl: B + '/oa', apiKey: 'sk-x', model: 'oa-ok', ...o });
const an = (o = {}) => ({ id: 'an', kind: 'anthropic', baseUrl: B + '/an', apiKey: 'ak-x', model: 'claude-haiku-5', ...o });
const ol = (o = {}) => ({ id: 'ol', kind: 'ollama', baseUrl: B + '/ol', apiKey: '', model: 'ol-ok', ...o });
const R = { system: 'SYS', text: 'hello' };

// ---------- sse.js ----------
await test('sseData: CRLF, split chunks, comments, other fields, final line without newline', async () => {
  const r = chunked(['event: x\r\nda', 'ta: one\r\n\r\n: comm', 'ent\r\nid: 5\r\ndata:two\n', 'data: thr', 'ee']);
  eq(await collect(sseData(r)), ['one', 'two', 'three']);
});
await test('ndjsonLines: skips empty lines, final line without newline', async () => {
  const r = chunked(['{"a":1}\n\n{"b"', ':2}\r\n', '{"c":3}']);
  eq(await collect(ndjsonLines(r)), ['{"a":1}', '{"b":2}', '{"c":3}']);
});
await test('sseData: multibyte char split across chunks', async () => {
  const bytes = new TextEncoder().encode('data: مرحبا\n');
  const r = new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 9)); c.enqueue(bytes.slice(9)); c.close(); } }));
  eq(await collect(sseData(r)), ['مرحبا']);
});

// ---------- openai ----------
await test('openai: stream text, ignores reasoning, stops at [DONE], request shape (no image)', async () => {
  eq(await collect(streamChat(oa(), R)), ['Hel', 'lo']);
  eq(last.method, 'POST');
  eq(last.url, '/oa/chat/completions');
  eq(last.headers['content-type'], 'application/json');
  eq(last.headers.authorization, 'Bearer sk-x');
  eq(last.body, { model: 'oa-ok', stream: true, messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hello' }] });
  ok(!('temperature' in last.body) && !('max_tokens' in last.body), 'no temperature/max_tokens');
});
await test('openai: image content array, extraBody merged, no auth header without key, trailing slash stripped', async () => {
  await collect(streamChat(oa({ apiKey: '', baseUrl: B + '/oa/', extraBody: { foo: 1 } }), { ...R, image: { mime: 'image/png', b64: 'QUJD' } }));
  eq(last.headers.authorization, undefined);
  eq(last.body.foo, 1);
  eq(last.body.messages[1].content, [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }]);
});
await test('openai: reasoning_effort sent only with lowThinking', async () => {
  await collect(streamChat(oa({ reasoningEffort: 'low' }), R));
  ok(!('reasoning_effort' in last.body), 'absent without lowThinking');
  await collect(streamChat(oa({ reasoningEffort: 'low' }), { ...R, lowThinking: true }));
  eq(last.body.reasoning_effort, 'low');
  await collect(streamChat(oa(), { ...R, lowThinking: true }));
  ok(!('reasoning_effort' in last.body), 'absent without p.reasoningEffort');
});
await test('openai: 400 mentioning reasoning retries once without reasoning_effort', async () => {
  hits['oa-reason'] = 0;
  const out = await collect(streamChat(oa({ model: 'oa-reason', reasoningEffort: 'low' }), { ...R, lowThinking: true }));
  eq(out, ['retried']);
  eq(hits['oa-reason'], 2);
  ok(!('reasoning_effort' in last.body), 'second request had none');
});
await test('openai: 429 with Retry-After header', async () => {
  const e = await rejects(() => collect(streamChat(oa({ model: 'oa-429' }), R)));
  ok(e instanceof ProviderError, 'ProviderError');
  eq([e.kind, e.status, e.retryAfter, e.providerId], ['rate', 429, 7, 'oa']);
  ok(e.message.startsWith('HTTP 429') && e.message.includes('Slow down'), e.message);
});
await test('openai: 429 retry delay parsed from body text', async () => {
  const e = await rejects(() => collect(streamChat(oa({ model: 'oa-429body' }), R)));
  eq([e.kind, e.retryAfter], ['rate', 12.5]);
});
await test('openai: 401 auth, 503 server, 418 bad', async () => {
  eq((await rejects(() => collect(streamChat(oa({ model: 'oa-401' }), R)))).kind, 'auth');
  eq((await rejects(() => collect(streamChat(oa({ model: 'oa-500' }), R)))).kind, 'server');
  const e = await rejects(() => collect(streamChat(oa({ model: 'oa-418' }), R)));
  eq([e.kind, e.status], ['bad', 418]);
});
await test('openai: mid-stream error payload (numeric code -> server) after partial output', async () => {
  const got = [];
  const e = await rejects(async () => { for await (const d of streamChat(oa({ model: 'oa-mid' }), R)) got.push(d); });
  eq(got, ['part']);
  eq([e.kind, e.status], ['server', 503]);
});
await test('openai: mid-stream error without code -> server', async () => {
  const e = await rejects(() => collect(streamChat(oa({ model: 'oa-mid-nocode' }), R)));
  eq(e.kind, 'server');
});
await test('openai: fetch rejection is network, status 0', async () => {
  const e = await rejects(() => collect(streamChat(oa({ baseUrl: 'http://127.0.0.1:1' }), R)));
  eq([e.kind, e.status], ['network', 0]);
});
await test('openai: AbortError propagates unchanged', async () => {
  const ac = new AbortController(); ac.abort();
  const e = await rejects(() => collect(streamChat(oa(), { ...R, signal: ac.signal })));
  eq(e.name, 'AbortError');
  ok(!(e instanceof ProviderError), 'not wrapped');
});
await test('openai: listModels strips "models/" and sorts; auth header sent', async () => {
  eq(await listModels(oa()), ['gemini-b', 'gpt-a']);
  eq(last.method, 'GET');
  eq(last.headers.authorization, 'Bearer sk-x');
});

// ---------- anthropic ----------
await test('anthropic: stream ignores thinking, request shape without image, haiku has no fallback', async () => {
  eq(await collect(streamChat(an(), R)), ['Hi', ' there']);
  eq(last.url, '/an/v1/messages');
  eq(last.headers['x-api-key'], 'ak-x');
  eq(last.headers['anthropic-version'], '2026-10-21');
  eq(last.headers['anthropic-dangerous-direct-browser-access'], 'true');
  eq(last.headers['anthropic-beta'], undefined);
  eq(last.body, { model: 'claude-haiku-5', max_tokens: 16000, stream: true, system: 'SYS', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
  for (const k of ['thinking', 'temperature', 'top_p', 'top_k', 'output_config', 'fallbacks']) ok(!(k in last.body), 'no ' + k);
});
await test('anthropic: image block first, maxTokens, lowThinking -> output_config', async () => {
  await collect(streamChat(an(), { ...R, image: { mime: 'image/jpeg', b64: 'QQ==' }, maxTokens: 500, lowThinking: true }));
  eq(last.body.max_tokens, 500);
  eq(last.body.output_config, { effort: 'low' });
  eq(last.body.messages[0].content, [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QQ==' } }, { type: 'text', text: 'hello' }]);
});
await test('anthropic: opus-5-5 and fable-5 get fallback header + body field', async () => {
  for (const m of ['claude-opus-5-5', 'claude-fable-5-x']) {
    await collect(streamChat(an({ model: m }), R));
    eq(last.headers['anthropic-beta'], 'server-side-fallback-2026-07-01', m);
    eq(last.body.fallbacks, 'default', m);
  }
});
await test('anthropic: refusal stop_reason throws kind refusal after stream', async () => {
  const got = [];
  const e = await rejects(async () => { for await (const d of streamChat(an({ model: 'claude-refuse' }), R)) got.push(d); });
  eq(got, ['no']);
  eq(e.kind, 'refusal');
});
await test('anthropic: error payloads overloaded->server, rate_limit->rate', async () => {
  eq((await rejects(() => collect(streamChat(an({ model: 'claude-overload' }), R)))).kind, 'server');
  eq((await rejects(() => collect(streamChat(an({ model: 'claude-rate' }), R)))).kind, 'rate');
});
await test('anthropic: HTTP 529 is server', async () => {
  const e = await rejects(() => collect(streamChat(an({ model: 'claude-529' }), R)));
  eq([e.kind, e.status], ['server', 529]);
});
await test('anthropic: listModels', async () => {
  eq(await listModels(an()), ['claude-a', 'claude-z']);
  eq(last.method, 'GET');
  eq(last.headers['x-api-key'], 'ak-x');
  eq(last.headers['anthropic-version'], '2026-10-21');
  eq(last.headers['anthropic-dangerous-direct-browser-access'], 'true');
});

// ---------- ollama ----------
await test('ollama: NDJSON content only (thinking ignored), request shape', async () => {
  eq(await collect(streamChat(ol(), R)), ['Sa', 'lam']);
  eq(last.url, '/ol/api/chat');
  eq(last.body, { model: 'ol-ok', stream: true, messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hello' }], options: { num_ctx: 8192, temperature: 0.3 } });
});
await test('ollama: image, numCtx, lowThinking -> think:false', async () => {
  await collect(streamChat(ol({ numCtx: 4096 }), { ...R, image: { mime: 'image/png', b64: 'QUJD' }, lowThinking: true }));
  eq(last.body.messages[1], { role: 'user', content: 'hello', images: ['QUJD'] });
  eq(last.body.options.num_ctx, 4096);
  eq(last.body.think, false);
});
await test('ollama: HTTP 403 is origin', async () => {
  const e = await rejects(() => collect(streamChat(ol({ model: 'ol-403' }), R)));
  eq([e.kind, e.status], ['origin', 403]);
});
await test('ollama: error line throws', async () => {
  const e = await rejects(() => collect(streamChat(ol({ model: 'ol-err' }), R)));
  ok(e instanceof ProviderError && e.message.includes('model not found'), e.message);
});
await test('ollama: listModels', async () => {
  eq(await listModels(ol()), ['llama3', 'qwen:7b']);
});

// ---- connect.js (OpenRouter OAuth with PKCE) ----
await test('pkce: RFC 7636 example challenge', async () => {
  eq(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
await test('pkce: verifier is 43 url-safe characters and differs each time', async () => {
  const a = randomToken(32), b = randomToken(32);
  ok(/^[A-Za-z0-9_-]{43}$/.test(a), a);
  ok(a !== b, 'same token twice');
});
await test('connect: auth url carries every parameter', async () => {
  const u = new URL(authUrl(OPENROUTER, { challenge: 'CH', state: 'ST' }));
  eq([u.origin + u.pathname, u.searchParams.get('callback_url'), u.searchParams.get('code_challenge'),
    u.searchParams.get('code_challenge_method'), u.searchParams.get('key_label'), u.searchParams.get('state')],
  ['https://openrouter.ai/auth', OPENROUTER.callback, 'CH', 'S256', 'Maana', 'ST']);
});
await test('connect: callback match ignores query, rejects look-alikes', async () => {
  ok(isCallback(OPENROUTER.callback + '?code=1&state=2', OPENROUTER.callback), 'own callback');
  ok(!isCallback('https://yousf612-alwazzan.github.io/maana-translate/', OPENROUTER.callback), 'site home');
  ok(!isCallback('https://evil.example/maana-translate/connect.html?code=1', OPENROUTER.callback), 'other host');
  ok(!isCallback('not a url', OPENROUTER.callback), 'garbage');
});

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
