// Telegram group manager bot for Cloudflare Workers.
// Features:
// - Anti-link with domain whitelisting
// - Anti-forward (including forwarded stories)
// - Auto-warn + auto-mute after N violations
// - /del to delete messages after a delay
// - Auto-delete join/leave messages (toggle)
// - Group settings configurable from PM by owner(s) only
// - Temporary moderation messages auto-delete after 5 minutes
// - Uses cron trigger to process scheduled deletions
// - Tracks groups where the bot is added, removes them on leave

const TG_API_BASE = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  BOT_CONFIG: KVNamespace;
  OWNER_USER_IDS?: string; // comma-separated user IDs
}

/* ---------- Telegram basic types ---------- */

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel" | string;
  title?: string;
}

interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;

  text?: string;
  caption?: string;

  reply_to_message?: TgMessage;

  // forwards
  forward_from?: TgUser;
  forward_from_chat?: TgChat;
  forward_from_message_id?: number;
  forward_sender_name?: string;
  forward_date?: number;
  forward_origin?: unknown;
  is_automatic_forward?: boolean;

  // stories
  story?: unknown;

  // service
  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
}

interface TgChatMemberUpdate {
  chat: TgChat;
  from: TgUser;
  date: number;
  old_chat_member: {
    user: TgUser;
    status: string;
  };
  new_chat_member: {
    user: TgUser;
    status: string;
  };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  my_chat_member?: TgChatMemberUpdate;
}

/* ---------- Group config & keys ---------- */

interface GroupConfig {
  id: string;
  title: string;
  antiLink: boolean;
  antiForward: boolean;
  autoDeleteJoin: boolean;
  autoDeleteLeave: boolean;
  maxWarns: number;
  whitelist: string[];
}

const DEFAULT_GROUP_CONFIG: Omit<GroupConfig, "id" | "title"> = {
  antiLink: true,
  antiForward: true,
  autoDeleteJoin: true,
  autoDeleteLeave: true,
  maxWarns: 3,
  whitelist: []
};

function groupKey(chatId: string): string {
  return `g:${chatId}`;
}

function warnsKey(chatId: string, userId: number): string {
  return `w:${chatId}:${userId}`;
}

function scheduleKey(chatId: string | number, messageId: number): string {
  return `s:${chatId}:${messageId}`;
}

function userCurrentGroupKey(userId: number): string {
  return `u:${userId}:currentGroup`;
}

/* ---------- Helper: owners ---------- */

function getOwnerIds(env: Env): Set<number> {
  const s = env.OWNER_USER_IDS || "";
  return new Set(
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => parseInt(x, 10))
      .filter((x) => !Number.isNaN(x))
  );
}

function isOwner(userId: number | undefined, env: Env): boolean {
  if (!userId) return false;
  return getOwnerIds(env).has(userId);
}

/* ---------- Cloudflare entry points ---------- */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("OK");
    }

    let update: TgUpdate | null = null;
    try {
      update = await request.json<TgUpdate>();
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (!update) return new Response("No update", { status: 400 });

    if (update.message) {
      ctx.waitUntil(handleMessage(update.message, env));
    } else if (update.my_chat_member) {
      ctx.waitUntil(handleMyChatMember(update.my_chat_member, env));
    }

    return new Response("OK");
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduler(env));
  }
};

/* ---------- Main handlers ---------- */

async function handleMessage(msg: TgMessage, env: Env): Promise<void> {
  const chat = msg.chat;

  if (chat.type === "private") {
    await handlePrivateMessage(msg, env);
    return;
  }

  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  await handleGroupMessage(msg, env);
}

async function handleMyChatMember(update: TgChatMemberUpdate, env: Env): Promise<void> {
  const chat = update.chat;
  const botUser = update.new_chat_member.user;

  if (!botUser.is_bot) return;

  const chatId = String(chat.id);
  const status = update.new_chat_member.status;

  if (status === "member" || status === "administrator") {
    // (Re)create group config
    await getGroupConfig(chat, env);
  } else if (status === "left" || status === "kicked") {
    // Remove config when bot is removed
    await env.BOT_CONFIG.delete(groupKey(chatId));
  }
}

/* ---------- Group message handling ---------- */

