# Deployment Notes - Stoat HTTP Polling Plugin

## What Was Done

The Stoat (Revolt) plugin has been successfully migrated from WebSocket to HTTP polling:

1. **ID Mismatch Resolved** - Manifest now explicitly declares config entry key
2. **WebSocket Removed** - All WebSocket code stripped; no longer a dependency
3. **HTTP Polling Added** - Clean, simple polling implementation with exponential backoff

---

## Next Steps to Activate

### Step 1: Configure Polling Channels

Add polling channels to `/root/.openclaw/openclaw.json` under `channels.stoat`:

```json
{
  "channels": {
    "stoat": {
      "enabled": true,
      "token": "HShLS_9_T9JwvrmLFTS2KwtzJPSaX6HFUtwuYptQS6gLlJDFfax2LRAjq8eYStoi",
      "apiBase": "https://api.revolt.chat",
      "pollChannels": ["CHANNEL_ID_1", "CHANNEL_ID_2"],
      "pollIntervalMs": 4000
    }
  }
}
```

Where:
- `pollChannels` = array of Revolt channel IDs to monitor
- `pollIntervalMs` = polling frequency in milliseconds (default: 4000)

### Step 2: Restart the Gateway

```bash
openclaw gateway restart
```

### Step 3: Monitor Logs

Watch for startup confirmation:

```bash
journalctl -u openclaw-gateway -f | grep stoat
```

Expected output:
```
[stoat] Stoat bot ID: <bot-id>
[stoat] Polling loop started
```

### Step 4: Test

1. Send a message to one of your configured polling channels
2. Check logs for:
   ```
   [stoat] Processed 1 new message(s) in <channel-id>
   ```

---

## Configuration Reference

### Required
- `token` — Revolt bot token (or env var `STOAT_BOT_TOKEN`)
- `pollChannels` — Array of channel IDs to monitor (required for polling to start)

### Optional
- `apiBase` — Revolt API endpoint (default: `https://api.revolt.chat`)
- `pollIntervalMs` — Polling frequency in ms (default: `4000`, min: `1000`)

### Per-Account (if using multiple accounts)

```json
{
  "channels": {
    "stoat": {
      "accounts": {
        "bot-a": {
          "token": "token-a",
          "pollChannels": ["channel-1", "channel-2"]
        },
        "bot-b": {
          "token": "token-b",
          "pollChannels": ["channel-3"]
        }
      }
    }
  }
}
```

---

## How Polling Works

1. **Initialization**
   - Fetches bot self-ID to avoid self-message loops
   - Initializes tracking for each channel

2. **Polling Cycle** (runs every `pollIntervalMs`)
   - Fetches latest 50 messages from each channel
   - Compares against last-seen message ID
   - Processes only new messages

3. **Error Handling**
   - Failed channels enter exponential backoff
   - Backoff: 1s → 2s → 4s → 8s → 16s → 32s → max 60s
   - Resets when channel succeeds again

---

## Troubleshooting

### Plugin doesn't start polling
- Check that `pollChannels` is configured (non-empty array)
- Verify bot token is valid
- Check gateway logs for errors

### Messages not processed
- Confirm channel IDs in `pollChannels` are correct
- Verify bot has access to those channels
- Check for self-message filtering (should skip bot's own messages)
- Increase `pollIntervalMs` if polling is too aggressive

### High CPU/memory usage
- Increase `pollIntervalMs` to poll less frequently
- Reduce number of channels in `pollChannels`
- Check for network/API issues causing hung requests

### Messages are delayed
- Reduce `pollIntervalMs` for faster polling (min ~1000ms recommended)
- Check network latency to Revolt API
- Monitor for exponential backoff being triggered

---

## API Compatibility

- **Revolt API:** Tested with `api.revolt.chat`
- **HTTP Method:** GET /channels/{id}/messages?limit=50&sort=Latest
- **Self-ID:** Fetched from GET /users/@me
- **Outbound:** POST /channels/{id}/messages (unchanged from WebSocket)

---

## Differences from WebSocket

| Feature | WebSocket | HTTP Polling |
|---------|-----------|--------------|
| Real-time | Yes (push) | No (poll-based) |
| Latency | <100ms | 1-5s (configurable) |
| Complexity | High | Low |
| Dependencies | WebSocket lib | None |
| CPU usage | Lower | Higher (if frequent) |
| Network | Persistent | Per-poll requests |
| Configuration | Simple | Channel-based |
| Debugging | Harder | Easier |

**Trade-off:** Slightly higher latency for much simpler, more maintainable code.

---

## Support

For issues, check:
1. Gateway logs: `journalctl -u openclaw-gateway`
2. Plugin manifest: `openclaw.plugin.json`
3. Plugin code: `index.js` (polling functions)
4. Configuration: `/root/.openclaw/openclaw.json` (channels.stoat)
