const TG_API_BASE = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  BOT_CONFIG: KVNamespace;
  OWNER_USER_IDS: string; // comma-separated user IDs
}

// ===== Types =====

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
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  forward_from?: TelegramUser;
  forward_from_chat?: TelegramChat;
  // forward_origin and other fields can exist but we don't need explicit typing here
  [key: string]: any;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  // other update types ignored
}

interface GroupSettings {
  antilink: boolean;
  antiforward: boolean;
  auto_mute: boolean;
  auto_mute_minutes: number;
  max_violations: number;
  whitelist: string[]; // domains
}

// For delayed deletions
interface DelTask {
  chatId: string;
  messageId: number;
  removeAt: number; // unix seconds
}

// ===== Helpers: owners, settings, storage =====

function getOwnerIds(env: Env): Set<number> {
  const raw = env.OWNER_USER_IDS || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n))
  );
}

function isOwner(userId: number | undefined, env: Env): boolean {
  if (!userId) return false;
  const owners = getOwnerIds(env);
  return owners.has(userId);
}

function defaultSettings(): GroupSettings {
  return {
    antilink: true,
    antiforward: false,
    auto_mute: true,
    auto_mute_minutes: 30,
    max_violations: 3,
    whitelist: []
  };
}

async function loadSettings(chatId: string, env: Env): Promise<GroupSettings> {
  const key = `settings:${chatId}`;
  const raw = await env.BOT_CONFIG.get(key);
  if (!raw) return defaultSettings();

  try {
    const parsed = JSON.parse(raw);
    const def = defaultSettings();
    return {
      antilink: typeof parsed.antilink === "boolean" ? parsed.antilink : def.antilink,
      antiforward: typeof parsed.antiforward === "boolean" ? parsed.antiforward : def.antiforward,
      auto_mute: typeof parsed.auto_mute === "boolean" ? parsed.auto_mute : def.auto_mute,
      auto_mute_minutes:
        typeof parsed.auto_mute_minutes === "number" ? parsed.auto_mute_minutes : def.auto_mute_minutes,
      max_violations:
        typeof parsed.max_violations === "number" ? parsed.max_violations : def.max_violations,
      whitelist: Array.isArray(parsed.whitelist) ? parsed.whitelist : def.whitelist
    };
  } catch {
    return defaultSettings();
  }
}

async function saveSettings(chatId: string, settings: GroupSettings, env: Env): Promise<void> {
  const key = `settings:${chatId}`;
  await env.BOT_CONFIG.put(key, JSON.stringify(settings));
}

// Maintain simple group list
async function registerGroup(chat: TelegramChat, env: Env): Promise<void> {
  const indexKey = "groups:index";
  const metaKey = `groupmeta:${chat.id}`;

  const raw = await env.BOT_CONFIG.get(indexKey);
  let ids: number[] = [];
  if (raw) {
    try {
      ids = JSON.parse(raw);
    } catch {
      ids = [];
    }
  }
  if (!ids.includes(chat.id)) {
    ids.push(chat.id);
    await env.BOT_CONFIG.put(indexKey, JSON.stringify(ids));
  }

  const meta = {
    id: chat.id,
    title: chat.title || "",
    username: chat.username || "",
    type: chat.type
  };
  await env.BOT_CONFIG.put(metaKey, JSON.stringify(meta));
}

// ===== Telegram API helper =====

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
    // ignore JSON parse errors
  }

  if (!res.ok || (data && data.ok === false)) {
    console.error("Telegram API error", method, data || res.statusText);
  }

  return data;
}

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

