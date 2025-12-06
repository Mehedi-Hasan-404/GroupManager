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
  sender_chat?: {
    id: number;
    title?: string;
    type?: string;
  };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface GroupSettings {
  antilink: boolean;
  maxViolations: number;
  autoMuteMinutes: number;
  whitelist: string[];
}

type GroupMap = { [chatId: string]: string };

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

    if (!update || !update.message) {
      return new Response("OK");
    }

    ctx.waitUntil(handleMessage(update.message, env));
    return new Response("OK");
  }
};

async function handleMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const text = message.text || message.caption || "";

  if (chat.type === "private") {
    if (text.startsWith("/")) {
      await handlePrivateCommand(message, env);
    } else {
      await sendText(
        chat.id,
        "Use /groups to see groups where I'm added.\nUse /help for more info.",
        env
      );
    }
    return;
  }

  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  const chatId = chat.id.toString();

  // Remember this group (for /groups in PM)
  await ensureGroupKnown(chat, env);

  const settings = await loadGroupSettings(chatId, env);

  if (text.startsWith("/")) {
    await handleGroupCommand(message, settings, env);
    return;
  }

  const user = message.from;
  if (!user) {
    return;
  }

  if (settings.antilink && containsBlockingLink(text, settings.whitelist)) {
    await deleteMessage(chatId, message.message_id, env);
    await handleRuleViolation(chatId, user.id, settings, env);
  }
}

/* =========================
   SETTINGS STORAGE HELPERS
   ========================= */

function defaultSettings(): GroupSettings {
  return {
    antilink: true,
    maxViolations: 3,
    autoMuteMinutes: 30,
    whitelist: []
  };
}

async function loadGroupSettings(chatId: string, env: Env): Promise<GroupSettings> {
  const key = `group:${chatId}:settings`;
  const json = await env.BOT_CONFIG.get(key);
  if (!json) return defaultSettings();
  try {
    const parsed = JSON.parse(json);
    return {
      ...defaultSettings(),
      ...parsed
    };
  } catch {
    return defaultSettings();
  }
}

async function saveGroupSettings(chatId: string, settings: GroupSettings, env: Env): Promise<void> {
  const key = `group:${chatId}:settings`;
  await env.BOT_CONFIG.put(key, JSON.stringify(settings));
}

async function ensureGroupKnown(chat: TelegramChat, env: Env): Promise<void> {
  const key = "groups:list";
  const raw = await env.BOT_CONFIG.get(key);
  let groups: GroupMap = {};
  if (raw) {
    try {
      groups = JSON.parse(raw);
    } catch {
      groups = {};
    }
  }
  const chatId = chat.id.toString();
  if (!groups[chatId]) {
    groups[chatId] = chat.title || chatId;
    await env.BOT_CONFIG.put(key, JSON.stringify(groups));
  }
}

/* =========================
   LINK DETECTION + WHITELIST
   ========================= */

function containsBlockingLink(text: string, whitelist: string[]): boolean {
  if (!text) return false;

  const regex = /((https?:\/\/)?([\w.-]+\.[a-z]{2,})(\/\S*)?)/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const domainRaw = match[3] || "";
    const domain = domainRaw.toLowerCase();
    if (!domain) continue;

    const allowed = whitelist.some(w => {
      const wl = w.toLowerCase();
      return domain === wl || domain.endsWith("." + wl);
    });

    if (!allowed) {
      return true;
    }
  }

  return false;
}

/* =========================
   VIOLATIONS & AUTO-MUTE
   ========================= */

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

  if (newCount >= settings.maxViolations) {
    await muteUser(chatId, userId, settings.autoMuteMinutes, env);
    await env.BOT_CONFIG.put(key, "0");

    await sendText(
      chatId,
      `🔇 User ${userId} auto-muted for ${settings.autoMuteMinutes} minutes due to repeated link posting.`,
      env
    );
  }
}

/* =========================
   GROUP COMMANDS (INSIDE GROUP)
   ========================= */

