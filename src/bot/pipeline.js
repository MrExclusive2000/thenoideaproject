import { InlineKeyboard } from 'grammy';
import { db, now } from '../db/db.js';
import { getSetting } from '../settings.js';
import { matchFaq } from '../faq/matcher.js';
import { askAi, aiBudgetExceeded } from '../ai/client.js';
import { containsBannedWord } from '../ai/guardrails.js';
import { state } from '../state.js';
import {
  sendChunked, logMessage, setLogSource, recordUnanswered, chatAllowed,
  isLikelyInScope, recordProblem, extractProblemTopic, isAdminUser,
} from './helpers.js';
import { alertAdmins } from './reports.js';
import { queueProblemAlert, setProblemRearmHook } from './problems.js';
import { hub } from './hub.js';

// Per-user answer cooldowns and short DM conversation memory.
const cooldowns = new Map();
const dmHistory = new Map();

// When the AI asks a clarifying question in a group ("Which device are you
// on?"), remember it per user so their next bare answer ("firestick") gets
// combined with the original question and re-run through the pipeline.
const CLARIFY_TTL_MS = 10 * 60 * 1000;
const pendingClarify = new Map(); // chatId:userId -> { question, at }

function setPendingClarify(chatId, userId, question) {
  pendingClarify.set(`${chatId}:${userId}`, { question, at: Date.now() });
  if (pendingClarify.size > 500) {
    const first = pendingClarify.keys().next().value;
    pendingClarify.delete(first);
  }
}

function takePendingClarify(chatId, userId) {
  const key = `${chatId}:${userId}`;
  const entry = pendingClarify.get(key);
  if (!entry) return null;
  pendingClarify.delete(key);
  return Date.now() - entry.at < CLARIFY_TTL_MS ? entry : null;
}

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
// Two tiers so general chat can't trigger it: unambiguous problem phrases
// count on their own; generic words ("calm DOWN mate", "the PROBLEM with
// him is...") only count when the message also mentions the service.
const STRONG_PROBLEM =
  /\b(buffer(ing|s)?|freez\w*|frozen|lag(gy|ging|s)?|stutter\w*|glitch\w*|crash\w*|playback|black ?screen|no (sound|audio|picture|video|streams?|channels?|epg|vod)|invalid|unauthori[sz]ed|logged (out|off)|wrong password|access denied|wrong (language|audio|sound)|only (one|1) (language|audio( track)?|track)|not work\w*|(doesnt|dont|isnt|aint|stopped) work\w*|wont (work|load|play|open|start)|cant (log ?in|sign in|watch|open|play|stream|connect)|keeps? (stopping|buffering|freezing|crashing|cutting|loading)|(is|are|was|were|gone|went|still) down|offline)\b/i;
const WEAK_PROBLEM = /\b(down|error|issues?|problems?|stuck|loading|broken)\b/i;

export function looksLikeProblem(text) {
  if (STRONG_PROBLEM.test(text)) return true;
  return WEAK_PROBLEM.test(text) && isLikelyInScope(text);
}

