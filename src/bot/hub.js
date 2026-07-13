import { db } from '../db/db.js';
import { getSetting } from '../settings.js';

// The bot registers its grammY `api` here on startup; the web panel and
// schedulers send through it. Every send is best-effort — the panel must keep
// working when the bot is offline.
export const hub = {
  api: null,

  get online() {
    return Boolean(this.api);
  },

  async send(chatId, text, extra = {}) {
    if (!this.api) throw new Error('Bot is not running');
    return this.api.sendMessage(chatId, text, extra);
  },

  // DM every configured admin Telegram ID. Silently skips when unset/offline.
  async notifyAdmins(text) {
    const ids = getSetting('reports.adminTelegramIds') || [];
    if (!this.api || !ids.length) return false;
    let sent = false;
    for (const id of ids) {
      try {
        await this.api.sendMessage(id, text);
        sent = true;
      } catch (err) {
        console.error(`notifyAdmins: failed for ${id}:`, err.message);
      }
    }
    return sent;
  },

  // Send to every enabled allowed chat. Returns per-chat results.
  async sendToAllowedChats(text) {
    if (!this.api) throw new Error('Bot is not running');
    const chats = db.prepare('SELECT chat_id, title FROM allowed_chats WHERE enabled = 1').all();
    if (!chats.length) throw new Error('No allowed chats configured');
    const results = [];
    for (const chat of chats) {
      try {
        await this.api.sendMessage(chat.chat_id, text);
        results.push({ chat: chat.title || chat.chat_id, ok: true });
      } catch (err) {
        results.push({ chat: chat.title || chat.chat_id, ok: false, error: err.message });
      }
    }
    return results;
  },
};