async function handleGroupCommand(
  message: TelegramMessage,
  settings: GroupSettings,
  env: Env
): Promise<void> {
  const chat = message.chat;
  const chatId = chat.id.toString();
  const text = message.text || "";
  const from = message.from;

  const [rawCmd, ...args] = text.split(" ");
  const cmd = rawCmd.split("@")[0];

  if (cmd === "/help" || cmd === "/start") {
    await sendText(
      chatId,
      "I manage this group:\n" +
        "- I delete links (unless whitelisted).\n" +
        "- I auto-mute users after too many violations.\n" +
        "- Admins (non-anonymous) can /mute and /unmute by replying to messages.",
      env
    );
    return;
  }

  if (cmd !== "/mute" && cmd !== "/unmute") {
    return;
  }

  if (!from) {
    await sendText(
      chatId,
      "I can't see which admin sent this because of anonymous mode. Turn off 'Remain anonymous' to use commands.",
      env
    );
    return;
  }

  const admin = await isAdmin(chatId, from.id, env);
  if (!admin) {
    return;
  }

  if (cmd === "/mute") {
    const reply = message.reply_to_message;
    if (!reply || !reply.from) {
      await sendText(
        chatId,
        "Reply to a user's message with `/mute 10m` or `/mute 1h`.",
        env
      );
      return;
    }
    const targetUser = reply.from;
    const minutes = parseDuration(args[0]) || settings.autoMuteMinutes;
    await muteUser(chatId, targetUser.id, minutes, env);
    await sendText(
      chatId,
      `🔇 Muted ${displayName(targetUser)} for ${minutes} minutes.`,
      env
    );
    return;
  }

  if (cmd === "/unmute") {
    const reply = message.reply_to_message;
    if (!reply || !reply.from) {
      await sendText(chatId, "Reply to a user's message with `/unmute`.", env);
      return;
    }
    const targetUser = reply.from;
    await unmuteUser(chatId, targetUser.id, env);
    await sendText(chatId, `🔊 Unmuted ${displayName(targetUser)}.`, env);
  }
}

/* =========================
   PRIVATE COMMANDS (PM WITH BOT)
   ========================= */

