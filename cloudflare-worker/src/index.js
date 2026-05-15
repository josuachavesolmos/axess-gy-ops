/**
 * Axess GY Dashboard — Auth + Data Worker
 *
 * Routes:
 *   POST  /auth/login         { username, password } → { token, user, exp }
 *   GET   /auth/verify        (Authorization: Bearer <jwt>) → { valid, user, exp }
 *   POST  /auth/logout
 *
 *   POST  /data/import        { dataset, filename, rows[] } (JWT) → { batch_id, row_count }
 *   GET   /data/snapshot      ?dataset=<x> (JWT) → { dataset, batch, rows[] }
 *   GET   /data/history       ?dataset=<x> (JWT) → { dataset, batches[] }
 *   DELETE /data/batch/:id    (JWT, admin) → { ok: true }
 *
 *   GET   /health
 *
 * Storage:
 *   KV `USERS`        → user credentials (PBKDF2 hashed)
 *   D1 `DB`           → dataset rows + import_batches
 *
 * Secrets:
 *   JWT_SECRET        → HS256 signing key
 *
 * Vars:
 *   ALLOWED_ORIGIN    → comma-separated CORS origins
 */

const TOKEN_TTL_SECONDS  = 86400;
const TOKEN_TTL_REMEMBER = 30 * 86400;
const PBKDF2_ITERATIONS  = 100000;
const D1_MAX_BOUND_PARAMS = 95;       // D1 caps bind() at ~100 params per stmt
const D1_MAX_STMTS_PER_BATCH = 50;    // D1 caps batch() at 100 stmts; stay safe

// ─────────────────────── crypto helpers ───────────────────────

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
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
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
  const headerB64 = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const data = headerB64 + '.' + payloadB64;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return data + '.' + b64urlEncode(new Uint8Array(sig));
}
async function verifyJWT(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, sigB64] = parts;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, b64urlDecodeToBytes(sigB64), enc.encode(headerB64 + '.' + payloadB64));
  if (!ok) throw new Error('bad signature');
  const payload = JSON.parse(b64urlDecodeToString(payloadB64));
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('token expired');
  return payload;
}

// ─────────────────────── HTTP helpers ───────────────────────

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function isAllowedOrigin(origin, allowed) {
  if (!origin) return false;
  if (origin === allowed) return true;
  if (allowed.includes(',')) return allowed.split(',').map(s => s.trim()).includes(origin);
  return false;
}

/** Reads Authorization: Bearer <jwt>, verifies it, returns user payload or throws. */
async function requireJWT(req, env) {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new HttpError(401, 'missing bearer token');
  try {
    return await verifyJWT(auth.slice(7).trim(), env.JWT_SECRET);
  } catch (e) {
    throw new HttpError(401, 'invalid token · ' + e.message);
  }
}
class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// ─────────────────────── auth routes ───────────────────────

async function handleLogin(req, env, headers) {
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, headers); }

  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const remember = !!body.remember;
  if (!username || !password) return jsonResponse({ error: 'username and password are required' }, 400, headers);

  const userData = await env.USERS.get(username, { type: 'json' });
  if (!userData) {
    await pbkdf2(password, crypto.getRandomValues(new Uint8Array(16)));
    return jsonResponse({ error: 'invalid credentials' }, 401, headers);
  }
  const ok = await verifyPassword(password, userData.passwordHash);
  if (!ok) return jsonResponse({ error: 'invalid credentials' }, 401, headers);

  const now = Math.floor(Date.now() / 1000);
  const ttl = remember ? TOKEN_TTL_REMEMBER : TOKEN_TTL_SECONDS;
  const payload = { sub: username, name: userData.name || username, role: userData.role || 'viewer', iat: now, exp: now + ttl };
  const token = await signJWT(payload, env.JWT_SECRET);
  try { await env.USERS.put(username, JSON.stringify({ ...userData, lastLogin: new Date().toISOString() })); } catch (e) {}

  return jsonResponse({ token, user: { username, name: payload.name, role: payload.role }, exp: payload.exp }, 200, headers);
}
async function handleVerify(req, env, headers) {
  try {
    const payload = await requireJWT(req, env);
    return jsonResponse({ valid: true, user: { username: payload.sub, name: payload.name, role: payload.role }, exp: payload.exp }, 200, headers);
  } catch (e) {
    return jsonResponse({ valid: false, error: e.message }, e.status || 401, headers);
  }
}
async function handleLogout(req, env, headers) {
  return jsonResponse({ ok: true }, 200, headers);
}

