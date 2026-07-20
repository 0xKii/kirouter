# KiRouter

Multi-provider LLM gateway with unified OpenAI-compatible API, key rotation, real-time dashboard, and budget tracking.

[![npm version](https://img.shields.io/npm/v/@0xki/kirouter)](https://www.npmjs.com/package/@0xki/kirouter)
[![license](https://img.shields.io/npm/l/@0xki/kirouter)](LICENSE)
[![node](https://img.shields.io/node/v/@0xki/kirouter)](https://nodejs.org)

## Quick Start

```bash
npm install -g @0xki/kirouter
kirouter
```

Dashboard: **http://localhost:8090**

## Features

- **Unified API** — OpenAI-compatible `/v1/chat/completions` for all providers
- **Key rotation** — automatic failover across multiple API keys
- **22 providers** — OpenAI, Anthropic, Grok, Gemini, DeepSeek, and more
- **Real-time dashboard** — stats, sparklines, trends, and health monitoring
- **Budget tracking** — per-provider spend limits and usage analytics
- **SQLite persistence** — request history, audit logs, and backups
- **Auto-update** — checks npm registry on startup, one-command upgrade

## CLI Options

```bash
kirouter                    # Start on port 8090
kirouter --port 3000        # Start on custom port
kirouter --update           # Check for updates and install
kirouter --version          # Show version
kirouter --help             # Show help
```

## Update

```bash
npm i -g @0xki/kirouter@latest --prefer-online
```

## API Example

```bash
curl http://localhost:8090/v1/chat/completions \
  -H "Authorization: Bearer $(cat ~/.kirouter/.gateway_key)" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Model format: `{provider}/{model_id}` — e.g., `openai/gpt-4o`, `anthropic/claude-opus-4-6`, `grok/grok-chat-fast`

## Configuration

Data is stored in `~/.kirouter/` (auto-created):

```
~/.kirouter/
├── .gateway_key            # Auto-generated API/admin key (chmod 600)
├── providers.json          # Provider configs and API keys
├── provider-key-stats.json # Provider-key usage and budget state
└── ki-gateway.db           # SQLite request and audit logs
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `KIGW_PORT` | `8090` | Gateway port (`--port` sets this) |
| `KIGW_DATA_DIR` | `~/.kirouter` | Mutable state directory |
| `PORT` | — | Legacy port alias; `KIGW_PORT` wins |
| `KIGW_HOST` | `127.0.0.1` | Listen address |
| `KI_DATA_DIR` | — | Legacy data-directory alias |
| `KI_GATEWAY_VERSION` | package version | Version string |
| `KIGW_SESSION_TTL_MS` | `86400000` | Admin-session lifetime in milliseconds |
| `KIGW_MAX_ADMIN_SESSIONS` | `100` | Maximum concurrent in-memory admin sessions (oldest idle session is evicted) |
| `KIGW_TRUST_PROXY` | `0` | Trust sanitized `X-Forwarded-Host`/`X-Forwarded-Proto` from a controlled reverse proxy |
| `KIGW_FORCE_SECURE_COOKIES` | `0` | Force Secure admin cookies behind a trusted HTTPS proxy |
| `KIGW_ALLOW_SESSION_NO_ORIGIN` | `0` | Allow session mint/write without Origin only for controlled local tools/tests |
| `KIGW_CHAT_BODY_LIMIT` | `2097152` | Maximum `/v1/chat/completions` JSON body (2 MiB) |
| `KIGW_ADMIN_BODY_LIMIT` | `1048576` | Maximum normal admin JSON body (1 MiB) |
| `KIGW_RESTORE_BODY_LIMIT` | `8388608` | Maximum restore JSON body (8 MiB) |
| `KIGW_ALLOW_PRIVATE_NETWORKS` | `0` | Explicitly allow custom private/loopback upstreams and proxies; keep disabled unless trusted |

## Admin Security

The browser exchanges the gateway master key for an opaque, server-side admin session. The master key is not persisted in `localStorage`, cookies, or SSE URLs. Mutating dashboard requests require both a CSRF token and a matching same-origin `Origin`/`Referer`; logout revokes the server session.

Configuration backups use schema version 2 and redact provider keys, credential-bearing proxy URLs, and error details. Plaintext secret export is unsupported. Restore validates the full document and reuses redacted keys that already exist on the same instance; it does not migrate secrets to a fresh host. Provider configuration and key statistics are staged together; an on-disk restore journal completes an interrupted two-file replacement on the next startup.

KiRouter defaults to port **8090**. Port **20128 is reserved for 9router** in Ki’s stack and is not used as the KiRouter default.

Custom provider and proxy URLs are restricted to public HTTP(S) destinations by default to reduce SSRF risk. Private, loopback, link-local, metadata, multicast, and reserved destinations require the explicit `KIGW_ALLOW_PRIVATE_NETWORKS=1` opt-in. DNS is checked and pinned for direct requests, redirects are revalidated, and proxied redirects are rejected. The default local grok2api upstream therefore also requires this opt-in.

When an upstream is reached through a remote HTTP(S) proxy, KiRouter validates both the configured upstream and proxy endpoint before dispatch, but the remote proxy ultimately resolves the CONNECT destination itself. End-to-end DNS pinning therefore applies only to direct requests. Use only trusted remote proxies with their own private-network/metadata egress controls.

## Development

```bash
git clone https://github.com/0xKii/kirouter.git
cd kirouter
npm install
npm install -g .
kirouter
```

## License

MIT © 2026 0xki