async function handlePrivateCommand(message: TelegramMessage, env: Env): Promise<void> {
  const chatId = message.chat.id;
  const from = message.from!;
  const text = message.text || "";

  const [rawCmd, ...args] = text.trim().split(" ");
  const cmd = rawCmd.split("@")[0];

  if (cmd === "/start" || cmd === "/help") {
    await sendText(
      chatId,
      "I am a group manager bot.\n\n" +
        "Commands (private chat):\n" +
        "/groups - show groups where I'm added and you are admin\n" +
        "/settings <group_id> - show settings for that group\n" +
        "/set <group_id> antilink on|off\n" +
        "/set <group_id> maxviolations <number>\n" +
        "/set <group_id> automute <minutes>\n" +
        "/set <group_id> whitelist add <domain>\n" +
        "/set <group_id> whitelist remove <domain>\n",
      env
    );
    return;
  }

  if (cmd === "/groups") {
    const key = "groups:list";
    const raw = await env.BOT_CONFIG.get(key);
    if (!raw) {
      await sendText(chatId, "I don't know any groups yet.", env);
      return;
    }
    let groups: GroupMap = {};
    try {
      groups = JSON.parse(raw);
    } catch {
      groups = {};
    }

    const entries = Object.entries(groups);
    if (entries.length === 0) {
      await sendText(chatId, "I don't know any groups yet.", env);
      return;
    }

    let result = "Groups I know (where you are admin):\n\n";
    for (const [gid, title] of entries) {
      const ok = await isAdmin(gid, from.id, env);
      if (ok) {
        result += `${title} – \`${gid}\`\n`;
      }
    }
    if (result.trim() === "Groups I know (where you are admin):") {
      result = "I don't see any groups where you are admin.";
    }

    await sendText(chatId, result, env);
    return;
  }

  if (cmd === "/settings") {
    if (args.length === 0) {
      await sendText(
        chatId,
        "Usage:\n/settings <group_id>\n\nGet the group id from /groups.",
        env
      );
      return;
    }
    const targetGroupId = args[0];
    const admin = await isAdmin(targetGroupId, from.id, env);
    if (!admin) {
      await sendText(chatId, "You are not an admin in that group.", env);
      return;
    }
    const settings = await loadGroupSettings(targetGroupId, env);
    const msg =
      `Settings for group ${targetGroupId}:\n` +
      `antilink: ${settings.antilink ? "ON" : "OFF"}\n` +
      `maxViolations: ${settings.maxViolations}\n` +
      `autoMuteMinutes: ${settings.autoMuteMinutes}\n` +
      `whitelist: ${settings.whitelist.join(", ") || "(none)"}`;
    await sendText(chatId, msg, env);
    return;
  }

  if (cmd === "/set") {
    if (args.length < 2) {
      await sendText(
        chatId,
        "Usage examples:\n" +
          "/set <group_id> antilink on\n" +
          "/set <group_id> maxviolations 3\n" +
          "/set <group_id> automute 30\n" +
          "/set <group_id> whitelist add example.com\n" +
          "/set <group_id> whitelist remove example.com",
        env
      );
      return;
    }

    const targetGroupId = args[0];
    const option = args[1].toLowerCase();
    const rest = args.slice(2);

    const admin = await isAdmin(targetGroupId, from.id, env);
    if (!admin) {
      await sendText(chatId, "You are not an admin in that group.", env);
      return;
    }

    const settings = await loadGroupSettings(targetGroupId, env);

    if (option === "antilink") {
      const v = (rest[0] || "").toLowerCase();
      settings.antilink = v === "on" || v === "true" || v === "1";
      await saveGroupSettings(targetGroupId, settings, env);
      await sendText(
        chatId,
        `antilink for ${targetGroupId} is now ${settings.antilink ? "ON" : "OFF"}.`,
        env
      );
      return;
    }

    if (option === "maxviolations") {
      const num = parseInt(rest[0] || "", 10);
      if (!num || num < 1) {
        await sendText(chatId, "maxviolations must be a positive number.", env);
        return;
      }
      settings.maxViolations = num;
      await saveGroupSettings(targetGroupId, settings, env);
      await sendText(
        chatId,
        `maxViolations for ${targetGroupId} set to ${num}.`,
        env
      );
      return;
    }

    if (option === "automute") {
      const num = parseInt(rest[0] || "", 10);
      if (!num || num < 1) {
        await sendText(chatId, "automute must be a positive number (minutes).", env);
        return;
      }
      settings.autoMuteMinutes = num;
      await saveGroupSettings(targetGroupId, settings, env);
      await sendText(
        chatId,
        `autoMuteMinutes for ${targetGroupId} set to ${num}.`,
        env
      );
      return;
    }

    if (option === "whitelist") {
      const sub = (rest[0] || "").toLowerCase();
      const domain = (rest[1] || "").toLowerCase();
      if (!domain) {
        await sendText(
          chatId,
          "Usage:\n/set <group_id> whitelist add example.com\n/set <group_id> whitelist remove example.com",
          env
        );
        return;
      }

      if (sub === "add") {
        if (!settings.whitelist.includes(domain)) {
          settings.whitelist.push(domain);
        }
        await saveGroupSettings(targetGroupId, settings, env);
        await sendText(
          chatId,
          `Added ${domain} to whitelist for ${targetGroupId}.`,
          env
        );
        return;
      }

      if (sub === "remove") {
        settings.whitelist = settings.whitelist.filter(d => d !== domain);
        await saveGroupSettings(targetGroupId, settings, env);
        await sendText(
          chatId,
          `Removed ${domain} from whitelist for ${targetGroupId}.`,
          env
        );
        return;
      }
    }

    await sendText(chatId, "Unknown option. Use /help for examples.", env);
    return;
  }

  await sendText(chatId, "Unknown command. Use /help.", env);
}

/* =========================
   UTILITIES
   ========================= */

function parseDuration(arg: string | undefined): number {
  if (!arg) return 0;
  const m = arg.match(/^(\d+)(m|h|d)$/i);
  if (!m) return 0;
  const value = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  if (unit === "d") return value * 60 * 24;
  return 0;
}

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

async function isAdmin(chatId: string | number, userId: number, env: Env): Promise<boolean> {
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

async function sendText(chatId: number | string, text: string, env: Env): Promise<void> {
  await tgCall("sendMessage", env, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown"
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
