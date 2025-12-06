const TG_API_BASE = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  BOT_CONFIG: KVNamespace;
  // Optional but recommended: comma-separated IDs of owners and/or group IDs
  OWNER_USER_IDS?: string;
}

/**
 * Basic Telegram types
 */
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

  // Forward-related fields
  forward_from?: TelegramUser;
  forward_from_chat?: TelegramChat;
  forward_sender_name?: string;
  forward_date?: number;
  forward_origin?: any;

  // Join/leave
  new_chat_members?: TelegramUser[];
  left_chat_member?: TelegramUser;

  // Reply
  reply_to_message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  my_chat_member?: ChatMemberUpdated;
}

interface ChatMember {
  user: TelegramUser;
  status: string;
}

interface ChatMemberUpdated {
  chat: TelegramChat;
  from: TelegramUser;
  date: number;
  old_chat_member: ChatMember;
  new_chat_member: ChatMember;
}

// Group-level settings stored in KV
interface GroupSettings {
  antiLink: boolean;
  antiForward: boolean;
  whitelist: string[]; // e.g. ["example.com", "youtube.com"]
  autoDeleteJoin: boolean;
  autoDeleteLeave: boolean;
  warnLimit: number;       // violations before auto-mute
  autoMuteMinutes: number; // minutes for auto-mute
}

/**
 * Default settings for a new group
 */
function defaultGroupSettings(): GroupSettings {
  return {
    antiLink: true,
    antiForward: true,  // ON by default
    whitelist: [],
    autoDeleteJoin: false,
    autoDeleteLeave: false,
    warnLimit: 3,
    autoMuteMinutes: 30
  };
}

/**
 * Owner IDs set (string IDs). Can contain user IDs or group IDs (for anonymous admins).
 */
function getOwnerIdSet(env: Env): Set<string> {
  const raw = env.OWNER_USER_IDS || "";
  return new Set(
    raw
      .split(",")
      .map(s => s.trim())
      .filter(s => s.length > 0)
  );
}

/**
 * Entry point for HTTP (Telegram webhook)
 */
async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  ctx.waitUntil(handleUpdate(update, env));

  return new Response("OK");
}

/**
 * Entry point for cron trigger (for scheduled deletions)
 */
async function handleScheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(processDeletionQueue(env));
}

export default {
  fetch: handleFetch,
  scheduled: handleScheduled
};

/**
 * Main update handler
 */
async function handleUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  if (update.my_chat_member) {
    await handleMyChatMember(update.my_chat_member, env);
  }

  if (update.message) {
    await handleMessage(update.message, env);
  }
}

/**
 * Register / unregister groups when the bot is added / removed.
 */
async function handleMyChatMember(update: ChatMemberUpdated, env: Env): Promise<void> {
  const chat = update.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const status = update.new_chat_member.status;
  if (status === "member" || status === "administrator" || status === "creator") {
    await registerGroup(chat, env);
  } else if (status === "kicked" || status === "left") {
    await unregisterGroup(chat.id, env);
  }
}

/**
 * Handle any message (group or private).
 */
async function handleMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const chatId = chat.id.toString();

  // Private chat logic (settings, help, etc.)
  if (chat.type === "private") {
    await handlePrivateMessage(message, env);
    return;
  }

  // Only manage group/supergroup
  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  // Make sure group is registered
  await registerGroup(chat, env);

  // Load settings
  const settings = await getGroupSettings(chatId, env);

  // Auto-delete join messages
  if (settings.autoDeleteJoin && message.new_chat_members && message.new_chat_members.length > 0) {
    await deleteMessage(chatId, message.message_id, env);
    return;
  }

  // Auto-delete leave messages
  if (settings.autoDeleteLeave && message.left_chat_member) {
    await deleteMessage(chatId, message.message_id, env);
    return;
  }

  // Commands in group
  const text = message.text || message.caption || "";
  if (text.startsWith("/")) {
    await handleGroupCommand(message, settings, env);
    return;
  }

  // No user info (e.g. some service messages), nothing more to do
  const user = message.from;
  if (!user) {
    return;
  }

  // Anti-forward (including forwarded stories)
  if (settings.antiForward && isForwarded(message)) {
    await deleteMessage(chatId, message.message_id, env);
    await handleRuleViolation(chatId, user.id, env);
    await sendText(chatId, "Forwarded messages (including stories) are not allowed in this group.", env, 300);
    return;
  }

  // Anti-link with whitelist
  if (settings.antiLink && containsBlockedLink(text, settings.whitelist)) {
    await deleteMessage(chatId, message.message_id, env);
    await handleRuleViolation(chatId, user.id, env);
    await sendText(chatId, "Links are not allowed in this group.", env, 300);
    return;
  }
}

