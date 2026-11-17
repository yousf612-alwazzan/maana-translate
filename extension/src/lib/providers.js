// LLM provider adapters: streaming chat + model listing for openai-compatible, anthropic, ollama.
import { sseData, ndjsonLines } from './sse.js';

export class ProviderError extends Error {
  constructor(kind, message, { status = 0, retryAfter = null, providerId = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind; // rate|auth|server|network|bad|refusal|origin
    this.status = status;
    this.retryAfter = retryAfter;
    this.providerId = providerId;
  }
}

const ANTHROPIC_VERSION = '2026-10-21';
const FALLBACK_PREFIXES = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5'];

const base = (p) => String(p.baseUrl || '').replace(/\/+$/, '');

function kindFromStatus(status, p) {
  if (status === 429) return 'rate';
  if (status === 403 && p && p.kind === 'ollama') return 'origin';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'server'; // includes 529
  return 'bad';
}

// Seconds from the Retry-After header or from text like "retry in 12.5s" / "retryDelay":"12s".
function parseRetryAfter(res, bodyText) {
  const h = res && res.headers && res.headers.get('retry-after');
  if (h != null && h !== '') {
    const n = Number(h);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(h);
    if (!Number.isNaN(d)) return Math.max(0, (d - Date.now()) / 1000);
  }
  const m = /retry in\s+([\d.]+)\s*s/i.exec(bodyText || '') || /"retryDelay"\s*:\s*"([\d.]+)s"/i.exec(bodyText || '');
  if (m) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Pull a short message out of a provider error body.
function errorText(bodyText) {
  let msg = '';
  try {
    let j = JSON.parse(bodyText);
    if (Array.isArray(j)) j = j[0]; // Gemini sometimes wraps errors in an array
    const e = j && j.error;
    if (typeof e === 'string') msg = e;
    else if (e && typeof e.message === 'string') msg = e.message;
    else if (j && typeof j.message === 'string') msg = j.message;
  } catch { /* not JSON */ }
  if (!msg) msg = (bodyText || '').trim();
  return msg.replace(/\s+/g, ' ').slice(0, 300);
}

async function httpError(res, p, bodyText) {
  if (bodyText == null) {
    try { bodyText = await res.text(); } catch { bodyText = ''; }
  }
  const kind = kindFromStatus(res.status, p);
  const msg = errorText(bodyText);
  return new ProviderError(kind, `HTTP ${res.status}${msg ? ': ' + msg : ''}`, {
    status: res.status,
    retryAfter: kind === 'rate' ? parseRetryAfter(res, bodyText) : null,
    providerId: p.id,
  });
}

// fetch wrapper: aborts propagate, other rejections become 'network'.
async function doFetch(p, url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new ProviderError('network', `Network error: ${(e && e.message) || e}`, { providerId: p.id });
  }
}

// Wrap an async iterator so mid-stream read failures map to ProviderError.
async function* guardStream(p, it) {
  try {
    yield* it;
  } catch (e) {
    if (e instanceof ProviderError || (e && e.name === 'AbortError')) throw e;
    throw new ProviderError('network', `Stream error: ${(e && e.message) || e}`, { providerId: p.id });
  }
}

function parseJson(p, s) {
  try { return JSON.parse(s); } catch {
    throw new ProviderError('bad', 'Malformed JSON in stream', { providerId: p.id });
  }
}

// ---------- openai ----------

function openaiHeaders(p) {
  const h = { 'Content-Type': 'application/json' };
  if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`;
  return h;
}

function openaiBody(p, req, withReasoning) {
  const content = req.image
    ? [
        { type: 'text', text: req.text },
        { type: 'image_url', image_url: { url: `data:${req.image.mime};base64,${req.image.b64}` } },
      ]
    : req.text;
  const body = {
    model: p.model,
    stream: true,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content },
    ],
    ...(p.extraBody || {}),
  };
  if (withReasoning && req.lowThinking && p.reasoningEffort) body.reasoning_effort = p.reasoningEffort;
  return body;
}

function payloadError(p, err, fallbackKind = 'server') {
  const msg = (err && (err.message || (typeof err === 'string' ? err : ''))) || 'Provider error';
  let status = 0;
  const num = [err && err.code, err && err.status].find((x) => typeof x === 'number');
  if (typeof num === 'number') status = num;
  const kind = status ? kindFromStatus(status, p) : fallbackKind;
  return new ProviderError(kind, String(msg).slice(0, 300), { status, providerId: p.id });
}

async function* streamOpenAI(p, req) {
  const url = `${base(p)}/chat/completions`;
  let withReasoning = true;
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await doFetch(p, url, {
      method: 'POST',
      headers: openaiHeaders(p),
      body: JSON.stringify(openaiBody(p, req, withReasoning)),
      signal: req.signal,
    });
    if (res.ok) break;
    const text = await res.text().catch(() => '');
    const sentReasoning = withReasoning && req.lowThinking && p.reasoningEffort;
    if (res.status === 400 && sentReasoning && attempt === 0 && /reasoning/i.test(text)) {
      withReasoning = false; // server doesn't accept reasoning_effort; retry once without
      continue;
    }
    throw await httpError(res, p, text);
  }
  for await (const data of guardStream(p, sseData(res))) {
    if (data === '[DONE]') return;
    if (!data) continue;
    const j = parseJson(p, data);
    if (j && j.error) throw payloadError(p, j.error);
    const delta = j && j.choices && j.choices[0] && j.choices[0].delta;
    const c = delta && delta.content; // reasoning / reasoning_content are ignored
    if (typeof c === 'string' && c) yield c;
  }
}

// ---------- anthropic ----------

function anthropicHeaders(p, withBeta) {
  const h = {
    'Content-Type': 'application/json',
    'x-api-key': p.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (withBeta) h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  return h;
}

function anthropicErrorKind(type) {
  switch (type) {
    case 'overloaded_error': return 'server';
    case 'rate_limit_error': return 'rate';
    case 'authentication_error':
    case 'permission_error': return 'auth';
    case 'invalid_request_error':
    case 'not_found_error':
    case 'request_too_large': return 'bad';
    default: return 'server';
  }
}

async function* streamAnthropic(p, req) {
  const model = String(p.model || '');
  const fb = FALLBACK_PREFIXES.some((x) => model.startsWith(x));
  const content = [];
  if (req.image) content.push({ type: 'image', source: { type: 'base64', media_type: req.image.mime, data: req.image.b64 } });
  content.push({ type: 'text', text: req.text });
  const body = {
    model,
    max_tokens: req.maxTokens || 16000,
    stream: true,
    system: req.system,
    messages: [{ role: 'user', content }],
  };
  if (req.lowThinking) body.output_config = { effort: 'low' };
  if (fb) body.fallbacks = 'default';

  const res = await doFetch(p, `${base(p)}/v1/messages`, {
    method: 'POST',
    headers: anthropicHeaders(p, fb),
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok) throw await httpError(res, p);

  let stopReason = null;
  for await (const data of guardStream(p, sseData(res))) {
    if (!data || data === '[DONE]') continue;
    const j = parseJson(p, data);
    if (!j) continue;
    if (j.type === 'content_block_delta') {
      const d = j.delta;
      if (d && d.type === 'text_delta' && typeof d.text === 'string' && d.text) yield d.text;
    } else if (j.type === 'message_delta') {
      if (j.delta && j.delta.stop_reason) stopReason = j.delta.stop_reason;
    } else if (j.type === 'error') {
      const e = j.error || {};
      throw new ProviderError(anthropicErrorKind(e.type), String(e.message || e.type || 'Provider error').slice(0, 300), { providerId: p.id });
    }
  }
  if (stopReason === 'refusal') {
    throw new ProviderError('refusal', 'The model refused to answer', { providerId: p.id });
  }
}

// ---------- ollama ----------

async function* streamOllama(p, req) {
  const body = {
    model: p.model,
    stream: true,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.text, ...(req.image ? { images: [req.image.b64] } : {}) },
    ],
    options: { num_ctx: p.numCtx || 8192, temperature: 0.3 },
    ...(req.lowThinking ? { think: false } : {}),
  };
  const res = await doFetch(p, `${base(p)}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok) throw await httpError(res, p);
  for await (const line of guardStream(p, ndjsonLines(res))) {
    const obj = parseJson(p, line);
    if (obj && typeof obj.error === 'string') {
      throw new ProviderError('server', obj.error.slice(0, 300), { providerId: p.id });
    }
    const c = obj && obj.message && obj.message.content; // message.thinking is ignored
    if (typeof c === 'string' && c) yield c;
  }
}

