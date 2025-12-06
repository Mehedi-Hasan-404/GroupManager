const TG_API_BASE = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  BOT_CONFIG: KVNamespace;
  OWNER_USER_IDS?: string;
}

// ---------- Types ----------

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

  // forwarded flags
  forward_from?: TelegramUser;
  forward_from_chat?: TelegramChat;
  forward_sender_name?: string;
  forward_date?: number;
  is_automatic_forward?: boolean;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

type GroupSettings = {
  antilink: boolean;
  antiforward: boolean;
  autoMuteAfter: number;    // violations before auto-mute
  autoMuteMinutes: number;  // mute length
  whitelist: string[];      // list of allowed domains
};

type DelAfterRecord = {
  chatId: string;
  messageId: number;
  deleteAt: number; // unix seconds
};

// ---------- Entry points ----------

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

    if (!update) {
      return new Response("No update", { status: 400 });
    }

    if (update.message) {
      ctx.waitUntil(handleMessage(update.message, env));
    }

    return new Response("OK");
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDelAfterCron(env));
  }
};

// ---------- Core handlers ----------

async function handleMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;

  // Save group metadata for /groups
  if (chat.type === "group" || chat.type === "supergroup") {
    await saveGroupMeta(chat, env);
  }

  if (chat.type === "private") {
    await handlePrivateMessage(message, env);
  } else if (chat.type === "group" || chat.type === "supergroup") {
    await handleGroupMessage(message, env);
  }
}

// Handle bot PM (owner settings, help)
async function handlePrivateMessage(message: TelegramMessage, env: Env): Promise<void> {
  const from = message.from;
  if (!from) return;

  const text = message.text || "";
  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = (rawCmd || "").split("@")[0];

  // Restrict PM usage to owners
  if (!isOwner(from.id, env)) {
    if (cmd === "/start" || cmd === "/help") {
      await sendText(
        from.id,
        "This bot is restricted. Only the configured owner(s) can manage settings.\nYou can still use it in groups for moderation.",
        env
      );
    }
    return;
  }

  switch (cmd) {
    case "/start":
    case "/help": {
      await sendText(
        from.id,
        [
          "👋 Group Manager Bot (Owner panel)",
          "",
          "Use these commands in *this chat* (PM):",
          "/groups - List groups I know",
          "/settings <group_id> - Show settings for a group",
          "/antilink <group_id> on|off",
          "/antiforward <group_id> on|off",
          "/whitelist <group_id> list",
          "/whitelist <group_id> add <domain>",
          "/whitelist <group_id> remove <domain>",
          "",
          "Use these in groups (admin only):",
          "/status - Show group filters",
          "Reply: /mute 10m - Mute a user",
          "Reply: /unmute - Unmute a user",
          "Reply: /delafter 10s - Auto delete a message after delay",
          "",
          "Note: I delete links (unless whitelisted) and can delete forwarded messages if antiforward is ON."
        ].join("\n"),
        env
      );
      break;
    }

    case "/groups": {
      const groups = await listGroups(env);
      if (groups.length === 0) {
        await sendText(from.id, "I don't know any groups yet. Add me to a group and let it receive some messages.", env);
        return;
      }

      const lines = groups.map(
        g => `• ${g.title || "(no title)"} — ID: ${g.id}`
      );
      await sendText(from.id, "Groups I know:\n\n" + lines.join("\n"), env);
      break;
    }

    case "/settings": {
      const groupId = args[0];
      if (!groupId) {
        await sendText(from.id, "Usage: /settings <group_id>", env);
        return;
      }
      const settings = await getGroupSettings(groupId, env);
      await sendText(
        from.id,
        formatSettings(groupId, settings),
        env
      );
      break;
    }

    case "/antilink": {
      const [groupId, value] = args;
      if (!groupId || !value) {
        await sendText(from.id, "Usage: /antilink <group_id> on|off", env);
        return;
      }
      const settings = await getGroupSettings(groupId, env);
      settings.antilink = value.toLowerCase() === "on";
      await saveGroupSettings(groupId, settings, env);
      await sendText(from.id, `antilink for ${groupId} set to ${settings.antilink ? "ON" : "OFF"}`, env);
      break;
    }

    case "/antiforward": {
      const [groupId, value] = args;
      if (!groupId || !value) {
        await sendText(from.id, "Usage: /antiforward <group_id> on|off", env);
        return;
      }
      const settings = await getGroupSettings(groupId, env);
      settings.antiforward = value.toLowerCase() === "on";
      await saveGroupSettings(groupId, settings, env);
      await sendText(from.id, `antiforward for ${groupId} set to ${settings.antiforward ? "ON" : "OFF"}`, env);
      break;
    }

    case "/whitelist": {
      const [groupId, action, argDomain] = args;
      if (!groupId || !action) {
        await sendText(
          from.id,
          "Usage:\n/whitelist <group_id> list\n/whitelist <group_id> add <domain>\n/whitelist <group_id> remove <domain>",
          env
        );
        return;
      }
      const settings = await getGroupSettings(groupId, env);

      if (action === "list") {
        if (settings.whitelist.length === 0) {
          await sendText(from.id, `No whitelisted domains for ${groupId}.`, env);
        } else {
          await sendText(
            from.id,
            `Whitelisted domains for ${groupId}:\n` + settings.whitelist.map(d => `• ${d}`).join("\n"),
            env
          );
        }
        return;
      }

      if (!argDomain) {
        await sendText(
          from.id,
          "You must specify a domain. Example:\n/whitelist " + groupId + " add example.com",
          env
        );
        return;
      }

      const domain = argDomain.toLowerCase();

      if (action === "add") {
        if (!settings.whitelist.includes(domain)) {
          settings.whitelist.push(domain);
        }
        await saveGroupSettings(groupId, settings, env);
        await sendText(from.id, `Added ${domain} to whitelist for ${groupId}.`, env);
      } else if (action === "remove") {
        settings.whitelist = settings.whitelist.filter(d => d !== domain);
        await saveGroupSettings(groupId, settings, env);
        await sendText(from.id, `Removed ${domain} from whitelist for ${groupId}.`, env);
      } else {
        await sendText(
          from.id,
          "Unknown action. Use: list | add | remove",
          env
        );
      }
      break;
    }

    default:
      // ignore unknown in PM for now
      break;
  }
}

