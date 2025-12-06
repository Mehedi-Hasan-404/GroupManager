const TG_API_BASE = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  BOT_CONFIG: KVNamespace;
  OWNER_USER_IDS?: string; // comma-separated owner ids, e.g. "5115267657,123456789"
}

/* ========== TELEGRAM TYPES (simplified) ========== */

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

  // forwarded fields (we treat ANY of these as "forward")
  forward_from?: TelegramUser;
  forward_from_chat?: TelegramChat;
  forward_from_message_id?: number;
  forward_sender_name?: string;
  forward_date?: number;
  is_automatic_forward?: boolean;
  // newer API can have forward_origin, story, etc.; we’ll treat any forward_* as forward.
}

interface TelegramChatMemberUpdate {
  chat: TelegramChat;
  new_chat_member: {
    user: TelegramUser;
    status: string; // "member", "administrator", "left", "kicked", etc.
  };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  my_chat_member?: TelegramChatMemberUpdate;
}

/* ========== GROUP SETTINGS & QUEUES ========== */

interface GroupSettings {
  antilink: boolean;
  antiforward: boolean;
  autowarn: boolean;
  maxWarns: number;
  autoMuteMinutes: number;
  whitelist: string[];
}

interface GroupInfo {
  id: number;
  title?: string;
  type: string;
  active: boolean;
  updatedAt: number;
}

interface DelEntry {
  chat_id: string;
  message_ids: number[];
  delete_at: number; // epoch seconds
}

/* ========== DEFAULTS ========== */

function defaultSettings(): GroupSettings {
  return {
    antilink: true,
    antiforward: true,   // anti-forward ON by default (including stories)
    autowarn: true,
    maxWarns: 3,
    autoMuteMinutes: 30,
    whitelist: []
  };
}

/* ========== MAIN EXPORT ========== */

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
      ctx.waitUntil(handleMessageUpdate(update.message, env));
    } else if (update.my_chat_member) {
      ctx.waitUntil(handleMyChatMember(update.my_chat_member, env));
    }

    return new Response("OK");
  },

  async scheduled(event: any, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(env));
  }
};

/* ========== OWNER CHECK ========== */

function isOwnerId(userId: number, env: Env): boolean {
  const raw = env.OWNER_USER_IDS;
  if (!raw || !raw.trim()) {
    // If not set, no restriction (for safety in early setup)
    return true;
  }
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(String(userId));
}

/* ========== UPDATE HANDLERS ========== */

async function handleMessageUpdate(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;

  // Private chat: handle separately
  if (chat.type === "private") {
    await handlePrivateMessage(message, env);
    return;
  }

  // Group / supergroup only
  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  const chatId = String(chat.id);
  const user = message.from;

  await trackGroup(chat, env); // track / refresh group info

  const text = message.text || message.caption || "";

  // Commands first
  if (text.startsWith("/")) {
    await handleCommand(message, env, /*fromPrivate*/ false);
    return;
  }

  // no user or from bot -> ignore for moderation
  if (!user || user.is_bot) return;

  const settings = await getGroupSettings(chatId, env);

  // Anti-link
  if (settings.antilink && containsProhibitedLink(text, settings.whitelist)) {
    await deleteMessage(chatId, message.message_id, env);
    await handleRuleViolation(chatId, user.id, env, settings, "link");
    return;
  }

  // Anti-forward (including story forwards)
  if (settings.antiforward && isForwarded(message)) {
    await deleteMessage(chatId, message.message_id, env);
    await handleRuleViolation(chatId, user.id, env, settings, "forward");
    return;
  }
}

async function handlePrivateMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chatId = String(message.chat.id);
  const user = message.from;
  const text = message.text || "";

  if (!user) return;

  if (text.startsWith("/")) {
    await handleCommand(message, env, /*fromPrivate*/ true);
    return;
  }

  // Non-command in PM
  if (!isOwnerId(user.id, env)) {
    await sendText(
      chatId,
      "This bot is restricted. Only the configured owner(s) can manage settings.\nYou can still use it in groups for automatic moderation.",
      env
    );
    return;
  }

  await sendText(
    chatId,
    "Send /help to see how to list groups and change their settings.",
    env
  );
}

async function handleMyChatMember(update: TelegramChatMemberUpdate, env: Env): Promise<void> {
  const chat = update.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const status = update.new_chat_member.status;
  const key = `group:${chat.id}`;
  const now = Date.now();

  let info: GroupInfo = {
    id: chat.id,
    title: chat.title,
    type: chat.type,
    active: true,
    updatedAt: now
  };

  const existing = await env.BOT_CONFIG.get(key);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as GroupInfo;
      info = { ...parsed, title: chat.title || parsed.title, updatedAt: now };
    } catch {
      // ignore
    }
  }

  if (status === "left" || status === "kicked") {
    info.active = false;
  } else {
    info.active = true;
  }

  await env.BOT_CONFIG.put(key, JSON.stringify(info));
}