/**
 * PRIVATE chat: only owners can manage settings; others see restricted message.
 */
async function handlePrivateMessage(message: TelegramMessage, env: Env): Promise<void> {
  const from = message.from;
  if (!from) return;

  const ownerIds = getOwnerIdSet(env);
  const isOwner = ownerIds.size === 0 ? true : ownerIds.has(from.id.toString());

  const text = message.text || message.caption || "";
  if (!text.startsWith("/")) {
    if (!isOwner) {
      await sendText(
        message.chat.id,
        "This bot is restricted. Only the configured owner(s) can manage settings.\nYou can still use it in groups for moderation.",
        env
      );
      return;
    }
    await sendText(
      message.chat.id,
      "Send /help to see how to configure your groups.",
      env
    );
    return;
  }

  const [rawCmd, ...rest] = text.split(" ");
  const cmd = rawCmd.split("@")[0];

  if (!isOwner && (cmd === "/groups" || cmd === "/settings" || cmd === "/set" || cmd === "/whitelist" || cmd === "/status")) {
    await sendText(
      message.chat.id,
      "This bot is restricted. Only the configured owner(s) can manage settings.\nYou can still use it in groups for moderation.",
      env
    );
    return;
  }

  switch (cmd) {
    case "/start":
    case "/help": {
      const msg =
        "I manage your groups:\n\n" +
        "- Delete links (with optional domain whitelist)\n" +
        "- Block forwarded messages (including stories)\n" +
        "- Auto-warn and auto-mute after too many violations\n" +
        "- /del to delete messages after a delay\n" +
        "- Auto-delete join/leave messages (optional)\n\n" +
        "Owner-only commands (here in PM):\n" +
        "/groups - List groups where I'm added\n" +
        "/settings - Show how to configure a group\n" +
        "/set <group_id> <key> <value>\n" +
        "   keys: antilink, antiforward, autojoin, autoleave, warnlimit, automute\n" +
        "   examples:\n" +
        "   /set -100123456789 antilink off\n" +
        "   /set -100123456789 antiforward on\n" +
        "   /set -100123456789 warnlimit 5\n" +
        "   /set -100123456789 automute 60\n\n" +
        "/whitelist <group_id> add <domain>\n" +
        "/whitelist <group_id> remove <domain>\n" +
        "/whitelist <group_id> list\n" +
        "   example: /whitelist -100123456789 add youtube.com\n\n" +
        "/status <group_id> - Show settings for that group.\n";
      await sendText(message.chat.id, msg, env);
      break;
    }

    case "/groups": {
      const groups = await getGroupList(env);
      if (groups.length === 0) {
        await sendText(message.chat.id, "No groups registered yet. Add me to a group as admin.", env);
        break;
      }
      const lines = groups.map(g => `${g.id} - ${g.title || "(no title)"}`);
      await sendText(message.chat.id, "Groups I know:\n" + lines.join("\n"), env);
      break;
    }

    case "/settings": {
      const msg =
        "Usage:\n\n" +
        "/groups - see group IDs\n" +
        "/set <group_id> <key> <value>\n" +
        "  keys:\n" +
        "  - antilink on|off\n" +
        "  - antiforward on|off\n" +
        "  - autojoin on|off (auto delete join messages)\n" +
        "  - autoleave on|off (auto delete leave messages)\n" +
        "  - warnlimit <number> (violations before auto-mute)\n" +
        "  - automute <minutes> (auto-mute duration)\n\n" +
        "Example:\n" +
        "/set -100123456789 antilink off\n" +
        "/set -100123456789 warnlimit 5\n" +
        "/set -100123456789 automute 60\n";
      await sendText(message.chat.id, msg, env);
      break;
    }

    case "/set": {
      if (rest.length < 3) {
        await sendText(
          message.chat.id,
          "Usage: /set <group_id> <key> <value>\nExample: /set -100123456789 antilink off",
          env
        );
        break;
      }
      const [groupIdRaw, key, ...valueParts] = rest;
      const groupId = groupIdRaw.trim();
      const value = valueParts.join(" ").trim().toLowerCase();

      const settings = await getGroupSettings(groupId, env);
      let changed = false;

      switch (key.toLowerCase()) {
        case "antilink":
          if (value === "on") {
            settings.antiLink = true;
            changed = true;
          } else if (value === "off") {
            settings.antiLink = false;
            changed = true;
          }
          break;

        case "antiforward":
          if (value === "on") {
            settings.antiForward = true;
            changed = true;
          } else if (value === "off") {
            settings.antiForward = false;
            changed = true;
          }
          break;

        case "autojoin":
          if (value === "on") {
            settings.autoDeleteJoin = true;
            changed = true;
          } else if (value === "off") {
            settings.autoDeleteJoin = false;
            changed = true;
          }
          break;

        case "autoleave":
          if (value === "on") {
            settings.autoDeleteLeave = true;
            changed = true;
          } else if (value === "off") {
            settings.autoDeleteLeave = false;
            changed = true;
          }
          break;

        case "warnlimit": {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num > 0) {
            settings.warnLimit = num;
            changed = true;
          }
          break;
        }

        case "automute": {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num > 0) {
            settings.autoMuteMinutes = num;
            changed = true;
          }
          break;
        }

        default:
          await sendText(
            message.chat.id,
            "Unknown key. Use one of: antilink, antiforward, autojoin, autoleave, warnlimit, automute.",
            env
          );
          break;
      }

      if (changed) {
        await saveGroupSettings(groupId, settings, env);
        await sendText(message.chat.id, `Updated settings for group ${groupId}.`, env);
      } else {
        await sendText(
          message.chat.id,
          "Nothing changed. Check your key/value.\nUse /settings for help.",
          env
        );
      }
      break;
    }

    case "/whitelist": {
      if (rest.length < 2) {
        await sendText(
          message.chat.id,
          "Usage:\n/whitelist <group_id> list\n/whitelist <group_id> add <domain>\n/whitelist <group_id> remove <domain>",
          env
        );
        break;
      }
      const groupId = rest[0].trim();
      const subcmd = (rest[1] || "").toLowerCase();
      const domain = (rest[2] || "").toLowerCase();
      const settings = await getGroupSettings(groupId, env);

      if (subcmd === "list") {
        if (settings.whitelist.length === 0) {
          await sendText(message.chat.id, `No whitelisted domains for group ${groupId}.`, env);
        } else {
          await sendText(
            message.chat.id,
            `Whitelisted domains for group ${groupId}:\n` + settings.whitelist.join("\n"),
            env
          );
        }
      } else if (subcmd === "add" && domain) {
        if (!settings.whitelist.includes(domain)) {
          settings.whitelist.push(domain);
          await saveGroupSettings(groupId, settings, env);
        }
        await sendText(message.chat.id, `Added "${domain}" to whitelist for group ${groupId}.`, env);
      } else if (subcmd === "remove" && domain) {
        const newList = settings.whitelist.filter(d => d !== domain);
        settings.whitelist = newList;
        await saveGroupSettings(groupId, settings, env);
        await sendText(message.chat.id, `Removed "${domain}" from whitelist for group ${groupId}.`, env);
      } else {
        await sendText(
          message.chat.id,
          "Usage:\n/whitelist <group_id> list\n/whitelist <group_id> add <domain>\n/whitelist <group_id> remove <domain>",
          env
        );
      }

      break;
    }

    case "/status": {
      if (rest.length < 1) {
        await sendText(
          message.chat.id,
          "Usage: /status <group_id>",
          env
        );
        break;
      }
      const groupId = rest[0].trim();
      const settings = await getGroupSettings(groupId, env);
      const msg =
        `Status for group ${groupId}:\n` +
        `antilink: ${settings.antiLink ? "on" : "off"}\n` +
        `antiforward: ${settings.antiForward ? "on" : "off"}\n` +
        `autojoin (auto delete join): ${settings.autoDeleteJoin ? "on" : "off"}\n` +
        `autoleave (auto delete leave): ${settings.autoDeleteLeave ? "on" : "off"}\n` +
        `warnlimit (auto-mute after): ${settings.warnLimit}\n` +
        `automute (minutes): ${settings.autoMuteMinutes}\n` +
        `whitelist: ${settings.whitelist.length ? settings.whitelist.join(", ") : "(none)"}`;
      await sendText(message.chat.id, msg, env);
      break;
    }

    default:
      // Ignore unknown PM commands
      break;
  }
}

