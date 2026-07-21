#!/usr/bin/env node
// ki-gateway v4.1 — multi-provider OpenAI-compatible gateway + admin dashboard.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { resolve as pathResolve, dirname, join as pathJoin, relative as pathRelative, isAbsolute as pathIsAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import crypto from 'node:crypto';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';

// ==== Proxy Pool system (global proxy management, 9router-style) ====
let PROXY_POOLS = []; // [{id, name, url, enabled, status, lastTested, lastError}]
const PROXY_DISPATCHERS = new Map(); // cache: url → ProxyAgent instance

function getDispatcherForUrl(url) {
  if (!url) return null;
  if (PROXY_DISPATCHERS.has(url)) return PROXY_DISPATCHERS.get(url);
  try {
    const agent = new ProxyAgent({ uri: url });
    PROXY_DISPATCHERS.set(url, agent);
    return agent;
  } catch (e) {
    console.error('[proxy-pool] Failed to create dispatcher for', maskProxyUrl(url), sanitizeErrorText(e.message, 160));
    return null;
  }
}

function getProviderDispatcher(providerObj) {
  if (!providerObj || !providerObj.proxyPoolId) return null;
  // Special case: rotate through ALL enabled pools round-robin
  if (providerObj.proxyPoolId === '__all__') {
    const activePools = PROXY_POOLS.filter(p => p.enabled && p.url && p.status !== 'error');
    if (!activePools.length) {
      // fallback: try all enabled (even error) so user still gets something
      const anyEnabled = PROXY_POOLS.filter(p => p.enabled && p.url);
      if (!anyEnabled.length) return null;
      providerObj.__proxyRr = ((providerObj.__proxyRr || 0) + 1) % anyEnabled.length;
      providerObj.__lastProxyPoolId = anyEnabled[providerObj.__proxyRr].id;
      providerObj.__lastProxyPoolName = anyEnabled[providerObj.__proxyRr].name;
      return getDispatcherForUrl(anyEnabled[providerObj.__proxyRr].url);
    }
    providerObj.__proxyRr = ((providerObj.__proxyRr || 0) + 1) % activePools.length;
    const chosen = activePools[providerObj.__proxyRr];
    providerObj.__lastProxyPoolId = chosen.id;
    providerObj.__lastProxyPoolName = chosen.name;
    return getDispatcherForUrl(chosen.url);
  }
  const pool = PROXY_POOLS.find(p => p.id === providerObj.proxyPoolId);
  if (!pool || !pool.enabled) return null;
  providerObj.__lastProxyPoolId = pool.id;
  providerObj.__lastProxyPoolName = pool.name;
  return getDispatcherForUrl(pool.url);
}

function invalidateDispatcher(url) {
  const d = PROXY_DISPATCHERS.get(url);
  if (d) { try { d.close(); } catch {} PROXY_DISPATCHERS.delete(url); }
}

function maskProxyUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      const user = u.username ? u.username.slice(0, 3) + '…' : '';
      return `${u.protocol}//${user}:***@${u.hostname}:${u.port || (u.protocol==='https:'?443:80)}${u.pathname !== '/' ? u.pathname : ''}`;
    }
    return url;
  } catch { return url; }
}
// ==== End proxy pool init ====



const __dirname = dirname(fileURLToPath(import.meta.url));
function parseListenPort(value) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) throw new Error('KIGW_PORT/PORT must be an integer from 1 to 65535');
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('KIGW_PORT/PORT must be an integer from 1 to 65535');
  return port;
}
const PORT = parseListenPort(process.env.KIGW_PORT || process.env.PORT || '8090');
const HOST = process.env.KIGW_HOST || '127.0.0.1';
// Mutable state dir (tests can isolate with KIGW_DATA_DIR). Dashboard HTML stays beside source.
const DATA_DIR = pathResolve(process.env.KIGW_DATA_DIR || process.env.KI_DATA_DIR || pathJoin(homedir(), '.kirouter'));
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const PROVIDERS_FILE = pathResolve(DATA_DIR, 'providers.json');
const DASHBOARD_FILE = pathResolve(__dirname, 'dashboard.html');
// Upstream retry (transient 5xx + network errors)
const RETRY_ATTEMPTS = Math.max(1, Math.min(4, parseInt(process.env.KIGW_RETRY_ATTEMPTS || '2', 10) || 2));
const RETRY_STATUSES = new Set((process.env.KIGW_RETRY_STATUSES || '500,502,503,504,529').split(',').map(x => parseInt(x.trim(), 10)).filter(Boolean));
const RETRY_DELAY_MS = Math.max(0, parseInt(process.env.KIGW_RETRY_DELAY_MS || '350', 10) || 0);
const KEY_ERROR_COOLDOWN_MS = Math.max(0, parseInt(process.env.KIGW_KEY_ERROR_COOLDOWN_MS || '600000', 10) || 0);
const KEY_STATS_FILE = pathResolve(DATA_DIR, 'provider-key-stats.json');
const RESTORE_JOURNAL_FILE = pathResolve(DATA_DIR, '.restore-transaction.json');
let RESTORE_IN_PROGRESS = false;
const ALLOW_PRIVATE_NETWORKS = /^(1|true|yes)$/i.test(String(process.env.KIGW_ALLOW_PRIVATE_NETWORKS || ''));
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.KIGW_TRUST_PROXY || ''));
const BODY_LIMITS = Object.freeze({
  chat: Math.max(16 * 1024, parseInt(process.env.KIGW_CHAT_BODY_LIMIT || String(2 * 1024 * 1024), 10) || 2 * 1024 * 1024),
  admin: Math.max(8 * 1024, parseInt(process.env.KIGW_ADMIN_BODY_LIMIT || String(1024 * 1024), 10) || 1024 * 1024),
  restore: Math.max(64 * 1024, parseInt(process.env.KIGW_RESTORE_BODY_LIMIT || String(8 * 1024 * 1024), 10) || 8 * 1024 * 1024),
});
// Dashboard session hardening
const SESSION_TTL_MS = Math.max(60_000, parseInt(process.env.KIGW_SESSION_TTL_MS || String(24 * 60 * 60 * 1000), 10) || (24 * 60 * 60 * 1000));
const MAX_ADMIN_SESSIONS = Math.max(1, Math.min(10_000, parseInt(process.env.KIGW_MAX_ADMIN_SESSIONS || '100', 10) || 100));
const SESSION_COOKIE_BASE = 'kigw_session';
const SESSION_COOKIE_HOST = '__Host-kigw_session';
const CSRF_COOKIE = 'kigw_csrf';
const LEGACY_KEY_COOKIE = 'kigw_key';
/** @type {Map<string, { id: string, csrf: string, createdAt: number, expiresAt: number, lastSeenAt: number }>} */
const SESSIONS = new Map();
const BUDGET_ALERTED = new Set();
function safeReadJSON(path, fallback) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback; }
  catch (e) { console.warn('[safeReadJSON]', path, e.message); return fallback; }
}

function atomicWriteFile(path, data, options = {}) {
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600, ...options });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

function isPathInsideDataDir(candidate) {
  const rel = pathRelative(pathResolve(DATA_DIR), pathResolve(String(candidate || '')));
  return !!rel && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !pathIsAbsolute(rel);
}
function recoverRestoreTransaction() {
  if (!existsSync(RESTORE_JOURNAL_FILE)) return;
  let journal;
  try {
    journal = JSON.parse(readFileSync(RESTORE_JOURNAL_FILE, 'utf8'));
    if (journal?.version !== 1 || !isPathInsideDataDir(journal.providersStage) || !isPathInsideDataDir(journal.statsStage)) {
      throw new Error('journal contains invalid stage paths');
    }
  } catch (e) {
    const quarantined = `${RESTORE_JOURNAL_FILE}.invalid-${Date.now()}`;
    try { renameSync(RESTORE_JOURNAL_FILE, quarantined); } catch {}
    console.error('[restore] quarantined invalid restore journal:', sanitizeErrorText(e.message, 200));
    return;
  }
  // Keep the journal on operational rename failure. Recovery is idempotent: a
  // later startup can finish whichever staged file still exists.
  for (const [stage, target] of [[journal.providersStage, PROVIDERS_FILE], [journal.statsStage, KEY_STATS_FILE]]) {
    if (existsSync(stage)) renameSync(stage, target);
  }
  unlinkSync(RESTORE_JOURNAL_FILE);
}
function commitRestoreFiles(providerText, statsText) {
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const providersStage = pathResolve(DATA_DIR, `.restore-providers-${nonce}.json`);
  const statsStage = pathResolve(DATA_DIR, `.restore-stats-${nonce}.json`);
  atomicWriteFile(providersStage, providerText);
  atomicWriteFile(statsStage, statsText);
  atomicWriteFile(RESTORE_JOURNAL_FILE, JSON.stringify({ version: 1, providersStage, statsStage }) + '\n');
  recoverRestoreTransaction();
}

/** @type {Record<string, Record<string, any>>} */
let KEY_STATS = {};
function loadKeyStats() {
  try {
    if (!existsSync(KEY_STATS_FILE)) { KEY_STATS = {}; return; }
    const j = JSON.parse(readFileSync(KEY_STATS_FILE, 'utf8'));
    KEY_STATS = (j && typeof j === 'object' && j.stats) ? j.stats : (j || {});
  } catch { KEY_STATS = {}; }
}
let KEY_STATS_SAVE_TIMER = null;
function saveKeyStats() {
  try {
    atomicWriteFile(KEY_STATS_FILE, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), stats: KEY_STATS }, null, 2) + '\n');
  } catch (e) { console.error('saveKeyStats', e.message); }
}
function scheduleKeyStatsSave() {
  if (KEY_STATS_SAVE_TIMER) return;
  KEY_STATS_SAVE_TIMER = setTimeout(() => { KEY_STATS_SAVE_TIMER = null; saveKeyStats(); }, 250);
  KEY_STATS_SAVE_TIMER.unref?.();
}
function keyStatsBucket(prefix) {
  const p = String(prefix || '');
  if (!KEY_STATS[p] || typeof KEY_STATS[p] !== 'object') KEY_STATS[p] = {};
  return KEY_STATS[p];
}
function recordProviderKeyUsage(prefix, keyId, patch = {}) {
  if (!prefix || !keyId) return null;
  const b = keyStatsBucket(prefix);
  const cur = b[keyId] || {
    spentCredit: 0, lastCredit: 0, requests: 0, success: 0, failed: 0,
    status: 'unknown', lastError: '', lastChecked: '', lastModel: '', lastTokens: 0,
  };
  const next = { ...cur };
  if (patch.credit != null && !Number.isNaN(Number(patch.credit))) {
    const c = Number(patch.credit);
    next.lastCredit = c;
    next.spentCredit = Number(next.spentCredit || 0) + c;
  }
  if (patch.incRequest) next.requests = Number(next.requests || 0) + 1;
  if (patch.incSuccess) next.success = Number(next.success || 0) + 1;
  if (patch.incFailed) next.failed = Number(next.failed || 0) + 1;
  if (patch.status) {
    if (patch.status === 'cooldown') {
      // Temporary rate-limit cooldown: don't overwrite a persistent status
      // (exhausted/error), but do set cooldownUntil so pickProviderKey skips.
      next.cooldownUntil = Date.now() + KEY_COOLDOWN_MS;
      if (next.status !== 'exhausted' && next.status !== 'error') next.status = 'active';
    } else {
      next.status = patch.status;
      // Clear cooldown on any explicit status change (success or hard fail)
      if (patch.status === 'active') next.cooldownUntil = 0;
    }
  }
  if (patch.lastError != null) next.lastError = sanitizeErrorText(patch.lastError, 300);
  if (patch.lastModel) next.lastModel = String(patch.lastModel);
  if (patch.tokens != null) next.lastTokens = Number(patch.tokens) || 0;
  next.lastChecked = new Date().toISOString();
  b[keyId] = next;
  scheduleKeyStatsSave();
  return next;
}
function getKeyStat(prefix, keyId) {
  return (KEY_STATS[prefix] && KEY_STATS[prefix][keyId]) || null;
}
function providerSpentCredit(prefix) {
  return Object.values(KEY_STATS[prefix] || {}).reduce((sum, stat) => sum + (Number(stat?.spentCredit) || 0), 0);
}
function providerBudgetState(prefix, provider) {
  const budget = Math.max(0, Number(provider?.budget) || 0);
  const spent = providerSpentCredit(prefix);
  return {
    budget,
    spent,
    action: provider?.budgetAction || 'alert',
    exceeded: budget > 0 && spent >= budget,
  };
}
function extractCreditFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const c = usage.credit ?? usage.credits ?? usage.used_credit ?? usage.credit_used;
  if (c == null || c === '') return null;
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
}
function isCreditsExhaustedError(status, text) {
  const t = String(text || '').toLowerCase();
  // Explicit signals that OUR key's credit is out
  if (status === 402) return true;
  if (t.includes('credits exhausted') || t.includes('credit exhausted') || t.includes('insufficient credit') || t.includes('insufficient_quota') || t.includes('insufficient_balance')) return true;
  // Do NOT match generic 429+"quota"/"exhausted" here — that often means the
  // upstream pool account (not our API key) is throttled. Classified elsewhere.
  return false;
}

// Some upstreams (grok2api, cbai) proxy a pool of accounts behind a single
// API key. Errors like "upstream_quota_exhausted" / "上游账号额度" describe the
// pool account, NOT our key — do not disable our key for those.
function isUpstreamPoolError(status, text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('upstream_quota_exhausted')) return true;
  if (t.includes('upstream_forbidden')) return true;
  if (t.includes('upstream_rate_limited')) return true;
  if (t.includes('upstream_network_error')) return true;
  if (t.includes('上游账号额度')) return true;
  if (t.includes('上游拒绝')) return true;
  if (t.includes('上游请求频率')) return true;
  if (t.includes('连接上游服务失败')) return true;
  return false;
}

function isTransientNetworkError(status, text) {
  if (status === 502 || status === 503 || status === 504) return true;
  const t = String(text || '').toLowerCase();
  if (t.includes('fetch failed') || t.includes('econnreset') || t.includes('etimedout') || t.includes('socket hang up')) return true;
  return false;
}

function classifyProviderKeyFailure(status, text) {
  const t = String(text || '').toLowerCase();
  // 1) Pool/upstream errors — never blame our key
  if (isUpstreamPoolError(status, t)) return '';
  // 2) Transient network — never blame our key
  if (isTransientNetworkError(status, t)) return '';
  // 3) Model-level gating (403 without pool signal) — model not entitled, key fine
  if (status === 403 && !isUpstreamPoolError(status, t)) return '';
  // 4) Model config problem
  if (status === 404 && (t.includes('model_not_found') || t.includes('模型不存在'))) return '';
  // 5) Rate limit at our key level — temporary cooldown, not permanent exhausted
  if (status === 429 && !isCreditsExhaustedError(status, t)) return 'cooldown';
  // 6) Real key-level failures
  if (isCreditsExhaustedError(status, t)) return 'exhausted';
  if (status === 401) return 'error';
  if (/(invalid|expired|revoked|unauthorized).{0,30}(api.?key|token)|(api.?key|token).{0,30}(invalid|expired|revoked)|account.{0,30}(suspend|restricted)/i.test(t)) return 'error';
  return '';
}

// Duration of temporary cooldown (rate-limited but key still valid)
const KEY_COOLDOWN_MS = 60 * 1000;

// ============================================================
// Request log — SQLite backed (persistent, fast aggregations)
// Migrated from JSON file in ki-gateway v1.5.
// Legacy JSON file kept as import source; new writes go to SQLite.
// ============================================================
const REQUEST_LOG_FILE = pathResolve(DATA_DIR, 'request-log.json');
const DB_FILE = pathResolve(DATA_DIR, 'ki-gateway.db');
const REQUEST_LOG_MAX = 300;      // in-memory cache size (for hot path reads)
const REQUEST_LOG_KEEP_DAYS = 30;  // purge older than this in SQLite

let DB = null;
let DB_STMT = null;

