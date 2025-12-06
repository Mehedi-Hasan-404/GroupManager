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
  type: string;
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
}

interface KVListKey {
  name: string;
}

interface KVListResult {
  keys: KVListKey[];
  list_complete: boolean;
  cursor?: string;
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

    if (update && update.message) {
      ctx.waitUntil(handleMessage(update.message, env));
    }

    return new Response("OK");
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processDeleteTasks(env));
  }
};

async function handleMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const from = message.from;
  const chatId = chat.id.toString();
  const text = message.text || message.caption || "";

  if (chat.type === "private") {
    await handlePrivateMessage(message, env);
    return;
  }

  if (chat.type === "group" || chat.type === "supergroup") {
    await saveGroupInfo(chat, env);
    if (from && from.username) {
      await saveUsername(chatId, from.username, from.id, env);
    }

    if (text.startsWith("/")) {
      await handleGroupCommand(message, env);
      return;
    }

    if (!from) return;

    if (containsLink(text)) {
      await deleteMessage(chatId, message.message_id, env);
      await handleRuleViolation(chatId, from.id, env);
      return;
    }
  }
}

async function handlePrivateMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text || "";

  if (text.startsWith("/start")) {
    await sendText(
      chatId,
      "Hi! Add me to groups as admin.\n\nI will:\n- Delete ALL links\n- Auto-mute users after 3 link violations\n- Let admins /mute, /unmute\n- Let admins schedule deletes with /del 10s, /del 10m\n\nUse /groups (here in private chat) to see groups I am in.",
      env
    );
    return;
  }

  if (text.startsWith("/groups")) {
    await listGroups(chatId, env);
    return;
  }

  if (text.startsWith("/help")) {
    await sendText(
      chatId,
      "Commands:\n/groups - show groups where I am added\nAdd me to a group and make me admin to start moderating.",
      env
    );
    return;
  }

  await sendText(chatId, "Add me to a group and make me admin.\nUse /groups here to see groups.", env);
}

async function handleGroupCommand(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const chatId = chat.id.toString();
  const from = message.from;
  const text = message.text || "";

  if (!from) return;

  const [rawCmd, ...args] = text.split(" ");
  const cmd = rawCmd.split("@")[0];

  const admin = await isAdmin(chatId, from.id, env);

  switch (cmd) {
    case "/mute": {
      if (!admin) return;
      const target = await resolveTargetUser(message, args, env);
      if (!target) {
        await sendText(chatId, "Reply to a user's message or use /mute @username 10m", env);
        return;
      }
      const durationMinutes = parseDurationToMinutes(args[args.length - 1]);
      await muteUser(chatId, target.id, durationMinutes, env);
      await sendText(chatId, `Muted ${displayName(target)} for ${formatDuration(durationMinutes)}.`, env);
      break;
    }

    case "/unmute": {
      if (!admin) return;
      const target = await resolveTargetUser(message, args, env);
      if (!target) {
        await sendText(chatId, "Reply to a user's message or use /unmute @username", env);
        return;
      }
      await unmuteUser(chatId, target.id, env);
      await sendText(chatId, `Unmuted ${displayName(target)}.`, env);
      break;
    }

    case "/del": {
      if (!admin) return;
      const reply = message.reply_to_message;
      if (!reply) {
        await sendText(chatId, "Reply to a message with /del 10s or /del 10m or /del 1h", env);
        return;
      }
      const seconds = parseDurationToSeconds(args[0]);
      const deleteAt = Math.floor(Date.now() / 1000) + seconds;
      const key = `delete_task:${chatId}:${reply.message_id}`;
      const value = JSON.stringify({
        chatId,
        messageId: reply.message_id,
        deleteAt
      });
      await env.BOT_CONFIG.put(key, value);
      await sendText(chatId, `I will delete that message in ${formatDurationSeconds(seconds)}.`, env);
      break;
    }

    case "/help": {
      await sendText(
        chatId,
        "Group commands (admins only):\n/mute [time] (reply or @username)\n/unmute (reply or @username)\n/del <time> (reply) - delete msg later\n\nTime examples: 10s, 10m, 1h, 1d.",
        env
      );
      break;
    }

    default:
      break;
  }
}

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