/**
 * GROUP commands (/mute, /unmute, /del, /status...)
 */
async function handleGroupCommand(
  message: TelegramMessage,
  settings: GroupSettings,
  env: Env
): Promise<void> {
  const chat = message.chat;
  const chatId = chat.id.toString();
  const text = message.text || "";
  const [rawCmd, ...rest] = text.split(" ");
  const cmd = rawCmd.split("@")[0];

  const from = message.from;
  const senderChat = message.sender_chat;

  const ownerIds = getOwnerIdSet(env);

  // Determine if this command is allowed moderator command
  const isOwnerModerator = (() => {
    if (ownerIds.size === 0) return false;
    if (from && ownerIds.has(from.id.toString())) return true;
    if (senderChat && ownerIds.has(senderChat.id.toString())) return true;
    return false;
  })();

  // If OWNER_USER_IDS is configured, only those IDs can moderate.
  // If not configured, fall back to Telegram admin check.
  let canModerate = false;
  if (ownerIds.size > 0) {
    canModerate = isOwnerModerator;
  } else if (from) {
    canModerate = await isAdmin(chatId, from.id, env);
  }

  switch (cmd) {
    case "/status": {
      const msg =
        `Status for this group:\n` +
        `antilink: ${settings.antiLink ? "on" : "off"}\n` +
        `antiforward: ${settings.antiForward ? "on" : "off"}\n` +
        `autojoin (auto delete join): ${settings.autoDeleteJoin ? "on" : "off"}\n` +
        `autoleave (auto delete leave): ${settings.autoDeleteLeave ? "on" : "off"}\n` +
        `warnlimit (auto-mute after): ${settings.warnLimit}\n` +
        `automute (minutes): ${settings.autoMuteMinutes}\n` +
        `whitelist: ${settings.whitelist.length ? settings.whitelist.join(", ") : "(none)"}`;
      await sendText(chat.id, msg, env, 300);
      break;
    }

    case "/mute": {
      if (!canModerate) return;

      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chat.id, "Reply to a user's message with /mute <time>, e.g. /mute 10m", env, 300);
        return;
      }
      const targetUser = reply.from;
      const durationMinutes = parseDuration(rest[0]); // 10m, 1h, 1d or default
      await muteUser(chatId, targetUser.id, durationMinutes, env);
      await sendText(
        chat.id,
        `Muted ${displayName(targetUser)} for ${rest[0] || "24h"}.`,
        env,
        300
      );
      break;
    }

    case "/unmute": {
      if (!canModerate) return;
      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chat.id, "Reply to a user's message with /unmute", env, 300);
        return;
      }
      const targetUser = reply.from;
      await unmuteUser(chatId, targetUser.id, env);
      await sendText(
        chat.id,
        `Unmuted ${displayName(targetUser)}.`,
        env,
        300
      );
      break;
    }

    case "/del": {
      if (!canModerate) return;
      const reply = message.reply_to_message;
      if (!reply) {
        await sendText(chat.id, "Reply to a message with /del <time>, e.g. /del 10s or /del 5m", env, 300);
        return;
      }
      const delaySeconds = parseDurationSeconds(rest[0]); // 10s, 10m, etc.
      const replyChatId = reply.chat.id.toString();
      const replyMsgId = reply.message_id;

      // Announce and schedule
      const delayText = rest[0] || "10s";
      const res = await tgCall("sendMessage", env, {
        chat_id: chatId,
        text: `This message will be deleted after ${delayText}.`
      });

      if (res && res.ok && res.result && typeof res.result.message_id === "number") {
        const noticeId = res.result.message_id as number;
        await scheduleDeleteMessage(replyChatId, replyMsgId, delaySeconds, env);
        await scheduleDeleteMessage(chatId, noticeId, delaySeconds, env);
      }
      break;
    }

    default:
      // other commands ignored in group
      break;
  }
}

