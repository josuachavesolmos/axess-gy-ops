/**
 * Axess GY Dashboard — Auth Worker
 * Cloudflare Worker that validates user credentials and issues JWTs.
 *
 * Routes:
 *   POST /auth/login    { username, password } → { token, user, exp }
 *   GET  /auth/verify   (Authorization: Bearer <jwt>) → { valid, user, exp }
 *   POST /auth/logout   (Authorization: Bearer <jwt>) → { ok: true }
 *
 * Storage:
 *   KV namespace `USERS` keyed by lowercase username.
 *   Value JSON: { passwordHash, name, email, role, createdAt, lastLogin }
 *   passwordHash format: "<saltHex>.<hashHex>" using PBKDF2-SHA256, 100k iterations.
 *
 * Secrets (set via `wrangler secret put`):
 *   JWT_SECRET   — random 32+ byte string used to sign JWTs (HS256).
 *
 * Vars (set in wrangler.toml):
 *   ALLOWED_ORIGIN — exact origin allowed to hit this Worker (e.g. https://axess.olmoraia.com).
 */

const TOKEN_TTL_SECONDS = 86400;            // 24h default session
const TOKEN_TTL_REMEMBER = 30 * 86400;      // 30d if remember=true
const PBKDF2_ITERATIONS = 100000;

// ───────────────────── crypto helpers ─────────────────────

function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function b64urlEncode(input) {
  const str = typeof input === 'string' ? input : String.fromCharCode(...input);
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecodeToString(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return atob(padded);
}
function b64urlDecodeToBytes(s) {
  const str = b64urlDecodeToString(s);
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

async function pbkdf2(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key, 256
  );
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return bytesToHex(salt) + '.' + bytesToHex(hash);
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split('.');
  if (!saltHex || !hashHex) return false;
  const salt = hexToBytes(saltHex);
  const expected = hexToBytes(hashHex);
  const computed = await pbkdf2(password, salt);
  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed[i] ^ expected[i];
  return diff === 0;
}

async function signJWT(payload, secret) {
  const enc = new TextEncoder();
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = b64urlEncode(JSON.stringify(header));
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const data = headerB64 + '.' + payloadB64;
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return data + '.' + b64urlEncode(new Uint8Array(sig));
}

async function verifyJWT(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, sigB64] = parts;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const ok = await crypto.subtle.verify('HMAC', key, b64urlDecodeToBytes(sigB64), enc.encode(headerB64 + '.' + payloadB64));
  if (!ok) throw new Error('bad signature');
  const payload = JSON.parse(b64urlDecodeToString(payloadB64));
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('token expired');
  }
  return payload;
}

// ───────────────────── HTTP helpers ─────────────────────

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function isAllowedOrigin(origin, allowed) {
  if (!origin) return false;
  // Allow exact match OR github.io fallback if ALLOWED_ORIGIN includes a wildcard prefix
  if (origin === allowed) return true;
  if (allowed.includes(',')) {
    return allowed.split(',').map(s => s.trim()).includes(origin);
  }
  return false;
}

// ───────────────────── route handlers ─────────────────────

async function handleLogin(req, env, headers) {
  let body;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'invalid JSON body' }, 400, headers); }

  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const remember = !!body.remember;

  if (!username || !password) {
    return jsonResponse({ error: 'username and password are required' }, 400, headers);
  }

  const userData = await env.USERS.get(username, { type: 'json' });

  // Constant-ish time even on missing user: run a dummy hash so timing doesn't reveal existence
  if (!userData) {
    await pbkdf2(password, crypto.getRandomValues(new Uint8Array(16)));
    return jsonResponse({ error: 'invalid credentials' }, 401, headers);
  }

  const ok = await verifyPassword(password, userData.passwordHash);
  if (!ok) return jsonResponse({ error: 'invalid credentials' }, 401, headers);

  const now = Math.floor(Date.now() / 1000);
  const ttl = remember ? TOKEN_TTL_REMEMBER : TOKEN_TTL_SECONDS;
  const payload = {
    sub: username,
    name: userData.name || username,
    role: userData.role || 'viewer',
    iat: now,
    exp: now + ttl
  };
  const token = await signJWT(payload, env.JWT_SECRET);

  // Update lastLogin (best-effort)
  try {
    await env.USERS.put(username, JSON.stringify({
      ...userData,
      lastLogin: new Date().toISOString()
    }));
  } catch (e) { /* non-fatal */ }

  return jsonResponse({
    token,
    user: { username, name: payload.name, role: payload.role },
    exp: payload.exp
  }, 200, headers);
}

async function handleVerify(req, env, headers) {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) {
    return jsonResponse({ valid: false, error: 'missing bearer token' }, 401, headers);
  }
  const token = auth.slice(7).trim();
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET);
    return jsonResponse({
      valid: true,
      user: { username: payload.sub, name: payload.name, role: payload.role },
      exp: payload.exp
    }, 200, headers);
  } catch (e) {
    return jsonResponse({ valid: false, error: e.message }, 401, headers);
  }
}

async function handleLogout(req, env, headers) {
  // Stateless JWTs cannot truly be invalidated server-side without a blocklist.
  // We acknowledge the logout — client must drop the token locally.
  return jsonResponse({ ok: true }, 200, headers);
}

// ───────────────────── Worker entry ─────────────────────

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGIN || '');
    const corsOrigin = isAllowedOrigin(origin, allowed) ? origin : '';
    const headers = corsHeaders(corsOrigin);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      if (!corsOrigin) return new Response('forbidden', { status: 403 });
      return new Response(null, { status: 204, headers });
    }

    // Block non-allowed origins (except simple health checks)
    if (!corsOrigin && origin) {
      return jsonResponse({ error: 'origin not allowed' }, 403, {});
    }

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');

    try {
      if (path === '/auth/login' && req.method === 'POST') return handleLogin(req, env, headers);
      if (path === '/auth/verify' && req.method === 'GET') return handleVerify(req, env, headers);
      if (path === '/auth/logout' && req.method === 'POST') return handleLogout(req, env, headers);
      if (path === '/health' && req.method === 'GET') return jsonResponse({ status: 'ok' }, 200, headers);
      return jsonResponse({ error: 'not found', path }, 404, headers);
    } catch (e) {
      return jsonResponse({ error: 'internal error', detail: e.message }, 500, headers);
    }
  }
};

// Exported for the seed-users script (so the same hashing implementation is used in deploy tooling).
export { hashPassword };
