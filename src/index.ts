/* =====================================================================
   Telegram Group Manager Bot (Monolithic Version)
   Cloudflare Workers | Single Entrypoint | Stable Routing
   ===================================================================== */

const TG_API = "https://api.telegram.org";

/* ================= ENV ================= */

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  OWNER_USER_IDS: string; // comma-separated user + group IDs
  BOT_CONFIG: KVNamespace;
}

/* ================= TYPES ================= */

type ChatType = "private" | "group" | "supergroup";

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

interface TgChat {
  id: number;
  type: ChatType;
  title?: string;
}

interface TgEntity {
  type: string; // url | text_link | mention
  offset?: number;
  length?: number;
  url?: string;
}

interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  sender_chat?: TgChat;

  text?: string;
  caption?: string;

  entities?: TgEntity[];
  caption_entities?: TgEntity[];

  reply_to_message?: TgMessage;

  forward_from?: any;
  forward_from_chat?: any;
  forward_origin?: any;
  is_automatic_forward?: boolean;
  story?: any;

  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
}

interface TgUpdate {
  message?: TgMessage;
  my_chat_member?: any;
}

/* ================= SETTINGS ================= */

interface GroupSettings {
  antilink: boolean;
  antiforward: boolean;
  warn_limit: number;
  automute_minutes: number;
  auto_delete_join: boolean;
  auto_delete_leave: boolean;
  whitelist: string[];
}

const DEFAULT_SETTINGS: GroupSettings = {
  antilink: true,
  antiforward: true,
  warn_limit: 3,
  automute_minutes: 30,
  auto_delete_join: false,
  auto_delete_leave: false,
  whitelist: []
};

/* ================= ENTRY ================= */

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (req.method !== "POST") return new Response("OK");

    const update = await req.json<TgUpdate>();

    if (update.message) {
      await routeMessage(update.message, env);
    } else if (update.my_chat_member) {
      await handleBotMembership(update.my_chat_member, env);
    }

    return new Response("OK");
  },

  async scheduled(_: ScheduledEvent, env: Env) {
    await runDeletionCron(env);
  }
};

/* ================= ROUTER ================= */

async function routeMessage(msg: TgMessage, env: Env) {
  if (msg.chat.type === "private") {
    await handlePrivate(msg, env);
  } else if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    await handleGroup(msg, env);
  }
}

/* ================= AUTH ================= */

function allowedIds(env: Env): Set<string> {
  return new Set(
    env.OWNER_USER_IDS.split(",").map(x => x.trim()).filter(Boolean)
  );
}

function isAllowed(msg: TgMessage, env: Env): boolean {
  const allow = allowedIds(env);
  if (msg.from && allow.has(String(msg.from.id))) return true;
  if (allow.has(String(msg.chat.id))) return true; // anonymous admin
  return false;
}

/* ================= GROUP HANDLER ================= */

async function handleGroup(msg: TgMessage, env: Env) {
  const chatId = String(msg.chat.id);
  const settings = await getSettings(chatId, env);

  registerGroup(chatId, msg.chat.title, env);

  // join / leave
  if (msg.new_chat_members && settings.auto_delete_join) {
    await deleteMsg(chatId, msg.message_id, env);
    return;
  }
  if (msg.left_chat_member && settings.auto_delete_leave) {
    await deleteMsg(chatId, msg.message_id, env);
    return;
  }

  // commands
  if (msg.text?.startsWith("/")) {
    if (!isAllowed(msg, env)) return;

    const cmd = msg.text.split(" ")[0];
    if (cmd === "/status") {
      await sendTemp(chatId, formatSettings(settings), 300, env);
    }
    if (cmd === "/del" && msg.reply_to_message) {
      const delay = parseDuration(msg.text.split(" ")[1] || "10s");
      await scheduleDelete(
        chatId,
        msg.reply_to_message.message_id,
        delay,
        env,
        msg.message_id
      );
      await sendTemp(chatId, "🗑️ Scheduled deletion.", 300, env);
    }
    return;
  }

  if (!msg.from) return;

  /* STORY */
  if (settings.antiforward && msg.story) {
    await violation(chatId, msg, msg.from, "story", env);
    return;
  }

  /* FORWARD */
  if (
    settings.antiforward &&
    (msg.forward_origin ||
      msg.forward_from ||
      msg.forward_from_chat ||
      msg.is_automatic_forward)
  ) {
    await violation(chatId, msg, msg.from, "forward", env);
    return;
  }

  /* LINK */
  if (settings.antilink && containsLink(msg, settings.whitelist)) {
    await violation(chatId, msg, msg.from, "link", env);
    return;
  }
}

