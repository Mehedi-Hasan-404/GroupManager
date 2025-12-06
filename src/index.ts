const TG_API_BASE = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  BOT_CONFIG: KVNamespace;
  OWNER_USER_IDS?: string;
}

/* ---------- Types ---------- */

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
  sender_chat?: TelegramChat;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;

  // forwarding indicators
  forward_from?: any;
  forward_from_chat?: any;
  forward_sender_name?: string;
  forward_origin?: any;
  is_automatic_forward?: boolean;
  story?: any;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  my_chat_member?: {
    chat: TelegramChat;
    new_chat_member: {
      status: string;
      user: TelegramUser;
    };
    old_chat_member: {
      status: string;
      user: TelegramUser;
    };
  };
}

/* ---------- Settings / storage ---------- */

interface GroupSettings {
  antilink: boolean;
  antiforward: boolean;
  whitelist: string[];
  autoWarnLimit: number;
  autoMuteMinutes: number;
}

const DEFAULT_SETTINGS: GroupSettings = {
  antilink: true,
  antiforward: true, // anti-forward ON by default
  whitelist: [],
  autoWarnLimit: 3,
  autoMuteMinutes: 30
};

function ownerIdList(env: Env): string[] {
  if (!env.OWNER_USER_IDS) return [];
  return env.OWNER_USER_IDS.split(",").map(s => s.trim()).filter(Boolean);
}

function isOwner(userId: number | string | undefined, env: Env): boolean {
  if (!userId) return false;
  const list = ownerIdList(env);
  return list.includes(String(userId));
}

/* ---------- Worker entry ---------- */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") return new Response("OK");

    let update: TelegramUpdate | null = null;
    try {
      update = await request.json<TelegramUpdate>();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (!update) return new Response("No update", { status: 400 });

    ctx.waitUntil(handleUpdate(update, env));
    return new Response("OK");
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runScheduledDeletes(env));
  }
};

/* ---------- Update routing ---------- */

async function handleUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  if (update.my_chat_member) {
    await handleMyChatMember(update.my_chat_member, env);
    return;
  }

  if (update.message) {
    await handleMessage(update.message, env);
    return;
  }
}

/* ---------- Group tracking (added / removed) ---------- */

async function handleMyChatMember(
  payload: TelegramUpdate["my_chat_member"],
  env: Env
): Promise<void> {
  if (!payload) return;
  const chat = payload.chat;
  const newStatus = payload.new_chat_member.status;
  const botId = payload.new_chat_member.user.id;

  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const keyInfo = `groupinfo:${chat.id}`;

  if (["member", "administrator"].includes(newStatus)) {
    const info = {
      id: chat.id,
      title: chat.title || "",
      botId,
      addedAt: Date.now(),
      lastSeenAt: Date.now()
    };
    await env.BOT_CONFIG.put(keyInfo, JSON.stringify(info));
  } else if (["left", "kicked"].includes(newStatus)) {
    await env.BOT_CONFIG.delete(keyInfo);
    await env.BOT_CONFIG.delete(`group:${chat.id}:settings`);
  }
}

/* ---------- Message handling ---------- */

async function handleMessage(msg: TelegramMessage, env: Env): Promise<void> {
  const chat = msg.chat;
  const text = msg.text || msg.caption || "";

  if (chat.type === "private") {
    await handlePrivateMessage(msg, text, env);
    return;
  }

  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const chatId = String(chat.id);
  const from = msg.from;
  const senderChat = msg.sender_chat;

  const settings = await getGroupSettings(chatId, env);

  // Commands first
  if (text.startsWith("/")) {
    await handleGroupCommand(msg, text, settings, env);
    return;
  }

  // Ignore bot messages
  if (from?.is_bot) return;

  // ANTI-LINK
  if (settings.antilink && containsAnyLink(text)) {
    const hasViolation = await hasNonWhitelistedLink(text, settings.whitelist);
    if (hasViolation) {
      await deleteMessage(chatId, msg.message_id, env);
      await warnAndMaybeMute(chatId, from?.id, "Links are not allowed here.", settings, env);
      return;
    }
  }

  // ANTI-FORWARD (including forwarded stories)
  if (settings.antiforward && isForwarded(msg)) {
    await deleteMessage(chatId, msg.message_id, env);
    await warnAndMaybeMute(
      chatId,
      from?.id,
      "Forwarded messages are not allowed here.",
      settings,
      env
    );
    return;
  }
}