/* ========== GROUP SETTINGS STORAGE ========== */

async function getGroupSettings(chatId: string, env: Env): Promise<GroupSettings> {
  const key = `settings:${chatId}`;
  const raw = await env.BOT_CONFIG.get(key);
  if (!raw) {
    const def = defaultSettings();
    await env.BOT_CONFIG.put(key, JSON.stringify(def));
    return def;
  }
  try {
    const parsed = JSON.parse(raw) as GroupSettings;
    // ensure all fields exist
    const def = defaultSettings();
    return {
      antilink: parsed.antilink ?? def.antilink,
      antiforward: parsed.antiforward ?? def.antiforward,
      autowarn: parsed.autowarn ?? def.autowarn,
      maxWarns: parsed.maxWarns ?? def.maxWarns,
      autoMuteMinutes: parsed.autoMuteMinutes ?? def.autoMuteMinutes,
      whitelist: Array.isArray(parsed.whitelist) ? parsed.whitelist : []
    };
  } catch {
    const def = defaultSettings();
    await env.BOT_CONFIG.put(key, JSON.stringify(def));
    return def;
  }
}

async function saveGroupSettings(chatId: string, settings: GroupSettings, env: Env): Promise<void> {
  const key = `settings:${chatId}`;
  await env.BOT_CONFIG.put(key, JSON.stringify(settings));
}

/* ========== GROUP INFO STORAGE ========== */

async function trackGroup(chat: TelegramChat, env: Env): Promise<void> {
  const key = `group:${chat.id}`;
  const now = Date.now();

  const info: GroupInfo = {
    id: chat.id,
    title: chat.title,
    type: chat.type,
    active: true,
    updatedAt: now
  };

  await env.BOT_CONFIG.put(key, JSON.stringify(info));
}

async function listActiveGroups(env: Env): Promise<GroupInfo[]> {
  const groups: GroupInfo[] = [];
  let cursor: string | undefined = undefined;

  do {
    const listResult = await env.BOT_CONFIG.list({ prefix: "group:", cursor });
    cursor = listResult.cursor;
    for (const key of listResult.keys) {
      const raw = await env.BOT_CONFIG.get(key.name);
      if (!raw) continue;
      try {
        const info = JSON.parse(raw) as GroupInfo;
        if (info.active) groups.push(info);
      } catch {
        // ignore
      }
    }
  } while (cursor);

  return groups;
}

/* ========== MODERATION HELPERS ========== */

function isForwarded(message: TelegramMessage): boolean {
  return Boolean(
    message.forward_from ||
      message.forward_from_chat ||
      message.forward_from_message_id ||
      message.forward_sender_name ||
      message.forward_date ||
      message.is_automatic_forward
  );
}

function containsProhibitedLink(text: string, whitelist: string[]): boolean {
  const t = text.toLowerCase();

  const patterns: RegExp[] = [
    /\bhttps?:\/\/[^\s]+/i,                           // http:// or https://
    /\bwww\.[^\s]+\.[^\s]+/i,                         // www.example.com
    /\b(?:[a-z0-9-]+\.)+(com|net|org|io|gg|xyz|info|biz|co|me|link|live|shop|online)(\/[^\s]*)?/i,
    /t\.me\/[^\s]+/i,
    /telegram\.me\/[^\s]+/i,
    /(joinchat|invite)\/[^\s]+/i
  ];

  // If no whitelist, any detected link is prohibited
  if (!whitelist || whitelist.length === 0) {
    return patterns.some((rx) => rx.test(text));
  }

  // If whitelist exists: only block links that don't contain any whitelisted domain
  for (const rx of patterns) {
    const matches = text.match(rx);
    if (matches) {
      const matchText = matches[0].toLowerCase();
      const allowed = whitelist.some((domain) =>
        matchText.includes(domain.toLowerCase())
      );
      if (!allowed) {
        return true;
      }
    }
  }

  return false;
}