/* ================= PM HANDLER ================= */

async function handlePrivate(msg: TgMessage, env: Env) {
  if (!msg.from || !allowedIds(env).has(String(msg.from.id))) {
    await send(msg.chat.id, "This bot is restricted.", env);
    return;
  }

  const parts = (msg.text || "").split(" ");
  const cmd = parts[0];

  if (cmd === "/start" || cmd === "/help") {
    await send(
      msg.chat.id,
      `/groups
/settings <group_id>
/set <group_id> antilink|antiforward|autojoin|autoleave on|off
/set <group_id> warn <number>
/whitelist <group_id> add|remove|list <domain>`,
      env
    );
    return;
  }

  if (cmd === "/groups") {
    const g = JSON.parse((await env.BOT_CONFIG.get("groups")) || "[]");
    await send(msg.chat.id, g.join("\n") || "No groups", env);
    return;
  }

  if (cmd === "/settings") {
    const gid = parts[1];
    if (!gid) return;
    const s = await getSettings(gid, env);
    await send(msg.chat.id, formatSettings(s), env);
    return;
  }

  if (cmd === "/set") {
    await handleSet(parts, env, msg.chat.id);
    return;
  }

  if (cmd === "/whitelist") {
    await handleWhitelist(parts, env, msg.chat.id);
    return;
  }
}

/* ================= VIOLATION ================= */

async function violation(
  chatId: string,
  msg: TgMessage,
  user: TgUser,
  reason: "link" | "forward" | "story",
  env: Env
) {
  await deleteMsg(chatId, msg.message_id, env);

  const key = `warn:${chatId}:${user.id}`;
  let count = Number(await env.BOT_CONFIG.get(key)) || 0;
  const settings = await getSettings(chatId, env);

  count += 1;

  if (count >= settings.warn_limit) {
    await mute(chatId, user.id, settings.automute_minutes, env);
    await env.BOT_CONFIG.put(key, "0");
    await sendTemp(
      chatId,
      `🔇 Muted ${mention(user)}\nReason: ${reason}`,
      300,
      env
    );
  } else {
    await env.BOT_CONFIG.put(key, String(count));
    await sendTemp(
      chatId,
      `⚠️ Warning ${count}/${settings.warn_limit}\nUser: ${mention(
        user
      )}\nReason: ${reason}`,
      300,
      env
    );
  }
}

/* ================= SETTINGS ================= */

async function getSettings(chatId: string, env: Env): Promise<GroupSettings> {
  const raw = await env.BOT_CONFIG.get(`settings:${chatId}`);
  if (!raw) {
    await env.BOT_CONFIG.put(
      `settings:${chatId}`,
      JSON.stringify(DEFAULT_SETTINGS)
    );
    return DEFAULT_SETTINGS;
  }
  return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
}

/* ================= UTILITIES ================= */

function mention(u: TgUser) {
  return u.username ? `@${u.username}` : u.first_name || String(u.id);
}

function formatSettings(s: GroupSettings) {
  return `AntiLink: ${s.antilink}
AntiForward: ${s.antiforward}
Warn limit: ${s.warn_limit}
AutoMute: ${s.automute_minutes}m
AutoJoinDelete: ${s.auto_delete_join}
AutoLeaveDelete: ${s.auto_delete_leave}
Whitelist: ${s.whitelist.join(", ") || "none"}`;
}

function containsLink(msg: TgMessage, whitelist: string[]): boolean {
  const text = msg.text || msg.caption || "";

  const hasEntity = [...(msg.entities || []), ...(msg.caption_entities || [])]
    .some(e => e.type === "url" || e.type === "text_link");

  if (hasEntity) return true;

  const rx =
    /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|[a-z0-9-]+\.[a-z]{2,})/i;

  if (!rx.test(text)) return false;
  if (!whitelist.length) return true;
  return !whitelist.some(d => text.toLowerCase().includes(d));
}

