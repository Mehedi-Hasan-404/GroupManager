const TG_API_BASE = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  BOT_CONFIG: KVNamespace;
  OWNER_USER_IDS?: string;
}

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel" | string;
  title?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  sender_chat?: TgChat;
  chat: TgChat;
  date?: number;

  text?: string;
  caption?: string;

  // reply
  reply_to_message?: TgMessage;

  // join / leave
  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;

  // forwards / stories
  is_automatic_forward?: boolean;
  forward_from?: TgUser;
  forward_from_chat?: TgChat;
  forward_from_message_id?: number;
  forward_date?: number;
  // story / forward_origin exist in recent Bot API; we keep as any
  [k: string]: any;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  my_chat_member?: any;
  chat_member?: any;
}

interface GroupSettings {
  antilink: boolean;
  antiforward: boolean;
  whitelist: string[];
  autoDeleteJoin: boolean;
  autoDeleteLeave: boolean;
  warnThreshold: number;
  autoMuteMinutes: number;
  botMsgTtlSeconds: number;
}

const DEFAULT_SETTINGS: GroupSettings = {
  antilink: true,
  antiforward: true,
  whitelist: [],
  autoDeleteJoin: true,
  autoDeleteLeave: true,
  warnThreshold: 3,
  autoMuteMinutes: 30,
  botMsgTtlSeconds: 300
};

const WARN_PREFIX = "warn:";
const GROUP_SETTINGS_PREFIX = "g:";
const GROUP_META_PREFIX = "meta:";
const DEL_PREFIX = "del:";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("OK");
    }

    let update: TgUpdate | null = null;
    try {
      update = await request.json<TgUpdate>();
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

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(env));
  }
};

function parseOwners(env: Env): Set<string> {
  const raw = env.OWNER_USER_IDS || "";
  return new Set(
    raw
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(Boolean)
  );
}

function isOwnerOrAllowed(env: Env, msg: TgMessage): boolean {
  const owners = parseOwners(env);
  const idsToCheck: string[] = [];

  if (msg.from) idsToCheck.push(String(msg.from.id));
  if (msg.sender_chat) idsToCheck.push(String(msg.sender_chat.id));

  for (const id of idsToCheck) {
    if (owners.has(id)) return true;
  }
  return false;
}

async function handleMessage(message: TgMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const chatIdStr = String(chat.id);

  if (chat.type === "private") {
    await handlePrivateMessage(message, env);
    return;
  }

  await storeGroupMeta(chat, env);

  const settings = await getGroupSettings(chat.id, env);

  if (settings.autoDeleteJoin && message.new_chat_members && message.new_chat_members.length > 0) {
    await deleteMessage(chatIdStr, message.message_id, env);
    return;
  }

  if (settings.autoDeleteLeave && message.left_chat_member) {
    await deleteMessage(chatIdStr, message.message_id, env);
    return;
  }

  const text = message.text || message.caption || "";

  if (text.startsWith("/")) {
    await handleGroupCommand(message, settings, env);
    return;
  }

  const user = message.from;
  if (!user) return;

  if (settings.antiforward && isForwarded(message)) {
    await deleteMessage(chatIdStr, message.message_id, env);
    await handleViolation(chat.id, user.id, "forward", env, message);
    return;
  }

  if (settings.antilink && containsForbiddenLink(text, settings.whitelist)) {
    await deleteMessage(chatIdStr, message.message_id, env);
    await handleViolation(chat.id, user.id, "link", env, message);
    return;
  }
}

async function handleMyChatMember(update: any, env: Env): Promise<void> {
  try {
    const chat: TgChat = update.chat;
    const newStatus: string = update.new_chat_member?.status;
    const oldStatus: string = update.old_chat_member?.status;

    if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;

    const chatIdStr = String(chat.id);
    const key = GROUP_META_PREFIX + chatIdStr;

    if (newStatus === "kicked" || newStatus === "left") {
      await env.BOT_CONFIG.delete(key);
      const settingsKey = GROUP_SETTINGS_PREFIX + chatIdStr + ":settings";
      await env.BOT_CONFIG.delete(settingsKey);
      return;
    }

    if (newStatus === "member" || newStatus === "administrator") {
      const meta = {
        id: chat.id,
        title: chat.title || "",
        lastSeen: Date.now(),
        active: true
      };
      await env.BOT_CONFIG.put(key, JSON.stringify(meta));
    }

    if (oldStatus === "member" && newStatus === "administrator") {
      const metaStr = await env.BOT_CONFIG.get(key);
      if (metaStr) {
        const meta = JSON.parse(metaStr);
        meta.lastSeen = Date.now();
        meta.active = true;
        await env.BOT_CONFIG.put(key, JSON.stringify(meta));
      }
    }
  } catch {
    return;
  }
}