async function handleRuleViolation(chatId: string, userId: number, env: Env): Promise<void> {
  const key = `violations:${chatId}:${userId}`;
  const current = (await env.BOT_CONFIG.get(key)) || "0";
  const count = parseInt(current, 10) || 0;
  const newCount = count + 1;
  await env.BOT_CONFIG.put(key, newCount.toString());
  if (newCount >= 3) {
    await muteUser(chatId, userId, 30, env);
    await env.BOT_CONFIG.put(key, "0");
    await sendText(chatId, `User ${userId} auto-muted for 30 minutes due to repeated link posting.`, env);
  }
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
    data = null;
  }
  if (!res.ok || (data && data.ok === false)) {
    console.error("Telegram API error", method, data || res.statusText);
  }
  return data;
}

function displayName(user: TelegramUser): string {
  if (user.username) return `@${user.username}`;
  const fullName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  if (fullName) return fullName;
  return `${user.id}`;
}

function parseDurationToMinutes(arg: string | undefined): number {
  if (!arg) return 24 * 60;
  const match = arg.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return 24 * 60;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === "s") return Math.max(1, Math.floor(value / 60));
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  if (unit === "d") return value * 60 * 24;
  return 24 * 60;
}

function parseDurationToSeconds(arg: string | undefined): number {
  if (!arg) return 10;
  const match = arg.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return 10;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === "s") return value;
  if (unit === "m") return value * 60;
  if (unit === "h") return value * 60 * 60;
  if (unit === "d") return value * 60 * 60 * 24;
  return 10;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours}h`;
  const days = hours / 24;
  return `${days}d`;
}

function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours}h`;
  const days = hours / 24;
  return `${days}d`;
}

async function saveGroupInfo(chat: TelegramChat, env: Env): Promise<void> {
  const key = `group:${chat.id}`;
  const value = JSON.stringify({
    id: chat.id,
    title: chat.title || "",
    type: chat.type,
    updatedAt: Date.now()
  });
  await env.BOT_CONFIG.put(key, value);
}

async function saveUsername(chatId: string, username: string, userId: number, env: Env): Promise<void> {
  const key = `user:${chatId}:${username.toLowerCase()}`;
  await env.BOT_CONFIG.put(key, userId.toString());
}

async function resolveTargetUser(message: TelegramMessage, args: string[], env: Env): Promise<TelegramUser | null> {
  const chatId = message.chat.id.toString();
  if (message.reply_to_message && message.reply_to_message.from) {
    return message.reply_to_message.from;
  }
  const maybeUser = args.find((a) => a.startsWith("@"));
  if (!maybeUser) return null;
  const username = maybeUser.replace("@", "").toLowerCase();
  const key = `user:${chatId}:${username}`;
  const userIdStr = await env.BOT_CONFIG.get(key);
  if (!userIdStr) return null;
  const userId = parseInt(userIdStr, 10);
  return { id: userId, username };
}

async function listGroups(chatId: number, env: Env): Promise<void> {
  let cursor: string | undefined = undefined;
  const lines: string[] = [];

  do {
    const res = (await env.BOT_CONFIG.list({ prefix: "group:", cursor })) as unknown as KVListResult;
    for (const key of res.keys) {
      const value = await env.BOT_CONFIG.get(key.name);
      if (!value) continue;
      const g = JSON.parse(value) as { id: number; title: string; type: string };
      lines.push(`${g.title || "(no title)"} [${g.id}]`);
    }
    cursor = res.cursor;
  } while (cursor);

  if (lines.length === 0) {
    await sendText(chatId, "No groups stored yet. Add me to some groups as admin and let people talk.", env);
  } else {
    await sendText(chatId, "Groups I am in:\n\n" + lines.join("\n"), env);
  }
}

async function processDeleteTasks(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let cursor: string | undefined = undefined;

  do {
    const res = (await env.BOT_CONFIG.list({ prefix: "delete_task:", cursor })) as unknown as KVListResult;
    for (const key of res.keys) {
      const value = await env.BOT_CONFIG.get(key.name);
      if (!value) continue;
      const task = JSON.parse(value) as { chatId: string; messageId: number; deleteAt: number };
      if (task.deleteAt <= now) {
        await deleteMessage(task.chatId, task.messageId, env);
        await env.BOT_CONFIG.delete(key.name);
      }
    }
    cursor = res.cursor;
  } while (cursor);
}
