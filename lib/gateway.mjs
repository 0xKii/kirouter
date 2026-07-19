#!/usr/bin/env node
// ki-gateway v4.1 — multi-provider OpenAI-compatible gateway + admin dashboard.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

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
    console.error('[proxy-pool] Failed to create dispatcher for', url, e.message);
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
const PORT = parseInt(process.env.PORT || process.env.KIGW_PORT || '20128', 10);
const HOST = process.env.KIGW_HOST || '127.0.0.1';
// Data directory: ~/.kirouter for user data (writable), lib/ for read-only assets
const DATA_DIR = process.env.KI_DATA_DIR || pathResolve(process.env.HOME || process.env.USERPROFILE || '.', '.kirouter');
import { mkdirSync } from 'node:fs';
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const PROVIDERS_FILE = pathResolve(DATA_DIR, 'providers.json');
const DASHBOARD_FILE = pathResolve(__dirname, 'dashboard.html');
// Upstream retry (transient 5xx + network errors)
const RETRY_ATTEMPTS = Math.max(1, Math.min(4, parseInt(process.env.KIGW_RETRY_ATTEMPTS || '2', 10) || 2));
const RETRY_STATUSES = new Set((process.env.KIGW_RETRY_STATUSES || '500,502,503,504,529').split(',').map(x => parseInt(x.trim(), 10)).filter(Boolean));
const RETRY_DELAY_MS = Math.max(0, parseInt(process.env.KIGW_RETRY_DELAY_MS || '350', 10) || 0);
const KEY_STATS_FILE = pathResolve(DATA_DIR, 'provider-key-stats.json');
function safeReadJSON(path, fallback) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback; }
  catch (e) { console.warn('[safeReadJSON]', path, e.message); return fallback; }
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
function saveKeyStats() {
  try {
    writeFileSync(KEY_STATS_FILE, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), stats: KEY_STATS }, null, 2));
  } catch (e) { console.error('saveKeyStats', e.message); }
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
  if (patch.status) next.status = patch.status;
  if (patch.lastError != null) next.lastError = String(patch.lastError || '').slice(0, 300);
  if (patch.lastModel) next.lastModel = String(patch.lastModel);
  if (patch.tokens != null) next.lastTokens = Number(patch.tokens) || 0;
  next.lastChecked = new Date().toISOString();
  b[keyId] = next;
  saveKeyStats();
  return next;
}
function getKeyStat(prefix, keyId) {
  return (KEY_STATS[prefix] && KEY_STATS[prefix][keyId]) || null;
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
  if (status === 429 && (t.includes('credit') || t.includes('quota') || t.includes('exhausted') || t.includes('balance'))) return true;
  if (t.includes('credits exhausted') || t.includes('credit exhausted') || t.includes('insufficient credit')) return true;
  return false;
}

// ============================================================
// Request log — SQLite backed (persistent, fast aggregations)
// Migrated from JSON file in ki-gateway v1.5.
// Legacy JSON file kept as import source; new writes go to SQLite.
// ============================================================
const REQUEST_LOG_FILE = pathResolve(DATA_DIR, 'request-log.json');
const DB_FILE = pathResolve(DATA_DIR, 'kirouter.db');
const REQUEST_LOG_MAX = 300;      // in-memory cache size (for hot path reads)
const REQUEST_LOG_KEEP_DAYS = 30;  // purge older than this in SQLite

let DB = null;
let DB_STMT = null;

function initDb() {
  const BetterSqlite3 = createRequire(import.meta.url)('better-sqlite3');
  DB = new BetterSqlite3(DB_FILE);
  DB.pragma('journal_mode = WAL');
  DB.pragma('synchronous = NORMAL');
  DB.pragma('foreign_keys = ON');
  DB.exec(`
    CREATE TABLE IF NOT EXISTS request_log (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      provider TEXT,
      model TEXT,
      status INTEGER,
      ok INTEGER,
      latency_ms INTEGER,
      tokens INTEGER,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      credit REAL,
      error TEXT,
      preview TEXT,
      stream INTEGER,
      key_id TEXT,
      raw TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_req_ts ON request_log(ts_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_req_provider ON request_log(provider);
    CREATE INDEX IF NOT EXISTS idx_req_ok ON request_log(ok);

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT,
      actor TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts_ms DESC);
  `);
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
function maskKeyHint(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 10) return '••••';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

const read = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };
const GATEWAY_KEY = read(pathResolve(DATA_DIR, '.gateway_key'));
const GROK_UPSTREAM_KEY = read(pathResolve(DATA_DIR, '.upstream_key'));
const G2A_USER = read(pathResolve(DATA_DIR, '.g2a_user'));
const G2A_PASS = read(pathResolve(DATA_DIR, '.g2a_pass'));
const G2A_BASE = process.env.G2A_BASE || 'http://127.0.0.1:8010';