async function handleRuleViolation(
  chatId: string,
  userId: number,
  env: Env,
  settings: GroupSettings,
  reason: "link" | "forward"
): Promise<void> {
  const key = `violations:${chatId}:${userId}`;
  const current = (await env.BOT_CONFIG.get(key)) || "0";
  const count = parseInt(current, 10) || 0;
  const newCount = count + 1;
  await env.BOT_CONFIG.put(key, String(newCount));

  if (!settings.autowarn) return;

  if (newCount >= settings.maxWarns) {
    // auto-mute
    await muteUser(chatId, userId, settings.autoMuteMinutes, env);
    await env.BOT_CONFIG.put(key, "0");

    await sendText(
      chatId,
      `🔇 User ${userId} auto-muted for ${settings.autoMuteMinutes} minutes due to repeated ${reason}s.`,
      env
    );
  } else {
    await sendText(
      chatId,
      `⚠️ User ${userId} has been warned (${newCount}/${settings.maxWarns}) for ${reason}.`,
      env
    );
  }
}

/* ========== COMMAND HANDLER ========== */

async function handleCommand(
  message: TelegramMessage,
  env: Env,
  fromPrivate: boolean
): Promise<void> {
  const chat = message.chat;
  const chatId = String(chat.id);
  const user = message.from;
  const text = message.text || "";

  const [rawCmd, ...rest] = text.split(" ");
  const cmd = rawCmd.split("@")[0]; // strip @BotName

  const isPrivate = chat.type === "private";
  const isGroup = chat.type === "group" || chat.type === "supergroup";

  const fromId = user?.id;
  const isOwner = fromId ? isOwnerId(fromId, env) : false;

  // /start, /help always allowed but differ in message
  if (cmd === "/start") {
    if (isPrivate) {
      if (!fromId || !isOwner) {
        await sendText(
          chatId,
          "This bot is restricted. Only the configured owner(s) can manage settings.\nYou can still use it in groups for automatic moderation.",
          env
        );
      } else {
        await sendText(
          chatId,
          "Hi! I'm your group manager bot.\n\n" +
            "Commands (global):\n" +
            "/groups - List groups where I'm added\n" +
            "/set <chat_id> <option> <value> - Change settings for a group\n" +
            "/status <chat_id> - Show settings for a group\n\n" +
            "Use me in groups to automatically delete links and forwarded messages and auto-mute rule breakers.",
          env
        );
      }
    } else {
      await sendText(
        chatId,
        "I'm active in this group. I delete links and forwarded messages according to this group's settings.",
        env
      );
    }
    return;
  }

  if (cmd === "/help") {
    if (isPrivate) {
      if (!fromId || !isOwner) {
        await sendText(
          chatId,
          "This bot is restricted. Only the configured owner(s) can manage settings.\nYou can still use it in groups for automatic moderation.",
          env
        );
      } else {
        await sendText(
          chatId,
          "Owner commands (use in PM):\n" +
            "/groups - List groups where I'm added (ID + title)\n" +
            "/status <chat_id> - Show settings for that group\n" +
            "/set <chat_id> <option> <value> - Change settings\n\n" +
            "Options:\n" +
            "- antilink on|off\n" +
            "- antiforward on|off\n" +
            "- autowarn on|off\n" +
            "- maxwarns <number>\n" +
            "- automute <minutes>\n" +
            "- whitelist add <domain>\n" +
            "- whitelist remove <domain>\n" +
            "- whitelist list\n\n" +
            "Group commands (only owners, inside group):\n" +
            "- /status - Show current settings for this group\n" +
            "- reply /mute 10m - Mute user for 10 minutes\n" +
            "- reply /unmute - Unmute user\n" +
            "- reply /del 10s - Delete that message after delay (10s/10m/2h...)",
          env
        );
      }
    } else {
      await sendText(
        chatId,
        "Group commands (owner only):\n" +
          "- reply /mute 10m - Mute that user\n" +
          "- reply /unmute - Unmute\n" +
          "- reply /del 10s - Delete that message after delay\n" +
          "- /status - Show this group's filters",
        env
      );
    }
    return;
  }

  // Everything below this line = owner-only
  if (!fromId || !isOwner) {
    // silently ignore for non-owners (to avoid spam in groups)
    if (isPrivate) {
      await sendText(
        chatId,
        "This bot is restricted. Only the configured owner(s) can manage settings.",
        env
      );
    }
    return;
  }

  // PM-only owner commands: /groups, /status <id>, /set <id> ...
  if (isPrivate) {
    if (cmd === "/groups") {
      const groups = await listActiveGroups(env);
      if (groups.length === 0) {
        await sendText(chatId, "I don't know any groups yet. Add me to a group first.", env);
        return;
      }
      const lines = groups.map(
        (g) => `• ${g.title || "(no title)"} — \`${g.id}\``
      );
      await sendText(chatId, "Known active groups:\n" + lines.join("\n"), env);
      return;
    }

    if (cmd === "/status") {
      const argChatId = rest[0];
      if (!argChatId) {
        await sendText(chatId, "Usage: /status <chat_id>", env);
        return;
      }
      const settings = await getGroupSettings(argChatId, env);
      await sendText(chatId, formatSettings(argChatId, settings), env);
      return;
    }

    if (cmd === "/set") {
      const [targetChatId, option, ...valueParts] = rest;
      if (!targetChatId || !option) {
        await sendText(
          chatId,
          "Usage: /set <chat_id> <option> <value>\nExample: /set -100123456 antilink on",
          env
        );
        return;
      }
      const value = valueParts.join(" ");
      const settings = await getGroupSettings(targetChatId, env);
      const reply = await applySetting(targetChatId, settings, option.toLowerCase(), value, env);
      await sendText(chatId, reply, env);
      return;
    }
  }

  // Group-only owner commands: /status, /mute, /unmute, /del
  if (isGroup) {
    const groupChatId = chatId;

    if (cmd === "/status") {
      const settings = await getGroupSettings(groupChatId, env);
      await sendText(groupChatId, formatSettings(groupChatId, settings), env);
      return;
    }

    if (cmd === "/mute") {
      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(groupChatId, "Reply to a user's message with /mute <time>, e.g. /mute 10m", env);
        return;
      }
      const targetUser = reply.from;
      const durationSeconds = parseDurationSeconds(rest[0]) || 24 * 60 * 60; // default 1 day
      const durationMinutes = Math.floor(durationSeconds / 60);

      await muteUser(groupChatId, targetUser.id, durationMinutes, env);
      await sendText(
        groupChatId,
        `🔇 Muted ${displayName(targetUser)} for ${rest[0] || "24h"}.`,
        env
      );
      return;
    }

    if (cmd === "/unmute") {
      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(groupChatId, "Reply to a user's message with /unmute", env);
        return;
      }
      const targetUser = reply.from;
      await unmuteUser(groupChatId, targetUser.id, env);
      await sendText(groupChatId, `🔊 Unmuted ${displayName(targetUser)}.`, env);
      return;
    }

    if (cmd === "/del") {
      const reply = message.reply_to_message;
      if (!reply) {
        await sendText(groupChatId, "Reply to a message with /del <time>, e.g. /del 10s or /del 10m", env);
        return;
      }

      const delaySeconds = parseDurationSeconds(rest[0]);
      if (!delaySeconds) {
        // delete immediately
        await deleteMessage(groupChatId, reply.message_id, env);
        return;
      }

      const deleteAt = Math.floor(Date.now() / 1000) + delaySeconds;

      // send confirmation (we will delete it together with target)
      const confirm = await tgCall("sendMessage", env, {
        chat_id: groupChatId,
        text: `🕒 This message and the replied message will be deleted in ${rest[0]}.`
      });

      const confirmId: number | undefined = confirm?.result?.message_id;

      const entry: DelEntry = {
        chat_id: groupChatId,
        message_ids: confirmId
          ? [reply.message_id, confirmId]
          : [reply.message_id],
        delete_at: deleteAt
      };

      const key = `delqueue:${deleteAt}:${groupChatId}:${reply.message_id}`;
      await env.BOT_CONFIG.put(key, JSON.stringify(entry));

      return;
    }
  }
}

