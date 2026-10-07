import { InlineKeyboard } from 'grammy';
import { db, now } from '../db/db.js';
import { getSetting, redactServiceUrls } from '../settings.js';
import { matchFaq } from '../faq/matcher.js';
import { askAi, aiBudgetExceeded, rephraseCanned } from '../ai/client.js';
import { containsBannedWord, endsWithQuestion } from '../ai/guardrails.js';
import { state } from '../state.js';
import {
  sendChunked, logMessage, setLogSource, recordUnanswered, chatAllowed,
  isLikelyInScope, hasScopeSignal, recordProblem, extractProblemTopic, isAdminUser,
  isContentIssue, looksLikeLiveIssue, wrongCopyIssue, withAdminContact,
} from './helpers.js';
import { alertAdmins } from './reports.js';
import { embed, retrieveFaqs } from '../ai/embeddings.js';
import { lookupAnswer, rememberAnswer, cacheable } from '../ai/answer-cache.js';
import { queueProblemAlert, setProblemRearmHook, maybeAutoDegrade } from './problems.js';
import { parseVodRequest, parseNaturalVodRequest, recordVodRequest, setRequestService, lookupImdb, canonicalizeRequest } from './requests.js';
import { hub } from './hub.js';

// Both request shapes: the taught "Request: Title" and natural "can we get X".
const anyVodRequest = (t) => parseVodRequest(t) || parseNaturalVodRequest(t);

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

// ---- Per-user service URLs --------------------------------------------------
// A user must only ever receive the URL for THEIR service. The URLs live in
// settings — deliberately outside the AI knowledge, so the model cannot hand
// out the wrong one. Flow: ask WHICH SERVICE they're on, then send that
// service's URL and nothing else.
const URL_TTL_MS = 10 * 60 * 1000;
const pendingUrl = new Map(); // chatId:userId -> { at, attempts }

function serviceConfig() {
  return {
    one: { name: String(getSetting('services.name1') || '').trim(), url: String(getSetting('services.url1') || '').trim() },
    two: { name: String(getSetting('services.name2') || '').trim(), url: String(getSetting('services.url2') || '').trim() },
    prefix: String(getSetting('services.prefix2') || 'THM').trim(),
  };
}

function isUrlRequest(text) {
  return /\burls?\b|\bdns\b|\b(server|service|login|host)\s+address\b/i.test(text);
}

function urlReplyText(svc) {
  const label = svc.name ? `You're on ${svc.name} — your` : 'Your';
  return `🔗 ${label} service URL is:\n${svc.url}\nEnter it exactly as written, together with your usual username and password.`;
}

function urlAskText() {
  const s = serviceConfig();
  return s.one.name && s.two.name
    ? `Which service are you on — ${s.one.name} or ${s.two.name}? Reply with the name and I'll send you the right URL. (Not sure? Just say "don't know" and I'll work it out from your username)`
    : 'Which service are you on? Reply with the name and I\'ll send you the right URL. (Not sure? Just say "don\'t know" and I\'ll work it out from your username)';
}

// Classify a USERNAME into a service: THM-prefixed or name-like ("ashley",
// "john99") → service 2; random letters/numbers ("x9k2p7") → service 1.
function serviceForUsername(username) {
  const s = serviceConfig();
  const t = String(username).trim();
  if (s.prefix && t.length > s.prefix.length && t.toUpperCase().startsWith(s.prefix.toUpperCase())) return s.two;
  const core = t.replace(/[^a-zA-Z0-9]/g, '');
  const nameWithTrailingDigits = /^[a-zA-Z]{3,}\d*$/.test(core);
  const vowely = /[aeiou]/i.test(core.replace(/\d/g, '').slice(0, 6));
  if (nameWithTrailingDigits && vowely) return s.two; // "ashley", "john99"
  return s.one; // "x9k2p7", "kxtvbq" — random mix
}

