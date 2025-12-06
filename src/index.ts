// Telegram Group Manager Bot for Cloudflare Workers
// Features:
// - Anti-link with regex + domain whitelist
// - Anti-forward (including forwarded stories)
// - Auto-warn (3 -> auto mute, then reset to 0)
// - Warn/mute messages auto-delete after 5 minutes
// - /del <time> to delete replied message later (cron-based)
// - Auto delete join/leave service messages (per-group)
// - Per-group settings managed from bot PM (/groups, /settings, /set)
// - Only OWNER_USER_IDS can use management/command features (including anonymous admins via group id)
// - Group list updates when bot is removed

const TG_API_BASE = "https://api.telegram.org";

// ---------- Env & basic types ----------

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  OWNER_USER_IDS?: string;
  BOT_CONFIG: KVNamespace;
}

type ChatType = "private" | "group" | "supergroup" | "channel" | string;

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: ChatType;
  title?: string;
}

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat; // for anonymous admins / channels
  chat: TelegramChat;
  date?: number;

  text?: string;
  caption?: string;

  // Forwards / stories
  forward_from?: any;
  forward_from_chat?: any;
  forward_origin?: any;
  is_automatic_forward?: boolean;
  story?: any;           // forwarded story
  reply_to_story?: any;  // replies to story (we don't need, but keep)

  // Entities (urls etc.)
  entities?: any[];
  caption_entities?: any[];

  // Reply
  reply_to_message?: TelegramMessage;

  // Join/leave
  new_chat_members?: TelegramUser[];
  left_chat_member?: TelegramUser;
}