/* ========== SETTINGS APPLICATION ==========\ */

function formatSettings(chatId: string, s: GroupSettings): string {
  return (
    `Settings for chat ${chatId}:\n` +
    `- antilink: ${s.antilink ? "ON" : "OFF"}\n` +
    `- antiforward: ${s.antiforward ? "ON" : "OFF"}\n` +
    `- autowarn: ${s.autowarn ? "ON" : "OFF"}\n` +
    `- maxwarns: ${s.maxWarns}\n` +
    `- automute: ${s.autoMuteMinutes} minutes\n` +
    `- whitelist: ${s.whitelist.length ? s.whitelist.join(", ") : "(none)"}`
  );
}

async function applySetting(
  chatId: string,
  settings: GroupSettings,
  option: string,
  value: string,
  env: Env
): Promise<string> {
  const trimmedValue = value.trim();

  if (option === "antilink") {
    if (trimmedValue !== "on" && trimmedValue !== "off") {
      return "antilink value must be 'on' or 'off'.";
    }
    settings.antilink = trimmedValue === "on";
    await saveGroupSettings(chatId, settings, env);
    return `antilink set to ${trimmedValue.toUpperCase()} for chat ${chatId}.`;
  }

  if (option === "antiforward") {
    if (trimmedValue !== "on" && trimmedValue !== "off") {
      return "antiforward value must be 'on' or 'off'.";
    }
    settings.antiforward = trimmedValue === "on";
    await saveGroupSettings(chatId, settings, env);
    return `antiforward set to ${trimmedValue.toUpperCase()} for chat ${chatId}.`;
  }

  if (option === "autowarn") {
    if (trimmedValue !== "on" && trimmedValue !== "off") {
      return "autowarn value must be 'on' or 'off'.";
    }
    settings.autowarn = trimmedValue === "on";
    await saveGroupSettings(chatId, settings, env);
    return `autowarn set to ${trimmedValue.toUpperCase()} for chat ${chatId}.`;
  }

  if (option === "maxwarns") {
    const n = parseInt(trimmedValue, 10);
    if (!Number.isFinite(n) || n < 1) {
      return "maxwarns must be a positive integer.";
    }
    settings.maxWarns = n;
    await saveGroupSettings(chatId, settings, env);
    return `maxwarns set to ${n} for chat ${chatId}.`;
  }

  if (option === "automute") {
    const n = parseInt(trimmedValue, 10);
    if (!Number.isFinite(n) || n < 1) {
      return "automute must be a positive integer (minutes).";
    }
    settings.autoMuteMinutes = n;
    await saveGroupSettings(chatId, settings, env);
    return `automute set to ${n} minutes for chat ${chatId}.`;
  }

  if (option === "whitelist") {
    const [sub, domainRaw] = trimmedValue.split(/\s+/, 2);
    const domain = (domainRaw || "").toLowerCase();

    if (sub === "add") {
      if (!domain) return "Usage: whitelist add <domain>";
      if (!settings.whitelist.includes(domain)) {
        settings.whitelist.push(domain);
      }
      await saveGroupSettings(chatId, settings, env);
      return `Added "${domain}" to whitelist for chat ${chatId}.`;
    }

    if (sub === "remove") {
      if (!domain) return "Usage: whitelist remove <domain>";
      settings.whitelist = settings.whitelist.filter((d) => d !== domain);
      await saveGroupSettings(chatId, settings, env);
      return `Removed "${domain}" from whitelist for chat ${chatId}.`;
    }

    if (sub === "list") {
      return settings.whitelist.length
        ? `Whitelist for ${chatId}: ${settings.whitelist.join(", ")}`
        : `Whitelist for ${chatId} is empty.`;
    }

    return "Usage: /set <chat_id> whitelist add|remove|list <domain>";
  }

  return "Unknown option. Valid options: antilink, antiforward, autowarn, maxwarns, automute, whitelist.";
}