// ─────────────────────── dataset mappers ───────────────────────
//
// Each mapper declares the column mapping between the dashboard's
// row shape (Excel-derived keys) and the D1 table columns. The same
// list is used for INSERT (toDB) and SELECT (toClient).

function normalizeText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function normalizeNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}
function normalizeInt(v) {
  const n = normalizeNum(v);
  return n == null ? null : Math.round(n);
}
function normalizeDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && v > 25000 && v < 60000) {
    return new Date((v - 25569) * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
  return s;
}
function normalizeDateTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && v > 25000 && v < 60000) {
    return new Date((v - 25569) * 86400000).toISOString();
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    try { return new Date(s).toISOString(); } catch { return s; }
  }
  return s;
}

const DATASET_MAPPERS = {
  master: {
    table: 'master_projects',
    view:  'v_master_current',
    fields: [
      ['workorder',        'Work Order Number',              normalizeText],
      ['client',           'Client',                         normalizeText],
      ['scope',            'Scope',                          normalizeText],
      ['installation',     'Installation',                   normalizeText],
      ['po_number',        'PO number',                      normalizeText],
      ['po_value',         'PO Value',                       normalizeNum],
      ['project_manager',  'Responsible/ Project Manager',   normalizeText],
      ['contract_manager', 'Contract Manager',               normalizeText],
      ['client_pm',        'Client PM',                      normalizeText],
      ['status',           'Status',                         normalizeText],
      ['period',           'PERIOD',                         normalizeText],
      ['start_date',       'Start date',                     normalizeDate],
      ['end_date',         'End date',                       normalizeDate],
      ['revenue_to_date',  'Invoice Value',                  normalizeNum],
      ['cost_to_date',     'Cost to date',                   normalizeNum],
      ['cmr_to_date',      'CMR',                            normalizeNum],
      ['qa_000',           '000',                            normalizeText],
      ['qa_100',           '100',                            normalizeText],
      ['qa_200',           '200',                            normalizeText],
      ['qa_300',           '300',                            normalizeText],
      ['qa_400',           '400',                            normalizeText],
      ['qa_500',           '500',                            normalizeText],
      ['qa_600',           '600',                            normalizeText],
      ['qa_700',           '700',                            normalizeText],
      ['qa_800',           '800',                            normalizeText],
      ['qa_900',           '900',                            normalizeText],
      ['comment',          'Comment',                        normalizeText],
      ['invoicing_status', 'Invoice Status',                 normalizeText]
    ]
  },

  personnel: {
    table: 'personnel_assignments',
    view:  'v_personnel_current',
    fields: [
      ['technician_name',         'Technician Name',         normalizeText],
      ['competency',              'Competency',              normalizeText],
      ['start_date',              'Start Date',              normalizeDate],
      ['duration_days',           'Duration (days)',         normalizeInt],
      ['end_date',                'End Date',                normalizeDate],
      ['installation',            'Installation',            normalizeText],
      ['client',                  'Client',                  normalizeText],
      ['status',                  'Status',                  normalizeText],
      ['work_order',              'Work Order',              normalizeText],
      ['support_classification',  'Support Classification',  normalizeText],
      ['scope',                   'Scope',                   normalizeText]
    ]
  },

  equipment: {
    table: 'equipment_assignments',
    view:  'v_equipment_current',
    fields: [
      ['description',           'Equipment Name',         normalizeText],
      ['start_date',            'Start Date',             normalizeDate],
      ['end_date',              'End Date',               normalizeDate],
      ['installation',          'Installation',           normalizeText],
      ['client',                'Client',                 normalizeText],
      ['status',                'Status',                 normalizeText],
      ['work_order',            'Work Order',             normalizeText],
      ['scope',                 'Scope',                  normalizeText],
      ['calibration_due_date',  'Calibration End Date',   normalizeDate]
      // equipment_status omitted on purpose — `status` is already the resolved
      // value (Equipment planner Status || Lists.equipment_status).
    ]
  },

  quote: {
    table: 'quotes',
    view:  'v_quotes_current',
    fields: [
      ['external_id',              'ID',                          normalizeText],
      ['title',                    'Title',                       normalizeText],
      ['entity',                   'Entity',                      normalizeText],
      ['job_title',                'Job Title',                   normalizeText],
      ['installation',             'Installation',                normalizeText],
      ['customer',                 'Customer',                    normalizeText],
      ['status',                   'Status',                      normalizeText],
      ['responsible',              'Responsible',                 normalizeText],
      ['segment',                  'Segment',                     normalizeText],
      ['created_by',               'Created By',                  normalizeText],
      ['quote_date',               'Quote Date',                  normalizeDate],
      ['validity_days',            'Validity',                    normalizeInt],
      ['validity_date',            'Validity Date',               normalizeDate],
      ['sent_date',                'Sent Date',                   normalizeDate],
      ['estimated_start_date',     'Estimated Start Date',        normalizeDate],
      ['estimated_duration',       'Estimated Project Duration',  normalizeText],
      ['accepted_rejected_date',   'Accepted/Rejected Date',      normalizeDate],
      ['probability',              'Probability',                 normalizeInt],
      ['out_ref',                  'Out Ref',                     normalizeText],
      ['quote_revision',           'Quote Revision',              normalizeText],
      ['client_ref',               'Client Ref',                  normalizeText],
      ['client_request_id',        'Client Request ID',           normalizeText],
      ['currency',                 'Currency',                    normalizeText],
      ['exchange_rate',            'Exchange Rate',               normalizeNum],
      ['price_list',               'Price List',                  normalizeText],
      ['axess_product',            'Axess Product',               normalizeText],
      ['incoterms',                'Incoterms',                   normalizeText],
      ['delivery_conditions',      'Delivery Conditions',         normalizeText],
      ['sum_total',                'Sum Total',                   normalizeNum],
      ['sum_total_base_currency',  'Sum Total Base Currency',     normalizeNum],
      ['weighted_probability_sum', 'Weighted Probability Sum',    normalizeNum],
      ['cost_sum_total',           'Cost Sum Total',              normalizeNum],
      ['cm_total',                 'CM Total',                    normalizeNum],
      ['cmr_total',                'CMR Total',                   normalizeNum],
      ['approver',                 'Approver',                    normalizeText],
      ['approval_due_date',        'Approval Due Date',           normalizeDate],
      ['workspace_url',            'Workspace Url',               normalizeText],
      ['created_excel',            'Created',                     normalizeDateTime],
      ['modified_excel',           'Modified',                    normalizeDateTime],
      ['modified_by',              'Modified By',                 normalizeText]
    ]
  },

  leads: {
    table: 'leads',
    view:  'v_leads_current',
    fields: [
      ['created',           'Created',          normalizeDateTime],
      ['title',             'Title',            normalizeText],
      ['responsible',       'Responsible',      normalizeText],
      ['entity',            'Entity',           normalizeText],
      ['status',            'Status',           normalizeText],
      ['due_date',          'DueDate',          normalizeDate],
      ['installation',      'Installation',     normalizeText],
      ['customer',          'Customer',         normalizeText],
      ['head_customer',     'Head Customer',    normalizeText],
      ['segment',           'Segment',          normalizeText],
      ['service',           'Service',          normalizeText],
      ['customer_id',       'CustomerId',       normalizeText],
      ['head_customer_id',  'HeadCustomerId',   normalizeText],
      ['installation_id',   'InstallationId',   normalizeText],
      ['entity_id',         'EntityID',         normalizeText],
      ['created_by',        'Created By',       normalizeText],
      ['modified_by',       'Modified By',      normalizeText],
      ['item_type',         'Item Type',        normalizeText],
      ['path',              'Path',             normalizeText]
    ]
  }
};

