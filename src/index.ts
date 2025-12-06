/* ===============================
   Telegram Group Manager Bot
   Cloudflare Workers
   =============================== */

const TG_API = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  BOT_CONFIG: KVNamespace;
  OWNER_USER_IDS: string;
}

/* ---------- TYPES ---------- */

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup";
  title?: string;
}

interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  sender_chat?: TgChat;
  text?: string;
  caption?: string;
  reply_to_message?: TgMessage;

  forward_from?: any;
  forward_from_chat?: any;
  forward_sender_name?: string;
  forward_origin?: any;
  forward_date?: number;
  story?: any;

  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
}

interface TgUpdate {
  message?: TgMessage;
  my_chat_member?: any;
}

type ViolationReason =
  | "LINK"
  | "FORWARD"
  | "STORY"
  | "DUPLICATE";

/* ---------- SETTINGS ---------- */

interface GroupSettings {
  antilink: boolean;
  antiforward: boolean;
  warn_limit: number;
  automute_minutes: number;
  whitelist: string[];
}

const DEFAULT_SETTINGS: GroupSettings = {
  antilink: true,
  antiforward: true,
  warn_limit: 3,
  automute_minutes: 30,
  whitelist: []
};

/* ---------- ENTRY ---------- */

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (req.method !== "POST") return new Response("OK");
    const update = await req.json<TgUpdate>();
    ctx.waitUntil(handleUpdate(update, env));
    return new Response("OK");
  },

  async scheduled(_: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDeletionCron(env));
  }
};

/* ---------- HELPERS ---------- */

const allowedIds = (env: Env) =>
  new Set(env.OWNER_USER_IDS.split(",").map(x => x.trim()));

const canModerate = (msg: TgMessage, env: Env): boolean => {
  const allow = allowedIds(env);
  if (msg.from && allow.has(String(msg.from.id))) return true;
  if (allow.has(String(msg.chat.id))) return true; // anonymous admin
  return false;
};

const uname = (u: TgUser) =>
  u.username ? `@${u.username}` : u.first_name || String(u.id);

/* ---------- UPDATE ---------- */

async function handleUpdate(update: TgUpdate, env: Env) {
  if (update.my_chat_member) {
    if (["left", "kicked"].includes(update.my_chat_member.new_chat_member.status)) {
      const id = update.my_chat_member.chat.id;
      await env.BOT_CONFIG.delete(`settings:${id}`);
    }
  }

  if (update.message) {
    await handleMessage(update.message, env);
  }
}

/* ---------- MESSAGE ---------- */

async function handleMessage(msg: TgMessage, env: Env) {
  const chatId = String(msg.chat.id);

  if (msg.chat.type === "private") {
    await handlePM(msg, env);
    return;
  }

  const settings = await getSettings(chatId, env);
  const text = msg.text || msg.caption || "";
  const user = msg.from;

  if (text.startsWith("/")) {
    await handleGroupCommand(msg, env);
    return;
  }

  if (!user) return;

  // ✅ Story forward
  if (settings.antiforward && msg.story) {
    await violate(chatId, msg, user, "STORY", env);
    return;
  }

  // ✅ Normal forward
  if (
    settings.antiforward &&
    (msg.forward_from ||
      msg.forward_from_chat ||
      msg.forward_sender_name ||
      msg.forward_origin)
  ) {
    await violate(chatId, msg, user, "FORWARD", env);
    return;
  }

  // ✅ Link
  if (settings.antilink && hasLink(text, settings.whitelist)) {
    await violate(chatId, msg, user, "LINK", env);
    return;
  }

  // ✅ Duplicate text spam
  if (await isDuplicate(chatId, text, env)) {
    await violate(chatId, msg, user, "DUPLICATE", env);
    return;
  }
}

/* ---------- VIOLATION ---------- */

