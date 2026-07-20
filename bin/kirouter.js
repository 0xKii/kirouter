#!/usr/bin/env node

/**
 * KiRouter CLI — Multi-provider LLM Gateway
 * Usage: kirouter [--port PORT] [--update] [--version] [--help]
 */

import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import crypto from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'fs';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_PATH = join(__dirname, '..', 'package.json');
const GATEWAY_PATH = join(__dirname, '..', 'lib', 'gateway.mjs');

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const VERSION = pkg.version;
const PKG_NAME = pkg.name;
const DEFAULT_PORT = 8090;

function parsePort(value, source = 'port') {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) throw new Error(`${source} must be an integer from 1 to 65535`);
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${source} must be an integer from 1 to 65535`);
  return port;
}

// Parse args
const args = process.argv.slice(2);
const flags = {
  port: null,
  update: false,
  version: false,
  help: false,
  noUpdateCheck: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--port' || arg === '-p') {
    if (i + 1 >= args.length) { console.error('Missing value for --port'); process.exit(2); }
    try { flags.port = parsePort(args[++i], '--port'); } catch (e) { console.error(e.message); process.exit(2); }
  } else if (arg === '--update' || arg === '-u') {
    flags.update = true;
  } else if (arg === '--version' || arg === '-v') {
    flags.version = true;
  } else if (arg === '--help' || arg === '-h') {
    flags.help = true;
  } else if (arg === '--no-update-check') {
    flags.noUpdateCheck = true;
  } else if (arg.startsWith('--port=')) {
    try { flags.port = parsePort(arg.slice('--port='.length), '--port'); } catch (e) { console.error(e.message); process.exit(2); }
  }
}

if (flags.port == null) {
  const envPort = process.env.KIGW_PORT || process.env.PORT;
  try { flags.port = envPort ? parsePort(envPort, process.env.KIGW_PORT ? 'KIGW_PORT' : 'PORT') : DEFAULT_PORT; }
  catch (e) { console.error(e.message); process.exit(2); }
}

// Colors
const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function log(msg, color = '') {
  console.log(color + msg + c.reset);
}

function banner() {
  console.log('');
  log('  ╔═══════════════════════════════════════╗', c.green);
  log('  ║           🚀 KiRouter v' + VERSION.padEnd(8) + '        ║', c.green);
  log('  ║   Multi-provider LLM Gateway         ║', c.green);
  log('  ╚═══════════════════════════════════════╝', c.reset);
  console.log('');
}

function help() {
  banner();
  console.log('Usage: kirouter [options]\n');
  console.log('Options:');
  console.log('  -p, --port <port>     Port to run on (default: 8090)');
  console.log('  -u, --update          Check for updates and exit');
  console.log('  -v, --version         Show version');
  console.log('  -h, --help            Show this help');
  console.log('  --no-update-check     Skip update check on startup');
  console.log('');
  console.log('Examples:');
  console.log('  kirouter                    # Start on port 8090');
  console.log('  kirouter --port 3000        # Start on port 3000');
  console.log('  kirouter --update           # Check for updates');
  console.log('');
  console.log('Dashboard: http://localhost:' + flags.port);
  console.log('API:       http://localhost:' + flags.port + '/v1');
  console.log('');
}

function checkForUpdates() {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'registry.npmjs.org',
      path: `/${PKG_NAME.replace('/', '%2f')}/latest`,
      timeout: 5000,
      headers: { 'Accept': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const latest = JSON.parse(data).version;
          resolve({ current: VERSION, latest, hasUpdate: latest !== VERSION });
        } catch {
          resolve({ current: VERSION, latest: VERSION, hasUpdate: false });
        }
      });
    });
    req.on('error', () => resolve({ current: VERSION, latest: VERSION, hasUpdate: false }));
    req.on('timeout', () => { req.destroy(); resolve({ current: VERSION, latest: VERSION, hasUpdate: false }); });
  });
}

async function showUpdateNotification() {
  const update = await checkForUpdates();
  if (update.hasUpdate) {
    console.log('');
    log('  ╭──────────────────────────────────────╮', c.yellow);
    log('  │  🎉 Update available!                │', c.yellow);
    log(`  │  v${update.current} → v${update.latest}                    │`, c.bright);
    log('  │                                      │', c.yellow);
    log('  │  Run: npm i -g @0xki/kirouter@latest       │', c.cyan);
    log('  ╰──────────────────────────────────────╯', c.yellow);
    console.log('');
    return true;
  }
  return false;
}

async function doUpdate() {
  log('Checking for updates...', c.dim);
  const update = await checkForUpdates();

  if (!update.hasUpdate) {
    log(`✓ You're on the latest version (v${VERSION})`, c.green);
    return;
  }

  log(`Update available: v${update.current} → v${update.latest}`, c.yellow);
  log('Installing update...', c.dim);

  try {
    execSync(`npm install -g ${PKG_NAME}@latest`, { stdio: 'inherit' });
    log(`✓ Updated to v${update.latest}`, c.green);
    log('Please restart kirouter to use the new version.', c.dim);
  } catch (e) {
    log('✗ Update failed. Try manually:', c.red);
    log(`  npm i -g ${PKG_NAME}@latest --prefer-online`, c.cyan);
    process.exit(1);
  }
}