// ---------- public API ----------

export async function* streamChat(p, req) {
  if (p.kind === 'openai') yield* streamOpenAI(p, req);
  else if (p.kind === 'anthropic') yield* streamAnthropic(p, req);
  else if (p.kind === 'ollama') yield* streamOllama(p, req);
  else throw new ProviderError('bad', `Unknown provider kind: ${p.kind}`, { providerId: p.id });
}

export async function listModels(p, signal) {
  let url;
  let headers;
  if (p.kind === 'openai') {
    url = `${base(p)}/models`;
    headers = p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
  } else if (p.kind === 'anthropic') {
    url = `${base(p)}/v1/models?limit=1000`;
    headers = anthropicHeaders(p, false);
    delete headers['Content-Type'];
  } else if (p.kind === 'ollama') {
    url = `${base(p)}/api/tags`;
    headers = {};
  } else {
    throw new ProviderError('bad', `Unknown provider kind: ${p.kind}`, { providerId: p.id });
  }
  const res = await doFetch(p, url, { method: 'GET', headers, signal });
  if (!res.ok) throw await httpError(res, p);
  let j;
  try { j = await res.json(); } catch {
    throw new ProviderError('bad', 'Malformed model list response', { providerId: p.id });
  }
  let ids;
  if (p.kind === 'ollama') ids = (j.models || []).map((m) => m && m.name);
  else if (p.kind === 'openai') ids = (j.data || []).map((m) => m && typeof m.id === 'string' ? m.id.replace(/^models\//, '') : null);
  else ids = (j.data || []).map((m) => m && m.id);
  return ids.filter((x) => typeof x === 'string' && x).sort();
}
