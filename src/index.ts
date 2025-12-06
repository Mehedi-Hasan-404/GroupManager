// Telegram Group Manager bot for Cloudflare Workers

const TG_API_BASE = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  BOT_CONFIG: KVNamespace;
  OWNER_USER_IDS?: string;
}

// ====== Types ======

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string; // "private" | "group" | "supergroup" | "channel" | ...
  title?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat; // for anonymous admins etc.
  chat: TelegramChat;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  // Forward-related – use as "any" internally
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  my_chat_member?: any;
}

// Group settings kept in KV
interface GroupSettings {
  antilink: boolean;
  antiforward: boolean;
  maxWarns: number;
  autoMuteMinutes: number;
  whitelist: string[]; // domains in lowercase, e.g. "example.com"
}

interface GroupMeta {
  id: number;
  title?: string;
  username?: string;
  addedAt: number; // unix seconds
}

interface DeleteJob {
  chatId: number;
  targetMessageId: number;
  infoMessageId?: number;
  deleteAt: number; // unix seconds
}

// KV key prefixes
const SETTINGS_PREFIX = "settings:";
const GROUP_META_PREFIX = "groupmeta:";
const WARNS_PREFIX = "warns:";
const DELQUEUE_PREFIX = "delqueue:";

// ====== Worker entrypoints ======

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("OK");
    }

    let update: TelegramUpdate | null = null;
    try {
      update = await request.json<TelegramUpdate>();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    if (!update) return new Response("No update", { status: 400 });

    if (update.message) {
      ctx.waitUntil(handleMessage(update.message, env));
    }

    if (update.my_chat_member) {
      ctx.waitUntil(handleMyChatMember(update.my_chat_member, env));
    }

    return new Response("OK");
  },

  // Cron for delayed deletes
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processDeleteQueue(env));
  }
};

// ====== Core handlers ======

async function handleMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;

  if (chat.type === "private") {
    await handlePrivateMessage(message, env);
    return;
  }

  if (chat.type === "group" || chat.type === "supergroup") {
    await handleGroupMessage(message, env);
  }
}

// When bot is added/removed from groups
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleMyChatMember(update: any, env: Env): Promise<void> {
  const chat: TelegramChat = update.chat;
  const newMember = update.new_chat_member;

  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;

  const status: string = newMember?.status || "";

  if (status === "member" || status === "administrator") {
    await ensureGroupKnown(chat, env);
  } else if (status === "left" || status === "kicked") {
    await removeGroup(chat.id, env);
  }
}

// ====== Private chat (owner control panel) ======

async function handlePrivateMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chatId = message.chat.id;
  const from = message.from;
  const text = message.text || "";

  if (!from) return;

  const [rawCmd, ...args] = text.trim().split(/\s+/);
  if (!rawCmd.startsWith("/")) {
    await sendText(chatId, "Use /help to see commands.", env);
    return;
  }

  const cmd = rawCmd.split("@")[0];

  const isOwnerUser = isOwner(from.id, env);
  if (!isOwnerUser) {
    if (cmd === "/start" || cmd === "/help") {
      await sendText(
        chatId,
        "This bot is restricted. Only the configured owner(s) can manage settings.\nYou can still use it in groups for moderation.",
        env
      );
    } else {
      await sendText(chatId, "Only the bot owner can use this command.", env);
    }
    return;
  }

  switch (cmd) {
    case "/start":
      await sendText(
        chatId,
        [
          "👋 Group Manager control panel.",
          "",
          "Main commands (use *here* in PM):",
          "/groups – list groups where I'm added",
          "/status <chat_id> – show settings for a group",
          "/set <chat_id> <key> <value> – change settings",
          "  keys: antilink on|off, antiforward on|off, maxwarns N, automute N_minutes",
          "/whitelist <chat_id> add|remove|list <domain>",
          "",
          "Use /help for full info."
        ].join("\n"),
        env
      );
      break;

    case "/help":
      await sendText(
        chatId,
        [
          "Available commands:",
          "",
          "/groups – list groups where I'm added",
          "/status <chat_id> – show config for that group",
          "/set <chat_id> <key> <value>",
          "  • antilink on|off",
          "  • antiforward on|off",
          "  • maxwarns <number>",
          "  • automute <minutes>",
          "",
          "/whitelist <chat_id> add <domain>",
          "/whitelist <chat_id> remove <domain>",
          "/whitelist <chat_id> list",
          "",
          "Use group commands directly in groups:",
          "  /mute 10m (reply) – mute user",
          "  /unmute (reply) – unmute user",
          "  /del 10s (reply) – delete that message later",
          "  /status – show current settings for this group."
        ].join("\n"),
        env
      );
      break;

    case "/groups":
      await handleGroupsCommand(chatId, env);
      break;

    case "/status":
      await handleStatusPM(chatId, args, env);
      break;

    case "/set":
      await handleSetPM(chatId, args, env);
      break;

    case "/whitelist":
      await handleWhitelistPM(chatId, args, env);
      break;

    default:
      await sendText(chatId, "Unknown command. Use /help.", env);
      break;
  }
}

