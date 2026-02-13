import {
  DEFAULT_ACCOUNT_ID,
  emptyPluginConfigSchema,
  createReplyPrefixContext,
  createReplyPrefixOptions,
} from "openclaw/plugin-sdk";

import { readFile } from "node:fs/promises";

const activeClients = new Map();
let runtimeRef = null;

function nowIso() {
  return new Date().toISOString();
}

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function resolveWsUrl(wsBase) {
  const base = trimTrailingSlash(wsBase || "wss://events.stoat.chat");
  if (/\?/.test(base)) {
    return base;
  }
  return `${base}/?format=json`;
}

function accountFromConfig(cfg, accountId = DEFAULT_ACCOUNT_ID) {
  const channelCfg = cfg?.channels?.stoat ?? {};
  const accountCfg = channelCfg.accounts?.[accountId] ?? {};

  const tokenEnvVar = accountCfg.tokenEnvVar ?? channelCfg.tokenEnvVar ?? "STOAT_BOT_TOKEN";
  const envToken = process.env[tokenEnvVar]?.trim();
  const token = (accountCfg.token ?? channelCfg.token ?? envToken ?? "").trim();

  return {
    accountId,
    name: accountCfg.name ?? (accountId === DEFAULT_ACCOUNT_ID ? "default" : accountId),
    enabled: accountCfg.enabled ?? channelCfg.enabled ?? true,
    token,
    tokenSource: accountCfg.token
      ? `channels.stoat.accounts.${accountId}.token`
      : channelCfg.token
        ? "channels.stoat.token"
        : envToken
          ? `env:${tokenEnvVar}`
          : "none",
    apiBase: trimTrailingSlash(accountCfg.apiBase ?? channelCfg.apiBase ?? "https://api.revolt.chat"),
    wsBase: trimTrailingSlash(accountCfg.wsBase ?? channelCfg.wsBase ?? "wss://events.stoat.chat"),
    autumnBase: trimTrailingSlash(accountCfg.autumnBase ?? channelCfg.autumnBase ?? "https://autumn.revolt.chat"),
    config: accountCfg,
  };
}

function listAccountIds(cfg) {
  const ids = Object.keys(cfg?.channels?.stoat?.accounts ?? {});
  return ids.length ? ids : [DEFAULT_ACCOUNT_ID];
}

async function stoatApiRequest({ apiBase, token, method = "GET", path, body }) {
  const headers = {
    "content-type": "application/json",
    "x-bot-token": token,
    "x-session-token": token,
  };

  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Stoat API ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }

  if (res.status === 204) return null;
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  return res.json();
}

async function sendStoatMessage({ token, apiBase, channelId, text, attachments }) {
  return stoatApiRequest({
    apiBase,
    token,
    method: "POST",
    path: `/channels/${encodeURIComponent(channelId)}/messages`,
    body: {
      ...(typeof text === "string" ? { content: text } : {}),
      ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
    },
  });
}

function getAttachmentId(attachment) {
  return attachment?._id || attachment?.id || null;
}

function normalizeAttachments(rawAttachments, autumnBase) {
  if (!Array.isArray(rawAttachments)) return [];
  const base = trimTrailingSlash(autumnBase || "https://autumn.revolt.chat");
  return rawAttachments
    .map((attachment) => {
      const id = getAttachmentId(attachment);
      if (!id) return null;
      const url = `${base}/attachments/${encodeURIComponent(String(id))}`;
      return {
        id: String(id),
        url,
        filename: attachment?.filename || null,
        contentType: attachment?.content_type || attachment?.contentType || null,
        size: attachment?.size ?? null,
      };
    })
    .filter(Boolean);
}