function containsForbiddenLink(text: string, whitelist: string[]): boolean {
  const lower = text.toLowerCase();
  const hasLink =
    /https?:\/\/\S+/i.test(text) ||
    /www\.\S+\.\S+/i.test(text) ||
    /\b[\w-]+\.(com|net|org|io|gg|xyz|info|biz|co|me|app|online|shop|live)(\/\S*)?/i.test(text) ||
    /t\.me\/\S+/i.test(text) ||
    /telegram\.me\/\S+/i.test(text) ||
    /\bdiscord\.gg\/\S+/i.test(text);

  if (!hasLink) return false;

  for (const domain of whitelist) {
    const d = domain.toLowerCase().trim();
    if (!d) continue;
    if (lower.includes(d)) {
      return false;
    }
  }

  return true;
}

function isForwarded(msg: TgMessage): boolean {
  if (msg.is_automatic_forward) return true;
  if (msg.forward_from || msg.forward_from_chat || msg.forward_from_message_id || msg.forward_date)
    return true;
  if ((msg as any).forward_origin) return true;
  if ((msg as any).story) return true;
  return false;
}

async function getGroupSettings(chatId: number, env: Env): Promise<GroupSettings> {
  const key = GROUP_SETTINGS_PREFIX + String(chatId) + ":settings";
  const raw = await env.BOT_CONFIG.get(key);
  if (!raw) return { ...DEFAULT_SETTINGS };

  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveGroupSettings(chatId: number, settings: GroupSettings, env: Env): Promise<void> {
  const key = GROUP_SETTINGS_PREFIX + String(chatId) + ":settings";
  await env.BOT_CONFIG.put(key, JSON.stringify(settings));
}

async function storeGroupMeta(chat: TgChat, env: Env): Promise<void> {
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  const key = GROUP_META_PREFIX + String(chat.id);
  const meta = {
    id: chat.id,
    title: chat.title || "",
    lastSeen: Date.now(),
    active: true
  };
  await env.BOT_CONFIG.put(key, JSON.stringify(meta));
}

async function handleViolation(
  chatId: number,
  userId: number,
  reason: "link" | "forward" | "manual",
  env: Env,
  contextMessage: TgMessage
): Promise<void> {
  const settings = await getGroupSettings(chatId, env);
  const warnKey = WARN_PREFIX + String(chatId) + ":" + String(userId);

  const current = (await env.BOT_CONFIG.get(warnKey)) || "0";
  const count = parseInt(current, 10) || 0;
  const newCount = count + 1;

  await env.BOT_CONFIG.put(warnKey, String(newCount));

  const chatIdStr = String(chatId);

  const reasonText =
    reason === "link"
      ? "sending links"
      : reason === "forward"
      ? "forwarding messages/stories"
      : "breaking the rules";

  const warnText = `⚠️ Warning ${newCount}/${settings.warnThreshold} for user ${userId} (${reasonText}).`;

  await sendEphemeralText(chatIdStr, warnText, settings.botMsgTtlSeconds, env);

  if (newCount >= settings.warnThreshold) {
    await muteUser(chatIdStr, userId, settings.autoMuteMinutes, env);
    await env.BOT_CONFIG.put(warnKey, "0");

    const muteText = `🔇 User ${userId} has been muted for ${settings.autoMuteMinutes} minutes after ${settings.warnThreshold} warnings (${reasonText}).`;
    await sendEphemeralText(chatIdStr, muteText, settings.botMsgTtlSeconds, env);
  }
}

async function handlePrivateMessage(message: TgMessage, env: Env): Promise<void> {
  const user = message.from;
  if (!user) return;
  const chatIdStr = String(message.chat.id);
  const isOwner = isOwnerOrAllowed(env, message);

  const text = message.text || "";

  if (!isOwner) {
    if (text.startsWith("/start")) {
      await sendText(
        chatIdStr,
        "This bot is restricted. Only the configured owner(s) can manage settings.\nYou can still use it in groups for moderation.",
        env
      );
    } else {
      await sendText(
        chatIdStr,
        "This bot is restricted. Only the configured owner(s) can manage settings from private chat.",
        env
      );
    }
    return;
  }

  const [cmdRaw, ...args] = text.split(" ");
  const cmd = cmdRaw.split("@")[0];

  switch (cmd) {
    case "/start":
    case "/help": {
      const help = [
        "👋 Bot is ready. Only owner IDs can manage settings.",
        "",
        "PM commands:",
        "/groups – List groups I know",
        "/settings <group_id> – Show settings for a group",
        "/status <group_id> – Show filters for a group",
        "/set <group_id> <key> <value> – Change a setting",
        "   keys: antilink, antiforward, joinclean, leaveclean, warnthreshold, automutemin, ttl",
        "/whitelist <group_id> add <domain>",
        "/whitelist <group_id> remove <domain>",
        "/whitelist <group_id> list",
        "",
        "Group commands:",
        "/status – show group filters",
        "/mute <time> (reply) – mute user (10s/10m/1h/1d/1d etc)",
        "/unmute (reply) – unmute user",
        "/warn (reply) – manual warn",
        "/del <time> (reply) – delete that message after a delay"
      ].join("\n");
      await sendText(chatIdStr, help, env);
      break;
    }

    case "/groups": {
      const groups = await listGroups(env);
      if (groups.length === 0) {
        await sendText(chatIdStr, "No groups recorded yet. Add me to a group as admin.", env);
        return;
      }
      const lines = groups.map(
        g =>
          `• ${g.title || "(no title)"} – ID: ${g.id} – ${g.active ? "active" : "left/removed"}`
      );
      await sendText(chatIdStr, "Groups I know:\n\n" + lines.join("\n"), env);
      break;
    }

    case "/settings": {
      const gid = args[0];
      if (!gid) {
        await sendText(chatIdStr, "Usage: /settings <group_id>", env);
        return;
      }
      const groupId = Number(gid);
      const settings = await getGroupSettings(groupId, env);
      const meta = await getGroupMeta(groupId, env);

      const lines = [
        `Settings for group ${meta?.title || ""} (ID: ${groupId}):`,
        `antilink: ${settings.antilink}`,
        `antiforward: ${settings.antiforward}`,
        `joinclean: ${settings.autoDeleteJoin}`,
        `leaveclean: ${settings.autoDeleteLeave}`,
        `warnThreshold: ${settings.warnThreshold}`,
        `autoMuteMinutes: ${settings.autoMuteMinutes}`,
        `botMsgTtlSeconds: ${settings.botMsgTtlSeconds}`,
        `whitelist: ${settings.whitelist.length ? settings.whitelist.join(", ") : "(none)"}`
      ];

      await sendText(chatIdStr, lines.join("\n"), env);
      break;
    }

    case "/status": {
      const gid = args[0];
      if (!gid) {
        await sendText(chatIdStr, "Usage: /status <group_id>", env);
        return;
      }
      const groupId = Number(gid);
      const settings = await getGroupSettings(groupId, env);
      const line = `Status for group ${groupId} – antilink: ${settings.antilink}, antiforward: ${settings.antiforward}, joinclean: ${settings.autoDeleteJoin}, leaveclean: ${settings.autoDeleteLeave}`;
      await sendText(chatIdStr, line, env);
      break;
    }

    case "/set": {
      const gid = args[0];
      const key = (args[1] || "").toLowerCase();
      const valueRaw = args[2];

      if (!gid || !key || !valueRaw) {
        await sendText(
          chatIdStr,
          "Usage: /set <group_id> <key> <value>\nKeys: antilink, antiforward, joinclean, leaveclean, warnthreshold, automutemin, ttl",
          env
        );
        return;
      }

      const groupId = Number(gid);
      const settings = await getGroupSettings(groupId, env);

      const valueLower = valueRaw.toLowerCase();

      if (key === "antilink" || key === "antiforward" || key === "joinclean" || key === "leaveclean") {
        const boolVal = valueLower === "on" || valueLower === "true" || valueLower === "1";
        if (key === "antilink") settings.antilink = boolVal;
        if (key === "antiforward") settings.antiforward = boolVal;
        if (key === "joinclean") settings.autoDeleteJoin = boolVal;
        if (key === "leaveclean") settings.autoDeleteLeave = boolVal;
      } else if (key === "warnthreshold") {
        const n = parseInt(valueRaw, 10);
        if (!isNaN(n) && n > 0) settings.warnThreshold = n;
      } else if (key === "automutemin") {
        const n = parseInt(valueRaw, 10);
        if (!isNaN(n) && n > 0) settings.autoMuteMinutes = n;
      } else if (key === "ttl") {
        const n = parseInt(valueRaw, 10);
        if (!isNaN(n) && n >= 0) settings.botMsgTtlSeconds = n;
      } else {
        await sendText(chatIdStr, "Unknown key. Allowed: antilink, antiforward, joinclean, leaveclean, warnthreshold, automutemin, ttl", env);
        return;
      }

      await saveGroupSettings(groupId, settings, env);
      await sendText(chatIdStr, "Updated. Use /settings " + groupId + " to see new values.", env);
      break;
    }

    case "/whitelist": {
      const gid = args[0];
      const sub = (args[1] || "").toLowerCase();

      if (!gid || !sub) {
        await sendText(
          chatIdStr,
          "Usage: /whitelist <group_id> list | add <domain> | remove <domain>",
          env
        );
        return;
      }

      const groupId = Number(gid);
      const settings = await getGroupSettings(groupId, env);

      if (sub === "list") {
        const text =
          settings.whitelist.length === 0
            ? "No whitelisted domains."
            : "Whitelisted domains:\n" + settings.whitelist.join("\n");
        await sendText(chatIdStr, text, env);
      } else if (sub === "add") {
        const domain = args[2];
        if (!domain) {
          await sendText(chatIdStr, "Usage: /whitelist <group_id> add <domain>", env);
          return;
        }
        if (!settings.whitelist.includes(domain)) {
          settings.whitelist.push(domain);
          await saveGroupSettings(groupId, settings, env);
        }
        await sendText(chatIdStr, `Added to whitelist: ${domain}`, env);
      } else if (sub === "remove") {
        const domain = args[2];
        if (!domain) {
          await sendText(chatIdStr, "Usage: /whitelist <group_id> remove <domain>", env);
          return;
        }
        settings.whitelist = settings.whitelist.filter(d => d !== domain);
        await saveGroupSettings(groupId, settings, env);
        await sendText(chatIdStr, `Removed from whitelist: ${domain}`, env);
      } else {
        await sendText(
          chatIdStr,
          "Usage: /whitelist <group_id> list | add <domain> | remove <domain>",
          env
        );
      }
      break;
    }

    default:
      break;
  }
}

async function listGroups(env: Env): Promise<{ id: number; title: string; active: boolean }[]> {
  const out: { id: number; title: string; active: boolean }[] = [];
  let cursor: string | undefined = undefined;

  do {
    const list = await env.BOT_CONFIG.list({ prefix: GROUP_META_PREFIX, cursor });
    cursor = list.cursor;
    for (const k of list.keys) {
      const raw = await env.BOT_CONFIG.get(k.name);
      if (!raw) continue;
      try {
        const meta = JSON.parse(raw);
        out.push({
          id: meta.id,
          title: meta.title || "",
          active: !!meta.active
        });
      } catch {
        continue;
      }
    }
  } while (cursor);

  return out;
}

async function getGroupMeta(groupId: number, env: Env): Promise<{ id: number; title: string; active: boolean } | null> {
  const key = GROUP_META_PREFIX + String(groupId);
  const raw = await env.BOT_CONFIG.get(key);
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw);
    return {
      id: meta.id,
      title: meta.title || "",
      active: !!meta.active
    };
  } catch {
    return null;
  }
}

