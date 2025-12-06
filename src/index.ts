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
  // other fields not used for now
}

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
  }
};

async function handleMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const user = message.from;

  // Private messages: respond with info/help.
  if (chat.type === "private") {
    const text = message.text || "";
    if (text.startsWith("/start")) {
      await sendText(chat.id, "Hi! Add me to a group as admin.\n\nI will:\n- Delete ALL links\n- Allow admins to /mute and /unmute rule breakers (reply to their message).", env);
    } else {
      await sendText(chat.id, "I only work inside groups as an admin. Add me to a group and give me 'Delete messages' + 'Restrict members' rights.", env);
    }
    return;
  }

  // Only moderate in groups/supergroups
  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  const chatId = chat.id.toString();
  const text = message.text || message.caption || "";

  // Handle commands first
  if (text.startsWith("/")) {
    await handleCommand(message, env);
    return;
  }

  // Ignore if no user (system message, etc.)
  if (!user) return;

  // Delete messages with ANY kind of link
  if (containsLink(text)) {
    await deleteMessage(chatId, message.message_id, env);
    await handleRuleViolation(chatId, user.id, env);
    return;
  }
}

/**
 * Detect if a text contains a link (any type).
 */
function containsLink(text: string | undefined): boolean {
  if (!text) return false;

  const patterns = [
    /https?:\/\/\S+/i,                         // http:// or https://
    /www\.\S+\.\S+/i,                          // www.example.com
    /\b[\w-]+\.(com|net|org|io|gg|xyz|info|biz|co|me)(\/\S*)?/i, // bare domains
    /t\.me\/\S+/i,                             // Telegram invite links
    /telegram\.me\/\S+/i,
    /joinchat\/\S+/i
  ];

  return patterns.some(rx => rx.test(text));
}

/**
 * Track violations (links) and auto-mute user after 3 violations.
 */
async function handleRuleViolation(chatId: string, userId: number, env: Env): Promise<void> {
  const key = `violations:${chatId}:${userId}`;
  const current = (await env.BOT_CONFIG.get(key)) || "0";
  const count = parseInt(current, 10) || 0;
  const newCount = count + 1;

  await env.BOT_CONFIG.put(key, newCount.toString());

  if (newCount >= 3) {
    // Auto-mute for 30 minutes
    await muteUser(chatId, userId, 30, env);
    await env.BOT_CONFIG.put(key, "0"); // reset

    await sendText(
      chatId,
      `🔇 User ${userId} auto-muted for 30 minutes due to repeated link posting.`,
      env
    );
  }
}

/**
 * Handle commands (/mute, /unmute, etc.)
 */
async function handleCommand(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const chatId = chat.id.toString();
  const from = message.from;
  const text = message.text || "";

  if (!from) return;

  const [rawCmd, ...args] = text.split(" ");
  const cmd = rawCmd.split("@")[0]; // Strip @BotName if present

  // Only admins can use moderation commands
  const admin = await isAdmin(chatId, from.id, env);

  switch (cmd) {
    case "/mute": {
      if (!admin) return;

      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chatId, "Reply to a user's message with /mute <time>, e.g. /mute 10m or /mute 1h", env);
        return;
      }

      const targetUser = reply.from;
      const durationMinutes = parseDuration(args[0]); // 10m, 1h, 1d or default

      await muteUser(chatId, targetUser.id, durationMinutes, env);
      await sendText(
        chatId,
        `🔇 Muted ${displayName(targetUser)} for ${args[0] || "24h"}.`,
        env
      );
      break;
    }

    case "/unmute": {
      if (!admin) return;

      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chatId, "Reply to a user's message with /unmute", env);
        return;
      }

      const targetUser = reply.from;
      await unmuteUser(chatId, targetUser.id, env);
      await sendText(
        chatId,
        `🔊 Unmuted ${displayName(targetUser)}.`,
        env
      );
      break;
    }

    case "/help":
    case "/start": {
      // If used in group, show quick usage
      await sendText(
        chatId,
        "I help manage this group:\n\n- I delete ALL links.\n- Admins can mute a user: reply to their message with /mute 10m\n- Admins can unmute: reply with /unmute",
        env
      );
      break;
    }

    default:
      // ignore other commands for now
      break;
  }
}

/**
 * Parse duration for /mute command.
 * Examples: 10m, 1h, 1d.
 * Returns minutes.
 */
function parseDuration(arg: string | undefined): number {
  if (!arg) return 24 * 60; // default 24h

  const match = arg.match(/^(\d+)(m|h|d)$/i);
  if (!match) return 24 * 60;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  if (unit === "d") return value * 60 * 24;
  return 24 * 60;
}

/**
 * Mute user by restricting all send permissions.
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

/**
 * Unmute user by restoring permissions.
 */
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
 * Check if a user is admin/creator of a chat.
 */
async function isAdmin(chatId: string, userId: number, env: Env): Promise<boolean> {
  try {
    const res = await tgCall("getChatMember", env, {
      chat_id: chatId,
      user_id: userId
    });

    if (!res.ok) return false;
    const status = res.result.status;
    return status === "creator" || status === "administrator";
  } catch {
    return false;
  }
}

/**
 * Send a text message.
 */
async function sendText(chatId: number | string, text: string, env: Env): Promise<void> {
  await tgCall("sendMessage", env, {
    chat_id: chatId,
    text
  });
}

/**
 * Delete a message.
 */
async function deleteMessage(chatId: string, messageId: number, env: Env): Promise<void> {
  await tgCall("deleteMessage", env, {
    chat_id: chatId,
    message_id: messageId
  });
}

/**
 * Tiny helper to call Telegram API.
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
 * Nice display name for logs/messages.
 */
function displayName(user: TelegramUser): string {
  if (user.username) return `@${user.username}`;
  const fullName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  if (fullName) return fullName;
  return `${user.id}`;
}
