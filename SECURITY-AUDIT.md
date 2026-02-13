# Security Audit — openclaw-plugin-stoat v1.0.0

**Date:** 2026-02-13
**Auditor:** Cami (AI-assisted)

## Summary

| Category | Severity | Status |
|----------|----------|--------|
| Hardcoded Secrets | Critical | ✅ PASS — none found |
| Token Handling | High | ✅ PASS — token from config/env only |
| Self-Message Loop | High | ✅ PASS — bot ID filtering active |
| Input Validation | Medium | ✅ PASS — IDs sanitized via encodeURIComponent |
| Rate Limiting | Medium | ✅ PASS — 429 handled with backoff |
| Error Messages | Low | ✅ PASS — truncated to 500 chars |
| Privacy | Low | ✅ PASS — no message content logged |
| Dependencies | Info | ✅ PASS — only openclaw/plugin-sdk + node:fs |
| Attachment Handling | Medium | ✅ PASS — no arbitrary file reads |

## Detailed Findings

### ✅ No Hardcoded Secrets
- Bot token loaded from `channels.stoat.token` config or `STOAT_BOT_TOKEN` env var
- No hardcoded channel IDs, user IDs, or server URLs
- Default URLs (api.revolt.chat, events.stoat.chat, autumn.revolt.chat) are public endpoints

### ✅ Token Handling
- Token passed via `x-bot-token` header (Revolt standard)
- Token not included in log messages or status output
- Token source tracked for debugging (`tokenSource` field shows config path, not value)

### ✅ Self-Message Filtering
- Bot fetches own user ID via `/users/@me` on startup
- All inbound messages checked against bot ID before dispatch
- Prevents infinite response loops

### ✅ Rate Limiting
- HTTP 429 responses handled with `retry_after` from response body/headers
- Polling backs off automatically on rate limit
- Minimum 1 second, configurable via server response

### ✅ Input Validation
- Channel IDs passed through `encodeURIComponent()` in URL construction
- Message text validated as string before processing
- Empty messages (no text + no media) are filtered out

### ✅ Error Message Safety
- API error responses truncated to 500 characters
- No token or auth data included in error messages
- Errors logged at warn level, not exposed to users

### ✅ Privacy
- No message content logged (only message IDs at debug level)
- Attachment metadata logged (filename, size) but not content
- User IDs used for routing only

### ✅ Attachment Security
- Outbound attachments: only from URLs (downloaded) or reply buffers
- `readFile` only used for `replyPayload.filePath` (OpenClaw-controlled)
- No user-controlled file paths accepted
- Autumn upload uses FormData with proper content-type

## Recommendations

1. **Consider** adding message size limits for outbound text (currently relies on `textChunkLimit: 1900`)
2. **Consider** validating attachment content-type before upload
3. **Monitor** WebSocket reconnection patterns for potential abuse

## Conclusion

The plugin is **safe for publication**. No critical or high-severity issues found.
