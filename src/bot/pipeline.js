import { InlineKeyboard } from 'grammy';
import { db, now } from '../db/db.js';
import { getSetting } from '../settings.js';
import { matchFaq } from '../faq/matcher.js';
import { askAi, aiBudgetExceeded } from '../ai/client.js';
import { containsBannedWord } from '../ai/guardrails.js';
import { state } from '../state.js';
import {
  sendChunked, logMessage, setLogSource, recordUnanswered, chatAllowed,
  isLikelyInScope, recordProblem, extractProblemTopic,
} from './helpers.js';
import { alertAdmins } from './reports.js';
import { queueProblemAlert } from './problems.js';

// Per-user answer cooldowns and short DM conversation memory.
const cooldowns = new Map();
const dmHistory = new Map();

// Remembers what each bot reply answered so 👎 can feed the unanswered inbox.
export const replyContext = new Map();
function rememberReply(chatId, messageId, data) {
  replyContext.set(`${chatId}:${messageId}`, data);
  if (replyContext.size > 500) {
    const first = replyContext.keys().next().value;
    replyContext.delete(first);
  }
}

function feedbackKeyboard() {
  return new InlineKeyboard().text('👍', 'fb:up').text('👎', 'fb:down');
}

export function looksLikeQuestion(text) {
  if (text.includes('?')) return true;
  const starters = /^(how|what|why|when|where|which|who|can|does|do|is|are|will|help|anyone|any1|pls|please)\b/i;
  return starters.test(text.trim());
}

// Support groups mostly post problem STATEMENTS ("buffering on bbc1",
// "purple not working") — treat those as requests for help too.
export function looksLikeProblem(text) {
  return /\b(buffer(ing|s)?|freez\w*|frozen|lag(gy|ging|s)?|stutter\w*|glitch\w*|crash\w*|stuck|loading|offline|down|error|issue|problem|broken|playback|black ?screen|no (sound|audio|picture|video)|not work\w*|(doesnt|dont|isnt|aint|stopped) work\w*|wont (work|load|play|open|start)|cant (log ?in|sign in|watch|open|play|stream|connect)|keeps? (stopping|buffering|freezing|crashing|cutting))\b/i.test(text);
}

function mentionsBot(ctx, text) {
  const username = state.bot.username;
  if (username && text.toLowerCase().includes(`@${username.toLowerCase()}`)) return true;
  return ctx.message?.reply_to_message?.from?.id === ctx.me?.id;
}

function onCooldown(userId) {
  const seconds = Number(getSetting('bot.cooldownSeconds')) || 0;
  if (!seconds) return false;
  return Date.now() - (cooldowns.get(userId) || 0) < seconds * 1000;
}

function bumpCooldown(userId) {
  cooldowns.set(userId, Date.now());
  if (cooldowns.size > 5000) cooldowns.clear();
}

// Record at most one problem report per user per minute so a single person
// spamming "still buffering" doesn't flood the admin inbox.
const recentProblem = new Map();
function problemRecentlyFrom(userId) {
  return Date.now() - (recentProblem.get(userId) || 0) < 60000;
}
function markProblemRecorded(userId) {
  recentProblem.set(userId, Date.now());
  if (recentProblem.size > 5000) recentProblem.clear();
}

function getBannedWords() {
  return db.prepare('SELECT word FROM banned_words').all().map((r) => r.word);
}

function stripMention(text) {
  const username = state.bot.username;
  return username ? text.replace(new RegExp(`@${username}`, 'gi'), '').trim() : text;
}

