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
  forward_sender_name?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

type GroupConfig = {
  antilink: boolean;
  antiforward: boolean;
  autoMuteAfter: number;
  autoMuteMinutes: number;
  whitelistDomains: string[];
};

const DEFAULT_CONFIG: GroupConfig = {
  antilink: true,
  antiforward: true,
  autoMuteAfter: 3,
  autoMuteMinutes: 30,
  whitelistDomains: []
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
  }
};

async function handleMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;

  if (chat.type === "private") {
    await handlePrivate(message, env);
    return;
  }

  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  await registerGroup(chat, env);

  const chatId = chat.id.toString();
  const text = message.text || message.caption || "";

  if (text.startsWith("/")) {
    await handleGroupCommand(message, env);
    return;
  }

  const user = message.from;
  if (!user) return;

  const config = await getGroupConfig(chatId, env);

  const hasForward =
    !!message.forward_from ||
    !!message.forward_from_chat ||
    !!message.forward_sender_name;

  if (config.antiforward && hasForward) {
    await deleteMessage(chatId, message.message_id, env);
    await handleRuleViolation(chatId, user.id, env, config);
    return;
  }

  if (config.antilink) {
    const textHasLink = containsLink(text);
    let violation = false;

    if (textHasLink) {
      const domains = extractDomains(text);
      if (domains.length === 0) {
        violation = true;
      } else {
        const nonWhitelisted = domains.filter(
          d => !isDomainWhitelisted(d, config.whitelistDomains)
        );
        violation = nonWhitelisted.length > 0;
      }
    }

    if (violation) {
      await deleteMessage(chatId, message.message_id, env);
      await handleRuleViolation(chatId, user.id, env, config);
      return;
    }
  }
}

/* ---------- PRIVATE CHAT HANDLERS ---------- */

async function handlePrivate(message: TelegramMessage, env: Env): Promise<void> {
  const chatId = message.chat.id.toString();
  const text = (message.text || "").trim();
  if (!text.startsWith("/")) {
    await sendText(
      chatId,
      "Use /help to see available commands.",
      env
    );
    return;
  }

  const [cmd, ...rest] = text.split(" ");
  const command = cmd.split("@")[0];

  switch (command) {
    case "/start":
      await sendText(
        chatId,
        "Hi! I'm a group manager bot.\n\n" +
          "Add me as admin in groups.\n" +
          "In groups I can delete links/forwards and mute users.\n\n" +
          "In this private chat you can manage settings:\n" +
          "- /groups – list groups I know\n" +
          "- /settings <groupId>\n" +
          "- /set <groupId> <option> <value>\n" +
          "- /whitelist <groupId> <add|remove|list> [domain]",
        env
      );
      break;

    case "/help":
      await sendText(
        chatId,
        "Commands in this chat:\n\n" +
          "/groups – list groups\n" +
          "/settings <groupId> – show config\n" +
          "/set <groupId> <option> <value>\n" +
          "  options:\n" +
          "    antilink on|off\n" +
          "    antiforward on|off\n" +
          "    automute_after <number>\n" +
          "    automute_minutes <number>\n\n" +
          "/whitelist <groupId> <add|remove|list> [domain]",
        env
      );
      break;

    case "/groups":
      await handleGroupsList(chatId, env);
      break;

    case "/settings":
      await handleSettingsCommand(chatId, rest, env);
      break;

    case "/set":
      await handleSetCommand(chatId, rest, env);
      break;

    case "/whitelist":
      await handleWhitelistCommand(chatId, rest, env);
      break;

    default:
      await sendText(chatId, "Unknown command. Use /help.", env);
  }
}

async function handleGroupsList(chatId: string, env: Env): Promise<void> {
  const list = await env.BOT_CONFIG.list({ prefix: "group:" });
  if (!list.keys.length) {
    await sendText(chatId, "I don't know any groups yet. Add me to a group and send a message there.", env);
    return;
  }

  let lines: string[] = ["Groups I know:"];
  for (const k of list.keys) {
    const data = await env.BOT_CONFIG.get(k.name);
    if (!data) continue;
    try {
      const g = JSON.parse(data) as { id: string; title?: string; username?: string };
      const name = g.title || g.username || g.id;
      lines.push(`${name} – ${g.id}`);
    } catch {
      continue;
    }
  }
  await sendText(chatId, lines.join("\n\n"), env);
}

