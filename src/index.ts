const TG_API_BASE = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  KV_BINDING: KVNamespace;
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
  username?: string;
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

type GroupSettings = {
  autoMuteAfterViolations: number;
  autoMuteDurationMinutes: number;
  manualMuteDefaultMinutes: number;
};

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
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(processScheduledDeletes(env));
  }
};

async function handleMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const user = message.from;
  const chatId = chat.id.toString();

  if (chat.type === "private") {
    const text = message.text || "";
    if (text.startsWith("/start") || text.startsWith("/help")) {
      await sendText(
        chatId,
        "Hi! Add me to groups as admin.\n\nI can:\n- Delete ALL links\n- Auto-mute spammers\n- /mute & /unmute users (reply)\n- /delafter 10s (reply) to delete later\n- /settings to see config\n- /set to change config\nIn private chat, send /groups to see groups.",
        env
      );
    } else if (text.startsWith("/groups")) {
      await showGroups(chatId, env);
    } else {
      await sendText(chatId, "Use /help to see what I can do.", env);
    }
    return;
  }

  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  await trackGroup(chat, env);

  const text = message.text || message.caption || "";

  if (text.startsWith("/")) {
    await handleCommand(message, env);
    return;
  }

  if (!user) return;

  const settings = await getSettings(chatId, env);

  if (containsLink(text)) {
    await deleteMessage(chatId, message.message_id, env);
    await handleRuleViolation(chatId, user.id, settings, env);
    return;
  }
}

/* SETTINGS & GROUPS */

function defaultSettings(): GroupSettings {
  return {
    autoMuteAfterViolations: 3,
    autoMuteDurationMinutes: 30,
    manualMuteDefaultMinutes: 24 * 60
  };
}

async function getSettings(chatId: string, env: Env): Promise<GroupSettings> {
  const key = `settings:${chatId}`;
  const raw = await env.KV_BINDING.get(key);
  if (!raw) return defaultSettings();
  try {
    const parsed = JSON.parse(raw);
    return { ...defaultSettings(), ...parsed };
  } catch {
    return defaultSettings();
  }
}

async function saveSettings(chatId: string, settings: GroupSettings, env: Env): Promise<void> {
  const key = `settings:${chatId}`;
  await env.KV_BINDING.put(key, JSON.stringify(settings));
}

async function trackGroup(chat: TelegramChat, env: Env): Promise<void> {
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  const key = `group:${chat.id}`;
  const data = {
    id: chat.id,
    type: chat.type,
    title: chat.title || "",
    username: chat.username || ""
  };
  await env.KV_BINDING.put(key, JSON.stringify(data));
}

async function showGroups(chatId: string, env: Env): Promise<void> {
  const list = await env.KV_BINDING.list({ prefix: "group:", limit: 50 });
  if (list.keys.length === 0) {
    await sendText(chatId, "I don't see any groups yet. Add me as admin to your groups.", env);
    return;
  }

  let text = "Groups I know:\n\n";
  for (const k of list.keys) {
    const raw = await env.KV_BINDING.get(k.name);
    if (!raw) continue;
    try {
      const g = JSON.parse(raw) as { id: number; title: string; username?: string };
      const title = g.title || "(no title)";
      const handle = g.username ? ` (@${g.username})` : "";
      text += `- ${title}${handle} (ID: ${g.id})\n`;
    } catch {
      continue;
    }
  }

  await sendText(chatId, text, env);
}

/* LINK + VIOLATIONS */

function containsLink(text: string | undefined): boolean {
  if (!text) return false;
  const patterns = [
    /https?:\/\/\S+/i,
    /www\.\S+\.\S+/i,
    /\b[\w-]+\.(com|net|org|io|gg|xyz|info|biz|co|me)(\/\S*)?/i,
    /t\.me\/\S+/i,
    /telegram\.me\/\S+/i,
    /joinchat\/\S+/i
  ];
  return patterns.some((rx) => rx.test(text));
}

async function handleRuleViolation(
  chatId: string,
  userId: number,
  settings: GroupSettings,
  env: Env
): Promise<void> {
  const key = `violations:${chatId}:${userId}`;
  const current = (await env.KV_BINDING.get(key)) || "0";
  const count = parseInt(current, 10) || 0;
  const newCount = count + 1;
  await env.KV_BINDING.put(key, newCount.toString());

  if (newCount >= settings.autoMuteAfterViolations) {
    await muteUser(chatId, userId, settings.autoMuteDurationMinutes, env);
    await env.KV_BINDING.put(key, "0");
    await sendText(
      chatId,
      `🔇 User ${userId} auto-muted for ${settings.autoMuteDurationMinutes} minutes due to repeated link posting.`,
      env
    );
  }
}

/* COMMANDS */