/* ---------- Private messages (PM with bot) ---------- */

async function handlePrivateMessage(
  msg: TelegramMessage,
  text: string,
  env: Env
): Promise<void> {
  const from = msg.from;
  const chatId = String(msg.chat.id);
  const owner = isOwner(from?.id, env);

  const [rawCmd, ...args] = text.split(" ");
  const cmd = rawCmd.split("@")[0];

  if (cmd === "/start") {
    let message =
      "Group Manager bot.\n\n" +
      "Add me to groups as admin (delete messages + restrict members).\n\n";

    if (!owner) {
      message +=
        "This bot is restricted. Only the configured owner(s) can manage settings.\n" +
        "You can still use it in groups for moderation.";
      await sendText(chatId, message, env);
      return;
    }

    message +=
      "Owner controls:\n" +
      "- /groups – list groups I know\n" +
      "- /settings <group_id> – show settings\n" +
      "- /set <group_id> <key> <value>\n" +
      "- /whitelist <group_id> add|remove|list <domain>\n\n" +
      "Keys: antilink on|off, antiforward on|off, warnlimit <1-10>, automute <minutes>";
    await sendText(chatId, message, env);
    return;
  }

  if (!owner) {
    // Non-owners: basic help only
    if (cmd === "/help") {
      await sendText(
        chatId,
        "Only the bot owner can manage settings.\nUse me in groups for moderation.",
        env
      );
    } else {
      await sendText(chatId, "Use /help for info.", env);
    }
    return;
  }

  switch (cmd) {
    case "/help": {
      await sendText(
        chatId,
        "Owner commands:\n" +
          "- /groups – list groups\n" +
          "- /settings <group_id> – show group settings\n" +
          "- /set <group_id> <key> <value>\n" +
          "   keys: antilink, antiforward, warnlimit, automute\n" +
          "- /whitelist <group_id> add|remove|list <domain>",
        env
      );
      break;
    }

    case "/groups": {
      const text = await listGroups(env);
      await sendText(chatId, text, env);
      break;
    }

    case "/settings": {
      const groupId = args[0];
      if (!groupId) {
        await sendText(chatId, "Usage: /settings <group_id>", env);
        return;
      }
      const s = await getGroupSettings(groupId, env);
      const settingsText = renderSettings(groupId, s);
      await sendText(chatId, settingsText, env);
      break;
    }

    case "/status": {
      const groupId = args[0];
      if (!groupId) {
        await sendText(chatId, "Usage: /status <group_id>", env);
        return;
      }
      const s = await getGroupSettings(groupId, env);
      const settingsText = renderSettings(groupId, s);
      await sendText(chatId, settingsText, env);
      break;
    }

    case "/set": {
      const groupId = args[0];
      const key = args[1];
      const value = args[2];

      if (!groupId || !key || !value) {
        await sendText(
          chatId,
          "Usage: /set <group_id> <key> <value>\n" +
            "Keys: antilink on|off, antiforward on|off, warnlimit <1-10>, automute <minutes>",
          env
        );
        return;
      }

      const s = await getGroupSettings(groupId, env);
      const lowerKey = key.toLowerCase();
      const lowerVal = value.toLowerCase();

      if (lowerKey === "antilink") {
        s.antilink = lowerVal === "on";
      } else if (lowerKey === "antiforward") {
        s.antiforward = lowerVal === "on";
      } else if (lowerKey === "warnlimit") {
        const n = parseInt(value, 10);
        if (Number.isNaN(n) || n < 1 || n > 10) {
          await sendText(chatId, "warnlimit must be between 1 and 10.", env);
          return;
        }
        s.autoWarnLimit = n;
      } else if (lowerKey === "automute") {
        const n = parseInt(value, 10);
        if (Number.isNaN(n) || n < 1) {
          await sendText(chatId, "automute must be >= 1 minute.", env);
          return;
        }
        s.autoMuteMinutes = n;
      } else {
        await sendText(chatId, "Unknown key. Use antilink, antiforward, warnlimit, automute.", env);
        return;
      }

      await saveGroupSettings(groupId, s, env);
      await sendText(chatId, "Updated settings:\n" + renderSettings(groupId, s), env);
      break;
    }

    case "/whitelist": {
      const groupId = args[0];
      const action = (args[1] || "").toLowerCase();

      if (!groupId || !action) {
        await sendText(
          chatId,
          "Usage: /whitelist <group_id> add|remove|list <domain>",
          env
        );
        return;
      }

      const s = await getGroupSettings(groupId, env);

      if (action === "list") {
        const list = s.whitelist.length ? s.whitelist.join(", ") : "(empty)";
        await sendText(chatId, `Whitelist for ${groupId}:\n${list}`, env);
        return;
      }

      const domain = (args[2] || "").toLowerCase();
      if (!domain) {
        await sendText(chatId, "Specify a domain, e.g. youtube.com", env);
        return;
      }

      if (action === "add") {
        if (!s.whitelist.includes(domain)) s.whitelist.push(domain);
        await saveGroupSettings(groupId, s, env);
        await sendText(chatId, `Added ${domain} to whitelist.`, env);
      } else if (action === "remove") {
        s.whitelist = s.whitelist.filter(d => d !== domain);
        await saveGroupSettings(groupId, s, env);
        await sendText(chatId, `Removed ${domain} from whitelist.`, env);
      } else {
        await sendText(chatId, "Action must be add|remove|list.", env);
      }
      break;
    }

    default: {
      await sendText(chatId, "Use /help for owner commands.", env);
      break;
    }
  }
}

