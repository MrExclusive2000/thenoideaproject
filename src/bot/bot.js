import { Bot, GrammyError } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { db, now } from '../db/db.js';
import { config } from '../config.js';
import { getSetting } from '../settings.js';
import { state } from '../state.js';
import { hub } from './hub.js';
import { registerCommands } from './commands.js';
import { registerFeedback } from './feedback.js';
import { registerOutageAnnounce } from './problems.js';
import { handleGroupMessage, handleDirectMessage } from './pipeline.js';

// Above this, a single message has stopped being slow and started being a
// fault worth reporting.
const SLOW_HANDLER_MS = 10 * 1000;
import { alertAdmins } from './reports.js';
import { recordJoin, markLeft, registerVetActions } from './joiners.js';
import { chatAllowed } from './helpers.js';

let bot = null;

export async function startBot() {
  if (!config.botToken) {
    state.bot.status = 'disabled';
    console.log('No TELEGRAM_BOT_TOKEN set — the web panel runs, the bot does not.');
    return null;
  }

  bot = new Bot(config.botToken);
  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  registerFeedback(bot);
  registerOutageAnnounce(bot);
  registerVetActions(bot);
  registerCommands(bot);

  // Membership tracking for the vetting flow. chat_member updates carry the
  // invite link, so /invite referrals are attributed to the inviter.
  bot.on('chat_member', (ctx) => {
    const upd = ctx.chatMember;
    if (!chatAllowed(upd.chat.id)) return;
    const wasIn = ['member', 'administrator', 'creator', 'restricted'].includes(upd.old_chat_member.status);
    const isIn = ['member', 'administrator', 'restricted'].includes(upd.new_chat_member.status);
    if (!wasIn && isIn) {
      const linkName = upd.invite_link?.name || '';
      const invitedBy = linkName.startsWith('ref:') ? Number(linkName.slice(4)) || null : null;
      recordJoin(upd.chat.id, upd.new_chat_member.user, invitedBy);
    } else if (wasIn && !isIn) {
      markLeft(upd.chat.id, upd.new_chat_member.user.id);
    }
  });

  // Group housekeeping: welcome messages and supergroup migration.
  bot.on('message:new_chat_members', async (ctx) => {
    const row = db.prepare('SELECT enabled FROM allowed_chats WHERE chat_id = ?').get(ctx.chat.id);
    if (!row?.enabled) return;
    for (const member of ctx.message.new_chat_members) {
      if (member.is_bot) continue;
      // Fallback join tracking (recordJoin dedupes with the chat_member path).
      recordJoin(ctx.chat.id, member);
      if (!getSetting('bot.welcomeEnabled')) continue;
      const text = String(getSetting('bot.welcomeText') || '').replace(/\{name\}/g, member.first_name || 'there');
      if (text) await ctx.reply(text).catch(() => {});
    }
  });

  // Telegram changes the chat id when a group upgrades to a supergroup —
  // carry the allowlist entry over so the bot keeps working.
  bot.on('message:migrate_to_chat_id', (ctx) => {
    const newId = ctx.message.migrate_to_chat_id;
    const old = db.prepare('SELECT * FROM allowed_chats WHERE chat_id = ?').get(ctx.chat.id);
    if (old) {
      db.prepare('INSERT OR REPLACE INTO allowed_chats (chat_id, title, enabled, added_at) VALUES (?, ?, ?, ?)')
        .run(newId, old.title, old.enabled, now());
      db.prepare('DELETE FROM allowed_chats WHERE chat_id = ?').run(ctx.chat.id);
      console.log(`chat migrated ${ctx.chat.id} → ${newId}`);
    }
  });

  // Fire-and-forget so one slow AI answer never blocks other users' messages
  // — FAQ replies stay instant while a generation is in flight. The AI itself
  // is protected by its own concurrency gate in ai/client.js.
  // All messages, not message:text — photos/captions need handling too (the
  // pipeline decides what deserves a reply and ignores the rest).
  bot.on('message', (ctx) => {
    // A message that takes this long has stopped being slow and started being
    // broken. Handlers run fire-and-forget so one of them cannot block the
    // others, but synchronous work (a SQLite query that lost its index, say)
    // blocks the whole process and the bot goes quiet with nothing in the log
    // to say why. Timing every message means the next time it happens, it
    // says so in the panel instead of looking like a dead bot.
    const started = Date.now();
    const handled = ctx.chat.type === 'private' ? handleDirectMessage(ctx) : handleGroupMessage(ctx);
    handled.then(() => {
      const ms = Date.now() - started;
      if (ms < SLOW_HANDLER_MS) return;
      const note = `A message took ${(ms / 1000).toFixed(1)}s to handle — something is running far slower than it should.`;
      console.error(note);
      state.bot.lastError = note;
      state.bot.lastSlowAt = Date.now();
    }).catch((err) => {
      console.error('handler error:', err.message);
      state.bot.lastError = String(err.message || err).slice(0, 300);
    });
  });

  bot.catch((err) => {
    const message = err.error?.message || String(err.error || err);
    console.error('bot error:', message);
    state.bot.lastError = message.slice(0, 300);
    alertAdmins('error', `❌ Bot error: ${message.slice(0, 200)}`);
  });

  // Long polling in the background. 409 = another instance is polling with
  // this token — surface it in the panel instead of crash-looping.
  bot.start({
    // chat_member (join/leave with invite-link attribution) is only delivered
    // when explicitly requested.
    allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
    onStart: (botInfo) => {
      state.bot.status = 'online';
      state.bot.username = botInfo.username;
      // Its display name as well as its @handle: people address it by the
      // name they can see ("Exclusive Manager, is bbc1 down?"), not by the
      // handle they have to remember.
      state.bot.firstName = botInfo.first_name || '';
      hub.api = bot.api;
      console.log(`Bot online as @${botInfo.username}`);
    },
  }).catch((err) => {
    hub.api = null;
    if (err instanceof GrammyError && err.error_code === 409) {
      state.bot.status = 'conflict';
      state.bot.lastError = 'Another instance of this bot is running (409). Stop the other one and restart.';
    } else if (err instanceof GrammyError && err.error_code === 401) {
      state.bot.status = 'error';
      state.bot.lastError = 'Bot token rejected by Telegram (401) — check TELEGRAM_BOT_TOKEN.';
    } else {
      state.bot.status = 'error';
      state.bot.lastError = String(err.message || err).slice(0, 300);
    }
    console.error('bot stopped:', state.bot.lastError);
  });

  return bot;
}

export async function stopBot() {
  if (!bot) return;
  hub.api = null;
  try {
    await bot.stop();
  } catch {
    // already stopped
  }
}