async function uploadAutumnAttachment({ autumnBase, token, bytes, filename, contentType }) {
  const base = trimTrailingSlash(autumnBase || "https://autumn.revolt.chat");
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: contentType || "application/octet-stream" }),
    filename || "attachment",
  );

  const res = await fetch(`${base}/attachments`, {
    method: "POST",
    headers: {
      "x-bot-token": token,
      "x-session-token": token,
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Autumn upload failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const payload = await res.json().catch(() => null);
  const id = payload?.id || payload?._id || null;
  if (!id) throw new Error("Autumn upload response missing attachment id");
  return String(id);
}

async function downloadMedia(mediaUrl) {
  const res = await fetch(mediaUrl);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`media download failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const contentDisposition = res.headers.get("content-disposition") || "";
  const cdNameMatch = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(contentDisposition);
  const filename = cdNameMatch?.[1] ? decodeURIComponent(cdNameMatch[1].replace(/"/g, "")) : null;
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType, filename };
}

function decodeReplyBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value !== "string") return null;

  const dataUrl = /^data:([^;]+);base64,(.+)$/i.exec(value.trim());
  if (dataUrl) {
    return {
      bytes: Buffer.from(dataUrl[2], "base64"),
      contentType: dataUrl[1],
    };
  }

  return { bytes: Buffer.from(value, "base64") };
}

async function sendTypingIndicator({ token, apiBase, channelId }) {
  await fetch(`${apiBase}/channels/${encodeURIComponent(channelId)}/typing`, {
    method: "PUT",
    headers: {
      "x-bot-token": token,
    },
  });
}

async function fetchSelfUserId(account) {
  const me = await stoatApiRequest({
    apiBase: account.apiBase,
    token: account.token,
    method: "GET",
    path: "/users/@me",
  });
  return me?._id || me?.id || null;
}

function normalizeInboundMessage(rawEvent, account) {
  if (!rawEvent || typeof rawEvent !== "object") return null;

  const message = rawEvent;
  const author = message.author;
  const authorId =
    (author && typeof author === "object" ? author._id || author.id : null) ||
    message.author_id ||
    message.author;

  const chatId = message.channel || message.channel_id;
  const messageId = message._id || message.id;
  const text = typeof message.content === "string" ? message.content : "";
  const media = normalizeAttachments(message.attachments, account?.autumnBase);

  if (!authorId || !chatId || (!text.trim() && !media.length)) return null;

  return {
    senderId: String(authorId),
    chatId: String(chatId),
    messageId: messageId ? String(messageId) : `stoat-${Date.now()}`,
    text,
    media,
    raw: message,
  };
}

function resolveReplyPrefixOptions({ cfg, agentId, channel, accountId }) {
  if (typeof createReplyPrefixOptions === "function") {
    return createReplyPrefixOptions({ cfg, agentId, channel, accountId });
  }
  if (typeof createReplyPrefixContext === "function") {
    const { responsePrefix, responsePrefixContextProvider, onModelSelected } =
      createReplyPrefixContext({ cfg, agentId, channel, accountId });
    return { responsePrefix, responsePrefixContextProvider, onModelSelected };
  }
  return {};
}

async function dispatchInbound(ctx, account, payload, selfId, options = {}) {
  const inbound = normalizeInboundMessage(payload, account);
  if (!inbound) return;

  if (selfId && inbound.senderId === selfId) {
    ctx.log?.debug?.(`[${account.accountId}] skipping self message ${inbound.messageId}`);
    return;
  }

  const core = runtimeRef;
  if (!core?.channel?.reply?.dispatchReplyFromConfig) {
    ctx.log?.warn?.(`[${account.accountId}] runtime channel reply API unavailable; inbound skipped`);
    return;
  }

  const logger = core.logging?.getChildLogger?.({ module: "stoat" });
  const cfg = core.config.loadConfig();

  const raw = inbound.raw ?? {};
  const rawType = String(raw.channel_type ?? raw.channelType ?? raw.type ?? "").toLowerCase();
  const channelTypeHint = String(options.channelType ?? "").toLowerCase();
  const isDirect =
    rawType.includes("direct") ||
    rawType.includes("dm") ||
    rawType.includes("saved") ||
    channelTypeHint.includes("direct") ||
    channelTypeHint.includes("saved") ||
    raw.dm === true ||
    raw.is_dm === true;

  const peerKind = isDirect ? "direct" : "channel";
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "stoat",
    accountId: account.accountId,
    peer: {
      kind: peerKind,
      id: isDirect ? inbound.senderId : inbound.chatId,
    },
  });

  const from = isDirect ? `stoat:${inbound.senderId}` : `stoat:channel:${inbound.chatId}`;
  const to = `stoat:${account.accountId}`;
  const bodyText = inbound.text.trim();
  const mediaLines = (inbound.media ?? []).map((m) => `[Image: ${m.url}]`);
  const body = [bodyText, ...mediaLines].filter(Boolean).join("\n");

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    From: from,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDirect ? "direct" : "channel",
    ConversationLabel: from,
    SenderId: inbound.senderId,
    Provider: "stoat",
    Surface: "stoat",
    MessageSid: inbound.messageId,
    OriginatingChannel: "stoat",
    OriginatingTo: inbound.chatId,
    ...(inbound.media?.length ? {
      MediaUrl: inbound.media[0].url,
      MediaPath: inbound.media[0].url,
      MediaType: inbound.media[0].contentType || "image/jpeg",
      ...(inbound.media.length > 1 ? {
        MediaUrls: inbound.media.map(m => m.url),
        MediaPaths: inbound.media.map(m => m.url),
        MediaTypes: inbound.media.map(m => m.contentType || "image/jpeg"),
      } : {}),
    } : {}),
  });

  const { onModelSelected, ...replyOptionsBase } = resolveReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "stoat",
    accountId: account.accountId,
  });

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...replyOptionsBase,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (replyPayload) => {
        const text = String(replyPayload?.text ?? "").trim();
        const attachmentIds = [];

        const uploadItem = async ({ bytes, filename, contentType }) => {
          try {
            const id = await uploadAutumnAttachment({
              autumnBase: account.autumnBase,
              token: account.token,
              bytes,
              filename,
              contentType,
            });
            attachmentIds.push(id);
          } catch (err) {
            logger?.warn?.(`stoat media upload failed for ${inbound.chatId}: ${String(err)}`);
          }
        };

        const media = replyPayload?.media;
        const mediaList = Array.isArray(media) ? media : media ? [media] : [];
        for (const item of mediaList) {
          if (typeof item !== "string" || !item.trim()) continue;
          try {
            if (/^https?:\/\//i.test(item)) {
              const downloaded = await downloadMedia(item);
              await uploadItem(downloaded);
            } else if (/^data:/i.test(item)) {
              const decoded = decodeReplyBuffer(item);
              if (decoded?.bytes) await uploadItem({
                bytes: decoded.bytes,
                contentType: decoded.contentType,
                filename: "attachment",
              });
            }
          } catch (err) {
            logger?.warn?.(`stoat media fetch failed for ${inbound.chatId}: ${String(err)}`);
          }
        }

        if (replyPayload?.filePath) {
          try {
            const bytes = await readFile(replyPayload.filePath);
            const filename = String(replyPayload.filePath).split("/").pop() || "attachment";
            await uploadItem({ bytes, filename });
          } catch (err) {
            logger?.warn?.(`stoat filePath upload failed for ${inbound.chatId}: ${String(err)}`);
          }
        }

        if (replyPayload?.buffer) {
          try {
            const decoded = decodeReplyBuffer(replyPayload.buffer);
            const bytes = Buffer.isBuffer(decoded) ? decoded : decoded?.bytes;
            if (bytes) {
              await uploadItem({
                bytes,
                contentType: decoded?.contentType || replyPayload?.mimeType || replyPayload?.contentType,
                filename: replyPayload?.filename || "attachment",
              });
            }
          } catch (err) {
            logger?.warn?.(`stoat buffer upload failed for ${inbound.chatId}: ${String(err)}`);
          }
        }

        if (!text && !attachmentIds.length) return;

        await sendStoatMessage({
          token: account.token,
          apiBase: account.apiBase,
          channelId: inbound.chatId,
          text,
          attachments: attachmentIds,
        });
      },
      onError: (err, info) => {
        logger?.warn?.(
          `stoat ${info?.kind ?? "reply"} failed for ${inbound.chatId}: ${String(err)}`,
        );
      },
    });

  try {
    try {
      await sendTypingIndicator({
        token: account.token,
        apiBase: account.apiBase,
        channelId: inbound.chatId,
      });
    } catch (err) {
      logger?.debug?.(`stoat typing indicator failed for ${inbound.chatId}: ${String(err)}`);
    }

    await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        ...replyOptionsBase,
        onModelSelected,
      },
    });
  } finally {
    markDispatchIdle?.();
  }
}

function createWsClient(ctx, account, selfId) {
  const state = {
    stopped: false,
    socket: null,
    reconnectTimer: null,
    pingTimer: null,
    backoffAttempt: 0,
    connectedAt: null,
    lastEventAt: null,
    lastError: null,
    polling: false,
    pollTimer: null,
    pollBackoffUntil: 0,
    lastSeenMessageId: null,
    channelTypeById: new Map(),
  };

  const wsUrl = resolveWsUrl(account.wsBase);

  const clearReconnect = () => {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  };

  const clearPing = () => {
    if (state.pingTimer) {
      clearInterval(state.pingTimer);
      state.pingTimer = null;
    }
  };

  const clearPoll = () => {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    state.polling = false;
    state.pollBackoffUntil = 0;
  };

  const resolvePollChannels = () => {
    const cfg = runtimeRef?.config?.loadConfig?.() ?? {};
    const configured = cfg?.channels?.stoat?.pollChannels;
    if (Array.isArray(configured) && configured.length) {
      return configured.map((v) => String(v).trim()).filter(Boolean);
    }
    return [];
  };

  const extractAuthorId = (msg) => {
    if (!msg || typeof msg !== "object") return null;
    const author = msg.author;
    if (author && typeof author === "object") return author._id || author.id || null;
    return msg.author_id || author || null;
  };

  const cacheChannelTypes = (channels) => {
    if (!Array.isArray(channels)) return;
    for (const ch of channels) {
      if (!ch || typeof ch !== "object") continue;
      const id = ch._id || ch.id;
      const type = ch.channel_type || ch.channelType || ch.type;
      if (!id || !type) continue;
      state.channelTypeById.set(String(id), String(type));
    }
  };

  const startPing = () => {
    clearPing();
    state.pingTimer = setInterval(() => {
      if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
      ctx.log?.debug?.(`[${account.accountId}] sending proactive websocket Ping`);
      state.socket.send(JSON.stringify({ type: "Ping", data: 0 }));
    }, 30000);
  };

  const startPollFallback = () => {
    if (state.stopped || state.polling) return;

    const tick = async () => {
      if (state.stopped) return;
      if (Date.now() < state.pollBackoffUntil) return;

      const pollChannels = resolvePollChannels();
      for (const channelId of pollChannels) {
        try {
          const res = await fetch(
            `${account.apiBase}/channels/${encodeURIComponent(channelId)}/messages?limit=5&sort=Latest`,
            {
              method: "GET",
              headers: {
                "content-type": "application/json",
                "x-bot-token": account.token,
                "x-session-token": account.token,
              },
            },
          );

          if (res.status === 429) {
            const body = await res.json().catch(() => null);
            const retryAfterRaw = body?.retry_after ?? res.headers.get("retry-after") ?? 10;
            const retryAfterSec = Math.max(1, Number(retryAfterRaw) || 10);
            state.pollBackoffUntil = Date.now() + retryAfterSec * 1000;
            ctx.log?.warn?.(`[${account.accountId}] polling rate limited (429), backing off ${retryAfterSec}s`);
            return;
          }

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`poll failed (${res.status}): ${text.slice(0, 300)}`);
          }

          const messages = await res.json().catch(() => []);
          if (!Array.isArray(messages) || !messages.length) continue;

          const ordered = [...messages].reverse();
          const newest = messages[0]?._id || messages[0]?.id || null;

          for (const msg of ordered) {
            const messageId = msg?._id || msg?.id;
            if (!messageId) continue;
            if (state.lastSeenMessageId && messageId <= state.lastSeenMessageId) continue;

            const authorId = extractAuthorId(msg);
            if (selfId && authorId && String(authorId) === String(selfId)) continue;

            await dispatchInbound(ctx, account, msg, selfId, {
              channelType: state.channelTypeById.get(String(msg?.channel || msg?.channel_id || "")),
            });
          }

          if (newest) {
            state.lastSeenMessageId = String(newest);
          }
        } catch (err) {
          state.lastError = `polling error: ${String(err)}`;
          ctx.log?.warn?.(`[${account.accountId}] ${state.lastError}`);
        }
      }
    };

    state.polling = true;
    state.pollTimer = setInterval(() => {
      tick().catch((err) => {
        state.lastError = `polling tick failed: ${String(err)}`;
        ctx.log?.warn?.(`[${account.accountId}] ${state.lastError}`);
      });
    }, 10000);

    tick().catch((err) => {
      state.lastError = `polling startup failed: ${String(err)}`;
      ctx.log?.warn?.(`[${account.accountId}] ${state.lastError}`);
    });
  };

  const scheduleReconnect = () => {
    if (state.stopped) return;
    clearReconnect();
    clearPing();
    const delayMs = Math.min(120000, 2000 * 2 ** state.backoffAttempt);
    state.backoffAttempt = Math.min(state.backoffAttempt + 1, 8);
    ctx.log?.warn?.(`[${account.accountId}] websocket disconnected, reconnect in ${delayMs}ms`);
    if (!state.polling) {
      ctx.log?.warn?.("WS down, falling back to REST polling");
      startPollFallback();
    }
    state.reconnectTimer = setTimeout(connect, delayMs);
    ctx.setStatus({
      accountId: account.accountId,
      running: true,
      transport: "websocket",
      connected: false,
      reconnectInMs: delayMs,
      polling: state.polling,
      lastError: state.lastError,
      lastEventAt: state.lastEventAt,
      selfId,
      wsUrl,
      apiBase: account.apiBase,
      tokenSource: account.tokenSource,
    });
  };

  const sendJson = (obj) => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    state.socket.send(JSON.stringify(obj));
  };

  const handleEvent = async (event) => {
    state.lastEventAt = nowIso();
    ctx.log?.info?.(`[${account.accountId}] ws event type=${event?.type}`);

    switch (event?.type) {
      case "Authenticated":
        ctx.log?.info?.(`[${account.accountId}] websocket authenticated`);
        break;
      case "Ready":
        ctx.log?.info?.(`[${account.accountId}] websocket ready`);
        cacheChannelTypes(event?.channels);
        break;
      case "Ping":
        sendJson({ type: "Pong", data: event?.data ?? undefined });
        break;
      case "Message": {
        const channelId = String(event?.channel || event?.channel_id || "");
        await dispatchInbound(ctx, account, event, selfId, {
          channelType: state.channelTypeById.get(channelId),
        });
        break;
      }
      default:
        break;
    }

    ctx.setStatus({
      accountId: account.accountId,
      running: true,
      transport: "websocket",
      connected: true,
      connectedAt: state.connectedAt,
      lastEventAt: state.lastEventAt,
      polling: state.polling,
      lastError: state.lastError,
      selfId,
      wsUrl,
      apiBase: account.apiBase,
      tokenSource: account.tokenSource,
    });
  };

  const connect = () => {
    if (state.stopped) return;

    try {
      const socket = new WebSocket(wsUrl);
      state.socket = socket;

      socket.addEventListener("open", () => {
        state.backoffAttempt = 0;
        state.connectedAt = nowIso();
        state.lastError = null;
        if (state.polling) {
          ctx.log?.info?.("WS reconnected, stopping REST poll");
          clearPoll();
        }
        ctx.log?.info?.(`[${account.accountId}] websocket connected: ${wsUrl}`);
        sendJson({ type: "Authenticate", token: account.token });
        startPing();
      });

      socket.addEventListener("message", async (msg) => {
        try {
          const text = typeof msg.data === "string" ? msg.data : String(msg.data ?? "");
          const event = JSON.parse(text);
          await handleEvent(event);
        } catch (err) {
          state.lastError = String(err);
          ctx.log?.warn?.(`[${account.accountId}] websocket message handling failed: ${state.lastError}`);
        }
      });

      socket.addEventListener("error", (err) => {
        state.lastError = `websocket error: ${String(err?.message || err)}`;
        ctx.log?.warn?.(`[${account.accountId}] ${state.lastError}`);
      });

      socket.addEventListener("close", () => {
        state.socket = null;
        scheduleReconnect();
      });
    } catch (err) {
      state.lastError = `websocket connect failed: ${String(err)}`;
      ctx.log?.error?.(`[${account.accountId}] ${state.lastError}`);
      scheduleReconnect();
    }
  };

  connect();

  return {
    stop: () => {
      state.stopped = true;
      clearReconnect();
      clearPing();
      clearPoll();
      if (state.socket) {
        try {
          state.socket.close();
        } catch {
          // ignore
        }
        state.socket = null;
      }
      ctx.setStatus({
        accountId: account.accountId,
        running: false,
        transport: "websocket",
        connected: false,
        lastStopAt: nowIso(),
        lastError: state.lastError,
      });
      ctx.log?.info?.(`[${account.accountId}] stoat websocket stopped`);
    },
  };
}

export const stoatPlugin = {
  id: "stoat",
  meta: {
    id: "stoat",
    label: "Stoat",
    selectionLabel: "Stoat (Revolt)",
    docsPath: "/channels/stoat",
    docsLabel: "stoat",
    blurb: "Stoat/Revolt bot integration over websocket + REST.",
    aliases: ["revolt"],
    order: 85,
  },
  capabilities: {
    chatTypes: ["direct", "group", "channel"],
    media: true,
  },
  reload: { configPrefixes: ["channels.stoat"] },
  configSchema: emptyPluginConfigSchema(),
  config: {
    listAccountIds: (cfg) => listAccountIds(cfg),
    resolveAccount: (cfg, accountId) => accountFromConfig(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => Boolean(account.token),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token),
      tokenSource: account.tokenSource,
      apiBase: account.apiBase,
      wsBase: account.wsBase,
      autumnBase: account.autumnBase,
    }),
  },
  messaging: {
    normalizeTarget: (target) => String(target).trim(),
    targetResolver: {
      looksLikeId: (input) => /^[A-Za-z0-9]{6,64}$/.test(String(input).trim()),
      hint: "<channelId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 1900,
    sendText: async ({ to, text, accountId }) => {
      const client = activeClients.get(accountId ?? DEFAULT_ACCOUNT_ID);
      if (!client) {
        throw new Error(`Stoat client not running for account ${accountId ?? DEFAULT_ACCOUNT_ID}`);
      }
      const msg = await sendStoatMessage({
        token: client.account.token,
        apiBase: client.account.apiBase,
        channelId: to,
        text,
      });
      return {
        channel: "stoat",
        to,
        messageId: msg?._id ?? msg?.id ?? `stoat-${Date.now()}`,
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts
        .filter((a) => typeof a.lastError === "string" && a.lastError.trim())
        .map((a) => ({
          channel: "stoat",
          accountId: a.accountId,
          kind: "runtime",
          message: `Channel error: ${a.lastError}`,
        })),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      transport: snapshot.transport ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token),
      tokenSource: account.tokenSource,
      apiBase: account.apiBase,
      wsBase: account.wsBase,
      autumnBase: account.autumnBase,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      selfId: runtime?.selfId ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.token) {
        throw new Error(
          `Stoat token missing for account ${account.accountId}. Set channels.stoat.token or env STOAT_BOT_TOKEN.`,
        );
      }

      const selfId = await fetchSelfUserId(account);
      if (!selfId) {
        ctx.log?.warn?.(`[${account.accountId}] could not resolve bot user ID; self-filter may not work`);
      } else {
        ctx.log?.info?.(`[${account.accountId}] Stoat bot ID: ${selfId}`);
      }

      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        connected: false,
        transport: "websocket",
        lastStartAt: nowIso(),
        selfId,
        apiBase: account.apiBase,
        wsUrl: resolveWsUrl(account.wsBase),
        tokenSource: account.tokenSource,
      });

      const wsClient = createWsClient(ctx, account, selfId);
      activeClients.set(account.accountId, { account, wsClient, selfId });

      return {
        stop: () => {
          try {
            wsClient?.stop?.();
          } finally {
            activeClients.delete(account.accountId);
          }
        },
      };
    },
  },
};

const plugin = {
  id: "stoat",
  name: "Stoat",
  description: "Stoat (Revolt) channel plugin",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api) {
    runtimeRef = api.runtime;
    api.registerChannel({ plugin: stoatPlugin });
  },
};

export default plugin;