function toDB(row, fields) {
  const out = {};
  for (const [dbCol, clientKey, normalizer] of fields) {
    out[dbCol] = normalizer(row[clientKey]);
  }
  return out;
}
function toClient(dbRow, fields) {
  const out = {};
  for (const [dbCol, clientKey] of fields) {
    out[clientKey] = dbRow[dbCol];
  }
  return out;
}

/** Multi-row INSERT respecting D1's bind() param cap (~100). Statements are
 *  grouped via db.batch() to amortize network round-trips.
 */
async function bulkInsert(db, tableName, columns, rows) {
  if (!rows.length) return 0;
  const colCount = columns.length;
  // Floor(95 / colCount) rows per multi-row INSERT keeps us under D1's bind cap.
  const rowsPerStmt = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / colCount));
  const colList = columns.join(', ');
  const placeholderRow = '(' + columns.map(() => '?').join(', ') + ')';

  const stmts = [];
  for (let i = 0; i < rows.length; i += rowsPerStmt) {
    const chunk = rows.slice(i, i + rowsPerStmt);
    const sql = `INSERT INTO ${tableName} (${colList}) VALUES ${chunk.map(() => placeholderRow).join(', ')}`;
    const params = [];
    for (const r of chunk) {
      for (const c of columns) params.push(r[c] === undefined ? null : r[c]);
    }
    stmts.push(db.prepare(sql).bind(...params));
  }

  for (let i = 0; i < stmts.length; i += D1_MAX_STMTS_PER_BATCH) {
    await db.batch(stmts.slice(i, i + D1_MAX_STMTS_PER_BATCH));
  }
  return rows.length;
}