/**
 * Check if message is forwarded (including stories).
 */
function isForwarded(message: TelegramMessage): boolean {
  if (message.forward_from) return true;
  if (message.forward_from_chat) return true;
  if (message.forward_sender_name) return true;
  if (typeof message.forward_date === "number") return true;
  if ((message as any).forward_origin) return true;
  return false;
}

/**
 * Link detection with domain whitelist:
 * Returns true if there is at least one non-whitelisted link.
 */
function containsBlockedLink(text: string | undefined, whitelist: string[]): boolean {
  if (!text) return false;

  const lowerWhitelist = whitelist.map(d => d.toLowerCase());

  // URL regex capturing hostname
  const urlRegex =
    /((https?:\/\/)?((www\.)?([\w-]+\.[\w.-]+))([\/?#]\S*)?)/gi;

  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    const host = (match[5] || "").toLowerCase(); // captured host
    if (!host) continue;
    if (!isWhitelistedHost(host, lowerWhitelist)) {
      return true;
    }
  }

  // Optional: detect emails as "links"
  const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  if (emailRegex.test(text)) {
    return true;
  }

  return false;
}

function isWhitelistedHost(host: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return false;
  for (const domain of whitelist) {
    if (!domain) continue;
    if (host === domain) return true;
    if (host.endsWith("." + domain)) return true;
  }
  return false;
}

/**
 * Handle rule violation: increment count with TTL, auto-mute after warnLimit.
 * KV key expires after 5 minutes, so warnings reset automatically.
 */
async function handleRuleViolation(chatId: string, userId: number, env: Env): Promise<void> {
  const settings = await getGroupSettings(chatId, env);
  const key = `violations:${chatId}:${userId}`;
  const current = (await env.BOT_CONFIG.get(key)) || "0";
  const count = parseInt(current, 10) || 0;
  const newCount = count + 1;

  await env.BOT_CONFIG.put(key, newCount.toString(), { expirationTtl: 300 }); // 5 minutes

  if (newCount >= settings.warnLimit) {
    await muteUser(chatId, userId, settings.autoMuteMinutes, env);
    await env.BOT_CONFIG.delete(key);
    await sendText(
      chatId,
      `User ${userId} auto-muted for ${settings.autoMuteMinutes} minutes due to repeated violations.`,
      env,
      300
    );
  }
}

/**
 * Group settings helpers
 */
async function getGroupSettings(chatId: string, env: Env): Promise<GroupSettings> {
  const key = `group:${chatId}:settings`;
  const raw = await env.BOT_CONFIG.get(key);
  if (!raw) {
    const def = defaultGroupSettings();
    await env.BOT_CONFIG.put(key, JSON.stringify(def));
    return def;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GroupSettings>;
    const def = defaultGroupSettings();
    return {
      antiLink: parsed.antiLink ?? def.antiLink,
      antiForward: parsed.antiForward ?? def.antiForward,
      whitelist: parsed.whitelist ?? def.whitelist,
      autoDeleteJoin: parsed.autoDeleteJoin ?? def.autoDeleteJoin,
      autoDeleteLeave: parsed.autoDeleteLeave ?? def.autoDeleteLeave,
      warnLimit: parsed.warnLimit ?? def.warnLimit,
      autoMuteMinutes: parsed.autoMuteMinutes ?? def.autoMuteMinutes
    };
  } catch {
    const def = defaultGroupSettings();
    await env.BOT_CONFIG.put(key, JSON.stringify(def));
    return def;
  }
}

async function saveGroupSettings(chatId: string, settings: GroupSettings, env: Env): Promise<void> {
  const key = `group:${chatId}:settings`;
  await env.BOT_CONFIG.put(key, JSON.stringify(settings));
}

/**
 * Group list helpers
 */
interface GroupInfo {
  id: number;
  title: string;
}

async function registerGroup(chat: TelegramChat, env: Env): Promise<void> {
  const key = "bot:groups";
  const raw = await env.BOT_CONFIG.get(key);
  let groups: GroupInfo[] = raw ? JSON.parse(raw) : [];
  if (!groups.find(g => g.id === chat.id)) {
    groups.push({ id: chat.id, title: chat.title || "" });
    await env.BOT_CONFIG.put(key, JSON.stringify(groups));
  }
}

async function unregisterGroup(chatId: number, env: Env): Promise<void> {
  const key = "bot:groups";
  const raw = await env.BOT_CONFIG.get(key);
  if (!raw) return;
  let groups: GroupInfo[] = JSON.parse(raw);
  const newGroups = groups.filter(g => g.id !== chatId);
  await env.BOT_CONFIG.put(key, JSON.stringify(newGroups));
}

async function getGroupList(env: Env): Promise<GroupInfo[]> {
  const raw = await env.BOT_CONFIG.get("bot:groups");
  if (!raw) return [];
  try {
    return JSON.parse(raw) as GroupInfo[];
  } catch {
    return [];
  }
}

/**
 * Duration parsing: "10m", "1h", "1d"
 */
function parseDuration(arg: string | undefined): number {
  if (!arg) return 24 * 60; // default 24h in minutes
  const match = arg.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return 24 * 60;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (unit === "s") return Math.max(1, Math.floor(value / 60)); // seconds rounded to minutes
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  if (unit === "d") return value * 60 * 24;
  return 24 * 60;
}

function parseDurationSeconds(arg: string | undefined): number {
  if (!arg) return 10; // default 10 seconds
  const match = arg.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return 10;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === "s") return value;
  if (unit === "m") return value * 60;
  if (unit === "h") return value * 3600;
  if (unit === "d") return value * 86400;
  return 10;
}

/**
 * Mute / unmute
 */
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

/**
 * Admin check (when OWNER_USER_IDS not used)
 */
async function isAdmin(chatId: string, userId: number, env: Env): Promise<boolean> {
  try {
    const res = await tgCall("getChatMember", env, {
      chat_id: chatId,
      user_id: userId
    });

    if (!res || !res.ok) return false;
    const status = res.result.status;
    return status === "creator" || status === "administrator";
  } catch {
    return false;
  }
}

/**
 * Send text with optional auto-delete
 */
async function sendText(
  chatId: number | string,
  text: string,
  env: Env,
  autoDeleteSeconds?: number
): Promise<void> {
  const res = await tgCall("sendMessage", env, {
    chat_id: chatId,
    text
  });

  if (
    res &&
    res.ok &&
    autoDeleteSeconds &&
    res.result &&
    typeof res.result.message_id === "number"
  ) {
    await scheduleDeleteMessage(String(chatId), res.result.message_id, autoDeleteSeconds, env);
  }
}

/**
 * Delete message
 */
async function deleteMessage(chatId: string, messageId: number, env: Env): Promise<void> {
  await tgCall("deleteMessage", env, {
    chat_id: chatId,
    message_id: messageId
  });
}

/**
 * Telegram API helper
 */
async function tgCall(method: string, env: Env, body: Record<string, unknown>): Promise<any> {
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

/**
 * Display name
 */
function displayName(user: TelegramUser): string {
  if (user.username) return `@${user.username}`;
  const fullName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  if (fullName) return fullName;
  return `${user.id}`;
}

/**
 * Deletion queue (used for /del and for auto-deleting bot messages)
 * Keys: del:<uuid> -> { chat_id, message_id, delete_at }
 */
async function scheduleDeleteMessage(
  chatId: string,
  messageId: number,
  delaySeconds: number,
  env: Env
): Promise<void> {
  const deleteAt = Math.floor(Date.now() / 1000) + delaySeconds;
  const key = `del:${crypto.randomUUID()}`;
  const value = JSON.stringify({
    chat_id: chatId,
    message_id: messageId,
    delete_at: deleteAt
  });
  await env.BOT_CONFIG.put(key, value, { expirationTtl: delaySeconds + 3600 });
}

/**
 * Cron: process deletion queue every minute
 */
async function processDeletionQueue(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let cursor: string | undefined = undefined;

  do {
    const list = await env.BOT_CONFIG.list({ prefix: "del:", cursor, limit: 100 });
    cursor = list.list_complete ? undefined : list.cursor;

    for (const key of list.keys) {
      const raw = await env.BOT_CONFIG.get(key.name);
      if (!raw) {
        await env.BOT_CONFIG.delete(key.name);
        continue;
      }
      try {
        const job = JSON.parse(raw) as { chat_id: string; message_id: number; delete_at: number };
        if (job.delete_at <= now) {
          await deleteMessage(job.chat_id, job.message_id, env);
          await env.BOT_CONFIG.delete(key.name);
        }
      } catch {
        await env.BOT_CONFIG.delete(key.name);
      }
    }
  } while (cursor);
}
