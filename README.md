# KiRouter

Multi-provider LLM gateway with unified API, dashboard, and automatic key rotation.

## Quick Start

### 1. Install globally

```shell
npm install -g @0xki/kirouter
```

### 2. Start KiRouter

```shell
kirouter
```

Dashboard opens at `http://localhost:20128`

### 3. Configure providers

Open `http://localhost:20128` in your browser, go to **Providers**, and add your API keys.

## Features

- **Unified API** — OpenAI-compatible endpoint for all providers
- **Multi-provider** — Grok, CodeBuddy, Anthropic, OpenAI, and 20+ more
- **Key rotation** — Automatic failover across multiple API keys
- **Dashboard** — Real-time stats, quota tracking, request logs
- **Budget tracking** — Monitor spend per provider/key
- **Auto-update** — Get notified when new versions are available

## CLI Options

```shell
kirouter --port 3000        # Custom port
kirouter --update           # Check for updates
kirouter --version          # Show version
kirouter --help             # Show help
```

## Updating

KiRouter checks for updates on startup. To update manually:

```shell
npm i -g @0xki/kirouter@latest --prefer-online
```

Or use the built-in command:

```shell
kirouter --update
```

## API Usage

KiRouter exposes an OpenAI-compatible API at `http://localhost:20128/v1`.

```shell
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok/grok-4.5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Model naming

Models are prefixed by provider: `provider/model-name`

Examples:
- `grok/grok-4.5`
- `cbai/claude-opus-4.7-1m`
- `anthropic/claude-sonnet-4`
- `openai/gpt-4o`

## Configuration

Config is stored in `~/.kirouter/` (created on first run):

- `providers.json` — Provider configurations
- `keys.json` — API keys (encrypted at rest)
- `budget.json` — Budget limits
- `stats.json` — Usage statistics

## License

MIT