// Handle group/supergroup messages
async function handleGroupMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chatId = message.chat.id.toString();
  const text = message.text || message.caption || "";
  const from = message.from;

  // Load settings
  const settings = await getGroupSettings(chatId, env);

  // Commands in group
  if (text.startsWith("/")) {
    await handleGroupCommand(message, settings, env);
    return;
  }

  // Filters: antilink / antiforward
  if (settings.antiforward && isForwarded(message)) {
    await deleteMessage(chatId, message.message_id, env);
    if (from) {
      await handleRuleViolation(chatId, from.id, settings, env);
    }
    return;
  }

  if (settings.antilink && containsDisallowedLink(text, settings.whitelist)) {
    await deleteMessage(chatId, message.message_id, env);
    if (from) {
      await handleRuleViolation(chatId, from.id, settings, env);
    }
    return;
  }
}

// ---------- Group commands (in groups only) ----------

async function handleGroupCommand(message: TelegramMessage, settings: GroupSettings, env: Env): Promise<void> {
  const chat = message.chat;
  const chatId = chat.id.toString();
  const text = message.text || "";
  const from = message.from;
  const senderChat = message.sender_chat;

  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = rawCmd.split("@")[0];

  const isAnonAdmin = !!senderChat && senderChat.id === chat.id;
  const adminAllowed = isAnonAdmin || (from ? await isAdmin(chatId, from.id, env) : false);

  switch (cmd) {
    case "/status": {
      await sendText(chatId, formatSettings(chatId, settings), env);
      break;
    }

    case "/mute": {
      if (!adminAllowed) return;

      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chatId, "Reply to a user's message with /mute <time>, e.g. /mute 10m", env);
        return;
      }

      const targetUser = reply.from;
      const durationMinutes = parseDuration(args[0]) || settings.autoMuteMinutes || 60;
      await muteUser(chatId, targetUser.id, durationMinutes, env);
      await sendText(
        chatId,
        `🔇 Muted ${displayName(targetUser)} for ${args[0] || `${durationMinutes}m`}.`,
        env
      );
      break;
    }

    case "/unmute": {
      if (!adminAllowed) return;

      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chatId, "Reply to a user's message with /unmute", env);
        return;
      }

      const targetUser = reply.from;
      await unmuteUser(chatId, targetUser.id, env);
      await sendText(chatId, `🔊 Unmuted ${displayName(targetUser)}.`, env);
      break;
    }

    case "/delafter": {
      if (!adminAllowed) return;

      const reply = message.reply_to_message;
      if (!reply) {
        await sendText(chatId, "Reply to a message with /delafter <time>, e.g. /delafter 10s or /delafter 10m", env);
        return;
      }

      const seconds = parseDurationSeconds(args[0]);
      if (!seconds) {
        await sendText(chatId, "Invalid time. Use something like 10s, 1m, 10m, 1h, 1d.", env);
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const record: DelAfterRecord = {
        chatId,
        messageId: reply.message_id,
        deleteAt: now + seconds
      };

      const key = `delafter:${chatId}:${reply.message_id}`;
      await env.BOT_CONFIG.put(key, JSON.stringify(record));
      await sendText(chatId, `⏳ Will delete that message in ${args[0] || `${seconds}s`}.`, env);
      break;
    }

    case "/help":
    case "/start": {
      await sendText(
        chatId,
        [
          "Group Manager Bot:",
          "",
          "• I delete links (unless whitelisted).",
          "• I can delete forwarded messages if antiforward is enabled (configured in owner PM).",
          "• Auto-mute after repeated violations.",
          "",
          "Commands (admin only):",
          "/status - Show current filters for this group",
          "Reply: /mute 10m - mute that user",
          "Reply: /unmute - unmute that user",
          "Reply: /delafter 10s - delete that message later"
        ].join("\n"),
        env
      );
      break;
    }

    default:
      // ignore other commands
      break;
  }
}