async function handleGroupCommand(message: TgMessage, settings: GroupSettings, env: Env): Promise<void> {
  const chat = message.chat;
  const chatIdStr = String(chat.id);
  const text = message.text || "";
  const user = message.from;

  if (!isOwnerOrAllowed(env, message)) return;

  const [cmdRaw, ...args] = text.split(" ");
  const cmd = cmdRaw.split("@")[0];

  switch (cmd) {
    case "/status": {
      const line = `Status – antilink: ${settings.antilink}, antiforward: ${settings.antiforward}, joinclean: ${settings.autoDeleteJoin}, leaveclean: ${settings.autoDeleteLeave}`;
      const msg = await sendTextWithResult(chatIdStr, line, env);
      if (msg) {
        await scheduleDeletion(chatIdStr, msg.message_id, settings.botMsgTtlSeconds, env);
      }
      break;
    }

    case "/mute": {
      if (!message.reply_to_message || !message.reply_to_message.from) return;
      const target = message.reply_to_message.from;
      const duration = parseDuration(args[0] || "24h");
      await muteUser(chatIdStr, target.id, duration, env);
      const m = await sendTextWithResult(
        chatIdStr,
        `🔇 Muted ${displayName(target)} for ${args[0] || "24h"}.`,
        env
      );
      if (m) {
        await scheduleDeletion(chatIdStr, m.message_id, settings.botMsgTtlSeconds, env);
      }
      break;
    }

    case "/unmute": {
      if (!message.reply_to_message || !message.reply_to_message.from) return;
      const target = message.reply_to_message.from;
      await unmuteUser(chatIdStr, target.id, env);
      const m = await sendTextWithResult(
        chatIdStr,
        `🔊 Unmuted ${displayName(target)}.`,
        env
      );
      if (m) {
        await scheduleDeletion(chatIdStr, m.message_id, settings.botMsgTtlSeconds, env);
      }
      break;
    }

    case "/warn": {
      if (!message.reply_to_message || !message.reply_to_message.from) return;
      const target = message.reply_to_message.from;
      await handleViolation(chat.id, target.id, "manual", env, message);
      break;
    }

    case "/del": {
      if (!message.reply_to_message) return;
      const targetMsgId = message.reply_to_message.message_id;
      const delay = parseDuration(args[0] || "10s");

      await scheduleDeletion(chatIdStr, targetMsgId, delay, env);

      const info = await sendTextWithResult(
        chatIdStr,
        `🗑️ This message and the replied one will be deleted after ${args[0] || "10s"}.`,
        env
      );
      if (info) {
        await scheduleDeletion(chatIdStr, info.message_id, delay, env);
      }

      break;
    }

    default:
      break;
  }
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return 24 * 60;
  const value = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === "s") return Math.max(1, Math.floor(value / 60)) || 1;
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  if (unit === "d") return value * 60 * 24;
  return 24 * 60;
}

