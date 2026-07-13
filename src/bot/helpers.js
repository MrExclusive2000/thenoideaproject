import { db, now } from '../db/db.js';
import { getSetting } from '../settings.js';

export const TG_MAX = 4096;

export function chunkText(text, size = TG_MAX) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// All bot replies go out as plain text — LLM output as MarkdownV2 is a
// guaranteed source of parse errors from unbalanced entities.
export async function sendChunked(api, chatId, text, extra = {}) {
  const chunks = chunkText(text);
  let last = null;
  for (let i = 0; i < chunks.length; i++) {
    // Only the final chunk carries the reply markup (feedback buttons).
    const opts = i === chunks.length - 1 ? extra : {};
    last = await api.sendMessage(chatId, chunks[i], opts);
  }
  return last;
}

export function isAdminUser(userId) {
  const ids = getSetting('reports.adminTelegramIds') || [];
  return ids.includes(userId);
}

export function chatAllowed(chatId) {
  const row = db.prepare('SELECT enabled FROM allowed_chats WHERE chat_id = ?').get(chatId);
  return Boolean(row?.enabled);
}

export function linkedCustomer(telegramUserId) {
  return db.prepare('SELECT * FROM customers WHERE telegram_user_id = ?').get(telegramUserId) || null;
}

export function customerUsable(customer) {
  if (!customer) return { ok: false, why: 'not-linked' };
  if (!customer.active) return { ok: false, why: 'disabled' };
  if (customer.expires_at && customer.expires_at < now()) return { ok: false, why: 'expired' };
  return { ok: true };
}

export function latestFile() {
  return db.prepare('SELECT * FROM files WHERE visible = 1 ORDER BY is_latest DESC, uploaded_at DESC LIMIT 1').get() || null;
}

export function logMessage(chatId, from, text, replySource) {
  const info = db.prepare('INSERT INTO messages_log (chat_id, tg_user_id, tg_username, text, reply_source, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(chatId, from?.id || null, from?.username || from?.first_name || null, String(text || '').slice(0, 500), replySource, now());
  return info.lastInsertRowid;
}

export function setLogSource(logId, source) {
  if (logId) db.prepare('UPDATE messages_log SET reply_source = ? WHERE id = ?').run(source, logId);
}

export function recordUnanswered(text, ctx, source, nearMissFaqId = null) {
  db.prepare('INSERT INTO unanswered (text, chat_id, chat_title, tg_user, near_miss_faq_id, source, ts) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      String(text).slice(0, 500),
      ctx.chat?.id || null,
      ctx.chat?.title || (ctx.chat?.type === 'private' ? 'DM' : null),
      ctx.from?.username || ctx.from?.first_name || null,
      nearMissFaqId,
      source,
      now()
    );
}
