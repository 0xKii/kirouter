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

Dashboard: **http://localhost:20128**

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
kirouter                    # Start on port 20128
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
curl http://localhost:20128/v1/chat/completions \
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
├── .gateway_key          # Auto-generated API key (chmod 600)
├── providers.json        # Provider configs and API keys
├── kirouter.db           # SQLite request log
└── request-log.json      # Hot cache of recent requests
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `20128` | Gateway port |
| `KI_DATA_DIR` | `~/.kirouter` | Data directory |
| `KI_GATEWAY_VERSION` | `v1.0.0` | Version string |

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