async function handleSettingsCommand(chatId: string, args: string[], env: Env): Promise<void> {
  const groupId = args[0];
  if (!groupId) {
    await sendText(chatId, "Usage: /settings <groupId>\nGet groupId from /groups.", env);
    return;
  }
  const config = await getGroupConfig(groupId, env);
  const text =
    `Settings for group ${groupId}:\n\n` +
    `antilink: ${config.antilink ? "on" : "off"}\n` +
    `antiforward: ${config.antiforward ? "on" : "off"}\n` +
    `autoMuteAfter: ${config.autoMuteAfter}\n` +
    `autoMuteMinutes: ${config.autoMuteMinutes}\n` +
    `whitelistDomains: ${
      config.whitelistDomains.length ? config.whitelistDomains.join(", ") : "(none)"
    }`;
  await sendText(chatId, text, env);
}

async function handleSetCommand(chatId: string, args: string[], env: Env): Promise<void> {
  const groupId = args[0];
  const option = args[1];
  const value = args[2];

  if (!groupId || !option || typeof value === "undefined") {
    await sendText(
      chatId,
      "Usage:\n" +
        "/set <groupId> antilink on|off\n" +
        "/set <groupId> antiforward on|off\n" +
        "/set <groupId> automute_after <number>\n" +
        "/set <groupId> automute_minutes <number>",
      env
    );
    return;
  }

  const config = await getGroupConfig(groupId, env);

  switch (option.toLowerCase()) {
    case "antilink":
      config.antilink = value.toLowerCase() === "on";
      break;
    case "antiforward":
      config.antiforward = value.toLowerCase() === "on";
      break;
    case "automute_after":
      config.autoMuteAfter = Math.max(1, parseInt(value, 10) || DEFAULT_CONFIG.autoMuteAfter);
      break;
    case "automute_minutes":
      config.autoMuteMinutes =
        Math.max(1, parseInt(value, 10) || DEFAULT_CONFIG.autoMuteMinutes);
      break;
    default:
      await sendText(chatId, "Unknown option. Use /help.", env);
      return;
  }

  await saveGroupConfig(groupId, config, env);
  await sendText(chatId, "Updated.\n\n" + await configToText(groupId, config), env);
}

async function handleWhitelistCommand(chatId: string, args: string[], env: Env): Promise<void> {
  const groupId = args[0];
  const action = args[1]?.toLowerCase();
  const domain = args[2]?.toLowerCase();

  if (!groupId || !action) {
    await sendText(
      chatId,
      "Usage:\n" +
        "/whitelist <groupId> list\n" +
        "/whitelist <groupId> add example.com\n" +
        "/whitelist <groupId> remove example.com",
      env
    );
    return;
  }

  const config = await getGroupConfig(groupId, env);

  if (action === "list") {
    const list = config.whitelistDomains.length
      ? config.whitelistDomains.join(", ")
      : "(none)";
    await sendText(chatId, `Whitelisted domains for ${groupId}:\n${list}`, env);
    return;
  }

  if (!domain) {
    await sendText(chatId, "Please provide a domain.", env);
    return;
  }

  if (action === "add") {
    if (!isDomainWhitelisted(domain, config.whitelistDomains)) {
      config.whitelistDomains.push(domain.toLowerCase());
    }
    await saveGroupConfig(groupId, config, env);
    await sendText(chatId, `Added ${domain} to whitelist.`, env);
  } else if (action === "remove") {
    config.whitelistDomains = config.whitelistDomains.filter(
      d => d.toLowerCase() !== domain.toLowerCase()
    );
    await saveGroupConfig(groupId, config, env);
    await sendText(chatId, `Removed ${domain} from whitelist.`, env);
  } else {
    await sendText(chatId, "Unknown action. Use add/remove/list.", env);
  }
}

async function configToText(groupId: string, config: GroupConfig): Promise<string> {
  return (
    `Settings for group ${groupId}:\n\n` +
    `antilink: ${config.antilink ? "on" : "off"}\n` +
    `antiforward: ${config.antiforward ? "on" : "off"}\n` +
    `autoMuteAfter: ${config.autoMuteAfter}\n` +
    `autoMuteMinutes: ${config.autoMuteMinutes}\n` +
    `whitelistDomains: ` +
    (config.whitelistDomains.length ? config.whitelistDomains.join(", ") : "(none)")
  );
}

/* ---------- GROUP COMMANDS (/mute, /unmute, /help) ---------- */