async function muteUser(chatId: string, userId: number, minutes: number, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const until = now + minutes * 60;

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
    until_date: until
  });
}

async function unmuteUser(chatId: string, userId: number, env: Env): Promise<void> {
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

async function sendText(chatId: string, text: string, env: Env): Promise<void> {
  await tgCall("sendMessage", env, {
    chat_id: chatId,
    text
  });
}

async function sendTextWithResult(
  chatId: string,
  text: string,
  env: Env
): Promise<{ message_id: number } | null> {
  const res = await tgCall("sendMessage", env, {
    chat_id: chatId,
    text
  });
  if (res && res.ok && res.result && typeof res.result.message_id === "number") {
    return { message_id: res.result.message_id };
  }
  return null;
}

async function sendEphemeralText(
  chatId: string,
  text: string,
  ttlSeconds: number,
  env: Env
): Promise<void> {
  if (ttlSeconds <= 0) {
    await sendText(chatId, text, env);
    return;
  }
  const msg = await sendTextWithResult(chatId, text, env);
  if (msg) {
    await scheduleDeletion(chatId, msg.message_id, ttlSeconds / 60, env);
  }
}

async function deleteMessage(chatId: string, messageId: number, env: Env): Promise<void> {
  await tgCall("deleteMessage", env, {
    chat_id: chatId,
    message_id: messageId
  });
}

async function scheduleDeletion(
  chatId: string,
  messageId: number,
  minutesFromNow: number,
  env: Env
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const delaySeconds = Math.max(1, minutesFromNow * 60);
  const when = now + delaySeconds;
  const key = `${DEL_PREFIX}${when}:${chatId}:${messageId}`;
  await env.BOT_CONFIG.put(key, "1");
}

async function handleCron(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let cursor: string | undefined = undefined;

  do {
    const list = await env.BOT_CONFIG.list({ prefix: DEL_PREFIX, cursor });
    cursor = list.cursor;

    for (const k of list.keys) {
      const key = k.name;
      const parts = key.split(":");
      if (parts.length < 4) continue;
      const ts = parseInt(parts[1], 10);
      const chatId = parts[2];
      const msgId = parseInt(parts[3], 10);
      if (isNaN(ts) || isNaN(msgId)) continue;

      if (ts <= now) {
        await deleteMessage(chatId, msgId, env);
        await env.BOT_CONFIG.delete(key);
      }
    }
  } while (cursor);
}

async function tgCall(method: string, env: Env, body: Record<string, unknown>): Promise<any> {
  const url = `${TG_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  let data: any = null;
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

function displayName(user: TgUser): string {
  if (user.username) return `@${user.username}`;
  const full = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  if (full) return full;
  return String(user.id);
}
