/**
 * AxessAuth — shared client-side helpers for the login + dashboard pages.
 *
 * Configures itself by reading <meta name="axess-auth-worker"> from the host page.
 * Exposes a global `AxessAuth` object.
 *
 * Pages:
 *   index.html      → uses AxessAuth.login() and AxessAuth.isAuthenticated()
 *   dashboard.html  → calls AxessAuth.requireAuth() at the very top of its <script>
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'axess.auth.token';
  const meta = document.querySelector('meta[name="axess-auth-worker"]');
  const rawUrl = (meta && meta.content) ? meta.content.replace(/\/+$/, '') : '';
  // Treat any URL containing "REPLACE" as "not yet configured" — useful for local dev
  const WORKER_URL = (rawUrl && !rawUrl.includes('REPLACE')) ? rawUrl : '';
  const AUTH_DISABLED = !WORKER_URL;

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; }
    catch (e) { return ''; }
  }
  function setToken(t) {
    try { localStorage.setItem(TOKEN_KEY, String(t)); }
    catch (e) { /* localStorage disabled */ }
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); }
    catch (e) { /* ignore */ }
  }

  function b64urlDecode(s) {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
    return atob(padded);
  }
  function decodePayload(token) {
    try {
      const parts = String(token).split('.');
      if (parts.length !== 3) return null;
      return JSON.parse(b64urlDecode(parts[1]));
    } catch (e) { return null; }
  }

  /** Is there a stored token whose `exp` is still in the future? (local check only) */
  function isAuthenticated() {
    const t = getToken();
    if (!t) return false;
    const p = decodePayload(t);
    if (!p || typeof p.exp !== 'number') return false;
    return p.exp > Math.floor(Date.now() / 1000);
  }

  function getCurrentUser() {
    const p = decodePayload(getToken());
    if (!p) return null;
    return {
      username: p.sub || '',
      name: p.name || p.sub || '',
      role: p.role || 'viewer',
      exp: p.exp || 0
    };
  }

  /** POST credentials to Worker. Returns { ok: boolean, error?: string, user?: {...} }. */
  async function login(username, password, remember) {
    if (!WORKER_URL) return { ok: false, error: 'Auth Worker URL not configured (meta[name=axess-auth-worker])' };
    let res;
    try {
      res = await fetch(WORKER_URL + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, remember: !!remember })
      });
    } catch (e) {
      return { ok: false, error: 'Network error · ' + (e.message || 'fetch failed') };
    }
    let body;
    try { body = await res.json(); }
    catch { body = {}; }
    if (!res.ok) return { ok: false, error: body.error || ('Login failed (HTTP ' + res.status + ')') };
    if (!body.token) return { ok: false, error: 'Server did not return a token' };
    setToken(body.token);
    return { ok: true, user: body.user };
  }

  /** Round-trip the token to the Worker. Returns { valid: boolean, user?: {...}, error?: string }. */
  async function verifyWithServer() {
    if (!WORKER_URL) return { valid: false, error: 'no worker url' };
    const t = getToken();
    if (!t) return { valid: false, error: 'no token' };
    let res;
    try {
      res = await fetch(WORKER_URL + '/auth/verify', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + t }
      });
    } catch (e) {
      return { valid: false, error: 'Network error · ' + e.message };
    }
    let body;
    try { body = await res.json(); } catch { body = {}; }
    if (!res.ok || !body.valid) {
      clearToken();
      return { valid: false, error: body.error || 'invalid' };
    }
    return { valid: true, user: body.user, exp: body.exp };
  }

  /** Best-effort server logout + always clear local. */
  async function logout() {
    const t = getToken();
    clearToken();
    if (!WORKER_URL || !t) return;
    try {
      await fetch(WORKER_URL + '/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + t }
      });
    } catch (e) { /* non-fatal */ }
  }

  /**
   * Use at top of dashboard.html script. Redirects to `loginUrl` (default index.html)
   * if no valid token. Calls /auth/verify after a fast local check, kicking the user
   * out if the server rejects the token.
   */
  async function requireAuth(opts) {
    opts = opts || {};
    const loginUrl = opts.loginUrl || 'index.html';
    // Dev mode: Worker URL not set → skip auth so the file works standalone.
    if (AUTH_DISABLED) {
      console.warn('[AxessAuth] Worker URL not configured — auth is disabled (dev mode).');
      return { username: 'dev', name: 'Dev preview', role: 'admin' };
    }
    if (!isAuthenticated()) {
      window.location.replace(loginUrl + '?next=' + encodeURIComponent(window.location.href));
      return null;
    }
    // Server-side verify
    const result = await verifyWithServer();
    if (!result.valid) {
      window.location.replace(loginUrl + '?reason=expired');
      return null;
    }
    return result.user;
  }

  // ─────────────────────── Data API (D1) ───────────────────────

  /** POST /data/import — send a dataset snapshot to the Worker. Fire-and-forget friendly. */
  async function pushDataset(dataset, filename, rows, meta) {
    if (AUTH_DISABLED) return { ok: false, skipped: true, reason: 'auth disabled (dev mode)' };
    const t = getToken();
    if (!t) return { ok: false, error: 'no auth token' };
    let res;
    try {
      res = await fetch(WORKER_URL + '/data/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
        body: JSON.stringify({ dataset, filename: filename || null, rows: rows || [], meta: meta || null })
      });
    } catch (e) {
      return { ok: false, error: 'Network error · ' + (e.message || 'fetch failed') };
    }
    let body; try { body = await res.json(); } catch { body = {}; }
    if (!res.ok) return { ok: false, error: body.error || ('HTTP ' + res.status) };
    return { ok: true, batch_id: body.batch_id, row_count: body.row_count };
  }

  /** GET /data/snapshot — returns { batch, rows[] } for a dataset, or { rows: [] } when no data. */
  async function fetchSnapshot(dataset) {
    if (AUTH_DISABLED) return { rows: [], skipped: true };
    const t = getToken();
    if (!t) return { rows: [], error: 'no auth token' };
    let res;
    try {
      res = await fetch(WORKER_URL + '/data/snapshot?dataset=' + encodeURIComponent(dataset), {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + t }
      });
    } catch (e) {
      return { rows: [], error: 'Network error · ' + e.message };
    }
    let body; try { body = await res.json(); } catch { body = {}; }
    if (!res.ok) return { rows: [], error: body.error || ('HTTP ' + res.status) };
    return { batch: body.batch || null, rows: body.rows || [] };
  }

  /** GET /data/history — list of import batches (optionally filtered by dataset). */
  async function fetchHistory(dataset) {
    if (AUTH_DISABLED) return { batches: [] };
    const t = getToken();
    if (!t) return { batches: [], error: 'no auth token' };
    const qs = dataset ? '?dataset=' + encodeURIComponent(dataset) : '';
    let res;
    try {
      res = await fetch(WORKER_URL + '/data/history' + qs, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + t }
      });
    } catch (e) {
      return { batches: [], error: 'Network error · ' + e.message };
    }
    let body; try { body = await res.json(); } catch { body = {}; }
    if (!res.ok) return { batches: [], error: body.error || ('HTTP ' + res.status) };
    return { batches: body.batches || [] };
  }

  window.AxessAuth = {
    WORKER_URL,
    login,
    logout,
    verifyWithServer,
    pushDataset,
    fetchSnapshot,
    fetchHistory,
    requireAuth,
    getToken,
    clearToken,
    isAuthenticated,
    getCurrentUser
  };
})();