async function handleGroupMessage(msg: TgMessage, env: Env): Promise<void> {
  const chat = msg.chat;
  const chatId = String(chat.id);
  const from = msg.from;
  const text = msg.text || msg.caption || "";

  const cfg = await getGroupConfig(chat, env);

  const isCommand = !!text.startsWith("/");
  if (isCommand) {
    await handleGroupCommand(msg, cfg, env);
    return;
  }

  // Auto-delete join/leave messages
  if (cfg.autoDeleteJoin && msg.new_chat_members && msg.new_chat_members.length > 0) {
    await deleteMessage(chatId, msg.message_id, env);
    return;
  }
  if (cfg.autoDeleteLeave && msg.left_chat_member) {
    await deleteMessage(chatId, msg.message_id, env);
    return;
  }

  if (!from) return;

  // Anti-forward
  if (cfg.antiForward && isForwarded(msg)) {
    await deleteMessage(chatId, msg.message_id, env);
    await registerViolation(chatId, from, "forward", cfg, env);
    return;
  }

  // Anti-link (unless every domain is whitelisted)
  if (cfg.antiLink && containsAnyLink(text)) {
    const domains = extractDomains(text);
    const nonWhitelisted = domains.filter((d) => !cfg.whitelist.includes(d.toLowerCase()));
    if (nonWhitelisted.length > 0) {
      await deleteMessage(chatId, msg.message_id, env);
      await registerViolation(chatId, from, "link", cfg, env);
      return;
    }
  }
}

async function handleGroupCommand(msg: TgMessage, cfg: GroupConfig, env: Env): Promise<void> {
  const chatId = String(msg.chat.id);
  const from = msg.from;
  const text = msg.text || "";
  if (!from) return;

  const [raw, ...rest] = text.split(" ");
  const cmd = raw.split("@")[0]; // strip @botname
  const arg = rest.join(" ").trim();

  // Only owners can run commands anywhere
  if (!isOwner(from.id, env)) {
    return;
  }

  switch (cmd) {
    case "/status": {
      const statusText = formatStatus(cfg);
      await sendText(chatId, statusText, env);
      break;
    }

    case "/mute": {
      const reply = msg.reply_to_message;
      if (!reply || !reply.from) {
        await sendTempMessage(chatId, "Reply to a user's message with /mute <time>, e.g. /mute 10m", 300, env);
        return;
      }
      const durationMinutes = parseDurationToMinutes(rest[0]);
      await muteUser(chatId, reply.from.id, durationMinutes, env);
      await sendTempMessage(
        chatId,
        `🔇 Muted ${displayName(reply.from)} for ${formatDuration(rest[0] || "24h")}.`,
        300,
        env
      );
      break;
    }

    case "/unmute": {
      const reply = msg.reply_to_message;
      if (!reply || !reply.from) {
        await sendTempMessage(chatId, "Reply to a user's message with /unmute", 300, env);
        return;
      }
      await unmuteUser(chatId, reply.from.id, env);
      await sendTempMessage(chatId, `🔊 Unmuted ${displayName(reply.from)}.`, 300, env);
      break;
    }

    case "/del": {
      const reply = msg.reply_to_message;
      if (!reply) {
        await sendTempMessage(
          chatId,
          "Reply to a message with /del <time>, e.g. /del 10s or /del 10m.",
          300,
          env
        );
        return;
      }
      const delaySeconds = parseDurationToSeconds(rest[0] || "10s");
      await scheduleDeletion(chatId, reply.message_id, delaySeconds, env);
      const res = await sendMessage(chatId, `🗑️ This message will be deleted in ${formatDuration(rest[0] || "10s")}.`, env);
      if (res?.ok) {
        const notifyId = res.result.message_id as number;
        await scheduleDeletion(chatId, notifyId, delaySeconds, env);
      }
      break;
    }

    default:
      // ignore other commands in group
      break;
  }
}

/* ---------- Private chat handling ---------- */