// Core answering flow: FAQ first, then AI with strict-topic guardrails.
// `history` carries conversation context (DM memory, or a group reply chain);
// `skipFaq` is set for follow-up replies so the bot doesn't repeat the same
// FAQ instead of continuing the conversation.
// Exported so tests can drive it with a fake ctx.
export async function answer(ctx, question, { isDm, logId, history: providedHistory = null, skipFaq = false }) {
  const faqs = db.prepare('SELECT * FROM faqs WHERE enabled = 1').all();
  const threshold = Number(getSetting('faq.threshold')) || 0.5;
  const result = skipFaq ? { match: null, nearMiss: null } : matchFaq(question, faqs, threshold);
  const replyParams = isDm ? {} : { reply_parameters: { message_id: ctx.message.message_id } };

  if (result.match) {
    db.prepare('UPDATE faqs SET hit_count = hit_count + 1 WHERE id = ?').run(result.match.id);
    setLogSource(logId, 'faq');
    const sent = await sendChunked(ctx.api, ctx.chat.id, result.match.answer, {
      ...replyParams,
      reply_markup: feedbackKeyboard(),
    });
    if (sent) rememberReply(ctx.chat.id, sent.message_id, { question, faqId: result.match.id, source: 'faq' });
    return 'faq';
  }

  // FAQ missed — try the AI, unless it's off or out of budget.
  if (getSetting('ai.enabled')) {
    if (aiBudgetExceeded()) {
      alertAdmins('budget', '⚠️ The daily AI budget has been reached — until midnight UTC the bot only answers exact FAQ matches.');
    } else {
      try {
        await ctx.replyWithChatAction?.('typing')?.catch?.(() => {});
        const historyKey = `${ctx.chat.id}:${ctx.from.id}`;
        const history = providedHistory ?? (isDm ? (dmHistory.get(historyKey) || []) : []);
        // A problem report, an FAQ near-miss, or plain app/device vocabulary
        // means we already KNOW this is on-topic — stop the model bailing to
        // OFFTOPIC on legit questions (e.g. "how do I enable developer options").
        const assumeOnTopic = looksLikeProblem(question) || Boolean(result.nearMiss) || isLikelyInScope(question);
        const reply = await askAi(question, { history, assumeOnTopic });

        if (reply) {
          setLogSource(logId, 'ai');
          if (isDm) {
            dmHistory.set(historyKey, [...history, { role: 'user', content: question }, { role: 'assistant', content: reply }].slice(-6));
            if (dmHistory.size > 1000) dmHistory.clear();
          }
          const sent = await sendChunked(ctx.api, ctx.chat.id, reply, {
            ...replyParams,
            reply_markup: feedbackKeyboard(),
          });
          if (sent) rememberReply(ctx.chat.id, sent.message_id, { question, faqId: null, source: 'ai' });
          return 'ai';
        }

        // The model refused, but we have a near-miss FAQ — answer with that
        // instead of saying nothing.
        if (result.nearMiss) {
          db.prepare('UPDATE faqs SET hit_count = hit_count + 1 WHERE id = ?').run(result.nearMiss.id);
          setLogSource(logId, 'faq');
          recordUnanswered(question, ctx, 'ai-refused', result.nearMiss.id);
          const sent = await sendChunked(ctx.api, ctx.chat.id, result.nearMiss.answer, {
            ...replyParams,
            reply_markup: feedbackKeyboard(),
          });
          if (sent) rememberReply(ctx.chat.id, sent.message_id, { question, faqId: result.nearMiss.id, source: 'faq' });
          return 'faq';
        }

        // In scope but genuinely unanswerable: log it for the admin, and defer
        // to a human — never the dismissive off-topic line. In a DM we always
        // reply; in a group we only speak up if the admin chose 'redirect'
        // (silent mode means silent), so this can't get chatty.
        if (assumeOnTopic || isLikelyInScope(question)) {
          setLogSource(logId, 'unsure');
          recordUnanswered(question, ctx, 'ai-refused', null);
          if (isDm || getSetting('bot.offtopicBehavior') === 'redirect') {
            const msg = getSetting('bot.unsureMessage');
            if (msg) await ctx.api.sendMessage(ctx.chat.id, msg, replyParams);
          }
          return 'unsure';
        }

        // Truly unrelated to the service — strict-topic rule kicked in.
        setLogSource(logId, 'offtopic');
        if (looksLikeQuestion(question)) recordUnanswered(question, ctx, 'offtopic', null);
        if (getSetting('bot.offtopicBehavior') === 'redirect') {
          const msg = getSetting('bot.offtopicMessage');
          if (msg) await ctx.api.sendMessage(ctx.chat.id, msg, replyParams);
        }
        return 'offtopic';
      } catch (err) {
        console.error('AI error:', err.message);
        state.bot.lastError = `AI: ${err.message}`;
        alertAdmins('error', `❌ AI endpoint problem: ${String(err.message).slice(0, 200)}`);
      }
    }
  }

  // Nothing could answer.
  setLogSource(logId, 'none');
  recordUnanswered(question, ctx, 'nomatch', result.nearMiss?.id ?? null);
  const fallback = getSetting('bot.fallbackMessage');
  if (fallback) {
    await ctx.api.sendMessage(ctx.chat.id, fallback, replyParams);
  } else if (isDm) {
    await ctx.api.sendMessage(ctx.chat.id, "I couldn't answer that one. Send /ticket followed by your question and the team will help you personally.");
  }
  return 'none';
}