async function handleGroupsCommand(chatId: number, env: Env): Promise<void> {
  const list = await env.BOT_CONFIG.list({ prefix: GROUP_META_PREFIX, limit: 1000 });
  if (!list.keys.length) {
    await sendText(chatId, "I don't know any groups yet.", env);
    return;
  }

  const lines: string[] = ["Groups I know:\n"];
  for (const key of list.keys) {
    const metaJson = await env.BOT_CONFIG.get(key.name);
    if (!metaJson) continue;
    const meta = JSON.parse(metaJson) as GroupMeta;
    const title = meta.title || "(no title)";
    lines.push(`${title} — \`${meta.id}\``);
  }

  await sendText(chatId, lines.join("\n"), env, { parse_mode: "Markdown" });
}

async function handleStatusPM(chatId: number, args: string[], env: Env): Promise<void> {
  const idStr = args[0];
  if (!idStr) {
    await sendText(chatId, "Usage: /status <chat_id>\nUse /groups to see chat IDs.", env);
    return;
  }

  const groupId = parseInt(idStr, 10);
  if (!groupId) {
    await sendText(chatId, "Invalid chat_id.", env);
    return;
  }

  const settings = await loadSettings(groupId, env);
  await sendText(chatId, formatSettings(groupId, settings), env);
}

async function handleSetPM(chatId: number, args: string[], env: Env): Promise<void> {
  const [idStr, key, value] = args;
  if (!idStr || !key || !value) {
    await sendText(
      chatId,
      "Usage: /set <chat_id> <key> <value>\nExample: /set -100123456789 antilink on",
      env
    );
    return;
  }

  const groupId = parseInt(idStr, 10);
  if (!groupId) {
    await sendText(chatId, "Invalid chat_id.", env);
    return;
  }

  const settings = await loadSettings(groupId, env);

  switch (key.toLowerCase()) {
    case "antilink":
      settings.antilink = value.toLowerCase() === "on";
      break;
    case "antiforward":
      settings.antiforward = value.toLowerCase() === "on";
      break;
    case "maxwarns": {
      const n = parseInt(value, 10);
      if (!n || n < 1) {
        await sendText(chatId, "maxwarns must be a positive number.", env);
        return;
      }
      settings.maxWarns = n;
      break;
    }
    case "automute": {
      const n = parseInt(value, 10);
      if (!n || n < 1) {
        await sendText(chatId, "automute must be minutes > 0.", env);
        return;
      }
      settings.autoMuteMinutes = n;
      break;
    }
    default:
      await sendText(
        chatId,
        "Unknown key. Supported keys: antilink, antiforward, maxwarns, automute",
        env
      );
      return;
  }

  await saveSettings(groupId, settings, env);
  await sendText(chatId, "Saved:\n" + formatSettings(groupId, settings), env);
}

async function handleWhitelistPM(chatId: number, args: string[], env: Env): Promise<void> {
  const [idStr, action, domainArg] = args;
  if (!idStr || !action) {
    await sendText(
      chatId,
      "Usage: /whitelist <chat_id> add|remove|list <domain>",
      env
    );
    return;
  }

  const groupId = parseInt(idStr, 10);
  if (!groupId) {
    await sendText(chatId, "Invalid chat_id.", env);
    return;
  }

  const settings = await loadSettings(groupId, env);

  switch (action.toLowerCase()) {
    case "list": {
      if (!settings.whitelist.length) {
        await sendText(chatId, "Whitelist is empty for this group.", env);
      } else {
        await sendText(
          chatId,
          "Whitelisted domains:\n" + settings.whitelist.join("\n"),
          env
        );
      }
      break;
    }
    case "add": {
      if (!domainArg) {
        await sendText(chatId, "Usage: /whitelist <chat_id> add <domain>", env);
        return;
      }
      const d = normalizeDomain(domainArg);
      if (!d) {
        await sendText(chatId, "Invalid domain.", env);
        return;
      }
      if (!settings.whitelist.includes(d)) {
        settings.whitelist.push(d);
        await saveSettings(groupId, settings, env);
      }
      await sendText(chatId, `Added to whitelist: ${d}`, env);
      break;
    }
    case "remove": {
      if (!domainArg) {
        await sendText(chatId, "Usage: /whitelist <chat_id> remove <domain>", env);
        return;
      }
      const d = normalizeDomain(domainArg);
      if (!d) {
        await sendText(chatId, "Invalid domain.", env);
        return;
      }
      settings.whitelist = settings.whitelist.filter((x) => x !== d);
      await saveSettings(groupId, settings, env);
      await sendText(chatId, `Removed from whitelist: ${d}`, env);
      break;
    }
    default:
      await sendText(
        chatId,
        "Unknown action. Use add, remove or list.",
        env
      );
      break;
  }
}

