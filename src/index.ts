const TG_API = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  BOT_CONFIG: KVNamespace;
}

/* ================= TYPES ================= */

interface Entity {
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
  entities?: Entity[];
  caption_entities?: Entity[];
  from?: User;
  chat: Chat;
  reply_to_message?: Message;
}

interface Update {
  message?: Message;
}

interface GroupSettings {
  deleteLinks: boolean;
  autoMute: boolean;
  maxViolations: number;
  muteMinutes: number;
  whitelist: string[];
}

/* ================= DEFAULT SETTINGS ================= */

const DEFAULT_SETTINGS: GroupSettings = {
  deleteLinks: true,
  autoMute: true,
  maxViolations: 3,
  muteMinutes: 30,
  whitelist: []
};

/* ================= WORKER ================= */

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (req.method !== "POST") return new Response("OK");
    const update = await req.json<Update>();
    if (!update.message) return new Response("OK");
    ctx.waitUntil(handleMessage(update.message, env));
    return new Response("OK");
  },

  async scheduled(_: ScheduledEvent, env: Env) {
    await processDeleteQueue(env);
  }
};

/* ================= MESSAGE HANDLER ================= */

async function handleMessage(msg: Message, env: Env) {
  if (!msg.from) return;
  if (msg.chat.type === "private") return;

  const chatId = String(msg.chat.id);
  const text = msg.text || msg.caption || "";

  await saveGroup(msg.chat, env);

  if (text.startsWith("/")) {
    await handleCommand(msg, env);
    return;
  }

  const settings = await getSettings(chatId, env);

  if (!settings.deleteLinks) return;

  if (hasAnyLink(msg, settings.whitelist)) {
    await deleteMessage(chatId, msg.message_id, env);

    if (settings.autoMute) {
      await registerViolation(chatId, msg.from.id, settings, env);
    }
  }
}

/* ================= LINK DETECTION ================= */

function hasAnyLink(msg: Message, whitelist: string[]): boolean {
  const text = (msg.text || msg.caption || "").toLowerCase();

  if (whitelist.some(w => text.includes(w.toLowerCase()))) return false;

  const regex =
    /((https?:\/\/|www\.)\S+|\b[a-z0-9.-]+\.[a-z]{2,}\S*)/i;

  if (regex.test(text)) return true;

  const entities = [
    ...(msg.entities || []),
    ...(msg.caption_entities || [])
  ];

  return entities.some(e => e.type === "url" || e.type === "text_link");
}

/* ================= SETTINGS ================= */

async function getSettings(chatId: string, env: Env): Promise<GroupSettings> {
  const raw = await env.BOT_CONFIG.get(`settings:${chatId}`);
  return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
}

async function saveSettings(chatId: string, s: GroupSettings, env: Env) {
  await env.BOT_CONFIG.put(`settings:${chatId}`, JSON.stringify(s));
}

/* ================= VIOLATIONS ================= */

async function registerViolation(
  chatId: string,
  userId: number,
  s: GroupSettings,
  env: Env
) {
  const key = `vio:${chatId}:${userId}`;
  const n = Number(await env.BOT_CONFIG.get(key)) || 0;
  const newCount = n + 1;

  if (newCount >= s.maxViolations) {
    await muteUser(chatId, userId, s.muteMinutes, env);
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

  const settings = await getSettings(chatId, env);

  /* ---- SETTINGS ---- */

  if (cmd === "/settings") {
    await sendMessage(
      chatId,
      formatSettings(settings),
      env
    );
    return;
  }

  if (cmd === "/set") {
    if (a1 === "links") settings.deleteLinks = a2 === "on";
    if (a1 === "automute") settings.autoMute = a2 === "on";
    if (a1 === "violations") settings.maxViolations = Number(a2);
    if (a1 === "mutetime") settings.muteMinutes = Number(a2);

    await saveSettings(chatId, settings, env);
    await sendMessage(chatId, "✅ Settings updated", env);
    return;
  }

  /* ---- WHITELIST ---- */

  if (cmd === "/whitelist") {
    if (a1 === "add" && a2) settings.whitelist.push(a2);
    if (a1 === "remove") settings.whitelist =
      settings.whitelist.filter(d => d !== a2);

    await saveSettings(chatId, settings, env);
    await sendMessage(
      chatId,
      "Whitelist:\n" + settings.whitelist.join("\n"),
      env
    );
    return;
  }

  /* ---- MODERATION ---- */

  if (cmd === "/mute" && msg.reply_to_message?.from) {
    await muteUser(
      chatId,
      msg.reply_to_message.from.id,
      parseTime(a1) / 60,
      env
    );
    return;
  }

  if (cmd === "/unmute" && msg.reply_to_message?.from) {
    await unmuteUser(chatId, msg.reply_to_message.from.id, env);
    return;
  }

  if (cmd === "/del" && msg.reply_to_message) {
    await scheduleDelete(
      chatId,
      msg.reply_to_message.message_id,
      parseTime(a1),
      env
    );
  }
}

/* ================= HELPERS ================= */

function formatSettings(s: GroupSettings): string {
  return (
    "⚙️ Group Settings:\n\n" +
    `Delete links: ${s.deleteLinks ? "ON" : "OFF"}\n` +
    `Auto mute: ${s.autoMute ? "ON" : "OFF"}\n` +
    `Max violations: ${s.maxViolations}\n` +
    `Mute time: ${s.muteMinutes} min\n\n` +
    "Commands:\n" +
    "/set links on|off\n" +
    "/set automute on|off\n" +
    "/set violations <number>\n" +
    "/set mutetime <minutes>"
  );
}

function parseTime(t = "10s"): number {
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

async function tg(method: string, body: any, env: Env) {
  await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function sendMessage(chatId: string, text: string, env: Env) {
  await tg("sendMessage", { chat_id: chatId, text }, env);
}

async function deleteMessage(chatId: string, id: number, env: Env) {
  await tg("deleteMessage", { chat_id: chatId, message_id: id }, env);
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
  msgId: number,
  sec: number,
  env: Env
) {
  await env.BOT_CONFIG.put(
    `del:${chatId}:${msgId}`,
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