async function violate(
  chatId: string,
  msg: TgMessage,
  user: TgUser,
  reason: ViolationReason,
  env: Env
) {
  const settings = await getSettings(chatId, env);

  await del(chatId, msg.message_id, env);

  const warnKey = `warn:${chatId}:${user.id}`;
  let warns = Number(await env.BOT_CONFIG.get(warnKey)) || 0;
  warns++;

  const reasons: Record<ViolationReason, string> = {
    LINK: "Posting links",
    FORWARD: "Forwarding messages",
    STORY: "Forwarding stories",
    DUPLICATE: "Repeated/copy-paste spam"
  };

  if (warns >= settings.warn_limit) {
    await mute(chatId, user.id, settings.automute_minutes, env);
    await env.BOT_CONFIG.put(warnKey, "0"); // ✅ RESET WARNS AFTER MUTE

    await sendTemp(
      chatId,
      `🔇 AUTO-MUTED\nUser: ${uname(user)}\nReason: ${reasons[reason]}`,
      300,
      env
    );
  } else {
    await env.BOT_CONFIG.put(warnKey, String(warns));
    await sendTemp(
      chatId,
      `⚠️ Warning ${warns}/${settings.warn_limit}\nUser: ${uname(
        user
      )}\nReason: ${reasons[reason]}`,
      300,
      env
    );
  }
}

/* ---------- GROUP COMMANDS ---------- */

async function handleGroupCommand(msg: TgMessage, env: Env) {
  if (!canModerate(msg, env)) return;
  const chatId = String(msg.chat.id);
  const cmd = (msg.text || "").split(" ")[0];

  if (cmd === "/status") {
    const s = await getSettings(chatId, env);
    await sendTemp(
      chatId,
      `antilink: ${s.antilink}
antiforward: ${s.antiforward}
warn limit: ${s.warn_limit}
auto mute: ${s.automute_minutes}m`,
      300,
      env
    );
  }
}

/* ---------- PM ---------- */

async function handlePM(msg: TgMessage, env: Env) {
  if (!msg.from || !allowedIds(env).has(String(msg.from.id))) {
    await send(msg.chat.id, "This bot is restricted.", env);
    return;
  }

  const text = msg.text || "";
  if (text === "/start" || text === "/help") {
    await send(
      msg.chat.id,
      `/groups
/set <group_id> antilink|antiforward on|off
/set <group_id> warn_limit <number>
/set <group_id> automute_minutes <number>
/whitelist <group_id> add|remove|list <domain>`,
      env
    );
  }
}

/* ---------- UTILS ---------- */

async function getSettings(chatId: string, env: Env): Promise<GroupSettings> {
  const raw = await env.BOT_CONFIG.get(`settings:${chatId}`);
  if (!raw) {
    await env.BOT_CONFIG.put(`settings:${chatId}`, JSON.stringify(DEFAULT_SETTINGS));
    return DEFAULT_SETTINGS;
  }
  return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
}

function hasLink(text: string, whitelist: string[]) {
  const regex = /(https?:\/\/|www\.|t\.me\/|[a-z0-9-]+\.[a-z]{2,})/i;
  if (!regex.test(text)) return false;
  return !whitelist.some(w => text.toLowerCase().includes(w));
}

async function isDuplicate(chatId: string, text: string, env: Env) {
  if (!text.trim()) return false;
  const hash = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(text.toLowerCase())
  );
  const key =
    "dup:" +
    chatId +
    ":" +
    Array.from(new Uint8Array(hash)).map(b => b.toString(16)).join("");
  if (await env.BOT_CONFIG.get(key)) return true;
  await env.BOT_CONFIG.put(key, "1");
  return false;
}

/* ---------- TELEGRAM ---------- */

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

async function sendTemp(chatId: string, text: string, ttl: number, env: Env) {
  const res = await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const msg = await res.json();
  await env.BOT_CONFIG.put(
    `del:${crypto.randomUUID()}`,
    JSON.stringify({ chatId, mid: msg.result.message_id, t: Date.now() + ttl * 1000 })
  );
}

async function del(chatId: string, mid: number, env: Env) {
  await tg("deleteMessage", env, { chat_id: chatId, message_id: mid });
}

async function mute(chatId: string, uid: number, mins: number, env: Env) {
  await tg("restrictChatMember", env, {
    chat_id: chatId,
    user_id: uid,
    until_date: Math.floor(Date.now() / 1000) + mins * 60,
    permissions: { can_send_messages: false }
  });
}

/* ---------- CRON ---------- */

async function runDeletionCron(env: Env) {
  const now = Date.now();
  const list = await env.BOT_CONFIG.list({ prefix: "del:" });
  for (const k of list.keys) {
    const v = JSON.parse((await env.BOT_CONFIG.get(k.name)) || "{}");
    if (v.t <= now) {
      await del(v.chatId, v.mid, env);
      await env.BOT_CONFIG.delete(k.name);
    }
  }
}
