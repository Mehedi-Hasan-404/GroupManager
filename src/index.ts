const TG_API_BASE = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  BOT_CONFIG: KVNamespace;
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel" | string;
  title?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface GroupSettings {
  antilink: boolean;
  autoMute: boolean;
  autoMuteThreshold: number;
  autoMuteMinutes: number;
  whitelist: string[];
}

const DEFAULT_SETTINGS: GroupSettings = {
  antilink: true,
  autoMute: true,
  autoMuteThreshold: 3,
  autoMuteMinutes: 30,
  whitelist: [] // domains like "example.com"
};

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("OK");
    }

    let update: TelegramUpdate | null = null;
    try {
      update = await request.json<TelegramUpdate>();
    } catch (e) {
      console.error("Failed to parse update", e);
      return new Response("Bad Request", { status: 400 });
    }

    if (!update || !update.message) {
      return new Response("OK");
    }

    ctx.waitUntil(handleMessage(update.message, env));
    return new Response("OK");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processDueDeletions(env));
  }
};

export default worker;

/* --------------------------- main logic --------------------------- */

async function handleMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;

  // Track group in KV for /groups command
  if (chat.type === "group" || chat.type === "supergroup") {
    await registerGroup(chat, env);
  }

  const text = message.text || message.caption || "";

  // Private chat: bot control & overview
  if (chat.type === "private") {
    await handlePrivateCommands(message, env);
    return;
  }

  // Only moderate groups / supergroups
  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const chatId = chat.id.toString();

  // Group commands
  if (text.startsWith("/")) {
    await handleGroupCommands(message, env);
    return;
  }

  // Normal message => moderation
  const user = message.from;
  if (!user) return;

  const settings = await getGroupSettings(chatId, env);

  if (settings.antilink) {
    const linkCheck = findBlockedLinks(text, settings.whitelist);
    if (linkCheck.hasBlocked) {
      await deleteMessage(chatId, message.message_id, env);
      await handleViolation(chatId, user.id, settings, env);
    }
  }
}

/* -------------------------- group settings ------------------------ */