async function muteUser(
  chatId: string,
  userId: number,
  minutes: number,
  env: Env
): Promise<void> {
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

// ===== Detection helpers =====

function displayName(user: TelegramUser): string {
  if (user.username) return `@${user.username}`;
  const full = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  if (full) return full;
  return `${user.id}`;
}

function containsLink(text: string | undefined): boolean {
  if (!text) return false;
  const patterns = [
    /https?:\/\/\S+/i,
    /www\.\S+\.\S+/i,
    /\b[\w-]+\.(com|net|org|io|gg|xyz|info|biz|co|me|in|bd|uk|us)(\/\S*)?/i,
    /t\.me\/\S+/i,
    /telegram\.me\/\S+/i,
    /joinchat\/\S+/i
  ];
  return patterns.some((rx) => rx.test(text));
}

function isForwarded(message: TelegramMessage): boolean {
  return Boolean(
    message.forward_from ||
      message.forward_from_chat ||
      message.forward_sender_name ||
      message.forward_origin
  );
}

function parseDuration(arg: string | undefined, defaultMinutes: number): number {
  if (!arg) return defaultMinutes;
  const match = arg.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return defaultMinutes;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (unit === "s") return Math.max(1, Math.floor(value / 60)); // for delafter we'll handle in seconds separately if needed
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  if (unit === "d") return value * 60 * 24;
  return defaultMinutes;
}

function parseSeconds(arg: string | undefined, defaultSeconds: number): number {
  if (!arg) return defaultSeconds;
  const match = arg.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return defaultSeconds;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (unit === "s") return value;
  if (unit === "m") return value * 60;
  if (unit === "h") return value * 60 * 60;
  if (unit === "d") return value * 60 * 60 * 24;
  return defaultSeconds;
}

function isWhitelisted(text: string | undefined, whitelist: string[]): boolean {
  if (!text || whitelist.length === 0) return false;
  const lower = text.toLowerCase();
  return whitelist.some((domain) => lower.includes(domain.toLowerCase()));
}

// ===== Violations & auto-mute =====

async function handleRuleViolation(
  chatId: string,
  userId: number,
  settings: GroupSettings,
  env: Env
): Promise<void> {
  const key = `violations:${chatId}:${userId}`;
  const current = (await env.BOT_CONFIG.get(key)) || "0";
  const count = parseInt(current, 10) || 0;
  const newCount = count + 1;

  await env.BOT_CONFIG.put(key, newCount.toString());

  if (settings.auto_mute && newCount >= settings.max_violations) {
    await muteUser(chatId, userId, settings.auto_mute_minutes, env);
    await env.BOT_CONFIG.put(key, "0");
    await sendText(
      chatId,
      `🔇 Auto-muted user ${userId} for ${settings.auto_mute_minutes} minutes (too many violations).`,
      env
    );
  }
}

// ===== Delayed delete queue =====

const DELQUEUE_KEY = "delqueue";

async function enqueueDelete(task: DelTask, env: Env): Promise<void> {
  const raw = await env.BOT_CONFIG.get(DELQUEUE_KEY);
  let list: DelTask[] = [];
  if (raw) {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }
  list.push(task);
  await env.BOT_CONFIG.put(DELQUEUE_KEY, JSON.stringify(list));
}

async function processDeleteQueue(env: Env): Promise<void> {
  const raw = await env.BOT_CONFIG.get(DELQUEUE_KEY);
  if (!raw) return;

  let list: DelTask[] = [];
  try {
    list = JSON.parse(raw);
  } catch {
    list = [];
  }

  if (list.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const remaining: DelTask[] = [];

  for (const task of list) {
    if (task.removeAt <= now) {
      await deleteMessage(task.chatId, task.messageId, env);
    } else {
      remaining.push(task);
    }
  }

  await env.BOT_CONFIG.put(DELQUEUE_KEY, JSON.stringify(remaining));
}

// ===== Command handling =====

async function handlePrivateCommand(message: TelegramMessage, env: Env): Promise<void> {
  const chatId = message.chat.id;
  const from = message.from;
  const text = message.text || "";
  const [rawCmd, ...args] = text.split(" ");
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const owner = isOwner(from?.id, env);

  if (cmd === "/start") {
    if (owner) {
      await sendText(
        chatId,
        "Hi, owner!\n\n" +
          "Commands (private):\n" +
          "/groups - list groups where I am added\n" +
          "/settings <group_id> - show settings for that group\n" +
          "/setg <group_id> <key> <value> - change settings\n" +
          "/whitelist <group_id> <add|remove|list> [domain]\n\n" +
          "Group commands (only owner IDs):\n" +
          "/status - show filters for this group\n" +
          "/mute <time> (reply)\n" +
          "/unmute (reply)\n" +
          "/delafter <time> (reply)\n" +
          "/antilink <on|off>\n" +
          "/antiforward <on|off>",
        env
      );
    } else {
      await sendText(
        chatId,
        "This bot is private.\nOnly the configured owner(s) can use moderation and settings commands.\n" +
          "You can still add the bot to groups where it will auto-moderate according to the owner's configuration.",
        env
      );
    }
    return;
  }

  if (cmd === "/help") {
    await handlePrivateCommand(
      { ...message, text: "/start" } as TelegramMessage,
      env
    );
    return;
  }

  if (!owner) {
    await sendText(
      chatId,
      "You are not in the allowed owner list for this bot.",
      env
    );
    return;
  }

  switch (cmd) {
    case "/groups": {
      const idxRaw = await env.BOT_CONFIG.get("groups:index");
      if (!idxRaw) {
        await sendText(chatId, "No groups registered yet.", env);
        return;
      }
      let ids: number[] = [];
      try {
        ids = JSON.parse(idxRaw);
      } catch {
        ids = [];
      }
      if (ids.length === 0) {
        await sendText(chatId, "No groups registered yet.", env);
        return;
      }

      let lines: string[] = [];
      for (const id of ids) {
        const metaRaw = await env.BOT_CONFIG.get(`groupmeta:${id}`);
        if (!metaRaw) {
          lines.push(`${id} - (no meta)`);
          continue;
        }
        try {
          const meta = JSON.parse(metaRaw);
          const title = meta.title || "(no title)";
          lines.push(`${id} - ${title}`);
        } catch {
          lines.push(`${id} - (broken meta)`);
        }
      }

      await sendText(chatId, "Groups I know:\n" + lines.join("\n"), env);
      break;
    }

    case "/settings": {
      const groupIdStr = args[0];
      if (!groupIdStr) {
        await sendText(chatId, "Usage: /settings <group_id>", env);
        return;
      }
      const groupId = groupIdStr.trim();
      const settings = await loadSettings(groupId, env);
      const msg =
        `Settings for group ${groupId}:\n` +
        `antilink: ${settings.antilink}\n` +
        `antiforward: ${settings.antiforward}\n` +
        `auto_mute: ${settings.auto_mute}\n` +
        `auto_mute_minutes: ${settings.auto_mute_minutes}\n` +
        `max_violations: ${settings.max_violations}\n` +
        `whitelist: ${settings.whitelist.join(", ") || "(none)"}`;
      await sendText(chatId, msg, env);
      break;
    }

    case "/setg": {
      const groupIdStr = args[0];
      const key = args[1];
      const value = args[2];

      if (!groupIdStr || !key || typeof value === "undefined") {
        await sendText(
          chatId,
          "Usage: /setg <group_id> <key> <value>\n" +
            "Keys: antilink (on/off), antiforward (on/off), auto_mute (on/off), auto_mute_minutes (number), max_violations (number)",
          env
        );
        return;
      }

      const groupId = groupIdStr.trim();
      const settings = await loadSettings(groupId, env);

      switch (key.toLowerCase()) {
        case "antilink":
          settings.antilink = value.toLowerCase() === "on";
          break;
        case "antiforward":
          settings.antiforward = value.toLowerCase() === "on";
          break;
        case "auto_mute":
          settings.auto_mute = value.toLowerCase() === "on";
          break;
        case "auto_mute_minutes":
          settings.auto_mute_minutes = parseInt(value, 10) || settings.auto_mute_minutes;
          break;
        case "max_violations":
          settings.max_violations = parseInt(value, 10) || settings.max_violations;
          break;
        default:
          await sendText(chatId, "Unknown key. Allowed: antilink, antiforward, auto_mute, auto_mute_minutes, max_violations", env);
          return;
      }

      await saveSettings(groupId, settings, env);
      await sendText(chatId, `Updated ${key} for group ${groupId}.`, env);
      break;
    }

    case "/whitelist": {
      const groupIdStr = args[0];
      const subcmd = args[1]?.toLowerCase();
      const domain = args[2];

      if (!groupIdStr || !subcmd) {
        await sendText(
          chatId,
          "Usage: /whitelist <group_id> <add|remove|list> [domain]",
          env
        );
        return;
      }

      const groupId = groupIdStr.trim();
      const settings = await loadSettings(groupId, env);

      if (subcmd === "list") {
        const msg =
          settings.whitelist.length === 0
            ? `No whitelisted domains for group ${groupId}.`
            : `Whitelisted domains for group ${groupId}:\n${settings.whitelist.join("\n")}`;
        await sendText(chatId, msg, env);
        return;
      }

      if (!domain) {
        await sendText(
          chatId,
          "You must specify a domain when using add/remove.",
          env
        );
        return;
      }

      const dom = domain.toLowerCase();

      if (subcmd === "add") {
        if (!settings.whitelist.includes(dom)) {
          settings.whitelist.push(dom);
        }
        await saveSettings(groupId, settings, env);
        await sendText(chatId, `Added ${dom} to whitelist for group ${groupId}.`, env);
      } else if (subcmd === "remove") {
        settings.whitelist = settings.whitelist.filter((d) => d !== dom);
        await saveSettings(groupId, settings, env);
        await sendText(chatId, `Removed ${dom} from whitelist for group ${groupId}.`, env);
      } else {
        await sendText(chatId, "Subcommand must be add, remove, or list.", env);
      }

      break;
    }

    default:
      await sendText(chatId, "Unknown command. Use /start for help.", env);
      break;
  }
}

async function handleGroupCommand(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const chatId = chat.id.toString();
  const from = message.from;
  const text = message.text || "";

  const [rawCmd, ...args] = text.split(" ");
  const cmd = rawCmd.split("@")[0].toLowerCase();

  const owner = isOwner(from?.id, env);

  // /start and /help in group: show simple info and don't restrict
  if (cmd === "/start") {
    await sendText(
      chatId,
      "I am a moderation bot.\n" +
        "Only configured owner IDs can use my commands.\n" +
        "I can delete links, forwards, and auto-mute violators.",
      env
    );
    return;
  }

  if (cmd === "/help") {
    await sendText(
      chatId,
      "Commands (only for configured owner IDs):\n" +
        "/status - show current filters for this group\n" +
        "/mute <time> (reply)\n" +
        "/unmute (reply)\n" +
        "/delafter <time> (reply)\n" +
        "/antilink <on|off>\n" +
        "/antiforward <on|off>",
      env
    );
    return;
  }

  if (!owner) {
    // Ignore all other commands from non-owners in groups
    return;
  }

  const settings = await loadSettings(chatId, env);

  switch (cmd) {
    case "/status": {
      const msg =
        `Status for this group:\n` +
        `antilink: ${settings.antilink}\n` +
        `antiforward: ${settings.antiforward}\n` +
        `auto_mute: ${settings.auto_mute}\n` +
        `auto_mute_minutes: ${settings.auto_mute_minutes}\n` +
        `max_violations: ${settings.max_violations}\n` +
        `whitelist: ${settings.whitelist.join(", ") || "(none)"}`;
      await sendText(chatId, msg, env);
      break;
    }

    case "/mute": {
      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chatId, "Reply to a user's message with /mute <time> (e.g. /mute 10m)", env);
        return;
      }
      const target = reply.from;
      const minutes = parseDuration(args[0], 24 * 60);
      await muteUser(chatId, target.id, minutes, env);
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
      await sendText(chatId, `🔊 Unmuted ${displayName(target)}.`, env);
      break;
    }

    case "/delafter": {
      const reply = message.reply_to_message;
      if (!reply) {
        await sendText(chatId, "Reply to a message with /delafter <time> (e.g. /delafter 10s or /delafter 2m)", env);
        return;
      }
      const seconds = parseSeconds(args[0], 10);
      const now = Math.floor(Date.now() / 1000);
      const task: DelTask = {
        chatId,
        messageId: reply.message_id,
        removeAt: now + seconds
      };
      await enqueueDelete(task, env);
      await sendText(
        chatId,
        `🧽 Message scheduled to be deleted in ${args[0] || "10s"}.`,
        env
      );
      break;
    }

    case "/antilink": {
      const val = args[0]?.toLowerCase();
      if (val !== "on" && val !== "off") {
        await sendText(chatId, "Usage: /antilink <on|off>", env);
        return;
      }
      settings.antilink = val === "on";
      await saveSettings(chatId, settings, env);
      await sendText(chatId, `antilink set to ${settings.antilink}`, env);
      break;
    }

    case "/antiforward": {
      const val = args[0]?.toLowerCase();
      if (val !== "on" && val !== "off") {
        await sendText(chatId, "Usage: /antiforward <on|off>", env);
        return;
      }
      settings.antiforward = val === "on";
      await saveSettings(chatId, settings, env);
      await sendText(chatId, `antiforward set to ${settings.antiforward}`, env);
      break;
    }

    default:
      // ignore unknown commands
      break;
  }
}