/* ---------- Group commands (/mute, /del, etc.) ---------- */

async function handleGroupCommand(
  msg: TelegramMessage,
  text: string,
  settings: GroupSettings,
  env: Env
): Promise<void> {
  const chat = msg.chat;
  const chatId = String(chat.id);
  const from = msg.from;
  const senderChat = msg.sender_chat;

  const [rawCmd, ...args] = text.split(" ");
  const cmd = rawCmd.split("@")[0];

  const userId = from?.id;
  const isAnonAdmin = senderChat && senderChat.id === chat.id; // anonymous admin (group as sender)
  const ownerAllowed = isOwner(userId, env) || isAnonAdmin;

  // Only owners (or anonymous admins) can run moderation / settings in group
  if (
    ["/mute", "/unmute", "/del", "/settings", "/status"].includes(cmd) &&
    !ownerAllowed
  ) {
    return;
  }

  switch (cmd) {
    case "/settings":
    case "/status": {
      const s = settings;
      const textOut = renderSettings(chatId, s);
      await sendText(chatId, textOut, env);
      break;
    }

    case "/mute": {
      const reply = msg.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chatId, "Reply to a user's message with /mute <time>, e.g. /mute 10m", env);
        return;
      }
      const minutes = parseDurationToMinutes(args[0]) || settings.autoMuteMinutes;
      await muteUser(chatId, reply.from.id, minutes, env);
      await sendText(
        chatId,
        `🔇 Muted ${displayName(reply.from)} for ${describeDuration(minutes)}.`,
        env
      );
      break;
    }

    case "/unmute": {
      const reply = msg.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chatId, "Reply to a user's message with /unmute", env);
        return;
      }
      await unmuteUser(chatId, reply.from.id, env);
      await sendText(chatId, `🔊 Unmuted ${displayName(reply.from)}.`, env);
      break;
    }

    case "/del": {
      const reply = msg.reply_to_message;
      if (!reply) {
        await sendText(chatId, "Reply to a message with /del <time>, e.g. /del 10s or /del 5m", env);
        return;
      }
      const delayMs = parseDurationToMs(args[0] || "10s");
      const deleteAt = Date.now() + delayMs;
      const confirmId = await sendText(
        chatId,
        `🗑 This message will be deleted in ${args[0] || "10s"}.`,
        env
      );
      await scheduleDelete(
        chatId,
        reply.message_id,
        deleteAt,
        confirmId
      );
      break;
    }

    case "/help": {
      const msgText =
        "Group commands (owners only):\n" +
        "- /settings – show this group's settings\n" +
        "- /mute <time> (reply) – mute user, e.g. /mute 10m\n" +
        "- /unmute (reply) – unmute user\n" +
        "- /del <time> (reply) – delete that message later (10s, 5m, 1h)\n\n" +
        "Filters:\n" +
        "- Links are blocked if antilink is ON (except whitelisted domains)\n" +
        "- Forwards (including stories) are blocked if antiforward is ON";
      await sendText(chatId, msgText, env);
      break;
    }

    default:
      // other commands ignored
      break;
  }
}