// ---------- Settings helpers ----------

function defaultGroupSettings(): GroupSettings {
  return {
    antilink: true,
    antiforward: false,
    autoMuteAfter: 3,
    autoMuteMinutes: 30,
    whitelist: []
  };
}

async function getGroupSettings(chatId: string, env: Env): Promise<GroupSettings> {
  const key = `group:${chatId}:settings`;
  const raw = await env.BOT_CONFIG.get(key);
  if (!raw) return defaultGroupSettings();

  try {
    const parsed = JSON.parse(raw) as GroupSettings;
    // ensure defaults
    return {
      ...defaultGroupSettings(),
      ...parsed,
      whitelist: parsed.whitelist || []
    };
  } catch {
    return defaultGroupSettings();
  }
}

async function saveGroupSettings(chatId: string, settings: GroupSettings, env: Env): Promise<void> {
  const key = `group:${chatId}:settings`;
  await env.BOT_CONFIG.put(key, JSON.stringify(settings));
}

function formatSettings(groupId: string, settings: GroupSettings): string {
  return [
    `Settings for group ID: ${groupId}`,
    "",
    `antilink: ${settings.antilink ? "ON" : "OFF"}`,
    `antiforward: ${settings.antiforward ? "ON" : "OFF"}`,
    `autoMuteAfter: ${settings.autoMuteAfter} violations`,
    `autoMuteMinutes: ${settings.autoMuteMinutes} minutes`,
    "",
    `whitelist:`,
    settings.whitelist.length ? settings.whitelist.map(d => `• ${d}`).join("\n") : "(none)"
  ].join("\n");
}

// Save minimal metadata for groups
async function saveGroupMeta(chat: TelegramChat, env: Env): Promise<void> {
  const key = `groupmeta:${chat.id}`;
  const value = JSON.stringify({
    id: chat.id,
    title: chat.title || "",
    updatedAt: Date.now()
  });
  await env.BOT_CONFIG.put(key, value);
}

async function listGroups(env: Env): Promise<{ id: string; title: string }[]> {
  const result: { id: string; title: string }[] = [];
  let cursor: string | undefined = undefined;

  do {
    const page = await env.BOT_CONFIG.list({ prefix: "groupmeta:", cursor });
    for (const k of page.keys) {
      const raw = await env.BOT_CONFIG.get(k.name);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { id: number; title: string };
        result.push({ id: String(parsed.id), title: parsed.title });
      } catch {
        // ignore
      }
    }
    cursor = page.cursor;
  } while (cursor);

  return result;
}

// ---------- Rule violations & auto-mute ----------

async function handleRuleViolation(chatId: string, userId: number, settings: GroupSettings, env: Env): Promise<void> {
  const key = `violations:${chatId}:${userId}`;
  const current = (await env.BOT_CONFIG.get(key)) || "0";
  const count = parseInt(current, 10) || 0;
  const newCount = count + 1;

  await env.BOT_CONFIG.put(key, String(newCount));

  if (newCount >= settings.autoMuteAfter) {
    await muteUser(chatId, userId, settings.autoMuteMinutes, env);
    await env.BOT_CONFIG.put(key, "0"); // reset
    await sendText(
      chatId,
      `🔇 User ${userId} auto-muted for ${settings.autoMuteMinutes} minutes due to repeated violations.`,
      env
    );
  }
}