// Lead problem answers with the known-issue banner when the admin has set a
// non-operational service status — "invalid user" during a login outage is
// almost certainly the outage, not the user's typo.
function serviceStatusLine() {
  const status = getSetting('service.status');
  if (status === 'operational') return null;
  const note = getSetting('service.note');
  return `⚠️ We're aware of a service issue right now${note ? ` — ${note}` : ''}. This may be what you're seeing.`;
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

// Two-stage problem triage: the FIRST report from a user gets the fixes and an
// invitation to confirm — no admin ping. A CONFIRMATION (another problem
// message within the window, a reply to the bot, or "still ...") escalates to
// the admins. Separately, several DIFFERENT users reporting within 15 minutes
// triggers one outage alert even without confirmations.
const PROBLEM_WINDOW_MS = 30 * 60 * 1000;
const problemState = new Map(); // userId -> { at, escalatedAt }

function getProblemState(userId) {
  const st = problemState.get(userId);
  if (!st || Date.now() - st.at > PROBLEM_WINDOW_MS) return null;
  return st;
}

function setProblemState(userId, patch) {
  const st = problemState.get(userId) || {};
  problemState.set(userId, { ...st, ...patch });
  if (problemState.size > 5000) problemState.clear();
}

function saysStillBroken(text) {
  return /\b(still|again|didnt (work|help)|didn't (work|help)|no luck|not fixed|same (issue|problem)|tried (all|everything|them|those|that))\b/i.test(text);
}

// "BBC 1 22:54", "since 9pm" — the details the bot asked for.
function hasTimeDetail(text) {
  return /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s?(am|pm)\b/i.test(text);
}

// "username is fine", "already tried that", "nothing works" — the user is
// telling us the suggested fixes don't apply. That's an implicit "still
// broken", not a reason to repeat the same FAQ.
function negatesFixes(text) {
  return /\b((is|are|was|were|looks?) (fine|right|correct|ok|okay)|already (tried|did|done|checked)|(tried|checked|done|did) (it|that|them|those|all|everything)|nothing (works|worked|changed|happens)|(didnt|didn't|doesnt|doesn't) (help|work|change))\b/i.test(text);
}

// "that fixed it", "working now", "all good" — the problem is over.
function saysResolved(text) {
  return /\b(fixed|sorted|solved|resolved|working now|works now|all good|that (worked|did it)|back to normal|(fine|good|ok|okay|sorted|perfect) now|no more (buffering|freezing|lagging|issues?|problems?))\b/i.test(text);
}

// Test helper: clear triage memory between scenarios.
export function _resetProblemTriage() {
  problemState.clear();
  lastOutageAlertAt = 0;
}

// When auto-close messages a user ("assuming it's sorted — reply if not"),
// re-arm their triage state so a late "still broken" escalates directly.
setProblemRearmHook((userId) => {
  problemState.set(userId, { at: Date.now(), escalatedAt: null, answeredAt: null, nudgedAt: Date.now() });
});

let lastOutageAlertAt = 0;
function checkOutage() {
  if (Date.now() - lastOutageAlertAt < 30 * 60 * 1000) return;
  const distinct = db.prepare(
    'SELECT COUNT(DISTINCT tg_user_id) n FROM problem_reports WHERE ts > ?'
  ).get(now() - 15 * 60).n;
  if (distinct >= 3) {
    lastOutageAlertAt = Date.now();
    alertAdmins('problem', `⚠️ Possible outage: ${distinct} different people reported problems in the last 15 minutes. Check the panel → Problem reports.`);
  }
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
// FAQ instead of continuing the conversation. `suffix` is appended to any
// actual answer (e.g. "flagged to the team" after a problem report).
// Exported so tests can drive it with a fake ctx.
export async function answer(ctx, question, { isDm, logId, history: providedHistory = null, skipFaq = false, suffix = null, prefix = null }) {
  const faqs = db.prepare('SELECT * FROM faqs WHERE enabled = 1').all();
  const threshold = Number(getSetting('faq.threshold')) || 0.5;
  const result = skipFaq ? { match: null, nearMiss: null } : matchFaq(question, faqs, threshold);
  const replyParams = isDm ? {} : { reply_parameters: { message_id: ctx.message.message_id } };
  const withSuffix = (text) => [prefix, text, suffix].filter(Boolean).join('\n\n');

  if (result.match) {
    db.prepare('UPDATE faqs SET hit_count = hit_count + 1 WHERE id = ?').run(result.match.id);
    setLogSource(logId, 'faq');
    const sent = await sendChunked(ctx.api, ctx.chat.id, withSuffix(result.match.answer), {
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
          // A reply ending in "?" is the model's one allowed clarifying
          // question — remember it so the user's next bare answer combines.
          if (!isDm && reply.trimEnd().endsWith('?')) {
            setPendingClarify(ctx.chat.id, ctx.from.id, question);
          }
          const sent = await sendChunked(ctx.api, ctx.chat.id, withSuffix(reply), {
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
          const sent = await sendChunked(ctx.api, ctx.chat.id, withSuffix(result.nearMiss.answer), {
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
        // Overloaded (queue full / waited too long / generation timed out):
        // tell the user honestly instead of going silent. Queued requests that
        // DID get a slot never land here — waiting in line is the retry.
        if (err.code === 'AI_BUSY' || err.code === 'AI_TIMEOUT') {
          setLogSource(logId, 'busy');
          const busy = getSetting('bot.busyMessage');
          if (busy) await ctx.api.sendMessage(ctx.chat.id, busy, replyParams).catch(() => {});
          if (err.code === 'AI_TIMEOUT') {
            state.bot.lastError = `AI: ${err.message}`;
            alertAdmins('error', `⏱ AI overloaded/slow: ${String(err.message).slice(0, 200)}`);
          }
          return 'busy';
        }
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

  // Admins post ANNOUNCEMENTS ("Guys — ask about URLs, install guides,
  // buffering...") that are full of trigger vocabulary but aren't support
  // requests — never run those through the FAQ or problem triage. An
  // announcement is an admin statement that addresses the group or spans
  // multiple lines. Admins' real questions still get answered (easy
  // self-testing), as does anything mentioning or replying to the bot.
  // bot.ignoreAdmins silences the bot for admin messages entirely.
  if (isAdminUser(ctx.from.id) && !mentioned) {
    const announcement = !looksLikeQuestion(text) &&
      (text.includes('\n') || /^(guys|everyone|all|lads|folks|team|announcement|attention|update|reminder|notice|fyi|psa|morning|evening|afternoon)\b/i.test(text.trim()));
    if (announcement || getSetting('bot.ignoreAdmins')) return;
  }

  const isProblem = looksLikeProblem(text);
  const faqThreshold = Number(getSetting('faq.threshold')) || 0.5;
  const standaloneFaqMatch = () => {
    const faqs = db.prepare('SELECT * FROM faqs WHERE enabled = 1').all();
    return Boolean(matchFaq(question, faqs, faqThreshold).match);
  };

  // Answer to a pending clarifying question? A bare fragment ("firestick")
  // that wouldn't trigger on its own gets combined with the original
  // question and re-run through the whole pipeline (FAQ first, then AI).
  // Anything that stands on its own is treated as a new message instead.
  {
    const pending = takePendingClarify(ctx.chat.id, ctx.from.id);
    if (pending && !looksLikeQuestion(text) && !isProblem && !standaloneFaqMatch()) {
      bumpCooldown(ctx.from.id);
      await answer(ctx, `${pending.question} — ${question}`, { isDm: false, logId });
      return;
    }
  }

  let shouldAnswer = mode === 'all' || mentioned;
  if (!shouldAnswer && mode === 'questions') {
    shouldAnswer = looksLikeQuestion(text) || isProblem || standaloneFaqMatch();
  }

  const repliedTo = ctx.message.reply_to_message;
  const isFollowUp = repliedTo?.from?.id === ctx.me?.id && Boolean(repliedTo.text);

  // Problem triage: fixes first, admin escalation only on confirmation.
  // A confirmation rarely repeats the problem words — real users type "still
  // happening", "BBC 1 22:54" or just reply to the bot — so with an active
  // report, any non-question reply, still-broken phrasing, time detail, or
  // repeat problem message escalates. Questions keep the conversation going.
  let problemId = null;
  let problemSuffix = null;
  const st = getProblemState(ctx.from.id);
  const alreadyEscalated = Boolean(st?.escalatedAt && Date.now() - st.escalatedAt < PROBLEM_WINDOW_MS);

  // "That fixed it" closes the report — never escalate a resolution.
  // (saysStillBroken wins on ambiguity like "still not fixed".)
  if (st && saysResolved(text) && !saysStillBroken(text)) {
    problemState.delete(ctx.from.id);
    db.prepare('UPDATE problem_reports SET resolved = 1 WHERE tg_user_id = ? AND resolved = 0 AND ts > ?')
      .run(ctx.from.id, now() - 2 * 3600);
    setLogSource(logId, 'resolved');
    if (alreadyEscalated) {
      // The admin was pinged earlier — close that loop too.
      hub.notifyAdmins(`✅ @${ctx.from?.username || ctx.from?.first_name} says their issue is now fixed: "${text.slice(0, 120)}"`).catch(() => {});
    }
    const note = getSetting('bot.problemResolvedNote');
    if (note) {
      await ctx.api.sendMessage(ctx.chat.id, note, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
    }
    return;
  }

  let isConfirmation = false;
  if (!alreadyEscalated) {
    if (st) {
      isConfirmation =
        isProblem ||
        saysStillBroken(text) ||
        negatesFixes(text) ||
        hasTimeDetail(text) ||
        (isFollowUp && !looksLikeQuestion(text));
    } else if (isProblem) {
      // No stored state (e.g. restart) but clearly a confirmation anyway.
      isConfirmation = isFollowUp || saysStillBroken(text);
    }
  }

  if (isConfirmation) {
    // Physics check: the fixes take minutes to actually try. A confirmation
    // that arrives too fast gets ONE friendly pushback instead of escalating —
    // unless the user brings details, negates a specific fix (checking your
    // password IS quick), or there's a known outage.
    const nudgeMinutes = Number(getSetting('bot.problemNudgeMinutes')) || 0;
    const sinceAnswer = st?.answeredAt ? Date.now() - st.answeredAt : null;
    const tooQuick = nudgeMinutes > 0 && sinceAnswer !== null && sinceAnswer < nudgeMinutes * 60000;
    if (
      tooQuick && !st.nudgedAt &&
      !negatesFixes(text) && !hasTimeDetail(text) &&
      getSetting('service.status') === 'operational'
    ) {
      setProblemState(ctx.from.id, { at: Date.now(), nudgedAt: Date.now() });
      setLogSource(logId, 'nudged');
      const nudge = getSetting('bot.problemNudgeMessage');
      if (nudge) {
        await ctx.api.sendMessage(ctx.chat.id, nudge, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
      }
      return;
    }

    // The user tried the fixes (or told us it's still broken) — NOW it goes
    // to the admins, and the user gets an ack instead of the same FAQ again.
    setProblemState(ctx.from.id, { at: Date.now(), escalatedAt: Date.now() });
    recordProblem(ctx, text, { answered: true });
    // Everything open from this user now belongs to the escalation — the
    // auto-close sweep must never touch reports the admin was pinged about.
    db.prepare('UPDATE problem_reports SET escalated = 1 WHERE tg_user_id = ? AND resolved = 0').run(ctx.from.id);
    // Give the admin the original report alongside the confirmation.
    const alertText = st?.firstText && st.firstText !== text ? `${st.firstText} — ${text}` : text;
    queueProblemAlert({
      tg_user: ctx.from?.username || ctx.from?.first_name,
      tg_user_id: ctx.from?.id,
      text: alertText,
      topic: extractProblemTopic(st?.firstText || '') || extractProblemTopic(text),
    });
    setLogSource(logId, 'escalated');
    const ack = getSetting('bot.problemFlaggedNote');
    if (ack) {
      await ctx.api.sendMessage(ctx.chat.id, ack, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
    }
    return;
  }

  if (isProblem && alreadyEscalated) {
    // Admins are already on it — stay quiet rather than nag or re-alert.
    setProblemState(ctx.from.id, { at: Date.now() });
    return;
  }

  let problemPrefix = null;
  if (isProblem && !st) {
    // First report: save it for the panel (no admin DM), answer with the
    // fixes, and invite the user to confirm if it persists.
    setProblemState(ctx.from.id, { at: Date.now(), escalatedAt: null, firstText: text.slice(0, 200) });
    problemId = recordProblem(ctx, text, { answered: false });
    problemSuffix = getSetting('bot.problemFollowupNote') || null;
    problemPrefix = serviceStatusLine();
    checkOutage();
  }

  if (!shouldAnswer) return;

  if (onCooldown(ctx.from.id)) return;
  bumpCooldown(ctx.from.id);

  // Replying to one of the bot's messages is a follow-up conversation: give
  // the AI the reply chain as context and don't just re-match the same FAQ.
  let history = null;
  if (isFollowUp) {
    const prev = replyContext.get(`${ctx.chat.id}:${repliedTo.message_id}`);
    history = [
      ...(prev?.question ? [{ role: 'user', content: String(prev.question).slice(0, 1000) }] : []),
      { role: 'assistant', content: String(repliedTo.text).slice(0, 1500) },
    ];
  }

  const outcome = await answer(ctx, question, { isDm: false, logId, history, skipFaq: isFollowUp, suffix: problemSuffix, prefix: problemPrefix });

  // Only mark the report answered when a real answer actually went out —
  // and remember WHEN, so too-quick confirmations can be nudged.
  if (problemId) {
    const gotAnswer = ['faq', 'ai'].includes(outcome);
    db.prepare('UPDATE problem_reports SET answered = ? WHERE id = ?').run(gotAnswer ? 1 : 0, problemId);
    if (gotAnswer) setProblemState(ctx.from.id, { answeredAt: Date.now() });
  }
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