// ─────────────────────── data routes ───────────────────────

async function handleDataImport(req, env, headers) {
  const user = await requireJWT(req, env);
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, headers); }

  const dataset = String(body.dataset || '').toLowerCase();
  const mapper = DATASET_MAPPERS[dataset];
  if (!mapper) return jsonResponse({ error: 'unknown dataset: ' + dataset, supported: Object.keys(DATASET_MAPPERS) }, 400, headers);

  const rows = Array.isArray(body.rows) ? body.rows : [];
  const filename = body.filename ? String(body.filename).slice(0, 255) : null;
  const meta = body.meta ? JSON.stringify(body.meta).slice(0, 8192) : null;

  // 1. Insert the batch row
  const batchInsert = await env.DB.prepare(
    'INSERT INTO import_batches (dataset, filename, row_count, imported_by, meta_json) VALUES (?, ?, ?, ?, ?)'
  ).bind(dataset, filename, rows.length, user.sub, meta).run();
  const batchId = batchInsert.meta && batchInsert.meta.last_row_id;
  if (!batchId) throw new HttpError(500, 'failed to create batch');

  // 2. Bulk insert the rows with batch_id set
  const dbRows = rows.map(r => {
    const m = toDB(r, mapper.fields);
    m.import_batch_id = batchId;
    return m;
  });
  const columns = mapper.fields.map(f => f[0]).concat(['import_batch_id']);
  const inserted = await bulkInsert(env.DB, mapper.table, columns, dbRows);

  return jsonResponse({ ok: true, batch_id: batchId, row_count: inserted, dataset }, 200, headers);
}

async function handleDataSnapshot(req, env, headers, url) {
  await requireJWT(req, env);
  const dataset = String(url.searchParams.get('dataset') || '').toLowerCase();
  const mapper = DATASET_MAPPERS[dataset];
  if (!mapper) return jsonResponse({ error: 'unknown dataset: ' + dataset }, 400, headers);

  const { results: batchRow } = await env.DB.prepare(
    'SELECT id, filename, row_count, imported_by, imported_at FROM import_batches WHERE dataset = ? ORDER BY imported_at DESC LIMIT 1'
  ).bind(dataset).all();
  if (!batchRow || batchRow.length === 0) {
    return jsonResponse({ dataset, batch: null, rows: [] }, 200, headers);
  }

  const { results } = await env.DB.prepare(`SELECT * FROM ${mapper.view}`).all();
  const rows = (results || []).map(r => toClient(r, mapper.fields));

  return jsonResponse({ dataset, batch: batchRow[0], rows }, 200, headers);
}

