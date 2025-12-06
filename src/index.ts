/* ====================================================================================
   Telegram Group Manager Bot
   Cloudflare Workers — Final Stable Version
   ==================================================================================== */

const TG_API = "https://api.telegram.org";

/* ================= ENV ================= */

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  OWNER_USER_IDS: string;
  BOT_CONFIG: KVNamespace;
}

/* ================= TYPES ================= */

type ChatType = "private" | "group" | "supergroup";

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TgChat {
  id: number;
  type: ChatType;
  title?: string;
}

interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  sender_chat?: TgChat;

  text?: string;
  caption?: string;
  entities?: any[];
  caption_entities?: any[];

  reply_to_message?: TgMessage;

  forward_from?: any;
  forward_from_chat?: any;
  forward_origin?: any;
  is_automatic_forward?: boolean;
  story?: any;

  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
}

interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

interface TgUpdate {
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
  my_chat_member?: any;
}

/* ================= SETTINGS ================= */

interface GroupSettings {
  antilink: boolean;
  antiforward: boolean;
  warnLimit: number;
  autoMuteMinutes: number;
  deleteJoin: boolean;
  deleteLeave: boolean;
  whitelist: string[];
}

const DEFAULT_SETTINGS: GroupSettings = {
  antilink: true,
  antiforward: true,
  warnLimit: 3,
  autoMuteMinutes: 30,
  deleteJoin: true,
  deleteLeave: true,
  whitelist: []
};

/* ================= ENTRY ================= */

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== "POST") return new Response("OK");

    const update = await req.json<TgUpdate>();

    if (update.callback_query) {
      ctx.waitUntil(handleCallback(update.callback_query, env));
    } else if (update.message) {
      ctx.waitUntil(route(update.message, env));
    } else if (update.my_chat_member) {
      ctx.waitUntil(handleBotMembership(update.my_chat_member, env));
    }
    return new Response("OK");
  },

  async scheduled(_: ScheduledEvent, env: Env) {
    await runDeletionCron(env);
  }
};

/* ================= ROUTER ================= */

async function route(msg: TgMessage, env: Env) {
  if (msg.chat.type === "private") {
    await handlePM(msg, env);
  } else {
    await handleGroup(msg, env);
  }
}

/* ================= AUTH ================= */

function allowed(env: Env): Set<string> {
  return new Set(
    env.OWNER_USER_IDS.split(",").map(v => v.trim()).filter(Boolean)
  );
}

function canModerate(msg: TgMessage, env: Env): boolean {
  const a = allowed(env);
  if (msg.from && a.has(String(msg.from.id))) return true;
  if (a.has(String(msg.chat.id))) return true; // anonymous admin
  return false;
}

/* ================= PRIVATE PM ================= */

async function handlePM(msg: TgMessage, env: Env) {
  if (!msg.from || !allowed(env).has(String(msg.from.id))) {
    await send(msg.chat.id, "This bot is restricted.", env);
    return;
  }

  await sendInline(
    msg.chat.id,
    "⚙️ Group Manager",
    [[{ text: "📋 My Groups", data: "groups:list" }]],
    env
  );
}

/* ================= INLINE CALLBACKS ================= */

