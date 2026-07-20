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
const PORT = parseInt(process.env.KIGW_PORT || '8090', 10);
const HOST = process.env.KIGW_HOST || '127.0.0.1';
const PROVIDERS_FILE = pathResolve(__dirname, 'providers.json');
const DASHBOARD_FILE = pathResolve(__dirname, 'dashboard.html');
// Upstream retry (transient 5xx + network errors)
const RETRY_ATTEMPTS = Math.max(1, Math.min(4, parseInt(process.env.KIGW_RETRY_ATTEMPTS || '2', 10) || 2));
const RETRY_STATUSES = new Set((process.env.KIGW_RETRY_STATUSES || '500,502,503,504,529').split(',').map(x => parseInt(x.trim(), 10)).filter(Boolean));
const RETRY_DELAY_MS = Math.max(0, parseInt(process.env.KIGW_RETRY_DELAY_MS || '350', 10) || 0);
const KEY_STATS_FILE = pathResolve(__dirname, 'provider-key-stats.json');
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
const REQUEST_LOG_FILE = pathResolve(__dirname, 'request-log.json');
const DB_FILE = pathResolve(__dirname, 'ki-gateway.db');
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
const GATEWAY_KEY = read(pathResolve(__dirname, '.gateway_key'));
const GROK_UPSTREAM_KEY = read(pathResolve(__dirname, '.upstream_key'));
const G2A_USER = read(pathResolve(__dirname, '.g2a_user'));
const G2A_PASS = read(pathResolve(__dirname, '.g2a_pass'));
const G2A_BASE = process.env.G2A_BASE || 'http://127.0.0.1:8010';