async function handleDataHistory(req, env, headers, url) {
  await requireJWT(req, env);
  const dataset = url.searchParams.get('dataset');
  let query = 'SELECT id, dataset, filename, row_count, imported_by, imported_at FROM import_batches';
  let bindings = [];
  if (dataset) {
    query += ' WHERE dataset = ?';
    bindings.push(dataset);
  }
  query += ' ORDER BY imported_at DESC LIMIT 50';
  const { results } = await env.DB.prepare(query).bind(...bindings).all();
  return jsonResponse({ batches: results || [] }, 200, headers);
}

async function handleDataBatchDelete(req, env, headers, batchId) {
  const user = await requireJWT(req, env);
  if (user.role !== 'admin') throw new HttpError(403, 'admin role required');
  const id = parseInt(batchId, 10);
  if (!id) throw new HttpError(400, 'invalid batch id');
  const res = await env.DB.prepare('DELETE FROM import_batches WHERE id = ?').bind(id).run();
  return jsonResponse({ ok: true, deleted: res.meta?.changes || 0, batch_id: id }, 200, headers);
}

// ─────────────────────── AI assistant ───────────────────────

const ANTHROPIC_MODEL  = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API    = 'https://api.anthropic.com/v1/messages';
const RATE_LIMIT_DAILY = 50;            // max AI calls per user per day
const RATE_LIMIT_TTL_SECONDS = 36 * 3600;

const SYSTEM_ASK = `You are the data assistant for the Axess Group Guyana operations dashboard.
Answer the user's question using ONLY the JSON CONTEXT provided.

Rules:
1. Be concise — 1 to 3 sentences max.
2. Use only the figures present in CONTEXT. Never invent numbers.
3. If the question falls outside operations or cannot be answered from CONTEXT,
   say so briefly and suggest what data would be needed.
4. Match the user's language (Spanish or English).
5. When mentioning a work order, client, technician, or quote, quote the value verbatim.
6. If the user asks for "what should I focus on" / "action items", point to specific
   records (with their identifiers) and one short reason each.

Today is {TODAY}.`;

const SYSTEM_INSIGHTS = `You generate "Today's Highlights" for the Axess GY operations dashboard.
Read the JSON CONTEXT and produce 3 to 5 actionable highlights.

Output: a JSON array of objects with shape:
  { "severity": "high"|"medium"|"low", "icon": "<single emoji>", "title": "<<=8 words>", "detail": "<<=25 words>" }

Priorities (highest first):
- Calibrations expired or expiring within 30 days.
- WOs with at least one QA step in "Not completed".
- WOs in Ongoing status with end_date already past.
- Stale quotes still "Sent" past validity_date.
- Clients with the largest PO value but lowest invoiced ratio.

Return ONLY the JSON array. No prose, no markdown fences, no explanation.
Default language: Spanish.`;