async function getGroupSettings(chatId: string, env: Env): Promise<GroupSettings> {
  const key = `group:${chatId}:settings`;
  const raw = await env.BOT_CONFIG.get(key);
  if (!raw) return { ...DEFAULT_SETTINGS };

  try {
    const parsed = JSON.parse(raw) as GroupSettings;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      whitelist: parsed.whitelist || []
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveGroupSettings(chatId: string, settings: GroupSettings, env: Env) {
  const key = `group:${chatId}:settings`;
  await env.BOT_CONFIG.put(key, JSON.stringify(settings));
}

/* -------------------------- group registry ------------------------ */

async function registerGroup(chat: TelegramChat, env: Env) {
  const id = chat.id.toString();
  const metaKey = `group:${id}:meta`;
  const indexKey = "groups:index";

  const metaValue = JSON.stringify({
    id,
    title: chat.title || ""
  });
  await env.BOT_CONFIG.put(metaKey, metaValue);

  const indexRaw = (await env.BOT_CONFIG.get(indexKey)) || "[]";
  let ids: string[] = [];
  try {
    ids = JSON.parse(indexRaw);
  } catch {
    ids = [];
  }
  if (!ids.includes(id)) {
    ids.push(id);
    await env.BOT_CONFIG.put(indexKey, JSON.stringify(ids));
  }
}

/* --------------------------- link handling ------------------------ */

interface LinkCheckResult {
  hasAny: boolean;
  hasBlocked: boolean;
  blockedDomains: string[];
}

function findBlockedLinks(text: string, whitelist: string[]): LinkCheckResult {
  const result: LinkCheckResult = {
    hasAny: false,
    hasBlocked: false,
    blockedDomains: []
  };

  if (!text) return result;

  // Very broad match for links/domains
  const linkRegex = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|[a-z0-9.-]+\.[a-z]{2,})(\/\S*)?/gi;
  const domainRegex = /[a-z0-9.-]+\.[a-z]{2,}/gi;

  const domainsFound = new Set<string>();
  let m: RegExpExecArray | null;

  while ((m = domainRegex.exec(text)) !== null) {
    domainsFound.add(m[0].toLowerCase());
  }

  const hasLinkLike = linkRegex.test(text) || domainsFound.size > 0;
  result.hasAny = hasLinkLike;

  if (!hasLinkLike) return result;

  const whitelistSet = new Set(whitelist.map(d => d.toLowerCase()));
  const blocked: string[] = [];

  for (const d of domainsFound) {
    // allow if exactly in whitelist or endsWith("." + whitelisted)
    let allowed = false;
    for (const w of whitelistSet) {
      if (d === w || d.endsWith("." + w)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) blocked.push(d);
  }

  if (blocked.length > 0) {
    result.hasBlocked = true;
    result.blockedDomains = blocked;
  } else {
    // Domains found but all whitelisted
    result.hasBlocked = false;
  }

  return result;
}

/* ----------------------- violations & auto mute ------------------- */

async function handleViolation(
  chatId: string,
  userId: number,
  settings: GroupSettings,
  env: Env
) {
  const key = `violations:${chatId}:${userId}`;
  const current = (await env.BOT_CONFIG.get(key)) || "0";
  const count = parseInt(current, 10) || 0;
  const next = count + 1;
  await env.BOT_CONFIG.put(key, next.toString());

  if (settings.autoMute && next >= settings.autoMuteThreshold) {
    await muteUser(chatId, userId, settings.autoMuteMinutes, env);
    await env.BOT_CONFIG.put(key, "0");
    await sendText(
      chatId,
      `🔇 User ${userId} auto-muted for ${settings.autoMuteMinutes} minutes due to repeated link posting.`,
      env
    );
  }
}

/* --------------------------- commands ----------------------------- */

async function handlePrivateCommands(message: TelegramMessage, env: Env) {
  const chatId = message.chat.id.toString();
  const text = message.text || "";

  const [cmdRaw] = text.split(" ");
  const cmd = cmdRaw.split("@")[0];

  switch (cmd) {
    case "/start":
    case "/help":
      await sendText(
        chatId,
        "👋 I am a group manager bot.\n\n" +
          "• Delete all links (with optional whitelist)\n" +
          "• Auto-mute repeated link posters\n" +
          "• Admin commands: /mute, /unmute, /del, /settings, /set ...\n\n" +
          "Add me to a group as admin and give me 'Delete messages' and 'Restrict members' permissions.",
        env
      );
      break;

    case "/groups":
      await showGroups(chatId, env);
      break;

    default:
      await sendText(
        chatId,
        "Use /groups to see groups where I'm added.\nUse /help for more info.",
        env
      );
      break;
  }
}

async function showGroups(chatId: string, env: Env) {
  const indexKey = "groups:index";
  const raw = (await env.BOT_CONFIG.get(indexKey)) || "[]";
  let ids: string[] = [];
  try {
    ids = JSON.parse(raw);
  } catch {
    ids = [];
  }

  if (ids.length === 0) {
    await sendText(chatId, "No groups registered yet.", env);
    return;
  }

  let lines: string[] = [];
  for (const id of ids) {
    const metaRaw = await env.BOT_CONFIG.get(`group:${id}:meta`);
    if (!metaRaw) continue;
    try {
      const meta = JSON.parse(metaRaw) as { id: string; title: string };
      lines.push(`${meta.title || "(no title)"} – ${meta.id}`);
    } catch {
      continue;
    }
  }

  if (lines.length === 0) {
    await sendText(chatId, "No groups registered yet.", env);
  } else {
    await sendText(chatId, "Groups I know:\n\n" + lines.join("\n"), env);
  }
}

async function handleGroupCommands(message: TelegramMessage, env: Env) {
  const chat = message.chat;
  const chatId = chat.id.toString();
  const from = message.from;
  if (!from) return;

  const text = message.text || "";
  const [cmdRaw, ...args] = text.split(" ");
  const cmd = cmdRaw.split("@")[0];

  const isFromAdmin = await isAdmin(chatId, from.id, env);

  switch (cmd) {
    case "/start":
    case "/help":
      await sendText(
        chatId,
        "👮 Group manager active.\n\n" +
          "I delete links and can auto-mute spammers.\n\n" +
          "Admin commands:\n" +
          "• /settings – show current settings\n" +
          "• /set antilink on|off\n" +
          "• /set automute on|off\n" +
          "• /set threshold <number>\n" +
          "• /set automutemin <minutes>\n" +
          "• /set whitelist add <domain.com>\n" +
          "• /set whitelist remove <domain.com>\n" +
          "• /set whitelist list\n" +
          "• Reply with /mute 10m or /mute 1h\n" +
          "• Reply with /unmute\n" +
          "• Reply with /del 10s|10m|1h|1d to delete a message later.",
        env
      );
      break;

    case "/settings": {
      const settings = await getGroupSettings(chatId, env);
      const txt =
        "⚙️ Settings:\n" +
        `• Anti-link: ${settings.antilink ? "ON" : "OFF"}\n` +
        `• Auto-mute: ${settings.autoMute ? "ON" : "OFF"}\n` +
        `• Auto-mute threshold: ${settings.autoMuteThreshold}\n` +
        `• Auto-mute minutes: ${settings.autoMuteMinutes}\n` +
        `• Whitelist: ${
          settings.whitelist.length ? settings.whitelist.join(", ") : "(none)"
        }`;
      await sendText(chatId, txt, env);
      break;
    }

    case "/set": {
      if (!isFromAdmin) return;
      await handleSetCommand(chatId, args, env);
      break;
    }

    case "/mute": {
      if (!isFromAdmin) return;
      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(
          chatId,
          "Reply to a user's message with /mute <time>, e.g. /mute 10m or /mute 1h",
          env
        );
        return;
      }
      const target = reply.from;
      const durationMinutes = parseDuration(args[0]); // 10m, 1h, 1d...
      await muteUser(chatId, target.id, durationMinutes, env);
      await sendText(
        chatId,
        `🔇 Muted ${displayName(target)} for ${args[0] || "24h"}.`,
        env
      );
      break;
    }

    case "/unmute": {
      if (!isFromAdmin) return;
      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chatId, "Reply to a user's message with /unmute", env);
        return;
      }
      const target = reply.from;
      await unmuteUser(chatId, target.id, env);
      await sendText(chatId, `🔊 Unmuted ${displayName(target)}.`, env);
      break;
    }

    case "/del": {
      if (!isFromAdmin) return;
      const reply = message.reply_to_message;
      if (!reply) {
        await sendText(
          chatId,
          "Reply to a message with /del 10s|10m|1h|1d to delete it later.",
          env
        );
        return;
      }
      const millis = parseDurationMillis(args[0]);
      if (!millis) {
        await sendText(
          chatId,
          "Invalid time. Use something like 10s, 30s, 1m, 10m, 1h, 1d.",
          env
        );
        return;
      }
      await scheduleDeletion(chatId, reply.message_id, Date.now() + millis, env);
      await sendText(
        chatId,
        `🗑️ Scheduled deletion in ${args[0] || "10m"}.`,
        env
      );
      break;
    }

    default:
      break;
  }
}