async function handleGroupCommand(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const chatId = chat.id.toString();
  const text = (message.text || "").trim();
  const [rawCmd, ...args] = text.split(" ");
  const cmd = rawCmd.split("@")[0];

  const from = message.from;
  const senderChat = message.sender_chat;

  const isAnonAdmin = senderChat && senderChat.id === chat.id;
  let isRealAdmin = false;
  if (from) {
    isRealAdmin = await isAdmin(chatId, from.id, env);
  }
  const admin = isAnonAdmin || isRealAdmin;

  switch (cmd) {
    case "/mute": {
      if (!admin) return;

      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendText(chatId, "Reply to a user's message with /mute <time>, e.g. /mute 10m", env);
        return;
      }
      const targetUser = reply.from;
      const durationMinutes = parseDuration(args[0]);
      const minutesLabel = args[0] || "24h";

      await muteUser(chatId, targetUser.id, durationMinutes, env);
      await sendText(
        chatId,
        `🔇 Muted ${displayName(targetUser)} for ${minutesLabel}.`,
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
      await sendText(chatId, `🔊 Unmuted ${displayName(targetUser)}.`, env);
      break;
    }

    case "/start":
    case "/help":
      await sendText(
        chatId,
        "I'm managing this group.\n\n" +
          "- I can delete links and forwards.\n" +
          "- Admins can /mute and /unmute by replying to a message.\n" +
          "- Change settings in my private chat with /groups and /settings.",
        env
      );
      break;

    default:
      break;
  }
}

/* ---------- CONFIG STORAGE ---------- */

async function getGroupConfig(chatId: string, env: Env): Promise<GroupConfig> {
  const key = `config:${chatId}`;
  const raw = await env.BOT_CONFIG.get(key);
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(raw) as GroupConfig;
    return {
      antilink: typeof parsed.antilink === "boolean" ? parsed.antilink : DEFAULT_CONFIG.antilink,
      antiforward:
        typeof parsed.antiforward === "boolean" ? parsed.antiforward : DEFAULT_CONFIG.antiforward,
      autoMuteAfter: parsed.autoMuteAfter || DEFAULT_CONFIG.autoMuteAfter,
      autoMuteMinutes: parsed.autoMuteMinutes || DEFAULT_CONFIG.autoMuteMinutes,
      whitelistDomains: parsed.whitelistDomains || []
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveGroupConfig(chatId: string, config: GroupConfig, env: Env): Promise<void> {
  const key = `config:${chatId}`;
  await env.BOT_CONFIG.put(key, JSON.stringify(config));
}

async function registerGroup(chat: TelegramChat, env: Env): Promise<void> {
  const key = `group:${chat.id}`;
  const data = {
    id: chat.id.toString(),
    title: chat.title,
    username: chat.username
  };
  await env.BOT_CONFIG.put(key, JSON.stringify(data));
}

/* ---------- MODERATION HELPERS ---------- */

async function handleRuleViolation(
  chatId: string,
  userId: number,
  env: Env,
  config: GroupConfig
): Promise<void> {
  const key = `violations:${chatId}:${userId}`;
  const current = (await env.BOT_CONFIG.get(key)) || "0";
  const count = parseInt(current, 10) || 0;
  const newCount = count + 1;

  await env.BOT_CONFIG.put(key, newCount.toString());

  if (newCount >= config.autoMuteAfter) {
    await muteUser(chatId, userId, config.autoMuteMinutes, env);
    await env.BOT_CONFIG.put(key, "0");
    await sendText(
      chatId,
      `🔇 User ${userId} auto-muted for ${config.autoMuteMinutes} minutes due to repeated violations.`,
      env
    );
  }
}

/* ---------- UTILITIES ---------- */

function containsLink(text: string | undefined): boolean {
  if (!text) return false;

  const patterns = [
    /https?:\/\/\S+/i,
    /www\.[^\s]+/i,
    /\b[\w-]+\.(com|net|org|io|gg|xyz|info|biz|co|me|tv|live)(\/\S*)?/i,
    /t\.me\/\S+/i,
    /telegram\.me\/\S+/i,
    /joinchat\/\S+/i
  ];

  return patterns.some(rx => rx.test(text));
}

function extractDomains(text: string): string[] {
  const domains = new Set<string>();
  const regex = /\b([a-z0-9-]+\.[a-z0-9.-]+)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    let d = match[1].toLowerCase();
    d = d.replace(/[.,!?:;]+$/, "");
    domains.add(d);
  }
  return Array.from(domains);
}

function isDomainWhitelisted(domain: string, whitelist: string[]): boolean {
  const d = domain.toLowerCase();
  return whitelist.some(w => d === w || d.endsWith("." + w));
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
  } catch {}

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

function parseDuration(arg: string | undefined): number {
  if (!arg) return 24 * 60;
  const match = arg.match(/^(\d+)(m|h|d)$/i);
  if (!match) return 24 * 60;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  if (unit === "d") return value * 60 * 24;
  return 24 * 60;
}
