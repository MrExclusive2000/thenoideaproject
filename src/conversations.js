import { db } from './db/db.js';

// The message log is flat: one row per message, in time order. The valuable
// shape is a THREAD — a question with whatever answered it — and Telegram
// gives us exactly one reliable way to rebuild that, the reply_to id captured
// on every row since v13.
//
// Deliberately NOT inferred: "an admin spoke 40 seconds after a question, so
// that must be the answer". In a busy group that pairs the wrong two messages
// constantly, and a corpus full of confidently wrong Q&A pairs is worse than
// a smaller honest one. Unreplied admin messages still export as plain
// messages — they are just not claimed as answers to anything.

const SELECT_COLUMNS =
  'id, chat_id, chat_title, tg_user_id, tg_username, text, reply_source, ' +
  'bot_reply, tg_msg_id, reply_to_tg_msg_id, is_admin, ts';

export function conversationMessages({ chatId = null, since = 0, limit = 5000 } = {}) {
  const where = ['ts >= ?'];
  const args = [since];
  if (chatId != null) {
    where.push('chat_id = ?');
    args.push(chatId);
  }
  return db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM messages_log
     WHERE ${where.join(' AND ')}
     ORDER BY ts DESC LIMIT ?`
  ).all(...args, limit).reverse();
}

// Returns one entry per message that got an answer: the bot's reply (stored on
// the question's own row) and/or any message that explicitly replied to it.
export function conversationThreads({ chatId = null, since = 0, limit = 5000 } = {}) {
  const rows = conversationMessages({ chatId, since, limit });

  const repliesTo = new Map();
  for (const r of rows) {
    if (r.reply_to_tg_msg_id == null) continue;
    const key = `${r.chat_id}:${r.reply_to_tg_msg_id}`;
    if (!repliesTo.has(key)) repliesTo.set(key, []);
    repliesTo.get(key).push(r);
  }

  const threads = [];
  for (const r of rows) {
    const answers = [];
    if (r.bot_reply) {
      answers.push({ from: 'bot', via: r.reply_source, text: r.bot_reply, ts: r.ts });
    }
    for (const a of repliesTo.get(`${r.chat_id}:${r.tg_msg_id}`) || []) {
      answers.push({
        from: a.is_admin ? 'admin' : 'member',
        username: a.tg_username,
        text: a.text,
        ts: a.ts,
      });
    }
    if (!answers.length) continue;
    threads.push({
      chat: r.chat_title || String(r.chat_id),
      ts: r.ts,
      asked_by: r.tg_username,
      asked_by_admin: Boolean(r.is_admin),
      question: r.text,
      answers,
    });
  }
  return threads;
}

// Questions nobody answered — neither the bot nor a human. The most useful
// list in the panel: every one of these is either a missing FAQ or a customer
// who walked away unhelped.
export function unansweredThreads({ chatId = null, since = 0, limit = 5000 } = {}) {
  const rows = conversationMessages({ chatId, since, limit });
  const answered = new Set();
  for (const r of rows) {
    if (r.reply_to_tg_msg_id != null) answered.add(`${r.chat_id}:${r.reply_to_tg_msg_id}`);
  }
  return rows.filter((r) =>
    !r.bot_reply &&
    !r.is_admin &&
    !answered.has(`${r.chat_id}:${r.tg_msg_id}`) &&
    String(r.text || '').trim().length > 8
  );
}

export function conversationStats(since = 0) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const total = one('SELECT COUNT(*) n FROM messages_log WHERE ts >= ?', since).n;
  const fromAdmins = one('SELECT COUNT(*) n FROM messages_log WHERE ts >= ? AND is_admin = 1', since).n;
  const botAnswered = one('SELECT COUNT(*) n FROM messages_log WHERE ts >= ? AND bot_reply IS NOT NULL', since).n;
  const humanReplies = one('SELECT COUNT(*) n FROM messages_log WHERE ts >= ? AND reply_to_tg_msg_id IS NOT NULL', since).n;
  const chats = db.prepare(
    'SELECT chat_id, MAX(chat_title) chat_title, COUNT(*) n FROM messages_log WHERE ts >= ? GROUP BY chat_id ORDER BY n DESC'
  ).all(since);
  const oldest = one('SELECT MIN(ts) t FROM messages_log').t;
  return { total, fromAdmins, botAnswered, humanReplies, chats, oldest };
}

export const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