// ====== Group messages ======

async function handleGroupMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const chatId = chat.id;
  const text = message.text || message.caption || "";

  await ensureGroupKnown(chat, env);
  const settings = await loadSettings(chatId, env);

  // 1) Commands
  if (text.startsWith("/")) {
    await handleGroupCommand(message, settings, env);
    return;
  }

  // 2) Moderation for normal messages
  await applyModerationRules(message, settings, env);
}

async function handleGroupCommand(message: TelegramMessage, settings: GroupSettings, env: Env): Promise<void> {
  const chat = message.chat;
  const chatId = chat.id;
  const text = message.text || "";
  const from = message.from;

  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = rawCmd.split("@")[0];

  // /status works for everyone to see config
  if (cmd === "/status") {
    await sendText(chatId, formatSettings(chatId, settings), env);
    return;
  }

  // Other commands require "admin-like" sender (normal admin or anonymous admin)
  const isAdminLike = await isAdminLikeSender(message, env);
  if (!isAdminLike) return;

  switch (cmd) {
    case "/mute": {
      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chatId, "Reply to a user's message with /mute <time>, e.g. /mute 10m", env);
        return;
      }
      const target = reply.from;
      const durationMinutes = parseDuration(args[0]); // default 24h
      await muteUser(chatId, target.id, durationMinutes, env);
      await sendText(
        chatId,
        `🔇 Muted ${displayName(target)} for ${args[0] || "24h"}.`,
        env
      );
      break;
    }

    case "/unmute": {
      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chatId, "Reply to a user's message with /unmute", env);
        return;
      }
      const target = reply.from;
      await unmuteUser(chatId, target.id, env);
      await sendText(
        chatId,
        `🔊 Unmuted ${displayName(target)}.`,
        env
      );
      break;
    }

    case "/del": {
      const reply = message.reply_to_message;
      if (!reply) {
        await sendText(chatId, "Reply to a message with /del <time>, e.g. /del 10s or /del 10m", env);
        return;
      }
      const seconds = parseDurationSeconds(args[0]); // default 60s
      const now = Math.floor(Date.now() / 1000);
      const deleteAt = now + seconds;

      const info = await sendText(
        chatId,
        `🗑 This message will be deleted in ${args[0] || "60s"}.`,
        env
      );

      const job: DeleteJob = {
        chatId,
        targetMessageId: reply.message_id,
        infoMessageId: info?.message_id,
        deleteAt
      };

      const key = `${DELQUEUE_PREFIX}${chatId}:${reply.message_id}`;
      await env.BOT_CONFIG.put(key, JSON.stringify(job));

      // also schedule deletion of the /del command message itself
      const cmdJob: DeleteJob = {
        chatId,
        targetMessageId: message.message_id,
        deleteAt
      };
      const key2 = `${DELQUEUE_PREFIX}${chatId}:${message.message_id}`;
      await env.BOT_CONFIG.put(key2, JSON.stringify(cmdJob));

      break;
    }

    default:
      // ignore others
      break;
  }
}

// Apply anti-link & anti-forward + warnings / auto-mute
async function applyModerationRules(message: TelegramMessage, settings: GroupSettings, env: Env): Promise<void> {
  const chatId = message.chat.id;
  const from = message.from;
  const senderChat = message.sender_chat;

  // Don't moderate messages from bots or from the group itself (anonymous admins)
  if (from?.is_bot) return;
  if (senderChat && senderChat.id === chatId) return;

  const userId = from?.id;
  if (!userId) return;

  const text = message.text || message.caption || "";

  // If user is admin, skip moderation
  const isAdminUser = await isAdmin(chatId, userId, env);
  if (isAdminUser) return;

  let violated = false;
  let reason = "";

  if (settings.antilink && hasBlockedLink(text, settings)) {
    violated = true;
    reason = "posting links";
  }

  if (!violated && settings.antiforward && isForwarded(message)) {
    violated = true;
    reason = "forwarding messages";
  }

  if (!violated) return;

  // Delete the message
  await deleteMessage(chatId, message.message_id, env);
  await addWarning(chatId, userId, reason, settings, env);
}