async function handleSetCommand(chatId: string, args: string[], env: Env) {
  if (args.length === 0) {
    await sendText(
      chatId,
      "Usage examples:\n" +
        "/set antilink on|off\n" +
        "/set automute on|off\n" +
        "/set threshold 3\n" +
        "/set automutemin 30\n" +
        "/set whitelist add example.com\n" +
        "/set whitelist remove example.com\n" +
        "/set whitelist list",
      env
    );
    return;
  }

  const settings = await getGroupSettings(chatId, env);
  const [sub, ...rest] = args;

  switch (sub) {
    case "antilink":
      if (rest[0] === "on") settings.antilink = true;
      else if (rest[0] === "off") settings.antilink = false;
      await saveGroupSettings(chatId, settings, env);
      await sendText(
        chatId,
        `Anti-link is now ${settings.antilink ? "ON" : "OFF"}.`,
        env
      );
      break;

    case "automute":
      if (rest[0] === "on") settings.autoMute = true;
      else if (rest[0] === "off") settings.autoMute = false;
      await saveGroupSettings(chatId, settings, env);
      await sendText(
        chatId,
        `Auto-mute is now ${settings.autoMute ? "ON" : "OFF"}.`,
        env
      );
      break;

    case "threshold": {
      const n = parseInt(rest[0], 10);
      if (!n || n < 1) {
        await sendText(chatId, "Give a positive number, e.g. /set threshold 3", env);
        return;
      }
      settings.autoMuteThreshold = n;
      await saveGroupSettings(chatId, settings, env);
      await sendText(chatId, `Auto-mute threshold set to ${n}.`, env);
      break;
    }

    case "automutemin": {
      const n = parseInt(rest[0], 10);
      if (!n || n < 1) {
        await sendText(chatId, "Give minutes, e.g. /set automutemin 30", env);
        return;
      }
      settings.autoMuteMinutes = n;
      await saveGroupSettings(chatId, settings, env);
      await sendText(chatId, `Auto-mute minutes set to ${n}.`, env);
      break;
    }

    case "whitelist": {
      const action = rest[0];
      const domain = (rest[1] || "").toLowerCase();
      if (action === "add" && domain) {
        if (!settings.whitelist.includes(domain)) {
          settings.whitelist.push(domain);
        }
        await saveGroupSettings(chatId, settings, env);
        await sendText(
          chatId,
          `Added to whitelist: ${domain}\nCurrent: ${
            settings.whitelist.length ? settings.whitelist.join(", ") : "(none)"
          }`,
          env
        );
      } else if (action === "remove" && domain) {
        settings.whitelist = settings.whitelist.filter(d => d !== domain);
        await saveGroupSettings(chatId, settings, env);
        await sendText(
          chatId,
          `Removed from whitelist: ${domain}\nCurrent: ${
            settings.whitelist.length ? settings.whitelist.join(", ") : "(none)"
          }`,
          env
        );
      } else if (action === "list") {
        await sendText(
          chatId,
          `Whitelist: ${
            settings.whitelist.length ? settings.whitelist.join(", ") : "(none)"
          }`,
          env
        );
      } else {
        await sendText(
          chatId,
          "Usage:\n" +
            "/set whitelist add example.com\n" +
            "/set whitelist remove example.com\n" +
            "/set whitelist list",
          env
        );
      }
      break;
    }

    default:
      await sendText(chatId, "Unknown setting. Use /settings to see options.", env);
      break;
  }
}