if (!GATEWAY_KEY) { console.error('FATAL: no gateway key'); process.exit(1); }

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
  return tok && tok === GATEWAY_KEY;
}
function dashAuthOk(req, url) {
  const q = url.searchParams.get('key');
  if (q && q === GATEWAY_KEY) return true;
  const cookie = req.headers['cookie'] || '';
  const m = cookie.match(/kigw_key=([^;]+)/);
  return m && m[1] === GATEWAY_KEY;
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
      version: process.env.KI_GATEWAY_VERSION || 'v1.0.1',
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
      if (path === '/admin/session' && req.method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': `kigw_key=${GATEWAY_KEY}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` });

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
          gateway: { version: process.env.KI_GATEWAY_VERSION || 'v1.0.1', providerCount: Object.keys(PROVIDERS).length },
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
            gateway: { version: process.env.KI_GATEWAY_VERSION || 'v1.0.1' },
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

// fallback if dashboard.html missing (kept minimal; primary is external file)
const DASHBOARD_HTML_FALLBACK = "<!DOCTYPE html>\n<html lang=\"id\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>ki-gateway</title>\n<style>\n:root{\n  --bg:#0a0d12;--bg2:#0f1319;--card:#141921;--card2:#1a2030;--bd:#252d3d;--bd2:#1e2533;\n  --fg:#e8eef5;--mut:#7a8699;--mut2:#5a6478;--acc:#5b9bf5;--acc2:#3b7dd4;\n  --ok:#2fd16a;--warn:#f0a93b;--err:#f5535f;--purple:#a472e8;--cyan:#4dd6c8;\n  --shadow:0 4px 24px rgba(0,0,0,.4);--radius:14px;\n}\n*{box-sizing:border-box;margin:0;padding:0}\nbody{background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh}\n::-webkit-scrollbar{width:7px;height:7px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#2a3445;border-radius:4px}\n.sidebar{position:fixed;left:0;top:0;bottom:0;width:220px;background:var(--bg2);border-right:1px solid var(--bd);display:flex;flex-direction:column;z-index:100;transition:transform .3s}\n.sidebar-brand{padding:18px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--bd)}\n.sidebar-brand .logo{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#5b9bf5,#a472e8);display:flex;align-items:center;justify-content:center;font-size:18px}\n.sidebar-brand .title{font-size:15px;font-weight:700}\n.sidebar-brand .sub{font-size:10px;color:var(--mut);font-weight:500}\n.nav{flex:1;padding:10px 8px;overflow-y:auto}\n.nav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;cursor:pointer;color:var(--mut);font-size:13px;font-weight:500;transition:.15s;margin-bottom:2px}\n.nav-item:hover{background:var(--card);color:var(--fg)}\n.nav-item.active{background:var(--card2);color:var(--acc)}\n.nav-item .ic{width:18px;text-align:center;font-size:15px}\n.nav-section{font-size:10px;color:var(--mut2);text-transform:uppercase;letter-spacing:1px;padding:14px 12px 6px;font-weight:600}\n.sidebar-foot{padding:10px 12px;border-top:1px solid var(--bd);font-size:11px;color:var(--mut2)}\n.main{margin-left:220px;min-height:100vh}\n.topbar{position:sticky;top:0;z-index:50;background:rgba(10,13,18,.85);backdrop-filter:blur(12px);border-bottom:1px solid var(--bd);padding:12px 24px;display:flex;align-items:center;gap:14px}\n.topbar h1{font-size:17px;font-weight:700;flex:1}\n.pill{font-size:11px;padding:3px 10px;border-radius:99px;font-weight:600;display:flex;align-items:center;gap:5px}\n.pill.ok{background:#2fd16a15;color:var(--ok)}.pill.err{background:#f5535f15;color:var(--err)}\n.dot{width:7px;height:7px;border-radius:50%;display:inline-block}\n.dot.ok{background:var(--ok);box-shadow:0 0 6px var(--ok)}.dot.err{background:var(--err)}\n.btn{background:var(--card2);color:var(--fg);border:1px solid var(--bd);padding:7px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;transition:.15s;display:inline-flex;align-items:center;gap:6px}\n.btn:hover{background:var(--bd);border-color:#3a4458}.btn:disabled{opacity:.4;cursor:not-allowed}\n.btn.primary{background:var(--acc2);border-color:var(--acc2);color:#fff}.btn.primary:hover{background:var(--acc)}\n.btn.sm{padding:5px 10px;font-size:11px}\n.content{padding:24px;max-width:1400px;margin:0 auto}\n.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:24px}\n.stat-card{background:var(--card);border:1px solid var(--bd);border-radius:var(--radius);padding:18px;position:relative;overflow:hidden}\n.stat-card .label{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.8px;font-weight:600}\n.stat-card .value{font-size:30px;font-weight:800;margin-top:6px;letter-spacing:-1px}\n.stat-card .sub{font-size:11px;color:var(--mut2);margin-top:4px}\n.stat-card .ic{position:absolute;top:14px;right:14px;width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px}\n.panel{background:var(--card);border:1px solid var(--bd);border-radius:var(--radius);margin-bottom:18px;overflow:hidden}\n.panel-head{padding:16px 20px;border-bottom:1px solid var(--bd2);display:flex;align-items:center;gap:10px}\n.panel-head h2{font-size:14px;font-weight:700;flex:1}\n.panel-head .count{font-size:11px;color:var(--mut);background:var(--bg2);padding:2px 8px;border-radius:99px}\n.panel-body{padding:18px 20px}\n.usage-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}\n.usage-item{text-align:center;padding:12px;background:var(--bg2);border-radius:10px;border:1px solid var(--bd2)}\n.usage-item .v{font-size:20px;font-weight:700}.usage-item .k{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-top:2px}\n.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}\n.search-input{background:var(--bg2);border:1px solid var(--bd);color:var(--fg);border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;min-width:200px;flex:1}\n.search-input:focus{outline:none;border-color:var(--acc)}\n.tab{padding:6px 14px;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600;border:1px solid var(--bd);background:var(--bg2);transition:.15s}\n.tab:hover{background:var(--card2)}.tab.active{background:var(--acc2);border-color:var(--acc2);color:#fff}\n.table-wrap{overflow:auto;max-height:520px;border-radius:8px}\ntable{width:100%;border-collapse:collapse;font-size:12px}\nth{text-align:left;padding:10px 12px;color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;background:var(--bg2);position:sticky;top:0}\ntd{padding:9px 12px;border-bottom:1px solid var(--bd2)}tr:hover td{background:var(--bg2)}\n.badge{font-size:10px;padding:2px 8px;border-radius:99px;font-weight:600;display:inline-block}\n.badge.build{background:#f0a93b15;color:var(--warn)}.badge.web{background:#5b9bf515;color:var(--acc)}\n.badge.active{background:#2fd16a15;color:var(--ok)}.badge.error{background:#f5535f15;color:var(--err)}.badge.disabled{background:#5a647815;color:var(--mut)}\n.qbar{width:60px;height:5px;border-radius:3px;background:var(--bd);overflow:hidden;display:inline-block;vertical-align:middle;margin-right:4px}\n.qbar .fill{height:100%;border-radius:3px}.qbar .fill.h{background:var(--ok)}.qbar .fill.m{background:var(--warn)}.qbar .fill.l{background:var(--err)}\n.chat-box{background:var(--bg2);border:1px solid var(--bd);border-radius:10px;padding:14px;min-height:80px;margin-top:10px;font-size:13px;white-space:pre-wrap;word-break:break-word}\n.chat-box.empty{color:var(--mut);font-style:italic}\ntextarea,select,input[type=text],input[type=password]{background:var(--bg2);border:1px solid var(--bd);color:var(--fg);border-radius:8px;padding:7px 12px;font:inherit;font-size:13px}\ntextarea:focus,select:focus,input:focus{outline:none;border-color:var(--acc)}\n.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center}\n.login-card{background:var(--card);border:1px solid var(--bd);border-radius:var(--radius);padding:32px;width:360px;box-shadow:var(--shadow)}\n.login-card .logo{width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#5b9bf5,#a472e8);display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:16px}\n.egress-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}\n.model-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}\n.model-item{background:var(--bg2);border:1px solid var(--bd2);border-radius:8px;padding:12px}\n.model-item .mid{font-weight:700;font-size:13px}.model-item .meta{font-size:11px;color:var(--mut);margin-top:4px}\n.mobile-toggle{display:none}\n@media(max-width:768px){.sidebar{transform:translateX(-220px)}.sidebar.open{transform:translateX(0)}.main{margin-left:0}.mobile-toggle{display:flex}.stats-grid{grid-template-columns:repeat(2,1fr)}.content{padding:14px}}\n\n/* Providers catalog (9router-style) */\n.prov-top{display:flex;align-items:flex-start;gap:14px;margin-bottom:18px;flex-wrap:wrap}\n.prov-top .title-block{flex:1;min-width:220px}\n.prov-top .title-block h2{font-size:20px;font-weight:800;letter-spacing:-.3px}\n.prov-top .title-block p{font-size:13px;color:var(--mut);margin-top:2px}\n.prov-search{background:var(--bg2);border:1px solid var(--bd);color:var(--fg);border-radius:10px;padding:9px 12px;font:inherit;font-size:13px;min-width:220px;width:min(320px,100%)}\n.prov-search:focus{outline:none;border-color:var(--acc)}\n.prov-sec{margin-bottom:22px}\n.prov-sec-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}\n.prov-sec-head h3{font-size:15px;font-weight:700;flex:1}\n.prov-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}\n.prov-card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px;display:flex;align-items:center;gap:12px;transition:.15s;min-height:74px}\n.prov-card:hover{border-color:#3a4a66;background:var(--card2)}\n.prov-card.connected{border-color:#2fd16a40}\n.prov-ico{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;flex-shrink:0;background:var(--bg2);border:1px solid var(--bd2)}\n.prov-meta{flex:1;min-width:0}\n.prov-name{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.prov-status{font-size:11px;color:var(--mut);margin-top:2px;display:flex;align-items:center;gap:5px}\n.prov-status .sdot{width:7px;height:7px;border-radius:50%;background:var(--mut2);display:inline-block}\n.prov-status .sdot.ok{background:var(--ok);box-shadow:0 0 6px var(--ok)}\n.prov-status .sdot.err{background:var(--err)}\n.prov-actions{display:flex;gap:6px;flex-shrink:0}\n.btn.ghost{background:transparent;border:1px solid var(--bd);color:var(--fg)}\n.btn.ghost:hover{background:var(--bg2);border-color:var(--acc);color:var(--acc)}\n.modal-back{position:fixed;inset:0;background:rgba(0,0,0,.62);backdrop-filter:blur(4px);z-index:200;display:flex;align-items:center;justify-content:center;padding:18px}\n.modal{background:var(--card);border:1px solid var(--bd);border-radius:16px;width:min(560px,100%);max-height:90vh;overflow:auto;box-shadow:var(--shadow)}\n.modal-head{padding:16px 18px;border-bottom:1px solid var(--bd2);display:flex;align-items:center;gap:10px}\n.modal-head h3{font-size:15px;font-weight:700;flex:1}\n.modal-body{padding:16px 18px}\n.modal-foot{padding:14px 18px;border-top:1px solid var(--bd2);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}\n.field{margin-bottom:12px}\n.field label{display:block;font-size:11px;color:var(--mut);margin-bottom:4px;font-weight:600}\n.field input,.field select,.field textarea{width:100%}\n.chip-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}\n.chip{padding:6px 12px;border-radius:99px;border:1px solid var(--bd);background:var(--bg2);font-size:12px;font-weight:600;cursor:pointer;color:var(--mut)}\n.chip.active{background:var(--acc2);border-color:var(--acc2);color:#fff}\n.hint{font-size:12px;color:var(--mut2);margin-top:4px}\n\n\n\n\n/* Compact provider/account chips (9router-style) */\n.chipbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px}\n.chipbar .clabel{font-size:11px;color:var(--mut);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-right:2px}\n.pchip{padding:5px 11px;border-radius:99px;border:1px solid var(--bd);background:var(--bg2);font-size:12px;font-weight:600;cursor:pointer;color:var(--mut);transition:.12s;user-select:none;display:inline-flex;align-items:center;gap:5px;line-height:1.2}\n.pchip:hover{border-color:#3a4a66;color:var(--fg);background:var(--card2)}\n.pchip.active{background:var(--acc2);border-color:var(--acc2);color:#fff}\n.pchip .n{font-size:10px;opacity:.85;font-weight:700}\n.pchip.active .n{opacity:1}\n.hchip{padding:4px 10px;border-radius:99px;border:1px solid var(--bd);background:transparent;font-size:11px;font-weight:600;cursor:pointer;color:var(--mut);transition:.12s}\n.hchip:hover{border-color:#3a4a66;color:var(--fg)}\n.hchip.active{background:var(--card2);border-color:var(--acc);color:var(--acc)}\n\n/* Usage analytics */\n.usage-head{display:flex;align-items:flex-start;gap:14px;margin-bottom:18px;flex-wrap:wrap}\n.usage-head .title-block{flex:1;min-width:220px}\n.usage-head .title-block h2{font-size:20px;font-weight:800;letter-spacing:-.3px}\n.usage-head .title-block p{font-size:13px;color:var(--mut);margin-top:2px}\n.usage-metric-tabs{display:flex;gap:6px;flex-wrap:wrap}\n.chart-wrap{padding:8px 0 4px}\n.chart-bars{display:flex;align-items:flex-end;gap:3px;height:160px}\n.chart-col{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;height:100%;justify-content:flex-end;position:relative}\n.chart-col .bar{width:100%;max-width:22px;border-radius:4px 4px 0 0;background:linear-gradient(180deg,var(--acc),var(--acc2));min-height:2px;transition:.15s}\n.chart-col:hover .bar{filter:brightness(1.15)}\n.chart-col .bar.tok{background:linear-gradient(180deg,var(--purple),#6d4bb8)}\n.chart-col .bar.cost{background:linear-gradient(180deg,var(--cyan),#2aa89c)}\n.chart-col .lbl{font-size:9px;color:var(--mut2);margin-top:6px;white-space:nowrap}\n.chart-col .tip{display:none;position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:var(--card2);border:1px solid var(--bd);padding:6px 8px;border-radius:8px;font-size:10px;white-space:nowrap;z-index:5;box-shadow:var(--shadow)}\n.chart-col:hover .tip{display:block}\n.split-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:14px}\n@media(max-width:980px){.split-grid{grid-template-columns:1fr}}\n.share-bar{height:6px;border-radius:99px;background:var(--bd);overflow:hidden;min-width:80px}\n.share-bar .fill{height:100%;border-radius:99px;background:var(--acc)}\n.kpi-sub{font-size:11px;color:var(--mut2);margin-top:4px}\n.fail-ok{display:flex;gap:8px;align-items:center;margin-top:8px}\n.fail-ok .seg{height:8px;border-radius:99px;flex:1;background:var(--bd);overflow:hidden;display:flex}\n.fail-ok .seg .ok{background:var(--ok)}.fail-ok .seg .bad{background:var(--err)}\n\n/* Quota tracker */\n.qcard{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px}\n.qcard.low{border-color:#f0a93b66}\n.qcard.bad{border-color:#f5535f66}\n.qcard .qtitle{font-size:13px;font-weight:700;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.qcard .qsub{font-size:11px;color:var(--mut);margin-bottom:10px}\n.qcard .qbar-lg{height:8px;border-radius:99px;background:var(--bd);overflow:hidden;margin-bottom:8px}\n.qcard .qbar-lg .fill{height:100%;border-radius:99px}\n.qgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}\n\n.hidden{display:none!important}\n</style>\n</head>\n<body>\n\n<div class=\"login-wrap\" id=\"loginScreen\">\n  <div class=\"login-card\">\n    <div class=\"logo\">\ud83c\udf19</div>\n    <h2 style=\"font-size:18px;font-weight:700;margin-bottom:4px\">ki-gateway</h2>\n    <p style=\"font-size:13px;color:var(--mut);margin-bottom:18px\">Masukkan gateway key untuk akses dashboard.</p>\n    <input type=\"password\" id=\"keyInput\" placeholder=\"kigw_...\" style=\"width:100%;margin-bottom:12px\" onkeydown=\"if(event.key==='Enter')doLogin()\">\n    <button class=\"btn primary\" style=\"width:100%\" onclick=\"doLogin()\">Masuk</button>\n    <p id=\"loginErr\" style=\"color:var(--err);font-size:12px;margin-top:10px\"></p>\n  </div>\n</div>\n\n<div id=\"app\" class=\"hidden\">\n<div class=\"sidebar\" id=\"sidebar\">\n  <div class=\"sidebar-brand\">\n    <div class=\"logo\">\ud83c\udf19</div>\n    <div><div class=\"title\">ki-gateway</div><div class=\"sub\" id=\"sbVersion\">v3</div></div>\n  </div>\n  <nav class=\"nav\">\n    <div class=\"nav-section\">Dashboard</div>\n    <a class=\"nav-item active\" data-page=\"overview\" onclick=\"goPage('overview')\"><span class=\"ic\">\ud83d\udcca</span> Overview</a>\n    <a class=\"nav-item\" data-page=\"accounts\" onclick=\"goPage('accounts')\"><span class=\"ic\">\ud83d\udccb</span> Accounts</a>\n    <a class=\"nav-item\" data-page=\"quota\" onclick=\"goPage('quota')\"><span class=\"ic\">\ud83d\udd0b</span> Quota Tracker</a>\n    <a class=\"nav-item\" data-page=\"usage\" onclick=\"goPage('usage')\"><span class=\"ic\">\ud83d\udcc8</span> Usage</a>\n    <div class=\"nav-section\">Tools</div>\n    <a class=\"nav-item\" data-page=\"chat\" onclick=\"goPage('chat')\"><span class=\"ic\">\ud83d\udcac</span> Test Chat</a>\n    <a class=\"nav-item\" data-page=\"convert\" onclick=\"goPage('convert')\"><span class=\"ic\">\ud83d\udd04</span> Convert</a>\n    <div class=\"nav-section\">System</div>\n    <a class=\"nav-item\" data-page=\"providers\" onclick=\"goPage('providers')\"><span class=\"ic\">\ud83d\udd0c</span> Providers</a>\n    <a class=\"nav-item\" data-page=\"models\" onclick=\"goPage('models')\"><span class=\"ic\">\ud83e\udde9</span> Models</a>\n    <a class=\"nav-item\" data-page=\"egress\" onclick=\"goPage('egress')\"><span class=\"ic\">\ud83c\udf10</span> Proxies</a>\n    <a class=\"nav-item\" data-page=\"keys\" onclick=\"goPage('keys')\"><span class=\"ic\">\ud83d\udd11</span> API Keys</a>\n  </nav>\n  <div class=\"sidebar-foot\" id=\"sbFoot\">\u2014</div>\n</div>\n<div class=\"main\">\n  <div class=\"topbar\">\n    <button class=\"btn sm mobile-toggle\" onclick=\"toggleSidebar()\">\u2630</button>\n    <h1 id=\"pageTitle\">Overview</h1>\n    <span class=\"pill ok\" id=\"statusPill\"><span class=\"dot ok\"></span> Online</span>\n    <button class=\"btn sm\" onclick=\"refreshAll()\">\u21bb Refresh</button>\n  </div>\n  <div class=\"content\" id=\"pageContent\"></div>\n</div>\n</div>\n\n<script>\nlet KEY = localStorage.getItem('kigw_key') || '';\nlet SUM = null, ACCS = null, EGRESS = null, RECENT_REQ = null;\nlet CUR_PAGE = 'overview', CUR_TAB = 'all', SEARCH = '';\n\nconst $ = s => document.querySelector(s);\nconst hdr = () => ({'Authorization':'Bearer '+KEY,'Content-Type':'application/json'});\n\nasync function doLogin(){\n  KEY = document.getElementById('keyInput').value.trim();\n  if(!KEY) return;\n  try{\n    const r = await fetch('/admin/summary',{headers:hdr()});\n    if(r.ok){\n      localStorage.setItem('kigw_key',KEY);\n      document.cookie='kigw_key='+KEY+';path=/;max-age=86400;SameSite=Strict';\n      document.getElementById('loginScreen').classList.add('hidden');\n      document.getElementById('app').classList.remove('hidden');\n      await init();\n    } else {\n      document.getElementById('loginErr').textContent = 'Key salah atau gateway error.';\n    }\n  }catch(e){ document.getElementById('loginErr').textContent = 'Error: '+e.message; }\n}\n\nasync function init(){\n  try{\n    const h = await fetch('/health').then(r=>r.json());\n    document.getElementById('sbVersion').textContent = 'v'+(h.version||'3');\n    document.getElementById('sbFoot').textContent = h.providers.join(', ')+' - '+new Date().toLocaleTimeString('id-ID');\n    await refreshAll();\n    setInterval(refreshAll, 30000);\n  }catch(e){ console.error(e); }\n}\n\nasync function loadEgress(){\n  const r = await fetch('/admin/egress',{headers:hdr()}).then(r=>r.json());\n  EGRESS = r.items||[];\n}\n\nasync function refreshAll(){\n  try{\n    const [s,a] = await Promise.all([\n      fetch('/admin/summary',{headers:hdr()}).then(r=>r.json()),\n      fetch('/admin/accounts',{headers:hdr()}).then(r=>r.json())\n    ]);\n    SUM = s; ACCS = a.items || [];\n    if(CUR_PAGE==='egress'){ await loadEgress(); }\n    renderPage();\n  }catch(e){\n    const p=document.getElementById('statusPill');\n    if(p){p.className='pill err';p.innerHTML='<span class=\"dot err\"></span> Error';}\n  }\n}\n\nfunction goPage(p){\n  if(CUR_TAB==='gateway') CUR_TAB='all';\n  CUR_PAGE = p;\n  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.page===p));\n  const titles={overview:'Overview',accounts:'Accounts',quota:'Quota Tracker',usage:'Usage',chat:'Test Chat',convert:'Convert Web to Build',providers:'Providers',models:'Models',egress:'Proxies',keys:'API Keys'};\n  document.getElementById('pageTitle').textContent = titles[p]||p;\n  document.getElementById('sidebar').classList.remove('open');\n  if(p==='egress' && !EGRESS){ loadEgress().then(()=>renderEgress()); return; }\n  renderPage();\n}\nfunction toggleSidebar(){ document.getElementById('sidebar').classList.toggle('open'); }\n\nfunction renderPage(){\n  if(!SUM) return;\n  const pages={overview:renderOverview,accounts:renderAccounts,quota:renderQuotaTracker,usage:renderUsage,chat:renderChat,convert:renderConvert,providers:renderProviders,models:renderModels,egress:renderEgress,keys:renderKeys};\n  (pages[CUR_PAGE]||renderOverview)();\n}\n\nfunction fmtNum(n){ return (n||0).toLocaleString('id-ID'); }\nfunction fmtPct(n){ return (Math.round((n||0)*10)/10)+'%'; }\nfunction fmtTok(n){\n  n = Number(n)||0;\n  if(n >= 1e9) return (n/1e9).toFixed(2)+'B';\n  if(n >= 1e6) return (n/1e6).toFixed(2)+'M';\n  if(n >= 1e3) return (n/1e3).toFixed(1)+'K';\n  return fmtNum(n);\n}\nfunction fmtCostTicks(ticks){\n  // grok2api billedCostUsdTicks \u2192 approx USD (1e9 ticks = $1)\n  var usd = (Number(ticks)||0) / 1e9;\n  if(usd <= 0) return '$0';\n  if(usd < 0.01) return '$'+usd.toFixed(4);\n  if(usd < 10) return '$'+usd.toFixed(3);\n  return '$'+usd.toLocaleString('en-US',{maximumFractionDigits:2});\n}\nfunction hourLabel(iso){\n  if(!iso) return '\u2014';\n  try{\n    var d = new Date(iso);\n    // show WIT-ish local host time hour\n    return d.toLocaleTimeString('id-ID',{hour:'2-digit', hour12:false})+':00';\n  }catch(e){ return String(iso).slice(11,16); }\n}\nfunction dayLabel(iso){\n  if(!iso) return '';\n  try{ return new Date(iso).toLocaleDateString('id-ID',{day:'2-digit',month:'short'}); }catch(e){ return ''; }\n}\n\nfunction qClass(pct){ return pct>50?'h':pct>20?'m':'l'; }\nfunction timeAgo(ts){ if(!ts) return '\u2014'; const d=new Date(ts); const s=Math.floor((Date.now()-d)/1000); if(s<60)return s+'s'; if(s<3600)return Math.floor(s/60)+'m'; if(s<86400)return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }\nfunction timeUntil(ts){ if(!ts) return '\u2014'; const d=new Date(ts); const s=Math.floor((d-Date.now())/1000); if(s<=0)return 'now'; if(s<3600)return Math.floor(s/60)+'m'; if(s<86400)return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }\n\nfunction renderOverview(){\n  if(!SUM) return;\n  // load recent if empty so overview multi-provider traffic appears\n  if(RECENT_REQ==null){\n    loadRecentRequests().then(function(){ renderOverview(); });\n  }\n  const a=SUM.accounts||{}, e=SUM.egress||{}, d=SUM.dashboard||{}, u=d.usage||{}, r=d.resources||{};\n  const providers = SUM.providers || [];\n  const recent = RECENT_REQ || [];\n  const gwVer = (SUM.gateway && SUM.gateway.version) || '?';\n\n  // gateway-level recent stats (multi-provider)\n  var okN=0, failN=0, tokN=0, creditN=0;\n  var byProv = {};\n  recent.forEach(function(x){\n    if(x.ok) okN++; else failN++;\n    tokN += Number(x.tokens||0);\n    if(x.credit!=null) creditN += Number(x.credit||0);\n    var p = x.provider || '?';\n    if(!byProv[p]) byProv[p] = {req:0, ok:0, fail:0, tokens:0, credit:0, latency:0};\n    byProv[p].req++;\n    if(x.ok) byProv[p].ok++; else byProv[p].fail++;\n    byProv[p].tokens += Number(x.tokens||0);\n    byProv[p].credit += Number(x.credit||0);\n    byProv[p].latency += Number(x.latencyMs||0);\n  });\n  var totalRecent = recent.length || 1;\n  var successRecent = Math.round((okN/totalRecent)*1000)/10;\n\n  // provider cards\n  var provCards = providers.map(function(p){\n    var st = byProv[p.prefix] || {req:0, ok:0, fail:0, tokens:0, credit:0, latency:0};\n    var keys = (p.enabledKeyCount||0)+'/'+(p.keyCount||0)+' keys';\n    var modelsN = (p.models||[]).length;\n    var on = p.enabled!==false;\n    var avgLat = st.req ? Math.round(st.latency/st.req) : 0;\n    var badge = on ? 'active' : 'disabled';\n    var icon = p.prefix==='cbai' ? '\ud83c\udf10' : (p.prefix==='grok' ? '\u26a1' : '\ud83d\udd0c');\n    return '<div class=\"prov-card '+(on?'connected':'')+'\" style=\"cursor:pointer\" onclick=\"goPage(\\'providers\\')\">'\n      + '<div class=\"prov-ico\">'+icon+'</div>'\n      + '<div class=\"prov-meta\">'\n      + '<div class=\"prov-name\">'+(p.name||p.prefix)+'</div>'\n      + '<div class=\"prov-status\"><span class=\"sdot '+(on?'ok':'err')+'\"></span>'\n      + (on?'connected':'disabled')+' \u00b7 <b>'+p.prefix+'</b> \u00b7 '+(p.type||'openai')\n      + '</div>'\n      + '<div style=\"font-size:11px;color:var(--mut);margin-top:6px;line-height:1.45\">'\n      + keys+' \u00b7 '+modelsN+' models'\n      + (st.req?(' \u00b7 recent <b style=\"color:var(--fg)\">'+st.req+'</b> req'):' \u00b7 no recent req')\n      + (st.tokens?(' \u00b7 '+fmtTok(st.tokens)+' tok'):'')\n      + (st.credit?(' \u00b7 credit '+st.credit.toFixed(3)):'')\n      + (avgLat?(' \u00b7 ~'+fmtMs(avgLat)):'')\n      + '</div></div>'\n      + '<div class=\"prov-actions\"><span class=\"badge '+badge+'\">'+(on?'ON':'OFF')+'</span></div>'\n      + '</div>';\n  }).join('') || '<p style=\"color:var(--mut)\">Belum ada provider. Tambah di menu Providers.</p>';\n\n  // grok account breakdown (still useful)\n  var grokPanel =\n    '<div class=\"usage-grid\">'\n    + '<div class=\"usage-item\"><div class=\"v\">'+fmtNum(a.total)+'</div><div class=\"k\">Total</div></div>'\n    + '<div class=\"usage-item\"><div class=\"v\">'+fmtNum(a.active)+'</div><div class=\"k\">Active</div></div>'\n    + '<div class=\"usage-item\"><div class=\"v\">'+fmtNum(a.build)+'</div><div class=\"k\">Build</div></div>'\n    + '<div class=\"usage-item\"><div class=\"v\">'+fmtNum(a.web)+'</div><div class=\"k\">Web</div></div>'\n    + '<div class=\"usage-item\"><div class=\"v\">'+(e.healthy||0)+'/'+(e.total||0)+'</div><div class=\"k\">Proxies OK</div></div>'\n    + '<div class=\"usage-item\"><div class=\"v\">'+fmtNum(a.errors||0)+'</div><div class=\"k\">Errors</div></div>'\n    + '</div>';\n\n  // models: prefer gateway provider models, fallback g2a models list\n  var modelItems = [];\n  providers.forEach(function(p){\n    (p.models||[]).forEach(function(m){\n      modelItems.push({\n        id: p.prefix+'/'+(m.id||m),\n        provider: p.prefix,\n        label: m.label || m.id || m,\n        enabled: p.enabled!==false\n      });\n    });\n  });\n  if(!modelItems.length && Array.isArray(SUM.models)){\n    modelItems = SUM.models.filter(function(m){return m.available;}).map(function(m){\n      return {id:m.id, provider:m.provider||'grok', label:m.id, enabled:!!m.enabled, accounts:m.accounts};\n    });\n  }\n  var rows = modelItems.slice(0,24).map(function(m){\n    return '<div class=\"model-item\"><div class=\"mid\">'+m.id+'</div><div class=\"meta\">'\n      + (m.provider||'?')\n      + (m.label && m.label!==m.id ? (' \u00b7 '+m.label) : '')\n      + (m.accounts!=null ? (' \u00b7 '+m.accounts+' akun') : '')\n      + ' \u00b7 '+(m.enabled?'enabled':'disabled')\n      + '</div></div>';\n  }).join('') || '<p style=\"color:var(--mut)\">No models</p>';\n\n  // recent mini table\n  var recentRows = recent.slice(0,8).map(function(x){\n    var prev = (x.preview||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');\n    return '<tr>'\n      + '<td style=\"color:var(--mut2);font-size:11px;white-space:nowrap\">'+timeAgo(x.ts)+'</td>'\n      + '<td><span class=\"badge active\">'+(x.provider||'?')+'</span></td>'\n      + '<td style=\"font-weight:600;font-size:12px\">'+(x.model||'\u2014')+'</td>'\n      + '<td>'+(x.ok?'<span class=\"badge active\">'+(x.status||'ok')+'</span>':'<span class=\"badge error\">'+(x.status||'err')+'</span>')+'</td>'\n      + '<td>'+fmtMs(x.latencyMs)+'</td>'\n      + '<td>'+fmtTok(x.tokens||0)+'</td>'\n      + '<td style=\"max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mut);font-size:11px\" title=\"'+prev+'\">'+(prev||'\u2014')+'</td>'\n      + '</tr>';\n  }).join('') || '<tr><td colspan=\"7\" style=\"text-align:center;color:var(--mut);padding:14px\">Belum ada recent request gateway</td></tr>';\n\n  var nonGrokKeys = providers.filter(function(p){return p.prefix!=='grok';}).reduce(function(n,p){return n+(p.keyCount||0);},0);\n  var enabledProv = providers.filter(function(p){return p.enabled!==false;}).length;\n\n  document.getElementById('pageContent').innerHTML =\n    '<div class=\"usage-head\"><div class=\"title-block\"><h2>\ud83c\udfe0 Gateway Overview</h2>'\n    + '<p>Multi-provider snapshot \u00b7 Grok accounts + provider keys + recent traffic</p></div>'\n    + '<span class=\"pill ok\"><span class=\"dot ok\"></span> v'+gwVer+' \u00b7 '+enabledProv+' providers</span></div>'\n\n    + '<div class=\"stats-grid\">'\n    + '<div class=\"stat-card\"><div class=\"ic\">\ud83d\udd0c</div><div class=\"label\">Providers</div><div class=\"value\">'+providers.length+'</div><div class=\"sub\">enabled '+enabledProv+'</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\ud83d\udd11</div><div class=\"label\">Provider Keys</div><div class=\"value\">'+nonGrokKeys+'</div><div class=\"sub\">non-Grok pool (CB dll)</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\ud83d\udce6</div><div class=\"label\">Grok Accounts</div><div class=\"value\">'+fmtNum(a.total)+'</div><div class=\"sub\">active '+fmtNum(a.active)+' \u00b7 build '+fmtNum(a.build)+' \u00b7 web '+fmtNum(a.web)+'</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\ud83c\udf10</div><div class=\"label\">Proxies</div><div class=\"value\">'+(e.healthy||0)+'/'+(e.total||0)+'</div><div class=\"sub\">Grok egress healthy</div></div>'\n    + '</div>'\n\n    + '<div class=\"stats-grid\">'\n    + '<div class=\"stat-card\"><div class=\"ic\">\ud83e\uddfe</div><div class=\"label\">Recent GW Req</div><div class=\"value\">'+recent.length+'</div><div class=\"sub\">log lokal gateway</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\u2705</div><div class=\"label\">Recent Success</div><div class=\"value\">'+successRecent+'%</div><div class=\"sub\">ok '+okN+' \u00b7 fail '+failN+'</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\ud83c\udfaf</div><div class=\"label\">Recent Tokens</div><div class=\"value\" style=\"font-size:24px\">'+fmtTok(tokN)+'</div><div class=\"sub\">from recent log</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\ud83d\udcb3</div><div class=\"label\">CB Credit Spent</div><div class=\"value\" style=\"font-size:24px\">'+creditN.toFixed(3)+'</div><div class=\"sub\">from recent log</div></div>'\n    + '</div>'\n\n    + '<div class=\"panel\"><div class=\"panel-head\"><h2>\ud83d\udd0c Providers</h2><span class=\"count\">'+providers.length+'</span>'\n    + '<button class=\"btn sm\" style=\"margin-left:auto\" onclick=\"goPage(\\'providers\\')\">Manage \u2192</button></div>'\n    + '<div class=\"panel-body\"><div class=\"prov-grid\">'+provCards+'</div></div></div>'\n\n    + '<div class=\"split-grid\">'\n    + '<div class=\"panel\" style=\"margin-bottom:0\"><div class=\"panel-head\"><h2>\ud83d\udcc8 Grok Usage 24h</h2><span class=\"count\">'+(d.period||'24h')+'</span>'\n    + '<button class=\"btn sm\" style=\"margin-left:auto\" onclick=\"goPage(\\'usage\\')\">Detail \u2192</button></div><div class=\"panel-body\">'\n    + '<div class=\"usage-grid\">'\n    + '<div class=\"usage-item\"><div class=\"v\">'+fmtNum(u.requests)+'</div><div class=\"k\">Requests</div></div>'\n    + '<div class=\"usage-item\"><div class=\"v\">'+fmtPct(u.successRate)+'</div><div class=\"k\">Success</div></div>'\n    + '<div class=\"usage-item\"><div class=\"v\">'+fmtTok(u.tokens)+'</div><div class=\"k\">Tokens</div></div>'\n    + '<div class=\"usage-item\"><div class=\"v\">'+fmtTok(u.inputTokens)+'</div><div class=\"k\">Input</div></div>'\n    + '<div class=\"usage-item\"><div class=\"v\">'+fmtTok(u.outputTokens)+'</div><div class=\"k\">Output</div></div>'\n    + '<div class=\"usage-item\"><div class=\"v\">'+fmtCostTicks(u.billedCostUsdTicks)+'</div><div class=\"k\">Est. Cost</div></div>'\n    + '</div>'\n    + '<div style=\"font-size:11px;color:var(--mut2);margin-top:10px\">Stats 24h ini dari Grok2API pool. Traffic CodeBuddy/provider lain = Recent Requests.</div>'\n    + '</div></div>'\n\n    + '<div class=\"panel\" style=\"margin-bottom:0\"><div class=\"panel-head\"><h2>\u26a1 Grok Accounts</h2>'\n    + '<button class=\"btn sm\" style=\"margin-left:auto\" onclick=\"goPage(\\'accounts\\')\">Accounts \u2192</button></div><div class=\"panel-body\">'\n    + grokPanel\n    + ((a.errors||0)>0 ? '<p style=\"color:var(--warn);margin-top:10px;font-size:13px\">\u26a0\ufe0f '+a.errors+' akun bermasalah \u2014 cek Accounts / Purge Bad.</p>' : '')\n    + '</div></div>'\n    + '</div>'\n\n    + '<div class=\"panel\" style=\"margin-top:18px\"><div class=\"panel-head\"><h2>\ud83e\uddfe Recent Requests</h2><span class=\"count\">'+recent.length+'</span>'\n    + '<button class=\"btn sm\" style=\"margin-left:auto\" onclick=\"goPage(\\'usage\\')\">Full log \u2192</button></div>'\n    + '<div class=\"panel-body\" style=\"padding:0\"><div class=\"table-wrap\" style=\"max-height:320px\"><table><thead><tr>'\n    + '<th>When</th><th>Provider</th><th>Model</th><th>Status</th><th>Latency</th><th>Tokens</th><th>Preview</th>'\n    + '</tr></thead><tbody>'+recentRows+'</tbody></table></div></div></div>'\n\n    + '<div class=\"panel\"><div class=\"panel-head\"><h2>\ud83e\udde9 Models</h2><span class=\"count\">'+modelItems.length+'</span>'\n    + '<button class=\"btn sm\" style=\"margin-left:auto\" onclick=\"goPage(\\'models\\')\">All \u2192</button></div>'\n    + '<div class=\"panel-body\"><div class=\"model-grid\">'+rows+'</div></div></div>';\n}\n\n\nfunction acctHealth(a){\n  if(!a.enabled) return 'disabled';\n  if(a.authStatus==='reauthRequired'||a.authStatus==='banned') return 'reauth';\n  if(a.authStatus==='error') return 'error';\n  var st=(a.quota&&a.quota.status)||'';\n  if(st==='exhausted') return 'exhausted';\n  if(a._source==='gateway' && st==='error') return 'error';\n  if(a.provider==='grok_web' && a.quotaWindows && a.quotaWindows.length){\n    var anyLeft=a.quotaWindows.some(function(w){return (w.remaining||0)>0});\n    if(!anyLeft) return 'exhausted';\n  }\n  if((a.failureCount||0)>=5) return 'error';\n  return 'ok';\n}\nfunction acctSearchText(a){\n  return [a.id, a.email, a.name, a.provider, a.authStatus, a.authType, a.linkedAccountName, a.lastError]\n    .map(function(x){return String(x==null?'':x);})\n    .join(' ')\n    .toLowerCase();\n}\nfunction providerLabel(p){\n  if(p==='grok_build' || p==='build') return 'Build';\n  if(p==='grok_web' || p==='web') return 'Web';\n  if(p==='grok_console' || p==='console') return 'Console';\n  if(p==='cbai' || p==='codebuddy') return 'CodeBuddy';\n  if(p==='grok') return 'Grok2API';\n  // gateway virtual provider id: gw_<prefix>\n  if(String(p||'').indexOf('gw_')===0) return String(p).slice(3);\n  return p || '\u2014';\n}\nfunction providerBadgeClass(p){\n  if(p==='grok_build' || p==='build') return 'build';\n  if(p==='grok_web' || p==='web') return 'web';\n  if(p==='grok_console' || p==='console') return 'disabled';\n  if(p==='cbai' || p==='codebuddy') return 'active';\n  return 'active';\n}\nfunction providerFilterKey(a){\n  // normalize account \u2192 filter chip key\n  if(!a) return 'other';\n  if(a._source==='gateway'){\n    var pm=a._providerMeta||{};\n    return String(pm.prefix || a.name || a.provider || 'other');\n  }\n  if(a.provider==='grok_build') return 'build';\n  if(a.provider==='grok_web') return 'web';\n  if(a.provider==='grok_console') return 'console';\n  if(a.provider==='cbai' || a.provider==='codebuddy') return 'cbai';\n  return String(a.provider||'other');\n}\nfunction providerChipMeta(){\n  // static grok account-types + dynamic non-grok gateway providers\n  var chips = [\n    {id:'all', label:'All', icon:''},\n    {id:'build', label:'Build', icon:'\u26a1'},\n    {id:'web', label:'Web', icon:'\ud83c\udf10'},\n    {id:'console', label:'Console', icon:'\ud83d\udda5\ufe0f'}\n  ];\n  var seen = {all:1,build:1,web:1,console:1,grok:1};\n  (SUM && SUM.providers ? SUM.providers : []).forEach(function(p){\n    if(!p || !p.prefix) return;\n    if(p.prefix==='grok') return; // grok already represented by build/web/console\n    if(seen[p.prefix]) return;\n    seen[p.prefix]=1;\n    var catIcon = (p.prefix==='cbai') ? '\ud83c\udf0d' : '\ud83d\udd0c';\n    chips.push({id:p.prefix, label:p.name||p.prefix, icon:catIcon});\n  });\n  return chips;\n}\nvar HFILTER='all';\nvar QFILTER='all'; // provider filter for quota (same keys as accounts)\nvar QHFILTER='all'; // health filter for quota\nvar QSEARCH='';\nfunction setHFilter(f){HFILTER=f;renderAccounts();}\nfunction setProvFilter(f){ CUR_TAB=f||'all'; renderAccounts(); }\nfunction filterAccountsList(base, tab, hfilter, search){\n  var items = (base||[]).slice();\n  var t = tab || 'all';\n  if(t && t!=='all'){\n    items = items.filter(function(a){ return providerFilterKey(a)===t; });\n  }\n  if(hfilter && hfilter!=='all') items=items.filter(function(a){return acctHealth(a)===hfilter;});\n  var q=(search||'').trim().toLowerCase();\n  if(q) items=items.filter(function(a){return acctSearchText(a).indexOf(q)>=0;});\n  return items;\n}\nfunction gatewayAccountRows(){\n  // Expand NON-GROK gateway providers into PER-KEY rows (9router-style).\n  // CodeBuddy 100 keys \u2192 100 rows di Accounts/Quota, bukan 1 card \"100/100\".\n  var rows = [];\n  (SUM && SUM.providers ? SUM.providers : []).forEach(function(p){\n    if(!p || !p.prefix || p.prefix==='grok') return;\n    var keys = (p.keys && p.keys.length) ? p.keys.slice() : [];\n    if(!keys.length){\n      keys = [{ id: 'primary', label: p.keyMasked || 'primary', enabled: !!(p.hasKey || (p.enabledKeyCount||0)>0), keyMasked: p.keyMasked || '' }];\n    }\n    keys.forEach(function(k, idx){\n      var kid = String(k.id || ('k'+(idx+1)));\n      var label = (k.label && String(k.label).trim()) ? String(k.label).trim() : '';\n      var masked = k.keyMasked || p.keyMasked || kid;\n      var enabled = (p.enabled!==false) && (k.enabled!==false);\n      var stStatus = k.status || (enabled ? 'unknown' : 'disabled');\n      var spent = Number(k.spentCredit || 0);\n      var lastC = Number(k.lastCredit || 0);\n      var auth = 'active';\n      if(p.enabled===false || !enabled || stStatus==='disabled') auth='disabled';\n      else if(stStatus==='exhausted' || stStatus==='error') auth='error';\n      else if(stStatus==='active') auth='active';\n      else auth = enabled ? 'active' : 'disabled';\n      rows.push({\n        id: 'gw:'+p.prefix+':'+kid,\n        email: label || masked || (p.name+' #'+(idx+1)),\n        name: kid,\n        provider: p.prefix,\n        authStatus: auth,\n        enabled: enabled,\n        failureCount: Number(k.failed || 0),\n        lastUsedAt: k.lastChecked || '',\n        lastError: k.lastError || '',\n        quota: {\n          used: spent,\n          limit: null,\n          remaining: null,\n          usagePercent: null,\n          type: 'spent-credit',\n          status: stStatus==='exhausted' ? 'exhausted' : (stStatus==='active' ? 'active' : (stStatus||'unknown')),\n          lastCredit: lastC,\n          requests: Number(k.requests || 0),\n          success: Number(k.success || 0),\n          failed: Number(k.failed || 0),\n          lastModel: k.lastModel || ''\n        },\n        billing: { used: spent, remaining: null, creditUsagePercent: 0, monthlyLimit: 0 },\n        quotaWindows: [],\n        _source: 'gateway',\n        _providerMeta: p,\n        _keyMeta: k,\n        _keyIndex: idx+1,\n        _keyTotal: keys.length\n      });\n    });\n  });\n  return rows;\n}\nfunction allAccountSources(){\n  return (ACCS||[]).concat(gatewayAccountRows());\n}\nfunction renderProviderChips(active, counts, onClickFn){\n  // onClickFn name string e.g. setProvFilter / setQFilter\n  return providerChipMeta().map(function(c){\n    var n = (c.id==='all') ? (counts.all||0) : (counts[c.id]||0);\n    var lab = (c.icon? (c.icon+' ') : '') + c.label;\n    return '<div class=\"pchip '+(active===c.id?'active':'')+'\" onclick=\"'+onClickFn+'(\\''+c.id+'\\')\">'+lab\n      +' <span class=\"n\">'+n+'</span></div>';\n  }).join('');\n}\nfunction renderHealthChips(active, hc, onClickFn){\n  var items=[\n    {id:'all', label:'All'},\n    {id:'ok', label:'\u2705 OK', n:hc.ok},\n    {id:'reauth', label:'\ud83d\udd11 Re-auth', n:hc.reauth},\n    {id:'exhausted', label:'\u23f3 Exhausted', n:hc.exhausted},\n    {id:'error', label:'\u274c Error', n:hc.error},\n    {id:'disabled', label:'\u26d4 Disabled', n:hc.disabled}\n  ];\n  return items.map(function(c){\n    var extra = (c.id==='all') ? '' : (' <span class=\"n\">'+(c.n||0)+'</span>');\n    return '<div class=\"hchip '+(active===c.id?'active':'')+'\" onclick=\"'+onClickFn+'(\\''+c.id+'\\')\">'+c.label+extra+'</div>';\n  }).join('');\n}\nfunction renderAccounts(){\n  var all = allAccountSources();\n  var items = filterAccountsList(all, CUR_TAB, HFILTER, SEARCH);\n\n  var tabItems = filterAccountsList(all, CUR_TAB, 'all', '');\n  var hc={ok:0,reauth:0,exhausted:0,error:0,disabled:0};\n  tabItems.forEach(function(a){var h=acctHealth(a); if(hc[h]!=null) hc[h]++;});\n\n  var counts={ all: all.length, build:0, web:0, console:0 };\n  all.forEach(function(a){\n    var k=providerFilterKey(a);\n    counts[k]=(counts[k]||0)+1;\n  });\n  // ensure known keys exist\n  ['build','web','console'].forEach(function(k){ if(counts[k]==null) counts[k]=0; });\n  providerChipMeta().forEach(function(c){ if(c.id!=='all' && counts[c.id]==null) counts[c.id]=0; });\n\n  var rows = items.map(function(a){\n    var isBuild=a.provider==='grok_build';\n    var hh=acctHealth(a);\n    var hmap={ok:['active','OK'],reauth:['error','Re-auth'],exhausted:['disabled','Exhausted'],error:['error','Error'],disabled:['disabled','Disabled']};\n    var hb=hmap[hh]||['disabled',hh];\n    var qd='<span style=\"color:var(--mut2)\">\u2014</span>';\n    if(a._source==='gateway'){\n      var pm=a._providerMeta||{};\n      var km=a._keyMeta||{};\n      var spent = (a.quota && a.quota.used!=null) ? Number(a.quota.used) : Number(km.spentCredit||0);\n      var lastC = (a.quota && a.quota.lastCredit!=null) ? Number(a.quota.lastCredit) : Number(km.lastCredit||0);\n      var st = (a.quota && a.quota.status) || km.status || 'unknown';\n      var stColor = st==='exhausted'?'var(--err)':(st==='active'?'var(--ok)':(st==='error'?'var(--err)':'var(--mut)'));\n      qd='<div style=\"font-size:11px;line-height:1.35\">'\n        +'<div>spent <b style=\"color:var(--fg)\">'+spent.toFixed(4)+'</b> credit'\n        +(lastC?(' \u00b7 last '+lastC.toFixed(4)):'')+'</div>'\n        +'<div style=\"color:var(--mut)\">key <b style=\"color:var(--fg)\">'+(km.keyMasked||km.id||a.name)+'</b>'\n        +(a._keyIndex?(' \u00b7 #'+a._keyIndex+'/'+a._keyTotal):'')\n        +' \u00b7 <span style=\"color:'+stColor+'\">'+st+'</span></div>'\n        +'</div>';\n    } else if(!isBuild && a.quotaWindows && a.quotaWindows.length){\n      qd=a.quotaWindows.map(function(w){var rst=w.resetAt?' <span style=\"color:var(--mut2);font-size:10px\">(reset '+timeUntil(w.resetAt)+')</span>':'';return '<span style=\"white-space:nowrap\">'+w.mode+': <b>'+w.remaining+'/'+w.total+'</b>'+rst+'</span>';}).join('<br>');\n    } else if(a.quota && (a.quota.limit||a.quota.remaining!=null)){\n      var pct=a.quota.usagePercent||0;\n      var cls=qClass(100-pct);\n      qd='<div><div class=\"qbar\"><div class=\"fill '+cls+'\" style=\"width:'+(100-pct)+'%\"></div></div><span style=\"font-size:11px\">'+fmtNum(a.quota.remaining||0)+'/'+fmtNum(a.quota.limit||0)+'</span></div>';\n    }\n    var canSelect = a._source!=='gateway';\n    return '<tr><td>'+(canSelect?'<input type=\"checkbox\" class=\"acct-check\" value=\"'+a.id+'\">':'')+'</td>'\n      +'<td style=\"color:var(--mut);font-size:11px\">'+a.id+'</td>'\n      +'<td><div style=\"font-weight:600\">'+(a.email||a.name||a.id)+'</div>'\n      +(a._source==='gateway'?'<div style=\"font-size:10px;color:var(--mut2)\">'+(a._providerMeta&&a._providerMeta.name?a._providerMeta.name:providerLabel(a.provider))+' \u00b7 id '+(a.name||'')+'</div>':'')\n      +(a.lastError?'<div style=\"font-size:10px;color:var(--err)\">'+String(a.lastError).slice(0,120)+'</div>':'')+'</td>'\n      +'<td><span class=\"badge '+providerBadgeClass(a.provider)+'\">'+providerLabel(a.provider)+'</span></td>'\n      +'<td><span class=\"badge '+hb[0]+'\">'+hb[1]+'</span></td>'\n      +'<td>'+qd+'</td>'\n      +'<td style=\"color:'+(a.failureCount>0?'var(--err)':'var(--mut2)')+'\">'+(a.failureCount||0)+'</td>'\n      +'<td style=\"color:var(--mut2);font-size:11px\">'+(a._source==='gateway'\n          ? ('<button class=\"btn sm\" onclick=\"testGatewayKey(\\''+ (a._providerMeta&&a._providerMeta.prefix||a.provider)+'\\',\\''+(a._keyMeta&&a._keyMeta.id||a.name)+'\\')\">Test</button>')\n          : timeAgo(a.lastUsedAt))+'</td></tr>';\n  }).join('') || '<tr><td colspan=\"8\" style=\"text-align:center;color:var(--mut);padding:20px\">No accounts match filter/search</td></tr>';\n\n  var caret = window.__acctSearchCaret;\n  var provActive = CUR_TAB || 'all';\n  document.getElementById('pageContent').innerHTML =\n    '<div class=\"chipbar\"><span class=\"clabel\">Provider</span>'+renderProviderChips(provActive, counts, 'setProvFilter')\n    +'<input class=\"search-input\" id=\"acctSearch\" type=\"text\" placeholder=\"Cari email / id / provider...\" value=\"'+(SEARCH||'').replace(/\"/g,'&quot;')+'\" oninput=\"setSearch(this.value,this)\" style=\"min-width:180px;margin-left:auto\">'\n    +'</div>'\n    + '<div class=\"chipbar\"><span class=\"clabel\">Status</span>'+renderHealthChips(HFILTER, hc, 'setHFilter')\n    + '<span style=\"margin-left:auto;font-size:12px;color:var(--mut)\">Showing <b>'+items.length+'</b></span>'\n    + '</div>'\n    + '<div class=\"toolbar\">'\n    + '<button class=\"btn sm\" onclick=\"acctSelectAll()\">Select All</button>'\n    + '<button class=\"btn sm\" onclick=\"acctRefreshToken()\">\ud83d\udd04 Refresh Token</button>'\n    + '<button class=\"btn sm\" onclick=\"acctDelete()\" style=\"color:var(--err)\">\ud83d\uddd1 Delete Terpilih</button>'\n    + '<button class=\"btn sm\" id=\"purgeBadBtn\" onclick=\"acctPurgeBad()\" style=\"color:var(--warn)\">\ud83e\uddf9 Purge Bad ('+(hc.reauth+hc.error+hc.exhausted)+')</button>'\n    + '<button class=\"btn sm\" onclick=\"probeProviderCredits(\\'cbai\\',10)\">\ud83d\udcb3 Probe CB Credits (10)</button>'\n    + '</div>'\n    + '<div id=\"acctActionResult\" style=\"margin-bottom:10px\"></div>'\n    + '<div class=\"panel\"><div class=\"table-wrap\"><table><thead><tr><th style=\"width:30px\"><input type=\"checkbox\" onchange=\"acctToggleAll(this)\"></th><th>ID</th><th>Email/Name</th><th>Type</th><th>Status</th><th>Quota</th><th>Fail</th><th>Used</th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';\n\n  // restore search focus/caret after re-render\n  var inp=document.getElementById('acctSearch');\n  if(inp && ((document.activeElement && document.activeElement.id==='acctSearch') || window.__acctSearchFocused)){\n    inp.focus();\n    try{\n      var pos = (caret!=null?caret:inp.value.length);\n      inp.setSelectionRange(pos,pos);\n    }catch(e){}\n  }\n}\nfunction acctToggleAll(cb){document.querySelectorAll('.acct-check').forEach(function(c){c.checked=cb.checked});}\nfunction acctSelectAll(){document.querySelectorAll('.acct-check').forEach(function(c){c.checked=true});}\nfunction acctSelectedIds(){return Array.from(document.querySelectorAll('.acct-check:checked')).map(function(c){return c.value}).filter(function(id){return String(id).indexOf('gw:')!==0;});}\nasync function acctDelete(){\n  var ids=acctSelectedIds();\n  if(!ids.length){alert('Pilih minimal 1 akun Grok');return;}\n  if(!confirm('HAPUS '+ids.length+' akun? Permanen (buat akun banned/error). Lanjut?'))return;\n  var out=document.getElementById('acctActionResult');\n  out.innerHTML='<span style=\"color:var(--acc)\">Deleting '+ids.length+'...</span>';\n  try{\n    var r=await fetch('/admin/accounts/delete',{method:'POST',headers:hdr(),body:JSON.stringify({ids:ids})}).then(function(r){return r.json()});\n    out.innerHTML='<span style=\"color:var(--ok)\">\u2705 Deleted '+r.deleted+(r.failed?', failed '+r.failed:'')+'</span>';\n    setTimeout(refreshAll,1200);\n  }catch(e){out.innerHTML='<span style=\"color:var(--err)\">'+e.message+'</span>';}\n}\nasync function acctRefreshToken(){\n  var ids=acctSelectedIds();\n  if(!ids.length){alert('Pilih minimal 1 akun Grok');return;}\n  var out=document.getElementById('acctActionResult');\n  out.innerHTML='<span style=\"color:var(--acc)\">Refreshing token '+ids.length+'...</span>';\n  try{\n    var r=await fetch('/admin/accounts/refresh-token',{method:'POST',headers:hdr(),body:JSON.stringify({ids:ids})}).then(function(r){return r.json()});\n    out.innerHTML='<span style=\"color:var(--ok)\">\u2705 Refreshed '+r.refreshed+(r.failed?', failed '+r.failed:'')+'</span>';\n    setTimeout(refreshAll,1200);\n  }catch(e){out.innerHTML='<span style=\"color:var(--err)\">'+e.message+'</span>';}\n}\nasync function acctPurgeBad(){\n  var out=document.getElementById('acctActionResult');\n  out.innerHTML='<span style=\"color:var(--acc)\">Counting bad accounts...</span>';\n  try{\n    var prev=await fetch('/admin/accounts/purge',{method:'POST',headers:hdr(),body:JSON.stringify({dryRun:true})}).then(function(r){return r.json();});\n    if(prev.error){out.innerHTML='<span style=\"color:var(--err)\">Error: '+prev.error+'</span>';return;}\n    var total=prev.total||0;\n    var b=prev.breakdown||{};\n    var btn=document.getElementById('purgeBadBtn');\n    if(btn) btn.textContent='\ud83e\uddf9 Purge Bad ('+total+')';\n    if(!total){out.innerHTML='<span style=\"color:var(--ok)\">\u2705 No bad accounts to purge</span>';return;}\n    var detail='total '+total\n      +' | reauth '+(b.reauth||0)\n      +' | error '+(b.error||0)\n      +' | exhausted '+(b.exhausted||0)\n      +' | build '+(b.build||0)\n      +' | console '+(b.console||0)\n      +' | web '+(b.web||0);\n    if(!confirm('Purge '+total+' bad accounts?\\n'+detail+'\\n\\nIni permanen. Lanjut?')){\n      out.innerHTML='<span style=\"color:var(--mut)\">Purge dibatalkan ('+total+' bad)</span>';\n      return;\n    }\n    out.innerHTML='<span style=\"color:var(--acc)\">Purging '+total+' bad accounts...</span>';\n    var r=await fetch('/admin/accounts/purge',{method:'POST',headers:hdr(),body:JSON.stringify({dryRun:false})}).then(function(r){return r.json();});\n    if(r.error){\n      out.innerHTML='<span style=\"color:var(--err)\">Error: '+r.error+'</span>';\n    } else {\n      out.innerHTML='<span style=\"color:var(--ok)\">\u2705 Purged: '+r.purged+' deleted, '+r.failed+' failed ('+r.total+' bad)</span>';\n      await refreshAll();\n    }\n  }catch(e){\n    out.innerHTML='<span style=\"color:var(--err)\">'+e.message+'</span>';\n  }\n}\nfunction setTab(t){ setProvFilter(t); }\nfunction setSearch(v, el){\n  SEARCH=v||'';\n  window.__acctSearchFocused=true;\n  if(el && typeof el.selectionStart==='number') window.__acctSearchCaret=el.selectionStart;\n  renderAccounts();\n}\n\nfunction quotaPct(a){\n  if(a.quota && a.quota.usagePercent!=null) return Number(a.quota.usagePercent)||0;\n  if(a.quotaWindows && a.quotaWindows.length){\n    // use worst window remaining ratio inverted\n    var worst=0;\n    a.quotaWindows.forEach(function(w){\n      var tot=w.total||0, rem=w.remaining||0;\n      if(tot>0){ var used=((tot-rem)/tot)*100; if(used>worst) worst=used; }\n    });\n    return worst;\n  }\n  return null;\n}\nfunction setQFilter(f){QFILTER=f||'all';renderQuotaTracker();}\nfunction setQHFilter(f){QHFILTER=f||'all';renderQuotaTracker();}\nfunction setQSearch(v){QSEARCH=v||'';renderQuotaTracker();}\nfunction renderQuotaTracker(){\n  var all = allAccountSources();\n  var counts={ all: all.length, build:0, web:0, console:0 };\n  all.forEach(function(a){ var k=providerFilterKey(a); counts[k]=(counts[k]||0)+1; });\n  providerChipMeta().forEach(function(c){ if(c.id!=='all' && counts[c.id]==null) counts[c.id]=0; });\n\n  var list = filterAccountsList(all, QFILTER, QHFILTER==='all' ? 'all' : QHFILTER, QSEARCH);\n\n  // health counts for current provider filter (ignore health filter)\n  var baseProv = filterAccountsList(all, QFILTER, 'all', '');\n  var hc={ok:0,reauth:0,exhausted:0,error:0,disabled:0};\n  baseProv.forEach(function(a){var h=acctHealth(a); if(hc[h]!=null) hc[h]++;});\n\n  // sort worst first for non-gateway rows; gateway last\n  list.sort(function(a,b){\n    var ga=a._source==='gateway'?1:0, gb=b._source==='gateway'?1:0;\n    if(ga!==gb) return ga-gb;\n    var pa=quotaPct(a), pb=quotaPct(b);\n    if(pa==null && pb==null) return 0;\n    if(pa==null) return 1;\n    if(pb==null) return -1;\n    return pb-pa;\n  });\n\n  var cards=list.slice(0,300).map(function(a){\n    if(a._source==='gateway'){\n      var pm=a._providerMeta||{};\n      var km=a._keyMeta||{};\n      var en = a.enabled!==false;\n      var pfx = pm.prefix || a.provider;\n      var spent = Number((a.quota&&a.quota.used)!=null?a.quota.used:(km.spentCredit||0));\n      var lastC = Number((a.quota&&a.quota.lastCredit)!=null?a.quota.lastCredit:(km.lastCredit||0));\n      var st = (a.quota&&a.quota.status) || km.status || 'unknown';\n      var reqs = Number((a.quota&&a.quota.requests)!=null?a.quota.requests:(km.requests||0));\n      var cls='qcard';\n      if(st==='exhausted' || st==='error') cls+=' bad';\n      return '<div class=\"'+cls+'\">'\n        +'<div class=\"qtitle\">\ud83d\udd11 '+(a.email||km.keyMasked||a.name)+'</div>'\n        +'<div class=\"qsub\"><span class=\"badge active\">'+providerLabel(a.provider)+'</span> \u00b7 key <b>'+(km.id||a.name)+'</b>'\n        +(a._keyIndex?(' \u00b7 #'+a._keyIndex+'/'+a._keyTotal):'')\n        +' \u00b7 '+st+'</div>'\n        +'<div class=\"qbar-lg\"><div class=\"fill '+(st==='exhausted'||st==='error'?'l':(st==='active'?'h':'m'))+'\" style=\"width:'+(st==='unknown'?20:(st==='exhausted'?100:Math.min(100, Math.max(8, spent*20))))+'%;background:'+(st==='exhausted'||st==='error'?'var(--err)':(st==='active'?'var(--ok)':'var(--acc)'))+'\"></div></div>'\n        +'<div style=\"display:flex;justify-content:space-between;font-size:12px;gap:8px;flex-wrap:wrap\">'\n        +'<span>Spent <b>'+spent.toFixed(4)+'</b></span>'\n        +'<span style=\"color:var(--mut)\">last '+lastC.toFixed(4)+' \u00b7 req '+reqs+'</span>'\n        +'</div>'\n        +'<div style=\"font-size:11px;color:var(--mut2);margin-top:6px\">No remaining-balance API \u00b7 track spent from usage.credit</div>'\n        +'<div style=\"margin-top:10px\"><button class=\"btn sm\" onclick=\"goPage(\\'providers\\');setTimeout(function(){openProviderManage(\\''+pfx+'\\')},50)\">Manage pool</button> '\n        +'<button class=\"btn sm\" onclick=\"testGatewayKey(\\''+pfx+'\\',\\''+(km.id||a.name)+'\\')\">\ud83e\uddea Test</button></div>'\n        +'</div>';\n    }\n    var pct=quotaPct(a);\n    var remain='\u2014', limit='\u2014', detail='';\n    if(a.quota && a.quota.limit!=null){\n      remain=fmtNum(a.quota.remaining||0); limit=fmtNum(a.quota.limit||0);\n      detail=(a.quota.type||'')+' \u00b7 '+(a.quota.status||'');\n    } else if(a.quotaWindows && a.quotaWindows.length){\n      detail=a.quotaWindows.map(function(w){return w.mode+': '+w.remaining+'/'+w.total;}).join(' \u00b7 ');\n      var tot=0,rem=0; a.quotaWindows.forEach(function(w){tot+=w.total||0;rem+=w.remaining||0;});\n      remain=fmtNum(rem); limit=fmtNum(tot);\n      if(tot>0) pct=((tot-rem)/tot)*100;\n    }\n    var cls='qcard';\n    if(pct!=null && pct>=95) cls+=' bad';\n    else if(pct!=null && pct>=70) cls+=' low';\n    var fillCls=pct==null?'h':(pct>=95?'l':pct>=70?'m':'h');\n    var width=pct==null?0:Math.max(0,Math.min(100,100-pct));\n    return '<div class=\"'+cls+'\">'\n      +'<div class=\"qtitle\">'+(a.email||a.name||a.id)+'</div>'\n      +'<div class=\"qsub\"><span class=\"badge '+providerBadgeClass(a.provider)+'\">'+providerLabel(a.provider)+'</span> \u00b7 '+acctHealth(a)+(detail?' \u00b7 '+detail:'')+'</div>'\n      +'<div class=\"qbar-lg\"><div class=\"fill '+fillCls+'\" style=\"width:'+width+'%\"></div></div>'\n      +'<div style=\"display:flex;justify-content:space-between;font-size:12px\"><span>Left <b>'+remain+'</b></span><span style=\"color:var(--mut)\">of '+limit+(pct!=null?(' \u00b7 '+Math.round(pct)+'% used'):'')+'</span></div>'\n      +'</div>';\n  }).join('') || '<div style=\"padding:20px;color:var(--mut);border:1px dashed var(--bd);border-radius:12px\">No quota rows for this filter</div>';\n\n  var low=all.filter(function(a){var p=quotaPct(a);return p!=null&&p>=70&&p<95}).length;\n  var crit=all.filter(function(a){var p=quotaPct(a);return (p!=null&&p>=95)||acctHealth(a)==='exhausted'}).length;\n  var ok=all.filter(function(a){var p=quotaPct(a);return acctHealth(a)==='ok'&&(p==null||p<70)}).length;\n\n  document.getElementById('pageContent').innerHTML =\n    '<div class=\"usage-head\"><div class=\"title-block\"><h2>\ud83d\udd0b Quota Tracker</h2><p>Sisa quota per akun \u00b7 filter provider compact ala 9router</p></div>'\n    +'<input class=\"prov-search\" placeholder=\"Search akun/provider...\" value=\"'+(QSEARCH||'').replace(/\"/g,'&quot;')+'\" oninput=\"setQSearch(this.value)\">'\n    +'</div>'\n    +'<div class=\"stats-grid\">'\n    +'<div class=\"stat-card\"><div class=\"ic\">\u2705</div><div class=\"label\">Healthy</div><div class=\"value\">'+ok+'</div></div>'\n    +'<div class=\"stat-card\"><div class=\"ic\">\u26a0\ufe0f</div><div class=\"label\">Low (\u226570%)</div><div class=\"value\">'+low+'</div></div>'\n    +'<div class=\"stat-card\"><div class=\"ic\">\ud83d\udd34</div><div class=\"label\">Critical</div><div class=\"value\">'+crit+'</div></div>'\n    +'<div class=\"stat-card\"><div class=\"ic\">\ud83d\udd0c</div><div class=\"label\">Provider Keys</div><div class=\"value\">'+(gatewayAccountRows().length)+'</div></div>'\n    +'</div>'\n    +'<div class=\"chipbar\"><span class=\"clabel\">Provider</span>'+renderProviderChips(QFILTER||'all', counts, 'setQFilter')+'</div>'\n    +'<div class=\"chipbar\"><span class=\"clabel\">Status</span>'+renderHealthChips(QHFILTER||'all', hc, 'setQHFilter')\n    +'<span style=\"margin-left:auto;font-size:12px;color:var(--mut)\">Showing <b>'+Math.min(list.length,300)+'</b>'+(list.length>300?' / '+list.length:'')+'</span>'\n    +'</div>'\n    +'<div class=\"qgrid\">'+cards+'</div>';\n}\n\nvar USAGE_METRIC = localStorage.getItem('kigw_usage_metric') || 'requests';\nvar USAGE_SEARCH = '';\nfunction setUsageMetric(m){ USAGE_METRIC=m; localStorage.setItem('kigw_usage_metric', m); renderUsage(); }\nfunction setUsageSearch(v){ USAGE_SEARCH=v||''; renderUsage(); }\n\nfunction buildUsageModelRows(series){\n  var map = {};\n  (series||[]).forEach(function(h){\n    (h.models||[]).forEach(function(m){\n      var id = m.model || '?';\n      if(!map[id]) map[id] = {model:id, tokens:0, cost:0, hours:0, peakTokens:0};\n      map[id].tokens += (m.tokens||0);\n      map[id].cost += (m.billedCostUsdTicks||0);\n      map[id].hours += 1;\n      if((m.tokens||0) > map[id].peakTokens) map[id].peakTokens = m.tokens||0;\n    });\n  });\n  return Object.keys(map).map(function(k){return map[k];})\n    .sort(function(a,b){return (b.tokens||0)-(a.tokens||0);});\n}\n\n\nvar RECENT_FILTER = 'all';\nvar RECENT_SEARCH = '';\nasync function loadRecentRequests(){\n  try{\n    var qs = '/admin/requests?limit=100';\n    if(RECENT_FILTER && RECENT_FILTER!=='all') qs += '&provider='+encodeURIComponent(RECENT_FILTER);\n    if(RECENT_SEARCH) qs += '&q='+encodeURIComponent(RECENT_SEARCH);\n    var r = await fetch(qs,{headers:hdr()}).then(function(r){return r.json();});\n    RECENT_REQ = r.items || [];\n  }catch(e){ RECENT_REQ = RECENT_REQ || []; console.error(e); }\n}\nfunction setRecentFilter(f){ RECENT_FILTER=f||'all'; renderUsage(true); }\nfunction setRecentSearch(v){ RECENT_SEARCH=v||''; renderUsage(true); }\nfunction fmtMs(n){ n=Number(n)||0; if(n<1000) return Math.round(n)+'ms'; return (n/1000).toFixed(2)+'s'; }\nfunction recentStatusBadge(ok, status){\n  if(ok) return '<span class=\"badge active\">'+status+'</span>';\n  if(status==429) return '<span class=\"badge error\">429</span>';\n  return '<span class=\"badge error\">'+(status||'err')+'</span>';\n}\n\nfunction renderUsage(skipReload){\n  if(!skipReload){\n    loadRecentRequests().then(function(){ renderUsage(true); });\n  }\n  const d=SUM.dashboard||{}, u=d.usage||{}, r=d.resources||{}, s=d.series||[];\n  const range = d.range || {};\n  const models = buildUsageModelRows(s);\n  const totalTok = models.reduce(function(a,m){return a+(m.tokens||0);},0) || 1;\n  const totalCost = models.reduce(function(a,m){return a+(m.cost||0);},0) || 1;\n  const metric = USAGE_METRIC || 'requests';\n\n  // peak hour\n  var peak = null;\n  s.forEach(function(h){\n    var v = metric==='tokens' ? (h.tokens||0) : metric==='cost' ? (h.billedCostUsdTicks||0) : (h.requests||0);\n    if(!peak || v > peak.v) peak = {h:h, v:v};\n  });\n\n  var mx = 1;\n  s.forEach(function(h){\n    var v = metric==='tokens' ? (h.tokens||0) : metric==='cost' ? (h.billedCostUsdTicks||0) : (h.requests||0);\n    if(v>mx) mx=v;\n  });\n\n  var chart = s.length ? '<div class=\"chart-wrap\"><div class=\"chart-bars\">'\n    + s.map(function(h, idx){\n        var v = metric==='tokens' ? (h.tokens||0) : metric==='cost' ? (h.billedCostUsdTicks||0) : (h.requests||0);\n        var pct = Math.round((v/mx)*100);\n        var hpx = Math.max(2, Math.round(pct*1.4));\n        var barCls = metric==='tokens'?'tok':(metric==='cost'?'cost':'');\n        var tipVal = metric==='tokens' ? fmtTok(h.tokens||0)+' tok'\n          : metric==='cost' ? fmtCostTicks(h.billedCostUsdTicks||0)\n          : fmtNum(h.requests||0)+' req';\n        var showLbl = (idx % 3 === 0) || idx === s.length-1;\n        return '<div class=\"chart-col\">'\n          + '<div class=\"tip\"><b>'+hourLabel(h.start)+'</b> \u00b7 '+tipVal\n          + '<br><span style=\"color:var(--mut)\">in '+fmtTok(h.inputTokens||0)+' / out '+fmtTok(h.outputTokens||0)+'</span></div>'\n          + '<div class=\"bar '+barCls+'\" style=\"height:'+hpx+'px\"></div>'\n          + '<div class=\"lbl\">'+(showLbl?hourLabel(h.start):'')+'</div>'\n          + '</div>';\n      }).join('')\n    + '</div></div>'\n    : '<p style=\"color:var(--mut);padding:12px 0\">Belum ada data series 24 jam.</p>';\n\n  // success split\n  var okN = u.successfulRequests||0, failN = u.failedRequests||0, reqN = u.requests|| (okN+failN) || 1;\n  var okPct = Math.round((okN/reqN)*1000)/10;\n  var failPct = Math.round((failN/reqN)*1000)/10;\n\n  // model filter\n  var q = (USAGE_SEARCH||'').toLowerCase().trim();\n  var mrows = models.filter(function(m){\n    if(!q) return true;\n    return String(m.model).toLowerCase().indexOf(q)>=0;\n  });\n\n  var modelTable = mrows.map(function(m,i){\n    var shareTok = Math.round(((m.tokens||0)/totalTok)*1000)/10;\n    var shareCost = Math.round(((m.cost||0)/totalCost)*1000)/10;\n    // guess provider tier from model name\n    var tier = (String(m.model).indexOf('chat-fast')>=0) ? 'web'\n      : (String(m.model).indexOf('4.5')>=0 || String(m.model).indexOf('multi-agent')>=0 || String(m.model).indexOf('reasoning')>=0) ? 'build'\n      : 'other';\n    var badge = tier==='web'?'web':(tier==='build'?'build':'active');\n    return '<tr>'\n      + '<td style=\"color:var(--mut2);font-size:11px\">'+(i+1)+'</td>'\n      + '<td style=\"font-weight:700\">'+m.model+'</td>'\n      + '<td><span class=\"badge '+badge+'\">'+tier+'</span></td>'\n      + '<td style=\"font-weight:600\">'+fmtTok(m.tokens)+'</td>'\n      + '<td style=\"min-width:120px\"><div style=\"display:flex;align-items:center;gap:8px\"><div class=\"share-bar\"><div class=\"fill\" style=\"width:'+Math.min(100,shareTok)+'%\"></div></div><span style=\"font-size:11px;color:var(--mut)\">'+shareTok+'%</span></div></td>'\n      + '<td>'+fmtCostTicks(m.cost)+'</td>'\n      + '<td style=\"color:var(--mut)\">'+shareCost+'%</td>'\n      + '<td style=\"color:var(--mut2);font-size:11px\">peak '+fmtTok(m.peakTokens)+'</td>'\n      + '</tr>';\n  }).join('') || '<tr><td colspan=\"8\" style=\"text-align:center;color:var(--mut);padding:16px\">No models match</td></tr>';\n\n  // hourly detail table (last 12 for compactness, toggle all via full list)\n  var hourRows = (s.slice().reverse()).map(function(h){\n    var topModel = (h.models||[]).slice().sort(function(a,b){return (b.tokens||0)-(a.tokens||0);})[0];\n    return '<tr>'\n      + '<td style=\"white-space:nowrap\">'+dayLabel(h.start)+' <b>'+hourLabel(h.start)+'</b></td>'\n      + '<td style=\"font-weight:700\">'+fmtNum(h.requests||0)+'</td>'\n      + '<td>'+fmtTok(h.tokens||0)+'</td>'\n      + '<td style=\"color:var(--mut)\">'+fmtTok(h.inputTokens||0)+'</td>'\n      + '<td style=\"color:var(--mut)\">'+fmtTok(h.outputTokens||0)+'</td>'\n      + '<td>'+fmtCostTicks(h.billedCostUsdTicks||0)+'</td>'\n      + '<td style=\"font-size:11px;color:var(--mut2)\">'+(topModel?(topModel.model+' \u00b7 '+fmtTok(topModel.tokens)):'\u2014')+'</td>'\n      + '</tr>';\n  }).join('') || '<tr><td colspan=\"7\" style=\"text-align:center;color:var(--mut);padding:16px\">No hourly data</td></tr>';\n\n  // provider cards (gateway)\n  var provCards = (SUM.providers||[]).map(function(p){\n    return '<div class=\"usage-item\" style=\"text-align:left\">'\n      + '<div style=\"display:flex;justify-content:space-between;gap:8px;align-items:center\">'\n      + '<div class=\"v\" style=\"font-size:14px\">'+(p.name||p.prefix)+'</div>'\n      + '<span class=\"badge '+(p.enabled===false?'disabled':'active')+'\">'+(p.enabled===false?'off':'on')+'</span></div>'\n      + '<div class=\"k\" style=\"text-transform:none;margin-top:6px;line-height:1.4\">'\n      + 'prefix <b style=\"color:var(--fg)\">'+p.prefix+'</b><br>'\n      + (p.enabledKeyCount||0)+'/'+(p.keyCount||0)+' keys \u00b7 '+(p.models?p.models.length:0)+' models \u00b7 '+(p.type||'openai')\n      + '</div></div>';\n  }).join('') || '<div style=\"color:var(--mut)\">No providers</div>';\n\n  var periodLabel = (d.period||'24h');\n  var rangeLabel = '';\n  if(range.start && range.end){\n    try{\n      rangeLabel = new Date(range.start).toLocaleString('id-ID')+' \u2192 '+new Date(range.end).toLocaleString('id-ID');\n    }catch(e){ rangeLabel = range.start+' \u2192 '+range.end; }\n  }\n\n  \n  var recent = RECENT_REQ || [];\n  var provSet = {};\n  recent.forEach(function(x){ if(x.provider) provSet[x.provider]=1; });\n  var recentProvChips = ['all'].concat(Object.keys(provSet).sort()).map(function(p){\n    var n = p==='all' ? recent.length : recent.filter(function(x){return x.provider===p;}).length;\n    // if filtered server-side, counts are approximate on current list\n    return '<div class=\"pchip '+((RECENT_FILTER||'all')===p?'active':'')+'\" onclick=\"setRecentFilter(\\''+p+'\\')\">'+(p==='all'?'All':p)+' <span class=\"n\">'+n+'</span></div>';\n  }).join('');\n  var recentRows = recent.map(function(x){\n    var when = x.ts ? timeAgo(x.ts) : '\u2014';\n    var prev = (x.preview||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');\n    return '<tr>'\n      + '<td style=\"white-space:nowrap;color:var(--mut2);font-size:11px\" title=\"'+(x.ts||'')+'\">'+when+'</td>'\n      + '<td><span class=\"badge active\">'+(x.provider||'?')+'</span></td>'\n      + '<td style=\"font-weight:600;font-size:12px\">'+(x.model||'\u2014')+'</td>'\n      + '<td>'+recentStatusBadge(!!x.ok, x.status)+'</td>'\n      + '<td style=\"font-weight:600\">'+fmtMs(x.latencyMs)+'</td>'\n      + '<td>'+fmtTok(x.tokens||0)+'</td>'\n      + '<td style=\"color:var(--mut);font-size:11px\">in '+fmtTok(x.promptTokens||0)+' / out '+fmtTok(x.completionTokens||0)+'</td>'\n      + '<td style=\"color:var(--mut2);font-size:11px\">'+(x.credit!=null?Number(x.credit).toFixed(4):'\u2014')+'</td>'\n      + '<td style=\"max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mut);font-size:11px\" title=\"'+prev+'\">'+(prev||'\u2014')+'</td>'\n      + '<td style=\"color:var(--err);font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis\" title=\"'+(String(x.error||'').replace(/\"/g,'&quot;'))+'\">'+(x.error?String(x.error).slice(0,80):'')+'</td>'\n      + '</tr>';\n  }).join('') || '<tr><td colspan=\"10\" style=\"text-align:center;color:var(--mut);padding:18px\">Belum ada request lewat gateway. Coba Test Chat / API call dulu.</td></tr>';\n\ndocument.getElementById('pageContent').innerHTML =\n    '<div class=\"usage-head\">'\n    + '<div class=\"title-block\"><h2>\ud83d\udcc8 Usage Analytics</h2>'\n    + '<p>Traffic 24 jam dari grok2api \u00b7 biar keliatan request, token, cost, dan model mana yang boros</p>'\n    + (rangeLabel?('<p style=\"font-size:11px;color:var(--mut2);margin-top:4px\">Range: '+rangeLabel+'</p>'):'')\n    + '</div>'\n    + '<div class=\"usage-metric-tabs\">'\n    + '<div class=\"tab '+(metric==='requests'?'active':'')+'\" onclick=\"setUsageMetric(\\'requests\\')\">Requests</div>'\n    + '<div class=\"tab '+(metric==='tokens'?'active':'')+'\" onclick=\"setUsageMetric(\\'tokens\\')\">Tokens</div>'\n    + '<div class=\"tab '+(metric==='cost'?'active':'')+'\" onclick=\"setUsageMetric(\\'cost\\')\">Cost</div>'\n    + '<button class=\"btn sm\" onclick=\"refreshAll()\">\u21bb Refresh</button>'\n    + '</div></div>'\n\n    + '<div class=\"stats-grid\">'\n    + '<div class=\"stat-card\"><div class=\"ic\">\ud83d\udcca</div><div class=\"label\">Requests</div><div class=\"value\">'+fmtNum(u.requests)+'</div>'\n    + '<div class=\"kpi-sub\">\u2705 '+fmtNum(okN)+' \u00b7 \u274c '+fmtNum(failN)+'</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\u2705</div><div class=\"label\">Success Rate</div><div class=\"value\">'+fmtPct(u.successRate)+'</div>'\n    + '<div class=\"fail-ok\"><div class=\"seg\"><div class=\"ok\" style=\"width:'+okPct+'%\"></div><div class=\"bad\" style=\"width:'+failPct+'%\"></div></div></div>'\n    + '<div class=\"kpi-sub\">Fail '+failPct+'%</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\ud83c\udfaf</div><div class=\"label\">Total Tokens</div><div class=\"value\">'+fmtTok(u.tokens)+'</div>'\n    + '<div class=\"kpi-sub\">in '+fmtTok(u.inputTokens)+' \u00b7 out '+fmtTok(u.outputTokens)+'</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\ud83d\udcb5</div><div class=\"label\">Est. Cost</div><div class=\"value\" style=\"font-size:24px\">'+fmtCostTicks(u.billedCostUsdTicks)+'</div>'\n    + '<div class=\"kpi-sub\">grok2api accounting \u00b7 '+periodLabel+'</div></div>'\n    + '</div>'\n\n    + '<div class=\"stats-grid\">'\n    + '<div class=\"stat-card\"><div class=\"ic\">\ud83d\udce5</div><div class=\"label\">Input Tokens</div><div class=\"value\" style=\"font-size:22px\">'+fmtTok(u.inputTokens)+'</div>'\n    + '<div class=\"kpi-sub\">cached '+fmtTok(u.cachedInputTokens||0)+'</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\ud83d\udce4</div><div class=\"label\">Output Tokens</div><div class=\"value\" style=\"font-size:22px\">'+fmtTok(u.outputTokens)+'</div>'\n    + '<div class=\"kpi-sub\">reasoning '+fmtTok(u.reasoningTokens||0)+'</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\u23f1\ufe0f</div><div class=\"label\">Peak Hour</div><div class=\"value\" style=\"font-size:22px\">'+(peak?hourLabel(peak.h.start):'\u2014')+'</div>'\n    + '<div class=\"kpi-sub\">'+(peak?(metric==='tokens'?fmtTok(peak.v)+' tok':metric==='cost'?fmtCostTicks(peak.v):fmtNum(peak.v)+' req'):'no data')+'</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\u267e\ufe0f</div><div class=\"label\">All-Time Req</div><div class=\"value\" style=\"font-size:22px\">'+fmtNum(r.allTimeRequests||0)+'</div>'\n    + '<div class=\"kpi-sub\">models '+(r.enabledModels||0)+'/'+(r.totalModels||0)+'</div></div>'\n    + '</div>'\n\n    + '<div class=\"panel\"><div class=\"panel-head\"><h2>\ud83d\udcc9 Traffic 24h \u00b7 '+(metric==='tokens'?'Tokens':metric==='cost'?'Cost':'Requests')+'</h2><span class=\"count\">'+s.length+' jam</span></div>'\n    + '<div class=\"panel-body\">'+chart\n    + '<div style=\"display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:11px;color:var(--mut)\">'\n    + '<span>\u25cf Hover bar buat detail jam</span>'\n    + '<span>\u25cf Metric: <b style=\"color:var(--fg)\">'+metric+'</b></span>'\n    + '</div></div></div>'\n\n    + '<div class=\"split-grid\">'\n    + '<div class=\"panel\" style=\"margin-bottom:0\"><div class=\"panel-head\"><h2>\ud83e\udde9 Usage by Model</h2><span class=\"count\">'+models.length+'</span>'\n    + '<input class=\"search-input\" style=\"max-width:180px;margin-left:auto\" placeholder=\"Filter model...\" value=\"'+(USAGE_SEARCH||'').replace(/\"/g,'&quot;')+'\" oninput=\"setUsageSearch(this.value)\">'\n    + '</div><div class=\"panel-body\" style=\"padding:0\"><div class=\"table-wrap\" style=\"max-height:360px\"><table><thead><tr>'\n    + '<th>#</th><th>Model</th><th>Tier</th><th>Tokens</th><th>Share</th><th>Cost</th><th>Cost%</th><th>Peak</th>'\n    + '</tr></thead><tbody>'+modelTable+'</tbody></table></div></div></div>'\n\n    + '<div class=\"panel\" style=\"margin-bottom:0\"><div class=\"panel-head\"><h2>\ud83d\udd0c Providers & Resources</h2></div><div class=\"panel-body\">'\n    + '<div class=\"usage-grid\" style=\"margin-bottom:14px\">'\n    + '<div class=\"usage-item\"><div class=\"v\">'+(r.activeAccounts||0)+'/'+(r.totalAccounts||0)+'</div><div class=\"k\">Accounts</div></div>'\n    + '<div class=\"usage-item\"><div class=\"v\">'+(r.activeClientKeys||0)+'/'+(r.totalClientKeys||0)+'</div><div class=\"k\">Client Keys</div></div>'\n    + '<div class=\"usage-item\"><div class=\"v\">'+(SUM.providers?SUM.providers.length:0)+'</div><div class=\"k\">GW Providers</div></div>'\n    + '<div class=\"usage-item\"><div class=\"v\">'+(SUM.egress?(SUM.egress.healthy+'/'+SUM.egress.total):'\u2014')+'</div><div class=\"k\">Proxies OK</div></div>'\n    + '</div>'\n    + '<div style=\"font-size:12px;color:var(--mut);margin-bottom:8px\">Gateway connections</div>'\n    + '<div class=\"usage-grid\">'+provCards+'</div>'\n    + '</div></div>'\n    + '</div>'\n\n    + '<div class=\"panel\" style=\"margin-top:18px\"><div class=\"panel-head\"><h2>\ud83d\udd52 Hourly Breakdown</h2><span class=\"count\">newest first</span></div>'\n    + '<div class=\"panel-body\" style=\"padding:0\"><div class=\"table-wrap\" style=\"max-height:420px\"><table><thead><tr>'\n    + '<th>Hour</th><th>Req</th><th>Tokens</th><th>Input</th><th>Output</th><th>Cost</th><th>Top Model</th>'\n    + '</tr></thead><tbody>'+hourRows+'</tbody></table></div></div></div>'\n\n    + '<div class=\"panel\" style=\"margin-top:18px\"><div class=\"panel-head\"><h2>\ud83e\uddfe Recent Requests</h2><span class=\"count\">'+(recent.length)+'</span><button class=\"btn sm\" style=\"margin-left:auto\" onclick=\"loadRecentRequests().then(function(){renderUsage(true)})\">\u21bb</button></div><div class=\"panel-body\" style=\"padding-top:12px\">'\n    + '<div class=\"chipbar\"><span class=\"clabel\">Provider</span>'+recentProvChips\n    + '<input class=\"search-input\" style=\"max-width:220px;margin-left:auto\" placeholder=\"Filter model/error/preview...\" value=\"'+(RECENT_SEARCH||'').replace(/\"/g,'&quot;')+'\" oninput=\"setRecentSearch(this.value)\">'\n    + '</div>'\n    + '<div class=\"table-wrap\" style=\"max-height:420px\"><table><thead><tr>'\n    + '<th>When</th><th>Provider</th><th>Model</th><th>Status</th><th>Latency</th><th>Tokens</th><th>In/Out</th><th>Credit</th><th>Preview</th><th>Error</th>'\n    + '</tr></thead><tbody>'+recentRows+'</tbody></table></div>'\n    + '<div style=\"font-size:11px;color:var(--mut2);margin-top:8px\">Log lokal gateway (max 300). Multi-provider: Grok + CodeBuddy + provider lain lewat ki-gateway.</div>'\n    + '</div></div>'\n        + '<div class=\"panel\"><div class=\"panel-head\"><h2>\u2139\ufe0f Cara Baca</h2></div><div class=\"panel-body\" style=\"font-size:13px;color:var(--mut);line-height:1.7\">'\n    + '<div>\u2022 <b style=\"color:var(--fg)\">Requests</b> = total call chat/completions lewat grok2api (24h).</div>'\n    + '<div>\u2022 <b style=\"color:var(--fg)\">Success rate</b> rendah biasanya quota exhausted / re-auth / proxy fail \u2014 cek Quota Tracker + Accounts.</div>'\n    + '<div>\u2022 <b style=\"color:var(--fg)\">Tokens</b> = input + output (+ reasoning/cached kalau ada).</div>'\n    + '<div>\u2022 <b style=\"color:var(--fg)\">Est. Cost</b> = accounting internal grok2api (<code>billedCostUsdTicks/1e9</code>), bukan invoice provider bayar.</div>'\n    + '<div>\u2022 <b style=\"color:var(--fg)\">By Model</b> nunjukin model mana yang paling boros token/cost.</div>'\n    + '<div>\u2022 Traffic provider non-Grok (CodeBuddy dll) belum masuk series 24h Grok \u2014 tapi masuk <b style=\"color:var(--fg)\">Recent Requests</b>.</div>'\n    + '</div></div>';\n}\n\nfunction renderChat(){\n  document.getElementById('pageContent').innerHTML =\n    '<div class=\"panel\"><div class=\"panel-head\"><h2>\ud83d\udcac Test Chat</h2></div><div class=\"panel-body\">'\n    + '<div style=\"margin-bottom:10px\"><select id=\"chatModel\" style=\"min-width:240px\"></select></div>'\n    + '<textarea id=\"chatPrompt\" rows=\"3\" placeholder=\"Ketik prompt...\" style=\"margin-bottom:10px\">Halo, kamu model apa?</textarea>'\n    + '<div style=\"display:flex;gap:8px\"><button class=\"btn primary\" id=\"chatBtn\" onclick=\"doChat()\">Kirim</button><button class=\"btn\" onclick=\"document.getElementById(\\'chatPrompt\\').value=\\'\\'\">Clear</button></div>'\n    + '<div class=\"chat-box empty\" id=\"chatOut\">Response...</div>'\n    + '<div class=\"chat-meta\" id=\"chatMeta\"></div>'\n    + '</div></div>';\n  var sel=document.getElementById('chatModel');\n  // Prefer gateway providers map (multi-provider). Fallback to grok models list.\n  if(SUM.providers && SUM.providers.length){\n    SUM.providers.forEach(function(p){(p.models||[]).forEach(function(m){var o=document.createElement('option');o.value=p.prefix+'/'+m.id;o.textContent=(m.label||m.id)+' \u00b7 '+p.prefix;sel.appendChild(o);});});\n  } else {\n    SUM.models.filter(m=>m.available).forEach(function(m){var o=document.createElement('option');o.value='grok/'+m.id;o.textContent=m.id+' ('+m.provider+')';sel.appendChild(o);});\n  }\n  if(!sel.options.length){SUM.providers.forEach(function(p){p.models.forEach(function(m){var o=document.createElement('option');o.value=p.prefix+'/'+m.id;o.textContent=(m.label||m.id)+' ('+p.prefix+')';sel.appendChild(o);});});}\n}\nasync function doChat(){\n  var out=document.getElementById('chatOut'),btn=document.getElementById('chatBtn'),meta=document.getElementById('chatMeta');\n  out.classList.remove('empty');out.textContent='Loading...';meta.textContent='';btn.disabled=true;\n  try{\n    var r=await fetch('/admin/testchat',{method:'POST',headers:hdr(),body:JSON.stringify({model:document.getElementById('chatModel').value,prompt:document.getElementById('chatPrompt').value})}).then(r=>r.json());\n    out.textContent=r.reply||JSON.stringify(r);\n    meta.textContent='Model: '+(r.model||'?')+(r.usage?' Tokens: in '+fmtNum(r.usage.prompt_tokens)+' / out '+fmtNum(r.usage.completion_tokens):'');\n  }catch(e){out.textContent='Error: '+e.message;}\n  btn.disabled=false;\n}\n\nfunction renderConvert(){\n  var allWeb=(ACCS||[]).filter(function(a){return a.provider==='grok_web'});\n  var pending=allWeb.filter(function(a){return !(a.linkedProvider==='grok_build' && a.linkedAccountId)});\n  var done=allWeb.filter(function(a){return a.linkedProvider==='grok_build' && a.linkedAccountId});\n  document.getElementById('pageContent').innerHTML =\n    '<div class=\"stats-grid\">'\n    + '<div class=\"stat-card\"><div class=\"ic\">\ud83c\udf10</div><div class=\"label\">Web Total</div><div class=\"value\">'+allWeb.length+'</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\u23f3</div><div class=\"label\">Belum Convert</div><div class=\"value\">'+pending.length+'</div><div class=\"sub\">bisa di-convert</div></div>'\n    + '<div class=\"stat-card\"><div class=\"ic\">\u2705</div><div class=\"label\">Sudah Build</div><div class=\"value\">'+done.length+'</div><div class=\"sub\">skip otomatis</div></div>'\n    + '</div>'\n    + '<div class=\"panel\"><div class=\"panel-head\"><h2>\ud83d\udd04 Convert Web to Build</h2><span class=\"count\">'+pending.length+' pending</span></div><div class=\"panel-body\">'\n    + '<p style=\"color:var(--mut);margin-bottom:16px\">Convert akun Web ke Build (unlock Grok-4.5). Otomatis, tanpa login manual. Akun yang <b>sudah punya Build</b> otomatis di-skip biar ga duplikat.</p>'\n    + '<div style=\"display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px\">'\n    + '<button class=\"btn primary\" id=\"convAllBtn\" onclick=\"doConvertAll()\"'+(pending.length===0?' disabled':'')+'>\u26a1 Convert Semua Pending ('+pending.length+')</button>'\n    + '<button class=\"btn\" id=\"convSelBtn\" onclick=\"doConvertSelected()\">\u2705 Convert Terpilih</button>'\n    + '</div>'\n    + '<div id=\"convProgress\" style=\"margin-bottom:14px\"></div>'\n    + (pending.length===0\n        ? '<div style=\"padding:20px;text-align:center;color:var(--ok);background:var(--bg2);border-radius:10px\">\ud83c\udf89 Semua '+allWeb.length+' akun Web sudah punya Build. Ga ada yang perlu di-convert.</div>'\n        : '<div class=\"table-wrap\" style=\"max-height:400px\"><table><thead><tr>'\n          + '<th style=\"width:30px\"><input type=\"checkbox\" id=\"convCheckAll\" onchange=\"convToggleAll(this)\"></th>'\n          + '<th>ID</th><th>Email/Name</th><th>Status</th><th>Last Used</th></tr></thead><tbody>'\n          + pending.map(function(a){return '<tr><td><input type=\"checkbox\" class=\"conv-check\" value=\"'+a.id+'\"></td>'\n              +'<td style=\"color:var(--mut);font-size:11px\">'+a.id+'</td>'\n              +'<td style=\"font-weight:600\">'+(a.email||a.name)+'</td>'\n              +'<td><span class=\"badge '+(a.authStatus==='active'?'active':'error')+'\">'+a.authStatus+'</span></td>'\n              +'<td style=\"color:var(--mut2);font-size:11px\">'+timeAgo(a.lastUsedAt)+'</td></tr>';}).join('')\n          + '</tbody></table></div>')\n    + '</div></div>'\n    + (done.length? '<div class=\"panel\"><div class=\"panel-head\"><h2>\u2705 Sudah di-Convert</h2><span class=\"count\">'+done.length+'</span></div><div class=\"panel-body\"><div class=\"table-wrap\" style=\"max-height:260px\"><table><thead><tr><th>ID</th><th>Email/Name</th><th>Build Linked</th></tr></thead><tbody>'\n        + done.map(function(a){return '<tr><td style=\"color:var(--mut);font-size:11px\">'+a.id+'</td><td style=\"font-weight:600\">'+(a.email||a.name)+'</td><td style=\"color:var(--ok);font-size:11px\">\u2192 '+(a.linkedAccountName||a.linkedAccountId)+'</td></tr>';}).join('')\n        + '</tbody></table></div></div></div>' : '');\n}\nfunction convToggleAll(cb){document.querySelectorAll('.conv-check').forEach(function(c){c.checked=cb.checked});}\nasync function doConvertAll(){\n  var pending=(ACCS||[]).filter(function(a){return a.provider==='grok_web' && !(a.linkedProvider==='grok_build' && a.linkedAccountId)});\n  if(!pending.length){alert('Semua akun Web sudah punya Build, ga ada yang perlu convert');return;}\n  if(!confirm('Convert '+pending.length+' akun Web (yang belum punya Build) ke Build?'))return;\n  await runConvert({ids:pending.map(function(a){return a.id})}, pending.length);\n}\nasync function doConvertSelected(){\n  var ids=Array.from(document.querySelectorAll('.conv-check:checked')).map(function(c){return parseInt(c.value)});\n  if(!ids.length){alert('Pilih minimal 1 akun');return;}\n  if(!confirm('Convert '+ids.length+' akun terpilih ke Build?'))return;\n  await runConvert({ids:ids}, ids.length);\n}\nasync function runConvert(body, count){\n  var p=document.getElementById('convProgress');\n  var a1=document.getElementById('convAllBtn'),a2=document.getElementById('convSelBtn');\n  if(a1)a1.disabled=true;if(a2)a2.disabled=true;\n  p.innerHTML='<div style=\"padding:12px;background:var(--bg2);border-radius:10px;border:1px solid var(--bd)\"><span style=\"color:var(--acc)\">\u23f3 Converting '+count+' akun... (jangan tutup halaman)</span></div>';\n  try{\n    var r=await fetch('/admin/convert',{method:'POST',headers:hdr(),body:JSON.stringify(body)}).then(function(r){return r.json()});\n    var created=r.created||0,failed=r.failed||0,skipped=r.skipped||0,linked=r.linked||0;\n    p.innerHTML='<div style=\"padding:12px;background:var(--bg2);border-radius:10px;border:1px solid var(--bd)\">'\n      +'<div style=\"color:var(--ok);font-weight:600;margin-bottom:6px\">\u2705 Convert selesai!</div>'\n      +'<div style=\"font-size:13px\">Created: <b>'+created+'</b> \u00b7 Linked: <b>'+linked+'</b> \u00b7 Skipped: '+skipped+(failed>0?' \u00b7 <span style=\"color:var(--err)\">Failed: '+failed+'</span>':'')+'</div></div>';\n    setTimeout(refreshAll,1500);\n  }catch(e){\n    p.innerHTML='<div style=\"padding:12px;background:var(--bg2);border-radius:10px;border:1px solid var(--err)\"><span style=\"color:var(--err)\">\u274c Error: '+e.message+'</span></div>';\n    if(a1)a1.disabled=false;if(a2)a2.disabled=false;\n  }\n}\n\nfunction maskKey(k){ if(!k) return '\u2014'; if(k.length<=10) return '\u2022\u2022\u2022\u2022'; return k.slice(0,6)+'\u2026'+k.slice(-4); }\n\n// Catalog templates (9router-style cards). Connected state pulled from SUM.providers.\nconst PROV_CATALOG = [\n  // OAuth\n  {id:'kiro', section:'oauth', name:'Kiro AI', icon:'\ud83d\udfe3', desc:'AWS CodeWhisperer OAuth', type:'openai', authMode:'oauth', baseUrl:'https://codewhisperer.us-east-1.amazonaws.com', models:'claude-sonnet-4.5|Sonnet 4.5\\nclaude-sonnet-4|Sonnet 4\\nclaude-haiku-4.5|Haiku 4.5\\nauto|Auto', comingSoon:true},\n  {id:'codebuddy-cn', section:'oauth', name:'CodeBuddy CN', icon:'\ud83d\udc99', desc:'Tencent CodeBuddy China', type:'openai', authMode:'oauth', baseUrl:'https://www.codebuddy.cn/api', models:'auto|Auto', comingSoon:true},\n  {id:'grok-cli', section:'oauth', name:'Grok CLI (Build)', icon:'\u26a1', desc:'Grok Build device flow', type:'openai', authMode:'oauth', baseUrl:'http://127.0.0.1:8010/v1', models:'grok-4.5|Grok 4.5', comingSoon:true},\n  {id:'xai', section:'oauth', name:'xAI (Grok)', icon:'\u2716\ufe0f', desc:'xAI OAuth / API', type:'openai', authMode:'api-key', baseUrl:'https://api.x.ai/v1', models:'grok-3|Grok 3\\ngrok-3-mini|Grok 3 Mini'},\n  // Free / local pools\n  {id:'grok', section:'free', name:'Grok2API', icon:'\ud83d\ude80', desc:'Local grok2api pool', type:'openai', authMode:'api-key', baseUrl:'http://127.0.0.1:8010/v1', models:'grok-4.5|Grok 4.5 (Build)\\ngrok-chat-fast|Grok Chat Fast (Web)', lockedPrefix:true},\n  {id:'cbai', section:'free', name:'CodeBuddy Global', icon:'\ud83c\udf10', desc:'Native CodeBuddy .ai', type:'codebuddy', authMode:'api-key', baseUrl:'https://www.codebuddy.ai', models:'glm-5.2|GLM 5.2\\nglm-5.1|GLM 5.1\\nclaude-opus-4.6|Claude Opus 4.6\\ngpt-5.5|GPT-5.5\\ngemini-3.1-pro|Gemini 3.1 Pro\\ndeepseek-v4-flash|DeepSeek V4 Flash\\nauto|Auto'},\n  {id:'openmodel', section:'free', name:'OpenModel', icon:'\ud83e\udde0', desc:'OpenModel free models', type:'openai', authMode:'api-key', baseUrl:'https://api.openmodel.ai/v1', models:'deepseek-v4-flash|DeepSeek V4 Flash'},\n  {id:'ollama', section:'free', name:'Ollama', icon:'\ud83e\udd99', desc:'Local Ollama', type:'openai', authMode:'api-key', baseUrl:'http://127.0.0.1:11434/v1', models:'llama3.1|Llama 3.1'},\n  // API key providers\n  {id:'openai', section:'apikey', name:'OpenAI', icon:'\ud83d\udfe2', desc:'OpenAI official API', type:'openai', authMode:'api-key', baseUrl:'https://api.openai.com/v1', models:'gpt-4o|GPT-4o\\ngpt-4o-mini|GPT-4o Mini\\no3-mini|o3-mini'},\n  {id:'anthropic', section:'apikey', name:'Anthropic', icon:'\ud83c\udd70\ufe0f', desc:'Claude API (OpenAI-compat proxy)', type:'openai', authMode:'api-key', baseUrl:'https://api.anthropic.com/v1', models:'claude-sonnet-4-5|Sonnet 4.5\\nclaude-opus-4-5|Opus 4.5'},\n  {id:'openrouter', section:'apikey', name:'OpenRouter', icon:'\ud83d\udee3\ufe0f', desc:'OpenRouter multi-model', type:'openai', authMode:'api-key', baseUrl:'https://openrouter.ai/api/v1', models:'openrouter/auto|Auto'},\n  {id:'gemini', section:'apikey', name:'Google Gemini', icon:'\u2728', desc:'Gemini OpenAI-compat', type:'openai', authMode:'api-key', baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai', models:'gemini-2.0-flash|Gemini 2.0 Flash'},\n  {id:'deepseek', section:'apikey', name:'DeepSeek', icon:'\ud83c\udf0a', desc:'DeepSeek API', type:'openai', authMode:'api-key', baseUrl:'https://api.deepseek.com/v1', models:'deepseek-chat|DeepSeek Chat\\ndeepseek-reasoner|DeepSeek Reasoner'},\n  {id:'groq', section:'apikey', name:'Groq', icon:'\u26a1', desc:'Groq fast inference', type:'openai', authMode:'api-key', baseUrl:'https://api.groq.com/openai/v1', models:'llama-3.3-70b-versatile|Llama 3.3 70B'},\n  {id:'together', section:'apikey', name:'Together AI', icon:'\ud83e\udd1d', desc:'Together OpenAI-compat', type:'openai', authMode:'api-key', baseUrl:'https://api.together.xyz/v1', models:'meta-llama/Llama-3.3-70B-Instruct-Turbo|Llama 3.3 70B'},\n  {id:'custom', section:'apikey', name:'Custom OpenAI', icon:'\ud83e\udde9', desc:'Any OpenAI-compatible endpoint', type:'openai', authMode:'api-key', baseUrl:'https://api.example.com/v1', models:'model-id|Model'},\n];\n\nlet PROV_SEARCH = '';\nlet MODAL = null; // current modal catalog item / connected provider\n\nfunction connectedMap(){\n  var m={};\n  (SUM.providers||[]).forEach(function(p){ m[p.prefix]=p; });\n  return m;\n}\nfunction findCatalog(id){ return PROV_CATALOG.find(function(c){return c.id===id;}); }\n\nfunction statusLine(conn, cat){\n  if(cat && cat.comingSoon && !conn) return {cls:'', text:'OAuth soon \u00b7 setup manual key ok', dot:''};\n  if(!conn) return {cls:'', text:'No connections', dot:''};\n  if(conn.enabled===false) return {cls:'', text:'Disabled \u00b7 '+(conn.keyCount||0)+' keys', dot:''};\n  var n = conn.enabledKeyCount!=null ? conn.enabledKeyCount : (conn.hasKey?1:0);\n  if(n>0) return {cls:'ok', text: n+' Connected', dot:'ok'};\n  return {cls:'', text:'Configured \u00b7 no keys', dot:''};\n}\n\nfunction renderProviders(){\n  var cmap = connectedMap();\n  var q = (PROV_SEARCH||'').toLowerCase().trim();\n  var sections = [\n    {id:'oauth', title:'OAuth Providers'},\n    {id:'free', title:'Free / Local Pools'},\n    {id:'apikey', title:'API Key Providers'},\n    {id:'connected', title:'Your Connections'},\n  ];\n\n  // custom connected not in catalog\n  var catalogIds = {};\n  PROV_CATALOG.forEach(function(c){ catalogIds[c.id]=1; });\n  var extras = (SUM.providers||[]).filter(function(p){ return !catalogIds[p.prefix]; });\n\n  function cardsHtml(items, mode){\n    return items.map(function(item){\n      var cat = mode==='catalog' ? item : findCatalog(item.prefix);\n      var conn = mode==='catalog' ? cmap[item.id] : item;\n      var id = mode==='catalog' ? item.id : item.prefix;\n      var name = mode==='catalog' ? item.name : (item.name||item.prefix);\n      var icon = (cat && cat.icon) || '\ud83d\udd0c';\n      var st = statusLine(conn, cat);\n      var connected = !!conn;\n      var btn = connected\n        ? '<button class=\"btn sm\" onclick=\"openProviderManage(\\''+id+'\\')\">Manage</button>'\n        : '<button class=\"btn sm ghost\" onclick=\"openProviderAdd(\\''+id+'\\')\">+ Add</button>';\n      if(mode==='catalog' && item.comingSoon && !connected){\n        btn = '<button class=\"btn sm ghost\" onclick=\"openProviderAdd(\\''+id+'\\')\">+ Setup</button>';\n      }\n      return '<div class=\"prov-card'+(connected?' connected':'')+'\">'\n        +'<div class=\"prov-ico\">'+icon+'</div>'\n        +'<div class=\"prov-meta\"><div class=\"prov-name\">'+name+'</div>'\n        +'<div class=\"prov-status\">'+(st.dot?('<span class=\"sdot '+st.dot+'\"></span>'):'')+st.text+'</div></div>'\n        +'<div class=\"prov-actions\">'+btn+'</div></div>';\n    }).join('');\n  }\n\n  function filterCatalog(sec){\n    return PROV_CATALOG.filter(function(c){\n      if(c.section!==sec) return false;\n      if(!q) return true;\n      return (c.name+' '+c.id+' '+c.desc+' '+c.type).toLowerCase().indexOf(q)>=0;\n    });\n  }\n\n  var body = '';\n  body += '<div class=\"prov-top\">'\n    +'<div class=\"title-block\"><h2>\ud83d\udd0c Providers</h2><p>Manage your AI provider connections \u2014 9router-style catalog</p></div>'\n    +'<button class=\"btn sm\" onclick=\"testAllProviders()\">\u25b6 Test All</button>'\n    +'<input class=\"prov-search\" id=\"provSearch\" placeholder=\"Search providers...\" value=\"'+PROV_SEARCH.replace(/\"/g,'&quot;')+'\" oninput=\"PROV_SEARCH=this.value;renderProviders()\">'\n    +'</div>';\n\n  // OAuth / Free / API Key sections\n  ['oauth','free','apikey'].forEach(function(sec){\n    var items = filterCatalog(sec);\n    if(!items.length) return;\n    var title = sections.find(function(s){return s.id===sec;}).title;\n    body += '<div class=\"prov-sec\"><div class=\"prov-sec-head\"><h3>'+title+'</h3>'\n      +'<span class=\"count\" style=\"font-size:11px;color:var(--mut);background:var(--bg2);padding:2px 8px;border-radius:99px\">'+items.length+'</span>'\n      +'</div><div class=\"prov-grid\">'+cardsHtml(items,'catalog')+'</div></div>';\n  });\n\n  // Connected extras + full list of active\n  var connectedList = (SUM.providers||[]).filter(function(p){\n    if(!q) return true;\n    return (p.prefix+' '+p.name+' '+(p.type||'')).toLowerCase().indexOf(q)>=0;\n  });\n  body += '<div class=\"prov-sec\"><div class=\"prov-sec-head\"><h3>Your Connections</h3>'\n    +'<span class=\"count\" style=\"font-size:11px;color:var(--mut);background:var(--bg2);padding:2px 8px;border-radius:99px\">'+connectedList.length+'</span>'\n    +'<button class=\"btn sm\" style=\"margin-left:auto\" onclick=\"openProviderAdd(\\'custom\\')\">+ Custom</button>'\n    +'</div>';\n  if(!connectedList.length){\n    body += '<div style=\"padding:18px;color:var(--mut);background:var(--card);border:1px dashed var(--bd);border-radius:12px\">Belum ada koneksi aktif. Klik <b>+ Add</b> di card provider.</div>';\n  } else {\n    body += '<div class=\"prov-grid\">'+connectedList.map(function(p){\n      var cat = findCatalog(p.prefix);\n      var st = statusLine(p, cat);\n      return '<div class=\"prov-card connected\">'\n        +'<div class=\"prov-ico\">'+(cat&&cat.icon?cat.icon:'\ud83d\udd0c')+'</div>'\n        +'<div class=\"prov-meta\"><div class=\"prov-name\">'+(p.name||p.prefix)+' <span style=\"color:var(--mut2);font-weight:500\">('+p.prefix+')</span></div>'\n        +'<div class=\"prov-status\"><span class=\"sdot '+(st.dot||'')+'\"></span>'+st.text+' \u00b7 '+(p.type||'openai')+' \u00b7 '+(p.authMode||'api-key')+'</div></div>'\n        +'<div class=\"prov-actions\">'\n        +'<button class=\"btn sm\" onclick=\"openProviderManage(\\''+p.prefix+'\\')\">Manage</button>'\n        +'</div></div>';\n    }).join('')+'</div>';\n  }\n  body += '</div>';\n\n  // modal mount\n  body += '<div id=\"provModalRoot\"></div>';\n\n  document.getElementById('pageContent').innerHTML = body;\n  if(MODAL) renderProvModal();\n}\n\nfunction closeProvModal(){ MODAL=null; var r=document.getElementById('provModalRoot'); if(r) r.innerHTML=''; }\nfunction openProviderAdd(id){\n  var cat = findCatalog(id) || findCatalog('custom');\n  var conn = connectedMap()[id];\n  MODAL = {mode:'add', id:id, cat:cat, conn:conn};\n  // if custom and id not catalog, still custom\n  if(id==='custom') MODAL.id = '';\n  renderProvModal();\n}\nfunction openProviderManage(prefix){\n  var conn = connectedMap()[prefix];\n  var cat = findCatalog(prefix);\n  MODAL = {mode:'manage', id:prefix, cat:cat, conn:conn};\n  renderProvModal();\n}\n\nfunction renderProvModal(){\n  var root = document.getElementById('provModalRoot');\n  if(!root || !MODAL) return;\n  var cat = MODAL.cat || {};\n  var conn = MODAL.conn || null;\n  var mode = MODAL.mode;\n  var title = mode==='manage' ? ('Manage \u00b7 '+(conn&&conn.name||MODAL.id)) : ('Add \u00b7 '+(cat.name||'Provider'));\n  var prefix = (conn && conn.prefix) || MODAL.id || cat.id || '';\n  var base = (conn && conn.baseUrl) || cat.baseUrl || '';\n  var typ = (conn && conn.type) || cat.type || 'openai';\n  var auth = (conn && conn.authMode) || cat.authMode || 'api-key';\n  var models = (conn && conn.models && conn.models.length)\n    ? conn.models.map(function(m){return m.label&&m.label!==m.id?(m.id+'|'+m.label):m.id;}).join('\\n')\n    : (cat.models||'');\n  var keyCount = conn ? (conn.keyCount||0) : 0;\n  var keys = (conn && conn.keys) || [];\n\n  var keysRows = keys.map(function(k){\n    return '<tr><td style=\"font-size:11px;color:var(--mut)\">'+k.id+'</td>'\n      +'<td style=\"font-size:11px\">'+maskKey(k.keyMasked)+'</td>'\n      +'<td><span class=\"badge '+(k.enabled?'active':'disabled')+'\">'+(k.enabled?'on':'off')+'</span></td>'\n      +'<td style=\"white-space:nowrap\">'\n      +'<button class=\"btn sm\" onclick=\"toggleKey(\\''+prefix+'\\',\\''+k.id+'\\','+(!k.enabled)+')\">'+(k.enabled?'Off':'On')+'</button> '\n      +'<button class=\"btn sm\" style=\"color:var(--err)\" onclick=\"deleteKey(\\''+prefix+'\\',\\''+k.id+'\\')\">Del</button>'\n      +'</td></tr>';\n  }).join('') || '<tr><td colspan=\"4\" style=\"color:var(--mut);text-align:center;padding:12px\">No keys yet</td></tr>';\n\n  root.innerHTML =\n    '<div class=\"modal-back\" onclick=\"if(event.target===this)closeProvModal()\">'\n    +'<div class=\"modal\">'\n    +'<div class=\"modal-head\"><h3>'+title+'</h3><button class=\"btn sm\" onclick=\"closeProvModal()\">\u2715</button></div>'\n    +'<div class=\"modal-body\">'\n    +(cat.comingSoon && mode==='add' ? '<div style=\"padding:10px 12px;border-radius:10px;background:#f0a93b15;color:var(--warn);font-size:12px;margin-bottom:12px\">OAuth button full belum. Bisa setup manual pakai API key / token dulu.</div>' : '')\n    +'<div class=\"chip-row\">'\n    +'<div class=\"chip '+(auth==='api-key'?'active':'')+'\" id=\"chipAuthKey\" onclick=\"setModalAuth(\\'api-key\\')\">\ud83d\udd11 API Key</div>'\n    +'<div class=\"chip '+(auth==='oauth'?'active':'')+'\" id=\"chipAuthOauth\" onclick=\"setModalAuth(\\'oauth\\')\">\ud83d\udd10 OAuth</div>'\n    +'<div class=\"chip active\" id=\"chipModeSingle\" onclick=\"setModalKeyMode(\\'single\\')\">Single</div>'\n    +'<div class=\"chip\" id=\"chipModeBulk\" onclick=\"setModalKeyMode(\\'bulk\\')\">Bulk</div>'\n    +'</div>'\n    +'<input type=\"hidden\" id=\"pvAuthMode\" value=\"'+auth+'\">'\n    +'<input type=\"hidden\" id=\"pvKeyMode\" value=\"single\">'\n    +'<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:10px\">'\n    +'<div class=\"field\"><label>Prefix *</label><input id=\"pvPrefix\" type=\"text\" value=\"'+prefix+'\" '+(conn||cat.lockedPrefix?'readonly style=\"opacity:.75\"':'')+' placeholder=\"cbai\"></div>'\n    +'<div class=\"field\"><label>Display Name</label><input id=\"pvName\" type=\"text\" value=\"'+(conn&&conn.name||cat.name||'')+'\" placeholder=\"Provider name\"></div>'\n    +'</div>'\n    +'<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:10px\">'\n    +'<div class=\"field\"><label>Type</label><select id=\"pvType\"><option value=\"openai\"'+(typ==='openai'?' selected':'')+'>OpenAI-compatible</option><option value=\"codebuddy\"'+(typ==='codebuddy'?' selected':'')+'>CodeBuddy Global</option></select></div>'\n    +'<div class=\"field\"><label>Base URL *</label><input id=\"pvBase\" type=\"text\" value=\"'+base+'\" placeholder=\"https://api.openai.com/v1\"></div>'\n    +'</div>'\n    +'<div class=\"field\" id=\"singleKeyBox\"><label>API Key '+(mode==='manage'?'(optional add)':'*')+'</label><input id=\"pvKey\" type=\"password\" placeholder=\"'+(keyCount?'kosong = keep existing':'sk-... / ck_...')+'\"></div>'\n    +'<div class=\"field hidden\" id=\"bulkKeyBox\"><label>Bulk API Keys (1 per line)</label><textarea id=\"pvBulkKeys\" rows=\"5\" placeholder=\"ck_xxx\\nck_yyy\\nsk_zzz\"></textarea><div class=\"hint\">Bulk keys masuk pool yang sama, round-robin.</div></div>'\n    +'<div class=\"field\"><label>Models (id atau id|label)</label><textarea id=\"pvModels\" rows=\"4\">'+models+'</textarea></div>'\n    +'<label style=\"font-size:12px;color:var(--mut);display:flex;gap:6px;align-items:center;margin-bottom:8px\"><input type=\"checkbox\" id=\"pvEnabled\" '+( !conn || conn.enabled!==false ? 'checked':'' )+'> Enabled</label>'\n    +(mode==='manage' ? (\n      '<div style=\"margin-top:8px;padding-top:12px;border-top:1px solid var(--bd2)\">'\n      +'<div style=\"display:flex;align-items:center;gap:8px;margin-bottom:8px\"><b style=\"font-size:13px\">\ud83d\udd11 Key Pool</b><span class=\"count\" style=\"font-size:11px;color:var(--mut)\">'+keyCount+'</span></div>'\n      +'<div class=\"table-wrap\" style=\"max-height:180px\"><table><thead><tr><th>ID</th><th>Key</th><th>Status</th><th></th></tr></thead><tbody>'+keysRows+'</tbody></table></div>'\n      +'</div>'\n    ) : '')\n    +'<div id=\"pvResult\" style=\"margin-top:10px\"></div>'\n    +'</div>'\n    +'<div class=\"modal-foot\">'\n    +(mode==='manage' && prefix!=='grok' ? '<button class=\"btn sm\" style=\"color:var(--err);margin-right:auto\" onclick=\"deleteProvider(\\''+prefix+'\\')\">Delete Provider</button>' : '<span style=\"margin-right:auto\"></span>')\n    +'<button class=\"btn\" onclick=\"closeProvModal()\">Cancel</button>'\n    +'<button class=\"btn sm\" onclick=\"testProviderForm()\">\ud83e\uddea Test API Key</button>'\n    +'<button class=\"btn primary\" onclick=\"saveProvider()\">'+(mode==='manage'?'\ud83d\udcbe Update':'\u2795 Connect')+'</button>'\n    +'</div></div></div>';\n}\n\nfunction setModalAuth(mode){\n  var el=document.getElementById('pvAuthMode'); if(el) el.value=mode;\n  var a=document.getElementById('chipAuthKey'); if(a) a.classList.toggle('active', mode==='api-key');\n  var b=document.getElementById('chipAuthOauth'); if(b) b.classList.toggle('active', mode==='oauth');\n}\nfunction setModalKeyMode(mode){\n  var el=document.getElementById('pvKeyMode'); if(el) el.value=mode;\n  var a=document.getElementById('chipModeSingle'); if(a) a.classList.toggle('active', mode==='single');\n  var b=document.getElementById('chipModeBulk'); if(b) b.classList.toggle('active', mode==='bulk');\n  var s=document.getElementById('singleKeyBox'); if(s) s.classList.toggle('hidden', mode!=='single');\n  var k=document.getElementById('bulkKeyBox'); if(k) k.classList.toggle('hidden', mode!=='bulk');\n}\nfunction parseModelsText(txt){\n  return (txt||'').split('\\n').map(function(s){return s.trim()}).filter(Boolean).map(function(line){\n    var parts=line.split('|');\n    var id=(parts[0]||'').trim();\n    var label=(parts[1]||id).trim();\n    return {id:id,label:label};\n  }).filter(function(m){return !!m.id});\n}\nasync function saveProvider(){\n  var out=document.getElementById('pvResult');\n  if(!out) return;\n  var prefix=(document.getElementById('pvPrefix').value||'').trim().toLowerCase();\n  var keyMode=(document.getElementById('pvKeyMode')||{}).value||'single';\n  var authMode=(document.getElementById('pvAuthMode')||{}).value||'api-key';\n  var body={\n    prefix:prefix,\n    name:(document.getElementById('pvName').value||'').trim()||prefix,\n    type:(document.getElementById('pvType').value||'openai'),\n    authMode:authMode,\n    baseUrl:(document.getElementById('pvBase').value||'').trim(),\n    enabled:!!document.getElementById('pvEnabled').checked,\n    models:parseModelsText(document.getElementById('pvModels').value)\n  };\n  if(keyMode==='bulk') body.bulkKeys = document.getElementById('pvBulkKeys').value||'';\n  else body.key = (document.getElementById('pvKey').value||'').trim();\n\n  if(!body.prefix || !/^[a-z0-9_-]+$/.test(body.prefix)){ out.innerHTML='<span style=\"color:var(--err)\">Prefix wajib</span>'; return; }\n  if(!body.baseUrl){ out.innerHTML='<span style=\"color:var(--err)\">Base URL wajib</span>'; return; }\n  if(!body.models.length){ out.innerHTML='<span style=\"color:var(--err)\">Minimal 1 model</span>'; return; }\n  out.innerHTML='<span style=\"color:var(--acc)\">Saving...</span>';\n  try{\n    var r=await fetch('/admin/providers',{method:'POST',headers:hdr(),body:JSON.stringify(body)}).then(function(r){return r.json()});\n    if(r.error){ out.innerHTML='<span style=\"color:var(--err)\">'+r.error+'</span>'; return; }\n    out.innerHTML='<span style=\"color:var(--ok)\">\u2705 Saved <b>'+body.prefix+'</b></span>';\n    await refreshAll();\n    MODAL = {mode:'manage', id:body.prefix, cat:findCatalog(body.prefix), conn:connectedMap()[body.prefix]};\n    renderProviders();\n  }catch(e){ out.innerHTML='<span style=\"color:var(--err)\">'+e.message+'</span>'; }\n}\nasync function toggleProvider(prefix, enabled){\n  try{\n    var r=await fetch('/admin/providers/toggle',{method:'POST',headers:hdr(),body:JSON.stringify({prefix:prefix,enabled:!!enabled})}).then(function(r){return r.json()});\n    if(r.error){ alert(r.error); return; }\n    await refreshAll(); goPage('providers');\n  }catch(e){ alert(e.message); }\n}\nasync function deleteProvider(prefix){\n  if(prefix==='grok'){ alert('Provider grok default tidak boleh dihapus'); return; }\n  if(!confirm('Hapus provider '+prefix+'?')) return;\n  try{\n    var r=await fetch('/admin/providers/delete',{method:'POST',headers:hdr(),body:JSON.stringify({prefix:prefix})}).then(function(r){return r.json()});\n    if(r.error){ alert(r.error); return; }\n    closeProvModal();\n    await refreshAll(); goPage('providers');\n  }catch(e){ alert(e.message); }\n}\nasync function deleteKey(prefix,id){\n  if(!confirm('Hapus key '+id+'?')) return;\n  await fetch('/admin/providers/keys/delete',{method:'POST',headers:hdr(),body:JSON.stringify({prefix:prefix,id:id})});\n  await refreshAll();\n  MODAL = {mode:'manage', id:prefix, cat:findCatalog(prefix), conn:connectedMap()[prefix]};\n  renderProviders();\n}\nasync function toggleKey(prefix,id,enabled){\n  await fetch('/admin/providers/keys/toggle',{method:'POST',headers:hdr(),body:JSON.stringify({prefix:prefix,id:id,enabled:!!enabled})});\n  await refreshAll();\n  MODAL = {mode:'manage', id:prefix, cat:findCatalog(prefix), conn:connectedMap()[prefix]};\n  renderProviders();\n}\nasync function testProviderForm(){\n  var out=document.getElementById('pvResult');\n  if(!out) return;\n  var prefix=(document.getElementById('pvPrefix').value||'').trim().toLowerCase();\n  var models=parseModelsText((document.getElementById('pvModels')||{}).value||'');\n  var model = models[0] ? models[0].id : '';\n  var keyMode=(document.getElementById('pvKeyMode')||{}).value||'single';\n  var key='';\n  if(keyMode==='single') key=((document.getElementById('pvKey')||{}).value||'').trim();\n  if(!prefix){ out.innerHTML='<span style=\"color:var(--err)\">Isi prefix dulu</span>'; return; }\n  out.innerHTML='<span style=\"color:var(--acc)\">\ud83e\uddea Testing API key '+prefix+(model?('/'+model):'')+'...</span>';\n  try{\n    var body={prefix:prefix, model:model, prompt:'Reply with exactly: OK'};\n    if(key) body.key=key;\n    // also send draft config so unsaved provider can be tested\n    body.type=(document.getElementById('pvType')||{}).value||'openai';\n    body.baseUrl=((document.getElementById('pvBase')||{}).value||'').trim();\n    var r=await fetch('/admin/providers/test',{method:'POST',headers:hdr(),body:JSON.stringify(body)}).then(function(r){return r.json()});\n    if(r.error || r.ok===false){\n      out.innerHTML='<span style=\"color:var(--err)\">\u274c INVALID / FAIL</span><div class=\"chat-box\" style=\"margin-top:8px\">'+(r.error||r.message||JSON.stringify(r)).toString().slice(0,700)+'</div>';\n    } else {\n      out.innerHTML='<span style=\"color:var(--ok)\">\u2705 VALID \u00b7 '+(r.latencyMs||'?')+'ms \u00b7 '+(r.model||model||'')+'</span><div class=\"chat-box\" style=\"margin-top:8px\">'+(r.reply||'OK').toString().slice(0,500)+'</div>';\n    }\n  }catch(e){ out.innerHTML='<span style=\"color:var(--err)\">'+e.message+'</span>'; }\n}\n\nasync function probeProviderCredits(prefix, limit){\n  prefix = prefix || 'cbai';\n  limit = limit || 10;\n  try{\n    var r = await fetch('/admin/providers/probe-credits',{method:'POST',headers:hdr(),body:JSON.stringify({prefix:prefix,limit:limit})}).then(function(r){return r.json();});\n    if(r.error){ alert('Probe error: '+r.error); return r; }\n    var ok=r.ok||0, fail=r.failed||0;\n    var spent = (r.results||[]).filter(function(x){return x.ok;}).reduce(function(a,x){return a+Number(x.credit||0);},0);\n    alert('Probe '+prefix+': '+ok+' ok / '+fail+' fail\\nSample spent this probe: '+spent.toFixed(4)+'\\n\\n'+(r.note||''));\n    await refreshAll();\n    return r;\n  }catch(e){ alert('Probe error: '+e.message); }\n}\nasync function testGatewayKey(prefix, keyId){\n  try{\n    var body = { prefix: prefix };\n    if(keyId) body.keyId = keyId;\n    var r = await fetch('/admin/providers/test',{method:'POST',headers:hdr(),body:JSON.stringify(body)}).then(function(r){return r.json();});\n    var ok = !!(r && (r.ok || r.valid));\n    var msg = (ok?'\u2705 VALID':'\u274c INVALID')+' \u00b7 '+(prefix||'?')+(keyId?(' / '+keyId):'');\n    if(r.latencyMs!=null) msg += '\\n'+r.latencyMs+'ms';\n    if(r.credit!=null) msg += '\\ncredit this call: '+Number(r.credit).toFixed(4);\n    if(r.usage && r.usage.credit!=null) msg += '\\nusage.credit: '+Number(r.usage.credit).toFixed(4);\n    if(r.error||r.message) msg += '\\n'+String(r.error||r.message).slice(0,280);\n    else if(r.reply) msg += '\\n'+String(r.reply).slice(0,160);\n    alert(msg);\n  }catch(e){ alert('Test error: '+e.message); }\n}\n\nasync function testProviderByPrefix(prefix){\n  try{\n    var r=await fetch('/admin/providers/test',{method:'POST',headers:hdr(),body:JSON.stringify({prefix:prefix,prompt:'Reply with exactly: OK'})}).then(function(r){return r.json()});\n    if(r.error || r.ok===false) alert('\u274c '+prefix+': '+(r.error||'fail'));\n    else alert('\u2705 '+prefix+' VALID ('+(r.latencyMs||'?')+'ms)\\n'+(r.reply||'').toString().slice(0,120));\n  }catch(e){ alert(e.message); }\n}\nasync function testAllProviders(){\n  var list=(SUM.providers||[]).filter(function(p){return p.enabled!==false});\n  if(!list.length){alert('No providers');return;}\n  var lines=[];\n  for(var i=0;i<list.length;i++){\n    var p=list[i];\n    try{\n      var r=await fetch('/admin/providers/test',{method:'POST',headers:hdr(),body:JSON.stringify({prefix:p.prefix,prompt:'Reply with exactly: OK'})}).then(function(r){return r.json()});\n      lines.push((r.ok!==false && !r.error?'\u2705':'\u274c')+' '+p.prefix+' \u00b7 '+(r.latencyMs||'-')+'ms \u00b7 '+(r.error||r.reply||'').toString().slice(0,80));\n    }catch(e){ lines.push('\u274c '+p.prefix+' \u00b7 '+e.message); }\n  }\n  alert('Test All Providers\\n\\n'+lines.join('\\n'));\n}\n\nfunction renderModels(){\n  var rows = SUM.models.map(function(m){\n    return '<div class=\"model-item\"><div class=\"mid\">'+m.id+'</div><div class=\"meta\">'\n      +'<span class=\"badge '+(m.provider==='grok_build'?'build':'web')+'\">'+m.provider+'</span> '\n      +(m.available?'<span class=\"badge active\">available</span>':'<span class=\"badge disabled\">unavailable</span>')+' '\n      +'<div style=\"margin-top:4px\">'+m.accounts+' akun</div></div></div>';\n  }).join('');\n  var prows = SUM.providers.map(function(p){\n    return '<div class=\"model-item\"><div class=\"mid\">'+p.prefix+' -> '+p.name+'</div><div class=\"meta\">'+p.models.map(function(m){return '\u2022 '+m.id}).join('<br>')+'</div></div>';\n  }).join('');\n  document.getElementById('pageContent').innerHTML =\n    '<div class=\"panel\"><div class=\"panel-head\"><h2>\ud83e\udde9 Models</h2><span class=\"count\">'+SUM.models.length+'</span></div><div class=\"panel-body\"><div class=\"model-grid\">'+rows+'</div></div></div>'\n    +'<div class=\"panel\"><div class=\"panel-head\"><h2>\ud83d\udd17 Gateway Providers</h2></div><div class=\"panel-body\"><div class=\"model-grid\">'+prows+'</div></div></div>';\n}\n\nvar PROXY_SCOPE_FILTER = localStorage.getItem('kigw_proxy_scope') || 'all';\nfunction setProxyScopeFilter(s){ PROXY_SCOPE_FILTER=s||'all'; localStorage.setItem('kigw_proxy_scope', PROXY_SCOPE_FILTER); renderEgress(); }\nfunction renderEgress(){\n  if(!EGRESS){document.getElementById('pageContent').innerHTML='<div style=\"text-align:center;padding:40px;color:var(--mut)\">Loading proxies...</div>';return;}\n  var allE=EGRESS;\n  var scopeF = PROXY_SCOPE_FILTER||'all';\n  var e = (scopeF==='all') ? allE.slice() : allE.filter(function(n){return n.scope===scopeF;});\n  var healthy=e.filter(function(n){return(n.health||0)>=0.9}).length;\n  var total=e.length;\n  var scopeCounts={all:allE.length};\n  allE.forEach(function(n){ var s=n.scope||'other'; scopeCounts[s]=(scopeCounts[s]||0)+1; });\n  var scopeChips = ['all','grok_build','grok_web','grok_console','grok_web_asset'].map(function(s){\n    var lab = s==='all'?'All':s.replace('grok_','');\n    return '<div class=\"pchip '+(scopeF===s?'active':'')+'\" onclick=\"setProxyScopeFilter(\\''+s+'\\')\">'+lab+' <span class=\"n\">'+(scopeCounts[s]||0)+'</span></div>';\n  }).join('');\n  var rows=e.map(function(n){\n    var h=n.health||0;\n    var hCls=h>=0.9?'ok':h>0?'m':'l';\n    var hColor=h>=0.9?'var(--ok)':h>0?'var(--warn)':'var(--err)';\n    return '<tr><td><input type=\"checkbox\" class=\"proxy-check\" value=\"'+n.id+'\"></td>'\n      +'<td style=\"color:var(--mut);font-size:11px\">'+n.id+'</td>'\n      +'<td style=\"font-weight:600\">'+n.name+'</td>'\n      +'<td><span class=\"badge '+(n.scope==='grok_build'?'build':'web')+'\">'+n.scope+'</span></td>'\n      +'<td style=\"font-size:11px;color:var(--mut2)\">'+(n.proxyConfigured?'configured':'none')+'</td>'\n      +'<td><div class=\"qbar\"><div class=\"fill '+hCls+'\" style=\"width:'+Math.round(h*100)+'%\"></div></div><span style=\"font-size:11px;color:'+hColor+'\">'+Math.round(h*100)+'%</span></td>'\n      +'<td style=\"color:'+(n.failureCount>0?'var(--err)':'var(--mut2)')+'\">'+(n.failureCount||0)+'</td>'\n      +'<td><input type=\"checkbox\" '+(n.enabled?'checked':'')+' onchange=\"toggleProxy('+n.id+',this.checked)\"><span style=\"font-size:11px\">'+(n.enabled?'on':'off')+'</span></td></tr>';\n  }).join('')||'<tr><td colspan=\"8\" style=\"text-align:center;color:var(--mut);padding:20px\">No proxies</td></tr>';\n  \n  document.getElementById('pageContent').innerHTML =\n    '<div class=\"chipbar\"><span class=\"clabel\">Scope</span>'+scopeChips+'</div>'\n    +'<div class=\"stats-grid\">'\n    +'<div class=\"stat-card\"><div class=\"ic\">\ud83c\udf10</div><div class=\"label\">Total</div><div class=\"value\">'+total+'</div><div class=\"sub\">'+(scopeF==='all'?'all scopes':scopeF)+'</div></div>'\n    +'<div class=\"stat-card\"><div class=\"ic\">\u2705</div><div class=\"label\">Healthy</div><div class=\"value\">'+healthy+'</div></div>'\n    +'<div class=\"stat-card\"><div class=\"ic\">\u26a0\ufe0f</div><div class=\"label\">Unhealthy</div><div class=\"value\">'+(total-healthy)+'</div></div>'\n    +'</div>'\n    +'<div class=\"panel\"><div class=\"panel-head\"><h2>\u2795 Add Proxies</h2></div><div class=\"panel-body\">'\n    +'<p style=\"color:var(--mut);margin-bottom:10px;font-size:13px\">Format: <code>http://user:pass@host:port</code>, one per line</p>'\n    +'<textarea id=\"proxyInput\" rows=\"6\" placeholder=\"http://user:pass@host:port\" style=\"margin-bottom:10px\"></textarea>'\n    +'<div style=\"display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px\">'\n    +'<label style=\"font-size:12px;color:var(--mut)\">Scope:</label>'\n    +'<select id=\"proxyScope\"><option value=\"all\">ALL scopes (build+web+console+web_asset)</option><option value=\"grok_build\">grok_build</option><option value=\"grok_web\">grok_web</option><option value=\"grok_console\">grok_console</option><option value=\"grok_web_asset\">grok_web_asset</option></select><span style=\"font-size:11px;color:var(--mut2)\">= semua scope egress Grok2API</span>'\n    +'<label style=\"font-size:12px;color:var(--mut)\">Prefix:</label>'\n    +'<input type=\"text\" id=\"proxyNamePrefix\" placeholder=\"proxy\" style=\"min-width:120px\">'\n    +'<button class=\"btn primary\" id=\"addProxyBtn\" onclick=\"addProxies()\">\u2795 Add</button></div>'\n    +'<div id=\"proxyAddResult\"></div></div></div>'\n    +'<div class=\"panel\"><div class=\"panel-head\"><h2>\ud83c\udf10 Active Proxies</h2><span class=\"count\">'+total+'</span>'\n    +'<button class=\"btn sm\" style=\"margin-left:auto\" onclick=\"refreshEgress()\">\u21bb</button>'\n    +'<button class=\"btn sm\" onclick=\"toggleAllProxies()\">All</button>'\n    +'<button class=\"btn sm\" onclick=\"deleteSelectedProxies()\" style=\"color:var(--err)\">\ud83d\uddd1</button></div>'\n    +'<div class=\"panel-body\"><div class=\"table-wrap\" style=\"max-height:420px\"><table><thead><tr>'\n    +'<th style=\"width:30px\"><input type=\"checkbox\" id=\"proxyCheckAll\" onchange=\"toggleProxyCheckAll(this)\"></th>'\n    +'<th>ID</th><th>Name</th><th>Scope</th><th>Proxy</th><th>Health</th><th>Fail</th><th>On</th>'\n    +'</tr></thead><tbody id=\"proxyTableBody\">'+rows+'</tbody></table></div></div></div>';\n}\nasync function refreshEgress(){await loadEgress();renderEgress();}\nasync function addProxies(){\n  var input=document.getElementById('proxyInput').value.trim();if(!input)return;\n  var proxies=input.split('\\n').map(function(s){return s.trim()}).filter(Boolean);\n  var scope=document.getElementById('proxyScope').value;\n  var prefix=document.getElementById('proxyNamePrefix').value.trim()||'proxy';\n  var btn=document.getElementById('addProxyBtn'),out=document.getElementById('proxyAddResult');\n  var scopes = (scope==='all' || scope==='*') ? ['grok_build','grok_web','grok_console','grok_web_asset'] : [scope];\n  btn.disabled=true;\n  out.innerHTML='<p style=\"color:var(--mut)\">Adding '+proxies.length+' proxy \u00d7 '+scopes.length+' scope...</p>';\n  try{\n    var totalAdded=0, totalFailed=0, details=[];\n    for(var si=0; si<scopes.length; si++){\n      var sc=scopes[si];\n      var namePrefix = scopes.length>1 ? (prefix+'-'+sc.replace('grok_','')) : prefix;\n      var r=await fetch('/admin/egress/add',{method:'POST',headers:hdr(),body:JSON.stringify({proxies:proxies,scope:sc,namePrefix:namePrefix})}).then(function(r){return r.json();});\n      totalAdded += (r.added||0);\n      totalFailed += (r.failed||0);\n      details.push(sc+': +'+(r.added||0)+(r.failed?(' / fail '+r.failed):''));\n    }\n    var html='<div style=\"padding:10px;background:var(--bg2);border-radius:8px;font-size:13px\">';\n    html+='<p style=\"color:var(--ok)\">Added: '+totalAdded+' \u00b7 Failed: '+totalFailed+'</p>';\n    html+='<p style=\"color:var(--mut);font-size:12px\">'+details.join(' \u00b7 ')+'</p>';\n    html+='</div>';\n    out.innerHTML=html;\n    document.getElementById('proxyInput').value='';\n    await loadEgress();renderEgress();\n  }catch(e){out.innerHTML='<p style=\"color:var(--err)\">'+e.message+'</p>';}\n  btn.disabled=false;\n}\nfunction toggleProxyCheckAll(cb){document.querySelectorAll('.proxy-check').forEach(function(c){c.checked=cb.checked});}\nfunction toggleAllProxies(){var cba=document.getElementById('proxyCheckAll');cba.checked=!cba.checked;toggleProxyCheckAll(cba);}\nasync function deleteSelectedProxies(){\n  var ids=Array.from(document.querySelectorAll('.proxy-check:checked')).map(function(c){return parseInt(c.value)});\n  if(!ids.length)return;if(!confirm('Delete '+ids.length+' proxies?'))return;\n  await fetch('/admin/egress/delete',{method:'POST',headers:hdr(),body:JSON.stringify({ids:ids})}).then(r=>r.json());\n  await loadEgress();renderEgress();\n}\nasync function toggleProxy(id,enabled){\n  await fetch('/admin/egress/toggle',{method:'POST',headers:hdr(),body:JSON.stringify({id:id,enabled:enabled})});\n}\n\nfunction renderKeys(){\n  var rows=SUM.clientKeys.map(function(k){\n    return '<tr><td style=\"color:var(--mut);font-size:11px\">'+k.id+'</td>'\n      +'<td style=\"font-weight:600\">'+k.name+'</td>'\n      +'<td><span class=\"badge '+(k.enabled?'active':'disabled')+'\">'+(k.enabled?'enabled':'disabled')+'</span></td>'\n      +'<td style=\"color:var(--mut2);font-size:11px\">'+timeAgo(k.lastUsedAt)+'</td></tr>';\n  }).join('');\n  document.getElementById('pageContent').innerHTML =\n    '<div class=\"panel\"><div class=\"panel-head\"><h2>\ud83d\udd11 API Keys</h2><span class=\"count\">'+SUM.clientKeys.length+'</span></div><div class=\"panel-body\"><div class=\"table-wrap\"><table><thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Used</th></tr></thead><tbody>'+rows+'</tbody></table></div></div></div>'\n    +'<div class=\"panel\"><div class=\"panel-head\"><h2>\ud83d\udccb Info</h2></div><div class=\"panel-body\"><div style=\"font-size:13px\">'\n    +'<div>Endpoint: <code>/v1/chat/completions</code></div>'\n    +'<div>Models: <code>/v1/models</code></div>'\n    +'<div>Auth: Bearer kigw_*</div></div></div></div>';\n}\n\nif(KEY){\n  fetch('/admin/summary',{headers:hdr()}).then(function(r){\n    if(r.ok){\n      document.getElementById('loginScreen').classList.add('hidden');\n      document.getElementById('app').classList.remove('hidden');\n      init();\n    }\n  }).catch(function(){});\n}\n</script>\n</body>\n</html>";

loadKeyStats();
loadRequestLog();
server.listen(PORT, HOST, () => {
  console.log('ki-gateway v4.1 listening on http://' + HOST + ':' + PORT);
  console.log('providers: ' + Object.keys(PROVIDERS).join(', '));
  console.log('providers file: ' + PROVIDERS_FILE);
});