async function handlePrivateMessage(msg: TgMessage, env: Env): Promise<void> {
  const chatId = String(msg.chat.id);
  const user = msg.from;
  const text = msg.text || "";
  const [raw, ...rest] = text.split(" ");
  const cmd = raw.split("@")[0];
  const args = rest;

  if (!user) return;

  const owners = getOwnerIds(env);

  if (!owners.has(user.id)) {
    // Non-owners can only see a simple message.
    if (cmd === "/start" || cmd === "/help") {
      await sendText(
        chatId,
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
        chatId,
        [
          "Group Manager Bot",
          "",
          "Commands (PM, owner only):",
          "/groups - List groups where I'm added",
          "/use <group_id> - Select a group to manage",
          "/settings - Show settings for currently selected group",
          "/set <key> <value> - Change setting for selected group",
          "   keys: antilink, antiforward, autojoin, autoleave, maxwarns",
          "/whitelist add <domain> - Allow links from this domain",
          "/whitelist remove <domain>",
          "/whitelist list",
          "",
          "Commands (in groups, owner only):",
          "/status - Show filters for this group",
          "/mute <time> (reply) - Mute user (10m, 1h, 1d...)",
          "/unmute (reply) - Unmute user",
          "/del <time> (reply) - Delete that message after delay (e.g. 10s, 10m)",
          "",
          "Notes:",
          "- Auto-warn + auto-mute runs for links/forwards.",
          "- Warn/mute messages auto-delete after 5 minutes.",
          "- Join/leave messages can be auto-deleted via settings.",
          "- Commands from anonymous admins cannot be recognized by Telegram as coming from you."
        ].join("\n"),
        env
      );
      break;
    }

    case "/groups": {
      const groups = await listGroups(env);
      if (groups.length === 0) {
        await sendText(chatId, "I don't know any groups yet. Add me to a group as admin.", env);
        return;
      }
      const lines = groups.map((g) => `${g.title} — ${g.id}`);
      await sendText(chatId, "Groups I know:\n\n" + lines.join("\n"), env);
      break;
    }

    case "/use": {
      const id = args[0];
      if (!id) {
        await sendText(chatId, "Usage: /use <group_id>\nUse /groups to see available group IDs.", env);
        return;
      }
      const key = groupKey(id);
      const raw = await env.BOT_CONFIG.get(key);
      if (!raw) {
        await sendText(chatId, "I don't know that group ID. Make sure the bot is in that group.", env);
        return;
      }
      await env.BOT_CONFIG.put(userCurrentGroupKey(user.id), id);
      await sendText(chatId, `Now managing group ID ${id}. Use /settings or /set.`, env);
      break;
    }

    case "/settings": {
      const groupId = await getCurrentGroupIdForUser(user.id, env);
      if (!groupId) {
        await sendText(
          chatId,
          "No group selected.\nUse /groups to list groups, then /use <group_id> to select one.",
          env
        );
        return;
      }
      const cfg = await getGroupConfig({ id: parseInt(groupId, 10), type: "group" } as TgChat, env);
      await sendText(chatId, formatStatus(cfg), env);
      break;
    }

    case "/status": {
      const groupId = await getCurrentGroupIdForUser(user.id, env);
      if (!groupId) {
        await sendText(
          chatId,
          "No group selected.\nUse /groups to list groups, then /use <group_id> to select one.",
          env
        );
        return;
      }
      const cfg = await getGroupConfig({ id: parseInt(groupId, 10), type: "group" } as TgChat, env);
      await sendText(chatId, formatStatus(cfg), env);
      break;
    }

    case "/set": {
      const groupId = await getCurrentGroupIdForUser(user.id, env);
      if (!groupId) {
        await sendText(
          chatId,
          "No group selected.\nUse /groups to list groups, then /use <group_id> to select one.",
          env
        );
        return;
      }
      if (args.length < 2) {
        await sendText(
          chatId,
          "Usage: /set <key> <value>\nKeys: antilink on/off, antiforward on/off, autojoin on/off, autoleave on/off, maxwarns <number>",
          env
        );
        return;
      }
      const key = args[0].toLowerCase();
      const value = args[1].toLowerCase();

      const cfg = await getGroupConfig({ id: parseInt(groupId, 10), type: "group" } as TgChat, env);

      if (key === "antilink") {
        cfg.antiLink = value === "on";
      } else if (key === "antiforward") {
        cfg.antiForward = value === "on";
      } else if (key === "autojoin") {
        cfg.autoDeleteJoin = value === "on";
      } else if (key === "autoleave") {
        cfg.autoDeleteLeave = value === "on";
      } else if (key === "maxwarns") {
        const n = parseInt(value, 10);
        if (!Number.isNaN(n) && n > 0 && n <= 10) {
          cfg.maxWarns = n;
        } else {
          await sendText(chatId, "maxwarns must be between 1 and 10.", env);
          return;
        }
      } else {
        await sendText(
          chatId,
          "Unknown key. Use: antilink, antiforward, autojoin, autoleave, maxwarns.",
          env
        );
        return;
      }

      await saveGroupConfig(cfg, env);
      await sendText(chatId, "Updated settings:\n\n" + formatStatus(cfg), env);
      break;
    }

    case "/whitelist": {
      const groupId = await getCurrentGroupIdForUser(user.id, env);
      if (!groupId) {
        await sendText(
          chatId,
          "No group selected.\nUse /groups to list groups, then /use <group_id> to select one.",
          env
        );
        return;
      }
      const cfg = await getGroupConfig({ id: parseInt(groupId, 10), type: "group" } as TgChat, env);

      const sub = args[0]?.toLowerCase();
      const domain = (args[1] || "").toLowerCase();

      if (!sub || sub === "list") {
        if (cfg.whitelist.length === 0) {
          await sendText(chatId, "No domains whitelisted.", env);
        } else {
          await sendText(chatId, "Whitelisted domains:\n" + cfg.whitelist.join("\n"), env);
        }
        return;
      }

      if (!domain) {
        await sendText(chatId, "Usage: /whitelist add <domain> or /whitelist remove <domain>", env);
        return;
      }

      if (sub === "add") {
        if (!cfg.whitelist.includes(domain)) {
          cfg.whitelist.push(domain);
        }
        await saveGroupConfig(cfg, env);
        await sendText(chatId, `Added to whitelist: ${domain}`, env);
      } else if (sub === "remove") {
        cfg.whitelist = cfg.whitelist.filter((d) => d !== domain);
        await saveGroupConfig(cfg, env);
        await sendText(chatId, `Removed from whitelist: ${domain}`, env);
      } else {
        await sendText(chatId, "Usage: /whitelist add <domain> or /whitelist remove <domain>", env);
      }
      break;
    }

    default:
      // ignore unknown private commands for owners
      break;
  }
}

