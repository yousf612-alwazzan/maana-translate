// One-click OpenRouter connect (OAuth with PKCE, as documented by OpenRouter).
// The user signs in on openrouter.ai and approves; OpenRouter sends a one-time
// code to our callback page; the service worker trades the code (plus the secret
// verifier that never leaves the browser) for a key on the user's own account.
// Nothing here needs a key or a server of ours.

export const OPENROUTER = {
  auth: 'https://openrouter.ai/auth',
  exchange: 'https://openrouter.ai/api/v1/auth/keys',
  // A plain page on the project site. The extension reads the code from the tab's
  // address as soon as it opens; the page itself only says what is happening.
  callback: 'https://yousf612-alwazzan.github.io/maana-translate/connect.html',
};

// A pending connect is only honoured for this long (OpenRouter codes last 10 minutes).
export const CONNECT_TTL_MS = 15 * 60 * 1000;

export function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(n = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(n)));
}

export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function authUrl({ auth, callback }, { challenge, state }) {
  const u = new URL(auth);
  u.searchParams.set('callback_url', callback);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('key_label', 'Maana');
  u.searchParams.set('state', state);
  return u.toString();
}

// Is this tab address our callback page? Compared without query and hash.
export function isCallback(url, callback) {
  try {
    const a = new URL(url);
    const b = new URL(callback);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

export async function exchangeCode(exchange, code, verifier) {
  const res = await fetch(exchange, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !data || typeof data.key !== 'string' || !data.key) {
    const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data.key;
}