// ====== Moderation helpers (warnings, mutes, detection) ======

async function addWarning(
  chatId: number,
  userId: number,
  reason: string,
  settings: GroupSettings,
  env: Env
): Promise<void> {
  const warnKey = `${WARNS_PREFIX}${chatId}:${userId}`;
  const curStr = (await env.BOT_CONFIG.get(warnKey)) || "0";
  const current = parseInt(curStr, 10) || 0;
  const next = current + 1;
  await env.BOT_CONFIG.put(warnKey, String(next));

  const msg = `⚠️ Warning ${next}/${settings.maxWarns} for user ${userId} (${reason}).`;
  await sendText(chatId, msg, env);

  if (next >= settings.maxWarns) {
    await env.BOT_CONFIG.put(warnKey, "0");
    await muteUser(chatId, userId, settings.autoMuteMinutes, env);
    await sendText(
      chatId,
      `🔇 User ${userId} auto-muted for ${settings.autoMuteMinutes} minutes due to repeated violations.`,
      env
    );
  }
}

function hasBlockedLink(text: string | undefined, settings: GroupSettings): boolean {
  if (!text) return false;

  // Find domains in text (with or without http/https/www)
  const regex = /\b((?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,}))/gi;
  let match: RegExpExecArray | null;
  let found = false;

  while ((match = regex.exec(text)) !== null) {
    found = true;
    const domain = (match[2] || "").toLowerCase();
    if (!domain) continue;
    if (!settings.whitelist.includes(domain)) {
      return true; // domain not whitelisted -> blocked
    }
  }

  // Also treat t.me or telegram.me without protocol
  const teleRe = /\b(t\.me|telegram\.me)\/\S+/i;
  if (teleRe.test(text)) {
    const domain = "t.me";
    if (!settings.whitelist.includes(domain)) return true;
  }

  // If no domain found at all, it's fine
  return false;
}

// Any forwarded message (including story forwards)
function isForwarded(message: TelegramMessage): boolean {
  // New Bot API: forward_origin field
  if (message.forward_origin) return true;
  // Old fields
  if (message.forward_from || message.forward_from_chat || message.forward_sender_name) return true;
  if (message.forward_date) return true;
  return false;
}

// ====== Group & settings storage ======

async function ensureGroupKnown(chat: TelegramChat, env: Env): Promise<void> {
  const key = `${GROUP_META_PREFIX}${chat.id}`;
  const exists = await env.BOT_CONFIG.get(key);
  if (!exists) {
    const meta: GroupMeta = {
      id: chat.id,
      title: chat.title,
      username: chat.username,
      addedAt: Math.floor(Date.now() / 1000)
    };
    await env.BOT_CONFIG.put(key, JSON.stringify(meta));
  }
}

async function removeGroup(chatId: number, env: Env): Promise<void> {
  // Remove meta; settings and warns can stay, they won't be listed
  const key = `${GROUP_META_PREFIX}${chatId}`;
  await env.BOT_CONFIG.delete(key);
}

function defaultSettings(): GroupSettings {
  return {
    antilink: true,
    antiforward: true, // ON by default
    maxWarns: 3,
    autoMuteMinutes: 30,
    whitelist: []
  };
}

async function loadSettings(chatId: number, env: Env): Promise<GroupSettings> {
  const key = `${SETTINGS_PREFIX}${chatId}`;
  const json = await env.BOT_CONFIG.get(key);
  if (!json) {
    const def = defaultSettings();
    await env.BOT_CONFIG.put(key, JSON.stringify(def));
    return def;
  }
  const parsed = JSON.parse(json) as Partial<GroupSettings>;
  return {
    ...defaultSettings(),
    ...parsed,
    whitelist: parsed.whitelist || []
  };
}

async function saveSettings(chatId: number, settings: GroupSettings, env: Env): Promise<void> {
  const key = `${SETTINGS_PREFIX}${chatId}`;
  await env.BOT_CONFIG.put(key, JSON.stringify(settings));
}

