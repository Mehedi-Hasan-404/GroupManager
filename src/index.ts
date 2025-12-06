const TG_API = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  BOT_CONFIG: KVNamespace;
}

interface MessageEntity {
  type: string;
  url?: string;
}

interface User {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface Chat {
  id: number;
  type: string;
  title?: string;
}

interface Message {
  message_id: number;
  text?: string;
  caption?: string;
  entities?: MessageEntity[];
  caption_entities?: MessageEntity[];
  from?: User;
  chat: Chat;
  reply_to_message?: Message;
}

interface Update {
  update_id: number;
  message?: Message;
}

/* ================= WORKER ================= */

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (req.method !== "POST") return new Response("OK");

    const update = await req.json<Update>();
    if (!update.message) return new Response("OK");

    ctx.waitUntil(handleMessage(update.message, env));
    return new Response("OK");
  },

  async scheduled(_e: ScheduledEvent, env: Env) {
    await processDeleteQueue(env);
  }
};

/* ================= MESSAGE HANDLER ================= */

async function handleMessage(msg: Message, env: Env) {
  const chatId = String(msg.chat.id);
  const user = msg.from;
  if (!user) return;

  if (msg.chat.type === "private") return;

  await saveGroup(msg.chat, env);

  const text = msg.text || msg.caption || "";

  if (text.startsWith("/")) {
    await handleCommand(msg, env);
    return;
  }

  const whitelist = await getWhitelist(chatId, env);

  if (hasAnyLink(msg, whitelist)) {
    await deleteMessage(chatId, msg.message_id, env);
    await registerViolation(chatId, user.id, env);
  }
}

/* ================= LINK DETECTION ================= */

function hasAnyLink(msg: Message, whitelist: string[]): boolean {
  const text = (msg.text || msg.caption || "").toLowerCase();

  if (isWhitelisted(text, whitelist)) return false;

  const regex =
    /((https?:\/\/|www\.)\S+|\b[a-z0-9.-]+\.[a-z]{2,}\S*)/i;

  if (regex.test(text)) return true;

  const entities = [
    ...(msg.entities || []),
    ...(msg.caption_entities || [])
  ];

  return entities.some(e => e.type === "url" || e.type === "text_link");
}

function isWhitelisted(text: string, whitelist: string[]) {
  return whitelist.some(domain => text.includes(domain.toLowerCase()));
}

/* ================= WHITELIST ================= */

async function getWhitelist(chatId: string, env: Env): Promise<string[]> {
  const raw = await env.BOT_CONFIG.get(`whitelist:${chatId}`);
  return raw ? JSON.parse(raw) : [];
}

async function saveWhitelist(chatId: string, list: string[], env: Env) {
  await env.BOT_CONFIG.put(`whitelist:${chatId}`, JSON.stringify(list));
}

/* ================= VIOLATIONS / AUTO MUTE ================= */

async function registerViolation(chatId: string, userId: number, env: Env) {
  const key = `vio:${chatId}:${userId}`;
  const count = Number(await env.BOT_CONFIG.get(key)) || 0;
  const newCount = count + 1;

  if (newCount >= 3) {
    await muteUser(chatId, userId, 30, env);
    await env.BOT_CONFIG.delete(key);
  } else {
    await env.BOT_CONFIG.put(key, String(newCount));
  }
}

/* ================= COMMANDS ================= */

async function handleCommand(msg: Message, env: Env) {
  const chatId = String(msg.chat.id);
  const text = msg.text || "";
  const [cmd, a1, a2] = text.split(" ");

  if (cmd === "/del" && msg.reply_to_message) {
    const sec = parseTime(a1 || "10s");
    await scheduleDelete(chatId, msg.reply_to_message.message_id, sec, env);
  }

  if (cmd === "/mute" && msg.reply_to_message?.from) {
    await muteUser(
      chatId,
      msg.reply_to_message.from.id,
      parseTime(a1 || "30m") / 60,
      env
    );
  }

  if (cmd === "/unmute" && msg.reply_to_message?.from) {
    await unmuteUser(chatId, msg.reply_to_message.from.id, env);
  }

  if (cmd === "/whitelist") {
    let list = await getWhitelist(chatId, env);

    if (a1 === "add" && a2) list.push(a2);
    if (a1 === "remove") list = list.filter(d => d !== a2);

    await saveWhitelist(chatId, list, env);
    await sendMessage(chatId, "Whitelist:\n" + list.join("\n"), env);
  }
}

/* ================= TIME ================= */

function parseTime(t: string): number {
  const m = t.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return 60;
  const n = +m[1];
  return m[2] === "s"
    ? n
    : m[2] === "m"
    ? n * 60
    : m[2] === "h"
    ? n * 3600
    : n * 86400;
}

/* ================= TELEGRAM API ================= */

async function tg(
  method: string,
  body: Record<string, any>,
  env: Env
) {
  await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function deleteMessage(chatId: string, msgId: number, env: Env) {
  await tg("deleteMessage", { chat_id: chatId, message_id: msgId }, env);
}

async function sendMessage(chatId: string, text: string, env: Env) {
  await tg("sendMessage", { chat_id: chatId, text }, env);
}

async function muteUser(chatId: string, userId: number, minutes: number, env: Env) {
  await tg(
    "restrictChatMember",
    {
      chat_id: chatId,
      user_id: userId,
      permissions: { can_send_messages: false },
      until_date: Math.floor(Date.now() / 1000) + minutes * 60
    },
    env
  );
}

async function unmuteUser(chatId: string, userId: number, env: Env) {
  await tg(
    "restrictChatMember",
    {
      chat_id: chatId,
      user_id: userId,
      permissions: { can_send_messages: true }
    },
    env
  );
}

/* ================= DELETE QUEUE ================= */

async function scheduleDelete(
  chatId: string,
  messageId: number,
  sec: number,
  env: Env
) {
  await env.BOT_CONFIG.put(
    `del:${chatId}:${messageId}`,
    String(Date.now() + sec * 1000)
  );
}

async function processDeleteQueue(env: Env) {
  const now = Date.now();
  const list = await env.BOT_CONFIG.list({ prefix: "del:" });

  for (const k of list.keys) {
    const t = Number(await env.BOT_CONFIG.get(k.name));
    if (t <= now) {
      const [, chatId, msgId] = k.name.split(":");
      await deleteMessage(chatId, Number(msgId), env);
      await env.BOT_CONFIG.delete(k.name);
    }
  }
}

/* ================= GROUP STORE ================= */

async function saveGroup(chat: Chat, env: Env) {
  await env.BOT_CONFIG.put(
    `group:${chat.id}`,
    JSON.stringify({ id: chat.id, title: chat.title })
  );
}