async function startGateway() {
  banner();

  // Check for updates (async, don't block)
  if (!flags.noUpdateCheck) {
    showUpdateNotification().then(hasUpdate => {
      if (hasUpdate) {
        log('Starting gateway... (update available, see above)', c.dim);
      }
    }).catch(() => {});
  }

  log(`Dashboard:  http://localhost:${flags.port}`, c.cyan);
  log(`API:        http://localhost:${flags.port}/v1`, c.cyan);
  log(`Health:     http://localhost:${flags.port}/health`, c.cyan);
  console.log('');
  log('Press Ctrl+C to stop', c.dim);
  console.log('');

  // Keep mutable state outside the installed package. KIGW_* is canonical;
  // PORT/KI_DATA_DIR remain compatibility aliases for older deployments.
  const dataDir = process.env.KIGW_DATA_DIR || process.env.KI_DATA_DIR || join(homedir(), '.kirouter');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = join(dataDir, '.gateway_key');
  if (!process.env.KIGW_GATEWAY_KEY) {
    try {
      const fd = openSync(keyPath, 'wx', 0o600);
      try { writeFileSync(fd, crypto.randomBytes(32).toString('base64url') + '\n'); }
      finally { closeSync(fd); }
      log(`Generated gateway key: ${keyPath}`, c.green);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  const port = flags.port.toString();
  const env = {
    ...process.env,
    PORT: port,
    KIGW_PORT: port,
    KIGW_DATA_DIR: dataDir,
    KI_GATEWAY_VERSION: `v${VERSION}`,
  };
  const child = spawn(process.execPath, [GATEWAY_PATH], { env, stdio: 'inherit' });

  child.on('error', (err) => {
    log(`Failed to start: ${err.message}`, c.red);
    process.exit(1);
  });

  let forwardingSignal = false;
  child.on('exit', (code, signal) => {
    if (!forwardingSignal && (code || signal)) log(`Gateway exited (${signal || `code ${code}`})`, c.red);
    process.exitCode = code ?? (signal ? 1 : 0);
  });

  const forwardSignal = (signal) => {
    if (forwardingSignal) return;
    forwardingSignal = true;
    console.log('');
    log('Shutting down...', c.dim);
    if (child.exitCode == null && child.signalCode == null) child.kill(signal);
    const killer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }, 5000);
    killer.unref?.();
  };
  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));
}

// Main
if (flags.help) {
  help();
} else if (flags.version) {
  console.log(VERSION);
} else if (flags.update) {
  doUpdate();
} else {
  startGateway();
}