const DONT_KNOW = /\b(dont know|don'?t know|do not know|not sure|no idea|dunno|idk|unsure|no clue)\b/i;

// Match the reply to a service: by name, by "1"/"2", or — since people paste
// them anyway — by a prefixed username (THM… → service 2).
function serviceFromReply(text) {
  const s = serviceConfig();
  const low = String(text).toLowerCase();
  const hit1 = Boolean(s.one.name) && low.includes(s.one.name.toLowerCase());
  const hit2 = Boolean(s.two.name) && low.includes(s.two.name.toLowerCase());
  if (hit1 && !hit2) return s.one;
  if (hit2 && !hit1) return s.two;
  if (/\b(one|1)\b/.test(low) && !/\b(two|2)\b/.test(low)) return s.one;
  if (/\b(two|2)\b/.test(low) && !/\b(one|1)\b/.test(low)) return s.two;
  const cand = plainWords(text).sort((a, b) => b.length - a.length)[0] || '';
  if (s.prefix && cand.length >= s.prefix.length + 2 && cand.toUpperCase().startsWith(s.prefix.toUpperCase())) return s.two;
  return null;
}

// Returns true when the message was handled as a URL request.
async function handleUrlRequest(ctx, logId, replyParams) {
  const s = serviceConfig();
  if (!s.one.url && !s.two.url) return false; // not configured — normal flow
  pendingUrl.set(`${ctx.chat.id}:${ctx.from.id}`, { at: Date.now(), attempts: 0, stage: 'service' });
  if (pendingUrl.size > 500) {
    pendingUrl.delete(pendingUrl.keys().next().value);
  }
  setLogSource(logId, 'service-url');
  await ctx.api.sendMessage(ctx.chat.id, urlAskText(), replyParams).catch(() => {});
  return true;
}

// The which-service answer to the ask above. Returns true when handled.
async function handleUrlServiceReply(ctx, text, logId, replyParams) {
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  const st = pendingUrl.get(key);
  if (!st) return false;
  if (Date.now() - st.at >= URL_TTL_MS) {
    pendingUrl.delete(key);
    return false;
  }
  if (looksLikeQuestion(text) || anyVodRequest(text) || looksLikeProblem(text) || looksLikeGreeting(text) || looksLikeThanks(text)) {
    // They moved on — a question ("which service am I on?"), a VOD request,
    // a problem report, a greeting. Normal answering takes it; the URL ask
    // is dropped, they can ask again.
    pendingUrl.delete(key);
    return false;
  }
  const send = (msg) => ctx.api.sendMessage(ctx.chat.id, msg, replyParams).catch(() => {});
  setLogSource(logId, 'service-url');

  // Stage 2: they told us their USERNAME — classify it. Random letters and
  // numbers → service 1; THM-prefixed or a name-style username → service 2.
  if (st.stage === 'username') {
    pendingUrl.delete(key);
    const cand = plainWords(text).sort((a, b) => b.length - a.length)[0] || '';
    const svc = serviceForUsername(cand);
    await send(svc.url ? urlReplyText(svc) : 'The admin will share that one with you here 👍');
    return true;
  }

  // Stage 1: which service? "Don't know" moves to the username question.
  if (DONT_KNOW.test(text)) {
    st.stage = 'username';
    st.at = Date.now();
    await send("No problem — what's the USERNAME you log in with? (just the username, never the password) I'll work out which service you're on.");
    return true;
  }
  const svc = serviceFromReply(text);
  if (svc && svc.url) {
    pendingUrl.delete(key);
    await send(urlReplyText(svc));
  } else if (svc) {
    pendingUrl.delete(key);
    await send('The admin will share that one with you here 👍');
  } else if (st.attempts < 1) {
    st.attempts++;
    await send(`Sorry, didn't catch that — ${urlAskText()} (Not sure? Just say "don't know")`);
  } else {
    pendingUrl.delete(key);
    await send('No worries — the admin will share the right URL with you here 👍');
  }
  return true;
}

// ---- VOD-request → which service? ------------------------------------------
// After capturing "Request: Title", ask which service it's for so the admin
// adds it to the right library. Only when two services are named. The answer
// is remembered per user for a short while so back-to-back requests don't
// re-ask.
const pendingVodService = new Map(); // chatId:userId -> { requestId, at, attempts }
const knownVodService = new Map();   // userId -> { name, at }

function twoServicesNamed() {
  const s = serviceConfig();
  return Boolean(s.one.name && s.two.name);
}

function vodServiceAskText() {
  const s = serviceConfig();
  const q = String(getSetting('bot.requestServiceQuestion') || '').trim();
  return `${q} ${s.one.name} or ${s.two.name}?`.trim();
}

function rememberVodService(userId, name) {
  knownVodService.set(userId, { name, at: Date.now() });
  if (knownVodService.size > 500) knownVodService.delete(knownVodService.keys().next().value);
}

function peekVodService(userId) {
  const k = knownVodService.get(userId);
  return k && Date.now() - k.at < URL_TTL_MS ? k.name : null;
}

// Which-service follow-up for a captured request: auto-tag from recent
// memory, or arm the ask. Returns the text to append to the ack ('' = none).
function maybeArmServiceAsk(ctx, requestId) {
  if (!twoServicesNamed() || !getSetting('bot.requestServiceQuestion')) return '';
  const known = peekVodService(ctx.from.id);
  if (known) {
    setRequestService(requestId, known);
    return `\n(noted for ${known} 👍)`;
  }
  pendingVodService.set(`${ctx.chat.id}:${ctx.from.id}`, { requestId, at: Date.now(), attempts: 0 });
  if (pendingVodService.size > 500) {
    pendingVodService.delete(pendingVodService.keys().next().value);
  }
  return `\n${vodServiceAskText()}`;
}

// IMDb "is this correct?" confirmations awaiting a yes/no/corrected-title.
const pendingVodConfirm = new Map(); // chatId:userId -> { requestId, original, canonical, at }

// Capture a VOD request and, when appropriate, ask which service it's for.
// Checks the title against IMDb first: an exact match is canonicalized
// silently ("the batman" → "The Batman (2022)"); a DIFFERING best guess asks
// the requester to confirm before the title is rewritten. IMDb being off,
// slow or clueless changes nothing — the request is always recorded.
async function captureVodRequest(ctx, title) {
  const hit = await lookupImdb(title);
  let useTitle = title;
  let confirm = null;
  if (hit) {
    const tNorm = title.toLowerCase().replace(/[^a-z0-9]/g, '');
    const noYear = hit.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    const withYear = hit.canonical.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (tNorm === noYear || tNorm === withYear) useTitle = hit.canonical;
    else confirm = hit.canonical;
  }
  const { ack, requestId, deduped } = recordVodRequest(ctx, useTitle);
  if (confirm && !deduped) {
    pendingVodConfirm.set(`${ctx.chat.id}:${ctx.from.id}`, { requestId, original: title, canonical: confirm, at: Date.now() });
    if (pendingVodConfirm.size > 500) {
      pendingVodConfirm.delete(pendingVodConfirm.keys().next().value);
    }
    return `${ack}\n🎬 Just to check — did you mean ${confirm}? (yes / no / the correct title)`;
  }
  if (deduped) return ack;
  return ack + maybeArmServiceAsk(ctx, requestId);
}

// The yes/no/corrected-title answer to the IMDb check. Returns true when
// handled.
async function handleVodConfirmReply(ctx, text, logId, replyParams) {
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  const st = pendingVodConfirm.get(key);
  if (!st) return false;
  if (Date.now() - st.at >= URL_TTL_MS) { pendingVodConfirm.delete(key); return false; }
  const send = (msg) => ctx.api.sendMessage(ctx.chat.id, msg, replyParams).catch(() => {});
  const w = plainWords(text);
  // "yes" family — but "thats wrong" / "right, it's actually X" must NOT
  // count, so multi-word forms are only accepted with an affirmative tail.
  const saysYes =
    (w.length > 0 && /^(yes|yeah|yep|yup|y|correct|aye|exactly|si)$/i.test(w[0]) && !w.includes('wrong') && !w.includes('not')) ||
    (w[0] === 'thats' && /^(it|right|correct|the)$/i.test(w[1] || '')) ||
    (w[0] === 'spot' && w[1] === 'on') ||
    (w[0] === 'right' && w.length === 1);
  if (saysYes) {
    pendingVodConfirm.delete(key);
    setLogSource(logId, 'vod-request');
    const survivingId = canonicalizeRequest(st.requestId, st.canonical);
    await send(`👍 Locked in as ${st.canonical}.${maybeArmServiceAsk(ctx, survivingId)}`);
    return true;
  }
  if (w.length && /^(no|nah|nope|wrong)$/i.test(w[0]) && w.length <= 4) {
    pendingVodConfirm.delete(key);
    setLogSource(logId, 'vod-request');
    await send(`No worries — kept it as "${st.original}".${maybeArmServiceAsk(ctx, st.requestId)}`);
    return true;
  }
  // Anything that stands on its own means they've moved on — the request
  // stays recorded exactly as they typed it.
  if (looksLikeQuestion(text) || anyVodRequest(text) || looksLikeProblem(text) || looksLikeGreeting(text) || looksLikeThanks(text)) {
    pendingVodConfirm.delete(key);
    return false;
  }
  // A bare title reply IS the correction ("no its the batman" was caught
  // above; "batman begins (2005)" lands here).
  pendingVodConfirm.delete(key);
  setLogSource(logId, 'vod-request');
  const corrected = text.trim().replace(/\s+/g, ' ').slice(0, 200);
  const survivingId = canonicalizeRequest(st.requestId, corrected);
  await send(`👍 Noted as "${corrected}".${maybeArmServiceAsk(ctx, survivingId)}`);
  return true;
}

// The which-service answer to the VOD ask. Returns true when handled.
async function handleVodServiceReply(ctx, text, logId, replyParams) {
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  const st = pendingVodService.get(key);
  if (!st) return false;
  if (Date.now() - st.at >= URL_TTL_MS) { pendingVodService.delete(key); return false; }
  // Anything that stands on its own means they've moved on — drop the ask
  // and let the normal flow take the message. A NEW "Request: ..." must be
  // captured (it re-arms its own ask), a problem report belongs to triage,
  // greetings/thanks to their canned replies.
  if (looksLikeQuestion(text) || anyVodRequest(text) || looksLikeProblem(text) || looksLikeGreeting(text) || looksLikeThanks(text)) {
    pendingVodService.delete(key);
    return false;
  }
  const svc = serviceFromReply(text);
  const send = (msg) => ctx.api.sendMessage(ctx.chat.id, msg, replyParams).catch(() => {});
  setLogSource(logId, 'vod-request');
  if (svc) {
    pendingVodService.delete(key);
    setRequestService(st.requestId, svc.name);
    rememberVodService(ctx.from.id, svc.name);
    await send(`👍 Got it — noted for ${svc.name}.`);
  } else if (st.attempts < 1) {
    st.attempts++;
    await send(`Which one — ${vodServiceAskText()}`);
  } else {
    pendingVodService.delete(key);
    await send('No worries — the team will sort it 👍');
  }
  return true;
}

// Greetings and pleasantries get warmth, never the off-topic brush-off.
// Deterministic on purpose: a whole message made of greeting words is a
// greeting; mixed messages ("hey, my app won't open") flow on as normal.
const GREETING_WORDS = new Set([
  'hey', 'hi', 'hiya', 'hello', 'yo', 'howdy', 'hola', 'alright', 'alrite', 'ayup',
  'sup', 'wassup', 'whats', 'up', 'good', 'morning', 'afternoon', 'evening', 'day',
  'there', 'mate', 'guys', 'lads', 'all', 'everyone', 'bot', 'm8', 'bud', 'buddy', 'pal', 'again',
]);
const THANKS_CORE = new Set(['thanks', 'thank', 'cheers', 'ta', 'ty', 'tysm', 'appreciated', 'appreciate', 'legend', 'lifesaver']);
const THANKS_EXTRA = new Set([
  'you', 'so', 'much', 'a', 'lot', 'nice', 'one', 'great', 'perfect', 'brilliant', 'amazing',
  'awesome', 'good', 'top', 'bot', 'mate', 'm8', 'man', 'bro', 'bud', 'pal', 'lovely', 'sound',
  'boss', 'work', 'stuff', 'x', 'xx', 'that', 'it', 'very',
]);

function plainWords(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function looksLikeGreeting(text) {
  const w = plainWords(text);
  return w.length > 0 && w.length <= 5 && w.every((x) => GREETING_WORDS.has(x));
}

function looksLikeThanks(text) {
  const w = plainWords(text);
  if (!w.length || w.length > 6) return false;
  const joined = w.join(' ');
  if (/^(nice one|good bot|top (man|work|bot)|good stuff|lovely stuff)( mate| m8)?$/.test(joined)) return true;
  return w.some((x) => THANKS_CORE.has(x)) && w.every((x) => THANKS_CORE.has(x) || THANKS_EXTRA.has(x));
}

function looksLikeQuestion(text) {
  if (text.includes('?')) return true;
  // "whats" (no apostrophe) must count too — \b never fires inside it, so
  // the contracted forms need listing explicitly.
  const starters = /^(how|hows|what|whats|why|when|whens|where|wheres|which|who|whos|can|does|do|is|are|will|help|anyone|any1|pls|please)\b/i;
  return starters.test(text.trim());
}

// Support groups mostly post problem STATEMENTS ("buffering on bbc1",
// "purple not working") — treat those as requests for help too.
// Two tiers so general chat can't trigger it: unambiguous problem phrases
// count on their own; generic words ("calm DOWN mate", "the PROBLEM with
// him is...") only count when the message also mentions the service.
const STRONG_PROBLEM =
  /\b(buffer(ing|s)?|freez\w*|frozen|lag(gy|ging|s)?|stutter\w*|glitch\w*|crash\w*|playback|black ?screen|no (sound|audio|picture|video|streams?|channels?|epg|vod)|invalid|unauthori[sz]ed|logged (out|off)|wrong password|access denied|wrong (language|audio|sound|version|copy|cut|file)|(us|american|censored|dubbed) (version|copy|cut)|only (one|1) (language|audio( track)?|track)|not work\w*|(doesnt|dont|isnt|aint|stopped) work\w*|wont (work|load|play|open|start)|cant (log ?in|sign in|watch|open|play|stream|connect)|keeps? (stopping|buffering|freezing|crashing|cutting|loading)|(is|are|was|were|gone|went|still) down|offline)\b/i;
const WEAK_PROBLEM = /\b(down|error|issues?|problems?|stuck|loading|broken)\b/i;

function looksLikeProblem(text) {
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
  // Admins are never rate-limited — rapid-fire testing must always answer.
  if (isAdminUser(userId)) return false;
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
// The live triage conversation. Backed by SQLite rather than a Map: the case
// row always survived a restart but this did not, so after every deploy a
// customer's "still not working" read as a brand new problem — the same fixes
// again, round count back to zero, no escalation.
//
// The window is how long a reply still counts as being about the open case.
// Thirty seconds of "try these fixes" takes minutes to actually carry out (a
// router restart alone is two), so a short window closed the thread while the
// customer was still off doing what the bot asked.
const problemWindowMs = () =>
  Math.max(1, Number(getSetting('bot.problemWindowMinutes')) || 720) * 60 * 1000;

const STATE_COLUMNS = {
  caseId: 'case_id',
  at: 'at',
  escalatedAt: 'escalated_at',
  answeredAt: 'answered_at',
  nudgedAt: 'nudged_at',
  awaitingService: 'awaiting_service',
  fromAutoClose: 'from_auto_close',
  fixRounds: 'fix_rounds',
  firstText: 'first_text',
  topic: 'topic',
};

const rowToState = (r) => r && {
  caseId: r.case_id,
  at: r.at,
  escalatedAt: r.escalated_at,
  answeredAt: r.answered_at,
  nudgedAt: r.nudged_at,
  awaitingService: Boolean(r.awaiting_service),
  fromAutoClose: Boolean(r.from_auto_close),
  fixRounds: r.fix_rounds,
  firstText: r.first_text,
  topic: r.topic,
};

function getProblemState(userId) {
  const row = db.prepare('SELECT * FROM problem_state WHERE tg_user_id = ?').get(userId);
  if (!row) return null;
  if (Date.now() - row.at > problemWindowMs()) {
    db.prepare('DELETE FROM problem_state WHERE tg_user_id = ?').run(userId);
    return null;
  }
  return rowToState(row);
}

function setProblemState(userId, patch) {
  const current = db.prepare('SELECT * FROM problem_state WHERE tg_user_id = ?').get(userId);
  const merged = { ...(rowToState(current) || {}), ...patch };
  const toDb = (k) => {
    const v = merged[k];
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v ?? null;
  };
  db.prepare(`
    INSERT INTO problem_state (tg_user_id, case_id, at, escalated_at, answered_at, nudged_at, awaiting_service, from_auto_close, fix_rounds, first_text, topic)
    VALUES (@tg_user_id, @case_id, @at, @escalated_at, @answered_at, @nudged_at, @awaiting_service, @from_auto_close, @fix_rounds, @first_text, @topic)
    ON CONFLICT(tg_user_id) DO UPDATE SET
      case_id = excluded.case_id, at = excluded.at, escalated_at = excluded.escalated_at,
      answered_at = excluded.answered_at, nudged_at = excluded.nudged_at,
      awaiting_service = excluded.awaiting_service, from_auto_close = excluded.from_auto_close,
      fix_rounds = excluded.fix_rounds, first_text = excluded.first_text, topic = excluded.topic
  `).run({
    tg_user_id: userId,
    case_id: toDb('caseId'),
    at: merged.at ?? Date.now(),
    escalated_at: toDb('escalatedAt'),
    answered_at: toDb('answeredAt'),
    nudged_at: toDb('nudgedAt'),
    awaiting_service: merged.awaitingService ? 1 : 0,
    from_auto_close: merged.fromAutoClose ? 1 : 0,
    fix_rounds: Number(merged.fixRounds) || 0,
    first_text: merged.firstText ?? null,
    topic: merged.topic ?? null,
  });
}

function clearProblemState(userId) {
  db.prepare('DELETE FROM problem_state WHERE tg_user_id = ?').run(userId);
}

// Closing by case id rather than "any open report from the last two hours":
// a customer who comes back the next morning to say it is fixed used to close
// nothing at all, leaving the report open on the panel for good.
function resolveOpenCase(userId, by, caseId = null) {
  if (caseId) {
    const r = db.prepare("UPDATE problem_reports SET resolved = 1, resolved_by = ? WHERE id = ? AND resolved = 0").run(by, caseId);
    if (r.changes) return r.changes;
  }
  return db.prepare("UPDATE problem_reports SET resolved = 1, resolved_by = ? WHERE tg_user_id = ? AND resolved = 0 AND ts > ?")
    .run(by, userId, now() - Math.ceil(problemWindowMs() / 1000)).changes;
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
  // "tried it/that/everything" counts — "HAVEN'T tried it" is the opposite
  // (live bug: "Haven't tried it today" escalated as a fix-negation).
  return /\b((is|are|was|were|looks?) (fine|right|correct|ok|okay)|already (tried|did|done|checked)|(?<!\b(?:havent|haven'?t|hadnt|hadn'?t|not|never)\s)(tried|checked|done|did) (it|that|them|those|all|everything)|nothing (works|worked|changed|happens)|(didnt|didn't|doesnt|doesn't) (help|work|change))\b/i.test(text);
}

// "that fixed it", "working now", "all good" — the problem is over.
function saysResolved(text) {
  return /\b(fixed|sorted|solved|resolved|working now|works now|all good|that (worked|did it)|back to normal|(fine|good|ok|okay|sorted|perfect) now|no more (buffering|freezing|lagging|issues?|problems?))\b/i.test(text);
}

// The invite appended to a round of fixes must match what a reply actually
// does: earlier rounds bring MORE steps, only the last round flags. Round
// numbers are 1-based ("this answer was round N").
function followupNoteForRound(round) {
  const maxRounds = Math.max(1, Math.min(4, Number(getSetting('bot.problemFixRounds')) || 1));
  if (round < maxRounds) {
    const more = String(getSetting('bot.problemMoreFixesNote') || '').trim();
    if (more) return more;
  }
  return getSetting('bot.problemFollowupNote') || null;
}

// Is this bot message the auto-close notice? Matched by TEXT, not by tracked
// message id — triage state is in-memory, and the whole point of the check is
// surviving restarts and long gaps. The template is admin-configurable, so
// compare against its literal chunks (placeholders stripped).
function looksLikeAutoCloseMsg(text) {
  const template = String(getSetting('bot.problemAutoCloseMessage') || '').trim();
  if (!template || !text) return false;
  const chunks = template.split(/\{name\}|\{topic\}/g).map((s) => s.trim()).filter((s) => s.length >= 12);
  return chunks.some((c) => text.includes(c));
}

// Test helper: clear triage memory between scenarios.
export function _resetProblemTriage() {
  db.prepare('DELETE FROM problem_state').run();
  lastOutageAlertAt = 0;
}

// When auto-close messages a user ("assuming it's sorted — reply if not"),
// re-arm their triage state so a late "still broken" escalates directly.
// fromAutoClose flips the default for their reply: neutral updates close
// softly, only clear still-broken phrasing escalates.
setProblemRearmHook((userId) => {
  setProblemState(userId, { at: Date.now(), escalatedAt: null, answeredAt: null, nudgedAt: Date.now(), fromAutoClose: true });
});

let lastOutageAlertAt = 0;
function checkOutage() {
  // Widespread symptoms flip the service status automatically (with its own
  // admin alert); the plain outage ping below stays as the fallback for
  // content-issue storms or when auto-degradation is switched off.
  if (maybeAutoDegrade()) {
    lastOutageAlertAt = Date.now();
    return;
  }
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

// Canned replies pass through the AI reworder so the bot doesn't repeat
// itself word-for-word; the saved setting text is the meaning contract and
// the fallback (AI off/busy/slow/wrong → saved text goes out unchanged).
async function spoken(key) {
  const msg = withAdminContact(String(getSetting(key) || '').trim());
  return msg ? rephraseCanned(msg) : '';
}

// Off-topic banter free pass: per user, the FIRST off-topic question in a
// while gets one short friendly AI answer (small-talk mode — no questions
// back); anything more inside the window falls through to the brush-off.
const smallTalkUsed = new Map(); // userId -> timestamp the pass was spent

async function maybeSmallTalk(ctx, question) {
  const minutes = Number(getSetting('bot.offtopicChatMinutes')) || 0;
  if (!minutes) return null;
  const userId = ctx.from?.id;
  if (!userId) return null;
  const last = smallTalkUsed.get(userId) || 0;
  if (Date.now() - last < minutes * 60 * 1000) return null;
  // Spend the pass BEFORE calling: even a failed/suppressed attempt counts,
  // so repeated off-topic messages can't farm AI calls.
  smallTalkUsed.set(userId, Date.now());
  if (smallTalkUsed.size > 2000) smallTalkUsed.clear();
  try {
    return await askAi(question, { smallTalk: true });
  } catch {
    return null; // AI busy/down/over budget → the brush-off answers instead
  }
}

export function _resetSmallTalk() {
  smallTalkUsed.clear();
}

// Photos, screen recordings and voice notes: the bot can't see or hear them.
// Ask the sender to TYPE it instead — but only when the media is aimed at
// the bot (always in a DM; in a group only when it replies to the bot).
// Stickers and GIFs are reactions, not content — never nagged.
const MEDIA_NAG_MS = 60 * 1000; // albums arrive as N separate messages — one nag covers the burst
const mediaNagged = new Map(); // userId -> ts of last nag

function unreadableMedia(msg) {
  if (!msg || msg.sticker || msg.animation) return false;
  return Boolean(
    msg.photo || msg.video || msg.voice || msg.video_note || msg.audio ||
    /^image\//.test(msg.document?.mime_type || '')
  );
}

async function sendMediaNag(ctx) {
  const msgText = String(getSetting('bot.photoMessage') || '').trim();
  const userId = ctx.from?.id;
  if (!msgText || !userId) return;
  if (Date.now() - (mediaNagged.get(userId) || 0) < MEDIA_NAG_MS) return;
  mediaNagged.set(userId, Date.now());
  if (mediaNagged.size > 2000) mediaNagged.clear();
  await ctx.api.sendMessage(ctx.chat.id, await rephraseCanned(msgText), { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
}

// "Which service is the best?" — never let the model freestyle a comparison
// of the admin's own products (live bug: it invented a Purple-vs-Smarters
// listicle). With two services configured, a canned admin-editable plug for
// service 1 answers instead. Patterns stay tight so "best way to pay for the
// service" still goes to the FAQ/AI.
function isBestServiceQuestion(text) {
  const t = String(text).toLowerCase();
  if (/\bwhich\s+(service|one)\b[^.?!\n]*\b(best|better)\b/.test(t)) return true;
  if (/\b(best|better)\s+services?\b/.test(t)) return true;
  if (/\bservices?\s+(is|are)\s+(the\s+)?(best|better)\b/.test(t)) return true;
  const s = serviceConfig();
  return Boolean(
    s.one.name && s.two.name && /\b(best|better|recommend)\b/.test(t) &&
    t.includes(s.one.name.toLowerCase()) && t.includes(s.two.name.toLowerCase())
  );
}

function bestServiceReply() {
  if (!twoServicesNamed()) return null;
  const s = serviceConfig();
  const template = String(getSetting('bot.bestServiceMessage') || '').trim();
  return template.replace(/\{name1\}/g, s.one.name).replace(/\{name2\}/g, s.two.name) || null;
}

// Core answering flow: FAQ first, then AI with strict-topic guardrails.
// `history` carries conversation context (DM memory, or a group reply chain);
// `skipFaq` is set for follow-up replies so the bot doesn't repeat the same
// FAQ instead of continuing the conversation. `suffix` is appended to any
// actual answer (e.g. "flagged to the team" after a problem report).
// Exported so tests can drive it with a fake ctx.
export async function answer(ctx, question, { isDm, logId, history: providedHistory = null, skipFaq = false, suffix = null, prefix = null, assumeOnTopic: forceOnTopic = false, directed = false, deepen = false }) {
  const faqs = db.prepare('SELECT * FROM faqs WHERE enabled = 1').all();
  const threshold = Number(getSetting('faq.threshold')) || 0.5;
  const result = skipFaq ? { match: null, nearMiss: null } : matchFaq(question, faqs, threshold);
  const replyParams = isDm ? {} : { reply_parameters: { message_id: ctx.message.message_id } };
  const withSuffix = (text) => [prefix, text, suffix].filter(Boolean).join('\n\n');

  // Full-AI mode: the model writes every reply, and the FAQ becomes knowledge
  // handed to it rather than a canned answer that pre-empts it. Keyword
  // matching only ever decided WHICH canned answer to fire, and two of an
  // FAQ's keywords landing in an unrelated sentence was enough to fire it —
  // so the FAQ regularly answered a question nobody asked. It stays as the
  // fallback for when the AI is off, over budget, refuses, or the embedding
  // model is unavailable: a worse answer beats no answer.
  //
  // The gate is a REAL vector, not the setting. "Embeddings are switched on"
  // and "embeddings work" are different things — the model may not be pulled,
  // or the endpoint may be down — and turning off the canned FAQ on the
  // strength of a setting alone would leave the bot with neither path.
  // One embedding per message; the cache lookup and FAQ retrieval share it.
  const aiReady = Boolean(getSetting('ai.enabled')) && !aiBudgetExceeded();
  const qVec = aiReady ? await embed(question) : null;
  const fullAi = aiReady && qVec !== null;

  // Before the FAQ matcher: "which service is best" would otherwise fuzzy-hit
  // the which-service FAQ (username classification) or reach the AI.
  if (isBestServiceQuestion(question)) {
    const plug = bestServiceReply();
    if (plug) {
      setLogSource(logId, 'canned');
      await ctx.api.sendMessage(ctx.chat.id, withSuffix(plug), replyParams);
      return 'canned';
    }
  }

  if (result.match && !fullAi) {
    db.prepare('UPDATE faqs SET hit_count = hit_count + 1 WHERE id = ?').run(result.match.id);
    // A service URL the admin pasted into the FAQ must not go to everyone —
    // the per-user URL flow is the only outlet for those.
    const faqAnswer = withAdminContact(redactServiceUrls(result.match.answer));
    setLogSource(logId, 'faq', faqAnswer);
    // FAQ answers join the DM conversation memory too, so a bare follow-up
    // ("THM4821" after the which-service FAQ) reaches the AI with context.
    if (isDm) {
      const historyKey = `${ctx.chat.id}:${ctx.from.id}`;
      dmHistory.set(historyKey, [
        ...(dmHistory.get(historyKey) || []),
        { role: 'user', content: question },
        { role: 'assistant', content: String(faqAnswer).slice(0, 1500) },
      ].slice(-6));
    }
    const sent = await sendChunked(ctx.api, ctx.chat.id, withSuffix(faqAnswer), {
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
        const historyKey = `${ctx.chat.id}:${ctx.from.id}`;
        const history = providedHistory ?? (isDm ? (dmHistory.get(historyKey) || []) : []);
        // A problem report, an FAQ near-miss, or plain app/device vocabulary
        // means we already KNOW this is on-topic — stop the model bailing to
        // OFFTOPIC on legit questions (e.g. "how do I enable developer options").
        const assumeOnTopic = forceOnTopic || looksLikeProblem(question) || Boolean(result.nearMiss) || isLikelyInScope(question);
        // The AI only sees messages with SOMETHING to anchor them: a scope
        // signal (one fuzzy vocabulary hit is enough), a problem/near-miss,
        // or an ongoing conversation. Anything else — "Sausage", "do you
        // like pineapples" — is off-script bait that small models chat along
        // with instead of refusing. Straight to off-topic handling, no AI
        // call spent.
        // Questions about the BOT's tastes ("which is your favourite mad max
        // film", "do you like…") are chat, not support — even though words
        // like film/movie are real VOD vocabulary. Route them down the
        // off-topic path in code; the model can't be trusted to refuse them.
        const opinionBait = /\b(?:your|ur) fav(?:ourite|orite)\b|\bdo (?:you|u) (?:like|love|prefer)\b/i.test(question)
          && !looksLikeProblem(question) && !result.nearMiss;
        const offScript = opinionBait || (!assumeOnTopic && !history.length && !hasScopeSignal(question));
        let reply = null;
        let cacheVec = null;
        let servedFromCache = false;
        if (!offScript) {
          await ctx.replyWithChatAction?.('typing')?.catch?.(() => {});
          // Live vs VOD hint for problem reports: pause/rewind advice is
          // nonsense for a live channel, and valid for a film/episode.
          const playback = looksLikeProblem(question)
            ? (wrongCopyIssue(question) ? 'content'
              : isContentIssue(question) ? 'vod'
              : looksLikeLiveIssue(question) ? 'live' : null)
            : null;
          // A problem with a near-miss FAQ answers from the ADMIN'S playbook,
          // not from the model's generic streaming instincts (live bug:
          // "buffering on bbc 1" got 5GHz-WiFi advice and skipped the FAQ's
          // "try a different link for the channel").
          const grounding = looksLikeProblem(question) && result.nearMiss
            ? String(result.nearMiss.answer).slice(0, 1200)
            : null;

          // One embedding per message, shared by the cache lookup and FAQ
          // retrieval below.
          const canCache = fullAi && cacheable({ history, grounding, playback, secondRound: deepen });
          cacheVec = qVec;

          // Someone has asked this before, in whatever words. Reuse the answer
          // rather than spending minutes re-deriving it — the whole reason
          // AI-for-everything is affordable on a slow node.
          const cached = canCache ? await lookupAnswer(question, cacheVec) : null;
          if (cached) {
            reply = cached.answer;
            servedFromCache = true;
          } else {
            // Semantic retrieval picks the FAQs actually about this question;
            // [] means embeddings are unavailable, and askAi falls back to its
            // own keyword selection.
            const retrieved = await retrieveFaqs(question, faqs, {
              k: Number(getSetting('ai.retrieveCount')) || 6,
              qVec: cacheVec,
            });
            reply = await askAi(question, {
              history, assumeOnTopic, playback, grounding, secondRound: deepen,
              // The banner above already said "we know". Walking someone
              // through restarting their box cannot fix a fault on our side,
              // and asking them to is a waste of their evening.
              knownOutage: Boolean(prefix) && getSetting('service.status') !== 'operational' && looksLikeProblem(question),
              knowledgeFaqs: retrieved.length ? retrieved.map((r) => r.faq) : null,
            });
            if (reply && canCache) {
              await rememberAnswer(question, reply, { source: 'ai', vector: cacheVec });
            }
          }
        }

        if (reply) {
          setLogSource(logId, servedFromCache ? 'cache' : 'ai', reply);
          if (isDm) {
            dmHistory.set(historyKey, [...history, { role: 'user', content: question }, { role: 'assistant', content: reply }].slice(-6));
            if (dmHistory.size > 1000) dmHistory.clear();
          }
          // A reply ending in "?" is the model's one allowed clarifying
          // question — remember it so the user's next bare answer combines.
          if (!isDm && endsWithQuestion(reply)) {
            setPendingClarify(ctx.chat.id, ctx.from.id, question);
          }
          const sent = await sendChunked(ctx.api, ctx.chat.id, withSuffix(reply), {
            ...replyParams,
            reply_markup: feedbackKeyboard(),
          });
          if (sent) {
            rememberReply(ctx.chat.id, sent.message_id, {
              question, faqId: null, source: servedFromCache ? 'cache' : 'ai', answer: reply,
            });
          }
          return servedFromCache ? 'cache' : 'ai';
        }

        // The model refused, but we have a near-miss FAQ — answer with that
        // instead of saying nothing.
        if (result.nearMiss) {
          db.prepare('UPDATE faqs SET hit_count = hit_count + 1 WHERE id = ?').run(result.nearMiss.id);
          setLogSource(logId, 'faq', withAdminContact(redactServiceUrls(result.nearMiss.answer)));
          recordUnanswered(question, ctx, 'ai-refused', result.nearMiss.id);
          const sent = await sendChunked(ctx.api, ctx.chat.id, withSuffix(withAdminContact(redactServiceUrls(result.nearMiss.answer))), {
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
        if (!opinionBait && (assumeOnTopic || isLikelyInScope(question))) {
          setLogSource(logId, 'unsure');
          recordUnanswered(question, ctx, 'ai-refused', null);
          if (isDm || getSetting('bot.offtopicBehavior') === 'redirect') {
            const msg = await spoken('bot.unsureMessage');
            if (msg) await ctx.api.sendMessage(ctx.chat.id, msg, replyParams);
          }
          return 'unsure';
        }

        // Truly unrelated to the service — strict-topic rule kicked in.
        // NOT recorded in the Unanswered inbox: that inbox exists to surface
        // FAQ-worthy questions, and banter would clutter it (and pollute the
        // weekly FAQ-suggestion clustering). Genuine scope gaps still land
        // there via the 'ai-refused' and 'nomatch' paths above/below.
        // Off-topic replies (banter AND brush-off) only when the bot is being
        // spoken to: always in a DM; in a group only on a mention or a reply
        // to the bot. "Anyone coming to the pub later?" is aimed at the
        // GROUP — the bot butting in with banter would be worse than silence.
        if (getSetting('bot.offtopicBehavior') === 'redirect' && (isDm || directed)) {
          // Banter budget: the FIRST off-topic question in a while gets one
          // short friendly answer; the next inside the window gets the witty
          // brush-off with no AI call. Fun once, chat buddy never.
          const banter = await maybeSmallTalk(ctx, question);
          if (banter) {
            setLogSource(logId, 'smalltalk');
            // Always steer back to support after banter — an admin-editable
            // line appended in code, never left to the model.
            const steer = await spoken('bot.smallTalkSteer');
            await ctx.api.sendMessage(ctx.chat.id, steer ? `${banter}\n\n${steer}` : banter, replyParams);
            return 'smalltalk';
          }
          setLogSource(logId, 'offtopic');
          const msg = await spoken('bot.offtopicMessage');
          if (msg) await ctx.api.sendMessage(ctx.chat.id, msg, replyParams);
          return 'offtopic';
        }
        setLogSource(logId, 'offtopic');
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
    await ctx.api.sendMessage(ctx.chat.id, withAdminContact("I couldn't answer that one — {admin} and they'll help you personally."));
  }
  return 'none';
}

export async function handleGroupMessage(ctx) {
  // Captioned media counts as text (the caption flows through every normal
  // gate below — mention/question/problem shape, reply-to-other-member rule).
  const text = ctx.message?.text ?? ctx.message?.caption;
  if (!text) {
    // A captionless photo/video REPLYING TO THE BOT is someone showing it a
    // screenshot — ask them to type it out. Anything else (member-to-member
    // photos, memes, stickers) is none of the bot's business: stay silent.
    if (
      unreadableMedia(ctx.message) &&
      ctx.message?.reply_to_message?.from?.id === ctx.me?.id &&
      chatAllowed(ctx.chat.id) &&
      getSetting('bot.enabled')
    ) {
      await sendMediaNag(ctx);
    }
    return;
  }
  state.bot.groupMessagesSeen++;
  state.bot.lastUpdateAt = Date.now();

  if (!chatAllowed(ctx.chat.id)) return;
  const logId = logMessage(ctx.chat.id, ctx.from, text, null, ctx.message, ctx.chat.title || null);
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

  // Per-user service URL flow (before FAQ/AI — the iOS FAQ also carries the
  // 'url' keyword and must not swallow these). Asking requires question form
  // or clear intent so group banter containing "url" doesn't trigger it.
  const groupReplyParams = { reply_parameters: { message_id: ctx.message.message_id } };
  if (await handleUrlServiceReply(ctx, text, logId, groupReplyParams)) return;
  if (await handleVodConfirmReply(ctx, text, logId, groupReplyParams)) return;
  if (await handleVodServiceReply(ctx, text, logId, groupReplyParams)) return;
  if (
    isUrlRequest(question) &&
    (mentioned || looksLikeQuestion(text) || /\b(need|want|give|send)\b/i.test(text)) &&
    await handleUrlRequest(ctx, logId, groupReplyParams)
  ) return;

  // "Request: Title (Year)" — the VOD request format the FAQ teaches.
  // Capture it: save for the panel, ack the requester (asking which service
  // it's for when two are configured), DM the admins.
  {
    const vodTitle = anyVodRequest(text);
    if (vodTitle) {
      setLogSource(logId, 'vod-request');
      await ctx.api.sendMessage(ctx.chat.id, await captureVodRequest(ctx, vodTitle), groupReplyParams).catch(() => {});
      return;
    }
  }

  // Greeting or thanks aimed AT the bot (mention or reply) gets the warm
  // reply — but never while problem triage is mid-flight for this user:
  // "cheers" after fixes belongs to the resolution logic below.
  if (mentioned && !getProblemState(ctx.from.id)) {
    if (looksLikeGreeting(question)) {
      setLogSource(logId, 'greeting');
      const msg = await spoken('bot.greetingMessage');
      if (msg) await ctx.api.sendMessage(ctx.chat.id, msg, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
      return;
    }
    if (looksLikeThanks(question)) {
      setLogSource(logId, 'thanks');
      const msg = await spoken('bot.thanksMessage');
      if (msg) await ctx.api.sendMessage(ctx.chat.id, msg, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
      return;
    }
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
      // The bot asked the clarifying question — this exchange is directed.
      await answer(ctx, `${pending.question} — ${question}`, { isDm: false, logId, directed: true });
      return;
    }
  }

  const repliedTo = ctx.message.reply_to_message;
  const isFollowUp = repliedTo?.from?.id === ctx.me?.id && Boolean(repliedTo.text);
  // A reply to ANOTHER member ("Can you repeat this please" quoting someone
  // else) is addressed to that member, not the bot — the bot must not butt in
  // with a brush-off. It only chimes in on such a reply for a genuine support
  // hit (a real problem or a confident FAQ match), never on question-shape
  // alone.
  const repliesToOtherUser = Boolean(repliedTo) && !isFollowUp;

  let shouldAnswer = mode === 'all' || mentioned;
  if (!shouldAnswer && mode === 'questions') {
    shouldAnswer = repliesToOtherUser
      ? (isProblem || standaloneFaqMatch())
      : (looksLikeQuestion(text) || isProblem || standaloneFaqMatch());
  }

  // Problem triage: fixes first, admin escalation only on confirmation.
  // A confirmation rarely repeats the problem words — real users type "still
  // happening", "BBC 1 22:54" or just reply to the bot — so with an active
  // report, any non-question reply, still-broken phrasing, time detail, or
  // repeat problem message escalates. Questions keep the conversation going.
  let problemId = null;
  let problemSuffix = null;
  let st = getProblemState(ctx.from.id);
  // A reply to the AUTO-CLOSE message re-enters triage no matter how much
  // later it arrives: the message promised "reply here and I'll flag it
  // straight to the team". Triage state now survives restarts, but it is
  // still bounded by the window and auto-close deliberately ends the thread,
  // so a reply arriving days later needs rebuilding from the replied-to text.
  if (!st && isFollowUp && looksLikeAutoCloseMsg(repliedTo.text)) {
    setProblemState(ctx.from.id, { at: Date.now(), escalatedAt: null, answeredAt: null, nudgedAt: Date.now(), fromAutoClose: true });
    st = getProblemState(ctx.from.id);
  }
  // A problem-shaped message about something ELSE is a NEW problem, not more
  // detail on the open one. Without this, "my login stopped working" lands on
  // the buffering case: it counts as a still-broken confirmation, escalates
  // the wrong report, and the login issue is never recorded at all. Dropping
  // the state here lets it fall through to the first-report path, which opens
  // its own case; the previous one stays open on the panel.
  if (st?.topic && looksLikeProblem(text)) {
    const newTopic = extractProblemTopic(text);
    if (newTopic && newTopic !== st.topic) {
      clearProblemState(ctx.from.id);
      st = null;
    }
  }
  const alreadyEscalated = Boolean(st?.escalatedAt && Date.now() - st.escalatedAt < problemWindowMs());

  // "That fixed it" closes the report — never escalate a resolution. A bare
  // "cheers mate" after the FIXES means the same thing, NOT a still-broken
  // confirmation. After an ESCALATION though, thanks just means "thanks for
  // passing it along" — acknowledge warmly and keep the report open.
  // (saysStillBroken wins on ambiguity like "still not fixed".)
  if (st && looksLikeThanks(text) && !saysResolved(text) && alreadyEscalated) {
    setLogSource(logId, 'thanks');
    const msg = await spoken('bot.thanksMessage');
    if (msg) await ctx.api.sendMessage(ctx.chat.id, msg, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
    return;
  }
  if (st && (saysResolved(text) || looksLikeThanks(text)) && !saysStillBroken(text)) {
    clearProblemState(ctx.from.id);
    resolveOpenCase(ctx.from.id, 'user', st?.caseId);
    setLogSource(logId, 'resolved');
    if (alreadyEscalated) {
      // The admin was pinged earlier — close that loop too.
      hub.notifyAdmins(`✅ @${ctx.from?.username || ctx.from?.first_name} says their issue is now fixed: "${text.slice(0, 120)}"`).catch(() => {});
    }
    const note = await spoken('bot.problemResolvedNote');
    if (note) {
      await ctx.api.sendMessage(ctx.chat.id, note, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
    }
    return;
  }

  // The escalation ack asked which service the problem is on — capture the
  // user's next non-question message as the answer, attach it to their
  // escalated reports and forward it to the admins. A question instead
  // ("why do you need that?") flows through normal answering, and a repeat
  // complaint stays in the quiet already-escalated path — the ask stays
  // armed either way; "that fixed it" was already handled above.
  if (st?.awaitingService && !looksLikeQuestion(text) && !isProblem) {
    setProblemState(ctx.from.id, { awaitingService: false, at: Date.now() });
    const info = text.slice(0, 100);
    db.prepare('UPDATE problem_reports SET service = ? WHERE tg_user_id = ? AND escalated = 1 AND resolved = 0')
      .run(info, ctx.from.id);
    setLogSource(logId, 'service-info');
    if (getSetting('reports.alertProblems')) {
      hub.notifyAdmins(`↳ @${ctx.from?.username || ctx.from?.first_name} says the escalated problem is on: "${info}"`).catch(() => {});
    }
    await ctx.api.sendMessage(ctx.chat.id, '👍 Passed that along to the team.', { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
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
        // After an auto-close ("assuming it's sorted?") the default flips:
        // only explicit still-broken signals above escalate — a neutral
        // update is a soft yes, handled below.
        (isFollowUp && !looksLikeQuestion(text) && !st.fromAutoClose);
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
      // A wrong/faulty copy has no fixes that "take minutes to try" — the
      // quick-confirm pushback would be nonsense there.
      !isContentIssue(st?.firstText || text) &&
      getSetting('service.status') === 'operational'
    ) {
      setProblemState(ctx.from.id, { at: Date.now(), nudgedAt: Date.now() });
      setLogSource(logId, 'nudged');
      const nudge = await spoken('bot.problemNudgeMessage');
      if (nudge) {
        await ctx.api.sendMessage(ctx.chat.id, nudge, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
      }
      return;
    }

    // More triage before flagging: with fix rounds left, answer the
    // confirmation with the NEXT set of steps (different link, backup app,
    // clear cache, reinstall…) instead of escalating. Auto-close re-entries
    // skip this — those users were promised an immediate flag — and so do
    // known outages.
    const maxRounds = Math.max(1, Math.min(4, Number(getSetting('bot.problemFixRounds')) || 1));
    if ((st?.fixRounds || 1) < maxRounds && !st?.fromAutoClose && getSetting('service.status') === 'operational'
        && !isContentIssue(st?.firstText || text)) {
      // (Content issues — a faulty copy of a title — skip extra rounds:
      // no device fix can change the file, the admin has to.)
      const newRound = (st?.fixRounds || 1) + 1;
      setProblemState(ctx.from.id, { at: Date.now(), fixRounds: newRound });
      recordProblem(ctx, text, { answered: true });
      const deeperQ = `${(st?.firstText || text).slice(0, 200)} — still happening after trying the first fixes. What else can I try?`;
      const deeper = await answer(ctx, deeperQ, { isDm: false, logId, skipFaq: true, assumeOnTopic: true, directed: true, deepen: true, suffix: followupNoteForRound(newRound) });
      if (deeper === 'ai') {
        setProblemState(ctx.from.id, { answeredAt: Date.now() });
        return;
      }
      // The AI had nothing further — fall through and escalate now.
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
    const ack = await spoken('bot.problemFlaggedNote');
    // Ask which service it's on — the answer goes to the admins too.
    // (Kept verbatim: it's an instruction, and it must stay a question.)
    const serviceQ = getSetting('bot.problemServiceQuestion');
    const ackFull = [ack, serviceQ].filter(Boolean).join('\n');
    if (ackFull) {
      await ctx.api.sendMessage(ctx.chat.id, ackFull, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
    }
    if (serviceQ) setProblemState(ctx.from.id, { awaitingService: true });
    return;
  }

  // Neutral reply to the auto-close notice ("we watched the end & went to
  // bed, not tried it today") — the notice asked "is it sorted?", so a reply
  // without still-broken phrasing leans yes: close softly, door left open.
  // (Clear resolutions got the warm close above; still-broken escalated.)
  if (st?.fromAutoClose && isFollowUp && !looksLikeQuestion(text)) {
    setLogSource(logId, 'soft-close');
    const msg = await spoken('bot.problemSoftCloseMessage');
    if (msg) await ctx.api.sendMessage(ctx.chat.id, msg, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
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
    // fromAutoClose: false — a FRESH report re-enters normal triage even if
    // an old auto-close flag is still merged into this user's state.
    setProblemState(ctx.from.id, { at: Date.now(), escalatedAt: null, firstText: text.slice(0, 200), fromAutoClose: false });
    problemId = recordProblem(ctx, text, { answered: false });
    setProblemState(ctx.from.id, { caseId: problemId, topic: extractProblemTopic(text) });
    problemSuffix = followupNoteForRound(1);
    // Outage/degradation check BEFORE building the banner: the report that
    // tips the threshold gets the known-issue banner on its own answer.
    checkOutage();
    problemPrefix = serviceStatusLine();
  }

  if (!shouldAnswer) return;

  // Cooldown drops are stamped in the log — a silently ignored question is
  // indistinguishable from a bug without this.
  if (onCooldown(ctx.from.id)) {
    setLogSource(logId, 'cooldown');
    return;
  }
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

  // Replying to the bot's own message is by definition an on-topic
  // conversation — a bare "THM4821" after the which-service answer must not
  // be brushed off as OFFTOPIC.
  const outcome = await answer(ctx, question, { isDm: false, logId, history, skipFaq: isFollowUp, suffix: problemSuffix, prefix: problemPrefix, assumeOnTopic: isFollowUp, directed: mentioned || isFollowUp });

  // Only mark the report answered when a real answer actually went out —
  // and remember WHEN, so too-quick confirmations can be nudged.
  if (problemId) {
    const gotAnswer = ['faq', 'ai'].includes(outcome);
    db.prepare('UPDATE problem_reports SET answered = ? WHERE id = ?').run(gotAnswer ? 1 : 0, problemId);
    if (gotAnswer) setProblemState(ctx.from.id, { answeredAt: Date.now() });
  }
}

// Problem triage for DMs — the group flow's sibling. Everything in a DM is
// aimed at the bot, so no reply-chain logic is needed: the stored case state
// carries the conversation, and a bare short "Yes" after the fixes stands in
// for the group's reply-to-bot confirmation. Returns true when the message
// was consumed. (Live bug this fixes: DM "buffering on bbc 1" → deflecting
// AI answer → "Yes" → "Great! How can I assist you further?" — no fixes
// followed up, nothing escalated.)
async function handleDmProblemReply(ctx, text, logId) {
  const st = getProblemState(ctx.from.id);
  if (!st) return false;
  // A different problem is a new case, not more detail on this one — see the
  // group path. Returning false hands it to the first-report flow.
  if (st.topic && looksLikeProblem(text)) {
    const newTopic = extractProblemTopic(text);
    if (newTopic && newTopic !== st.topic) {
      clearProblemState(ctx.from.id);
      return false;
    }
  }
  const send = (msg) => ctx.api.sendMessage(ctx.chat.id, msg).catch(() => {});
  const alreadyEscalated = Boolean(st.escalatedAt && Date.now() - st.escalatedAt < problemWindowMs());
  const isProblem = looksLikeProblem(text);

  // Thanks after escalation = "thanks for passing it along" — keep it open.
  if (looksLikeThanks(text) && !saysResolved(text) && alreadyEscalated) {
    setLogSource(logId, 'thanks');
    const msg = await spoken('bot.thanksMessage');
    if (msg) await send(msg);
    return true;
  }
  if ((saysResolved(text) || looksLikeThanks(text)) && !saysStillBroken(text)) {
    clearProblemState(ctx.from.id);
    resolveOpenCase(ctx.from.id, 'user', st?.caseId);
    setLogSource(logId, 'resolved');
    if (alreadyEscalated) {
      hub.notifyAdmins(`✅ @${ctx.from?.username || ctx.from?.first_name} says their issue is now fixed: "${text.slice(0, 120)}"`).catch(() => {});
    }
    const note = await spoken('bot.problemResolvedNote');
    if (note) await send(note);
    return true;
  }

  // Which-service answer for an escalated report.
  if (st.awaitingService && !looksLikeQuestion(text) && !isProblem) {
    setProblemState(ctx.from.id, { awaitingService: false, at: Date.now() });
    const info = text.slice(0, 100);
    db.prepare('UPDATE problem_reports SET service = ? WHERE tg_user_id = ? AND escalated = 1 AND resolved = 0')
      .run(info, ctx.from.id);
    setLogSource(logId, 'service-info');
    if (getSetting('reports.alertProblems')) {
      hub.notifyAdmins(`↳ @${ctx.from?.username || ctx.from?.first_name} says the escalated problem is on: "${info}"`).catch(() => {});
    }
    await send('👍 Passed that along to the team.');
    return true;
  }

  let isConfirmation = false;
  if (!alreadyEscalated) {
    const shortAffirm =
      /^\s*(yes|yeah|yep|yup|aye|i (have|did)|did (that|them|it)|done (that|them|it|all)|tried)/i.test(text) &&
      text.trim().split(/\s+/).length <= 8;
    isConfirmation =
      isProblem || saysStillBroken(text) || negatesFixes(text) || hasTimeDetail(text) ||
      (shortAffirm && !st.fromAutoClose);
  }

  if (isConfirmation) {
    // Same physics check as the group: an instant "Yes" gets one pushback.
    const nudgeMinutes = Number(getSetting('bot.problemNudgeMinutes')) || 0;
    const sinceAnswer = st.answeredAt ? Date.now() - st.answeredAt : null;
    const tooQuick = nudgeMinutes > 0 && sinceAnswer !== null && sinceAnswer < nudgeMinutes * 60000;
    if (
      tooQuick && !st.nudgedAt &&
      !negatesFixes(text) && !hasTimeDetail(text) &&
      // A wrong/faulty copy has no fixes that "take minutes to try" — the
      // quick-confirm pushback would be nonsense there.
      !isContentIssue(st?.firstText || text) &&
      getSetting('service.status') === 'operational'
    ) {
      setProblemState(ctx.from.id, { at: Date.now(), nudgedAt: Date.now() });
      setLogSource(logId, 'nudged');
      const nudge = await spoken('bot.problemNudgeMessage');
      if (nudge) await send(nudge);
      return true;
    }

    // Same second-round triage as the group before flagging (DM history
    // gives the model the earlier fixes, so round two is genuinely new).
    const maxRounds = Math.max(1, Math.min(4, Number(getSetting('bot.problemFixRounds')) || 1));
    if ((st.fixRounds || 1) < maxRounds && !st.fromAutoClose && getSetting('service.status') === 'operational'
        && !isContentIssue(st.firstText || text)) {
      // (Faulty-copy content issues skip extra rounds — only the admin can
      // repair or replace the file.)
      const newRound = (st.fixRounds || 1) + 1;
      setProblemState(ctx.from.id, { at: Date.now(), fixRounds: newRound });
      recordProblem(ctx, text, { answered: true });
      const deeperQ = `${(st.firstText || text).slice(0, 200)} — still happening after trying the first fixes. What else can I try?`;
      const deeper = await answer(ctx, deeperQ, { isDm: true, logId, skipFaq: true, assumeOnTopic: true, deepen: true, suffix: followupNoteForRound(newRound) });
      if (deeper === 'ai') {
        setProblemState(ctx.from.id, { answeredAt: Date.now() });
        return true;
      }
      // Nothing further to suggest — escalate below.
    }

    setProblemState(ctx.from.id, { at: Date.now(), escalatedAt: Date.now() });
    recordProblem(ctx, text, { answered: true });
    db.prepare('UPDATE problem_reports SET escalated = 1 WHERE tg_user_id = ? AND resolved = 0').run(ctx.from.id);
    const alertText = st.firstText && st.firstText !== text ? `${st.firstText} — ${text}` : text;
    queueProblemAlert({
      tg_user: ctx.from?.username || ctx.from?.first_name,
      tg_user_id: ctx.from?.id,
      text: alertText,
      topic: extractProblemTopic(st.firstText || '') || extractProblemTopic(text),
    });
    setLogSource(logId, 'escalated');
    const ack = await spoken('bot.problemFlaggedNote');
    const serviceQ = getSetting('bot.problemServiceQuestion');
    const ackFull = [ack, serviceQ].filter(Boolean).join('\n');
    if (ackFull) await send(ackFull);
    if (serviceQ) setProblemState(ctx.from.id, { awaitingService: true });
    return true;
  }

  // Neutral reply to the auto-close notice — soft close, door open.
  if (st.fromAutoClose && !looksLikeQuestion(text) && !isProblem) {
    setLogSource(logId, 'soft-close');
    const msg = await spoken('bot.problemSoftCloseMessage');
    if (msg) await send(msg);
    return true;
  }

  if (isProblem && alreadyEscalated) {
    // Admins are already on it — stay quiet rather than nag or re-alert.
    setProblemState(ctx.from.id, { at: Date.now() });
    return true;
  }
  return false; // questions and unrelated messages flow to normal answering
}

export async function handleDirectMessage(ctx) {
  const media = unreadableMedia(ctx.message);
  const text = ctx.message?.text ?? ctx.message?.caption;
  if (!text && !media) return;
  state.bot.lastUpdateAt = Date.now();
  if (!getSetting('bot.enabled')) return;

  // Media with no caption: everything in a DM is aimed at the bot, and the
  // bot can't see it — ask them to type it out instead.
  if (!text) {
    if (getSetting('bot.dmEnabled')) await sendMediaNag(ctx);
    return;
  }

  if (!getSetting('bot.dmEnabled')) return;
  if (containsBannedWord(text, getBannedWords())) return;
  // Log BEFORE the cooldown check — a dropped DM used to vanish entirely.
  const logId = logMessage(ctx.chat.id, ctx.from, text, null, ctx.message, 'DM');
  if (onCooldown(ctx.from.id)) {
    setLogSource(logId, 'cooldown');
    return;
  }
  bumpCooldown(ctx.from.id);

  // Per-user service URL flow: answer a pending username reply, or start the
  // flow when they ask for a URL — only ever THEIR service's URL.
  if (await handleUrlServiceReply(ctx, text, logId, {})) return;
  if (await handleVodConfirmReply(ctx, text, logId, {})) return;
  if (await handleVodServiceReply(ctx, text, logId, {})) return;
  if (isUrlRequest(text) && await handleUrlRequest(ctx, logId, {})) return;

  // "Request: Title (Year)" works in DMs too.
  {
    const vodTitle = anyVodRequest(text);
    if (vodTitle) {
      setLogSource(logId, 'vod-request');
      await ctx.reply(await captureVodRequest(ctx, vodTitle)).catch(() => {});
      return;
    }
  }

  // Problem triage first: with an active report, "yes" / "still broken" /
  // "sorted" replies belong to it — a bare "cheers" then means "resolved",
  // not a generic thank-you.
  if (await handleDmProblemReply(ctx, text, logId)) return;

  // A wave back beats the topic police: greetings and thanks get warm canned
  // replies (configurable) and never reach the AI or the off-topic path.
  if (looksLikeGreeting(text)) {
    setLogSource(logId, 'greeting');
    const msg = await spoken('bot.greetingMessage');
    if (msg) await ctx.reply(msg).catch(() => {});
    return;
  }
  if (looksLikeThanks(text)) {
    setLogSource(logId, 'thanks');
    const msg = await spoken('bot.thanksMessage');
    if (msg) await ctx.reply(msg).catch(() => {});
    return;
  }

  // First report: record it for the panel, answer with the fixes, and
  // invite the user to confirm — the same fixes-first flow as the group.
  let problemId = null;
  let problemSuffix = null;
  let problemPrefix = null;
  if (looksLikeProblem(text) && !getProblemState(ctx.from.id)) {
    setProblemState(ctx.from.id, { at: Date.now(), escalatedAt: null, firstText: text.slice(0, 200), fromAutoClose: false });
    problemId = recordProblem(ctx, text, { answered: false });
    setProblemState(ctx.from.id, { caseId: problemId, topic: extractProblemTopic(text) });
    problemSuffix = followupNoteForRound(1);
    checkOutage();
    problemPrefix = serviceStatusLine();
  }
  const outcome = await answer(ctx, text, { isDm: true, logId, suffix: problemSuffix, prefix: problemPrefix });
  if (problemId) {
    const gotAnswer = ['faq', 'ai'].includes(outcome);
    db.prepare('UPDATE problem_reports SET answered = ? WHERE id = ?').run(gotAnswer ? 1 : 0, problemId);
    if (gotAnswer) setProblemState(ctx.from.id, { answeredAt: Date.now() });
  }
}
