import { db, now } from '../db/db.js';
import { replyContext } from './pipeline.js';
import { recordUnanswered } from './helpers.js';
import { forgetAnswerByText } from '../ai/answer-cache.js';

export function registerFeedback(bot) {
  bot.callbackQuery(/^fb:(up|down)$/, async (ctx) => {
    const rating = ctx.match[1];
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return ctx.answerCallbackQuery();

    const context = replyContext.get(`${chatId}:${messageId}`) || {};
    try {
      db.prepare(`
        INSERT INTO answer_feedback (chat_id, message_id, faq_id, source, rating, tg_user_id, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, message_id, tg_user_id) DO UPDATE SET rating = excluded.rating, ts = excluded.ts
      `).run(chatId, messageId, context.faqId ?? null, context.source ?? null, rating, ctx.from.id, now());
    } catch (err) {
      console.error('feedback save failed:', err.message);
    }

    // A thumbs-down puts the original question in the admin's review inbox.
    if (rating === 'down' && context.question) {
      recordUnanswered(context.question, ctx, 'feedback', context.faqId ?? null);
    }
    // ...and evicts the answer from the semantic cache. Keeping it would serve
    // the same wrong answer to the next person who asks the same thing, and a
    // cached mistake is worse than an uncached one because it never gets
    // rewritten.
    if (rating === 'down' && context.answer) {
      forgetAnswerByText(context.answer);
    }

    await ctx.answerCallbackQuery({ text: rating === 'up' ? 'Thanks! 👍' : 'Sorry about that — flagged for the team. 🙏' });
  });
}