function parseDuration(v: string): number {
  const m = v.match(/^(\d+)(s|m|h)$/i);
  if (!m) return 10;
  const n = Number(m[1]);
  const u = m[2];
  if (u === "s") return n;
  if (u === "m") return n * 60;
  if (u === "h") return n * 3600;
  return 10;
}

/* ================= STORAGE HELPERS ================= */

async function registerGroup(id: string, title?: string, env?: Env) {
  const raw = await env!.BOT_CONFIG.get("groups");
  const arr = raw ? JSON.parse(raw) : [];
  if (!arr.includes(id)) {
    arr.push(id);
    await env!.BOT_CONFIG.put("groups", JSON.stringify(arr));
  }
}

async function handleSet(parts: string[], env: Env, chatId: number | string) {
  const [_, gid, key, val] = parts;
  if (!gid || !key) return;
  let s = await getSettings(gid, env);
  if (key === "antilink") s.antilink = val === "on";
  if (key === "antiforward") s.antiforward = val === "on";
  if (key === "warn") s.warn_limit = Number(val);
  await env.BOT_CONFIG.put(`settings:${gid}`, JSON.stringify(s));
  await send(chatId, "Updated.", env);
}

async function handleWhitelist(parts: string[], env: Env, chatId: number | string) {
  const [_, gid, action, domain] = parts;
  if (!gid) return;
  let s = await getSettings(gid, env);
  if (action === "add" && domain && !s.whitelist.includes(domain)) {
    s.whitelist.push(domain);
  }
  if (action === "remove" && domain) {
    s.whitelist = s.whitelist.filter(d => d !== domain);
  }
  await env.BOT_CONFIG.put(`settings:${gid}`, JSON.stringify(s));
  await send(chatId, "Whitelist updated.", env);
}

/* ================= TELEGRAM ================= */

async function tg(method: string, env: Env, body: any) {
  await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function send(chatId: number | string, text: string, env: Env) {
  await tg("sendMessage", env, { chat_id: chatId, text });
}

async function sendTemp(
  chatId: string,
  text: string,
  sec: number,
  env: Env
) {
  const r = await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const j = await r.json();
  await env.BOT_CONFIG.put(
    `del:${crypto.randomUUID()}`,
    JSON.stringify({
      chatId,
      mid: j.result.message_id,
      at: Date.now() + sec * 1000
    })
  );
}

async function deleteMsg(chatId: string, mid: number, env: Env) {
  await tg("deleteMessage", env, { chat_id: chatId, message_id: mid });
}

async function mute(
  chatId: string,
  uid: number,
  mins: number,
  env: Env
) {
  await tg("restrictChatMember", env, {
    chat_id: chatId,
    user_id: uid,
    until_date: Math.floor(Date.now() / 1000) + mins * 60,
    permissions: { can_send_messages: false }
  });
}

/* ================= CRON ================= */

async function scheduleDelete(
  chatId: string,
  mid: number,
  sec: number,
  env: Env,
  also?: number
) {
  await env.BOT_CONFIG.put(
    `del:${crypto.randomUUID()}`,
    JSON.stringify({
      chatId,
      mid,
      also,
      at: Date.now() + sec * 1000
    })
  );
}

async function runDeletionCron(env: Env) {
  const now = Date.now();
  const keys = await env.BOT_CONFIG.list({ prefix: "del:" });
  for (const k of keys.keys) {
    const v = JSON.parse((await env.BOT_CONFIG.get(k.name)) || "{}");
    if (v.at <= now) {
      await deleteMsg(v.chatId, v.mid, env);
      if (v.also) await deleteMsg(v.chatId, v.also, env);
      await env.BOT_CONFIG.delete(k.name);
    }
  }
}

/* ================= BOT MEMBERSHIP ================= */

async function handleBotMembership(update: any, env: Env) {
  if (["left", "kicked"].includes(update.new_chat_member.status)) {
    await env.BOT_CONFIG.delete(`settings:${update.chat.id}`);
  }
}