/* ---------- Config helpers ---------- */

async function getGroupConfig(chat: TgChat, env: Env): Promise<GroupConfig> {
  const id = String(chat.id);
  const key = groupKey(id);
  const raw = await env.BOT_CONFIG.get(key);
  if (!raw) {
    const cfg: GroupConfig = {
      id,
      title: chat.title || id,
      ...DEFAULT_GROUP_CONFIG
    };
    await env.BOT_CONFIG.put(key, JSON.stringify(cfg));
    return cfg;
  }
  let cfg: GroupConfig;
  try {
    cfg = JSON.parse(raw) as GroupConfig;
  } catch {
    cfg = {
      id,
      title: chat.title || id,
      ...DEFAULT_GROUP_CONFIG
    };
  }
  if (chat.title && chat.title !== cfg.title) {
    cfg.title = chat.title;
    await env.BOT_CONFIG.put(key, JSON.stringify(cfg));
  }
  return cfg;
}

async function saveGroupConfig(cfg: GroupConfig, env: Env): Promise<void> {
  await env.BOT_CONFIG.put(groupKey(cfg.id), JSON.stringify(cfg));
}

async function getCurrentGroupIdForUser(userId: number, env: Env): Promise<string | null> {
  const v = await env.BOT_CONFIG.get(userCurrentGroupKey(userId));
  return v || null;
}

async function listGroups(env: Env): Promise<GroupConfig[]> {
  const list = await env.BOT_CONFIG.list({ prefix: "g:" });
  const result: GroupConfig[] = [];
  for (const k of list.keys) {
    const raw = await env.BOT_CONFIG.get(k.name);
    if (!raw) continue;
    try {
      const cfg = JSON.parse(raw) as GroupConfig;
      result.push(cfg);
    } catch {
      // ignore broken entries
    }
  }
  return result;
}

function formatStatus(cfg: GroupConfig): string {
  return [
    `Group: ${cfg.title} (${cfg.id})`,
    "",
    `Anti-link: ${cfg.antiLink ? "ON" : "OFF"}`,
    `Anti-forward: ${cfg.antiForward ? "ON" : "OFF"}`,
    `Auto-delete join messages: ${cfg.autoDeleteJoin ? "ON" : "OFF"}`,
    `Auto-delete leave messages: ${cfg.autoDeleteLeave ? "ON" : "OFF"}`,
    `Max warns before mute: ${cfg.maxWarns}`,
    "",
    `Whitelisted domains: ${
      cfg.whitelist.length ? cfg.whitelist.join(", ") : "none"
    }`
  ].join("\n");
}

/* ---------- Violations / warnings ---------- */

async function registerViolation(
  chatId: string,
  user: TgUser,
  reason: "link" | "forward",
  cfg: GroupConfig,
  env: Env
): Promise<void> {
  const key = warnsKey(chatId, user.id);
  const raw = (await env.BOT_CONFIG.get(key)) || "0";
  const current = parseInt(raw, 10) || 0;
  const next = current + 1;
  await env.BOT_CONFIG.put(key, String(next));

  await sendTempMessage(
    chatId,
    `⚠️ Warning ${next}/${cfg.maxWarns} for ${displayName(user)} (${reason}).`,
    300,
    env
  );

  if (next >= cfg.maxWarns) {
    await env.BOT_CONFIG.put(key, "0");
    await muteUser(chatId, user.id, 30, env); // 30 minutes
    await sendTempMessage(
      chatId,
      `🔇 ${displayName(user)} has been auto-muted for 30 minutes (too many warnings).`,
      300,
      env
    );
  }
}