function formatSettings(chatId: number, s: GroupSettings): string {
  return [
    `Settings for chat ${chatId}:`,
    `• antilink: ${s.antilink ? "ON" : "OFF"}`,
    `• antiforward: ${s.antiforward ? "ON" : "OFF"}`,
    `• maxwarns: ${s.maxWarns}`,
    `• automute: ${s.autoMuteMinutes} minutes`,
    `• whitelist domains: ${s.whitelist.length ? s.whitelist.join(", ") : "(none)"}`
  ].join("\n");
}

// ====== Delete queue (cron) ======

async function processDeleteQueue(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let cursor: string | undefined = undefined;

  while (true) {
    const page = await env.BOT_CONFIG.list({
      prefix: DELQUEUE_PREFIX,
      limit: 100,
      cursor
    });

    for (const key of page.keys) {
      const value = await env.BOT_CONFIG.get(key.name);
      if (!value) continue;
      const job = JSON.parse(value) as DeleteJob;
      if (job.deleteAt <= now) {
        await deleteMessage(job.chatId, job.targetMessageId, env);
        if (job.infoMessageId) {
          await deleteMessage(job.chatId, job.infoMessageId, env);
        }
        await env.BOT_CONFIG.delete(key.name);
      }
    }

    if (!page.list_complete && page.cursor) {
      cursor = page.cursor;
    } else {
      break;
    }
  }
}

// ====== Admin / owner helpers ======

function getOwnerIds(env: Env): number[] {
  const raw = env.OWNER_USER_IDS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !!n);
}

function isOwner(userId: number, env: Env): boolean {
  const owners = getOwnerIds(env);
  if (!owners.length) return true; // if not configured, treat everyone as owner
  return owners.includes(userId);
}

// Some admins may be anonymous – their messages have sender_chat = group
async function isAdminLikeSender(message: TelegramMessage, env: Env): Promise<boolean> {
  const chatId = message.chat.id;
  const from = message.from;
  const senderChat = message.sender_chat;

  // Anonymous admin: sender_chat.id == chat.id
  if (senderChat && senderChat.id === chatId) {
    return true;
  }

  if (!from) return false;
  return await isAdmin(chatId, from.id, env);
}

async function isAdmin(chatId: number, userId: number, env: Env): Promise<boolean> {
  try {
    const res = await tgCall("getChatMember", env, {
      chat_id: chatId,
      user_id: userId
    });
    if (!res || res.ok === false) return false;
    const status = res.result.status as string;
    return status === "creator" || status === "administrator";
  } catch {
    return false;
  }
}

// ====== Telegram API helpers ======

async function tgCall(
  method: string,
  env: Env,
  body: Record<string, unknown>
): Promise<any> {
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

async function sendText(
  chatId: number | string,
  text: string,
  env: Env,
  extra?: Record<string, unknown>
): Promise<{ message_id: number } | null> {
  const res = await tgCall("sendMessage", env, {
    chat_id: chatId,
    text,
    ...(extra || {})
  });
  if (res && res.ok) {
    return { message_id: res.result.message_id as number };
  }
  return null;
}

async function deleteMessage(chatId: number, messageId: number, env: Env): Promise<void> {
  await tgCall("deleteMessage", env, {
    chat_id: chatId,
    message_id: messageId
  });
}

async function muteUser(chatId: number, userId: number, minutes: number, env: Env): Promise<void> {
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

async function unmuteUser(chatId: number, userId: number, env: Env): Promise<void> {
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

// ====== Misc helpers ======

function displayName(user: TelegramUser): string {
  if (user.username) return `@${user.username}`;
  const fullName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  if (fullName) return fullName;
  return `${user.id}`;
}

function parseDuration(arg: string | undefined): number {
  // minutes; default 24h
  if (!arg) return 24 * 60;
  const m = arg.match(/^(\d+)([smhd])$/i);
  if (!m) return 24 * 60;

  const value = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();

  if (unit === "s") return Math.max(1, Math.round(value / 60));
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  if (unit === "d") return value * 60 * 24;
  return 24 * 60;
}

function parseDurationSeconds(arg: string | undefined): number {
  // seconds; default 60s
  if (!arg) return 60;
  const m = arg.match(/^(\d+)([smhd])$/i);
  if (!m) return 60;

  const value = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();

  if (unit === "s") return value;
  if (unit === "m") return value * 60;
  if (unit === "h") return value * 60 * 60;
  if (unit === "d") return value * 60 * 60 * 24;
  return 60;
}

function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase();
  if (!d) return null;
  if (d.startsWith("http://") || d.startsWith("https://")) {
    try {
      const u = new URL(d);
      d = u.hostname.toLowerCase();
    } catch {
      // fall back
    }
  }
  if (d.startsWith("www.")) d = d.slice(4);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
  return d;
}