// Auto-generate gateway key on first run (npm package UX)
let GATEWAY_KEY_FINAL = GATEWAY_KEY;
if (!GATEWAY_KEY_FINAL) {
  GATEWAY_KEY_FINAL = 'kigw_' + crypto.randomBytes(24).toString('hex');
  try {
    writeFileSync(pathResolve(DATA_DIR, '.gateway_key'), GATEWAY_KEY_FINAL + '\n', { mode: 0o600 });
    console.log('[init] Generated gateway key:', GATEWAY_KEY_FINAL.slice(0, 12) + '...');
    console.log('[init] Saved to', pathResolve(DATA_DIR, '.gateway_key'));
  } catch (e) {
    console.error('FATAL: cannot write gateway key:', e.message);
    process.exit(1);
  }
}

/** @type {Record<string, any>} */
let PROVIDERS = {};

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
  const baseUrl = String(raw.baseUrl || '').trim().replace(/\/$/, '');
  if (!baseUrl) throw new Error('baseUrl required');
  const models = Array.isArray(raw.models) ? raw.models : [];
  const normModels = models.map((m) => {
    if (typeof m === 'string') return { id: m, label: m };
    const id = String(m?.id || '').trim();
    if (!id) return null;
    return {
      id,
      label: String(m?.label || id).trim(),
      ...(m?.tier ? { tier: String(m.tier) } : {}),
    };
  }).filter(Boolean);
  if (!normModels.length) throw new Error('at least 1 model required');
  const typeRaw = String(raw.type || 'openai').trim().toLowerCase();
  const type = ['codebuddy', 'codebuddy-global', 'cbai'].includes(typeRaw) ? 'codebuddy' : 'openai';
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
  // ensure grok default exists if empty
  if (!Object.keys(next).length) {
    const d = defaultProvidersConfig().providers.grok;
    next.grok = normalizeProvider('grok', d);
  }
  // if grok key empty but env/file key exists, fill
  if (next.grok && !next.grok.key && GROK_UPSTREAM_KEY) next.grok.key = GROK_UPSTREAM_KEY;
  PROVIDERS = next;
  // Load proxy pools
  PROXY_POOLS = Array.isArray(cfg?.proxyPools) ? cfg.proxyPools : [];
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
  writeFileSync(PROVIDERS_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
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
    return status !== 'exhausted' && status !== 'error';
  });
  // Prefer healthy keys, fallback to all keys if none healthy
  const keys = healthyKeys.length ? healthyKeys : allKeys;
  if (keys.length) {
    // simple round-robin
    provider.__rr = ((provider.__rr || 0) + 1) % keys.length;
    const chosen = keys[provider.__rr];
    provider.__lastKeyId = chosen.id;
    provider.__lastKey = chosen.key;
    return chosen.key;
  }
  provider.__lastKeyId = (provider?.keys || []).find((k) => k.key === provider?.key)?.id || 'primary';
  provider.__lastKey = provider?.key || '';
  return provider?.key || '';
}