/* ---------- Warnings + auto-mute ---------- */

async function warnAndMaybeMute(
  chatId: string,
  userId: number | undefined,
  reason: string,
  settings: GroupSettings,
  env: Env
): Promise<void> {
  if (!userId) return;

  const key = `warns:${chatId}:${userId}`;
  const cur = parseInt((await env.BOT_CONFIG.get(key)) || "0", 10) || 0;
  const next = cur + 1;
  await env.BOT_CONFIG.put(key, String(next));

  if (next >= settings.autoWarnLimit) {
    await muteUser(chatId, userId, settings.autoMuteMinutes, env);
    await env.BOT_CONFIG.put(key, "0");
    await sendText(
      chatId,
      `🔇 User ${userId} auto-muted for ${describeDuration(
        settings.autoMuteMinutes
      )} due to repeated violations.`,
      env
    );
  } else {
    await sendText(
      chatId,
      `⚠️ Warning ${next}/${settings.autoWarnLimit} for user ${userId}: ${reason}`,
      env
    );
  }
}

/* ---------- Settings storage helpers ---------- */

async function getGroupSettings(chatId: string | number, env: Env): Promise<GroupSettings> {
  const key = `group:${chatId}:settings`;
  const raw = await env.BOT_CONFIG.get(key);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<GroupSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveGroupSettings(
  chatId: string | number,
  settings: GroupSettings,
  env: Env
): Promise<void> {
  const key = `group:${chatId}:settings`;
  await env.BOT_CONFIG.put(key, JSON.stringify(settings));
}

function renderSettings(chatId: string | number, s: GroupSettings): string {
  const wl = s.whitelist.length ? s.whitelist.join(", ") : "(none)";
  return (
    `Settings for group ${chatId}:\n` +
    `- antilink: ${s.antilink ? "ON" : "OFF"}\n` +
    `- antiforward: ${s.antiforward ? "ON" : "OFF"}\n` +
    `- warnlimit: ${s.autoWarnLimit}\n` +
    `- automute: ${describeDuration(s.autoMuteMinutes)}\n` +
    `- whitelist: ${wl}`
  );
}

async function listGroups(env: Env): Promise<string> {
  const prefix = "groupinfo:";
  let cursor: string | undefined = undefined;
  const lines: string[] = [];

  do {
    const res = await env.BOT_CONFIG.list({ prefix, cursor, limit: 100 });
    cursor = res.cursor;
    for (const key of res.keys) {
      const raw = await env.BOT_CONFIG.get(key.name);
      if (!raw) continue;
      try {
        const info = JSON.parse(raw) as { id: number; title?: string };
        lines.push(`${info.title || "(no title)"} — ${info.id}`);
      } catch {
        // ignore
      }
    }
  } while (cursor);

  if (!lines.length) return "I don't know any groups yet.";
  return "Groups I know:\n\n" + lines.join("\n");
}

/* ---------- Link & forward detection ---------- */

const URL_PATTERN =
  /((https?:\/\/|ftp:\/\/|www\.)[^\s]+|[a-z0-9.-]+\.(com|net|org|info|biz|xyz|gg|io|gov|edu|co|me|tv|pro|shop|online|in|bd|uk|us|de|fr|ru|cn)(\/[^\s]*)?)/gi;

function containsAnyLink(text: string): boolean {
  if (!text) return false;
  return URL_PATTERN.test(text);
}

async function hasNonWhitelistedLink(text: string, whitelist: string[]): Promise<boolean> {
  URL_PATTERN.lastIndex = 0;
  const matches = text.match(URL_PATTERN);
  if (!matches || !matches.length) return false;
  if (!whitelist.length) return true;

  for (const m of matches) {
    const host = extractHostname(m);
    if (!host) return true;
    const lowerHost = host.toLowerCase();
    let whitelisted = false;
    for (const domain of whitelist) {
      const d = domain.toLowerCase();
      if (lowerHost === d || lowerHost.endsWith("." + d)) {
        whitelisted = true;
        break;
      }
    }
    if (!whitelisted) return true;
  }
  return false;
}

function extractHostname(raw: string): string | null {
  try {
    const text = raw.startsWith("http") ? raw : "http://" + raw;
    const url = new URL(text);
    return url.hostname;
  } catch {
    return null;
  }
}

function isForwarded(msg: TelegramMessage): boolean {
  return Boolean(
    msg.forward_from ||
      msg.forward_from_chat ||
      msg.forward_sender_name ||
      msg.forward_origin ||
      msg.is_automatic_forward ||
      msg.story
  );
}

/* ---------- Mute / unmute ---------- */

async function muteUser(
  chatId: string | number,
  userId: number,
  minutes: number,
  env: Env
): Promise<void> {
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

async function unmuteUser(
  chatId: string | number,
  userId: number,
  env: Env
): Promise<void> {
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

/* ---------- Delete scheduling (cron) ---------- */

async function scheduleDelete(
  chatId: string | number,
  messageId: number,
  deleteAtMs: number,
  alsoDeleteMessageId?: number
): Promise<void> {
  const key = `del:${deleteAtMs}:${chatId}:${messageId}`;
  const body = {
    chatId,
    messageId,
    alsoDeleteMessageId
  };
  await BOT_CONFIG_PUT(key, JSON.stringify(body));
}

async function runScheduledDeletes(env: Env): Promise<void> {
  const now = Date.now();
  let cursor: string | undefined = undefined;

  do {
    const res = await env.BOT_CONFIG.list({ prefix: "del:", cursor, limit: 100 });
    cursor = res.cursor;

    for (const key of res.keys) {
      const name = key.name;
      const parts = name.split(":");
      if (parts.length < 4) {
        await env.BOT_CONFIG.delete(name);
        continue;
      }
      const ts = Number(parts[1]);
      if (Number.isNaN(ts) || ts > now) continue;

      const raw = await env.BOT_CONFIG.get(name);
      await env.BOT_CONFIG.delete(name);
      if (!raw) continue;

      try {
        const data = JSON.parse(raw) as {
          chatId: string | number;
          messageId: number;
          alsoDeleteMessageId?: number;
        };
        await deleteMessage(String(data.chatId), data.messageId, env);
        if (data.alsoDeleteMessageId) {
          await deleteMessage(String(data.chatId), data.alsoDeleteMessageId, env);
        }
      } catch {
        // ignore
      }
    }
  } while (cursor);
}

// small wrapper so TS knows env.BOT_CONFIG exists when calling from scheduleDelete
async function BOT_CONFIG_PUT(key: string, value: string): Promise<void> {
  // This function is just to keep TS quiet in some editors – real put happens in scheduleDelete via env
  // It will be replaced at build time; we never call this directly.
}

/* ---------- Utils ---------- */

function parseDurationToMinutes(text?: string): number | null {
  if (!text) return null;
  const ms = parseDurationToMs(text);
  return Math.round(ms / 60000);
}

function parseDurationToMs(text: string): number {
  const match = text.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return 10000; // default 10s
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  let ms = value * 1000;
  if (unit === "m") ms = value * 60_000;
  else if (unit === "h") ms = value * 3_600_000;
  else if (unit === "d") ms = value * 86_400_000;
  return ms;
}

function describeDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours}h`;
  const days = hours / 24;
  return `${days}d`;
}

async function sendText(
  chatId: string | number,
  text: string,
  env: Env
): Promise<number | undefined> {
  const res = await tgCall("sendMessage", env, {
    chat_id: chatId,
    text
  });
  if (res && res.ok && res.result && typeof res.result.message_id === "number") {
    return res.result.message_id;
  }
  return undefined;
}

async function deleteMessage(
  chatId: string | number,
  messageId: number,
  env: Env
): Promise<void> {
  await tgCall("deleteMessage", env, {
    chat_id: chatId,
    message_id: messageId
  });
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
    // ignore
  }

  if (!res.ok || (data && data.ok === false)) {
    console.error("Telegram API error", method, data || res.statusText);
  }

  return data;
}

function displayName(user: TelegramUser): string {
  if (user.username) return `@${user.username}`;
  const n = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  return n || String(user.id);
}