async function buildAssistantContext(env) {
  const NOT_DONE_FRAGMENT = `
    (qa_000 = 'Completed' OR qa_000 = 'Not applicable' OR qa_000 IS NULL OR qa_000 = '') AND
    (qa_100 = 'Completed' OR qa_100 = 'Not applicable' OR qa_100 IS NULL OR qa_100 = '') AND
    (qa_200 = 'Completed' OR qa_200 = 'Not applicable' OR qa_200 IS NULL OR qa_200 = '') AND
    (qa_300 = 'Completed' OR qa_300 = 'Not applicable' OR qa_300 IS NULL OR qa_300 = '') AND
    (qa_400 = 'Completed' OR qa_400 = 'Not applicable' OR qa_400 IS NULL OR qa_400 = '') AND
    (qa_500 = 'Completed' OR qa_500 = 'Not applicable' OR qa_500 IS NULL OR qa_500 = '') AND
    (qa_600 = 'Completed' OR qa_600 = 'Not applicable' OR qa_600 IS NULL OR qa_600 = '') AND
    (qa_700 = 'Completed' OR qa_700 = 'Not applicable' OR qa_700 IS NULL OR qa_700 = '') AND
    (qa_800 = 'Completed' OR qa_800 = 'Not applicable' OR qa_800 IS NULL OR qa_800 = '') AND
    (qa_900 = 'Completed' OR qa_900 = 'Not applicable' OR qa_900 IS NULL OR qa_900 = '')`;

  const HAS_NOT_COMPLETED = `(
    qa_000 LIKE '%Not completed%' OR qa_100 LIKE '%Not completed%' OR
    qa_200 LIKE '%Not completed%' OR qa_300 LIKE '%Not completed%' OR
    qa_400 LIKE '%Not completed%' OR qa_500 LIKE '%Not completed%' OR
    qa_600 LIKE '%Not completed%' OR qa_700 LIKE '%Not completed%' OR
    qa_800 LIKE '%Not completed%' OR qa_900 LIKE '%Not completed%')`;

  const [
    masterStats, masterQa, masterOverdue, masterStatus, masterByClient, masterRedSample,
    personnelStats, personnelByStatus, personnelByTech,
    equipmentStats, equipmentCalib, equipmentExpiredList,
    quoteStats, quoteByStatus,
    leadsStats, leadsByStatus, leadsByResp
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as total, COALESCE(SUM(po_value),0) as total_po,
                           COALESCE(SUM(revenue_to_date),0) as total_invoiced,
                           COALESCE(AVG(cmr_to_date),0) as avg_cmr
                    FROM v_master_current`).first(),
    env.DB.prepare(`SELECT COUNT(*) as total,
                           SUM(CASE WHEN ${NOT_DONE_FRAGMENT} THEN 1 ELSE 0 END) as compliant,
                           SUM(CASE WHEN ${HAS_NOT_COMPLETED} THEN 1 ELSE 0 END) as has_not_completed
                    FROM v_master_current`).first(),
    env.DB.prepare(`SELECT COUNT(*) as overdue FROM v_master_current
                    WHERE end_date IS NOT NULL AND end_date < date('now')
                      AND COALESCE(status,'') NOT LIKE '%omplet%'
                      AND COALESCE(status,'') NOT LIKE '%losed%'
                      AND COALESCE(status,'') NOT LIKE '%ancel%'`).first(),
    env.DB.prepare(`SELECT status, COUNT(*) as c FROM v_master_current
                    WHERE status IS NOT NULL GROUP BY status ORDER BY c DESC LIMIT 10`).all(),
    env.DB.prepare(`SELECT client, COUNT(*) as wos, COALESCE(SUM(po_value),0) as po,
                           COALESCE(SUM(revenue_to_date),0) as invoiced
                    FROM v_master_current WHERE client IS NOT NULL
                    GROUP BY client ORDER BY po DESC LIMIT 5`).all(),
    env.DB.prepare(`SELECT workorder, client, status, po_value FROM v_master_current
                    WHERE ${HAS_NOT_COMPLETED} LIMIT 5`).all(),
    env.DB.prepare(`SELECT COUNT(*) as total, COUNT(DISTINCT technician_name) as techs
                    FROM v_personnel_current`).first(),
    env.DB.prepare(`SELECT status, COUNT(*) as c FROM v_personnel_current
                    WHERE status IS NOT NULL GROUP BY status ORDER BY c DESC LIMIT 8`).all(),
    env.DB.prepare(`SELECT technician_name, COUNT(*) as c FROM v_personnel_current
                    WHERE technician_name IS NOT NULL GROUP BY technician_name ORDER BY c DESC LIMIT 5`).all(),
    env.DB.prepare(`SELECT COUNT(*) as total FROM v_equipment_current`).first(),
    env.DB.prepare(`SELECT
        COUNT(CASE WHEN calibration_due_date IS NOT NULL AND calibration_due_date < date('now') THEN 1 END) as expired,
        COUNT(CASE WHEN calibration_due_date IS NOT NULL
                    AND calibration_due_date BETWEEN date('now') AND date('now','+30 days') THEN 1 END) as expiring_30d,
        COUNT(CASE WHEN calibration_due_date IS NOT NULL AND calibration_due_date > date('now','+30 days') THEN 1 END) as ok
      FROM v_equipment_current`).first(),
    env.DB.prepare(`SELECT description, calibration_due_date FROM v_equipment_current
                    WHERE calibration_due_date IS NOT NULL
                      AND calibration_due_date < date('now','+30 days')
                    ORDER BY calibration_due_date ASC LIMIT 8`).all(),
    env.DB.prepare(`SELECT COUNT(*) as total, COALESCE(SUM(sum_total_base_currency),0) as total_revenue,
                           COALESCE(SUM(cost_sum_total),0) as total_cost
                    FROM v_quotes_current`).first(),
    env.DB.prepare(`SELECT status, COUNT(*) as c, COALESCE(SUM(sum_total_base_currency),0) as revenue
                    FROM v_quotes_current WHERE status IS NOT NULL
                    GROUP BY status ORDER BY c DESC LIMIT 8`).all(),
    env.DB.prepare(`SELECT COUNT(*) as total FROM v_leads_current`).first(),
    env.DB.prepare(`SELECT status, COUNT(*) as c FROM v_leads_current
                    WHERE status IS NOT NULL GROUP BY status ORDER BY c DESC LIMIT 6`).all(),
    env.DB.prepare(`SELECT responsible, COUNT(*) as c FROM v_leads_current
                    WHERE responsible IS NOT NULL GROUP BY responsible ORDER BY c DESC LIMIT 5`).all()
  ]);

  return {
    today: new Date().toISOString().slice(0, 10),
    master: {
      total: masterStats?.total || 0,
      total_po_value: Math.round(masterStats?.total_po || 0),
      total_invoiced: Math.round(masterStats?.total_invoiced || 0),
      avg_cmr_pct: Math.round((masterStats?.avg_cmr || 0) * 1000) / 10,
      qa_compliance_pct: masterQa?.total
        ? Math.round(((masterQa.compliant || 0) / masterQa.total) * 1000) / 10 : 0,
      qa_wos_with_not_completed: masterQa?.has_not_completed || 0,
      overdue_count: masterOverdue?.overdue || 0,
      by_status: masterStatus?.results || [],
      top_clients_by_po: masterByClient?.results || [],
      sample_red_wos: masterRedSample?.results || []
    },
    personnel: {
      total_assignments: personnelStats?.total || 0,
      unique_technicians: personnelStats?.techs || 0,
      by_status: personnelByStatus?.results || [],
      top_technicians: personnelByTech?.results || []
    },
    equipment: {
      total: equipmentStats?.total || 0,
      calibration_expired: equipmentCalib?.expired || 0,
      calibration_expiring_30d: equipmentCalib?.expiring_30d || 0,
      calibration_ok: equipmentCalib?.ok || 0,
      sample_expiring: equipmentExpiredList?.results || []
    },
    quote: {
      total: quoteStats?.total || 0,
      total_revenue_base_currency: Math.round(quoteStats?.total_revenue || 0),
      total_cost: Math.round(quoteStats?.total_cost || 0),
      by_status: quoteByStatus?.results || []
    },
    leads: {
      total: leadsStats?.total || 0,
      by_status: leadsByStatus?.results || [],
      top_responsible: leadsByResp?.results || []
    }
  };
}

async function checkAIRateLimit(env, username) {
  const today = new Date().toISOString().slice(0, 10);
  const key = 'ratelimit:ai:' + username + ':' + today;
  const current = parseInt((await env.USERS.get(key)) || '0', 10);
  if (current >= RATE_LIMIT_DAILY) {
    throw new HttpError(429, 'Daily AI quota reached (' + RATE_LIMIT_DAILY + '). Resets at midnight UTC.');
  }
  await env.USERS.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_TTL_SECONDS });
  return { used: current + 1, max: RATE_LIMIT_DAILY };
}

async function callAnthropic(env, system, userContent, maxTokens) {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens || 400,
      system,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  let body; try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) throw new HttpError(502, 'Anthropic API error · ' + (body?.error?.message || ('HTTP ' + res.status)));
  const text = (body.content && body.content[0] && body.content[0].text) || '';
  return { text, usage: body.usage || {}, model: body.model || ANTHROPIC_MODEL };
}

async function handleAssistantAsk(req, env, headers) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, 'ANTHROPIC_API_KEY not configured');
  const user = await requireJWT(req, env);

  let body; try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, headers); }
  const question = String(body.question || '').trim().slice(0, 1000);
  if (!question) return jsonResponse({ error: 'question is required' }, 400, headers);

  const quota = await checkAIRateLimit(env, user.sub);
  const ctx = await buildAssistantContext(env);
  const system = SYSTEM_ASK.replace('{TODAY}', ctx.today);
  const userContent = 'CONTEXT (JSON):\n' + JSON.stringify(ctx) + '\n\nUser question: ' + question;

  const result = await callAnthropic(env, system, userContent, 400);
  return jsonResponse({
    answer: result.text,
    model: result.model,
    usage: result.usage,
    quota
  }, 200, headers);
}

async function handleAssistantInsights(req, env, headers) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, 'ANTHROPIC_API_KEY not configured');
  const user = await requireJWT(req, env);

  const quota = await checkAIRateLimit(env, user.sub);
  const ctx = await buildAssistantContext(env);
  const userContent = 'CONTEXT (JSON):\n' + JSON.stringify(ctx);
  const result = await callAnthropic(env, SYSTEM_INSIGHTS, userContent, 600);

  let highlights = [];
  try {
    const m = result.text.match(/\[[\s\S]*\]/);
    if (m) highlights = JSON.parse(m[0]);
  } catch (e) { /* graceful fallback */ }

  return jsonResponse({
    highlights,
    raw: result.text,
    model: result.model,
    usage: result.usage,
    quota
  }, 200, headers);
}

// ─────────────────────── Worker entry ───────────────────────

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGIN || '');
    const corsOrigin = isAllowedOrigin(origin, allowed) ? origin : '';
    const headers = corsHeaders(corsOrigin);

    if (req.method === 'OPTIONS') {
      if (!corsOrigin) return new Response('forbidden', { status: 403 });
      return new Response(null, { status: 204, headers });
    }
    if (!corsOrigin && origin) return jsonResponse({ error: 'origin not allowed' }, 403, {});

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');

    try {
      // auth
      if (path === '/auth/login'  && req.method === 'POST') return handleLogin(req, env, headers);
      if (path === '/auth/verify' && req.method === 'GET')  return handleVerify(req, env, headers);
      if (path === '/auth/logout' && req.method === 'POST') return handleLogout(req, env, headers);
      // data
      if (path === '/data/import'   && req.method === 'POST') return handleDataImport(req, env, headers);
      if (path === '/data/snapshot' && req.method === 'GET')  return handleDataSnapshot(req, env, headers, url);
      if (path === '/data/history'  && req.method === 'GET')  return handleDataHistory(req, env, headers, url);
      const batchMatch = path.match(/^\/data\/batch\/(\d+)$/);
      if (batchMatch && req.method === 'DELETE') return handleDataBatchDelete(req, env, headers, batchMatch[1]);
      // assistant (AI)
      if (path === '/assistant/ask'      && req.method === 'POST') return handleAssistantAsk(req, env, headers);
      if (path === '/assistant/insights' && req.method === 'POST') return handleAssistantInsights(req, env, headers);
      // misc
      if (path === '/health' && req.method === 'GET') return jsonResponse({ status: 'ok' }, 200, headers);
      return jsonResponse({ error: 'not found', path }, 404, headers);
    } catch (e) {
      if (e instanceof HttpError) return jsonResponse({ error: e.message }, e.status, headers);
      return jsonResponse({ error: 'internal error', detail: e.message }, 500, headers);
    }
  }
};

export { hashPassword };