/* ---------- Scheduler ---------- */

async function scheduleDeletion(
  chatId: string | number,
  messageId: number,
  delaySeconds: number,
  env: Env
): Promise<void> {
  const when = Math.floor(Date.now() / 1000) + delaySeconds;
  await env.BOT_CONFIG.put(scheduleKey(chatId, messageId), String(when));
}

async function runScheduler(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const list = await env.BOT_CONFIG.list({ prefix: "s:" });

  for (const k of list.keys) {
    const keyName = k.name; // s:<chatId>:<msgId>
    const whenStr = await env.BOT_CONFIG.get(keyName);
    if (!whenStr) continue;
    const when = parseInt(whenStr, 10) || 0;
    if (when > now) continue;

    const parts = keyName.split(":");
    if (parts.length !== 3) {
      await env.BOT_CONFIG.delete(keyName);
      continue;
    }
    const chatId = parts[1];
    const msgId = parseInt(parts[2], 10);
    if (!Number.isNaN(msgId)) {
      await deleteMessage(chatId, msgId, env);
    }
    await env.BOT_CONFIG.delete(keyName);
  }
}

/* ---------- Telegram helpers ---------- */

async function tgCall(
  method: string,
  env: Env,
  body: Record<string, unknown>
): Promise<any> {
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

async function sendMessage(
  chatId: string | number,
  text: string,
  env: Env
): Promise<any> {
  return tgCall("sendMessage", env, {
    chat_id: chatId,
    text
  });
}

async function sendText(
  chatId: string | number,
  text: string,
  env: Env
): Promise<void> {
  await sendMessage(chatId, text, env);
}

async function sendTempMessage(
  chatId: string | number,
  text: string,
  ttlSeconds: number,
  env: Env
): Promise<void> {
  const res = await sendMessage(chatId, text, env);
  if (res?.ok) {
    const msgId = res.result.message_id as number;
    await scheduleDeletion(chatId, msgId, ttlSeconds, env);
  }
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

async function muteUser(
  chatId: string | number,
  userId: number,
  minutes: number,
  env: Env
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const untilDate = now + minutes * 60;
  const perms = {
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
    permissions: perms,
    until_date: untilDate
  });
}

async function unmuteUser(
  chatId: string | number,
  userId: number,
  env: Env
): Promise<void> {
  const perms = {
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
    permissions: perms
  });
}

/* ---------- Detection helpers ---------- */

function isForwarded(msg: TgMessage): boolean {
  return Boolean(
    msg.forward_from ||
      msg.forward_from_chat ||
      msg.forward_from_message_id ||
      msg.forward_sender_name ||
      msg.forward_origin ||
      msg.is_automatic_forward ||
      msg.forward_date ||
      msg.story // forwarded story
  );
}

function containsAnyLink(text: string | undefined): boolean {
  if (!text) return false;

  const linkRegex =
    /(https?:\/\/\S+)|(\bwww\.[^\s]+)|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|gg|xyz|info|biz|co|me|in|bd|uk|ru|tv|pro|live|shop|app)\b[^\s]*/i;

  const telegramRegex = /(t\.me\/\S+|telegram\.me\/\S+)/i;
  const emailRegex = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

  return linkRegex.test(text) || telegramRegex.test(text) || emailRegex.test(text);
}

function extractDomains(text: string | undefined): string[] {
  if (!text) return [];
  const domains: string[] = [];
  const domainRegex =
    /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|gg|xyz|info|biz|co|me|in|bd|uk|ru|tv|pro|live|shop|app)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = domainRegex.exec(text)) !== null) {
    domains.push(m[0].toLowerCase());
  }
  return domains;
}

/* ---------- Misc helpers ---------- */

function parseDurationToMinutes(token: string | undefined): number {
  const seconds = parseDurationToSeconds(token || "24h");
  return Math.max(1, Math.round(seconds / 60));
}

function parseDurationToSeconds(token: string): number {
  const m = token.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return 10; // default 10s
  const value = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === "s") return value;
  if (unit === "m") return value * 60;
  if (unit === "h") return value * 60 * 60;
  if (unit === "d") return value * 60 * 60 * 24;
  return 10;
}

function formatDuration(token: string): string {
  return token;
}

function displayName(user: TgUser): string {
  if (user.username) return `@${user.username}`;
  const full = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  return full || String(user.id);
}