/* ------------------------ mute / unmute --------------------------- */

async function muteUser(
  chatId: string,
  userId: number,
  minutes: number,
  env: Env
) {
  const now = Math.floor(Date.now() / 1000);
  const untilDate = now + minutes * 60;

  const permissions = {
    can_send_messages: false,
    can_send_audios: false,
    can_send_documents: false,
    can_send_photos: false,
    can_send_videos: false,
    can_send_video_notes: false,
    can_send_voice_notes: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false
  };

  await tgCall("restrictChatMember", env, {
    chat_id: chatId,
    user_id: userId,
    permissions,
    until_date: untilDate
  });
}

async function unmuteUser(chatId: string, userId: number, env: Env) {
  const permissions = {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true
  };

  await tgCall("restrictChatMember", env, {
    chat_id: chatId,
    user_id: userId,
    permissions
  });
}

/* --------------------- timed delete with cron --------------------- */

async function scheduleDeletion(
  chatId: string,
  messageId: number,
  deleteAtMs: number,
  env: Env
) {
  const key = `del:${chatId}:${messageId}`;
  const value = JSON.stringify({
    chatId,
    messageId,
    deleteAt: deleteAtMs
  });
  await env.BOT_CONFIG.put(key, value);
}

async function processDueDeletions(env: Env) {
  const now = Date.now();
  let cursor: string | undefined = undefined;

  do {
    const list = await env.BOT_CONFIG.list({ prefix: "del:", cursor });
    cursor = list.cursor;

    for (const key of list.keys) {
      const raw = await env.BOT_CONFIG.get(key.name);
      if (!raw) continue;
      try {
        const data = JSON.parse(raw) as {
          chatId: string;
          messageId: number;
          deleteAt: number;
        };
        if (data.deleteAt <= now) {
          await deleteMessage(data.chatId, data.messageId, env);
          await env.BOT_CONFIG.delete(key.name);
        }
      } catch (e) {
        console.error("Bad deletion entry", key.name, e);
        await env.BOT_CONFIG.delete(key.name);
      }
    }
  } while (cursor);
}

/* --------------------------- helpers ------------------------------ */

function parseDuration(arg: string | undefined): number {
  if (!arg) return 24 * 60; // default 24h
  const m = arg.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return 24 * 60;
  const value = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === "s") return Math.max(1, Math.round(value / 60));
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  if (unit === "d") return value * 60 * 24;
  return 24 * 60;
}

function parseDurationMillis(arg: string | undefined): number {
  if (!arg) return 10 * 60 * 1000; // default 10m
  const m = arg.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return 0;
  const value = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === "s") return value * 1000;
  if (unit === "m") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  if (unit === "d") return value * 24 * 60 * 60 * 1000;
  return 0;
}

async function isAdmin(chatId: string, userId: number, env: Env): Promise<boolean> {
  try {
    const res = await tgCall("getChatMember", env, {
      chat_id: chatId,
      user_id: userId
    });
    if (!res || !res.ok) return false;
    const status = res.result.status;
    return status === "creator" || status === "administrator";
  } catch (e) {
    console.error("isAdmin error", e);
    return false;
  }
}

async function sendText(chatId: string | number, text: string, env: Env) {
  await tgCall("sendMessage", env, {
    chat_id: chatId,
    text
  });
}

async function deleteMessage(chatId: string | number, messageId: number, env: Env) {
  await tgCall("deleteMessage", env, {
    chat_id: chatId,
    message_id: messageId
  });
}

async function tgCall(method: string, env: Env, body: Record<string, unknown>) {
  const url = `${TG_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  let data: any;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok || (data && data.ok === false)) {
    console.error("Telegram API error", method, data || res.statusText);
  }
  return data;
}

function displayName(user: TelegramUser): string {
  if (user.username) return `@${user.username}`;
  const full = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  return full || `${user.id}`;
}
