# 🦎 openclaw-plugin-stoat

> **The first Revolt/Stoat channel plugin for [OpenClaw](https://github.com/openclaw/openclaw)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)

Connect your OpenClaw agent to [Revolt](https://revolt.chat) / [Stoat](https://stoat.chat) servers with full bidirectional messaging, image support, and rock-solid connectivity.

## ✨ Features

- **🔌 WebSocket Primary** — Real-time message delivery via Revolt's WebSocket API
- **🔄 REST Polling Fallback** — Automatic 10s polling when WebSocket disconnects
- **🖼️ Image Support** — Inbound + outbound attachments via Revolt's Autumn file server
- **⌨️ Typing Indicators** — Shows typing status before bot replies
- **💬 DM Support** — Direct messages and saved messages detection
- **🔁 Auto-Reconnect** — Exponential backoff (max 120s) with automatic recovery
- **💓 Ping Keepalive** — Proactive 30s pings to prevent server-side disconnects
- **🤖 Self-Message Filtering** — Bot won't respond to its own messages
- **👥 Multi-Account** — Support for multiple bot accounts

## 📦 Installation

1. Copy the plugin to your OpenClaw extensions directory:

```bash
mkdir -p ~/.openclaw/extensions/stoat
cp index.js package.json ~/.openclaw/extensions/stoat/
```

2. Add to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "channels": {
    "stoat": {
      "enabled": true,
      "token": "YOUR_BOT_TOKEN",
      "wsBase": "wss://events.stoat.chat"
    }
  },
  "plugins": {
    "entries": {
      "stoat": {
        "enabled": true
      }
    }
  }
}
```

3. Restart OpenClaw:

```bash
systemctl --user restart openclaw-gateway
```

## 🔧 Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `channels.stoat.token` | — | Bot token from Revolt/Stoat |
| `channels.stoat.wsBase` | `wss://events.stoat.chat` | WebSocket endpoint |
| `channels.stoat.apiBase` | `https://api.revolt.chat` | REST API endpoint |
| `channels.stoat.autumnBase` | `https://autumn.revolt.chat` | File upload server |
| `channels.stoat.pollChannels` | `[]` | Channel IDs for REST polling fallback |

### Environment Variables

You can also set the token via environment variable:

```bash
export STOAT_BOT_TOKEN="your-bot-token"
```

## 🏗️ Architecture

```
┌─────────────┐     WebSocket      ┌──────────────┐
│  Revolt/     │◄──────────────────►│   OpenClaw    │
│  Stoat       │     (primary)      │   Gateway     │
│  Server      │◄──────────────────►│              │
│              │   REST API          │              │
│              │   (fallback)        │              │
└─────────────┘                    └──────────────┘
       │                                   │
       │  Autumn                           │
       │  (file uploads)                   │
       ▼                                   ▼
┌─────────────┐                    ┌──────────────┐
│  Attachments │                    │  Agent       │
│  (images)    │                    │  Response    │
└─────────────┘                    └──────────────┘
```

**Hybrid Connectivity:**
1. WebSocket connects and authenticates with bot token
2. On disconnect → automatic REST polling every 10s
3. On WebSocket reconnect → polling stops
4. Proactive ping every 30s prevents server-side timeouts

## 🔒 Security

- Bot token is never logged or exposed in status endpoints
- Self-message filtering prevents infinite loops
- Rate limiting (429) handled with automatic backoff
- No message content is logged
- See [SECURITY-AUDIT.md](SECURITY-AUDIT.md) for full audit

## 📝 Creating a Bot

1. Go to your Revolt/Stoat server settings
2. Navigate to **Bots** → **Create Bot**
3. Copy the bot token
4. Invite the bot to your server/channels

## 🤝 Contributing

PRs welcome! This is the first Revolt/Stoat plugin for OpenClaw.

## 📄 License

[MIT](LICENSE) © 2026 robbyczgw-cla