function resolve(model) {
  if (!model) return null;
  const hasSlash = String(model).includes('/');
  const prefix = hasSlash ? String(model).split('/')[0] : 'grok';
  const p = PROVIDERS[prefix];
  if (!p) return null;
  if (p.enabled === false) return null;
  const upstreamModel = hasSlash ? String(model).slice(prefix.length + 1) : String(model);
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
  const _dispatcher_ = getProviderDispatcher(provider);
  return (_dispatcher_ ? undiciFetch : fetch)(`${provider.baseUrl}/chat/completions`, {
    dispatcher: _dispatcher_ || undefined,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
}

async function forwardCodebuddy(provider, upstreamModel, payload, { forceNonStream = false } = {}) {
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
  const url = `${origin}/v2/chat/completions`;
  const key = pickProviderKey(provider, provider.__prefix || '');
  const _cbaidisp_ = getProviderDispatcher(provider);
  const _fetchFn_ = _cbaidisp_ ? undiciFetch : fetch;
  const up = await _fetchFn_(url, {
    dispatcher: _cbaidisp_ || undefined,
    method: 'POST',
    headers: codebuddyHeaders(key, origin),
    body: JSON.stringify(upstreamBody),
  });
  // Attach metadata for response writer
  up.__cbClientWantsStream = clientWantsStream;
  up.__cbModel = upstreamModel;
  up.__cbKeyId = provider.__lastKeyId || '';
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
  };
  if (isCodebuddyProvider(provider)) {
    const clientWantsStream = !!upstreamRes.__cbClientWantsStream;
    const model = upstreamRes.__cbModel || upstreamModel;
    const prefix = upstreamRes.__cbPrefix || provider.__prefix || '';
    const keyId = upstreamRes.__cbKeyId || provider.__lastKeyId || '';
    meta.stream = !!clientWantsStream;
    if (!upstreamRes.ok) {
      const errTxt = await upstreamRes.text();
      meta.error = String(errTxt || '').slice(0, 400);
      if (keyId) {
        recordProviderKeyUsage(prefix, keyId, {
          incRequest: true,
          incFailed: true,
          status: isCreditsExhaustedError(upstreamRes.status, errTxt) ? 'exhausted' : 'error',
          lastError: errTxt,
          lastModel: model,
        });
      }
      send(res, upstreamRes.status, {
        error: { message: errTxt.slice(0, 800), type: 'upstream_error', code: upstreamRes.status },
      });
      return meta;
    }
    if (clientWantsStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
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
  meta.stream = ct.includes('text/event-stream');
  if (!upstreamRes.ok) {
    const errTxt = await upstreamRes.text();
    meta.error = String(errTxt || '').slice(0, 400);
    res.writeHead(upstreamRes.status, { 'Content-Type': ct.includes('json') ? 'application/json' : ct });
    res.end(errTxt);
    return meta;
  }
  res.writeHead(upstreamRes.status, { 'Content-Type': ct });
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
  res.end(bodyTxt);
  return meta;
}

async function callProviderChatOnce(provider, upstreamModel, payload, opts = {}) {
  if (isCodebuddyProvider(provider)) return forwardCodebuddy(provider, upstreamModel, payload, opts);
  return forwardOpenAI(provider, upstreamModel, payload);
}

// Retry wrapper — auto-retry on transient upstream failures (502/503/504/network).
// Non-streaming only (streaming responses cannot be replayed after first byte).
async function callProviderChat(provider, upstreamModel, payload, opts = {}) {
  const isStream = !!payload?.stream;
  const MAX_RETRIES = isStream ? 0 : 2;
  const RETRY_STATUSES = new Set([502, 503, 504]);
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await callProviderChatOnce(provider, upstreamModel, payload, opts);
      const status = r?.status || 0;
      if (attempt < MAX_RETRIES && RETRY_STATUSES.has(status)) {
        const backoff = 200 * (attempt + 1) + Math.floor(Math.random() * 100);
        console.warn(`[retry] ${provider?.prefix || '?'} status=${status} attempt=${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      // Retry on network errors (ECONNRESET, ETIMEDOUT, socket hang up, fetch failed)
      const msg = String(e?.message || '');
      const isTransient = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed|other side closed/i.test(msg);
      if (attempt < MAX_RETRIES && isTransient) {
        const backoff = 200 * (attempt + 1) + Math.floor(Math.random() * 100);
        console.warn(`[retry] ${provider?.prefix || '?'} error="${msg.slice(0, 60)}" attempt=${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw e;
    }
  }
  if (lastErr) throw lastErr;
  // If loop exits via retry-exhaustion on bad status, do one final call so caller sees the final response
  return callProviderChatOnce(provider, upstreamModel, payload, opts);
}


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
  const r = await fetch(`${G2A_BASE}/api/admin/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: G2A_USER, password: G2A_PASS }),
  });
  const j = await r.json();
  g2aToken = j?.data?.tokens?.accessToken;
  g2aTokenExp = now + 10 * 60 * 1000;
  if (!g2aToken) throw new Error('grok2api login failed');
  return g2aToken;
}
async function g2aFetch(path, opts = {}) {
  const tok = await g2aLogin();
  return fetch(`${G2A_BASE}${path}`, {
    ...opts,
    headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}

function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': typeof obj === 'string' && !headers['Content-Type'] ? 'application/json' : (headers['Content-Type'] || 'application/json'), ...headers });
  res.end(body);
}
function authOk(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.replace(/^Bearer\s+/i, '').trim();
  return tok && tok === GATEWAY_KEY_FINAL;
}
function dashAuthOk(req, url) {
  const q = url.searchParams.get('key');
  if (q && q === GATEWAY_KEY_FINAL) return true;
  const cookie = req.headers['cookie'] || '';
  const m = cookie.match(/kigw_key=([^;]+)/);
  return m && m[1] === GATEWAY_KEY_FINAL;
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

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
      version: '4.1',
      providers: Object.keys(PROVIDERS).filter((k) => PROVIDERS[k]?.enabled !== false),
      providerCount: Object.keys(PROVIDERS).length,
    });
    if (path === '/' || path === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
          res.writeHead(200, {
            'Content-Type': ctype,
            'Cache-Control': 'public, max-age=86400, immutable',
            'Content-Length': buf.length
          });
          return res.end(buf);
        } catch (e) {
          return send(res, 404, { error: 'logo not found' });
        }
      }
      return send(res, 404, { error: 'invalid logo path' });
    }

    if (path.startsWith('/admin/')) {
      const ok = authOk(req) || dashAuthOk(req, url);
      if (!ok) return send(res, 401, { error: 'unauthorized' });
      if (path === '/admin/session' && req.method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': `kigw_key=${GATEWAY_KEY_FINAL}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` });

      // ---- multi-provider management ----
      if (path === '/admin/providers' && req.method === 'GET') {
        return send(res, 200, { items: listProvidersPublic(true) });
      }
      if (path === '/admin/providers' && req.method === 'POST') {
        const raw = await readBody(req); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const prefix = String(p.prefix || '').trim().toLowerCase();
        if (!prefix) return send(res, 400, { error: 'prefix required' });
        const existing = PROVIDERS[prefix];
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
        const raw = await readBody(req); let p;
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
        const raw = await readBody(req); let p;
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
        const raw = await readBody(req); let p;
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
                  lastError: errTxt.slice(0, 300), lastModel: model,
                });
              }
              return send(res, 200, { ok: false, status: up.status, error: errTxt.slice(0, 800), latencyMs, model, prefix });
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
        const raw = await readBody(req); let p;
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
        const raw = await readBody(req); let p;
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
        const raw = await readBody(req); let p;
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
        const raw = await readBody(req); let p;
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
        const raw = await readBody(req); let p;
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
        const raw = await readBody(req); let p;
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
              // Reset stats file entry
              if (typeof PROVIDER_KEY_STATS === 'object' && PROVIDER_KEY_STATS) {
                const stKey = pfx + ':' + kid;
                if (PROVIDER_KEY_STATS[stKey]) {
                  PROVIDER_KEY_STATS[stKey].failed = 0;
                  PROVIDER_KEY_STATS[stKey].status = 'unknown';
                  PROVIDER_KEY_STATS[stKey].lastError = '';
                  reset++;
                } else {
                  reset++;
                }
              } else {
                reset++;
              }
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
            urlFull: p.url, enabled: p.enabled !== false,
            status: p.status || 'unknown', lastTested: p.lastTested || null,
            lastError: p.lastError || null,
            usedBy: Object.entries(PROVIDERS)
              .filter(([_, v]) => v.proxyPoolId === p.id)
              .map(([k, v]) => ({ prefix: k, name: v.name })),
          })),
        });
      }
      if (path === '/admin/proxy-pools' && req.method === 'POST') {
        const raw = await readBody(req); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const urls = [];
        if (p.url) urls.push(String(p.url).trim());
        if (Array.isArray(p.urls)) urls.push(...p.urls.map(u => String(u).trim()));
        if (p.bulkUrls) urls.push(...String(p.bulkUrls).split(/\r?\n/).map(s => s.trim()).filter(Boolean));
        let added = 0, skipped = 0, errors = [];
        for (const url of urls) {
          if (!url || url.startsWith('#')) continue;
          try {
            new URL(url); // validate
            if (PROXY_POOLS.some(x => x.url === url)) { skipped++; continue; }
            const id = crypto.randomUUID().slice(0, 8);
            const name = p.name || `Proxy ${new URL(url).hostname}:${new URL(url).port || ''}`;
            PROXY_POOLS.push({
              id, name, url, enabled: true, status: 'unknown',
              lastTested: null, lastError: null,
            });
            added++;
          } catch (e) { errors.push(url + ': ' + e.message); }
        }
        persistProviders();
        return send(res, 200, { ok: true, added, skipped, errors, total: PROXY_POOLS.length });
      }
      if (path === '/admin/proxy-pools/delete' && req.method === 'POST') {
        const raw = await readBody(req); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const ids = Array.isArray(p.ids) ? p.ids.map(String) : (p.id ? [String(p.id)] : []);
        const idSet = new Set(ids);
        const before = PROXY_POOLS.length;
        PROXY_POOLS = PROXY_POOLS.filter(x => !idSet.has(x.id));
        const deleted = before - PROXY_POOLS.length;
        // Clear proxyPoolId from providers using deleted pools
        for (const v of Object.values(PROVIDERS)) {
          if (v.proxyPoolId && idSet.has(v.proxyPoolId)) v.proxyPoolId = '';
        }
        // Cleanup dispatcher cache
        for (const id of ids) {
          const p = PROXY_POOLS.find(x => x.id === id); // (undefined now)
        }
        persistProviders();
        return send(res, 200, { ok: true, deleted });
      }
      if (path === '/admin/proxy-pools/toggle' && req.method === 'POST') {
        const raw = await readBody(req); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const pool = PROXY_POOLS.find(x => x.id === String(p.id || '').trim());
        if (!pool) return send(res, 404, { error: 'pool not found' });
        pool.enabled = !!p.enabled;
        if (!pool.enabled) invalidateDispatcher(pool.url);
        persistProviders();
        return send(res, 200, { ok: true, id: pool.id, enabled: pool.enabled });
      }
      if (path === '/admin/proxy-pools/test' && req.method === 'POST') {
        const raw = await readBody(req); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const ids = Array.isArray(p.ids) ? p.ids.map(String) : (p.id ? [String(p.id)] : PROXY_POOLS.map(x => x.id));
        const results = [];
        for (const id of ids) {
          const pool = PROXY_POOLS.find(x => x.id === id);
          if (!pool) { results.push({ id, ok: false, error: 'not found' }); continue; }
          try {
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
            pool.status = 'error'; pool.lastTested = new Date().toISOString();
            pool.lastError = e.message;
            results.push({ id, ok: false, error: e.message });
          }
        }
        persistProviders();
        return send(res, 200, { ok: true, results });
      }
      // Set proxy pool for a provider (link provider → pool)
      if (path === '/admin/providers/proxy' && req.method === 'POST') {
        const raw = await readBody(req); let p;
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
        return send(res, 200, {
          ok: true, prefix, proxyPoolId: poolId,
          pool: poolId === '__all__' ? { id: '__all__', name: 'All Pools (rotate)', mode: 'rotate' }
                : poolId ? PROXY_POOLS.find(x => x.id === poolId) : null,
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
          gateway: { version: process.env.KI_GATEWAY_VERSION || 'v1.0.0', providerCount: Object.keys(PROVIDERS).length },
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
        const raw = await readBody(req);
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
          return send(res, 200, { dryRun: true, total: bad.length, breakdown, sample: bad.slice(0, 10).map((a) => ({ id: a.id, email: a.email || a.name || '', provider: a.provider, authStatus: a.authStatus, failureCount: a.failureCount || 0 })) });
        }
        let purged = 0, failed = 0;
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
        return send(res, 200, { dryRun: false, purged, failed, total: bad.length, breakdown, results });
      }

      if (path === '/admin/egress' && req.method === 'GET') {
        const r = await g2aFetch('/api/admin/v1/egress-nodes'); const j = await r.json();
        const items = (j?.data?.items || j?.data || []).map(n => ({ id: n.id, name: n.name, scope: n.scope, enabled: n.enabled, proxyConfigured: n.proxyConfigured, health: n.health, failureCount: n.failureCount || 0 }));
        return send(res, 200, { items });
      }
      if (path === '/admin/egress/add' && req.method === 'POST') {
        const raw = await readBody(req); let p; try { p = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
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
        const raw = await readBody(req); let p; try { p = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const ids = p.ids || []; const results = [];
        for (const id of ids) { try { const r = await g2aFetch(`/api/admin/v1/egress-nodes/${id}`, { method: 'DELETE' }); results.push({ id, ok: r.status < 400 }); } catch (e) { results.push({ id, ok: false, error: e.message }); } }
        return send(res, 200, { deleted: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
      }
      if (path === '/admin/egress/toggle' && req.method === 'POST') {
        const raw = await readBody(req); let p; try { p = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const r = await g2aFetch(`/api/admin/v1/egress-nodes/${p.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !!p.enabled }) });
        return send(res, r.status, await r.text());
      }
      if (path === '/admin/device/start' && req.method === 'POST') { const r = await g2aFetch('/api/admin/v1/accounts/device/start', { method: 'POST' }); const j = await r.json(); return send(res, r.status, j?.data || j); }
      if (path.startsWith('/admin/device/poll/') && req.method === 'POST') { const id = path.split('/').pop(); const r = await g2aFetch(`/api/admin/v1/accounts/device/${id}/poll`, { method: 'POST' }); return send(res, r.status, await r.text()); }
      if (path === '/admin/convert' && req.method === 'POST') {
        const raw = await readBody(req);
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
        const raw = await readBody(req); let p; try { p = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const ids = p.ids || []; const results = [];
        for (const id of ids) { try { const r = await g2aFetch(`/api/admin/v1/accounts/${id}`, { method: 'DELETE' }); results.push({ id, ok: r.status < 400 }); } catch (e) { results.push({ id, ok: false, error: e.message }); } }
        return send(res, 200, { deleted: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
      }
      if (path === '/admin/accounts/refresh-token' && req.method === 'POST') {
        const raw = await readBody(req); let p; try { p = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const ids = p.ids || []; const results = [];
        for (const id of ids) { try { const r = await g2aFetch(`/api/admin/v1/accounts/${id}/refresh-token`, { method: 'POST' }); results.push({ id, ok: r.status < 400 }); } catch (e) { results.push({ id, ok: false, error: e.message }); } }
        return send(res, 200, { refreshed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
      }
      if (path === '/admin/testchat' && req.method === 'POST') {
        const raw = await readBody(req); let p; try { p = JSON.parse(raw); } catch { p = {}; }
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
            return send(res, up.status, { error: errTxt.slice(0, 800), status: up.status });
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
        const j = await up.json().catch(async () => ({ raw: await up.text() }));
        if (!up.ok) return send(res, up.status, { error: j?.error?.message || j?.error || j, status: up.status });
        return send(res, 200, { reply: j?.choices?.[0]?.message?.content || JSON.stringify(j), usage: j?.usage || null, model: r.upstreamModel, provider: r.prefix, type: r.provider.type || 'openai' });
      }
      if (path.startsWith('/admin/proxy/')) { const apiPath = path.replace('/admin/proxy', ''); const r = await g2aFetch(apiPath, req.method !== 'GET' ? { method: req.method, body: await readBody(req) } : {}); return send(res, r.status, await r.text()); }
      
      if (path === '/admin/providers/probe-credits' && req.method === 'POST') {
        const raw = await readBody(req); let p; try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
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
              max_tokens: 4,
              stream: true,
              stream_options: { include_usage: true },
            };
            const up = await forwardCodebuddy(provider, model, payload, { forceNonStream: true });
            const txt = await up.text();
            const latencyMs = Date.now() - started;
            if (!up.ok) {
              const exhausted = isCreditsExhaustedError(up.status, txt);
              recordProviderKeyUsage(prefix, k.id, {
                incRequest: true, incFailed: true,
                status: exhausted ? 'exhausted' : 'error',
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

      // ============================================================
      // /admin/backup — Export full config (providers, stats, budgets)
      // GET → returns JSON download for user to save
      // ============================================================
      if (path === '/admin/backup' && req.method === 'GET') {
        try {
          const providers = safeReadJSON(PROVIDERS_FILE, {});
          const stats = safeReadJSON(KEY_STATS_FILE, {});
          const dump = {
            version: 1,
            exportedAt: new Date().toISOString(),
            gateway: { version: process.env.KI_GATEWAY_VERSION || 'v1.0.0' },
            providers,
            keyStats: stats,
          };
          auditLog('backup', 'config', `exported ${Object.keys(providers.providers || {}).length} providers`);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="ki-gateway-backup-${new Date().toISOString().slice(0,10)}.json"`,
          });
          return res.end(JSON.stringify(dump, null, 2));
        } catch (e) { return send(res, 500, { error: e.message }); }
      }

      // ============================================================
      // /admin/restore — Import config backup (validates version + shape)
      // POST body: full backup JSON
      // ============================================================
      if (path === '/admin/restore' && req.method === 'POST') {
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw);
          if (!body || body.version !== 1) {
            return send(res, 400, { error: 'invalid backup version (expected 1)' });
          }
          if (!body.providers || typeof body.providers !== 'object') {
            return send(res, 400, { error: 'backup missing providers section' });
          }
          const preview = url.searchParams.get('preview') === '1';
          if (preview) {
            return send(res, 200, {
              preview: true,
              providers: Object.keys(body.providers.providers || {}).length,
              exportedAt: body.exportedAt,
            });
          }
          // Actual restore — backup current first
          const ts = Date.now();
          if (existsSync(PROVIDERS_FILE)) {
            writeFileSync(`${PROVIDERS_FILE}.bak.restore.${ts}`, readFileSync(PROVIDERS_FILE));
          }
          if (body.keyStats && existsSync(KEY_STATS_FILE)) {
            writeFileSync(`${KEY_STATS_FILE}.bak.restore.${ts}`, readFileSync(KEY_STATS_FILE));
          }
          writeFileSync(PROVIDERS_FILE, JSON.stringify(body.providers, null, 2));
          if (body.keyStats) writeFileSync(KEY_STATS_FILE, JSON.stringify(body.keyStats, null, 2));
          loadProviders();
          loadKeyStats();
          auditLog('restore', 'config', `imported ${Object.keys(body.providers.providers || {}).length} providers`);
          return send(res, 200, {
            ok: true,
            restored: {
              providers: Object.keys(body.providers.providers || {}).length,
              keyStats: !!body.keyStats,
            },
            backupSaved: `.bak.restore.${ts}`,
          });
        } catch (e) { return send(res, 400, { error: 'restore failed: ' + e.message }); }
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
          const raw = await readBody(req);
          const body = JSON.parse(raw);
          const prefix = String(body.prefix || '');
          const budget = Number(body.budget) || 0;
          const action = ['alert', 'disable', 'none'].includes(body.budgetAction) ? body.budgetAction : 'alert';
          const providers = safeReadJSON(PROVIDERS_FILE, {});
          if (!providers.providers || !providers.providers[prefix]) {
            return send(res, 404, { error: 'provider not found' });
          }
          providers.providers[prefix].budget = budget;
          providers.providers[prefix].budgetAction = action;
          writeFileSync(PROVIDERS_FILE, JSON.stringify(providers, null, 2));
          loadProviders();
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
            const r = await undiciFetch(testUrl, {
              method: 'GET',
              signal: controller.signal,
              headers: pickProviderKey(pfx) ? { Authorization: `Bearer ${pickProviderKey(pfx)}` } : {},
            });
            clearTimeout(timeout);
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
      // /admin/events — SSE real-time push (stats snapshot every 5s)
      // Client uses EventSource() to subscribe.
      // ============================================================
      if (path === '/admin/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
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
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
          return res.end(lines.join('\n') + '\n');
        } catch (e) { return send(res, 500, { error: e.message }); }
      }

      // Add model to a provider
      if (path === '/admin/providers/models/add' && req.method === 'POST') {
        const raw = await readBody(req); let p;
        try { p = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const prefix = String(p.prefix || '').trim().toLowerCase();
        const id = String(p.id || '').trim();
        const label = String(p.label || p.id || '').trim();
        if (!prefix || !id) return send(res, 400, { error: 'prefix and id required' });
        const provider = PROVIDERS[prefix];
        if (!provider) return send(res, 404, { error: 'provider not found' });
        if (!Array.isArray(provider.models)) provider.models = [];
        if (provider.models.some(m => (m.id || m) === id)) return send(res, 409, { error: 'model already exists' });
        provider.models.push({ id, label });
        persistProviders();
        auditLog('model.add', prefix+':'+id, { label });
        return send(res, 200, { ok: true, prefix, id, label });
      }
      // Test a specific model on a provider
      if (path === '/admin/providers/test-model' && req.method === 'POST') {
        const raw = await readBody(req); let p;
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
          await pickProviderKey(provider, prefix);
          // Use max_tokens:1 — model validation only, minimal cost
          const upstreamRes = await callProviderChat(provider, model, {
            model,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
            stream: false
          });
          const latencyMs = Date.now() - started;
          const status = upstreamRes?.status || 0;
          if (!upstreamRes || status >= 400) {
            const errTxt = upstreamRes ? await upstreamRes.text().catch(()=>'') : 'no response';
            const errStr = String(errTxt || '');
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
          const j = await upstreamRes.json().catch(()=>null);
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
    // Retry transient failures; non-stream only (streams can't be replayed).
  // Re-picks provider key each attempt (rotation for multi-key providers).
  async function fetchUpstreamWithRetry(r, payload) {
    const isStream = !!payload?.stream;
    const maxAttempt = isStream ? 1 : RETRY_ATTEMPTS;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempt; attempt++) {
      if (attempt > 1 && RETRY_DELAY_MS) await new Promise(rs => setTimeout(rs, RETRY_DELAY_MS + Math.floor(Math.random()*150)));
      try {
        await pickProviderKey(r.provider, r.prefix);
        const upstreamRes = await fetchUpstreamWithRetry(r, payload);
        if (RETRY_STATUSES.has(upstreamRes.status) && attempt < maxAttempt) {
          try { upstreamRes.body?.cancel?.(); } catch {}
          log('warn', 'provider-retry', { model: payload.model, provider: r.provider.name, status: upstreamRes.status, attempt: attempt + 1 });
          continue;
        }
        if (attempt > 1) log('info', 'provider-retry-done', { model: payload.model, provider: r.provider.name, status: upstreamRes.status, attempts: attempt });
        return upstreamRes;
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e);
        const transient = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|other side closed|aborted/i.test(msg);
        if (transient && attempt < maxAttempt) { log('warn', 'provider-retry', { model: payload.model, provider: r.provider.name, error: msg.slice(0,80), attempt: attempt + 1 }); continue; }
        throw e;
      }
    }
    throw lastErr || new Error('upstream failed after retries');
  }

  if (path === '/v1/chat/completions' && req.method === 'POST') {
      if (!authOk(req)) return send(res, 401, { error: { message: 'invalid gateway key', type: 'auth_error' } });
      const raw = await readBody(req); let payload;
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
      if (!pickProviderKey(r.provider, r.prefix || '')) {
        pushRequestLog({
          provider: r.prefix, model: payload?.model || r.upstreamModel, status: 400, ok: false, latencyMs: Date.now() - started,
          error: 'no api key', preview: summarizeMessages(payload?.messages), stream: !!payload?.stream,
        });
        return send(res, 400, { error: { message: `provider ${r.prefix} has no api key`, type: 'invalid_request_error' } });
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
          keyId: r.provider.__lastKeyId || '',
          keyMasked: maskKeyHint(r.provider.__lastKey || ''),
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
  } catch (e) { try { send(res, 502, { error: { message: `gateway error: ${e.message}`, type: 'gateway_error' } }); } catch {} }
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));

// fallback if dashboard.html missing (minimal English; primary is external file)
const DASHBOARD_HTML_FALLBACK = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>KiRouter</title><style>body{background:#0a0d12;color:#e8eef5;font:14px system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#141921;border:1px solid #252d3d;border-radius:12px;padding:32px;width:360px}input{width:100%;padding:10px;background:#0f1319;border:1px solid #252d3d;color:#fff;border-radius:8px;margin:12px 0}button{width:100%;padding:10px;background:#3b82f6;color:#fff;border:0;border-radius:8px;cursor:pointer}h2{margin:0 0 8px;font-size:18px}p{color:#7a8699;font-size:13px;margin:0 0 16px}.err{color:#f5535f;font-size:12px;margin-top:8px}</style></head><body><div class="card"><h2>KiRouter</h2><p>Multi-provider LLM Gateway</p><input type="password" id="k" placeholder="Gateway key" onkeydown="if(event.key==='Enter')login()"><button onclick="login()">Login</button><div class="err" id="e"></div></div><script>async function login(){const k=document.getElementById('k').value;const r=await fetch('/admin/summary',{headers:{Authorization:'Bearer '+k}});if(r.ok){document.cookie='kigw_key='+k+';path=/;max-age=86400';location.reload()}else{document.getElementById('e').textContent='Invalid key'}}</script></body></html>`;

loadKeyStats();
loadRequestLog();
server.listen(PORT, HOST, () => {
  console.log('ki-gateway v4.1 listening on http://' + HOST + ':' + PORT);
  console.log('providers: ' + Object.keys(PROVIDERS).join(', '));
  console.log('providers file: ' + PROVIDERS_FILE);
});