async function handleCommand(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const chatId = chat.id.toString();
  const from = message.from;
  const text = message.text || "";

  const [rawCmd, ...args] = text.split(" ");
  const cmd = rawCmd.split("@")[0];

  if (!from) return;

  if (chat.type === "private") {
    if (cmd === "/groups") {
      await showGroups(chatId, env);
      return;
    }
    if (cmd === "/start" || cmd === "/help") {
      await sendText(
        chatId,
        "Use /groups here to see groups.\nInside a group:\n- reply + /mute 10m\n- reply + /unmute\n- reply + /delafter 10s\n- /settings and /set",
        env
      );
      return;
    }
    return;
  }

  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const isFromAdmin = await isAdmin(chatId, from.id, env);
  const settings = await getSettings(chatId, env);

  switch (cmd) {
    case "/mute": {
      if (!isFromAdmin) return;
      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chatId, "Reply to a user's message with /mute 10m", env);
        return;
      }
      const targetUser = reply.from;
      const seconds = parseDurationSeconds(args[0], settings.manualMuteDefaultMinutes * 60);
      const minutes = Math.max(1, Math.round(seconds / 60));
      await muteUser(chatId, targetUser.id, minutes, env);
      await sendText(
        chatId,
        `🔇 Muted ${displayName(targetUser)} for ${args[0] || `${minutes}m`}.`,
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
      const targetUser = reply.from;
      await unmuteUser(chatId, targetUser.id, env);
      await sendText(chatId, `🔊 Unmuted ${displayName(targetUser)}.`, env);
      break;
    }

    case "/delafter": {
      if (!isFromAdmin) return;
      const reply = message.reply_to_message;
      if (!reply) {
        await sendText(chatId, "Reply to a message with /delafter 10s or /delafter 10m", env);
        return;
      }
      const targetMessageId = reply.message_id;
      const seconds = parseDurationSeconds(args[0], 10);
      const now = Math.floor(Date.now() / 1000);
      const deleteAt = now + seconds;
      const key = `del:${chatId}:${targetMessageId}`;
      await env.KV_BINDING.put(key, deleteAt.toString());
      await sendText(chatId, `🕒 Will delete that message in ${args[0] || `${seconds}s`}.`, env);
      break;
    }

    case "/settings": {
      if (!isFromAdmin) return;
      const msg =
        "Current settings:\n" +
        `- Auto-mute after violations: ${settings.autoMuteAfterViolations}\n` +
        `- Auto-mute duration: ${settings.autoMuteDurationMinutes} minutes\n` +
        `- Manual /mute default: ${settings.manualMuteDefaultMinutes} minutes\n\n` +
        "Change with:\n" +
        "/set automute_violations 3\n" +
        "/set automute_duration 30m\n" +
        "/set mute_default 1h";
      await sendText(chatId, msg, env);
      break;
    }

    case "/set": {
      if (!isFromAdmin) return;
      const key = args[0];
      const value = args[1];
      if (!key || !value) {
        await sendText(
          chatId,
          "Usage:\n/set automute_violations 3\n/set automute_duration 30m\n/set mute_default 1h",
          env
        );
        return;
      }

      if (key === "automute_violations") {
        const num = parseInt(value, 10);
        if (!num || num < 1) {
          await sendText(chatId, "automute_violations must be a number >= 1", env);
          return;
        }
        settings.autoMuteAfterViolations = num;
      } else if (key === "automute_duration") {
        const seconds = parseDurationSeconds(value, settings.autoMuteDurationMinutes * 60);
        settings.autoMuteDurationMinutes = Math.max(1, Math.round(seconds / 60));
      } else if (key === "mute_default") {
        const seconds = parseDurationSeconds(value, settings.manualMuteDefaultMinutes * 60);
        settings.manualMuteDefaultMinutes = Math.max(1, Math.round(seconds / 60));
      } else {
        await sendText(chatId, "Unknown setting key.", env);
        return;
      }

      await saveSettings(chatId, settings, env);
      await sendText(chatId, "✅ Settings updated.", env);
      break;
    }

    case "/help":
    case "/start": {
      await sendText(
        chatId,
        "Commands (admins):\n" +
          "- reply + /mute 10m\n" +
          "- reply + /unmute\n" +
          "- reply + /delafter 10s\n" +
          "- /settings\n" +
          "- /set automute_violations 3\n" +
          "- /set automute_duration 30m\n" +
          "- /set mute_default 1h",
        env
      );
      break;
    }

    default:
      break;
  }
}

/* DURATION, MUTE, UNMUTE, ADMIN, TG HELPERS */

function parseDurationSeconds(arg: string | undefined, defaultSeconds: number): number {
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

async function isAdmin(chatId: string, userId: number, env: Env): Promise<boolean> {
  try {
    const data = await tgCall("getChatMember", env, {
      chat_id: chatId,
      user_id: userId
    });
    if (!data || data.ok === false) return false;
    const status = data.result.status;
    return status === "creator" || status === "administrator";
  } catch {
    return false;
  }
}

async function sendText(chatId: string | number, text: string, env: Env): Promise<void> {
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

/* SCHEDULED DELETE PROCESSOR */

async function processScheduledDeletes(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const list = await env.KV_BINDING.list({ prefix: "del:", limit: 100 });

  for (const key of list.keys) {
    const value = await env.KV_BINDING.get(key.name);
    if (!value) {
      await env.KV_BINDING.delete(key.name);
      continue;
    }
    const deleteAt = parseInt(value, 10) || 0;
    if (deleteAt > now) continue;

    const parts = key.name.split(":");
    if (parts.length < 3) {
      await env.KV_BINDING.delete(key.name);
      continue;
    }
    const chatId = parts[1];
    const messageId = parseInt(parts[2], 10);
    if (!Number.isNaN(messageId)) {
      await deleteMessage(chatId, messageId, env);
    }
    await env.KV_BINDING.delete(key.name);
  }
}
