const TG_API = "https://api.telegram.org";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  BOT_CONFIG: KVNamespace;
  OWNER_USER_IDS?: string;
}

type GroupConfig = {
  antilink: boolean;
  antiforward: boolean;
  autoMuteAfter: number;
  autoMuteMinutes: number;
  whitelist: string[];
};

const DEFAULT_CONFIG: GroupConfig = {
  antilink: true,
  antiforward: true,
  autoMuteAfter: 3,
  autoMuteMinutes: 30,
  whitelist: []
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (req.method !== "POST") return new Response("OK");

    const update = await req.json<any>();

    if (update.message) {
      ctx.waitUntil(handleMessage(update.message, env));
    }

    if (update.my_chat_member) {
      ctx.waitUntil(handleMyChatMember(update.my_chat_member, env));
    }

    return new Response("OK");
  }
};

/* ================= OWNERS ================= */

function isOwner(userId: number, env: Env): boolean {
  if (!env.OWNER_USER_IDS) return true;
  return env.OWNER_USER_IDS.split(",").map(s => s.trim()).includes(String(userId));
}

/* ================= MAIN MESSAGE HANDLER ================= */

async function handleMessage(msg: any, env: Env) {
  const chat = msg.chat;
  const text = msg.text || msg.caption || "";

  if (chat.type === "group" || chat.type === "supergroup") {
    await trackGroup(chat, env);
  }

  if (chat.type === "private") {
    if (!msg.from || !isOwner(msg.from.id, env)) {
      await send(chat.id, "Access denied.", env);
      return;
    }
    if (text.startsWith("/")) await handlePrivateCommand(msg, env);
    return;
  }

  if (chat.type !== "group" && chat.type !== "supergroup") return;

  if (text.startsWith("/")) {
    await handleGroupCommand(msg, env);
    return;
  }

  const user = msg.from;
  if (!user) return;

  const cfg = await getConfig(chat.id, env);

  const isForward =
    msg.forward_from || msg.forward_from_chat || msg.forward_sender_name;

  if (cfg.antiforward && isForward) {
    await deleteMsg(chat.id, msg.message_id, env);
    await recordViolation(chat.id, user.id, cfg, env);
    return;
  }

  if (cfg.antilink && hasLink(text, cfg.whitelist)) {
    await deleteMsg(chat.id, msg.message_id, env);
    await recordViolation(chat.id, user.id, cfg, env);
  }
}

/* ================= GROUP COMMANDS ================= */

async function handleGroupCommand(msg: any, env: Env) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const [cmd, arg] = text.split(" ");

  const isAnonAdmin = msg.sender_chat?.id === chatId;
  let isRealAdmin = false;

  if (msg.from) {
    isRealAdmin = await isAdmin(chatId, msg.from.id, env);
  }

  const allowed = isAnonAdmin || isRealAdmin;
  if (!allowed) return;

  if (cmd === "/mute" && msg.reply_to_message?.from) {
    await mute(chatId, msg.reply_to_message.from.id, parseTime(arg), env);
  }

  if (cmd === "/unmute" && msg.reply_to_message?.from) {
    await unmute(chatId, msg.reply_to_message.from.id, env);
  }

  if (cmd === "/del" && msg.reply_to_message) {
    await scheduleDelete(chatId, msg.reply_to_message.message_id, parseTime(arg), env);
  }
}

/* ================= PRIVATE COMMANDS ================= */

async function handlePrivateCommand(msg: any, env: Env) {
  const chatId = msg.chat.id;
  const parts = msg.text.trim().split(" ");
  const cmd = parts[0];

  if (cmd === "/groups") {
    const list = await env.BOT_CONFIG.list({ prefix: "group:" });
    const out: string[] = [];
    for (const k of list.keys) {
      const data = await env.BOT_CONFIG.get(k.name);
      if (!data) continue;
      const g = JSON.parse(data);
      if (g.active !== false)
        out.push(`${g.title || "Unnamed"} (${g.id})`);
    }
    await send(chatId, out.join("\n") || "No groups.", env);
  }

  if (cmd === "/settings" && parts[1]) {
    const cfg = await getConfig(parts[1], env);
    await send(chatId, JSON.stringify(cfg, null, 2), env);
  }

  if (cmd === "/set" && parts.length >= 4) {
    const [, gid, key, val] = parts;
    const cfg = await getConfig(gid, env);

    if (key === "antilink") cfg.antilink = val === "on";
    if (key === "antiforward") cfg.antiforward = val === "on";
    if (key === "automute_after") cfg.autoMuteAfter = Number(val);
    if (key === "automute_minutes") cfg.autoMuteMinutes = Number(val);

    await saveConfig(gid, cfg, env);
    await send(chatId, "Updated.", env);
  }

  if (cmd === "/whitelist" && parts.length >= 3) {
    const [, gid, action, domain] = parts;
    const cfg = await getConfig(gid, env);

    if (action === "add" && domain) cfg.whitelist.push(domain);
    if (action === "remove")
      cfg.whitelist = cfg.whitelist.filter(d => d !== domain);

    await saveConfig(gid, cfg, env);
    await send(chatId, "Whitelist updated.", env);
  }
}