interface MyChatMemberUpdate {
  chat: TelegramChat;
  from: TelegramUser;
  date: number;
  old_chat_member: { status: string };
  new_chat_member: { status: string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  my_chat_member?: MyChatMemberUpdate;
}

// ---------- Group settings and meta ----------

interface GroupSettings {
  antiLink: boolean;
  antiForward: boolean;
  whitelistDomains: string[];
  warnThreshold: number;
  autoDeleteJoin: boolean;
  autoDeleteLeave: boolean;
}

interface GroupMeta {
  id: string;
  title?: string;
  active: boolean;
  lastSeen: number;
}

const SETTINGS_PREFIX = "group:settings:";
const META_PREFIX = "group:meta:";
const GROUP_INDEX_KEY = "groups:index";
const WARN_PREFIX = "warns:";
const DEL_BUCKET_PREFIX = "delbucket:"; // delbucket:<minute> -> JSON array of jobs

type ViolationReason = "link" | "forward" | "story" | "service";

// Scheduled deletion job
interface DeleteJob {
  chat_id: string;
  message_id: number;
  also_delete_id?: number;
}

// ---------- Helpers: owners / actors ----------

function parseOwnerSet(env: Env): Set<string> {
  const raw = env.OWNER_USER_IDS || "";
  const parts = raw.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  return new Set(parts);
}

// Who is actually "doing" this action
function getActorId(message: TelegramMessage): string | null {
  // Normal user
  if (message.from && !message.from.is_bot) {
    return String(message.from.id);
  }
  // Anonymous admin / channel
  if (message.sender_chat) {
    return String(message.sender_chat.id);
  }
  return null;
}

function isOwnerActor(message: TelegramMessage, env: Env): boolean {
  const owners = parseOwnerSet(env);
  const actorId = getActorId(message);
  if (!actorId) return false;
  return owners.has(actorId);
}

// ---------- Helpers: KV for settings/meta ----------

function defaultSettings(): GroupSettings {
  return {
    antiLink: true,
    antiForward: true,
    whitelistDomains: [],
    warnThreshold: 3,
    autoDeleteJoin: false,
    autoDeleteLeave: false,
  };
}

async function getGroupSettings(chatId: string, env: Env): Promise<GroupSettings> {
  const key = SETTINGS_PREFIX + chatId;
  const raw = await env.BOT_CONFIG.get(key);
  if (!raw) return defaultSettings();
  try {
    const parsed = JSON.parse(raw);
    return {
      ...defaultSettings(),
      ...parsed,
      whitelistDomains: Array.isArray(parsed.whitelistDomains)
        ? parsed.whitelistDomains
        : [],
    };
  } catch {
    return defaultSettings();
  }
}

async function saveGroupSettings(chatId: string, settings: GroupSettings, env: Env) {
  const key = SETTINGS_PREFIX + chatId;
  await env.BOT_CONFIG.put(key, JSON.stringify(settings));
}

async function registerGroup(chat: TelegramChat, env: Env) {
  const id = String(chat.id);
  const now = Math.floor(Date.now() / 1000);
  const metaKey = META_PREFIX + id;
  const raw = await env.BOT_CONFIG.get(metaKey);
  let meta: GroupMeta;
  if (raw) {
    try {
      meta = JSON.parse(raw);
    } catch {
      meta = { id, title: chat.title, active: true, lastSeen: now };
    }
  } else {
    meta = { id, title: chat.title, active: true, lastSeen: now };
  }
  meta.active = true;
  meta.title = chat.title || meta.title;
  meta.lastSeen = now;
  await env.BOT_CONFIG.put(metaKey, JSON.stringify(meta));

  // Update index of groups
  const idxRaw = await env.BOT_CONFIG.get(GROUP_INDEX_KEY);
  let ids: string[] = [];
  if (idxRaw) {
    try {
      ids = JSON.parse(idxRaw);
      if (!Array.isArray(ids)) ids = [];
    } catch {
      ids = [];
    }
  }
  if (!ids.includes(id)) {
    ids.push(id);
    await env.BOT_CONFIG.put(GROUP_INDEX_KEY, JSON.stringify(ids));
  }
}

async function setGroupActive(chatId: string, active: boolean, env: Env) {
  const metaKey = META_PREFIX + chatId;
  const raw = await env.BOT_CONFIG.get(metaKey);
  const now = Math.floor(Date.now() / 1000);
  let meta: GroupMeta = { id: chatId, active, lastSeen: now };
  if (raw) {
    try {
      meta = { ...meta, ...JSON.parse(raw) };
    } catch {
      // ignore
    }
  }
  meta.active = active;
  meta.lastSeen = now;
  await env.BOT_CONFIG.put(metaKey, JSON.stringify(meta));
}

// ---------- Helpers: Telegram API ----------

async function tgCall(
  method: string,
  env: Env,
  body: Record<string, unknown>
): Promise<any> {
  const url = `${TG_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

async function sendText(
  chatId: string | number,
  text: string,
  env: Env
): Promise<TelegramMessage | null> {
  const data = await tgCall("sendMessage", env, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  });
  if (data && data.ok && data.result) {
    return data.result as TelegramMessage;
  }
  return null;
}

async function deleteMessage(chatId: string | number, messageId: number, env: Env) {
  await tgCall("deleteMessage", env, {
    chat_id: chatId,
    message_id: messageId,
  });
}

// send ephemeral message that auto-deletes after delaySeconds
async function sendEphemeralText(
  chatId: string | number,
  text: string,
  delaySeconds: number,
  env: Env
) {
  const msg = await sendText(chatId, text, env);
  if (msg) {
    await scheduleDelete(String(chatId), msg.message_id, delaySeconds, env);
  }
}

// ---------- Warns & moderation ----------

async function getWarnCount(chatId: string, userId: number, env: Env): Promise<number> {
  const key = `${WARN_PREFIX}${chatId}:${userId}`;
  const raw = await env.BOT_CONFIG.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  return isNaN(count) ? 0 : count;
}

async function setWarnCount(chatId: string, userId: number, count: number, env: Env) {
  const key = `${WARN_PREFIX}${chatId}:${userId}`;
  await env.BOT_CONFIG.put(key, String(count));
}

async function addWarning(
  chatId: string,
  user: TelegramUser,
  settings: GroupSettings,
  reason: ViolationReason,
  env: Env
) {
  const current = await getWarnCount(chatId, user.id, env);
  const newCount = current + 1;

  await setWarnCount(chatId, user.id, newCount, env);

  const reasonText =
    reason === "link"
      ? "sending links"
      : reason === "forward"
      ? "forwarding messages"
      : reason === "story"
      ? "forwarding stories"
      : "violating rules";

  const text = `⚠️ <b>Warning ${newCount}/${settings.warnThreshold}</b> for <a href="tg://user?id=${user.id}">${escapeHtml(
    displayName(user)
  )}</a>\nReason: ${reasonText}`;

  // warn message auto-delete after 5 minutes
  await sendEphemeralText(chatId, text, 5 * 60, env);

  if (newCount >= settings.warnThreshold) {
    // auto-mute and reset warn count
    await muteUser(chatId, user.id, 30, env); // 30 minutes
    await setWarnCount(chatId, user.id, 0, env);

    const muteText = `🔇 <b>Auto mute</b> for <a href="tg://user?id=${user.id}">${escapeHtml(
      displayName(user)
    )}</a>\nReason: too many warnings. Duration: 30 minutes.`;

    await sendEphemeralText(chatId, muteText, 5 * 60, env);
  }
}

// 30 minutes default; parse from /mute
function parseDurationToMinutes(arg: string | undefined): number {
  if (!arg) return 24 * 60; // default 24h
  const m = arg.trim().match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return 24 * 60;
  const value = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === "s") return Math.max(1, Math.round(value / 60));
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  if (unit === "d") return value * 60 * 24;
  return 24 * 60;
}

async function muteUser(chatId: string, userId: number, minutes: number, env: Env) {
  const now = Math.floor(Date.now() / 1000);
  const until = now + minutes * 60;

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
    can_add_web_page_previews: false,
  };

  await tgCall("restrictChatMember", env, {
    chat_id: chatId,
    user_id: userId,
    permissions,
    until_date: until,
  });
}

async function unmuteUser(chatId: string, userId: number, env: Env) {
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
    can_add_web_page_previews: true,
  };

  await tgCall("restrictChatMember", env, {
    chat_id: chatId,
    user_id: userId,
    permissions,
  });
}

// ---------- Link detection + whitelist ----------

function escapeHtml(text: string): string {
  return text.replace(/[<&>"]/g, (c) => {
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    if (c === "&") return "&amp;";
    if (c === '"') return "&quot;";
    return c;
  });
}

function displayName(user: TelegramUser): string {
  if (user.username) return `@${user.username}`;
  const full = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  return full || String(user.id);
}

function extractDomainsFromText(text: string): string[] {
  const domains: string[] = [];
  const regex = /((https?:\/\/|www\.)[^\s]+|[\w.-]+\.(com|net|org|io|gg|xyz|info|biz|co|me|in|bd|ru|cn|uk|de|fr)(\/\S*)?)/gi;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    let url = match[0];
    url = url.replace(/^https?:\/\//i, "");
    url = url.replace(/^www\./i, "");
    const host = url.split(/[\/?#]/)[0];
    if (host && !domains.includes(host.toLowerCase())) {
      domains.push(host.toLowerCase());
    }
  }
  return domains;
}

function isLinkMessage(message: TelegramMessage): boolean {
  const text = message.text || message.caption || "";
  if (!text) return false;

  // Entities from Telegram (url / text_link)
  const hasEntityLink = (entities?: any[]) =>
    !!entities &&
    entities.some((e) => e.type === "url" || e.type === "text_link" || e.type === "mention");

  if (hasEntityLink(message.entities) || hasEntityLink(message.caption_entities)) {
    return true;
  }

  // Regex-based detection
  const patterns = [
    /https?:\/\/\S+/i,
    /www\.\S+\.\S+/i,
    /\b[\w.-]+\.(com|net|org|io|gg|xyz|info|biz|co|me|in|bd|ru|cn|uk|de|fr)(\/\S*)?/i,
    /t\.me\/\S+/i,
    /telegram\.me\/\S+/i,
    /joinchat\/\S+/i,
  ];

  if (patterns.some((rx) => rx.test(text))) return true;

  return false;
}

function isAllowedDomain(text: string, whitelist: string[]): boolean {
  if (!whitelist || whitelist.length === 0) {
    // No whitelist defined -> all links are "not allowed"
    return false;
  }
  const domains = extractDomainsFromText(text);
  if (domains.length === 0) return false;

  const wl = whitelist.map((d) => d.toLowerCase());
  for (const dom of domains) {
    for (const allowed of wl) {
      if (dom === allowed || dom.endsWith("." + allowed)) {
        return true;
      }
    }
  }
  return false;
}

// ---------- Forward / story detection ----------

function isForwardOrStory(message: TelegramMessage): boolean {
  if (message.forward_origin) return true;
  if ((message as any).forward_from) return true;
  if ((message as any).forward_from_chat) return true;
  if (message.is_automatic_forward) return true;
  if ((message as any).story) return true; // forwarded story
  return false;
}

// ---------- Scheduled deletion (cron) ----------

function getCurrentBucketMinute(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor(nowSec / 60);
}

async function scheduleDelete(
  chatId: string,
  messageId: number,
  delaySeconds: number,
  env: Env,
  alsoDeleteId?: number
) {
  const nowSec = Math.floor(Date.now() / 1000);
  const dueSec = nowSec + delaySeconds;
  const bucket = Math.floor(dueSec / 60);
  const key = `${DEL_BUCKET_PREFIX}${bucket}`;

  const raw = await env.BOT_CONFIG.get(key);
  let jobs: DeleteJob[] = [];
  if (raw) {
    try {
      jobs = JSON.parse(raw);
      if (!Array.isArray(jobs)) jobs = [];
    } catch {
      jobs = [];
    }
  }

  jobs.push({ chat_id: chatId, message_id: messageId, also_delete_id: alsoDeleteId });
  await env.BOT_CONFIG.put(key, JSON.stringify(jobs));
}

async function runCron(env: Env) {
  const nowBucket = getCurrentBucketMinute();
  // To be safe against slight delays, process last 3 buckets
  const buckets = [nowBucket, nowBucket - 1, nowBucket - 2];

  for (const bucket of buckets) {
    if (bucket <= 0) continue;
    const key = `${DEL_BUCKET_PREFIX}${bucket}`;
    const raw = await env.BOT_CONFIG.get(key);
    if (!raw) continue;

    let jobs: DeleteJob[] = [];
    try {
      jobs = JSON.parse(raw);
      if (!Array.isArray(jobs)) jobs = [];
    } catch {
      jobs = [];
    }

    for (const job of jobs) {
      try {
        await deleteMessage(job.chat_id, job.message_id, env);
        if (job.also_delete_id) {
          await deleteMessage(job.chat_id, job.also_delete_id, env);
        }
      } catch (e) {
        console.error("Error deleting scheduled message", e);
      }
    }

    // Remove bucket after processing
    await env.BOT_CONFIG.delete(key);
  }
}

// ---------- Commands ----------

async function handlePrivateCommand(message: TelegramMessage, env: Env) {
  const chatId = String(message.chat.id);
  const text = message.text || "";
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].split("@")[0]; // /start@BotName -> /start
  const args = parts.slice(1);

  const isOwner = isOwnerActor(message, env);

  switch (cmd) {
    case "/start":
      await sendText(
        chatId,
        "Hi!\n\n" +
          "• I delete links and forwards in groups.\n" +
          "• I warn users, and mute after 3 warnings.\n" +
          "• I can auto-delete messages and join/leave notices.\n\n" +
          (isOwner
            ? "You are an <b>owner</b>. Use /groups to manage your groups."
            : "This bot is restricted. Only the configured owner(s) can manage settings.\nYou can still use it in groups for moderation."),
        env
      );
      break;

    case "/help":
      await sendText(
        chatId,
        "Commands:\n\n" +
          "<b>In groups</b> (owner only):\n" +
          "• /status - show filters for this group\n" +
          "• reply + /mute 10m - mute user\n" +
          "• reply + /unmute - unmute user\n" +
          "• reply + /del 10s - delete that message later\n\n" +
          "<b>In PM</b> (owner only):\n" +
          "• /groups - list groups I know\n" +
          "• /settings &lt;group_id&gt; - show settings\n" +
          "• /set &lt;group_id&gt; &lt;option&gt; &lt;value&gt;\n" +
          "   options: antilink, antiforward, whitelist, autojoin, autoleave, threshold\n" +
          "   examples:\n" +
          "   /set -1001234567890 antilink on\n" +
          "   /set -1001234567890 antiforward off\n" +
          "   /set -1001234567890 whitelist add youtube.com\n" +
          "   /set -1001234567890 whitelist remove youtube.com\n" +
          "   /set -1001234567890 autojoin on\n" +
          "   /set -1001234567890 threshold 3",
        env
      );
      break;

    case "/groups":
      if (!isOwner) {
        await sendText(chatId, "Only configured owner(s) can use this command.", env);
        return;
      }
      await handleGroupsList(chatId, env);
      break;

    case "/settings":
      if (!isOwner) {
        await sendText(chatId, "Only configured owner(s) can use this command.", env);
        return;
      }
      if (!args[0]) {
        await sendText(chatId, "Usage: /settings <group_id>", env);
        return;
      }
      await handleSettingsView(chatId, args[0], env);
      break;

    case "/set":
      if (!isOwner) {
        await sendText(chatId, "Only configured owner(s) can use this command.", env);
        return;
      }
      await handleSetCommand(chatId, args, env);
      break;

    case "/status":
      if (!isOwner) {
        await sendText(chatId, "Only configured owner(s) can use this command.", env);
        return;
      }
      if (!args[0]) {
        await sendText(
          chatId,
          "Usage in PM: /status <group_id>\n" +
            "Usage in group: /status (no arguments).",
          env
        );
        return;
      }
      await handleStatusView(chatId, args[0], env);
      break;

    default:
      await sendText(
        chatId,
        "Unknown command.\nUse /help to see how to use the bot.",
        env
      );
  }
}

async function handleGroupsList(chatId: string, env: Env) {
  const raw = await env.BOT_CONFIG.get(GROUP_INDEX_KEY);
  if (!raw) {
    await sendText(chatId, "No groups registered yet.", env);
    return;
  }
  let ids: string[] = [];
  try {
    ids = JSON.parse(raw);
    if (!Array.isArray(ids)) ids = [];
  } catch {
    ids = [];
  }
  if (ids.length === 0) {
    await sendText(chatId, "No groups registered yet.", env);
    return;
  }

  let lines: string[] = [];
  for (const id of ids) {
    const metaRaw = await env.BOT_CONFIG.get(META_PREFIX + id);
    if (!metaRaw) continue;
    try {
      const meta = JSON.parse(metaRaw) as GroupMeta;
      const status = meta.active ? "✅ active" : "❌ removed";
      lines.push(`${meta.title || "(no title)"} (${id}) - ${status}`);
    } catch {
      continue;
    }
  }

  if (lines.length === 0) {
    await sendText(chatId, "No groups registered yet.", env);
    return;
  }

  await sendText(
    chatId,
    "Groups I know:\n\n" +
      lines.join("\n") +
      "\n\nUse /settings <group_id> or /status <group_id> in PM.",
    env
  );
}

function formatSettingsText(chatId: string, settings: GroupSettings): string {
  return (
    `Settings for <code>${chatId}</code>:\n\n` +
    `• antiLink: <b>${settings.antiLink ? "ON" : "OFF"}</b>\n` +
    `• antiForward: <b>${settings.antiForward ? "ON" : "OFF"}</b>\n` +
    `• warnThreshold: <b>${settings.warnThreshold}</b>\n` +
    `• autoDeleteJoin: <b>${settings.autoDeleteJoin ? "ON" : "OFF"}</b>\n` +
    `• autoDeleteLeave: <b>${settings.autoDeleteLeave ? "ON" : "OFF"}</b>\n` +
    `• whitelistDomains (${settings.whitelistDomains.length}): ${
      settings.whitelistDomains.length
        ? settings.whitelistDomains.map(escapeHtml).join(", ")
        : "none"
    }`
  );
}

async function handleSettingsView(pmChatId: string, targetId: string, env: Env) {
  const settings = await getGroupSettings(targetId, env);
  await sendText(pmChatId, formatSettingsText(targetId, settings), env);
}

async function handleStatusView(pmChatId: string, targetId: string, env: Env) {
  const settings = await getGroupSettings(targetId, env);
  await sendText(pmChatId, formatSettingsText(targetId, settings), env);
}

async function handleSetCommand(pmChatId: string, args: string[], env: Env) {
  const targetId = args[0];
  if (!targetId) {
    await sendText(
      pmChatId,
      "Usage: /set <group_id> <option> <value>\nExample: /set -1001234567890 antilink on",
      env
    );
    return;
  }
  const option = (args[1] || "").toLowerCase();
  const value = args.slice(2).join(" ");

  if (!option) {
    await sendText(
      pmChatId,
      "Missing option.\nOptions: antilink, antiforward, whitelist, autojoin, autoleave, threshold",
      env
    );
    return;
  }

  let settings = await getGroupSettings(targetId, env);

  switch (option) {
    case "antilink": {
      const v = value.toLowerCase();
      if (v !== "on" && v !== "off") {
        await sendText(pmChatId, "Use: /set <group_id> antilink on|off", env);
        return;
      }
      settings.antiLink = v === "on";
      break;
    }

    case "antiforward": {
      const v = value.toLowerCase();
      if (v !== "on" && v !== "off") {
        await sendText(pmChatId, "Use: /set <group_id> antiforward on|off", env);
        return;
      }
      settings.antiForward = v === "on";
      break;
    }

    case "autojoin": {
      const v = value.toLowerCase();
      if (v !== "on" && v !== "off") {
        await sendText(pmChatId, "Use: /set <group_id> autojoin on|off", env);
        return;
      }
      settings.autoDeleteJoin = v === "on";
      break;
    }

    case "autoleave": {
      const v = value.toLowerCase();
      if (v !== "on" && v !== "off") {
        await sendText(pmChatId, "Use: /set <group_id> autoleave on|off", env);
        return;
      }
      settings.autoDeleteLeave = v === "on";
      break;
    }

    case "threshold": {
      const n = parseInt(value, 10);
      if (!n || n < 1 || n > 20) {
        await sendText(
          pmChatId,
          "Use: /set <group_id> threshold <number between 1 and 20>",
          env
        );
        return;
      }
      settings.warnThreshold = n;
      break;
    }

    case "whitelist": {
      const parts = value.trim().split(/\s+/);
      const sub = (parts[0] || "").toLowerCase();
      const domain = (parts[1] || "").toLowerCase();
      if (!sub || !domain) {
        await sendText(
          pmChatId,
          "Use: /set <group_id> whitelist add <domain>\nOr: /set <group_id> whitelist remove <domain>",
          env
        );
        return;
      }
      if (sub === "add") {
        if (!settings.whitelistDomains.includes(domain)) {
          settings.whitelistDomains.push(domain);
        }
      } else if (sub === "remove") {
        settings.whitelistDomains = settings.whitelistDomains.filter((d) => d !== domain);
      } else {
        await sendText(
          pmChatId,
          "Use: /set <group_id> whitelist add <domain> | remove <domain>",
          env
        );
        return;
      }
      break;
    }

    default:
      await sendText(
        pmChatId,
        "Unknown option.\nOptions: antilink, antiforward, whitelist, autojoin, autoleave, threshold",
        env
      );
      return;
  }

  await saveGroupSettings(targetId, settings, env);
  await sendText(
    pmChatId,
    "Updated settings:\n\n" + formatSettingsText(targetId, settings),
    env
  );
}

async function handleGroupCommand(message: TelegramMessage, env: Env, settings: GroupSettings) {
  const chatId = String(message.chat.id);
  const text = message.text || "";
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].split("@")[0];
  const args = parts.slice(1);

  const isOwner = isOwnerActor(message, env);
  if (!isOwner) {
    // Non-owners can't use group commands, but messages still get moderated
    return;
  }

  switch (cmd) {
    case "/help":
      await sendEphemeralText(
        chatId,
        "Owner commands in groups:\n" +
          "• /status - show filters\n" +
          "• reply + /mute 10m - mute user\n" +
          "• reply + /unmute - unmute user\n" +
          "• reply + /del 10s - delete message later",
        5 * 60,
        env
      );
      break;

    case "/status": {
      await sendEphemeralText(chatId, formatSettingsText(chatId, settings), 5 * 60, env);
      break;
    }

    case "/mute": {
      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendEphemeralText(
          chatId,
          "Reply to a user's message with /mute <time>, e.g. /mute 10m or /mute 1h",
          5 * 60,
          env
        );
        return;
      }
      const target = reply.from;
      const mins = parseDurationToMinutes(args[0]);
      await muteUser(chatId, target.id, mins, env);
      const text =
        `🔇 Muted <a href="tg://user?id=${target.id}">${escapeHtml(
          displayName(target)
        )}</a> for ${args[0] || "24h"}.`;
      await sendEphemeralText(chatId, text, 5 * 60, env);
      break;
    }

    case "/unmute": {
      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await sendEphemeralText(
          chatId,
          "Reply to a user's message with /unmute",
          5 * 60,
          env
        );
        return;
      }
      const target = reply.from;
      await unmuteUser(chatId, target.id, env);
      const text = `🔊 Unmuted <a href="tg://user?id=${target.id}">${escapeHtml(
        displayName(target)
      )}</a>.`;
      await sendEphemeralText(chatId, text, 5 * 60, env);
      break;
    }

    // /del <time> : delete replied message later
    case "/del": {
      const reply = message.reply_to_message;
      if (!reply) {
        await sendEphemeralText(
          chatId,
          "Reply to a message with /del <time>, e.g. /del 10s or /del 5m",
          5 * 60,
          env
        );
        return;
      }
      const durationArg = args[0] || "10s";
      const mins = parseDurationToMinutes(durationArg);
      const seconds = mins * 60;
      // schedule deletion of replied message, and also delete the /del command message itself at same time
      await scheduleDelete(chatId, reply.message_id, seconds, env, message.message_id);

      await sendEphemeralText(
        chatId,
        `🗑️ This message will be deleted after ${durationArg}.`,
        5 * 60,
        env
      );
      break;
    }

    default:
      // ignore others
      break;
  }
}

// ---------- Main message handler ----------

async function handleMessage(message: TelegramMessage, env: Env) {
  const chat = message.chat;
  const chatId = String(chat.id);

  if (chat.type === "private") {
    if (message.text && message.text.startsWith("/")) {
      await handlePrivateCommand(message, env);
    } else {
      await sendText(
        chatId,
        "I work in groups.\nAdd me as admin (delete messages + restrict members) and use /help here to manage settings.",
        env
      );
    }
    return;
  }

  // Group / supergroup
  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  // Register group meta
  await registerGroup(chat, env);
  const settings = await getGroupSettings(chatId, env);

  // First handle service messages join/leave
  if (message.new_chat_members && message.new_chat_members.length > 0) {
    if (settings.autoDeleteJoin) {
      await deleteMessage(chatId, message.message_id, env);
      return;
    }
  }
  if (message.left_chat_member) {
    if (settings.autoDeleteLeave) {
      await deleteMessage(chatId, message.message_id, env);
      return;
    }
  }

  const text = message.text || message.caption || "";

  // Commands in groups
  if (text.startsWith("/")) {
    await handleGroupCommand(message, env, settings);
    // do not moderate command messages themselves
    return;
  }

  // No user => system message, ignore for moderation
  if (!message.from) return;

  const user = message.from;

  // Anti-link
  if (settings.antiLink && isLinkMessage(message)) {
    const content = message.text || message.caption || "";
    const allowed = isAllowedDomain(content, settings.whitelistDomains);
    if (!allowed) {
      await deleteMessage(chatId, message.message_id, env);
      await addWarning(chatId, user, settings, "link", env);
      return;
    }
  }

  // Anti-forward (including forwarded stories)
  if (settings.antiForward && isForwardOrStory(message)) {
    await deleteMessage(chatId, message.message_id, env);
    const reason: ViolationReason = (message as any).story ? "story" : "forward";
    await addWarning(chatId, user, settings, reason, env);
    return;
  }
}

// ---------- my_chat_member handler (bot added / removed) ----------

async function handleMyChatMember(update: MyChatMemberUpdate, env: Env) {
  const chatId = String(update.chat.id);
  const status = update.new_chat_member.status; // "member", "administrator", "left", "kicked" etc.

  if (status === "member" || status === "administrator") {
    await setGroupActive(chatId, true, env);
  } else if (status === "left" || status === "kicked") {
    await setGroupActive(chatId, false, env);
  }
}

// ---------- Worker entrypoints ----------

export default {
  // Webhook handler
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("OK");
    }

    let update: TelegramUpdate | null = null;
    try {
      update = await request.json<TelegramUpdate>();
    } catch (e) {
      console.error("Failed to parse update", e);
      return new Response("Bad Request", { status: 400 });
    }

    if (!update) {
      return new Response("No update", { status: 400 });
    }

    if (update.message) {
      ctx.waitUntil(handleMessage(update.message, env));
    } else if (update.my_chat_member) {
      ctx.waitUntil(handleMyChatMember(update.my_chat_member, env));
    }

    return new Response("OK");
  },

  // Cron handler for scheduled deletions
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env));
  },
};