// ---------- Filters ----------

function isForwarded(message: TelegramMessage): boolean {
  return !!(
    message.forward_from ||
    message.forward_from_chat ||
    message.forward_sender_name ||
    message.forward_date ||
    message.is_automatic_forward
  );
}

/**
 * Detects links; returns true only if there is a link AND
 * none of the whitelisted domains appear in the text.
 * (So a message with only whitelisted domains is allowed.)
 */
function containsDisallowedLink(text: string | undefined, whitelist: string[]): boolean {
  if (!text) return false;

  const baseHasLink =
    /https?:\/\/\S+/i.test(text) ||
    /www\.\S+\.\S+/i.test(text) ||
    /\b[\w-]+\.(com|net|org|io|gg|xyz|info|biz|co|me|bd|in|uk|us)(\/\S*)?/i.test(text) ||
    /t\.me\/\S+/i.test(text) ||
    /telegram\.me\/\S+/i.test(text);

  if (!baseHasLink) return false;

  // If whitelist not empty, allow if *all* links match some whitelisted domain.
  if (whitelist.length > 0) {
    const lowered = text.toLowerCase();
    const someWhitelistedPresent = whitelist.some(domain =>
      lowered.includes(domain.toLowerCase())
    );
    if (someWhitelistedPresent) {
      // For simplicity: if any whitelisted domain is present, we allow this message.
      return false;
    }
  }

  return true;
}

// ---------- Mute / Unmute ----------

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

// ---------- Admin / Owner checks ----------

async function isAdmin(chatId: string, userId: number, env: Env): Promise<boolean> {
  try {
    const res = await tgCall("getChatMember", env, {
      chat_id: chatId,
      user_id: userId
    });

    if (!res || res.ok === false) return false;
    const status = res.result.status;
    return status === "creator" || status === "administrator";
  } catch {
    return false;
  }
}

function isOwner(userId: number, env: Env): boolean {
  const raw = env.OWNER_USER_IDS || "";
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
  return ids.includes(String(userId));
}

// ---------- Time parsing ----------

function parseDuration(arg?: string): number | null {
  if (!arg) return null;
  const match = arg.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === "s") return Math.max(1, Math.floor(value / 60)); // round seconds up to minutes for mute
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  if (unit === "d") return value * 60 * 24;
  return null;
}

function parseDurationSeconds(arg?: string): number | null {
  if (!arg) return null;
  const match = arg.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === "s") return value;
  if (unit === "m") return value * 60;
  if (unit === "h") return value * 60 * 60;
  if (unit === "d") return value * 60 * 60 * 24;
  return null;
}

// ---------- Cron handler for /delafter ----------

async function runDelAfterCron(env: Env): Promise<void> {
  let cursor: string | undefined = undefined;
  const now = Math.floor(Date.now() / 1000);

  do {
    const page = await env.BOT_CONFIG.list({ prefix: "delafter:", cursor });
    for (const k of page.keys) {
      const raw = await env.BOT_CONFIG.get(k.name);
      if (!raw) continue;

      let record: DelAfterRecord;
      try {
        record = JSON.parse(raw) as DelAfterRecord;
      } catch {
        await env.BOT_CONFIG.delete(k.name);
        continue;
      }

      if (record.deleteAt <= now) {
        await deleteMessage(record.chatId, record.messageId, env);
        await env.BOT_CONFIG.delete(k.name);
      }
    }
    cursor = page.cursor;
  } while (cursor);
}

// ---------- Telegram API helpers ----------

async function sendText(chatId: number | string, text: string, env: Env): Promise<void> {
  await tgCall("sendMessage", env, {
    chat_id: chatId,
    text
  });
}

async function deleteMessage(chatId: string, messageId: number, env: Env): Promise<void> {
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

  // Uncomment this if you want debug logs in Cloudflare:
  // if (!res.ok || (data && data.ok === false)) {
  //   console.error("Telegram error:", method, data || res.statusText);
  // }

  return data;
}

// ---------- Misc ----------

function displayName(user: TelegramUser): string {
  if (user.username) return `@${user.username}`;
  const full = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  return full || String(user.id);
}