// ===== Main message handler =====

async function handleMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const chatId = chat.id.toString();

  // Register group if needed
  if (chat.type === "group" || chat.type === "supergroup") {
    await registerGroup(chat, env);
  }

  // Private chat
  if (chat.type === "private") {
    if (message.text?.startsWith("/")) {
      await handlePrivateCommand(message, env);
    } else {
      // Non-command in private
      const owner = isOwner(message.from?.id, env);
      if (owner) {
        await sendText(
          chatId,
          "Use /groups, /settings, /setg, /whitelist to manage your groups.\nUse /help for full list.",
          env
        );
      } else {
        await sendText(chatId, "Use /start to see what this bot does.", env);
      }
    }
    return;
  }

  // Group/supergroup only
  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  const text = message.text || message.caption || "";

  // Commands in group
  if (text.startsWith("/")) {
    await handleGroupCommand(message, env);
    return;
  }

  // Automatic moderation
  const from = message.from;
  if (!from) {
    return;
  }

  const settings = await loadSettings(chatId, env);

  // Forward filter
  if (settings.antiforward && isForwarded(message)) {
    await deleteMessage(chatId, message.message_id, env);
    await handleRuleViolation(chatId, from.id, settings, env);
    return;
  }

  // Link filter with whitelist
  if (settings.antilink && containsLink(text) && !isWhitelisted(text, settings.whitelist)) {
    await deleteMessage(chatId, message.message_id, env);
    await handleRuleViolation(chatId, from.id, settings, env);
    return;
  }
}

// ===== Worker export (fetch + cron) =====

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

    if (update?.message) {
      ctx.waitUntil(handleMessage(update.message, env));
    }

    return new Response("OK");
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await processDeleteQueue(env);
  }
};