export async function handleGroupMessage(ctx) {
  const text = ctx.message?.text;
  if (!text) return;
  state.bot.groupMessagesSeen++;
  state.bot.lastUpdateAt = Date.now();

  if (!chatAllowed(ctx.chat.id)) return;
  const logId = logMessage(ctx.chat.id, ctx.from, text, null);
  if (!getSetting('bot.enabled')) return;

  if (containsBannedWord(text, getBannedWords())) {
    alertAdmins('bannedWord', `🚫 Banned word in ${ctx.chat.title || ctx.chat.id} from @${ctx.from?.username || ctx.from?.first_name}: "${text.slice(0, 120)}"`);
    return;
  }

  const mode = getSetting('bot.responseMode');
  const mentioned = mentionsBot(ctx, text);
  const question = stripMention(text);
  if (question.length < 3) return;

  const isProblem = looksLikeProblem(text);

  let shouldAnswer = mode === 'all' || mentioned;
  if (!shouldAnswer && mode === 'questions') {
    shouldAnswer = looksLikeQuestion(text) || isProblem;
    if (!shouldAnswer) {
      // Last check: if the FAQ can answer this confidently, answer it —
      // staying silent on a known answer helps nobody.
      const faqs = db.prepare('SELECT * FROM faqs WHERE enabled = 1').all();
      shouldAnswer = Boolean(matchFaq(question, faqs, Number(getSetting('faq.threshold')) || 0.5).match);
    }
  }

  // Surface problem reports to admins (buffering, channels down, ...) so they
  // can spot outages. Deduped per user so one person can't spam the inbox.
  if (isProblem && !problemRecentlyFrom(ctx.from.id)) {
    markProblemRecorded(ctx.from.id);
    const willAnswer = shouldAnswer && !onCooldown(ctx.from.id);
    recordProblem(ctx, text, { answered: willAnswer });
    queueProblemAlert({
      tg_user: ctx.from?.username || ctx.from?.first_name,
      tg_user_id: ctx.from?.id,
      text,
      topic: extractProblemTopic(text),
    });
  }

  if (!shouldAnswer) return;

  if (onCooldown(ctx.from.id)) return;
  bumpCooldown(ctx.from.id);

  // Replying to one of the bot's messages is a follow-up conversation: give
  // the AI the reply chain as context and don't just re-match the same FAQ.
  const repliedTo = ctx.message.reply_to_message;
  const isFollowUp = repliedTo?.from?.id === ctx.me?.id && Boolean(repliedTo.text);
  let history = null;
  if (isFollowUp) {
    const prev = replyContext.get(`${ctx.chat.id}:${repliedTo.message_id}`);
    history = [
      ...(prev?.question ? [{ role: 'user', content: String(prev.question).slice(0, 1000) }] : []),
      { role: 'assistant', content: String(repliedTo.text).slice(0, 1500) },
    ];
  }

  await answer(ctx, question, { isDm: false, logId, history, skipFaq: isFollowUp });
}

export async function handleDirectMessage(ctx) {
  const text = ctx.message?.text;
  if (!text) return;
  state.bot.lastUpdateAt = Date.now();
  if (!getSetting('bot.enabled')) return;

  // An open ticket turns the DM into a support thread: messages go to the
  // ticket, not the AI.
  const openTicket = db.prepare(
    "SELECT * FROM tickets WHERE telegram_user_id = ? AND status != 'closed' ORDER BY id DESC LIMIT 1"
  ).get(ctx.from.id);
  if (openTicket) {
    db.prepare('INSERT INTO ticket_messages (ticket_id, sender, body, ts) VALUES (?, ?, ?, ?)')
      .run(openTicket.id, 'customer', text.slice(0, 3500), now());
    db.prepare("UPDATE tickets SET status = 'open', updated_at = ? WHERE id = ?").run(now(), openTicket.id);
    alertAdmins('ticket', `🎫 New reply on ticket #${openTicket.id} from @${ctx.from?.username || ctx.from?.first_name}:\n"${text.slice(0, 200)}"`);
    await ctx.reply(`Added to your ticket #${openTicket.id} — the team will get back to you. (Send /close to close it.)`);
    return;
  }

  if (!getSetting('bot.dmEnabled')) return;
  if (containsBannedWord(text, getBannedWords())) return;
  if (onCooldown(ctx.from.id)) return;
  bumpCooldown(ctx.from.id);

  const logId = logMessage(ctx.chat.id, ctx.from, text, null);
  await answer(ctx, text, { isDm: true, logId });
}