/* ================= GROUP TRACKING ================= */

async function trackGroup(chat: any, env: Env) {
  await env.BOT_CONFIG.put(
    `group:${chat.id}`,
    JSON.stringify({ id: chat.id, title: chat.title, active: true })
  );
}

async function handleMyChatMember(update: any, env: Env) {
  const chat = update.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;

  if (["left", "kicked"].includes(update.new_chat_member.status)) {
    const key = `group:${chat.id}`;
    const data = await env.BOT_CONFIG.get(key);
    if (data) {
      const g = JSON.parse(data);
      g.active = false;
      await env.BOT_CONFIG.put(key, JSON.stringify(g));
    }
  }
}

/* ================= CONFIG ================= */

async function getConfig(chatId: string, env: Env): Promise<GroupConfig> {
  const raw = await env.BOT_CONFIG.get(`cfg:${chatId}`);
  return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
}

async function saveConfig(chatId: string, cfg: GroupConfig, env: Env) {
  await env.BOT_CONFIG.put(`cfg:${chatId}`, JSON.stringify(cfg));
}

/* ================= MODERATION ================= */

async function recordViolation(chatId: string, userId: number, cfg: GroupConfig, env: Env) {
  const key = `vio:${chatId}:${userId}`;
  const n = Number(await env.BOT_CONFIG.get(key)) || 0;
  if (n + 1 >= cfg.autoMuteAfter) {
    await mute(chatId, userId, cfg.autoMuteMinutes * 60, env);
    await env.BOT_CONFIG.delete(key);
  } else {
    await env.BOT_CONFIG.put(key, String(n + 1));
  }
}

/* ================= UTILITIES ================= */

function hasLink(text: string, whitelist: string[]) {
  const rx = /\b[\w.-]+\.[a-z]{2,}\b/i;
  const found = rx.exec(text);
  if (!found) return false;
  return !whitelist.some(d => found[0].endsWith(d));
}

function parseTime(t = "10s"): number {
  const m = t.match(/^(\d+)(s|m|h)$/);
  if (!m) return 10;
  const n = +m[1];
  return m[2] === "s" ? n : m[2] === "m" ? n * 60 : n * 3600;
}

/* ================= TELEGRAM API ================= */

async function tg(method: string, body: any, env: Env) {
  await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function send(chatId: number, text: string, env: Env) {
  await tg("sendMessage", { chat_id: chatId, text }, env);
}

async function deleteMsg(chatId: number, msgId: number, env: Env) {
  await tg("deleteMessage", { chat_id: chatId, message_id: msgId }, env);
}

async function mute(chatId: number, userId: number, seconds: number, env: Env) {
  await tg("restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    permissions: { can_send_messages: false },
    until_date: Math.floor(Date.now() / 1000) + seconds
  }, env);
}

async function unmute(chatId: number, userId: number, env: Env) {
  await tg("restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    permissions: { can_send_messages: true }
  }, env);
}

async function isAdmin(chatId: number, userId: number, env: Env): Promise<boolean> {
  const res = await fetch(
    `${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/getChatMember`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, user_id: userId })
    }
  ).then(r => r.json());

  return ["administrator", "creator"].includes(res?.result?.status);
}

async function scheduleDelete(chatId: number, msgId: number, sec: number, env: Env) {
  await env.BOT_CONFIG.put(`del:${chatId}:${msgId}`, String(Date.now() + sec * 1000));
}