async function handleCallback(q: TgCallbackQuery, env: Env) {
  const data = q.data || "";
  const chatId = q.message?.chat.id;
  if (!chatId) return;

  if (!allowed(env).has(String(q.from.id))) {
    await answerCb(q.id, "Not allowed", env);
    return;
  }

  if (data === "groups:list") {
    await showGroups(chatId, env);
  }

  if (data.startsWith("group:")) {
    const gid = Number(data.split(":")[1]);
    await showSettings(chatId, gid, env);
  }

  if (data.startsWith("toggle:")) {
    const [, gid, key] = data.split(":");
    const s = await getSettings(Number(gid), env);
    (s as any)[key] = !(s as any)[key];
    await saveSettings(Number(gid), s, env);
    await showSettings(chatId, Number(gid), env);
  }

  if (data.startsWith("warn:")) {
    const [, gid, dir] = data.split(":");
    const s = await getSettings(Number(gid), env);
    s.warnLimit = dir === "up" ? s.warnLimit + 1 : Math.max(1, s.warnLimit - 1);
    await saveSettings(Number(gid), s, env);
    await showSettings(chatId, Number(gid), env);
  }

  if (data.startsWith("mute:")) {
    const [, gid, dir] = data.split(":");
    const s = await getSettings(Number(gid), env);
    s.autoMuteMinutes =
      dir === "up"
        ? s.autoMuteMinutes + 5
        : Math.max(5, s.autoMuteMinutes - 5);
    await saveSettings(Number(gid), s, env);
    await showSettings(chatId, Number(gid), env);
  }

  await answerCb(q.id, "", env);
}

/* ================= INLINE UI ================= */

async function showGroups(chatId: number, env: Env) {
  const list = await listGroups(env);
  if (!list.length) {
    await send(chatId, "No groups found.", env);
    return;
  }

  const buttons = list.map(g => [
    { text: g.title || String(g.id), data: `group:${g.id}` }
  ]);

  await sendInline(chatId, "📋 Select Group", buttons, env);
}

async function showSettings(chatId: number, groupId: number, env: Env) {
  const s = await getSettings(groupId, env);

  await sendInline(
    chatId,
    `⚙️ Settings for ${groupId}`,
    [
      [{ text: `Anti-Link ${s.antilink ? "✅" : "❌"}`, data: `toggle:${groupId}:antilink` }],
      [{ text: `Anti-Forward ${s.antiforward ? "✅" : "❌"}`, data: `toggle:${groupId}:antiforward` }],
      [{ text: `Join Clean ${s.deleteJoin ? "✅" : "❌"}`, data: `toggle:${groupId}:deleteJoin` }],
      [{ text: `Leave Clean ${s.deleteLeave ? "✅" : "❌"}`, data: `toggle:${groupId}:deleteLeave` }],
      [
        { text: "➖", data: `warn:${groupId}:down` },
        { text: `Warn ${s.warnLimit}`, data: "noop" },
        { text: "➕", data: `warn:${groupId}:up` }
      ],
      [
        { text: "➖", data: `mute:${groupId}:down` },
        { text: `${s.autoMuteMinutes}m`, data: "noop" },
        { text: "➕", data: `mute:${groupId}:up` }
      ],
      [{ text: "⬅ Back", data: "groups:list" }]
    ],
    env
  );
}

/* ================= GROUP MODERATION ================= */

async function handleGroup(msg: TgMessage, env: Env) {
  const chatId = msg.chat.id;
  rememberGroup(msg.chat, env);
  const settings = await getSettings(chatId, env);

  if (settings.deleteJoin && msg.new_chat_members) {
    await del(chatId, msg.message_id, env);
    return;
  }

  if (settings.deleteLeave && msg.left_chat_member) {
    await del(chatId, msg.message_id, env);
    return;
  }

  const text = msg.text || msg.caption || "";

  if (!msg.from) return;

  if (
    settings.antiforward &&
    (msg.story || msg.forward_origin || msg.is_automatic_forward)
  ) {
    await violation(chatId, msg.from.id, msg.message_id, "Forwarded content", env);
    return;
  }

  if (settings.antilink && hasLink(text, settings.whitelist)) {
    await violation(chatId, msg.from.id, msg.message_id, "Links not allowed", env);
  }
}

/* ================= WARN / MUTE ================= */