const DB_SCHEMA_VERSION = 2;
function tableColumns(table) {
  return new Set(DB.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
}
function ensureColumn(table, name, definition) {
  if (!tableColumns(table).has(name)) DB.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
function migrateDb() {
  let version = Number(DB.pragma('user_version', { simple: true })) || 0;
  if (version > DB_SCHEMA_VERSION) throw new Error(`database schema ${version} is newer than supported ${DB_SCHEMA_VERSION}`);
  const migrate = DB.transaction(() => {
    if (version < 1) {
      DB.exec(`
        CREATE TABLE IF NOT EXISTS request_log (
          id TEXT PRIMARY KEY, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL,
          provider TEXT, model TEXT, status INTEGER, ok INTEGER,
          latency_ms INTEGER, tokens INTEGER, prompt_tokens INTEGER,
          completion_tokens INTEGER, credit REAL, error TEXT, preview TEXT,
          stream INTEGER, key_id TEXT, raw TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_req_ts ON request_log(ts_ms DESC);
        CREATE INDEX IF NOT EXISTS idx_req_provider ON request_log(provider);
        CREATE INDEX IF NOT EXISTS idx_req_ok ON request_log(ok);
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL,
          action TEXT NOT NULL, target TEXT, detail TEXT, actor TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts_ms DESC);
      `);
      version = 1;
    }
    if (version < 2) {
      // Upgrade early/legacy databases that predate request metadata columns.
      ensureColumn('request_log', 'prompt_tokens', 'INTEGER');
      ensureColumn('request_log', 'completion_tokens', 'INTEGER');
      ensureColumn('request_log', 'credit', 'REAL');
      ensureColumn('request_log', 'preview', 'TEXT');
      ensureColumn('request_log', 'stream', 'INTEGER');
      ensureColumn('request_log', 'key_id', 'TEXT');
      ensureColumn('request_log', 'raw', 'TEXT');
      version = 2;
    }
    DB.pragma(`user_version = ${DB_SCHEMA_VERSION}`);
  });
  migrate();
}

function initDb() {
  const BetterSqlite3 = createRequire(import.meta.url)('better-sqlite3');
  DB = new BetterSqlite3(DB_FILE);
  DB.pragma('journal_mode = WAL');
  DB.pragma('synchronous = NORMAL');
  DB.pragma('foreign_keys = ON');
  migrateDb();
  DB_STMT = {
    insertReq: DB.prepare(`INSERT OR REPLACE INTO request_log
      (id, ts, ts_ms, provider, model, status, ok, latency_ms, tokens, prompt_tokens, completion_tokens, credit, error, preview, stream, key_id, raw)
      VALUES (@id, @ts, @ts_ms, @provider, @model, @status, @ok, @latency_ms, @tokens, @prompt_tokens, @completion_tokens, @credit, @error, @preview, @stream, @key_id, @raw)`),
    recent: DB.prepare(`SELECT * FROM request_log ORDER BY ts_ms DESC LIMIT ?`),
    recentFiltered: DB.prepare(`SELECT * FROM request_log WHERE (@provider IS NULL OR provider = @provider) AND (@since IS NULL OR ts_ms >= @since) ORDER BY ts_ms DESC LIMIT @limit`),
    countSince: DB.prepare(`SELECT COUNT(*) as c FROM request_log WHERE ts_ms >= ?`),
    statsRange: DB.prepare(`
      SELECT provider,
             COUNT(*) as requests,
             SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) as success,
             SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) as failed,
             SUM(COALESCE(tokens,0)) as tokens,
             SUM(COALESCE(credit,0)) as credit,
             AVG(latency_ms) as avg_latency
        FROM request_log
        WHERE ts_ms >= ?
        GROUP BY provider
    `),
    hourBuckets: DB.prepare(`
      SELECT CAST(ts_ms / 3600000 AS INTEGER) as bucket,
             COUNT(*) as requests,
             SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) as success,
             SUM(COALESCE(tokens,0)) as tokens,
             SUM(COALESCE(credit,0)) as credit
        FROM request_log
        WHERE ts_ms >= ?
        GROUP BY bucket
        ORDER BY bucket ASC
    `),
    byModel: DB.prepare(`
      SELECT provider, model,
             COUNT(*) as requests,
             SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) as success,
             SUM(COALESCE(tokens,0)) as tokens,
             AVG(latency_ms) as avg_latency
        FROM request_log
        WHERE ts_ms >= ? AND model IS NOT NULL AND model != ''
        GROUP BY provider, model
        ORDER BY requests DESC
        LIMIT 50
    `),
    purgeOld: DB.prepare(`DELETE FROM request_log WHERE ts_ms < ?`),
    insertAudit: DB.prepare(`INSERT INTO audit_log (id, ts, ts_ms, action, target, detail, actor) VALUES (@id, @ts, @ts_ms, @action, @target, @detail, @actor)`),
    auditRecent: DB.prepare(`SELECT * FROM audit_log ORDER BY ts_ms DESC LIMIT ?`),
  };
  console.log('[db] SQLite initialised at', DB_FILE);

  // One-time import from legacy JSON file if present and DB empty
  try {
    const legacyCount = DB.prepare('SELECT COUNT(*) as c FROM request_log').get().c;
    if (legacyCount === 0 && existsSync(REQUEST_LOG_FILE)) {
      const j = JSON.parse(readFileSync(REQUEST_LOG_FILE, 'utf8'));
      const items = Array.isArray(j?.items) ? j.items : (Array.isArray(j) ? j : []);
      if (items.length) {
        const tx = DB.transaction((rows) => { for (const r of rows) DB_STMT.insertReq.run(rowToDbEntry(r)); });
        tx(items);
        console.log('[db] imported', items.length, 'legacy request-log entries');
      }
    }
  } catch (e) { console.warn('[db] legacy import failed:', e.message); }
}

function rowToDbEntry(r) {
  return {
    id: r.id || crypto.randomBytes(6).toString('hex'),
    ts: r.ts || new Date().toISOString(),
    ts_ms: r.ts ? new Date(r.ts).getTime() : Date.now(),
    provider: r.provider || null,
    model: r.model || null,
    status: r.status != null ? Number(r.status) : null,
    ok: r.ok ? 1 : 0,
    latency_ms: r.latencyMs != null ? Number(r.latencyMs) : null,
    tokens: r.tokens != null ? Number(r.tokens) : null,
    prompt_tokens: r.promptTokens != null ? Number(r.promptTokens) : null,
    completion_tokens: r.completionTokens != null ? Number(r.completionTokens) : null,
    credit: r.credit != null ? Number(r.credit) : null,
    error: r.error || null,
    preview: (r.preview || '').slice(0, 500) || null,
    stream: r.stream ? 1 : 0,
    key_id: r.keyId || null,
    raw: null,  // reserved for future full-payload dump
  };
}

function dbRowToApi(row) {
  return {
    id: row.id,
    ts: row.ts,
    provider: row.provider,
    model: row.model,
    status: row.status,
    ok: !!row.ok,
    latencyMs: row.latency_ms,
    tokens: row.tokens,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    credit: row.credit,
    error: row.error,
    preview: row.preview,
    stream: !!row.stream,
    keyId: row.key_id,
  };
}

/** In-memory cache of recent entries — hot path avoids DB roundtrip per request. */
let REQUEST_LOG = [];
function loadRequestLog() {
  if (!DB) initDb();
  try {
    REQUEST_LOG = DB_STMT.recent.all(REQUEST_LOG_MAX).map(dbRowToApi);
  } catch (e) { console.error('loadRequestLog', e.message); REQUEST_LOG = []; }
}
function saveRequestLog() { /* no-op — SQLite persists on write */ }

function pushRequestLog(entry) {
  const row = {
    id: crypto.randomBytes(6).toString('hex'),
    ts: new Date().toISOString(),
    ...entry,
  };
  try {
    if (!DB) initDb();
    DB_STMT.insertReq.run(rowToDbEntry(row));
  } catch (e) { console.error('pushRequestLog db', e.message); }
  REQUEST_LOG.unshift(row);
  if (REQUEST_LOG.length > REQUEST_LOG_MAX) REQUEST_LOG.length = REQUEST_LOG_MAX;
  return row;
}

function purgeOldRequests() {
  if (!DB) return;
  try {
    const cutoff = Date.now() - REQUEST_LOG_KEEP_DAYS * 86400_000;
    const r = DB_STMT.purgeOld.run(cutoff);
    if (r.changes > 0) console.log('[db] purged', r.changes, 'old request log entries');
  } catch (e) { console.error('purgeOldRequests', e.message); }
}

function rotateGatewayKey() {
  if ((process.env.KIGW_GATEWAY_KEY || '').trim()) {
    const err = new Error('gateway key is managed by KIGW_GATEWAY_KEY env; unset it to rotate via dashboard');
    err.code = 'env_managed';
    throw err;
  }
  const keyPath = pathResolve(DATA_DIR, '.gateway_key');
  const generated = crypto.randomBytes(32).toString('base64url');
  // Atomic-ish replace: write temp then rename
  const tmp = keyPath + '.tmp.' + process.pid;
  writeFileSync(tmp, generated + '\n', { mode: 0o600 });
  renameSync(tmp, keyPath);
  GATEWAY_KEY = generated;
  // Invalidate every dashboard session — old key/session must not remain valid
  SESSIONS.clear();
  console.log('[ki-gateway] gateway key rotated at', keyPath);
  return generated;
}

function resetAllProviderKeyHealth() {
  let reset = 0;
  for (const pfx of Object.keys(KEY_STATS || {})) {
    const bucket = KEY_STATS[pfx];
    if (!bucket || typeof bucket !== 'object') continue;
    for (const kid of Object.keys(bucket)) {
      const st = bucket[kid];
      if (!st || typeof st !== 'object') continue;
      st.failed = 0;
      st.status = 'unknown';
      st.lastError = '';
      st.cooldownUntil = 0;
      reset += 1;
    }
  }
  saveKeyStats();
  return reset;
}

function purgeRequestLogs({ olderThanDays = null, all = false } = {}) {
  if (!DB) throw new Error('database unavailable');
  if (all) {
    const before = DB.prepare('SELECT COUNT(*) as c FROM request_log').get().c || 0;
    DB.prepare('DELETE FROM request_log').run();
    // keep in-memory ring buffer consistent
    REQUEST_LOG.length = 0;
    return { deleted: before, mode: 'all' };
  }
  const days = Math.max(0, Number(olderThanDays));
  if (!Number.isFinite(days)) throw new Error('olderThanDays required');
  const cutoff = Date.now() - days * 86400_000;
  const r = DB.prepare('DELETE FROM request_log WHERE ts_ms < ?').run(cutoff);
  // trim in-memory log too
  for (let i = REQUEST_LOG.length - 1; i >= 0; i--) {
    if ((REQUEST_LOG[i]?.ts_ms || 0) < cutoff) REQUEST_LOG.splice(i, 1);
  }
  return { deleted: r.changes || 0, mode: `older_than_${days}d`, cutoffMs: cutoff };
}

function gatewayInfoPayload() {
  let requestLogCount = 0;
  try { if (DB) requestLogCount = DB.prepare('SELECT COUNT(*) as c FROM request_log').get().c || 0; } catch {}
  const uptimeMs = Date.now() - STARTED_AT;
  return {
    version: GATEWAY_VERSION,
    service: 'ki-gateway',
    host: HOST,
    port: PORT,
    listen: `${HOST}:${PORT}`,
    dataDir: DATA_DIR,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    startedAt: new Date(STARTED_AT).toISOString(),
    uptimeMs,
    uptimeSec: Math.floor(uptimeMs / 1000),
    providerCount: Object.keys(PROVIDERS).length,
    enabledProviders: Object.values(PROVIDERS).filter((p) => p?.enabled !== false).length,
    sessionCount: SESSIONS.size,
    requestLogCount,
    keyEnvManaged: !!(process.env.KIGW_GATEWAY_KEY || '').trim(),
  };
}

function auditLog(action, target, detail, actor) {
  if (!DB) return;
  try {
    DB_STMT.insertAudit.run({
      id: crypto.randomBytes(6).toString('hex'),
      ts: new Date().toISOString(),
      ts_ms: Date.now(),
      action: String(action),
      target: target ? String(target).slice(0, 200) : null,
      detail: detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : null,
      actor: actor || 'dashboard',
    });
  } catch (e) { console.error('auditLog', e.message); }
}
function summarizeMessages(messages) {
  try {
    const arr = Array.isArray(messages) ? messages : [];
    const lastUser = [...arr].reverse().find((m) => m && m.role === 'user');
    let text = '';
    const c = lastUser?.content;
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) text = c.map((x) => (typeof x === 'string' ? x : (x?.text || ''))).join(' ');
    text = String(text || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 160);
  } catch { return ''; }
}
function sanitizeErrorText(value, max = 300) {
  let text = String(value || '');
  text = text.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi, '$1[redacted]');
  text = text.replace(/([?&](?:key|api[_-]?key|token|password)=)[^&#\s]+/gi, '$1[redacted]');
  text = text.replace(/(?:sk|ck|g2a|kigw)_[A-Za-z0-9._-]{8,}/g, '[redacted]');
  text = text.replace(/:\/\/([^/@:\s]+):([^/@\s]+)@/g, '://$1:[redacted]@');
  return text.slice(0, max);
}

function maskKeyHint(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 10) return '••••';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

const read = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };
function loadOrCreateGatewayKey() {
  const envKey = (process.env.KIGW_GATEWAY_KEY || '').trim();
  if (envKey) return envKey;
  const keyPath = pathResolve(DATA_DIR, '.gateway_key');
  const existing = read(keyPath);
  if (existing) return existing;
  const generated = crypto.randomBytes(32).toString('base64url');
  try {
    writeFileSync(keyPath, generated + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`[ki-gateway] generated gateway key at ${keyPath}`);
    return generated;
  } catch (e) {
    if (e.code === 'EEXIST') {
      const raced = read(keyPath);
      if (raced) return raced;
    }
    throw e;
  }
}
let GATEWAY_KEY = loadOrCreateGatewayKey();
const GATEWAY_VERSION = process.env.KI_GATEWAY_VERSION || 'v1.0.6';
const STARTED_AT = Date.now();
let UPDATE_CHECK_CACHE = null;
const GROK_UPSTREAM_KEY = read(pathResolve(DATA_DIR, '.upstream_key')) || read(pathResolve(__dirname, '.upstream_key'));
const G2A_USER = read(pathResolve(DATA_DIR, '.g2a_user')) || read(pathResolve(__dirname, '.g2a_user'));
const G2A_PASS = read(pathResolve(DATA_DIR, '.g2a_pass')) || read(pathResolve(__dirname, '.g2a_pass'));
const G2A_BASE = process.env.G2A_BASE || 'http://127.0.0.1:8010';


/** @type {Record<string, any>} */
let PROVIDERS = {};

function isBlockedIpv4(ip) {
  const n = ip.split('.').map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a,b,c,d] = n;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 255 && b === 255 && c === 255 && d === 255);
}
function mappedIpv4FromIpv6(ip) {
  const s = String(ip || '').toLowerCase().split('%')[0];
  const dotted = s.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = s.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return '';
  const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
  return `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`;
}
function isBlockedIpv6(ip) {
  const s = String(ip || '').toLowerCase().split('%')[0];
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('fc') || s.startsWith('fd') || /^fe[89ab]/.test(s) || s.startsWith('ff')) return true;
  if (s === '2001:db8::' || /^2001:db8(?::|$)/.test(s)) return true;
  const mapped = mappedIpv4FromIpv6(s);
  return mapped ? isBlockedIpv4(mapped) : false;
}
function isBlockedAddress(ip) {
  const family = isIP(String(ip || ''));
  return !family || (family === 4 ? isBlockedIpv4(ip) : isBlockedIpv6(ip));
}
function normalizeNetworkUrl(value, { kind = 'provider', allowCredentials = false } = {}) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch { throw new Error(`${kind} URL must be an absolute URL`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`${kind} URL must use http or https`);
  if (u.hash) throw new Error(`${kind} URL fragments are not allowed`);
  if (!allowCredentials && (u.username || u.password)) throw new Error(`${kind} URL credentials are not allowed`);
  if (!u.hostname) throw new Error(`${kind} URL hostname is required`);
  const hostLiteral = u.hostname.replace(/^\[|\]$/g, '');
  if (!ALLOW_PRIVATE_NETWORKS && isIP(hostLiteral) && isBlockedAddress(hostLiteral)) {
    throw new Error(`${kind} URL targets a private/reserved address; set KIGW_ALLOW_PRIVATE_NETWORKS=1 only for trusted local endpoints`);
  }
  return u.toString().replace(/\/$/, '');
}
async function resolveNetworkTarget(value, kind = 'provider') {
  const normalized = normalizeNetworkUrl(value, { kind, allowCredentials: kind === 'proxy' });
  if (ALLOW_PRIVATE_NETWORKS) return { normalized, records: null };
  const u = new URL(normalized);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const records = isIP(host) ? [{ address: host, family: isIP(host) }] : await dnsLookup(host, { all: true, verbatim: true });
  if (!records.length || records.some((r) => isBlockedAddress(r.address))) {
    throw new Error(`${kind} URL resolves to a private/reserved address; set KIGW_ALLOW_PRIVATE_NETWORKS=1 only for trusted local endpoints`);
  }
  return { normalized, records };
}
async function assertPublicDestination(value, kind = 'provider') {
  return (await resolveNetworkTarget(value, kind)).normalized;
}
const PINNED_DISPATCHERS = new Map();
function pinnedDispatcher(url, records) {
  if (!records) return null;
  const u = new URL(url);
  const key = `${u.protocol}//${u.host}|${records.map((r) => `${r.address}/${r.family}`).join(',')}`;
  if (PINNED_DISPATCHERS.has(key)) return PINNED_DISPATCHERS.get(key);
  let cursor = 0;
  const dispatcher = new Agent({ connect: { lookup(_hostname, options, callback) {
    const r = records[cursor++ % records.length];
    if (options?.all) callback(null, records.map((x) => ({ address: x.address, family: x.family })));
    else callback(null, r.address, r.family);
  } } });
  PINNED_DISPATCHERS.set(key, dispatcher);
  if (PINNED_DISPATCHERS.size > 64) {
    const [oldKey, old] = PINNED_DISPATCHERS.entries().next().value;
    PINNED_DISPATCHERS.delete(oldKey);
    try { old.close(); } catch {}
  }
  return dispatcher;
}
async function guardedFetch(url, options = {}, kind = 'provider') {
  let current = String(url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const target = await resolveNetworkTarget(current, kind);
    current = target.normalized;
    const dispatcher = pinnedDispatcher(current, target.records);
    const response = dispatcher
      ? await undiciFetch(current, { ...options, dispatcher, redirect: 'manual' })
      : await fetch(current, { ...options, redirect: 'manual' });
    if (![301,302,303,307,308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    try { await response.body?.cancel?.(); } catch {}
    current = await assertPublicDestination(new URL(location, current).toString(), kind);
    if (redirects === 3) throw new Error('too many upstream redirects');
    if (response.status === 303) options = { ...options, method: 'GET', body: undefined };
  }
  throw new Error('too many upstream redirects');
}

function defaultProvidersConfig() {
  return {
    version: 1,
    providers: {
      grok: {
        name: 'Grok2API',
        baseUrl: `${G2A_BASE}/v1`,
        key: GROK_UPSTREAM_KEY || '',
        enabled: true,
        models: [
          { id: 'grok-4.5', label: 'Grok 4.5 (Build)', tier: 'build' },
          { id: 'grok-chat-fast', label: 'Grok Chat Fast (Web)', tier: 'web' },
        ],
      },
    },
  };
}

function normalizeProvider(prefix, raw = {}) {
  const pfx = String(prefix || '').trim().toLowerCase();
  if (!pfx || !/^[a-z0-9_-]+$/.test(pfx)) throw new Error('invalid prefix');
  const baseUrlRaw = String(raw.baseUrl || '').trim().replace(/\/$/, '');
  if (!baseUrlRaw) throw new Error('baseUrl required');
  const baseUrl = normalizeNetworkUrl(baseUrlRaw, { kind: 'provider' });
  const typeRaw = String(raw.type || 'openai').trim().toLowerCase();
  // openai = OpenAI-compatible chat/completions
  // anthropic = Anthropic-compatible (OpenAI-compat proxy path; label preserved for UI/routing clarity)
  // codebuddy = native CodeBuddy adapter
  let type = 'openai';
  if (['codebuddy', 'codebuddy-global', 'cbai'].includes(typeRaw)) type = 'codebuddy';
  else if (['anthropic', 'claude', 'anthropic-compatible'].includes(typeRaw)) type = 'anthropic';
  const models = Array.isArray(raw.models) ? raw.models : [];
  const normModels = models.map((m) => {
    const rawId = String(typeof m === 'string' ? m : (m?.id || '')).trim();
    let id = rawId;
    // CodeBuddy model IDs are bare. Repair legacy values such as cbai/cbai/gpt-5.6-sol.
    if (type === 'codebuddy') {
      while (id.startsWith(`${pfx}/`)) id = id.slice(pfx.length + 1);
    }
    if (!id) return null;
    return {
      id,
      label: String((typeof m === 'object' && m?.label) || id).trim(),
      ...(m?.tier ? { tier: String(m.tier) } : {}),
    };
  }).filter(Boolean);
  if (!normModels.length) throw new Error('at least 1 model required');
  // codebuddy base is origin; path /v2/chat/completions is handled by adapter
  let finalBase = baseUrl;
  if (type === 'codebuddy') {
    // accept either origin or full path; normalize to origin
    finalBase = baseUrl
      .replace(/\/v2\/chat\/completions\/?$/, '')
      .replace(/\/v1\/?$/, '')
      .replace(/\/$/, '') || 'https://www.codebuddy.ai';
  }
  const authModeRaw = String(raw.authMode || raw.auth || 'api-key').trim().toLowerCase();
  const authMode = authModeRaw.startsWith('oauth') ? 'oauth' : 'api-key';
  // multi-key pool (9router-style connections)
  let keys = [];
  if (Array.isArray(raw.keys)) {
    for (const k of raw.keys) {
      if (typeof k === 'string') {
        const kk = k.trim();
        if (kk) keys.push({ id: crypto.randomUUID().slice(0, 8), key: kk, enabled: true, label: '' });
      } else if (k && typeof k === 'object') {
        const kk = String(k.key || k.apiKey || '').trim();
        if (!kk) continue;
        keys.push({
          id: String(k.id || crypto.randomUUID().slice(0, 8)),
          key: kk,
          enabled: k.enabled !== false,
          label: String(k.label || k.name || '').trim(),
        });
      }
    }
  }
  let primary = String(raw.key || '').trim();
  if (!primary && keys.length) primary = keys.find((x) => x.enabled !== false)?.key || keys[0].key || '';
  // if primary set but keys empty, seed keys
  if (primary && !keys.some((x) => x.key === primary)) {
    keys.unshift({ id: crypto.randomUUID().slice(0, 8), key: primary, enabled: true, label: 'primary' });
  }
  return {
    name: String(raw.name || pfx).trim() || pfx,
    type,
    authMode,
    baseUrl: finalBase,
    key: primary,
    keys,
    enabled: raw.enabled !== false,
    models: normModels,
    budget: Math.max(0, Number(raw.budget) || 0),
    budgetAction: ['alert', 'disable', 'none'].includes(raw.budgetAction) ? raw.budgetAction : 'alert',
    proxyPoolId: String(raw.proxyPoolId || ''),
  };
}

// Catalog providers — auto-registered on first boot so prefixes resolve.
// They start with enabled:false and no API key. Add key via Providers page to activate.
const CATALOG_PROVIDERS = {
  'openai':      { name: 'OpenAI',           type: 'openai', baseUrl: 'https://api.openai.com/v1',                    models: ['gpt-4o','gpt-4o-mini','gpt-4-turbo','gpt-4','o1','o1-mini','o1-pro','o3-mini'] },
  'anthropic':   { name: 'Anthropic',        type: 'openai', baseUrl: 'https://api.anthropic.com/v1',                 models: ['claude-sonnet-4.5','claude-haiku-4.5','claude-opus-4.5','claude-3.5-sonnet','claude-3.5-haiku','claude-3-opus'] },
  'gemini':      { name: 'Google Gemini',    type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.0-flash','gemini-2.0-flash-thinking','gemini-1.5-pro','gemini-1.5-flash','gemini-1.5-flash-8b'] },
  'deepseek':    { name: 'DeepSeek',         type: 'openai', baseUrl: 'https://api.deepseek.com/v1',                  models: ['deepseek-chat','deepseek-reasoner','deepseek-coder'] },
  'openrouter':  { name: 'OpenRouter',       type: 'openai', baseUrl: 'https://openrouter.ai/api/v1',                 models: ['openrouter/auto','anthropic/claude-sonnet-4.5','openai/gpt-4o','google/gemini-2.0-flash-001','deepseek/deepseek-chat','meta-llama/llama-3.3-70b-instruct','qwen/qwen-2.5-72b-instruct'] },
  'groq':        { name: 'Groq',             type: 'openai', baseUrl: 'https://api.groq.com/openai/v1',               models: ['llama-3.3-70b-versatile','llama-3.1-8b-instant','mixtral-8x7b-32768','gemma2-9b-it'] },
  'mistral':     { name: 'Mistral',          type: 'openai', baseUrl: 'https://api.mistral.ai/v1',                    models: ['mistral-large-latest','mistral-medium-latest','mistral-small-latest','codestral-latest','open-mixtral-8x22b'] },
  'together':    { name: 'Together AI',      type: 'openai', baseUrl: 'https://api.together.xyz/v1',                  models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo','meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo','Qwen/Qwen2.5-72B-Instruct-Turbo','mistralai/Mixtral-8x7B-Instruct-v0.1'] },
  'fireworks':   { name: 'Fireworks',        type: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1',        models: ['accounts/fireworks/models/llama-v3p3-70b-instruct','accounts/fireworks/models/llama4-maverick-instruct-basic','accounts/fireworks/models/qwen2p5-72b-instruct','accounts/fireworks/models/deepseek-v3'] },
  'perplexity':  { name: 'Perplexity',       type: 'openai', baseUrl: 'https://api.perplexity.ai',                    models: ['perplexity/sonar-pro','perplexity/sonar','perplexity/sonar-reasoning','perplexity/sonar-reasoning-pro'] },
  'cohere':      { name: 'Cohere',           type: 'openai', baseUrl: 'https://api.cohere.ai/compatibility/v1',       models: ['command-r-plus','command-r','command','command-light'] },
  'xai':         { name: 'xAI (Grok)',       type: 'openai', baseUrl: 'https://api.x.ai/v1',                          models: ['grok-4.5','grok-4','grok-3','grok-3-mini','grok-2','grok-2-vision'] },
  'zai':         { name: 'Z.AI (GLM)',       type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4',                 models: ['glm-5.2','glm-5.1','glm-5','glm-4.7'] },
  'moonshot':    { name: 'Moonshot (Kimi)',  type: 'openai', baseUrl: 'https://api.moonshot.cn/v1',                   models: ['moonshot-v1-8k','moonshot-v1-32k','moonshot-v1-128k','kimi-k1.5'] },
  'nvidia':      { name: 'NVIDIA NIM',       type: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1',          models: ['nvidia/llama-3.1-nemotron-70b-instruct','nvidia/llama-3.3-nemotron-super-49b','deepseek-ai/deepseek-r1','qwen/qwen2.5-coder-32b-instruct'] },
  'novita':      { name: 'Novita AI',        type: 'openai', baseUrl: 'https://api.novita.ai/v3/openai',              models: ['deepseek/deepseek-v3','deepseek/deepseek-r1','qwen/qwen2.5-72b-instruct','meta-llama/llama-3.3-70b-instruct'] },
  'openmodel':   { name: 'OpenModel',        type: 'openai', baseUrl: 'https://api.openmodel.ai/v1',                  models: ['deepseek-v4-flash','deepseek-v4-chat'] },
  'ollama':      { name: 'Ollama',           type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1',                    models: ['llama3.3','llama3.1','qwen2.5','mistral','codellama','phi4'] },
  'kiro':        { name: 'Kiro AI',          type: 'openai', baseUrl: 'https://codewhisperer.us-east-1.amazonaws.com',  models: ['claude-sonnet-4.5','claude-sonnet-4','claude-haiku-4.5','glm-5','auto'] },
  'codebuddy-cn': { name: 'CodeBuddy CN',    type: 'openai', baseUrl: 'https://www.codebuddy.cn/api',                 models: ['deepseek-v4-pro','glm-5.2','kimi-k3','minimax-m3'] },
  'grok-cli':    { name: 'Grok CLI (Build)', type: 'openai', baseUrl: 'http://127.0.0.1:8010/v1',                     models: ['grok-4.5','grok-3','grok-3-mini'] },
};

function ensureCatalogProviders() {
  let changed = false;
  for (const [prefix, spec] of Object.entries(CATALOG_PROVIDERS)) {
    if (PROVIDERS[prefix]) continue; // already registered
    try {
      const norm = normalizeProvider(prefix, {
        name: spec.name,
        type: spec.type,
        baseUrl: spec.baseUrl,
        models: spec.models.map(id => ({ id, label: id })),
        key: '',
        enabled: false, // starts disabled — enable + add key to activate
      });
      PROVIDERS[prefix] = norm;
      changed = true;
      console.log('[catalog] registered:', prefix);
    } catch (e) {
      console.error('[catalog] skip', prefix, e.message);
    }
  }
  if (changed) persistProviders();
}

function loadProviders() {
  let cfg;
  if (existsSync(PROVIDERS_FILE)) {
    try {
      cfg = JSON.parse(readFileSync(PROVIDERS_FILE, 'utf8'));
    } catch (e) {
      console.error('[providers] invalid providers.json, using defaults:', e.message);
      cfg = defaultProvidersConfig();
    }
  } else {
    cfg = defaultProvidersConfig();
    saveProvidersConfig(cfg);
  }
  const next = {};
  const src = cfg?.providers || {};
  for (const [k, v] of Object.entries(src)) {
    try {
      const p = normalizeProvider(k, v);
      // keep empty key only if update intentionally keeps; for load allow empty
      next[k.toLowerCase()] = p;
    } catch (e) {
      console.error(`[providers] skip ${k}: ${e.message}`);
    }
  }
  // A private default upstream requires explicit KIGW_ALLOW_PRIVATE_NETWORKS=1.
  // If it is blocked, keep booting with the public disabled catalog instead of crashing.
  if (!Object.keys(next).length) {
    const d = defaultProvidersConfig().providers.grok;
    try { next.grok = normalizeProvider('grok', d); }
    catch (e) { console.warn('[providers] default grok disabled:', e.message); }
  }
  // if grok key empty but env/file key exists, fill
  if (next.grok && !next.grok.key && GROK_UPSTREAM_KEY) next.grok.key = GROK_UPSTREAM_KEY;
  PROVIDERS = next;
  // Load proxy pools defensively. Hand-edited state must not bypass URL normalization.
  PROXY_POOLS = [];
  for (const rawPool of (Array.isArray(cfg?.proxyPools) ? cfg.proxyPools : [])) {
    try {
      const id = String(rawPool?.id || '').trim();
      if (!id) throw new Error('proxy id required');
      const url = normalizeNetworkUrl(rawPool?.url, { kind: 'proxy', allowCredentials: true });
      PROXY_POOLS.push({
        id, name: String(rawPool?.name || id), url, enabled: rawPool?.enabled !== false,
        status: String(rawPool?.status || 'unknown'), lastTested: rawPool?.lastTested || null,
        lastError: rawPool?.lastError ? sanitizeErrorText(rawPool.lastError, 200) : null,
      });
    } catch (e) { console.error('[proxy-pools] skip invalid entry:', sanitizeErrorText(e.message, 160)); }
  }
  // Restore proxyPoolId per provider from cfg
  for (const [k, v] of Object.entries(src)) {
    if (v && v.proxyPoolId && PROVIDERS[k.toLowerCase()]) {
      PROVIDERS[k.toLowerCase()].proxyPoolId = v.proxyPoolId;
    }
  }
  loadKeyStats();
  return PROVIDERS;
}

function saveProvidersConfig(cfg) {
  atomicWriteFile(PROVIDERS_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

function persistProviders() {
  const cfg = {
    version: 1,
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, {
      name: v.name,
      type: v.type || 'openai',
      authMode: v.authMode || 'api-key',
      baseUrl: v.baseUrl,
      key: v.key || '',
      keys: (v.keys || []).map((x) => ({ id: x.id, key: x.key, enabled: x.enabled !== false, label: x.label || '' })),
      enabled: v.enabled !== false,
      models: v.models || [],
      proxyPoolId: v.proxyPoolId || '',
      budget: Math.max(0, Number(v.budget) || 0),
      budgetAction: ['alert', 'disable', 'none'].includes(v.budgetAction) ? v.budgetAction : 'alert',
    }])),
    proxyPools: PROXY_POOLS,
  };
  saveProvidersConfig(cfg);
}

function listProvidersPublic(includeKey = false) {
  return Object.entries(PROVIDERS).map(([prefix, p]) => {
    const keys = p.keys || [];
    const enabledKeys = keys.filter((k) => k.enabled !== false);
    let linkedPool = null;
    if (p.proxyPoolId === '__all__') {
      const activeCount = PROXY_POOLS.filter(pp => pp.enabled).length;
      linkedPool = { id: '__all__', name: 'All Pools (rotate)', mode: 'rotate', activeCount, enabled: true, status: activeCount > 0 ? 'active' : 'unknown' };
    } else if (p.proxyPoolId) {
      const found = PROXY_POOLS.find(pp => pp.id === p.proxyPoolId);
      if (found) linkedPool = { id: found.id, name: found.name, status: found.status, enabled: found.enabled };
    }
    return {
      prefix,
      name: p.name,
      type: p.type || 'openai',
      authMode: p.authMode || 'api-key',
      baseUrl: p.baseUrl,
      enabled: p.enabled !== false,
      models: p.models || [],
      keyCount: keys.length,
      enabledKeyCount: enabledKeys.length,
      proxyPoolId: p.proxyPoolId || '',
      proxyPool: linkedPool,
      keyMasked: p.key ? (p.key.length <= 10 ? '••••' : (p.key.slice(0, 6) + '…' + p.key.slice(-4))) : '',
      budget: Math.max(0, Number(p.budget) || 0),
      budgetAction: p.budgetAction || 'alert',
      currentSpent: providerSpentCredit(prefix),
      keys: keys.map((k) => {
        const st = getKeyStat(prefix, k.id) || {};
        return {
          id: k.id,
          label: k.label || '',
          enabled: k.enabled !== false,
          keyMasked: k.key ? (k.key.length <= 10 ? '••••' : (k.key.slice(0, 6) + '…' + k.key.slice(-4))) : '',
          spentCredit: Number(st.spentCredit || 0),
          lastCredit: Number(st.lastCredit || 0),
          requests: Number(st.requests || 0),
          success: Number(st.success || 0),
          failed: Number(st.failed || 0),
          status: st.status || (k.enabled === false ? 'disabled' : 'unknown'),
          lastError: st.lastError || '',
          lastChecked: st.lastChecked || '',
          lastModel: st.lastModel || '',
          lastTokens: Number(st.lastTokens || 0),
          cooldownUntil: Number(st.cooldownUntil || 0),
        };
      }),
      ...(includeKey ? { hasKey: !!p.key || enabledKeys.length > 0 } : {}),
    };
  });
}

function pickProviderKey(provider, forcePrefix = '') {
  // Filter healthy keys: enabled, has key, not exhausted/error
  // Status is stored in KEY_STATS, not in the key object itself
  const prefix = forcePrefix || provider.__prefix || '';
  const allKeys = (provider?.keys || []).filter((k) => k.enabled !== false && k.key);
  const healthyKeys = allKeys.filter((k) => {
    const st = getKeyStat(prefix, k.id);
    const status = String(st?.status || 'unknown').toLowerCase();
    if (status === 'exhausted') return false;
    // Temporary rate-limit cooldown: skip until cooldownUntil has passed
    const cd = Number(st?.cooldownUntil || 0);
    if (cd && Date.now() < cd) return false;
    if (status !== 'error') return true;
    const checked = Date.parse(st?.lastChecked || '') || 0;
    return KEY_ERROR_COOLDOWN_MS > 0 && Date.now() - checked >= KEY_ERROR_COOLDOWN_MS;
  });
  const keys = healthyKeys;
  if (keys.length) {
    // simple round-robin
    provider.__rr = ((provider.__rr || 0) + 1) % keys.length;
    const chosen = keys[provider.__rr];
    provider.__lastKeyId = chosen.id;
    provider.__lastKey = chosen.key;
    return chosen.key;
  }
  // A configured pool that is entirely unhealthy must not silently recycle dead keys.
  if (allKeys.length) {
    provider.__lastKeyId = '';
    provider.__lastKey = '';
    return '';
  }
  const primaryId = (provider?.keys || []).find((k) => k.key === provider?.key)?.id || 'primary';
  const primaryStat = getKeyStat(prefix, primaryId);
  if (primaryStat?.status === 'exhausted') return '';
  provider.__lastKeyId = primaryId;
  provider.__lastKey = provider?.key || '';
  return provider?.key || '';
}

function hasEligibleProviderKey(provider, prefix = '') {
  const configured = (provider?.keys || []).filter((k) => k.key);
  const pool = configured.filter((k) => k.enabled !== false);
  if (configured.length && !pool.length) return false;
  if (!configured.length) return !!provider?.key;
  return pool.some((k) => {
    const st = getKeyStat(prefix || provider.__prefix || '', k.id);
    const status = String(st?.status || 'unknown').toLowerCase();
    if (status === 'exhausted') return false;
    const cd = Number(st?.cooldownUntil || 0);
    if (cd && Date.now() < cd) return false;
    if (status !== 'error') return true;
    const checked = Date.parse(st?.lastChecked || '') || 0;
    return KEY_ERROR_COOLDOWN_MS > 0 && Date.now() - checked >= KEY_ERROR_COOLDOWN_MS;
  });
}

function resolve(model) {
  if (!model) return null;
  const hasSlash = String(model).includes('/');
  const prefix = hasSlash ? String(model).split('/')[0] : 'grok';
  const p = PROVIDERS[prefix];
  if (!p) return null;
  if (p.enabled === false) return null;
  let upstreamModel = hasSlash ? String(model).slice(prefix.length + 1) : String(model);
  // Defensive repair for legacy double-prefixed CodeBuddy paths only. Other
  // providers may legitimately use namespaced IDs such as openrouter/auto.
  if (isCodebuddyProvider(p)) {
    while (upstreamModel.startsWith(`${prefix}/`)) upstreamModel = upstreamModel.slice(prefix.length + 1);
  }
  if (!upstreamModel) return null;
  p.__prefix = prefix;
  return { provider: p, prefix, upstreamModel };
}


// ---- native upstream adapters ----
function isCodebuddyProvider(p) {
  return (p?.type || 'openai') === 'codebuddy';
}

function codebuddyHeaders(key, baseUrl) {
  const host = String(baseUrl || 'https://www.codebuddy.ai').replace(/^https?:\/\//, '').split('/')[0];
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
    'X-API-Key': key,
    'X-User-Id': 'anonymous',
    'X-Domain': host,
    'X-Agent-Intent': 'craft',
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'X-IDE-Version': '1.0.7',
    'X-Product': 'SaaS',
    'User-Agent': 'CLI/1.0.7 CodeBuddy/1.0.7',
    'X-Conversation-ID': crypto.randomUUID(),
    'X-Conversation-Request-ID': crypto.randomBytes(16).toString('hex'),
    'X-Conversation-Message-ID': crypto.randomUUID().replace(/-/g, ''),
    'X-Request-ID': crypto.randomUUID().replace(/-/g, ''),
  };
}

function aggregateCodebuddySse(chunks, model) {
  let content = '';
  let reasoning = '';
  let finish = 'stop';
  let usage = null;
  const toolCalls = {};
  for (const line of String(chunks).split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const d = s.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(d); } catch { continue; }
    if (obj.usage) usage = obj.usage;
    for (const ch of obj.choices || []) {
      if (ch.finish_reason) finish = ch.finish_reason;
      const delta = ch.delta || {};
      if (delta.content) content += delta.content;
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index || 0;
        const slot = (toolCalls[idx] ||= { id: null, type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name = tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
  }
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  const tcs = Object.keys(toolCalls).sort((a, b) => Number(a) - Number(b)).map((k) => toolCalls[k]);
  if (tcs.length) { message.tool_calls = tcs; if (finish === 'stop') finish = 'tool_calls'; }
  return {
    id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function normalizeSseLine(line) {
  const t = line.trim();
  if (!t.startsWith('data:')) return line + '\n';
  const d = t.slice(5).trim();
  if (d === '[DONE]') return 'data: [DONE]\n\n';
  try {
    const obj = JSON.parse(d);
    for (const ch of obj.choices || []) {
      if (ch.finish_reason === '') ch.finish_reason = null;
    }
    return 'data: ' + JSON.stringify(obj) + '\n\n';
  } catch {
    return line + '\n';
  }
}

async function forwardOpenAI(provider, upstreamModel, payload) {
  const body = { ...payload, model: upstreamModel };
  const key = pickProviderKey(provider, provider.__prefix || '');
  await assertPublicDestination(provider.baseUrl, 'provider');
  const _dispatcher_ = getProviderDispatcher(provider);
  if (_dispatcher_) {
    const pool = PROXY_POOLS.find((p) => p.id === provider.__lastProxyPoolId);
    if (pool?.url) await assertPublicDestination(pool.url, 'proxy');
    // A proxy performs its own DNS lookup, so reject a target that already resolves
    // to a private/reserved address immediately before tunnelling it.
    await assertPublicDestination(provider.baseUrl, 'provider');
  }
  const target = `${provider.baseUrl}/chat/completions`;
  const options = {
    dispatcher: _dispatcher_ || undefined,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  };
  return _dispatcher_ ? undiciFetch(target, { ...options, redirect: 'error' }) : guardedFetch(target, options, 'provider');
}

async function forwardCodebuddy(provider, upstreamModel, payload, { forceNonStream = false, keyOverride = '', keyIdOverride = '' } = {}) {
  const clientWantsStream = forceNonStream ? false : !!payload.stream;
  let messages = Array.isArray(payload.messages) ? payload.messages.slice() : [];
  if (messages.length === 1 && messages[0]?.role === 'user') {
    messages = [{ role: 'system', content: 'You are a helpful assistant.' }, ...messages];
  }
  const upstreamBody = {
    ...payload,
    model: upstreamModel,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  const origin = provider.baseUrl.replace(/\/$/, '');
  await assertPublicDestination(origin, 'provider');
  const url = `${origin}/v2/chat/completions`;
  const key = keyOverride || pickProviderKey(provider, provider.__prefix || '');
  if (!key) throw new Error(`no healthy API key available for provider ${provider.__prefix || provider.name || 'unknown'}`);
  // Capture the selected ID before awaiting fetch; provider round-robin state is shared
  // and another concurrent request may advance it while this request is in flight.
  const selectedKeyId = keyIdOverride || provider.__lastKeyId || '';
  const _cbaidisp_ = getProviderDispatcher(provider);
  if (_cbaidisp_) {
    const pool = PROXY_POOLS.find((p) => p.id === provider.__lastProxyPoolId);
    if (pool?.url) await assertPublicDestination(pool.url, 'proxy');
    await assertPublicDestination(origin, 'provider');
  }
  const _fetchFn_ = _cbaidisp_ ? undiciFetch : fetch;
  const requestOptions = {
    dispatcher: _cbaidisp_ || undefined,
    method: 'POST',
    headers: codebuddyHeaders(key, origin),
    body: JSON.stringify(upstreamBody),
  };
  const up = _cbaidisp_
    ? await _fetchFn_(url, { ...requestOptions, redirect: 'error' })
    : await guardedFetch(url, requestOptions, 'provider');
  // Attach metadata for response writer
  up.__cbClientWantsStream = clientWantsStream;
  up.__cbModel = upstreamModel;
  up.__cbKeyId = selectedKeyId;
  up.__cbKey = key;
  up.__cbPrefix = provider.__prefix || '';
  return up;
}

async function writeUpstreamToClient(res, upstreamRes, provider, upstreamModel) {
  const meta = {
    ok: !!upstreamRes?.ok,
    status: upstreamRes?.status || 0,
    tokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    credit: null,
    error: '',
    stream: false,
    keyId: '',
    keyMasked: '',
  };
  if (isCodebuddyProvider(provider)) {
    const clientWantsStream = !!upstreamRes.__cbClientWantsStream;
    const model = upstreamRes.__cbModel || upstreamModel;
    const prefix = upstreamRes.__cbPrefix || provider.__prefix || '';
    const keyId = upstreamRes.__cbKeyId || provider.__lastKeyId || '';
    meta.keyId = keyId;
    meta.keyMasked = maskKeyHint(upstreamRes.__cbKey || '');
    meta.stream = !!clientWantsStream;
    if (!upstreamRes.ok) {
      const errTxt = await upstreamRes.text();
      const safeErr = sanitizeErrorText(errTxt, 800);
      meta.error = safeErr.slice(0, 400);
      if (keyId) {
        const keyStatus = classifyProviderKeyFailure(upstreamRes.status, errTxt);
        recordProviderKeyUsage(prefix, keyId, {
          incRequest: true,
          incFailed: true,
          status: keyStatus || undefined,
          lastError: safeErr,
          lastModel: model,
        });
      }
      send(res, upstreamRes.status, {
        error: { message: safeErr, type: 'upstream_error', code: upstreamRes.status },
      });
      return meta;
    }
    if (clientWantsStream) {
      res.writeHead(200, securityHeaders(null, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      }));
      const reader = upstreamRes.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let doneSent = false;
      let lastUsage = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const t = line.trim();
          if (!t) { res.write('\n'); continue; }
          if (t.startsWith('data:')) {
            const d0 = t.slice(5).trim();
            if (d0 === '[DONE]') {
              if (!doneSent) { res.write('data: [DONE]\n\n'); doneSent = true; }
              continue;
            }
            try {
              const obj = JSON.parse(d0);
              if (obj && obj.usage) lastUsage = obj.usage;
            } catch {}
            res.write(normalizeSseLine(line));
          } else {
            res.write(line + '\n');
          }
        }
      }
      if (!doneSent) res.write('data: [DONE]\n\n');
      if (lastUsage) {
        meta.tokens = Number(lastUsage.total_tokens || 0);
        meta.promptTokens = Number(lastUsage.prompt_tokens || lastUsage.input_tokens || 0);
        meta.completionTokens = Number(lastUsage.completion_tokens || lastUsage.output_tokens || 0);
        meta.credit = extractCreditFromUsage(lastUsage);
      }
      if (keyId) {
        recordProviderKeyUsage(prefix, keyId, {
          incRequest: true,
          incSuccess: true,
          status: 'active',
          lastError: '',
          lastModel: model,
          credit: meta.credit,
          tokens: meta.tokens,
        });
      }
      res.end();
      return meta;
    }
    // non-stream: aggregate SSE
    const txt = await upstreamRes.text();
    const agg = aggregateCodebuddySse(txt, model);
    if (agg?.usage) {
      meta.tokens = Number(agg.usage.total_tokens || 0);
      meta.promptTokens = Number(agg.usage.prompt_tokens || 0);
      meta.completionTokens = Number(agg.usage.completion_tokens || 0);
      meta.credit = extractCreditFromUsage(agg.usage);
    }
    if (keyId) {
      recordProviderKeyUsage(prefix, keyId, {
        incRequest: true,
        incSuccess: true,
        status: 'active',
        lastError: '',
        lastModel: model,
        credit: meta.credit,
        tokens: meta.tokens,
      });
    }
    send(res, 200, agg);
    return meta;
  }

  // default openai-compatible
  const ct = upstreamRes.headers.get('content-type') || 'application/json';
  const prefix = provider.__prefix || '';
  const keyId = provider.__lastKeyId || '';
  meta.keyId = keyId;
  meta.keyMasked = maskKeyHint(provider.__lastKey || '');
  meta.stream = ct.includes('text/event-stream');
  if (!upstreamRes.ok) {
    const errTxt = await upstreamRes.text();
    const safeErr = sanitizeErrorText(errTxt, 800);
    meta.error = safeErr.slice(0, 400);
    if (keyId) {
      const keyStatus = classifyProviderKeyFailure(upstreamRes.status, errTxt);
      recordProviderKeyUsage(prefix, keyId, { incRequest: true, incFailed: true, status: keyStatus || undefined, lastError: safeErr, lastModel: upstreamModel });
    }
    return send(res, upstreamRes.status, {
      error: { message: safeErr, type: 'upstream_error', code: upstreamRes.status },
    }), meta;
  }
  res.writeHead(upstreamRes.status, securityHeaders(null, { 'Content-Type': ct }));
  if (ct.includes('text/event-stream') && upstreamRes.body) {
    const reader = upstreamRes.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let lastUsage = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      res.write(chunk);
      buf += dec.decode(value, { stream: true });
      // keep only tail to parse usage cheaply
      if (buf.length > 20000) buf = buf.slice(-20000);
    }
    // parse usage from SSE tail if present
    for (const line of buf.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const d0 = t.slice(5).trim();
      if (!d0 || d0 === '[DONE]') continue;
      try {
        const obj = JSON.parse(d0);
        if (obj?.usage) lastUsage = obj.usage;
      } catch {}
    }
    if (lastUsage) {
      meta.tokens = Number(lastUsage.total_tokens || 0);
      meta.promptTokens = Number(lastUsage.prompt_tokens || lastUsage.input_tokens || 0);
      meta.completionTokens = Number(lastUsage.completion_tokens || lastUsage.output_tokens || 0);
      meta.credit = extractCreditFromUsage(lastUsage);
    }
    if (keyId) recordProviderKeyUsage(prefix, keyId, { incRequest: true, incSuccess: true, status: 'active', lastError: '', lastModel: upstreamModel, credit: meta.credit, tokens: meta.tokens });
    res.end();
    return meta;
  }
  const bodyTxt = await upstreamRes.text();
  try {
    const j = JSON.parse(bodyTxt);
    if (j?.usage) {
      meta.tokens = Number(j.usage.total_tokens || 0);
      meta.promptTokens = Number(j.usage.prompt_tokens || 0);
      meta.completionTokens = Number(j.usage.completion_tokens || 0);
      meta.credit = extractCreditFromUsage(j.usage);
    }
    if (j?.error) meta.error = String(j.error?.message || j.error || '').slice(0, 400);
  } catch {}
  if (keyId) recordProviderKeyUsage(prefix, keyId, { incRequest: true, incSuccess: true, status: 'active', lastError: '', lastModel: upstreamModel, credit: meta.credit, tokens: meta.tokens });
  res.end(bodyTxt);
  return meta;
}

async function callProviderChatOnce(provider, upstreamModel, payload, opts = {}) {
  if (isCodebuddyProvider(provider)) return forwardCodebuddy(provider, upstreamModel, payload, opts);
  return forwardOpenAI(provider, upstreamModel, payload);
}

// Retry wrapper. HTTP failures are inspected before any bytes reach the client,
// so rotating to another key is safe for both streaming and non-streaming calls.
async function callProviderChat(provider, upstreamModel, payload, opts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const r = await callProviderChatOnce(provider, upstreamModel, payload, opts);
      const status = r?.status || 0;
      let retryable = RETRY_STATUSES.has(status);
      if (!r?.ok) {
        const errTxt = await r.clone().text().catch(() => '');
        const keyStatus = classifyProviderKeyFailure(status, errTxt);
        retryable = retryable || status === 429 || !!keyStatus;
        const selectedId = isCodebuddyProvider(provider) ? r.__cbKeyId : provider.__lastKeyId;
        const selectedPrefix = isCodebuddyProvider(provider) ? (r.__cbPrefix || provider.__prefix || '') : (provider.__prefix || '');
        if (retryable && attempt < RETRY_ATTEMPTS && selectedId) {
          recordProviderKeyUsage(selectedPrefix, selectedId, {
            incRequest: true, incFailed: true, status: keyStatus || undefined,
            lastError: errTxt, lastModel: upstreamModel,
          });
        }
      }
      if (attempt < RETRY_ATTEMPTS && retryable) {
        if (!hasEligibleProviderKey(provider, provider.__prefix || '')) return r;
        try { await r.body?.cancel?.(); } catch {}
        const backoff = RETRY_DELAY_MS * (attempt + 1) + Math.floor(Math.random() * 100);
        console.warn(`[retry] ${provider?.__prefix || '?'} status=${status} attempt=${attempt + 1}/${RETRY_ATTEMPTS} in ${backoff}ms`);
        await new Promise((wait) => setTimeout(wait, backoff));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || '');
      const isTransient = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed|other side closed/i.test(msg);
      if (attempt < RETRY_ATTEMPTS && isTransient) {
        const backoff = RETRY_DELAY_MS * (attempt + 1) + Math.floor(Math.random() * 100);
        console.warn(`[retry] ${provider?.__prefix || '?'} error="${msg.slice(0, 60)}" attempt=${attempt + 1}/${RETRY_ATTEMPTS} in ${backoff}ms`);
        await new Promise((wait) => setTimeout(wait, backoff));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('upstream failed after retries');
}


recoverRestoreTransaction();
loadProviders();
ensureCatalogProviders();

// Init SQLite storage + import legacy JSON log + load hot cache
initDb();
loadRequestLog();
purgeOldRequests();
// Nightly cleanup at 03:00 local time (rough)
setInterval(purgeOldRequests, 24 * 60 * 60 * 1000);

let g2aToken = null, g2aTokenExp = 0;
async function g2aLogin() {
  const now = Date.now();
  if (g2aToken && now < g2aTokenExp) return g2aToken;
  const r = await guardedFetch(`${G2A_BASE}/api/admin/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: G2A_USER, password: G2A_PASS }),
  }, 'provider');
  const j = await r.json();
  g2aToken = j?.data?.tokens?.accessToken;
  g2aTokenExp = now + 10 * 60 * 1000;
  if (!g2aToken) throw new Error('grok2api login failed');
  return g2aToken;
}
async function g2aFetch(path, opts = {}) {
  const tok = await g2aLogin();
  return guardedFetch(`${G2A_BASE}${path}`, {
    ...opts,
    headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  }, 'provider');
}

function isHttpsRequest(req) {
  if (req.socket && req.socket.encrypted) return true;
  const xf = TRUST_PROXY ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() : '';
  if (xf === 'https') return true;
  if (String(process.env.KIGW_FORCE_SECURE_COOKIES || '').trim() === '1') return true;
  return false;
}

function securityHeaders(req, extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  // Preserve legacy default: bare string bodies still advertise application/json unless overridden.
  const contentType = headers['Content-Type'] || 'application/json; charset=utf-8';
  const base = securityHeaders(null, { 'Content-Type': contentType });
  res.writeHead(code, { ...base, ...headers, 'Content-Type': headers['Content-Type'] || contentType });
  res.end(body);
}

function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(aa, bb); } catch { return false; }
}

function parseCookies(req) {
  const raw = req.headers['cookie'] || '';
  const out = Object.create(null);
  if (!raw) return out;
  for (const part of String(raw).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function getBearerToken(req) {
  const h = req.headers['authorization'] || '';
  return h.replace(/^Bearer\s+/i, '').trim();
}

function authOk(req) {
  const tok = getBearerToken(req);
  return !!(tok && timingSafeEqualStr(tok, GATEWAY_KEY));
}

function purgeExpiredSessions(now = Date.now()) {
  for (const [id, s] of SESSIONS) {
    if (!s || s.expiresAt <= now) SESSIONS.delete(id);
  }
}

function createSession() {
  purgeExpiredSessions();
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const sess = { id, csrf, createdAt: now, expiresAt: now + SESSION_TTL_MS, lastSeenAt: now };
  SESSIONS.set(id, sess);
  while (SESSIONS.size > MAX_ADMIN_SESSIONS) {
    const oldest = [...SESSIONS.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    if (!oldest) break;
    SESSIONS.delete(oldest.id);
  }
  return sess;
}

function getSession(req) {
  purgeExpiredSessions();
  const cookies = parseCookies(req);
  // Prefer __Host- cookie; never accept raw GATEWAY_KEY cookies/query.
  const sid = cookies[SESSION_COOKIE_HOST] || cookies[SESSION_COOKIE_BASE] || '';
  if (!sid) return null;
  const sess = SESSIONS.get(sid);
  if (!sess) return null;
  if (sess.expiresAt <= Date.now()) {
    SESSIONS.delete(sid);
    return null;
  }
  sess.lastSeenAt = Date.now();
  return sess;
}

function sessionCookieName(secure) {
  // __Host- requires Secure + Path=/ + no Domain. Use only when Secure is feasible.
  return secure ? SESSION_COOKIE_HOST : SESSION_COOKIE_BASE;
}

function buildSetCookie(name, value, { secure = false, httpOnly = true, maxAgeSec = Math.floor(SESSION_TTL_MS / 1000), clear = false } = {}) {
  const parts = [`${name}=${clear ? '' : value}`, 'Path=/', 'SameSite=Strict'];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (clear) parts.push('Max-Age=0');
  else if (maxAgeSec != null) parts.push(`Max-Age=${Math.max(0, maxAgeSec | 0)}`);
  return parts.join('; ');
}

function clearLegacyKeyCookies(secure) {
  // Always clear legacy raw-key cookies (host-only Path=/).
  return [
    buildSetCookie(LEGACY_KEY_COOKIE, '', { secure: false, httpOnly: true, clear: true }),
    buildSetCookie(LEGACY_KEY_COOKIE, '', { secure: true, httpOnly: true, clear: true }),
  ];
}

function sessionSetCookieHeaders(req, sess, { clear = false } = {}) {
  const secure = isHttpsRequest(req);
  const name = sessionCookieName(secure);
  const other = secure ? SESSION_COOKIE_BASE : SESSION_COOKIE_HOST;
  const maxAgeSec = Math.max(0, Math.floor((sess.expiresAt - Date.now()) / 1000));
  const headers = [];
  if (clear) {
    headers.push(buildSetCookie(name, '', { secure, httpOnly: true, clear: true }));
    headers.push(buildSetCookie(other, '', { secure: !secure ? false : true, httpOnly: true, clear: true }));
    headers.push(buildSetCookie(SESSION_COOKIE_BASE, '', { secure: false, httpOnly: true, clear: true }));
    headers.push(buildSetCookie(SESSION_COOKIE_HOST, '', { secure: true, httpOnly: true, clear: true }));
    headers.push(buildSetCookie(CSRF_COOKIE, '', { secure, httpOnly: false, clear: true }));
  } else {
    headers.push(buildSetCookie(name, sess.id, { secure, httpOnly: true, maxAgeSec }));
    // Clear the alternate name to avoid ambiguity across http/https transitions.
    headers.push(buildSetCookie(other, '', { secure: secure, httpOnly: true, clear: true }));
    // CSRF cookie is intentionally readable by frontend JS (double-submit helper).
    headers.push(buildSetCookie(CSRF_COOKIE, sess.csrf, { secure, httpOnly: false, maxAgeSec }));
  }
  headers.push(...clearLegacyKeyCookies(secure));
  return headers;
}

function requestHost(req) {
  const xfHost = TRUST_PROXY ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  const host = xfHost || String(req.headers.host || '').trim();
  return host.toLowerCase();
}

function originHost(origin) {
  if (!origin || origin === 'null') return '';
  try {
    const u = new URL(origin);
    return u.host.toLowerCase();
  } catch {
    return '';
  }
}

function validateOriginForSessionWrite(req) {
  // Require same-origin for browser session issuance/mutation helpers.
  const host = requestHost(req);
  if (!host) return false;
  const origin = String(req.headers.origin || '').trim();
  const referer = String(req.headers.referer || '').trim();
  if (origin) {
    const oh = originHost(origin);
    return !!oh && oh === host;
  }
  // Some clients omit Origin on same-site POST; accept matching Referer host.
  if (referer) {
    try {
      const rh = new URL(referer).host.toLowerCase();
      return rh === host;
    } catch {
      return false;
    }
  }
  // Non-browser API clients should use Bearer, not cookie session minting.
  // Allow missing Origin only when explicitly opted in (tests / local tools).
  if (String(process.env.KIGW_ALLOW_SESSION_NO_ORIGIN || '').trim() === '1') return true;
  return false;
}

function getCsrfFromRequest(req) {
  // Only accept explicit client-provided tokens (header). Do NOT trust the CSRF
  // cookie alone — browsers auto-send cookies on cross-site form posts.
  const h = req.headers['x-csrf-token'] || req.headers['x-xsrf-token'] || '';
  return String(h || '').trim();
}

function csrfOk(req, sess) {
  if (!sess) return false;
  const token = getCsrfFromRequest(req);
  // Compare against server-side session CSRF (cookie is only a delivery aid for the SPA).
  return !!(token && timingSafeEqualStr(token, sess.csrf));
}

function isStateChangingMethod(method) {
  const m = String(method || 'GET').toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

/** Dashboard cookie/session auth only — never query-string secrets or raw key cookies. */
function dashAuthOk(req, _url) {
  return !!getSession(req);
}

function appendSetCookies(headers, cookies) {
  const out = { ...headers };
  const list = Array.isArray(cookies) ? cookies : [cookies];
  if (out['Set-Cookie']) {
    const prev = out['Set-Cookie'];
    out['Set-Cookie'] = (Array.isArray(prev) ? prev : [prev]).concat(list);
  } else {
    out['Set-Cookie'] = list.length === 1 ? list[0] : list;
  }
  return out;
}

// Node's res.writeHead accepts array for Set-Cookie only via setHeader in some versions.
// Normalize multi Set-Cookie through setHeader when needed.
function sendWithCookies(res, code, obj, headers = {}, cookies = []) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const contentType = headers['Content-Type'] || 'application/json; charset=utf-8';
  const base = securityHeaders(null, { 'Content-Type': contentType });
  const finalHeaders = { ...base, ...headers, 'Content-Type': headers['Content-Type'] || contentType };
  // Use writeHead + manual setHeader for multi cookies when array.
  const cookieList = Array.isArray(cookies) ? cookies.filter(Boolean) : (cookies ? [cookies] : []);
  if (finalHeaders['Set-Cookie']) {
    const sc = finalHeaders['Set-Cookie'];
    cookieList.unshift(...(Array.isArray(sc) ? sc : [sc]));
    delete finalHeaders['Set-Cookie'];
  }
  res.statusCode = code;
  for (const [k, v] of Object.entries(finalHeaders)) res.setHeader(k, v);
  if (cookieList.length) res.setHeader('Set-Cookie', cookieList);
  res.end(body);
}

class HttpInputError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function requireJsonContentType(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && !type.endsWith('+json')) {
    throw new HttpInputError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
}
async function readBody(req, { limit = BODY_LIMITS.admin, requireJson = false } = {}) {
  if (requireJson) requireJsonContentType(req);
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > limit) throw new HttpInputError(413, 'body_too_large', `request body exceeds ${limit} bytes`);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpInputError(413, 'body_too_large', `request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function boundedString(value, name, max = 500) {
  const s = String(value ?? '');
  if (s.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return s;
}
function redactedBackup() {
  const providers = {};
  for (const [prefix, p] of Object.entries(PROVIDERS)) {
    providers[prefix] = {
      name: p.name, type: p.type, authMode: p.authMode, baseUrl: p.baseUrl,
      enabled: p.enabled !== false, models: p.models || [], proxyPoolId: p.proxyPoolId || '',
      budget: Math.max(0, Number(p.budget) || 0), budgetAction: p.budgetAction || 'alert',
      keyRedacted: !!p.key,
      keys: (p.keys || []).map((k) => ({ id: k.id, enabled: k.enabled !== false, label: k.label || '', keyRedacted: true })),
    };
  }
  const proxyPools = PROXY_POOLS.map((p) => {
    let safeUrl = p.url;
    let urlRedacted = false;
    try {
      const u = new URL(p.url);
      if (u.username || u.password) { safeUrl = null; urlRedacted = true; }
    } catch { safeUrl = null; urlRedacted = true; }
    return { id: p.id, name: p.name, url: safeUrl, urlRedacted, enabled: p.enabled !== false };
  });
  const safeStats = Object.fromEntries(Object.entries(KEY_STATS).map(([prefix, bucket]) => [prefix,
    Object.fromEntries(Object.entries(bucket || {}).map(([id, stat]) => [id, {
      spentCredit: Number(stat?.spentCredit || 0), lastCredit: Number(stat?.lastCredit || 0),
      requests: Number(stat?.requests || 0), success: Number(stat?.success || 0), failed: Number(stat?.failed || 0),
      status: String(stat?.status || 'unknown'), lastChecked: String(stat?.lastChecked || ''),
      lastModel: String(stat?.lastModel || ''), lastTokens: Number(stat?.lastTokens || 0),
      lastError: stat?.lastError ? '[redacted]' : '',
    }]))
  ]));
  return {
    version: 2, secrets: 'redacted', exportedAt: new Date().toISOString(),
    gateway: { version: GATEWAY_VERSION },
    providers: { version: 2, providers, proxyPools },
    keyStats: { version: 1, updatedAt: new Date().toISOString(), stats: safeStats },
  };
}
function validateRestoreBackup(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('backup must be an object');
  if (body.version !== 2 || body.secrets !== 'redacted') throw new Error('unsupported backup; only version 2 redacted backups are accepted');
  const section = body.providers;
  if (!section || typeof section !== 'object' || !section.providers || typeof section.providers !== 'object' || Array.isArray(section.providers)) {
    throw new Error('backup missing providers section');
  }
  const entries = Object.entries(section.providers);
  if (!entries.length) throw new Error('backup must contain at least one provider');
  if (entries.length > 100) throw new Error('backup exceeds 100 providers');
  const nextProviders = {};
  for (const [prefixRaw, raw] of entries) {
    const prefix = boundedString(prefixRaw, 'provider prefix', 64).toLowerCase();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`provider ${prefix} must be an object`);
    if ((raw.key && String(raw.key)) || raw.apiKey || raw.secret) throw new Error(`plaintext provider secrets are not accepted (${prefix})`);
    if (!Array.isArray(raw.models) || raw.models.length > 500) throw new Error(`invalid models for ${prefix}`);
    if (!Array.isArray(raw.keys) || raw.keys.length > 5000) throw new Error(`invalid keys for ${prefix}`);
    const current = PROVIDERS[prefix];
    const currentById = new Map((current?.keys || []).map((k) => [String(k.id), k]));
    const keys = raw.keys.map((item) => {
      if (!item || typeof item !== 'object' || item.key || item.apiKey || item.secret) throw new Error(`plaintext key in ${prefix} is not accepted`);
      const id = boundedString(item.id, 'key id', 128);
      const existing = currentById.get(id);
      if (!existing?.key) throw new Error(`redacted key ${prefix}/${id} is unavailable locally`);
      return { id, key: existing.key, enabled: item.enabled !== false, label: boundedString(item.label, 'key label', 200) };
    });
    const merged = {
      name: boundedString(raw.name, 'provider name', 200), type: raw.type, authMode: raw.authMode,
      baseUrl: boundedString(raw.baseUrl, 'baseUrl', 2048), enabled: raw.enabled !== false,
      models: raw.models.map((m) => ({
        id: boundedString(typeof m === 'string' ? m : m?.id, 'model id', 300),
        label: boundedString(typeof m === 'string' ? m : (m?.label || m?.id), 'model label', 300),
        ...(m?.tier ? { tier: boundedString(m.tier, 'model tier', 100) } : {}),
      })),
      keys, key: current?.key || keys[0]?.key || '',
      proxyPoolId: boundedString(raw.proxyPoolId, 'proxyPoolId', 128),
      budget: Math.max(0, Number(raw.budget) || 0), budgetAction: raw.budgetAction,
    };
    nextProviders[prefix] = normalizeProvider(prefix, merged);
  }
  const poolsRaw = section.proxyPools == null ? [] : section.proxyPools;
  if (!Array.isArray(poolsRaw) || poolsRaw.length > 1000) throw new Error('invalid proxyPools section');
  const currentPools = new Map(PROXY_POOLS.map((p) => [String(p.id), p]));
  const nextPools = poolsRaw.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('proxy pool must be an object');
    const id = boundedString(raw.id, 'proxy id', 128);
    let url = raw.url;
    if (raw.urlRedacted) url = currentPools.get(id)?.url;
    if (!url) throw new Error(`redacted proxy ${id} is unavailable locally`);
    url = normalizeNetworkUrl(boundedString(url, 'proxy URL', 4096), { kind: 'proxy', allowCredentials: true });
    return { id, name: boundedString(raw.name, 'proxy name', 200), url, enabled: raw.enabled !== false, status: 'unknown', lastTested: null, lastError: null };
  });
  const statsSection = body.keyStats;
  const nextStats = statsSection == null ? structuredClone(KEY_STATS) : {};
  if (statsSection != null) {
    if (!statsSection || typeof statsSection !== 'object' || typeof statsSection.stats !== 'object' || Array.isArray(statsSection.stats)) throw new Error('invalid keyStats section');
    if (Object.keys(statsSection.stats).length > 100) throw new Error('keyStats exceeds provider limit');
    for (const [prefixRaw, bucket] of Object.entries(statsSection.stats)) {
      const prefix = boundedString(prefixRaw, 'stats prefix', 64).toLowerCase();
      if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket) || Object.keys(bucket).length > 5000) throw new Error(`invalid keyStats for ${prefix}`);
      nextStats[prefix] = {};
      for (const [idRaw, stat] of Object.entries(bucket)) {
        const id = boundedString(idRaw, 'stats key id', 128);
        if (!stat || typeof stat !== 'object' || Array.isArray(stat)) throw new Error(`invalid key stat ${prefix}/${id}`);
        const numeric = (name) => {
          const n = Number(stat[name] || 0);
          if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) throw new Error(`invalid ${name} for ${prefix}/${id}`);
          return n;
        };
        nextStats[prefix][id] = {
          spentCredit: numeric('spentCredit'), lastCredit: numeric('lastCredit'), requests: numeric('requests'),
          success: numeric('success'), failed: numeric('failed'), lastTokens: numeric('lastTokens'),
          status: boundedString(stat.status || 'unknown', 'stats status', 32),
          lastError: stat.lastError === '[redacted]' ? '' : boundedString(stat.lastError || '', 'stats error', 300),
          lastChecked: boundedString(stat.lastChecked || '', 'stats timestamp', 64),
          lastModel: boundedString(stat.lastModel || '', 'stats model', 300),
        };
      }
    }
  }
  const cfg = {
    version: 2,
    providers: Object.fromEntries(Object.entries(nextProviders).map(([k, v]) => [k, {
      name: v.name, type: v.type, authMode: v.authMode, baseUrl: v.baseUrl, key: v.key, keys: v.keys,
      enabled: v.enabled !== false, models: v.models, proxyPoolId: v.proxyPoolId || '', budget: v.budget, budgetAction: v.budgetAction,
    }])),
    proxyPools: nextPools,
  };
  return { cfg, nextStats, providerCount: entries.length };
}

// Periodic session cleanup
setInterval(() => purgeExpiredSessions(), 5 * 60 * 1000).unref?.();

function getDashboardHtml() {
  try {
    if (existsSync(DASHBOARD_FILE)) return readFileSync(DASHBOARD_FILE, 'utf8');
  } catch {}
  return DASHBOARD_HTML_FALLBACK;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    if (path === '/health') return send(res, 200, {
      status: 'ok',
      service: 'ki-gateway',
      version: GATEWAY_VERSION,
      providers: Object.keys(PROVIDERS).filter((k) => PROVIDERS[k]?.enabled !== false),
      providerCount: Object.keys(PROVIDERS).length,
    });
    if (path === '/' || path === '/dashboard') {
      res.writeHead(200, securityHeaders(req, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      }));
      return res.end(getDashboardHtml());
    }

    // Serve static provider logos from public/providers/*
    if (path.startsWith('/providers/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const cleanRel = path.replace(/^\/providers\//, '').replace(/\.\.+/g, '');
      if (/^[a-zA-Z0-9._-]+\.(png|svg|jpg|jpeg|webp)$/.test(cleanRel)) {
        const filePath = pathResolve(__dirname, 'public', 'providers', cleanRel);
        try {
          const buf = readFileSync(filePath);
          const ext = cleanRel.split('.').pop().toLowerCase();
          const ctype = ext === 'svg' ? 'image/svg+xml'
            : ext === 'png' ? 'image/png'
            : ext === 'webp' ? 'image/webp'
            : 'image/jpeg';
          res.writeHead(200, securityHeaders(req, {
            'Content-Type': ctype,
            'Cache-Control': 'public, max-age=86400, immutable',
            'Content-Length': buf.length
          }));
          return res.end(buf);
        } catch (e) {
          return send(res, 404, { error: 'logo not found' });
        }
      }
      return send(res, 404, { error: 'invalid logo path' });
    }

    if (path.startsWith('/admin/')) {
      const bearerOk = authOk(req);
      const sess = getSession(req);
      const sessionOk = !!sess;

      // Explicitly reject query-string admin secrets and legacy raw-key cookies.
      // (Presence alone is not auth; we never accept them.)
      const qKey = url.searchParams.get('key');
      if (qKey != null && qKey !== '') {
        return send(res, 401, { error: 'query auth rejected', code: 'query_auth_rejected' });
      }
      const cookies = parseCookies(req);
      if (cookies[LEGACY_KEY_COOKIE]) {
        // Clear legacy cookie and deny if it was the only credential path.
        // Bearer/session can still proceed after clear on subsequent requests;
        // for this request, ignore the legacy cookie entirely (already ignored by getSession).
      }

      // /admin/session — mint opaque server-side session from Bearer master key
      if (path === '/admin/session' && req.method === 'POST') {
        if (!bearerOk) return send(res, 401, { error: 'unauthorized', code: 'invalid_gateway_key' });
        if (!validateOriginForSessionWrite(req)) {
          return send(res, 403, { error: 'origin validation failed', code: 'bad_origin' });
        }
        const newSess = createSession();
        const cookiesOut = sessionSetCookieHeaders(req, newSess);
        return sendWithCookies(res, 200, {
          ok: true,
          csrfToken: newSess.csrf,
          expiresAt: new Date(newSess.expiresAt).toISOString(),
          maxAgeSec: Math.floor(SESSION_TTL_MS / 1000),
        }, {}, cookiesOut);
      }

      // /admin/logout — revoke session + clear cookies (session cookie or Bearer allowed)
      if (path === '/admin/logout' && req.method === 'POST') {
        if (!bearerOk && !sessionOk) return send(res, 401, { error: 'unauthorized' });
        if (sessionOk && !bearerOk) {
          // Session-authenticated logout requires CSRF to prevent forced logout CSRF.
          if (!csrfOk(req, sess)) return send(res, 403, { error: 'csrf validation failed', code: 'csrf' });
          if (!validateOriginForSessionWrite(req)) {
            return send(res, 403, { error: 'origin validation failed', code: 'bad_origin' });
          }
        }
        if (sess) SESSIONS.delete(sess.id);
        const dummy = sess || { id: '', csrf: '', expiresAt: Date.now() };
        const cookiesOut = sessionSetCookieHeaders(req, dummy, { clear: true });
        return sendWithCookies(res, 200, { ok: true }, {}, cookiesOut);
      }

      if (!bearerOk && !sessionOk) {
        // Also clear legacy raw key cookie if present (defense in depth)
        if (cookies[LEGACY_KEY_COOKIE]) {
          return sendWithCookies(res, 401, { error: 'unauthorized', code: 'legacy_cookie_rejected' }, {}, clearLegacyKeyCookies(isHttpsRequest(req)));
        }
        return send(res, 401, { error: 'unauthorized' });
      }

      // CSRF for state-changing admin methods when authenticated via session only.
      // Bearer API/admin clients remain usable without CSRF.
      if (sessionOk && !bearerOk && isStateChangingMethod(req.method)) {
        if (!validateOriginForSessionWrite(req)) {
          return send(res, 403, { error: 'origin validation failed', code: 'bad_origin' });
        }
        if (!csrfOk(req, sess)) {
          return send(res, 403, { error: 'csrf validation failed', code: 'csrf' });
        }
      }

      // ---- multi-provider management ----
      if (path === '/admin/providers' && req.method === 'GET') {
        return send(res, 200, { items: listProvidersPublic(true) });
      }
      if (path === '/admin/providers' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const prefix = String(p.prefix || '').trim().toLowerCase();
        if (!prefix) return send(res, 400, { error: 'prefix required' });
        const existing = PROVIDERS[prefix];
        try { await assertPublicDestination(p.baseUrl ?? existing?.baseUrl ?? '', 'provider'); }
        catch (e) { return send(res, 400, { error: e.message, code: 'network_policy' }); }
        // keep key if blank on update
        const key = (p.key !== undefined && String(p.key).trim() !== '')
          ? String(p.key).trim()
          : (existing?.key || '');
        try {
          // bulk keys from form: p.keys (array) or p.bulkKeys (string/array)
          let incomingKeys = existing?.keys ? existing.keys.slice() : [];
          if (Array.isArray(p.keys)) {
            // replace/merge mode: if replaceKeys true, replace all
            if (p.replaceKeys) incomingKeys = [];
            for (const item of p.keys) {
              const kk = typeof item === 'string' ? item.trim() : String(item?.key || item?.apiKey || '').trim();
              if (!kk) continue;
              if (incomingKeys.some((x) => x.key === kk)) continue;
              incomingKeys.push({
                id: crypto.randomUUID().slice(0, 8),
                key: kk,
                enabled: true,
                label: typeof item === 'object' ? String(item.label || item.name || '') : '',
              });
            }
          }
          if (p.bulkKeys) {
            const lines = Array.isArray(p.bulkKeys) ? p.bulkKeys : String(p.bulkKeys).split(/\r?\n/);
            for (const line of lines) {
              const kk = String(line || '').trim();
              if (!kk || kk.startsWith('#')) continue;
              if (incomingKeys.some((x) => x.key === kk)) continue;
              incomingKeys.push({ id: crypto.randomUUID().slice(0, 8), key: kk, enabled: true, label: '' });
            }
          }
          if (key && !incomingKeys.some((x) => x.key === key)) {
            incomingKeys.unshift({ id: crypto.randomUUID().slice(0, 8), key, enabled: true, label: 'primary' });
          }
          const norm = normalizeProvider(prefix, {
            name: p.name ?? existing?.name,
            type: p.type ?? existing?.type ?? 'openai',
            authMode: p.authMode ?? existing?.authMode ?? 'api-key',
            baseUrl: p.baseUrl ?? existing?.baseUrl,
            key: key || existing?.key || '',
            keys: incomingKeys,
            enabled: p.enabled !== undefined ? !!p.enabled : (existing ? existing.enabled !== false : true),
            models: p.models ?? existing?.models,
            budget: p.budget ?? existing?.budget,
            budgetAction: p.budgetAction ?? existing?.budgetAction,
            proxyPoolId: p.proxyPoolId ?? existing?.proxyPoolId,
          });
          if (!norm.key && prefix !== 'local') {
            // allow empty key but warn via response flag
          }
          PROVIDERS[prefix] = norm;
          persistProviders();
          return send(res, 200, { ok: true, provider: listProvidersPublic(true).find((x) => x.prefix === prefix) });
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      if (path === '/admin/providers/delete' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const prefix = String(p.prefix || '').trim().toLowerCase();
        if (!prefix) return send(res, 400, { error: 'prefix required' });
        if (prefix === 'grok') return send(res, 400, { error: 'cannot delete default provider grok' });
        if (!PROVIDERS[prefix]) return send(res, 404, { error: 'provider not found' });
        delete PROVIDERS[prefix];
        persistProviders();
        return send(res, 200, { ok: true, deleted: prefix });
      }
      if (path === '/admin/providers/toggle' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const prefix = String(p.prefix || '').trim().toLowerCase();
        if (!PROVIDERS[prefix]) return send(res, 404, { error: 'provider not found' });
        PROVIDERS[prefix].enabled = !!p.enabled;
        persistProviders();
        return send(res, 200, { ok: true, prefix, enabled: PROVIDERS[prefix].enabled });
      }
      if (path === '/admin/providers/reload' && req.method === 'POST') {
        loadProviders();
        return send(res, 200, { ok: true, items: listProvidersPublic(true) });
      }

      if (path === '/admin/providers/test' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const prefix = String(p.prefix || '').trim().toLowerCase();
        if (!prefix) return send(res, 400, { error: 'prefix required', ok: false });
        let provider = PROVIDERS[prefix];
        if (!provider || p.baseUrl || p.key || p.type) {
          try {
            const draft = normalizeProvider(prefix, {
              name: p.name || provider?.name || prefix,
              type: p.type || provider?.type || 'openai',
              authMode: p.authMode || provider?.authMode || 'api-key',
              baseUrl: p.baseUrl || provider?.baseUrl || '',
              key: (p.key && String(p.key).trim()) || provider?.key || '',
              keys: provider?.keys || [],
              enabled: true,
              models: p.models || provider?.models || [{ id: 'test', label: 'test' }],
            });
            if (provider && p.key && !p.baseUrl) {
              draft.baseUrl = provider.baseUrl;
              draft.type = provider.type || draft.type;
              draft.models = provider.models || draft.models;
              draft.keys = [{ id: 'tmp', key: String(p.key).trim(), enabled: true, label: 'test' }];
              draft.key = String(p.key).trim();
            } else if (p.key) {
              draft.keys = [{ id: 'tmp', key: String(p.key).trim(), enabled: true, label: 'test' }];
              draft.key = String(p.key).trim();
            }
            provider = draft;
          } catch (e) {
            return send(res, 400, { error: e.message, ok: false });
          }
        }
        if (!provider) return send(res, 404, { error: 'provider not found', ok: false });
        try { await assertPublicDestination(provider.baseUrl, 'provider'); }
        catch (e) { return send(res, 400, { error: e.message, code: 'network_policy', ok: false }); }
        let key = (p.key && String(p.key).trim()) || '';
        if (!key && p.keyId && Array.isArray(provider.keys)) {
          const found = provider.keys.find((k) => String(k.id) === String(p.keyId));
          if (found && found.key) key = found.key;
        }
        if (!key) key = pickProviderKey(provider, prefix);
        if (!key) return send(res, 400, { error: 'no api key to test', ok: false });
        const testProv = { ...provider, key, keys: [{ id: 't', key, enabled: true, label: 'test' }] };
        let model = String(p.model || '').trim();
        if (!model) model = (provider.models && provider.models[0] && provider.models[0].id) || '';
        if (!model) return send(res, 400, { error: 'no model to test', ok: false });
        const payload = {
          model,
          messages: [{ role: 'user', content: p.prompt || 'Reply with exactly: OK' }],
          max_tokens: p.max_tokens || 20,
          stream: false,
        };
        const t0 = Date.now();
        try {
          const up = await callProviderChat(testProv, model, payload, { forceNonStream: true });
          const latencyMs = Date.now() - t0;
          if (isCodebuddyProvider(testProv)) {
            if (!up.ok) {
              const errTxt = await up.text();
              if (p.keyId || provider.__lastKeyId) {
                recordProviderKeyUsage(prefix, String(p.keyId || provider.__lastKeyId), {
                  incRequest: true, incFailed: true, 
                  status: isCreditsExhaustedError(up.status, errTxt) ? 'exhausted' : 'error',
                  lastError: sanitizeErrorText(errTxt, 300), lastModel: model,
                });
              }
              return send(res, 200, { ok: false, status: up.status, error: sanitizeErrorText(errTxt, 800), latencyMs, model, prefix });
            }
            const txt = await up.text();
            const j = aggregateCodebuddySse(txt, model);
            const reply = j?.choices?.[0]?.message?.content || '';
            const credit = extractCreditFromUsage(j?.usage);
            if (p.keyId || provider.__lastKeyId) {
              recordProviderKeyUsage(prefix, String(p.keyId || provider.__lastKeyId), {
                incRequest: true, incSuccess: true, status: 'active', lastError: '', lastModel: model, credit, tokens: j?.usage?.total_tokens,
              });
            }
            return send(res, 200, { ok: true, valid: true, reply, usage: j?.usage || null, credit, latencyMs, model, prefix, type: 'codebuddy', keyId: p.keyId || provider.__lastKeyId || null });
          }
          const txt = await up.text();
          let j;
          try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
          if (!up.ok) {
            return send(res, 200, { ok: false, status: up.status, error: j?.error?.message || j?.error || j?.raw || j, latencyMs, model, prefix });
          }
          return send(res, 200, {
            ok: true,
            reply: j?.choices?.[0]?.message?.content || String(txt).slice(0, 300),
            usage: j?.usage || null,
            latencyMs,
            model,
            prefix,
            type: testProv.type || 'openai',
          });
        } catch (e) {
          return send(res, 200, { ok: false, error: e.message, latencyMs: Date.now() - t0, prefix, model });
        }
      }

      if (path === '/admin/providers/keys' && req.method === 'POST') {
        // bulk/single add keys to existing provider (or create-lite)
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const prefix = String(p.prefix || '').trim().toLowerCase();
        if (!prefix) return send(res, 400, { error: 'prefix required' });
        if (!PROVIDERS[prefix]) return send(res, 404, { error: 'provider not found — create provider dulu' });
        const lines = [];
        if (p.key) lines.push(String(p.key));
        if (Array.isArray(p.keys)) lines.push(...p.keys.map(String));
        if (p.bulkKeys) lines.push(...String(p.bulkKeys).split(/\r?\n/));
        let added = 0, skipped = 0;
        const prov = PROVIDERS[prefix];
        prov.keys = prov.keys || [];
        for (const line of lines) {
          const kk = String(line || '').trim();
          if (!kk || kk.startsWith('#')) continue;
          if (prov.keys.some((x) => x.key === kk)) { skipped += 1; continue; }
          prov.keys.push({ id: crypto.randomUUID().slice(0, 8), key: kk, enabled: true, label: p.label || '' });
          added += 1;
        }
        if (!prov.key && prov.keys.length) prov.key = prov.keys[0].key;
        persistProviders();
        return send(res, 200, { ok: true, prefix, added, skipped, keyCount: prov.keys.length, provider: listProvidersPublic(true).find((x) => x.prefix === prefix) });
      }
      if (path === '/admin/providers/keys/delete' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const prefix = String(p.prefix || '').trim().toLowerCase();
        const id = String(p.id || '').trim();
        if (!PROVIDERS[prefix]) return send(res, 404, { error: 'provider not found' });
        const before = (PROVIDERS[prefix].keys || []).length;
        PROVIDERS[prefix].keys = (PROVIDERS[prefix].keys || []).filter((k) => k.id !== id);
        if (PROVIDERS[prefix].key && !(PROVIDERS[prefix].keys || []).some((k) => k.key === PROVIDERS[prefix].key)) {
          PROVIDERS[prefix].key = PROVIDERS[prefix].keys[0]?.key || '';
        }
        persistProviders();
        return send(res, 200, { ok: true, deleted: before - PROVIDERS[prefix].keys.length, keyCount: PROVIDERS[prefix].keys.length });
      }
      if (path === '/admin/providers/keys/toggle' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const prefix = String(p.prefix || '').trim().toLowerCase();
        const id = String(p.id || '').trim();
        const k = (PROVIDERS[prefix]?.keys || []).find((x) => x.id === id);
        if (!k) return send(res, 404, { error: 'key not found' });
        k.enabled = !!p.enabled;
        persistProviders();
        return send(res, 200, { ok: true, id, enabled: k.enabled });
      }
      // Bulk delete provider keys by array of key ids grouped by prefix
      // Body: { items: [{prefix, id}, ...] }  OR  { prefix, ids: [id1, id2, ...] }
      if (path === '/admin/providers/keys/bulk-delete' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const items = Array.isArray(p.items) ? p.items : [];
        const prefix = String(p.prefix || '').trim().toLowerCase();
        const ids = Array.isArray(p.ids) ? p.ids.map(String) : [];
        let deleted = 0, failed = 0;
        const byPrefix = {};
        for (const it of items) {
          const pfx = String(it.prefix || '').trim().toLowerCase();
          const kid = String(it.id || '').trim();
          if (!pfx || !kid) { failed++; continue; }
          if (!byPrefix[pfx]) byPrefix[pfx] = [];
          byPrefix[pfx].push(kid);
        }
        if (prefix && ids.length) byPrefix[prefix] = (byPrefix[prefix] || []).concat(ids);
        for (const [pfx, kids] of Object.entries(byPrefix)) {
          const prov = PROVIDERS[pfx];
          if (!prov) { failed += kids.length; continue; }
          const before = (prov.keys || []).length;
          const kidSet = new Set(kids);
          prov.keys = (prov.keys || []).filter((k) => !kidSet.has(k.id));
          const removed = before - prov.keys.length;
          deleted += removed;
          failed += (kids.length - removed);
          if (prov.key && !prov.keys.some((k) => k.key === prov.key)) {
            prov.key = prov.keys[0]?.key || '';
          }
        }
        persistProviders();
        return send(res, 200, { ok: true, deleted, failed });
      }
      // Bulk toggle enabled/disabled
      // Body: { items: [{prefix, id}, ...], enabled: bool }  OR  { prefix, ids: [...], enabled: bool }
      if (path === '/admin/providers/keys/bulk-toggle' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const enabled = !!p.enabled;
        const items = Array.isArray(p.items) ? p.items : [];
        const prefix = String(p.prefix || '').trim().toLowerCase();
        const ids = Array.isArray(p.ids) ? p.ids.map(String) : [];
        let updated = 0, failed = 0;
        const byPrefix = {};
        for (const it of items) {
          const pfx = String(it.prefix || '').trim().toLowerCase();
          const kid = String(it.id || '').trim();
          if (!pfx || !kid) { failed++; continue; }
          if (!byPrefix[pfx]) byPrefix[pfx] = [];
          byPrefix[pfx].push(kid);
        }
        if (prefix && ids.length) byPrefix[prefix] = (byPrefix[prefix] || []).concat(ids);
        for (const [pfx, kids] of Object.entries(byPrefix)) {
          const prov = PROVIDERS[pfx];
          if (!prov) { failed += kids.length; continue; }
          const kidSet = new Set(kids);
          for (const k of (prov.keys || [])) {
            if (kidSet.has(k.id)) { k.enabled = enabled; updated++; }
          }
        }
        persistProviders();
        return send(res, 200, { ok: true, updated, failed, enabled });
      }
      // Bulk reset stats (clear failed count, mark as unknown so router retries)
      // Body: { items: [{prefix, id}, ...] }  OR  { prefix, ids: [...] }
      if (path === '/admin/providers/keys/bulk-reset' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const items = Array.isArray(p.items) ? p.items : [];
        const prefix = String(p.prefix || '').trim().toLowerCase();
        const ids = Array.isArray(p.ids) ? p.ids.map(String) : [];
        let reset = 0, failed = 0;
        const byPrefix = {};
        for (const it of items) {
          const pfx = String(it.prefix || '').trim().toLowerCase();
          const kid = String(it.id || '').trim();
          if (!pfx || !kid) { failed++; continue; }
          if (!byPrefix[pfx]) byPrefix[pfx] = [];
          byPrefix[pfx].push(kid);
        }
        if (prefix && ids.length) byPrefix[prefix] = (byPrefix[prefix] || []).concat(ids);
        for (const [pfx, kids] of Object.entries(byPrefix)) {
          const kidSet = new Set(kids);
          for (const kid of kids) {
            try {
              const bucket = KEY_STATS[pfx];
              if (bucket && bucket[kid]) {
                bucket[kid].failed = 0;
                bucket[kid].status = 'unknown';
                bucket[kid].lastError = '';
                bucket[kid].cooldownUntil = 0;
              }
              reset++;
            } catch (e) { failed++; }
          }
        }
        try { if (typeof saveKeyStats === 'function') saveKeyStats(); } catch {}
        return send(res, 200, { ok: true, reset, failed });
      }

      // ============ PROXY POOL ENDPOINTS (global, 9router-style) ============
      if (path === '/admin/proxy-pools' && req.method === 'GET') {
        return send(res, 200, {
          items: PROXY_POOLS.map(p => ({
            id: p.id, name: p.name, url: maskProxyUrl(p.url),
            hasCredentials: (() => { try { const u = new URL(p.url); return !!(u.username || u.password); } catch { return false; } })(), enabled: p.enabled !== false,
            status: p.status || 'unknown', lastTested: p.lastTested || null,
            lastError: p.lastError ? sanitizeErrorText(p.lastError, 200) : null,
            usedBy: Object.entries(PROVIDERS)
              .filter(([_, v]) => v.proxyPoolId === p.id)
              .map(([k, v]) => ({ prefix: k, name: v.name })),
          })),
        });
      }
      if (path === '/admin/proxy-pools' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const urls = [];
        if (p.url) urls.push(String(p.url).trim());
        if (Array.isArray(p.urls)) urls.push(...p.urls.map(u => String(u).trim()));
        if (p.bulkUrls) urls.push(...String(p.bulkUrls).split(/\r?\n/).map(s => s.trim()).filter(Boolean));
        let added = 0, skipped = 0, errors = [];
        for (const url of urls) {
          if (!url || url.startsWith('#')) continue;
          try {
            const normalizedUrl = normalizeNetworkUrl(url, { kind: 'proxy', allowCredentials: true });
            await assertPublicDestination(normalizedUrl, 'proxy');
            if (PROXY_POOLS.some(x => x.url === normalizedUrl)) { skipped++; continue; }
            const id = crypto.randomUUID().slice(0, 8);
            const name = p.name || `Proxy ${new URL(normalizedUrl).hostname}:${new URL(normalizedUrl).port || ''}`;
            PROXY_POOLS.push({
              id, name, url: normalizedUrl, enabled: true, status: 'unknown',
              lastTested: null, lastError: null,
            });
            added++;
          } catch (e) { errors.push(maskProxyUrl(url) + ': ' + sanitizeErrorText(e.message, 200)); }
        }
        persistProviders();
        return send(res, 200, { ok: true, added, skipped, errors, total: PROXY_POOLS.length });
      }
      if (path === '/admin/proxy-pools/delete' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const ids = Array.isArray(p.ids) ? p.ids.map(String) : (p.id ? [String(p.id)] : []);
        const idSet = new Set(ids);
        const removedUrls = PROXY_POOLS.filter(x => idSet.has(x.id)).map(x => x.url);
        const before = PROXY_POOLS.length;
        PROXY_POOLS = PROXY_POOLS.filter(x => !idSet.has(x.id));
        const deleted = before - PROXY_POOLS.length;
        // Clear proxyPoolId from providers using deleted pools
        for (const v of Object.values(PROVIDERS)) {
          if (v.proxyPoolId && idSet.has(v.proxyPoolId)) v.proxyPoolId = '';
        }
        // Cleanup dispatcher cache for removed pools.
        for (const url of removedUrls) invalidateDispatcher(url);
        persistProviders();
        return send(res, 200, { ok: true, deleted });
      }
      if (path === '/admin/proxy-pools/toggle' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const pool = PROXY_POOLS.find(x => x.id === String(p.id || '').trim());
        if (!pool) return send(res, 404, { error: 'pool not found' });
        pool.enabled = !!p.enabled;
        if (!pool.enabled) invalidateDispatcher(pool.url);
        persistProviders();
        return send(res, 200, { ok: true, id: pool.id, enabled: pool.enabled });
      }
      if (path === '/admin/proxy-pools/test' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const ids = Array.isArray(p.ids) ? p.ids.map(String) : (p.id ? [String(p.id)] : PROXY_POOLS.map(x => x.id));
        const results = [];
        for (const id of ids) {
          const pool = PROXY_POOLS.find(x => x.id === id);
          if (!pool) { results.push({ id, ok: false, error: 'not found' }); continue; }
          try {
            await assertPublicDestination(pool.url, 'proxy');
            const dispatcher = new ProxyAgent({ uri: pool.url });
            const t0 = Date.now();
            const r = await undiciFetch('https://api.ipify.org?format=json', {
              dispatcher, signal: AbortSignal.timeout(8000),
            });
            const latency = Date.now() - t0;
            const j = await r.json();
            try { dispatcher.close(); } catch {}
            pool.status = 'active'; pool.lastTested = new Date().toISOString();
            pool.lastError = null; pool.exitIp = j.ip || null; pool.latencyMs = latency;
            results.push({ id, ok: true, ip: j.ip, latencyMs: latency });
          } catch (e) {
            const safeError = sanitizeErrorText(e.message, 300);
            pool.status = 'error'; pool.lastTested = new Date().toISOString();
            pool.lastError = safeError;
            results.push({ id, ok: false, error: safeError });
          }
        }
        persistProviders();
        return send(res, 200, { ok: true, results });
      }
      // Set proxy pool for a provider (link provider → pool)
      if (path === '/admin/providers/proxy' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const prefix = String(p.prefix || '').trim().toLowerCase();
        const poolId = p.proxyPoolId ? String(p.proxyPoolId).trim() : '';
        if (!PROVIDERS[prefix]) return send(res, 404, { error: 'provider not found' });
        // Special value '__all__' = rotate all pools
        if (poolId && poolId !== '__all__' && !PROXY_POOLS.find(x => x.id === poolId)) {
          return send(res, 404, { error: 'proxy pool not found' });
        }
        PROVIDERS[prefix].proxyPoolId = poolId;
        // Reset round-robin counter when changing mode
        PROVIDERS[prefix].__proxyRr = 0;
        persistProviders();
        const selectedPool = poolId && poolId !== '__all__' ? PROXY_POOLS.find(x => x.id === poolId) : null;
        return send(res, 200, {
          ok: true, prefix, proxyPoolId: poolId,
          pool: poolId === '__all__'
            ? { id: '__all__', name: 'All Pools (rotate)', mode: 'rotate' }
            : selectedPool ? { id: selectedPool.id, name: selectedPool.name, enabled: selectedPool.enabled !== false, status: selectedPool.status || 'unknown' } : null,
        });
      }

      if (path === '/admin/summary') {
        // Grok-centric stats (accounts/egress/usage) still from grok2api when available.
        // Providers list always from local multi-provider registry.
        let accounts = { total: 0, web: 0, build: 0, active: 0, errors: 0 };
        let egress = { total: 0, healthy: 0, items: [] };
        let dashboard = {};
        let models = [];
        let clientKeys = [];
        try {
          const [accR1, egR, dashR, modR, keyR] = await Promise.all([
            g2aFetch('/api/admin/v1/accounts?pageSize=100&page=1'), g2aFetch('/api/admin/v1/egress-nodes'),
            g2aFetch('/api/admin/v1/dashboard'), g2aFetch('/api/admin/v1/models'), g2aFetch('/api/admin/v1/client-keys'),
          ]);
          const acc1 = await accR1.json(), eg = await egR.json(), dash = await dashR.json(), mod = await modR.json(), key = await keyR.json();
          let accItems = acc1?.data?.items || [];
          const accTotal = acc1?.data?.total || accItems.length;
          const accPages = Math.ceil(accTotal / 100) || 1;
          for (let pg = 2; pg <= accPages; pg++) {
            const rp = await g2aFetch(`/api/admin/v1/accounts?pageSize=100&page=${pg}`); const jp = await rp.json();
            accItems = accItems.concat(jp?.data?.items || []);
          }
          const items = accItems;
          const dashData = dash?.data || {};
          const totalAccounts = dashData?.resources?.totalAccounts || items.length;
          const activeAccounts = dashData?.resources?.activeAccounts || items.filter(a => a.authStatus === 'active').length;
          const web = items.filter(a => a.provider === 'grok_web'), build = items.filter(a => a.provider === 'grok_build');
          const errorAccs = items.filter(a => a.authStatus === 'error' || a.failureCount > 0);
          const egItems = eg?.data?.items || [], modItems = mod?.data?.items || [];
          const keyItems = (key?.data?.items || (Array.isArray(key?.data) ? key.data : []));
          accounts = { total: totalAccounts, web: web.length, build: build.length, active: activeAccounts, errors: errorAccs.length };
          egress = { total: egItems.length, healthy: egItems.filter(n => (n.health || 0) >= 0.9).length, items: egItems.map(n => ({ id: n.id, name: n.name, health: n.health, failures: n.failureCount || 0, enabled: n.enabled })) };
          dashboard = dash?.data || {};
          models = modItems.map(m => ({ id: m.publicId, provider: m.provider, enabled: m.enabled, available: m.available, accounts: m.totalAccounts || 0 }));
          clientKeys = keyItems.map(k => ({ id: k.id, name: k.name, enabled: k.enabled, lastUsedAt: k.lastUsedAt || '' }));
        } catch (e) {
          // grok2api down: still serve gateway providers
          console.error('[summary] grok2api stats failed:', e.message);
        }
        return send(res, 200, {
          providers: listProvidersPublic(true),
          accounts,
          egress,
          dashboard,
          models,
          clientKeys,
          gateway: { version: GATEWAY_VERSION, providerCount: Object.keys(PROVIDERS).length },
        });
      }
      if (path === '/admin/accounts') {
        const r1 = await g2aFetch('/api/admin/v1/accounts?pageSize=100&page=1'); const j1 = await r1.json();
        let allAccs = (j1?.data?.items || []);
        const totalAccs = j1?.data?.total || allAccs.length;
        const numPages = Math.ceil(totalAccs / 100) || 1;
        for (let pg = 2; pg <= numPages; pg++) {
          const rp = await g2aFetch(`/api/admin/v1/accounts?pageSize=100&page=${pg}`); const jp = await rp.json();
          allAccs = allAccs.concat(jp?.data?.items || []);
        }
        const items = allAccs.map(a => {
          const q = a.quota || {}, b = a.billing || {};
          return { id: a.id, name: a.name, email: a.email || '', provider: a.provider, authType: a.authType, authStatus: a.authStatus, enabled: a.enabled, failureCount: a.failureCount || 0, lastError: a.lastError || '', lastUsedAt: a.lastUsedAt || '', refreshFailureCount: a.refreshFailureCount || 0, observedModel: a.observedModel || '', linkedAccountId: a.linkedAccountId || null, linkedProvider: a.linkedProvider || null, linkedAccountName: a.linkedAccountName || '', quota: { used: q.used, limit: q.limit, remaining: q.remaining, usagePercent: q.usagePercent, type: q.type || '', status: q.status || '' }, billing: { used: b.used, remaining: b.remaining, creditUsagePercent: b.creditUsagePercent || 0, monthlyLimit: b.monthlyLimit || 0 }, quotaWindows: (a.quotaWindows || []).map(w => ({ mode: w.mode, remaining: w.remaining, total: w.total, usagePercent: w.usagePercent, resetAt: w.resetAt })) };
        });
        return send(res, 200, { items });
      }
      if (path === '/admin/accounts/purge' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true });
        let p = {};
        try { if (raw) p = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const dryRun = !!p.dryRun;
        const allAccs = [];
        for (const prov of ['grok_build', 'grok_console', 'grok_web']) {
          let page = 1;
          while (true) {
            const r = await g2aFetch(`/api/admin/v1/accounts?page=${page}&pageSize=100&provider=${prov}`);
            const j = await r.json();
            const items = j?.data?.items || [];
            if (!items.length) break;
            allAccs.push(...items);
            page += 1;
            if (page > 200) break;
          }
        }
        const isBad = (a) => {
          const auth = a.authStatus || '';
          const fc = a.failureCount || 0;
          const qs = (a.quota && a.quota.status) || '';
          if (auth === 'reauthRequired' || auth === 'error' || auth === 'banned') return true;
          if (qs === 'exhausted') return true;
          if (fc > 5) return true;
          if (a.provider === 'grok_web' && Array.isArray(a.quotaWindows) && a.quotaWindows.length) {
            if (!a.quotaWindows.some((w) => (w.remaining || 0) > 0)) return true;
          }
          return false;
        };
        const bad = allAccs.filter(isBad);
        const breakdown = {
          reauth: bad.filter((a) => a.authStatus === 'reauthRequired' || a.authStatus === 'banned').length,
          error: bad.filter((a) => a.authStatus === 'error' || (a.failureCount || 0) > 5).length,
          exhausted: bad.filter((a) => ((a.quota && a.quota.status) === 'exhausted') || (a.provider === 'grok_web' && Array.isArray(a.quotaWindows) && a.quotaWindows.length && !a.quotaWindows.some((w) => (w.remaining || 0) > 0))).length,
          build: bad.filter((a) => a.provider === 'grok_build').length,
          web: bad.filter((a) => a.provider === 'grok_web').length,
          console: bad.filter((a) => a.provider === 'grok_console').length,
        };
        if (dryRun) {
          const badBuildIds = new Set(bad.filter((a) => a.provider === 'grok_build').map((a) => String(a.id)));
          const badIds = new Set(bad.map((a) => String(a.id)));
          const cascadePreview = allAccs.filter((a) => (
            a.provider === 'grok_web' &&
            a.linkedProvider === 'grok_build' &&
            a.linkedAccountId != null &&
            badBuildIds.has(String(a.linkedAccountId)) &&
            !badIds.has(String(a.id))
          ));
          return send(res, 200, {
            dryRun: true,
            total: bad.length,
            cascadeTotal: cascadePreview.length,
            breakdown,
            sample: bad.slice(0, 10).map((a) => ({ id: a.id, email: a.email || a.name || '', provider: a.provider, authStatus: a.authStatus, failureCount: a.failureCount || 0 })),
            cascadeSample: cascadePreview.slice(0, 10).map((a) => ({ id: a.id, email: a.email || a.name || '', provider: a.provider, linkedTo: a.linkedAccountId })),
          });
        }
        // Cascade: for each grok_build we're about to delete, find grok_web
        // accounts whose linkedAccountId points at it and delete them too, so
        // orphaned web accounts don't drift back into the "pending convert"
        // list and fail on re-convert.
        const badBuildIds = new Set(bad.filter((a) => a.provider === 'grok_build').map((a) => String(a.id)));
        const badIds = new Set(bad.map((a) => String(a.id)));
        const cascadeWeb = allAccs.filter((a) => (
          a.provider === 'grok_web' &&
          a.linkedProvider === 'grok_build' &&
          a.linkedAccountId != null &&
          badBuildIds.has(String(a.linkedAccountId)) &&
          !badIds.has(String(a.id))
        ));
        let purged = 0, failed = 0, cascaded = 0, cascadeFailed = 0;
        const results = [];
        for (const a of bad) {
          try {
            const r = await g2aFetch(`/api/admin/v1/accounts/${a.id}`, { method: 'DELETE' });
            const ok = r.status < 400;
            if (ok) purged += 1; else failed += 1;
            results.push({ id: a.id, ok });
          } catch (e) {
            failed += 1;
            results.push({ id: a.id, ok: false, error: e.message });
          }
        }
        for (const a of cascadeWeb) {
          try {
            const r = await g2aFetch(`/api/admin/v1/accounts/${a.id}`, { method: 'DELETE' });
            const ok = r.status < 400;
            if (ok) cascaded += 1; else cascadeFailed += 1;
            results.push({ id: a.id, ok, cascade: true, linkedTo: a.linkedAccountId });
          } catch (e) {
            cascadeFailed += 1;
            results.push({ id: a.id, ok: false, cascade: true, linkedTo: a.linkedAccountId, error: e.message });
          }
        }
        return send(res, 200, { dryRun: false, purged, failed, cascaded, cascadeFailed, total: bad.length, cascadeTotal: cascadeWeb.length, breakdown, results });
      }

      if (path === '/admin/egress' && req.method === 'GET') {
        const r = await g2aFetch('/api/admin/v1/egress-nodes'); const j = await r.json();
        const items = (j?.data?.items || j?.data || []).map(n => ({ id: n.id, name: n.name, scope: n.scope, enabled: n.enabled, proxyConfigured: n.proxyConfigured, health: n.health, failureCount: n.failureCount || 0 }));
        return send(res, 200, { items });
      }
      if (path === '/admin/egress/add' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p; try { p = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const proxies = (p.proxies || []).filter(x => x && String(x).trim());
        let scopes = [];
        if (Array.isArray(p.scopes) && p.scopes.length) scopes = p.scopes.map(s => String(s));
        else if (p.scope === 'all' || p.scope === '*') scopes = ['grok_build', 'grok_web', 'grok_console', 'grok_web_asset'];
        else scopes = [p.scope || 'grok_web'];
        const results = [];
        for (const scope of scopes) {
          for (let i = 0; i < proxies.length; i++) {
            const px = String(proxies[i]).trim();
            const base = p.namePrefix || 'proxy';
            const name = scopes.length > 1
              ? `${base}-${String(scope).replace(/^grok_/, '')}-${i + 1}`
              : `${base}-${i + 1}`;
            try {
              const r = await g2aFetch('/api/admin/v1/egress-nodes', { method: 'POST', body: JSON.stringify({ name, scope, proxyUrl: px }) });
              const j = await r.json();
              results.push({ proxy: px, name, scope, ok: r.status < 400, id: j?.data?.id || null, error: j?.error?.message || '' });
            } catch (e) {
              results.push({ proxy: px, name, scope, ok: false, error: e.message });
            }
          }
        }
        return send(res, 200, { added: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, scopes, results });
      }
      if (path === '/admin/egress/delete' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p; try { p = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const ids = p.ids || []; const results = [];
        for (const id of ids) { try { const r = await g2aFetch(`/api/admin/v1/egress-nodes/${id}`, { method: 'DELETE' }); results.push({ id, ok: r.status < 400 }); } catch (e) { results.push({ id, ok: false, error: e.message }); } }
        return send(res, 200, { deleted: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
      }
      if (path === '/admin/egress/toggle' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p; try { p = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const r = await g2aFetch(`/api/admin/v1/egress-nodes/${p.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !!p.enabled }) });
        return send(res, r.status, await r.text());
      }
      if (path === '/admin/device/start' && req.method === 'POST') { const r = await g2aFetch('/api/admin/v1/accounts/device/start', { method: 'POST' }); const j = await r.json(); return send(res, r.status, j?.data || j); }
      if (path.startsWith('/admin/device/poll/') && req.method === 'POST') { const id = path.split('/').pop(); const r = await g2aFetch(`/api/admin/v1/accounts/device/${id}/poll`, { method: 'POST' }); return send(res, r.status, await r.text()); }
      if (path === '/admin/convert' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true });
        const r = await g2aFetch('/api/admin/v1/accounts/web/convert-to-build', { method: 'POST', headers: { 'Accept': 'text/event-stream', 'Content-Type': 'application/json' }, body: raw });
        const txt = await r.text();
        let final = null;
        for (const line of txt.split('\n')) {
          const s = line.trim();
          if (s.startsWith('data:')) { try { const d = JSON.parse(s.slice(5).trim()); if (d && (d.created !== undefined || d.failed !== undefined)) final = d; } catch (e) {} }
        }
        if (final) return send(res, 200, final);
        try { return send(res, r.status, JSON.parse(txt)); } catch { return send(res, r.status, { raw: txt.slice(-400) }); }
      }
      if (path === '/admin/accounts/delete' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p; try { p = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const ids = p.ids || []; const results = [];
        for (const id of ids) { try { const r = await g2aFetch(`/api/admin/v1/accounts/${id}`, { method: 'DELETE' }); results.push({ id, ok: r.status < 400 }); } catch (e) { results.push({ id, ok: false, error: e.message }); } }
        return send(res, 200, { deleted: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
      }
      if (path === '/admin/accounts/refresh-token' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p; try { p = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const ids = p.ids || []; const results = [];
        for (const id of ids) { try { const r = await g2aFetch(`/api/admin/v1/accounts/${id}/refresh-token`, { method: 'POST' }); results.push({ id, ok: r.status < 400 }); } catch (e) { results.push({ id, ok: false, error: e.message }); } }
        return send(res, 200, { refreshed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
      }
      if (path === '/admin/testchat' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p; try { p = JSON.parse(raw); } catch { p = {}; }
        const model = p.model || 'grok/grok-chat-fast'; const r = resolve(model);
        if (!r) return send(res, 404, { error: 'no provider' });
        if (!pickProviderKey(r.provider, r.prefix || '')) return send(res, 400, { error: 'provider has no api key' });
        const payload = {
          model: r.upstreamModel,
          messages: [{ role: 'user', content: p.prompt || 'hi' }],
          max_tokens: p.max_tokens || 200,
          stream: false,
        };
        const up = await callProviderChat(r.provider, r.upstreamModel, payload, { forceNonStream: true });
        if (isCodebuddyProvider(r.provider)) {
          if (!up.ok) {
            const errTxt = await up.text();
            return send(res, up.status, { error: sanitizeErrorText(errTxt, 800), status: up.status });
          }
          const txt = await up.text();
          const j = aggregateCodebuddySse(txt, r.upstreamModel);
          return send(res, 200, {
            reply: j?.choices?.[0]?.message?.content || JSON.stringify(j),
            usage: j?.usage || null,
            model: r.upstreamModel,
            provider: r.prefix,
            type: 'codebuddy',
          });
        }
        // Read body once as text, then attempt JSON parse — avoids
        // "Body has already been read" when .json() partially consumes then fails.
        const bodyTxt = await up.text();
        let j;
        try { j = JSON.parse(bodyTxt); } catch { j = { raw: bodyTxt.slice(0, 800) }; }
        if (!up.ok) return send(res, up.status, { error: j?.error?.message || j?.error || j, status: up.status });
        return send(res, 200, { reply: j?.choices?.[0]?.message?.content || JSON.stringify(j), usage: j?.usage || null, model: r.upstreamModel, provider: r.prefix, type: r.provider.type || 'openai' });
      }
      // Legacy Grok admin pass-through was intentionally removed: an unrestricted
      // authenticated proxy exposed the entire upstream admin API. Add explicit
      // allowlisted routes if a dashboard feature needs one in the future.
      if (path.startsWith('/admin/proxy/')) return send(res, 404, { error: 'not found' });
      
      if (path === '/admin/providers/probe-credits' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p; try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const prefix = String(p.prefix || '').trim().toLowerCase();
        if (!prefix || !PROVIDERS[prefix]) return send(res, 404, { error: 'provider not found' });
        const provider = PROVIDERS[prefix];
        if (!isCodebuddyProvider(provider)) {
          return send(res, 400, { error: 'probe-credits supports codebuddy only. Grok remaining credits come from account quota/billing.' });
        }
        let keys = (provider.keys || []).filter((k) => k.enabled !== false && k.key);
        if (p.keyId) keys = keys.filter((k) => String(k.id) === String(p.keyId));
        const limit = Math.max(1, Math.min(Number(p.limit) || 10, 30));
        keys = keys.slice(0, limit);
        const model = String(p.model || (provider.models?.[0]?.id) || 'glm-5.2');
        const results = [];
        for (const k of keys) {
          const started = Date.now();
          try {
            provider.__lastKeyId = k.id;
            provider.__lastKey = k.key;
            provider.__prefix = prefix;
            const payload = {
              model,
              messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'ping' }],
              max_tokens: 16,
              stream: true,
              stream_options: { include_usage: true },
            };
            const up = await forwardCodebuddy(provider, model, payload, {
              forceNonStream: true,
              keyOverride: k.key,
              keyIdOverride: k.id,
            });
            const txt = await up.text();
            const latencyMs = Date.now() - started;
            if (!up.ok) {
              const keyStatus = classifyProviderKeyFailure(up.status, txt);
              const exhausted = keyStatus === 'exhausted';
              recordProviderKeyUsage(prefix, k.id, {
                incRequest: true, incFailed: true,
                status: keyStatus || undefined,
                lastError: txt, lastModel: model,
              });
              results.push({ id: k.id, ok: false, status: up.status, exhausted, error: txt.slice(0, 240), latencyMs });
              continue;
            }
            const j = aggregateCodebuddySse(txt, model);
            const credit = extractCreditFromUsage(j?.usage);
            recordProviderKeyUsage(prefix, k.id, {
              incRequest: true, incSuccess: true, status: 'active', lastError: '', lastModel: model, credit, tokens: j?.usage?.total_tokens,
            });
            results.push({ id: k.id, ok: true, credit, usage: j?.usage || null, latencyMs, reply: j?.choices?.[0]?.message?.content || '' });
          } catch (e) {
            recordProviderKeyUsage(prefix, k.id, { incRequest: true, incFailed: true, status: 'error', lastError: e.message, lastModel: model });
            results.push({ id: k.id, ok: false, error: e.message });
          }
        }
        return send(res, 200, {
          prefix,
          note: 'CodeBuddy has no remaining-balance API for ck_ keys. We track spent credit from usage.credit on each request/probe. Grok remaining credits still come from g2a account quota/billing.',
          probed: results.length,
          ok: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          results,
        });
      }

      
      if (path === '/admin/requests' && req.method === 'GET') {
        const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1000));
        const provider = String(url.searchParams.get('provider') || '').trim().toLowerCase();
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
        const since = parseInt(url.searchParams.get('since') || '0', 10) || null;
        // Use SQLite for flexible query (provider filter + time range)
        let items = [];
        try {
          const rows = DB_STMT.recentFiltered.all({
            provider: (provider && provider !== 'all') ? provider : null,
            since: since || null,
            limit: q ? Math.max(limit, 500) : limit,  // over-fetch when q filter is used
          });
          items = rows.map(dbRowToApi);
          if (q) items = items.filter((x) => JSON.stringify(x).toLowerCase().includes(q)).slice(0, limit);
        } catch (e) {
          console.error('/admin/requests', e.message);
          items = REQUEST_LOG.slice(0, limit);
        }
        return send(res, 200, {
          total: items.length,
          items,
          note: 'Requests from SQLite (persistent, 30-day retention). Multi-provider incl. Grok + CodeBuddy.',
        });
      }

      // ============================================================
      // /admin/stats — Aggregated stats for dashboard analytics
      // ?range=1h|6h|24h|7d|30d (default 24h)
      // Returns: totals + hourly buckets + per-provider breakdown
      // ============================================================
      if (path === '/admin/stats' && req.method === 'GET') {
        const rangeStr = String(url.searchParams.get('range') || '24h');
        const rangeMs = {
          '1h': 3600_000, '6h': 6*3600_000, '24h': 24*3600_000,
          '7d': 7*86400_000, '30d': 30*86400_000,
        }[rangeStr] || 24*3600_000;
        const since = Date.now() - rangeMs;
        try {
          const byProvider = DB_STMT.statsRange.all(since);
          const rawBuckets = DB_STMT.hourBuckets.all(since);
          // Fill missing hourly buckets with zeros for continuous chart
          const nowBucket = Math.floor(Date.now() / 3600000);
          const sinceBucket = Math.floor(since / 3600000);
          const bucketMap = new Map(rawBuckets.map(b => [b.bucket, b]));
          const filled = [];
          for (let b = sinceBucket; b <= nowBucket; b++) {
            const src = bucketMap.get(b);
            filled.push({
              bucket: b,
              start: new Date(b * 3600000).toISOString(),
              requests: src?.requests || 0,
              success: src?.success || 0,
              tokens: src?.tokens || 0,
              credit: src?.credit || 0,
            });
          }
          // Totals
          const total = byProvider.reduce((a, p) => ({
            requests: a.requests + (p.requests || 0),
            success: a.success + (p.success || 0),
            failed: a.failed + (p.failed || 0),
            tokens: a.tokens + (p.tokens || 0),
            credit: a.credit + (p.credit || 0),
          }), { requests: 0, success: 0, failed: 0, tokens: 0, credit: 0 });
          const successRate = total.requests > 0 ? Math.round((total.success / total.requests) * 1000) / 10 : 0;
          const avgLatencyByProv = byProvider.map(p => ({ ...p, avg_latency: Math.round(p.avg_latency || 0) }));
          const byModel = DB_STMT.byModel.all(since).map(m => ({
            ...m,
            avg_latency: Math.round(m.avg_latency || 0),
            successRate: m.requests > 0 ? Math.round((m.success / m.requests) * 1000) / 10 : 0,
          }));
          return send(res, 200, {
            range: rangeStr,
            since: new Date(since).toISOString(),
            total: { ...total, successRate },
            byProvider: avgLatencyByProv,
            byModel,
            series: filled,
          });
        } catch (e) {
          console.error('/admin/stats', e.message);
          return send(res, 500, { error: e.message });
        }
      }

      // ============================================================
      // /admin/audit — audit log recent (config changes, admin actions)
      // ============================================================
      if (path === '/admin/audit' && req.method === 'GET') {
        const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500));
        try {
          const items = DB_STMT.auditRecent.all(limit);
          return send(res, 200, { total: items.length, items });
        } catch (e) { return send(res, 500, { error: e.message }); }
      }

      // Backup is redacted by design. Plaintext secret export is intentionally unsupported.
      if (path === '/admin/backup' && req.method === 'GET') {
        try {
          if (url.searchParams.get('secrets') && url.searchParams.get('secrets') !== 'redacted') {
            return send(res, 400, { error: 'plaintext secret export is not supported', code: 'secret_export_unsupported' });
          }
          const dump = redactedBackup();
          auditLog('backup', 'config', `exported ${Object.keys(dump.providers.providers).length} redacted providers`);
          res.writeHead(200, {
            ...securityHeaders(req),
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="ki-gateway-backup-${new Date().toISOString().slice(0,10)}.json"`,
          });
          return res.end(JSON.stringify(dump, null, 2));
        } catch (e) { return send(res, 500, { error: e.message }); }
      }

      if (path === '/admin/restore' && req.method === 'POST') {
        if (RESTORE_IN_PROGRESS) return send(res, 409, { error: 'restore already in progress' });
        RESTORE_IN_PROGRESS = true;
        try {
          const raw = await readBody(req, { limit: BODY_LIMITS.restore, requireJson: true });
          const body = JSON.parse(raw);
          const validated = validateRestoreBackup(body);
          for (const p of Object.values(validated.cfg.providers)) await assertPublicDestination(p.baseUrl, 'provider');
          for (const pool of validated.cfg.proxyPools) await assertPublicDestination(pool.url, 'proxy');
          if (url.searchParams.get('preview') === '1') {
            return send(res, 200, { preview: true, providers: validated.providerCount, exportedAt: body.exportedAt, secrets: 'redacted' });
          }
          // Validation and network policy complete before either live file is replaced.
          const ts = Date.now();
          if (existsSync(PROVIDERS_FILE)) atomicWriteFile(`${PROVIDERS_FILE}.bak.restore.${ts}`, readFileSync(PROVIDERS_FILE));
          if (existsSync(KEY_STATS_FILE)) atomicWriteFile(`${KEY_STATS_FILE}.bak.restore.${ts}`, readFileSync(KEY_STATS_FILE));
          commitRestoreFiles(
            JSON.stringify(validated.cfg, null, 2) + '\n',
            JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), stats: validated.nextStats }, null, 2) + '\n',
          );
          loadProviders();
          auditLog('restore', 'config', `imported ${validated.providerCount} validated providers`);
          return send(res, 200, { ok: true, restored: { providers: validated.providerCount, keyStats: true }, backupSaved: `.bak.restore.${ts}` });
        } catch (e) { return send(res, 400, { error: 'restore failed: ' + sanitizeErrorText(e.message, 300) }); }
        finally { RESTORE_IN_PROGRESS = false; }
      }

      // ============================================================
      // /admin/budget — Get/set budget per provider (max credit)
      // GET → current budgets; POST { prefix, budget } → update
      // ============================================================
      if (path === '/admin/budget' && req.method === 'GET') {
        const providers = safeReadJSON(PROVIDERS_FILE, {});
        const budgets = {};
        for (const [pfx, p] of Object.entries(providers.providers || {})) {
          budgets[pfx] = {
            budget: Number(p.budget || 0),
            budgetAction: p.budgetAction || 'alert',
            currentSpent: 0,
          };
          // Sum spent from stats
          const stats = KEY_STATS[pfx] || {};
          budgets[pfx].currentSpent = Object.values(stats).reduce((s, k) => s + (Number(k?.spentCredit) || 0), 0);
          budgets[pfx].pct = budgets[pfx].budget > 0
            ? Math.round((budgets[pfx].currentSpent / budgets[pfx].budget) * 1000) / 10
            : 0;
        }
        return send(res, 200, { budgets });
      }
      if (path === '/admin/budget' && req.method === 'POST') {
        try {
          const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true });
          const body = JSON.parse(raw);
          const prefix = String(body.prefix || '').trim().toLowerCase();
          const budget = Math.max(0, Number(body.budget) || 0);
          const action = ['alert', 'disable', 'none'].includes(body.budgetAction) ? body.budgetAction : 'alert';
          if (!PROVIDERS[prefix]) return send(res, 404, { error: 'provider not found' });
          PROVIDERS[prefix].budget = budget;
          PROVIDERS[prefix].budgetAction = action;
          persistProviders();
          auditLog('budget-update', prefix, { budget, action });
          return send(res, 200, { ok: true, prefix, budget, budgetAction: action });
        } catch (e) { return send(res, 400, { error: e.message }); }
      }

      // ============================================================
      // /admin/health-deep — upstream connectivity check
      // ============================================================
      if (path === '/admin/health-deep' && req.method === 'GET') {
        const results = [];
        for (const [pfx, p] of Object.entries(PROVIDERS)) {
          if (p.enabled === false) { results.push({ prefix: pfx, ok: null, status: 'disabled' }); continue; }
          const start = Date.now();
          try {
            const baseUrl = p.baseUrl || '';
            const testUrl = baseUrl.replace(/\/v1\/?$/, '') + '/v1/models';
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const selectedKey = pickProviderKey(p, pfx);
            let r;
            try {
              r = await guardedFetch(testUrl, {
                method: 'GET', signal: controller.signal,
                headers: selectedKey ? { Authorization: `Bearer ${selectedKey}` } : {},
              }, 'provider');
            } finally { clearTimeout(timeout); }
            results.push({
              prefix: pfx, ok: r.status < 500,
              status: r.status,
              latencyMs: Date.now() - start,
            });
          } catch (e) {
            results.push({ prefix: pfx, ok: false, error: e.message.slice(0, 100), latencyMs: Date.now() - start });
          }
        }
        return send(res, 200, { results, checkedAt: new Date().toISOString() });
      }

      // ============================================================
      // Settings endpoints
      // ============================================================
      if (path === '/admin/settings/info' && req.method === 'GET') {
        return send(res, 200, gatewayInfoPayload());
      }

      if (path === '/admin/gateway-key/rotate' && req.method === 'POST') {
        try {
          const newKey = rotateGatewayKey();
          auditLog('gateway_key_rotate', 'gateway', { via: 'admin' }, bearerOk ? 'bearer' : 'session');
          // Return new key ONCE. Caller must copy it; sessions are already wiped.
          return send(res, 200, {
            ok: true,
            key: newKey,
            keyMasked: maskKeyHint(newKey),
            rotatedAt: new Date().toISOString(),
            note: 'All dashboard sessions invalidated. Copy this key now — it will not be shown again.',
          });
        } catch (e) {
          const status = e.code === 'env_managed' ? 400 : 500;
          return send(res, status, { error: e.message, code: e.code || 'rotate_failed' });
        }
      }

      if (path === '/admin/request-log/purge' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true });
        let p; try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const all = p.all === true || p.mode === 'all';
        const olderThanDays = p.olderThanDays != null ? Number(p.olderThanDays) : (p.days != null ? Number(p.days) : null);
        try {
          if (!all && (olderThanDays == null || Number.isNaN(olderThanDays))) {
            return send(res, 400, { error: 'provide olderThanDays (number) or all:true' });
          }
          const result = purgeRequestLogs({ all, olderThanDays });
          auditLog('request_log_purge', 'request_log', result, bearerOk ? 'bearer' : 'session');
          return send(res, 200, { ok: true, ...result });
        } catch (e) {
          return send(res, 500, { error: e.message });
        }
      }

      if (path === '/admin/providers/keys/reset-all-health' && req.method === 'POST') {
        try {
          const reset = resetAllProviderKeyHealth();
          auditLog('provider_key_health_reset_all', 'key_stats', { reset }, bearerOk ? 'bearer' : 'session');
          return send(res, 200, { ok: true, reset });
        } catch (e) {
          return send(res, 500, { error: e.message });
        }
      }

      // ============================================================
      // /admin/update-check — check npm registry for newer version
      // Cached for 1 hour to avoid hammering registry.
      // Only flags update when npm latest is STRICTLY newer than
      // current (semver). Dev/local builds ahead of npm stay quiet.
      // ============================================================
      if (path === '/admin/update-check' && req.method === 'GET') {
        const now = Date.now();
        const current = String(GATEWAY_VERSION || '').replace(/^v/i, '').trim();
        // Bust cache if GATEWAY_VERSION changed since last check (e.g. mid-session bump)
        if (UPDATE_CHECK_CACHE && UPDATE_CHECK_CACHE.current !== current) UPDATE_CHECK_CACHE = null;
        if (UPDATE_CHECK_CACHE && (now - Date.parse(UPDATE_CHECK_CACHE.checkedAt || 0)) < 3600_000) {
          return send(res, 200, UPDATE_CHECK_CACHE);
        }
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          let r;
          try {
            r = await guardedFetch('https://registry.npmjs.org/@0xki%2fkirouter', {
              method: 'GET',
              signal: controller.signal,
              headers: { 'Accept': 'application/json' },
            }, 'provider');
          } finally { clearTimeout(timeout); }
          if (!r.ok) return send(res, 200, { current, latest: null, updateAvailable: false, error: 'registry_unavailable', checkedAt: new Date().toISOString() });
          const data = await r.json();
          const latest = data['dist-tags']?.latest || null;
          // Semver compare: only true when latest > current. Equal or local-ahead → no banner.
          const parseVer = (v) => String(v || '').replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
          const cmp = (a, b) => {
            const aa = parseVer(a), bb = parseVer(b);
            const n = Math.max(aa.length, bb.length);
            for (let i = 0; i < n; i++) {
              const d = (aa[i] || 0) - (bb[i] || 0);
              if (d) return d > 0 ? 1 : -1;
            }
            return 0;
          };
          const updateAvailable = !!(latest && cmp(latest, current) > 0);
          const result = {
            current,
            latest,
            updateAvailable,
            aheadOfNpm: !!(latest && cmp(current, latest) > 0),
            checkedAt: new Date().toISOString(),
          };
          UPDATE_CHECK_CACHE = result;
          return send(res, 200, result);
        } catch (e) {
          return send(res, 200, { current, latest: null, updateAvailable: false, error: sanitizeErrorText(e.message, 100), checkedAt: new Date().toISOString() });
        }
      }

      // ============================================================
      // /admin/events — SSE real-time push (stats snapshot every 5s)
      // Client uses EventSource() to subscribe.
      // ============================================================
      if (path === '/admin/events' && req.method === 'GET') {
        // Auth already enforced above via session cookie or Bearer (no URL secrets).
        res.writeHead(200, securityHeaders(req, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        }));
        res.write(': connected\n\n');
        const push = () => {
          try {
            const now = Date.now();
            const since24h = now - 24 * 3600_000;
            const total = DB.prepare(`SELECT COUNT(*) as requests, SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) as success, SUM(COALESCE(tokens,0)) as tokens FROM request_log WHERE ts_ms >= ?`).get(since24h);
            const provCount = Object.keys(PROVIDERS).length;
            const enabledCount = Object.values(PROVIDERS).filter(p => p.enabled !== false).length;
            const payload = {
              ts: new Date().toISOString(),
              requests24h: total.requests || 0,
              success24h: total.success || 0,
              tokens24h: total.tokens || 0,
              successRate: total.requests > 0 ? Math.round((total.success / total.requests) * 1000) / 10 : 0,
              providers: { total: provCount, enabled: enabledCount },
              recentInMemory: REQUEST_LOG.length,
            };
            res.write(`event: stats\ndata: ${JSON.stringify(payload)}\n\n`);
          } catch (e) { /* client probably disconnected */ }
        };
        push();
        const iv = setInterval(push, 5000);
        const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch(e){} }, 30000);
        req.on('close', () => { clearInterval(iv); clearInterval(heartbeat); });
        return;
      }

      // ============================================================
      // /admin/metrics — Prometheus text format
      // For external monitoring (Grafana, Uptime Kuma, Prometheus).
      // ============================================================
      if (path === '/admin/metrics' && req.method === 'GET') {
        try {
          const now = Date.now();
          const since24h = now - 24 * 3600_000;
          const since1h = now - 3600_000;
          const total24h = DB.prepare(`SELECT COUNT(*) as c, SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) as ok, SUM(COALESCE(tokens,0)) as tok, SUM(COALESCE(credit,0)) as cr FROM request_log WHERE ts_ms >= ?`).get(since24h);
          const total1h  = DB.prepare(`SELECT COUNT(*) as c, SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) as ok FROM request_log WHERE ts_ms >= ?`).get(since1h);
          const byProv = DB_STMT.statsRange.all(since24h);
          const lines = [];
          lines.push('# HELP kigw_requests_total Total requests (all-time in DB).');
          lines.push('# TYPE kigw_requests_total counter');
          const allTime = DB.prepare('SELECT COUNT(*) as c FROM request_log').get().c;
          lines.push(`kigw_requests_total ${allTime}`);
          lines.push('# HELP kigw_requests_24h Requests in last 24 hours.');
          lines.push('# TYPE kigw_requests_24h gauge');
          lines.push(`kigw_requests_24h ${total24h.c || 0}`);
          lines.push(`kigw_requests_1h ${total1h.c || 0}`);
          lines.push('# HELP kigw_success_rate_24h Success rate (0-100) in last 24h.');
          lines.push('# TYPE kigw_success_rate_24h gauge');
          const rate = total24h.c > 0 ? (total24h.ok / total24h.c) * 100 : 0;
          lines.push(`kigw_success_rate_24h ${rate.toFixed(2)}`);
          lines.push(`kigw_tokens_24h ${total24h.tok || 0}`);
          lines.push(`kigw_credit_24h ${(total24h.cr || 0).toFixed(4)}`);
          lines.push('# HELP kigw_provider_requests_24h Requests per provider (24h).');
          lines.push('# TYPE kigw_provider_requests_24h gauge');
          for (const p of byProv) {
            const prov = String(p.provider || 'unknown').replace(/"/g, '');
            lines.push(`kigw_provider_requests_24h{provider="${prov}"} ${p.requests || 0}`);
            lines.push(`kigw_provider_success_24h{provider="${prov}"} ${p.success || 0}`);
            lines.push(`kigw_provider_failed_24h{provider="${prov}"} ${p.failed || 0}`);
            lines.push(`kigw_provider_avg_latency_ms{provider="${prov}"} ${Math.round(p.avg_latency || 0)}`);
          }
          lines.push('# HELP kigw_providers_enabled Number of enabled providers.');
          lines.push('# TYPE kigw_providers_enabled gauge');
          const enabled = Object.values(PROVIDERS).filter(p => p.enabled !== false).length;
          lines.push(`kigw_providers_enabled ${enabled}`);
          lines.push(`kigw_providers_total ${Object.keys(PROVIDERS).length}`);
          res.writeHead(200, securityHeaders(req, { 'Content-Type': 'text/plain; version=0.0.4' }));
          return res.end(lines.join('\n') + '\n');
        } catch (e) { return send(res, 500, { error: e.message }); }
      }

      // Add model to a provider
      if (path === '/admin/providers/models/add' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const prefix = String(p.prefix || '').trim().toLowerCase();
        let id = String(p.id || '').trim();
        if (!prefix || !id) return send(res, 400, { error: 'prefix and id required' });
        const provider = PROVIDERS[prefix];
        if (!provider) return send(res, 404, { error: 'provider not found' });
        if (isCodebuddyProvider(provider)) {
          while (id.startsWith(`${prefix}/`)) id = id.slice(prefix.length + 1);
        }
        if (!id) return send(res, 400, { error: 'model id required' });
        const label = String(p.label || id).trim();
        if (!Array.isArray(provider.models)) provider.models = [];
        if (provider.models.some(m => (m.id || m) === id)) return send(res, 409, { error: 'model already exists' });
        provider.models.push({ id, label });
        persistProviders();
        auditLog('model.add', prefix+':'+id, { label });
        return send(res, 200, { ok: true, prefix, id, label });
      }
      // Test a specific model on a provider
      if (path === '/admin/providers/test-model' && req.method === 'POST') {
        const raw = await readBody(req, { limit: BODY_LIMITS.admin, requireJson: true }); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const prefix = String(p.prefix || '').trim().toLowerCase();
        const model = String(p.model || '').trim();
        const prompt = String(p.prompt || 'Reply with exactly: OK');
        if (!prefix || !model) return send(res, 400, { error: 'prefix and model required' });
        const provider = PROVIDERS[prefix];
        if (!provider) return send(res, 404, { error: 'provider not found' });
        const started = Date.now();
        try {
          // Check key availability first — if no key, report config issue not model issue
          const hasKey = provider.key || (Array.isArray(provider.keys) && provider.keys.some(k => k.enabled !== false));
          if (!hasKey) {
            return send(res, 200, { ok: false, status: 0, latencyMs: 0, error: 'no API key configured', errorType: 'config', hint: 'Add API key via Providers page' });
          }
          // Use max_tokens:16 — model validation only, minimal cost (CodeBuddy min is >1)
          const upstreamRes = await callProviderChat(provider, model, {
            model,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 16,
            stream: false
          });
          const latencyMs = Date.now() - started;
          const status = upstreamRes?.status || 0;
          if (!upstreamRes || status >= 400) {
            const errTxt = upstreamRes ? await upstreamRes.text().catch(()=>'') : 'no response';
            const errStr = String(errTxt || '');
            const keyId = upstreamRes?.__cbKeyId || provider.__lastKeyId || '';
            if (isCodebuddyProvider(provider) && keyId) {
              recordProviderKeyUsage(prefix, keyId, {
                incRequest: true, incFailed: true,
                status: classifyProviderKeyFailure(status, errStr) || undefined,
                lastError: errStr, lastModel: model,
              });
            }
            // Classify error type for better UX
            let errorType = 'upstream';
            let hint = '';
            if (status === 401 || status === 403) { errorType = 'auth'; hint = 'API key invalid/expired'; }
            else if (/credits? exhausted|quota exceeded|insufficient|balance/i.test(errStr)) { errorType = 'credits'; hint = 'Credits exhausted — model exists but account out of credits'; }
            else if (status === 404) { errorType = 'model_not_found'; hint = 'Model ID may not exist on this provider'; }
            else if (status === 429) { errorType = 'rate_limit'; hint = 'Rate limited — model exists but throttled'; }
            else if (/model.*not.*found|invalid.*model|no such model/i.test(errStr)) { errorType = 'model_not_found'; hint = 'Model ID not recognized by provider'; }
            return send(res, 200, { ok: false, status, latencyMs, error: errStr.slice(0,300), errorType, hint });
          }
          let j = null;
          if (isCodebuddyProvider(provider)) {
            const txt = await upstreamRes.text().catch(() => '');
            j = aggregateCodebuddySse(txt, model);
            const keyId = upstreamRes.__cbKeyId || provider.__lastKeyId || '';
            if (keyId) recordProviderKeyUsage(prefix, keyId, {
              incRequest: true, incSuccess: true, status: 'active', lastError: '', lastModel: model,
              credit: extractCreditFromUsage(j?.usage), tokens: j?.usage?.total_tokens,
            });
          } else {
            j = await upstreamRes.json().catch(()=>null);
          }
          const reply = j?.choices?.[0]?.message?.content || j?.capturedText || '';
          return send(res, 200, { ok: true, status, latencyMs, reply: String(reply).trim().slice(0,200) });
        } catch (e) {
          const msg = String(e?.message || e);
          let errorType = 'network';
          let hint = 'Connection failed';
          if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(msg)) { errorType = 'unreachable'; hint = 'Provider endpoint unreachable'; }
          else if (/timeout|ETIMEDOUT/.test(msg)) { errorType = 'timeout'; hint = 'Request timed out'; }
          return send(res, 200, { ok: false, latencyMs: Date.now() - started, error: msg.slice(0, 300), errorType, hint });
        }
      }
      return send(res, 404, { error: 'unknown admin route' });
    }

    if (path === '/v1/models') {
      if (!authOk(req)) return send(res, 401, { error: { message: 'invalid gateway key', type: 'auth_error' } });
      const data = [];
      for (const [prefix, p] of Object.entries(PROVIDERS)) {
        if (p.enabled === false) continue;
        for (const m of (p.models || [])) data.push({ id: `${prefix}/${m.id}`, object: 'model', owned_by: prefix });
      }
      return send(res, 200, { object: 'list', data });
    }
  if (path === '/v1/chat/completions' && req.method === 'POST') {
      if (!authOk(req)) return send(res, 401, { error: { message: 'invalid gateway key', type: 'auth_error' } });
      const raw = await readBody(req, { limit: BODY_LIMITS.chat, requireJson: true }); let payload;
      try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } }); }
      const started = Date.now();
      const r = resolve(payload.model);
      if (!r) {
        pushRequestLog({
          provider: '?', model: payload?.model || '', status: 404, ok: false, latencyMs: Date.now() - started,
          error: 'model_not_found', preview: summarizeMessages(payload?.messages), stream: !!payload?.stream,
        });
        return send(res, 404, { error: { message: `no provider for model: ${payload.model}`, type: 'invalid_request_error', code: 'model_not_found' } });
      }
      const budgetState = providerBudgetState(r.prefix, r.provider);
      if (budgetState.exceeded && budgetState.action === 'alert' && !BUDGET_ALERTED.has(r.prefix)) {
        BUDGET_ALERTED.add(r.prefix);
        auditLog('budget-exceeded', r.prefix, { spent: budgetState.spent, budget: budgetState.budget, action: 'alert' }, 'gateway');
        console.warn(`[budget] ${r.prefix} exceeded ${budgetState.spent}/${budgetState.budget}`);
      } else if (!budgetState.exceeded) {
        BUDGET_ALERTED.delete(r.prefix);
      }
      if (budgetState.exceeded && budgetState.action === 'disable') {
        pushRequestLog({
          provider: r.prefix, model: payload?.model || r.upstreamModel, status: 429, ok: false, latencyMs: Date.now() - started,
          error: 'provider budget exceeded', preview: summarizeMessages(payload?.messages), stream: !!payload?.stream,
        });
        return send(res, 429, { error: {
          message: `provider ${r.prefix} budget exceeded (${budgetState.spent}/${budgetState.budget})`,
          type: 'rate_limit_error', code: 'provider_budget_exceeded',
        } });
      }
      if (!hasEligibleProviderKey(r.provider, r.prefix || '')) {
        pushRequestLog({
          provider: r.prefix, model: payload?.model || r.upstreamModel, status: 400, ok: false, latencyMs: Date.now() - started,
          error: 'no api key', preview: summarizeMessages(payload?.messages), stream: !!payload?.stream,
        });
        return send(res, 503, { error: { message: `provider ${r.prefix} has no healthy API key`, type: 'upstream_unavailable', code: 'all_keys_unhealthy' } });
      }
      try {
        const upstreamRes = await callProviderChat(r.provider, r.upstreamModel, payload);
        const meta = await writeUpstreamToClient(res, upstreamRes, r.provider, r.upstreamModel);
        pushRequestLog({
          provider: r.prefix,
          model: payload?.model || `${r.prefix}/${r.upstreamModel}`,
          upstreamModel: r.upstreamModel,
          status: meta?.status || upstreamRes?.status || 0,
          ok: !!meta?.ok,
          latencyMs: Date.now() - started,
          tokens: meta?.tokens || 0,
          promptTokens: meta?.promptTokens || 0,
          completionTokens: meta?.completionTokens || 0,
          credit: meta?.credit,
          stream: !!meta?.stream || !!payload?.stream,
          keyId: meta?.keyId || r.provider.__lastKeyId || '',
          keyMasked: meta?.keyMasked || maskKeyHint(r.provider.__lastKey || ''),
          preview: summarizeMessages(payload?.messages),
          error: meta?.error || '',
        });
      } catch (e) {
        pushRequestLog({
          provider: r.prefix, model: payload?.model || r.upstreamModel, status: 502, ok: false,
          latencyMs: Date.now() - started, error: e.message, preview: summarizeMessages(payload?.messages), stream: !!payload?.stream,
        });
        throw e;
      }
      return;
    }
    return send(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  } catch (e) {
    try {
      if (e instanceof HttpInputError) {
        return send(res, e.status, { error: { message: e.message, type: 'invalid_request_error', code: e.code } });
      }
      send(res, 502, { error: { message: `gateway error: ${sanitizeErrorText(e.message, 300)}`, type: 'gateway_error' } });
    } catch {}
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[ki-gateway] listening on http://${HOST}:${PORT}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[ki-gateway] ${signal}; shutting down`);
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref?.();
  if (KEY_STATS_SAVE_TIMER) { clearTimeout(KEY_STATS_SAVE_TIMER); KEY_STATS_SAVE_TIMER = null; }
  saveKeyStats();
  for (const dispatcher of PROXY_DISPATCHERS.values()) { try { dispatcher.close(); } catch {} }
  for (const dispatcher of PINNED_DISPATCHERS.values()) { try { dispatcher.close(); } catch {} }
  server.close(() => {
    try { DB?.close(); } catch {}
    clearTimeout(force);
    process.exit(0);
  });
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => console.error('[uncaught]', e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));

// fallback if dashboard.html missing (kept minimal; primary is external file)
const DASHBOARD_HTML_FALLBACK = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KiRouter</title></head><body><h1>Dashboard unavailable</h1><p>The dashboard asset is missing. Reinstall KiRouter or restore lib/dashboard.html.</p></body></html>';
