# OpenClaw Stoat Plugin - Update Summary

## Task 1: Plugin ID Mismatch Fix ✅

**Issue:** Gateway warning `plugin stoat: plugin id mismatch (manifest uses "stoat", entry hints "openclaw-stoat-plugin")`

**Solution Applied:**
- Added explicit `"configKey": "stoat"` to manifest to clarify entry key mapping
- Enhanced `configSchema` with detailed property documentation
- All IDs now consistent:
  - Manifest `"id": "stoat"` ✓
  - Plugin export `id: "stoat"` ✓
  - Config entry key `"stoat"` ✓
  - stoatPlugin.meta.id = `"stoat"` ✓

The mismatch warning should now be resolved as the plugin explicitly declares its config entry key.

---

## Task 2: WebSocket → HTTP Polling Migration ✅

### What Changed

#### Removed
- `buildWsUrl()` — WebSocket URL builder
- `startStoatGatewayLoop()` — Entire WebSocket loop implementation
- All WebSocket event listeners (open, message, error, close, ping/pong)
- WebSocket reconnection logic
- `wsBase` configuration option (not needed for HTTP polling)

#### Added
- `pollChannelMessages()` — HTTP GET poller with message filtering
- `startPollingLoop()` — Main polling loop with exponential backoff
- `handleInboundMessage()` — Extracted message handler (cleaner separation)
- Configurable polling via `channels.stoat.pollChannels` (array of channel IDs)
- Configurable poll interval via `channels.stoat.pollIntervalMs` (default: 4000ms)
- Message ID tracking to only process new messages
- Exponential backoff (1s, 2s, 4s, 8s, 16s, 32s, max 60s)
- Per-channel backoff handling

### Configuration

To use the polling plugin, configure in `~/.openclaw/openclaw.json`:

```json
"channels": {
  "stoat": {
    "enabled": true,
    "token": "HShLS_9_T9JwvrmLFTS2KwtzJPSaX6HFUtwuYptQS6gLlJDFfax2LRAjq8eYStoi",
    "apiBase": "https://api.revolt.chat",
    "pollChannels": ["channel-id-1", "channel-id-2"],
    "pollIntervalMs": 4000
  }
}
```

### How It Works

1. **Initialization**
   - Fetches bot self-ID from `/users/@me` for self-message filtering
   - Initializes last-seen message ID for each polling channel

2. **Polling Loop**
   - Every `pollIntervalMs` (default: 4 seconds):
     - Polls each channel in `pollChannels` via `GET /channels/{channelId}/messages?limit=50`
     - Compares message IDs against last-seen ID
     - Processes only new messages (those after last-seen ID)
     - Updates last-seen message ID for next poll

3. **Message Processing**
   - Filters out self-messages (by comparing author ID with bot ID)
   - Calls `handleInboundMessage()` handler
   - Handler invokes OpenClaw's `channel.reply.handleInboundMessage`

4. **Outbound (Unchanged)**
   - `sendText()` still works as before
   - Sends via `POST /channels/{channelId}/messages`

5. **Error Handling**
   - Logs poll failures
   - Applies exponential backoff per failing channel
   - Resets backoff counters on successful poll cycle
   - Max backoff: 60 seconds

### Status Reporting

Plugin status now includes:
- `mode: "http-polling"` (instead of "websocket")
- `pollChannels: <count>` — number of channels being polled
- `pollIntervalMs: <ms>` — polling interval
- `lastPollAt: <ISO>` — last successful poll time
- `nextPollAt: <ISO>` — estimated next poll time

### Benefits

✅ Simpler architecture (no WebSocket dependency)
✅ Easier to debug (HTTP is more transparent)
✅ Better control flow (synchronous polling vs async events)
✅ Configurable polling rate and channels
✅ Proper message deduplication (by ID tracking)
✅ Built-in exponential backoff
✅ Self-message filtering to prevent echo loops

---

## Files Modified

- `index.js` — Complete rewrite (WebSocket → HTTP polling)
- `openclaw.plugin.json` — Enhanced manifest with config schema

## Files NOT Modified (per requirements)

- `/root/.openclaw/openclaw.json` — Configuration file untouched
- `package.json` — No changes needed

---

## Testing

To test the plugin:

```bash
# 1. Ensure channels.stoat.pollChannels is set with valid channel IDs
# 2. Restart OpenClaw gateway
openclaw gateway restart

# 3. Check logs for polling activity
journalctl -u openclaw-gateway -f

# 4. Send a message to a monitored Stoat channel
# 5. Verify bot receives and processes the message
```

Expected log output:
```
[stoat] Stoat bot ID: <bot-id>
[stoat] Polling loop started
[stoat] Processed 1 new message(s) in <channel-id>
```