async function violation(
  chatId: number,
  userId: number,
  mid: number,
  reason: string,
  env: Env
) {
  const key = `warn:${chatId}:${userId}`;
  const s = await getSettings(chatId, env);

  await del(chatId, mid, env);

  let count = Number(await env.BOT_CONFIG.get(key)) || 0;
  count++;

  if (count >= s.warnLimit) {
    await mute(chatId, userId, s.autoMuteMinutes, env);
    await env.BOT_CONFIG.put(key, "0");
    await sendTemp(chatId, `🔇 Muted\nReason: ${reason}`, 300, env);
  } else {
    await env.BOT_CONFIG.put(key, String(count));
    await sendTemp(chatId, `⚠️ Warning ${count}/${s.warnLimit}\n${reason}`, 300, env);
  }
}

/* ================= SETTINGS ================= */

async function getSettings(chatId: number, env: Env): Promise<GroupSettings> {
  const raw = await env.BOT_CONFIG.get(`settings:${chatId}`);
  if (!raw) {
    await saveSettings(chatId, DEFAULT_SETTINGS, env);
    return DEFAULT_SETTINGS;
  }
  return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
}

async function saveSettings(chatId: number, s: GroupSettings, env: Env) {
  await env.BOT_CONFIG.put(`settings:${chatId}`, JSON.stringify(s));
}

/* ================= GROUP LIST ================= */

async function rememberGroup(chat: TgChat, env: Env) {
  await env.BOT_CONFIG.put(
    `group:${chat.id}`,
    JSON.stringify({ id: chat.id, title: chat.title || "" })
  );
}

async function listGroups(env: Env): Promise<{ id: number; title: string }[]> {
  const out: any[] = [];
  const res = await env.BOT_CONFIG.list({ prefix: "group:" });
  for (const k of res.keys) {
    const v = await env.BOT_CONFIG.get(k.name);
    if (v) out.push(JSON.parse(v));
  }
  return out;
}

/* ================= HELPERS ================= */

function hasLink(text: string, whitelist: string[]): boolean {
  const rx =
    /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|[a-z0-9-]+\.[a-z]{2,})/i;
  if (!rx.test(text)) return false;
  return !whitelist.some(d => text.toLowerCase().includes(d));
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

async function sendInline(
  chatId: number | string,
  text: string,
  buttons: { text: string; data: string }[][],
  env: Env
) {
  await tg("sendMessage", env, {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: buttons }
  });
}

async function answerCb(id: string, text: string, env: Env) {
  await tg("answerCallbackQuery", env, { callback_query_id: id, text });
}

async function del(chatId: number | string, mid: number, env: Env) {
  await tg("deleteMessage", env, { chat_id: chatId, message_id: mid });
}

async function mute(chatId: number, uid: number, mins: number, env: Env) {
  await tg("restrictChatMember", env, {
    chat_id: chatId,
    user_id: uid,
    until_date: Math.floor(Date.now() / 1000) + mins * 60,
    permissions: { can_send_messages: false }
  });
}

async function sendTemp(
  chatId: number,
  text: string,
  sec: number,
  env: Env
) {
  const res = await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const j = await res.json();
  await env.BOT_CONFIG.put(
    `del:${crypto.randomUUID()}`,
    JSON.stringify({
      chatId,
      mid: j.result.message_id,
      at: Date.now() + sec * 1000
    })
  );
}

/* ================= CRON ================= */

async function runDeletionCron(env: Env) {
  const now = Date.now();
  const list = await env.BOT_CONFIG.list({ prefix: "del:" });
  for (const k of list.keys) {
    const v = JSON.parse((await env.BOT_CONFIG.get(k.name)) || "{}");
    if (v.at <= now) {
      await del(v.chatId, v.mid, env);
      await env.BOT_CONFIG.delete(k.name);
    }
  }
}

/* ================= BOT REMOVED ================= */

async function handleBotMembership(update: any, env: Env) {
  if (["left", "kicked"].includes(update.new_chat_member?.status)) {
    await env.BOT_CONFIG.delete(`group:${update.chat.id}`);
    await env.BOT_CONFIG.delete(`settings:${update.chat.id}`);
  }
}