/* ========== MUTE / UNMUTE / DELETE HELPERS ========== */

async function muteUser(chatId: string, userId: number, minutes: number, env: Env): Promise<void> {
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

async function deleteMessage(chatId: string, messageId: number, env: Env): Promise<void> {
  await tgCall("deleteMessage", env, {
    chat_id: chatId,
    message_id: messageId
  });
}

/* ========== CRON HANDLER FOR /del QUEUE ========== */

async function handleCron(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let cursor: string | undefined = undefined;

  do {
    const listResult = await env.BOT_CONFIG.list({ prefix: "delqueue:", cursor });
    cursor = listResult.cursor;

    for (const k of listResult.keys) {
      const name = k.name;
      const parts = name.split(":");
      const ts = Number(parts[1] || 0);
      if (!ts || ts > now) continue;

      const raw = await env.BOT_CONFIG.get(name);
      if (!raw) {
        await env.BOT_CONFIG.delete(name);
        continue;
      }

      let entry: DelEntry | null = null;
      try {
        entry = JSON.parse(raw) as DelEntry;
      } catch {
        await env.BOT_CONFIG.delete(name);
        continue;
      }

      if (!entry) {
        await env.BOT_CONFIG.delete(name);
        continue;
      }

      for (const msgId of entry.message_ids) {
        await deleteMessage(entry.chat_id, msgId, env);
      }

      await env.BOT_CONFIG.delete(name);
    }
  } while (cursor);
}

/* ========== UTILITIES ========== */

function parseDurationSeconds(arg?: string): number | null {
  if (!arg) return null;
  const m = arg.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return null;
  const value = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === "s") return value;
  if (unit === "m") return value * 60;
  if (unit === "h") return value * 60 * 60;
  if (unit === "d") return value * 60 * 60 * 24;
  return null;
}

async function sendText(chatId: string | number, text: string, env: Env): Promise<void> {
  await tgCall("sendMessage", env, { chat_id: chatId, text });
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
  const full = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  return full || String(user.id);
}
