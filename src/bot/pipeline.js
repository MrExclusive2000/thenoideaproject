import { InlineKeyboard } from 'grammy';
import { db, now } from '../db/db.js';
import { getSetting, redactServiceUrls, serviceStatusFor, serviceNotesFor } from '../settings.js';
import { matchFaq } from '../faq/matcher.js';
import { askAi, aiBudgetExceeded, rephraseCanned } from '../ai/client.js';
import { containsBannedWord, endsWithQuestion, offersNoNewHelp, repeatsPreviousAnswer } from '../ai/guardrails.js';
import { state } from '../state.js';
import {
  sendChunked, logMessage, setLogSource, recordUnanswered, chatAllowed,
  isLikelyInScope, hasScopeSignal, recordProblem, extractProblemTopic, isAdminUser,
  isContentIssue, looksLikeLiveIssue, wrongCopyIssue, withAdminContact, linkedCustomer,
} from './helpers.js';
import { alertAdmins } from './reports.js';
import { embed, retrieveFaqs, embeddingsProven } from '../ai/embeddings.js';
import { lookupAnswer, rememberAnswer, cacheable } from '../ai/answer-cache.js';
import { circuitOpen } from '../ai/breaker.js';
import { looksLikeChannelQuestion, looksLikeFixtureQuestion, channelGrounding, channelCount, findChannels, findVodTitle, vodKnown, xcConfigured } from '../xc.js';
import { looksLikeGuideRequest, findGuide, visibleGuides, mdToPlain, guideLeadIn } from '../guides.js';
import { looksLikeWalletRequest, walletMessage } from '../payments.js';
import { looksLikeInviteRequest, buildInvite, INVITE_NO_GROUP, INVITE_NO_PERMISSION } from './invites.js';
import { looksLikeCredentialDump, CREDENTIAL_WARNING } from './credentials.js';
import { looksLikeSportsQuestion, sportsGrounding, sportsEnabled } from '../sports.js';
import { recallService, rememberService, forgetService } from '../service-memory.js';
import {
  queueProblemAlert, setProblemRearmHook, maybeAutoDegrade,
  looksLikeCaseClose, caseNumbersIn, closeCaseAsAdmin, openCaseIds,
} from './problems.js';
import { parseVodRequest, parseNaturalVodRequest, parseAvailabilityQuestion, serviceNamedIn, recordVodRequest, setRequestService, lookupImdb, canonicalizeRequest } from './requests.js';
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
  // Each service carries its own number. serviceConfig() builds a fresh
  // object every call, so `svc === s.two` is always false however obviously
  // correct it looks — which silently labelled everyone service 1.
  return {
    one: { num: 1, name: String(getSetting('services.name1') || '').trim(), url: String(getSetting('services.url1') || '').trim() },
    two: { num: 2, name: String(getSetting('services.name2') || '').trim(), url: String(getSetting('services.url2') || '').trim() },
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
// Does this word plausibly name an account, as opposed to being an ordinary
// word out of a sentence? serviceForUsername below never returns null — it is
// a classifier, not a detector — so everything handed to it must have passed
// through here first, or any stray word gets filed as the customer's service.
function plausibleUsername(word) {
  const w = String(word || '').trim();
  if (w.length < 4) return false;
  // On our books: settled, whatever it looks like.
  try {
    if (db.prepare('SELECT 1 FROM customers WHERE LOWER(username) = ? LIMIT 1').get(w.toLowerCase())) return true;
  } catch { /* table may not exist yet */ }
  const s = serviceConfig();
  if (s.prefix && w.toUpperCase().startsWith(s.prefix.toUpperCase()) && w.length > s.prefix.length) return true;
  // Otherwise it has to look like a login rather than a word: a digit in it,
  // or a mix of cases. "sports" and "football" are neither.
  return /\d/.test(w) || (/[a-z]/.test(w) && /[A-Z]/.test(w.slice(1)));
}

// What the "which service is this on?" question actually asked for: a service
// name, or the username they log in with. Returns the label to record, or null
// — and null means "they did not answer it", never "record this anyway".
function serviceAnswerIn(text) {
  const svc = serviceFromReply(text);
  if (svc?.name) return svc.name;
  if (svc) return `service ${svc.num}`;
  const words = plainWords(text);
  // A bare username, or one in a short sentence ("im on THM4821").
  if (words.length <= 6) {
    const cand = String(text).trim().split(/\s+/).map((w) => w.replace(/[^\w]/g, '')).find((w) => plausibleUsername(w));
    if (cand) {
      const guess = serviceForUsername(cand);
      return guess?.name ? `${cand} (${guess.name})` : cand;
    }
  }
  // Free text, accepted ONLY when the panel has no service names to match
  // against — then "Exclusive" is a perfectly good answer and there is
  // nothing to check it with. With names configured, serviceFromReply above
  // is the only way in: otherwise "refund me then" (three words, no service
  // named) was filed as the service the fault is on.
  if (twoServicesNamed()) return null;
  const ASKING_FOR_SOMETHING = /\b(refund|cancel|money back|help|sort|send|give|want|need|please|when|sorry|fix)\b/i;
  if (words.length && words.length <= 3
      && !looksLikeAcknowledgement(text) && !looksLikeThanks(text)
      && !looksLikeFrustration(text) && !looksLikeQuestion(text)
      && !mentionsTriedAlready(text) && !ASKING_FOR_SOMETHING.test(text)) {
    return String(text).trim().slice(0, 100);
  }
  return null;
}

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
    // They just told us their username. That is the strongest evidence short
    // of a linked account, and it saves asking them again later.
    rememberService(ctx.from.id, svc.num, 'username', cand);
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
    rememberService(ctx.from.id, svc.num, 'told');
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

// Two services exist whether or not the admin has got round to NAMING them.
// Gating the which-service follow-up on the names being filled in meant a
// half-configured install silently never asked — which looks like the bot
// not caring, not like a setting being blank.
function twoServicesNamed() {
  const s = serviceConfig();
  if (s.one.name && s.two.name) return true;
  if (s.one.url && s.two.url) return true;
  return xcConfigured(1) && xcConfigured(2);
}

const servicesAreNamed = () => {
  const s = serviceConfig();
  return Boolean(s.one.name && s.two.name);
};

// Without names there is no "X or Y?" to ask, but the username answers the
// same question and is the authoritative source anyway.
const USERNAME_ASK = "What's the username you log in with? (just the username, never the password) — I'll work out which service you're on.";

function vodServiceAskText() {
  const s = serviceConfig();
  const q = String(getSetting('bot.requestServiceQuestion') || '').trim();
  if (!servicesAreNamed()) return `${q} ${USERNAME_ASK}`.trim();
  return `${q} ${s.one.name} or ${s.two.name}?`.trim();
}

function rememberVodService(userId, name, num = null) {
  knownVodService.set(userId, { name, num, at: Date.now() });
  if (knownVodService.size > 500) knownVodService.delete(knownVodService.keys().next().value);
}

function peekVodService(userId) {
  const k = knownVodService.get(userId);
  return k && Date.now() - k.at < URL_TTL_MS ? k.name : null;
}

// The NUMBER is what every per-service lookup actually needs, and unlike the
// name it exists whether or not the admin has filled the names in.
function peekServiceNumber(userId) {
  const k = knownVodService.get(userId);
  return k && Date.now() - k.at < URL_TTL_MS ? k.num : null;
}

// ---- which service is this person on? --------------------------------------
// The two services carry DIFFERENT channel lineups and DIFFERENT VOD
// libraries, so a fair number of answers are only correct for one of them.
// Answering from service 1 for everybody is not a neutral default — it is
// confidently telling half the customers something untrue about their own
// service. Resolve it where we can, ask once where we cannot.

// 1 or 2, or null when we genuinely cannot tell.
function serviceNumberFor(ctx, question = '') {
  const s = serviceConfig();
  const id = ctx.from?.id;

  // What they said in this very message wins FOR THIS MESSAGE. It is not
  // stored: naming a service in a question says nothing about who you are.
  // Someone on Flix can perfectly well ask "is Big Bang Theory on Exclusive?"
  // and pinning them to Exclusive over it would be wrong from then on.
  const named = serviceNamedIn(question);
  if (named) return named;

  // A linked customer is authoritative — their username is on file, and the
  // username is what decides the service. Recorded so it survives unlinking.
  const customer = linkedCustomer(id);
  if (customer?.username) {
    const num = serviceForUsername(customer.username).num;
    rememberService(id, num, 'linked', customer.username);
    return num;
  }

  // An admin is on BOTH services, so a remembered answer must not quietly
  // speak for them. They pin one deliberately with /service, which stores it
  // as 'admin' and is honoured below like anyone else's.
  const stored = recallService(id);
  if (stored && !(isAdminUser(id) && stored.source !== 'admin')) return stored.service;

  // Last resort: what they said a few minutes ago in this conversation.
  const num = peekServiceNumber(id);
  if (num) return num;
  const remembered = peekVodService(id);
  if (remembered) {
    if (s.two.name && remembered.toLowerCase() === s.two.name.toLowerCase()) return 2;
    if (s.one.name && remembered.toLowerCase() === s.one.name.toLowerCase()) return 1;
  }
  return null;
}

// With only one service configured there is nothing to ask about, so the
// question would be pure friction.
const serviceAmbiguous = () => twoServicesNamed();

function serviceAskText(why) {
  const s = serviceConfig();
  if (!servicesAreNamed()) return `${why} ${USERNAME_ASK}`;
  return `${why} Which service are you on — ${s.one.name} or ${s.two.name}? (Not sure? Reply with the username you log in with — never the password — and I'll work it out.)`;
}

// A question parked while we ask which service it is about, so the customer
// does not have to type it again. Without this the follow-up costs them a
// message and reads as the bot being obtuse.
const pendingServiceQuestion = new Map(); // chatId:userId -> { question, at }

// Ask which service, and park the question. Returns true when it asked.
async function askWhichService(ctx, question, why, logId, replyParams) {
  if (!serviceAmbiguous()) return false;
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  pendingServiceQuestion.set(key, { question, at: Date.now() });
  if (pendingServiceQuestion.size > 500) {
    pendingServiceQuestion.delete(pendingServiceQuestion.keys().next().value);
  }
  setLogSource(logId, 'service-ask');
  await ctx.api.sendMessage(ctx.chat.id, serviceAskText(why), replyParams).catch(() => {});
  return true;
}

// Their answer to that ask: remember it and re-run what they originally
// asked, so they never have to type it twice.
async function handleServiceReply(ctx, text, logId, replyParams) {
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  const st = pendingServiceQuestion.get(key);
  if (!st) return false;
  if (Date.now() - st.at >= URL_TTL_MS) {
    pendingServiceQuestion.delete(key);
    return false;
  }
  // They moved on rather than answering — let the normal flow have it.
  if (looksLikeProblem(text) || anyVodRequest(text) || looksLikeGreeting(text) || looksLikeThanks(text)) {
    pendingServiceQuestion.delete(key);
    return false;
  }

  const s = serviceConfig();
  let svc = serviceFromReply(text);
  let usedUsername = null;
  if (!svc) {
    // They may have replied with a username instead of a service name.
    const cand = plainWords(text).sort((a, b) => b.length - a.length)[0] || '';
    if (cand.length >= 4) {
      svc = serviceForUsername(cand);
      usedUsername = cand;
    }
  }
  if (!svc) {
    // One more go before giving up. Dropping it meant the message fell into
    // whatever flow was armed next — a one-word "Now" landed in problem
    // triage and got "let me know if it stops working again".
    if (!st.attempts) {
      st.attempts = 1;
      st.at = Date.now();
      const s2 = serviceConfig();
      setLogSource(logId, 'service-ask');
      await ctx.api.sendMessage(ctx.chat.id, servicesAreNamed()
        ? `Sorry, didn't catch that — ${s2.one.name} or ${s2.two.name}? (Or ${USERNAME_ASK.charAt(0).toLowerCase()}${USERNAME_ASK.slice(1)})`
        : `Sorry, didn't catch that — ${USERNAME_ASK}`, replyParams).catch(() => {});
      return true;
    }
    pendingServiceQuestion.delete(key);
    return false; // give up gracefully — normal handling takes it
  }

  // Requiring a NAME here threw the answer away on any install where the two
  // services had not been named — the bot asked for the username, got it,
  // worked out the service, and then silently dropped the whole thing. The
  // number is what every per-service lookup needs, and it exists either way.
  const num = svc.num;
  pendingServiceQuestion.delete(key);
  rememberVodService(ctx.from.id, svc.name || `service ${num}`, num);
  // Answering "which service are you on?" IS a statement about themselves, so
  // it is kept — this is what stops the same person being asked every time.
  // A username is stronger evidence than a name they picked off a menu.
  rememberService(ctx.from.id, num, usedUsername ? 'username' : 'told', usedUsername || null);
  // Re-run the original question now that the answer will be right for them.
  await answer(ctx, st.question, { isDm: ctx.chat.type === 'private', logId, assumeOnTopic: true });
  return true;
}

// Questions whose answer differs between the two services. Both of these read
// from per-service data, so answering without knowing which one is a coin
// flip dressed up as an answer.
function isServiceSpecific(question) {
  return looksLikeChannelQuestion(question) || looksLikeFixtureQuestion(question);
}

export const _startsNewTopic = (t) => startsNewTopic(t);
export const _looksLikeQuestion = (t) => looksLikeQuestion(t);
export const _looksLikeProblem = (t) => looksLikeProblem(t);
export const _plausibleUsername = (t) => plausibleUsername(t);
export const _answersIsItSorted = (t) => answersIsItSorted(t);

export const _resetServiceAsk = () => {
  pendingServiceQuestion.clear();
  knownVodService.clear();
};

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
// Is it already on the service? Checked before anything is filed, because a
// request for a title we already carry costs the customer their evening
// (waiting for a batch that will never come) and the admin a manual close.
// Returns sendable text, or null to carry on and record the request.
function alreadyInLibrary(ctx, title, asked = '') {
  const service = serviceNumberFor(ctx, asked);
  // Only check a library we actually hold. With no cached library, or no idea
  // which service they are on AND the two libraries differing, saying "it's
  // already there" would be a guess — and sending someone hunting through
  // the app for a film we do not carry is worse than taking a duplicate.
  const candidates = service ? [service] : [1, 2];
  const usable = candidates.filter((n) => vodKnown(n));
  if (!usable.length) return null;
  if (!service && usable.length === 2 && serviceAmbiguous()) {
    const hitsOne = findVodTitle(title, { service: 1 });
    const hitsTwo = findVodTitle(title, { service: 2 });
    // Only answer outright when both services agree; otherwise it depends on
    // who they are, and the service ask below handles that.
    if (!hitsOne.length || !hitsTwo.length) return null;
    return hitsOne[0];
  }
  for (const n of usable) {
    const hits = findVodTitle(title, { service: n });
    if (hits.length) return hits[0];
  }
  return null;
}

// Is the thing they asked about a LIVE CHANNEL we carry? Deliberately strict:
// findChannels is a fuzzy ranker built for "what's on bbc1", and a loose hit
// here would answer "yes we have that" about a film because some channel name
// shares a word with it. Every significant word of the title has to appear in
// the channel's name.
function channelsCarrying(title, service) {
  const words = String(title).toLowerCase().match(/[a-z0-9+]+/g) || [];
  const meaningful = words.filter((w) => w.length > 2 && !['the', 'and', 'you', 'got', 'have', 'any'].includes(w));
  if (!meaningful.length) return [];
  return findChannels(title, { service, limit: 6 })
    .filter((c) => {
      const name = String(c.name).toLowerCase();
      return meaningful.every((w) => name.includes(w));
    });
}

function alreadyInLineup(ctx, title, asked = '') {
  const service = serviceNumberFor(ctx, asked);
  const candidates = service ? [service] : [1, 2];
  // A cached lineup is what matters, not whether the panel is reachable right
  // now — the answer comes from the cache either way.
  const usable = candidates.filter((n) => channelCount(n) > 0);
  if (!usable.length) return null;
  for (const n of usable) {
    const hits = channelsCarrying(title, n);
    if (!hits.length) continue;
    const names = [...new Set(hits.map((h) => h.name))].slice(0, 4);
    const list = names.length > 1 ? `\n${names.map((x) => `• ${x}`).join('\n')}` : ` "${names[0]}"`;
    return `✅ Yes — that's a live channel on the service${list}\n\nIt's in the TV guide in your app. If it won't play, say so and I'll get it looked at.`;
  }
  return null;
}

function libraryHitText(hit, meant = null) {
  const where = hit.kind === 'series' ? 'Series' : 'Movies';
  // When IMDb confirmed the same thing, say its proper name — the library
  // writes them as "Mob Land - 2023" and nobody calls it that.
  const shown = meant?.canonical && hit.exact ? meant.canonical : hit.name;
  const kind = hit.kind === 'series' ? 'a series' : 'a film';
  if (hit.exact) {
    return `✅ Good news — "${shown}" is already on the service. Open the ${where} section in your app and search for it. If it won't play, tell me and I'll get it looked at.`;
  }
  // An unsure hit must say WHAT it found, not just that it found something.
  // "Mob Land - 2023" was offered for "MobLand" as a certainty: same letters
  // once the spaces come out, a different title, a different year, and a film
  // rather than the series they asked about. The year and the kind are what
  // let the customer spot that in a second — and the offer to request the
  // right one has to come with it, or being told the wrong thing is where it
  // ends for them.
  const year = hit.year ? ` (${hit.year})` : '';
  return `🤔 Closest I've got is "${hit.name}"${year} — ${kind}, in the ${where} section. `
    + `If that's the one, you're sorted. If you meant a different one, say so with the year `
    + `and I'll get it requested for you.`;
}

// "Do you have The Big Bang Theory?" has a factual answer, and the model used
// to invent one — "it is available in our VOD section" — for a show nobody had
// checked. The customer then hunts through the app for something we may not
// carry. Only the library may answer this; when there is no library cached,
// it becomes a request, because a duplicate request is cheap and a wrong
// "yes we have it" is not.
// Does what the LIBRARY holds actually match what the customer meant? IMDb
// knows "MobLand" is a 2025 Tom Hardy series and "Mob Land" a 2023 Travolta
// film; the library only knows a string. Without this the bot matched one to
// the other and called it good news.
// Returns null when IMDb is off, unreachable, or has nothing useful — every
// path here degrades to the previous behaviour rather than blocking an answer.
async function imdbVerdict(title, hit) {
  const meant = await lookupImdb(title).catch(() => null);
  if (!meant) return null;
  if (!hit) return { meant, mismatch: false };
  const held = String(hit.name || '');
  const heldYear = hit.year ? String(hit.year) : null;
  const sameKind = hit.kind === meant.kind;
  const sameYear = !heldYear || !meant.year || heldYear === String(meant.year);
  // A different kind, or a different year, means the library is holding a
  // different thing with a similar name.
  return { meant, mismatch: !sameKind || !sameYear, held };
}

// The poster rides with the answer when there is one. Sent as a photo with
// the text as its caption, so it is one message rather than two — and if
// Telegram will not take the image (too big, host unreachable, caption over
// its 1024-character limit) the text still goes out on its own. Being told
// about a title without a picture is fine; not being told is not.
async function sendAvailability(ctx, result, replyParams) {
  const { text, poster } = typeof result === 'string' ? { text: result, poster: null } : (result || {});
  if (!text) return;
  if (poster && getSetting('vod.posters') !== false && text.length <= 1024) {
    try {
      await ctx.api.sendPhoto(ctx.chat.id, poster, { caption: text, ...replyParams });
      return;
    } catch {
      // fall through to plain text
    }
  }
  await ctx.api.sendMessage(ctx.chat.id, text, replyParams).catch(() => {});
}

async function answerAvailability(ctx, title, asked = '') {
  // A CHANNEL first. "Do you have Sky Sports" was being filed as a request for
  // a film while two Sky Sports channels sat in the lineup the bot owns — the
  // customer was told "I can't check" about something it could check, and the
  // admin got a VOD request for a TV channel. Channels are checked before the
  // library because a channel name is the less ambiguous of the two.
  const chan = alreadyInLineup(ctx, title, asked);
  if (chan) return chan;

  const hit = alreadyInLibrary(ctx, title, asked);
  const verdict = await imdbVerdict(title, hit).catch(() => null);
  const poster = verdict?.meant?.poster || null;

  if (hit) {
    // IMDb says the thing they meant is a different kind or a different year
    // from the thing we hold. That is the MobLand case: they asked about the
    // 2025 series, we have the 2023 film, and the bot called it good news.
    if (verdict?.mismatch) {
      const m = verdict.meant;
      const meantKind = m.kind === 'series' ? 'series' : 'film';
      const heldKind = hit.kind === 'series' ? 'series' : 'film';
      const { ack, requestId, deduped } = recordVodRequest(ctx, m.canonical);
      const body =
        `You mean ${m.canonical}${m.cast ? ` — the ${meantKind} with ${m.cast}` : ` — the ${meantKind}`}. `
        + `That one isn't on the service. What we do have is "${hit.name}", a different ${heldKind} with a similar name, `
        + `in the ${hit.kind === 'series' ? 'Series' : 'Movies'} section.\n\n${ack}`;
      return { text: deduped ? body : body + maybeArmServiceAsk(ctx, requestId), poster };
    }
    // IMDb agrees, or had nothing to say — the library answer stands, and a
    // confirmed title can be named properly rather than as the panel wrote it.
    return { text: libraryHitText(hit, verdict?.meant || null), poster };
  }

  const service = serviceNumberFor(ctx, asked);
  const checked = service ? vodKnown(service) : (vodKnown(1) && vodKnown(2));
  // Request the title IMDb recognised rather than whatever they typed — it
  // dedupes properly and the admin gets something searchable.
  const requestTitle = verdict?.meant?.canonical || title;
  if (checked) {
    const { ack, requestId, deduped } = recordVodRequest(ctx, requestTitle);
    const named = verdict?.meant
      ? `${verdict.meant.canonical}${verdict.meant.cast ? ` (${verdict.meant.cast})` : ''} isn't in there at the moment — I've checked.`
      : "Not in there at the moment — I've checked.";
    const head = `${named} ${ack}`;
    return { text: deduped ? head : head + maybeArmServiceAsk(ctx, requestId), poster };
  }
  // No library to check against. Say so rather than guessing either way.
  const { ack, requestId, deduped } = recordVodRequest(ctx, requestTitle);
  const head = `I can't check the library from here, so I've put it on the request list — if we already have it the admin will say so. ${ack}`;
  return { text: deduped ? head : head + maybeArmServiceAsk(ctx, requestId), poster };
}

async function captureVodRequest(ctx, title) {
  // alreadyInLibrary returns the HIT now, so the availability path can check
  // it against IMDb. This path only needs the sentence.
  const already = alreadyInLibrary(ctx, title);
  if (already) {
    const meant = await lookupImdb(title).catch(() => null);
    // The same mismatch check as the availability path: a request for the
    // 2025 series must not be closed off by the 2023 film of a similar name.
    const differentThing = meant && already.kind !== meant.kind;
    if (!differentThing) return libraryHitText(already, meant);
  }

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
  // parseAvailabilityQuestion too: "have you got tnt sports" is a NEW
  // question about the lineup, and it was being consumed as the answer to
  // "which service is that request for?".
  if (looksLikeQuestion(text) || anyVodRequest(text) || parseAvailabilityQuestion(text)
      || looksLikeProblem(text) || looksLikeGreeting(text) || looksLikeThanks(text)
      || looksLikeAcknowledgement(text)) {
    pendingVodService.delete(key);
    return false;
  }
  let svc = serviceFromReply(text);
  if (!svc) {
    // They may have answered with their username, which is what we asked for
    // when the services have no names configured. serviceForUsername is a
    // heuristic that ALWAYS returns a service, so it must only ever see
    // something that is actually a username — handed the longest word of any
    // sentence it assigned "sports" to a service and recorded it.
    const cand = plainWords(text).sort((a, b) => b.length - a.length)[0] || '';
    if (plausibleUsername(cand)) svc = serviceForUsername(cand);
  }
  const send = (msg) => ctx.api.sendMessage(ctx.chat.id, msg, replyParams).catch(() => {});
  setLogSource(logId, 'vod-request');
  if (svc) {
    pendingVodService.delete(key);
    const num = svc.num;
    const label = svc.name || `service ${num}`;
    setRequestService(st.requestId, label);
    rememberVodService(ctx.from.id, label, num);
    await send(`👍 Got it — noted for ${label}.`);
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
  // Ways people address the bot. "sir" was missing, so "good morning sir" was
  // not a greeting, went to the model, and came back off-topic — a customer
  // saying hello got told it was not our area.
  'sir', 'madam', 'maam', 'boss', 'chief', 'bro', 'bruv', 'fella', 'fellas',
  'gents', 'dude', 'folks', 'team', 'everybody', 'big', 'man', 'people',
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

// "What can you do?", "can you answer any of my questions", "are you a bot?" —
// a question ABOUT the bot, not a support question and not banter. Brushing
// these off with "can't help with that, I'm strictly service support" is the
// worst of both: it refuses the one question the bot can always answer, and
// it reads as broken when the user then asks what it IS for.
// "...what you can do" is the same question as "what can you do", and the
// word order defeated it: live, "Bot give everyone a brief overview what you
// can do" was filed as banter and answered with a chatty line plus the
// "service stuff is where I shine" steer bolted on the end — in a group, as
// an introduction to everybody.
const CAPABILITY_RE = /\b(?:what|which|anything)\b.{0,30}\b(?:can|could)\s+(?:you|u)\b|\b(?:what|anything|everything|all)\b[^.?!\n]{0,20}\b(?:you|u)\s+(?:can|could)\s+(?:do|help|offer|assist)\b|\b(?:overview|summary|rundown|run down|intro(?:duction)?|list)\b[^.?!\n]{0,30}\b(?:what|you|your)\b[^.?!\n]{0,20}\b(?:can|do|does|offer)\b|\btell\b[^.?!\n]{0,20}\b(?:what|everything)\b[^.?!\n]{0,15}\b(?:you|u)\s+(?:can|do)\b|\b(?:can|could)\s+(?:you|u)\b.{0,30}\b(?:answer|help|do|assist)\b|\bwhat(?:'?s| is| are)?\s+(?:your|ur)\s+(?:purpose|job|use|point)\b|\bare\s+(?:you|u)\s+(?:a\s+)?(?:bot|ai|real|human)\b|\bwhat\s+(?:do|are)\s+(?:you|u)\s+(?:do|for)\b/i;

// "Is this a real person?", "are you there or is this automated?" — the same
// question as "are you a bot", which the line above already answers, just
// phrased the other way round. Both were going to banter.
const IS_IT_HUMAN =
  /\b(?:is|are)\s+(?:this|that|it|you|u)\b[^.?!\n]{0,20}\b(?:real person|actual person|a human|human being|automated|a robot|a machine|ai|bot)\b|\bam i (?:talking|speaking|chatting) (?:to|with)\b[^.?!\n]{0,20}\b(?:a )?(?:bot|human|person|robot|machine|real)\b|\breal person or\b/i;

function looksLikeCapabilityQuestion(text) {
  const t = String(text || '').trim();
  if (t.length > 120) return false; // a long message is a real question with these words in it
  return CAPABILITY_RE.test(t) || IS_IT_HUMAN.test(t);
}

// Asking for a person. The single clearest signal a customer can send that
// the bot is not going to be enough, and it was answered with "service stuff
// is where I shine 😄 Try me!" — which is both the wrong answer and a little
// insulting to someone who has just said they want a human. It is also where
// phone calls belong: we do not have a phone, and the honest version of that
// is "the admin, here, by message", not banter.
const WANTS_A_HUMAN =
  /\b(?:speak|talk|chat|spk)\b[^.?!\n]{0,20}\b(?:to|with)\b[^.?!\n]{0,15}\b(?:a\s+)?(?:human|person|someone|somebody|real person|agent|advisor|manager|owner|admin|boss|staff)\b|\b(?:get|put)\b[^.?!\n]{0,15}\b(?:me\s+)?(?:through|onto|on)\b[^.?!\n]{0,15}\b(?:a\s+)?(?:human|person|someone|admin|agent)\b|\b(?:can|could|will|would)\s+(?:you|u|someone|somebody)\b[^.?!\n]{0,12}\b(?:ring|call|phone)\s+me\b|\b(?:i want|i need|id like|i'd like|gimme)\b[^.?!\n]{0,15}\b(?:a\s+)?(?:human|real person|person to talk)\b|\bhuman (?:please|pls)\b|\breal (?:person|human) please\b/i;

function looksLikeHumanRequest(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 160) return false;
  return WANTS_A_HUMAN.test(t);
}

export const _looksLikeHumanRequest = (t) => looksLikeHumanRequest(t);
export const _alreadySteers = (t) => alreadySteers(t);
export const _verbatimLines = () => VERBATIM_LINES;

function looksLikeGreeting(text) {
  const w = plainWords(text);
  return w.length > 0 && w.length <= 5 && w.every((x) => GREETING_WORDS.has(x));
}

// Words that mean hello and nothing else. The full list above includes
// contextual ones like "whats" (for "whats up") and "good", which are no use
// as evidence on their own — "whats the ltc wallet address" is five words
// containing "whats" and is plainly not a greeting.
const CORE_GREETING = new Set([
  'hey', 'hi', 'hiya', 'hello', 'yo', 'howdy', 'hola', 'alright', 'alrite',
  'ayup', 'sup', 'wassup', 'morning', 'afternoon', 'evening', 'greetings',
]);

// A short pleasantry that is MOSTLY a greeting. The strict test above needs
// EVERY word to be known, so one unlisted word ("sir") turned "good morning
// sir" into an off-topic message and the customer was brushed off for saying
// hello. No word list is ever complete, so this is the backstop: brief, says
// hello, asks nothing.
// "You there?", "anyone about?", "is anyone online" — checking somebody is
// listening before they type the real question. Not a greeting by vocabulary
// and not a help request, so it went to the banter path and got "service
// stuff is where I shine 😄" in reply to a customer wondering if anyone is
// home. Answering it like a hello is right: it invites the actual question.
const PRESENCE_RE =
  /^\s*(?:is\s+)?(?:any\s?(?:one|body)|u|you|ya|anyone\s+there|hello|helloo+)\s*(?:there|about|around|online|on|awake|in|up|home)?\s*\??\s*$/i;

function mostlyGreeting(text) {
  if (PRESENCE_RE.test(String(text || ''))) return true;
  const w = plainWords(text);
  if (!w.length || w.length > 5) return false;
  if (String(text).includes('?')) return false;
  return w.some((x) => CORE_GREETING.has(x));
}

// "Okay", "right", "cool" — the end of a conversation, not a new question.
// Answering one with an offer of help ("just let me know the channel name and
// I'll look it up") is noise: they did not ask for anything.
const ACK_WORDS = new Set([
  'ok', 'okay', 'okey', 'oki', 'k', 'kk', 'right', 'righto', 'cool', 'sound',
  'sounds', 'good', 'great', 'fine', 'fair', 'enough', 'gotcha', 'got', 'it',
  'understood', 'noted', 'alright', 'np', 'no', 'worries', 'problem', 'yep',
  'yeah', 'yh', 'ah', 'oh', 'i', 'see', 'will', 'do',
  // A bare "yes" or "maybe later" with no case open is the end of a
  // conversation, not a question. Both were reaching the model and coming
  // back with the banter line. During triage a short "yes" is caught earlier,
  // as a confirmation, so this only affects the quiet path.
  'yes', 'yea', 'aye', 'maybe', 'later', 'sure', 'nice', 'ta',
  // Laughing along is the end of a joke, not a new question. "fair enough ha"
  // was spending an AI call to reply to someone chuckling.
  'ha', 'haha', 'hah', 'lol', 'lmao', 'heh', 'hehe', 'true', 'indeed', 'same',
]);

// Noise: "???", "....", "hmmm", "ok so". Not a question, not an answer, not
// a complaint — someone thinking out loud or prodding the chat. Each one was
// spending a real AI call AND the per-user banter pass, then coming back with
// "service stuff is where I shine 😄", which is a strange reply to "....".
// Treated as an acknowledgement: the bot stays quiet and waits for the actual
// message, which is what a person would do.
const NOISE_ONLY = /^[\s.?!,;:\-_~*()[\]"'`]*$/;
const THINKING_NOISE = /^\s*(?:h+m+|e+r+m+|u+m+|a+h+|o+h+|h+a+h*|lol|haha|hmmm+|erm|well|so|ok so|right so|anyway)\s*[.?!]*\s*$/i;

function looksLikeNoise(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  return NOISE_ONLY.test(t) || THINKING_NOISE.test(t);
}

function looksLikeAcknowledgement(text) {
  if (looksLikeNoise(text)) return true;
  const w = plainWords(text);
  if (!w.length || w.length > 3) return false;
  if (String(text).includes('?')) return false;
  return w.every((x) => ACK_WORDS.has(x));
}

// "I need assistance", "can someone help me", "need a hand" — a request for
// help that hasn't said what's wrong yet. It carries NO vocabulary from the
// service, so the scope gate read it as off-script and the customer asking
// for help was told "can't help with that one 😂, I'm strictly service
// support". That is the single worst reply in the bot. The right answer is to
// ask what's up, from code, so it still works with the AI unreachable.
const HELP_WORDS = new Set([
  'help', 'helps', 'helping', 'assistance', 'assist', 'support', 'hand', 'advice',
]);
// Everything allowed to surround the ask. A message with ANY word outside
// these two sets has content of its own ("help me install purple") and
// belongs to the model, not here.
const HELP_FILLER = new Set([
  'i', 'im', 'a', 'an', 'the', 'some', 'any', 'bit', 'of', 'my', 'me', 'us', 'we',
  'need', 'needs', 'needed', 'want', 'wanted', 'require', 'required', 'looking',
  'for', 'with', 'please', 'pls', 'plz', 'can', 'could', 'would', 'you', 'u',
  'someone', 'somebody', 'anyone', 'any1', 'anybody', 'give', 'got', 'have',
  'here', 'there', 'mate', 'bro', 'sir', 'pal', 'urgent', 'urgently', 'asap',
  'quick', 'quickly', 'bud', 'buddy', 'hi', 'hey', 'hello', 'yo', 'to', 'is',
  'bit', 'able', 'free', 'spare', 'minute', 'sec', 'second', 'there',
  'm', 's', 're', 'd', 'll',
  // Typed on a phone, in a hurry: "nee help plz".
  'nee', 'ned', 'neeed', 'wnt', 'wud', 'cud', 'u', 'ur', 'abit',
]);

function looksLikeHelpRequest(text) {
  const w = plainWords(text);
  if (!w.length || w.length > 7) return false;
  if (!w.some((x) => HELP_WORDS.has(x))) return false;
  // Said what's wrong — the model answers that far better than "what's up?".
  // Deliberately NOT gated on a scope signal: the every() test below already
  // guarantees nothing but help words and filler, so the only thing that can
  // raise a scope signal here is the word "support" itself — and "need
  // support" is precisely the message this exists to catch.
  if (looksLikeProblem(text)) return false;
  return w.every((x) => HELP_WORDS.has(x) || HELP_FILLER.has(x));
}

// Abuse and giving up. Both arrived as content-free messages with no scope
// signal, so both got banter or the brush-off: the bot answered "Cunt" with
// a cheery line about where it shines, and "Balls to it" — a customer walking
// out — with the same. Neither is recoverable by a model that has nothing to
// work with, and a customer swearing at the bot is the moment a human is
// worth most. Deliberately strict: anything with content of its own ("fuck
// this purple app won't load") is a problem report and must reach the model.
const ABUSE_WORDS = new Set([
  'cunt', 'cunts', 'prick', 'pricks', 'dickhead', 'dickheads', 'wanker',
  'wankers', 'knob', 'knobhead', 'bellend', 'twat', 'twats', 'tosser',
  'arsehole', 'asshole', 'bastard', 'bastards', 'idiot', 'idiots', 'moron',
  'morons', 'muppet', 'clown', 'useless', 'garbage', 'rubbish', 'crap',
  'shit', 'shite', 'shat', 'stupid', 'thick', 'dumb', 'pathetic', 'joke',
  // A bare "ffs" or "wtf" is the whole message and means the same thing.
  // Carrying content ("wtf is wrong with bbc1") fails the strict test below
  // and reaches the model as the question it is.
  'ffs', 'wtf', 'fs',
]);
// Walking away. Scored separately from abuse only so the admin alert can say
// which it was — they get the same reply.
// "Cancel my subscription" is deliberately NOT here. It is a real request
// with a real answer, and answering it with "sorry, I'm not getting this
// right — tell me what's not working" would be gibberish.
const GIVING_UP_RE = /\b(?:balls to (?:it|this|that)|(?:fuck|fuk|fck|screw|sack) (?:it|this|that)|forget (?:it|this|that)|can'?t be (?:arsed|bothered)|cba\b|waste of (?:time|money)|wasting my time|i'?m done|im done|done with (?:this|it)|giv(?:e|ing) up|had enough|packing (?:it|this) in|not worth it|not (?:waiting|hanging about|sitting here)|sort it out|sort this out|do something|get it sorted|fix it then)\b/i;
const ABUSE_FILLER = new Set([
  'you', 'youre', 'your', 'ur', 'u', 'this', 'that', 'it', 'its', 'is', 'are',
  'am', 'a', 'an', 'the', 'what', 'whats', 'bloody', 'absolute', 'absolutely',
  'fucking', 'fuckin', 'fking', 'effing', 'total', 'totally', 'complete',
  'completely', 'right', 'proper', 'so', 'such', 'bit', 'of', 'load', 'bot',
  'thing', 'ai', 'robot', 'piece', 'junk', 'and', 'off', 'me', 'my', 'for',
  'fuck', 'fck', 'fuk', 'jesus', 'christ', 'god', 'sake', 'mate', 'm8',
  'lads', 'man', 'then', 'all', 'im', 'i', 'to', 'with', 'at', 'now',
  // "im not waiting all night for this" — the words left over once the
  // giving-up phrase is removed still have to be filler, or it does not count.
  'night', 'day', 'for', 'about', 'any', 'more', 'longer', 'here', 'again',
  // "you're" / "it's" split on the apostrophe, so the orphan letters count
  // as filler or the strict test fails on punctuation alone.
  'm', 's', 're', 't', 've', 'll',
]);

function looksLikeFrustration(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  // Carries a symptom: "purple is shit on firestick" is a complaint with
  // something to answer in it. It goes to the model; a canned de-escalation
  // would throw the only useful part of the message away. Anything else with
  // content of its own is caught by the strict word-set tests below — NOT by
  // hasScopeSignal, which is a deliberately loose one-fuzzy-hit test and
  // scored "waste of time" as service vocabulary on the strength of "time".
  if (looksLikeProblem(t)) return null;
  const givingUp = GIVING_UP_RE.test(t);
  // The giving-up phrase itself is removed before the strictness test — what
  // is LEFT has to be filler, or the message has content of its own.
  const w = plainWords(givingUp ? t.replace(GIVING_UP_RE, ' ') : t);
  if (givingUp) {
    return w.every((x) => ABUSE_WORDS.has(x) || ABUSE_FILLER.has(x)) ? 'giving-up' : null;
  }
  if (!w.length || w.length > 6) return null;
  if (!w.some((x) => ABUSE_WORDS.has(x))) return null;
  return w.every((x) => ABUSE_WORDS.has(x) || ABUSE_FILLER.has(x)) ? 'abuse' : null;
}

export const _looksLikeHelpRequest = (t) => looksLikeHelpRequest(t);
export const _looksLikeFrustration = (t) => looksLikeFrustration(t);

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
  // "have/got/could/any" were missing, and people drop the question mark
  // constantly: "have you got tnt sports" read as a statement, which let the
  // pending "which service is that request for?" question swallow it and
  // file TNT Sports as the service the customer is on.
  const starters = /^(how|hows|what|whats|why|when|whens|where|wheres|which|who|whos|can|could|would|should|does|do|did|is|are|was|were|will|have|has|had|got|any|anybody|anyone|any1|am|shall|may|might|help|pls|please)\b/i;
  return starters.test(text.trim());
}

// Support groups mostly post problem STATEMENTS ("buffering on bbc1",
// "purple not working") — treat those as requests for help too.
// Two tiers so general chat can't trigger it: unambiguous problem phrases
// count on their own; generic words ("calm DOWN mate", "the PROBLEM with
// him is...") only count when the message also mentions the service.
const STRONG_PROBLEM =
  /\b(buffer(ing|s)?|freez\w*|frozen|lag(gy|ging|s)?|stutter\w*|glitch\w*|crash\w*|playback|black ?screen|no (sound|audio|picture|video|streams?|channels?|epg|vod)|invalid|unauthori[sz]ed|logged (out|off)|wrong password|access denied|wrong (language|audio|sound|version|copy|cut|file)|(us|american|censored|dubbed) (version|copy|cut)|only (one|1) (language|audio( track)?|track)|not work\w*|(doesnt|don'?t|isn'?t|ain'?t|won'?t|can'?t|stopped)( even| still| ever| really| actually)? work\w*|wont (work|load|play|open|start)|cant (log ?in|sign in|watch|open|play|stream|connect)|keeps? (stopping|buffering|freezing|crashing|cutting|loading)|(is|are|was|were|gone|went|still) down|offline)\b/i;
const WEAK_PROBLEM = /\b(down|error|issues?|problems?|stuck|loading|broken|broke|bust|knackered|useless)\b/i;

// Blunt, whole-message complaints. "Nothing works" and "it's broke" are
// complete problem reports in the way people actually type them, and both
// were landing in the banter path — a customer saying nothing works got
// "Anyway, service stuff is where I shine 😄". They name no app and no
// symptom, so no amount of vocabulary matching was ever going to catch them.
const BLUNT_PROBLEM =
  /\b(?:nothing|nowt|none of it|nothings?|no ?thing)\s+(?:works?|working|loads?|loading|plays?|playing)\b|\b(?:it'?s|its|it is|everything'?s|everythings|all)\s+(?:broke|broken|bust|busted|down|dead|knackered|fucked|buggered)\b|^\s*(?:not working|notworking|no\s*work|doesn'?t work|dont work|won'?t work|not loading|won'?t load|wont load|no signal|no service|dead)\s*[.!]*$/i;

function looksLikeProblem(text) {
  if (STRONG_PROBLEM.test(text) || BLUNT_PROBLEM.test(text)) return true;
  // Listing the fixes they already tried is a problem report by definition —
  // nobody restarts an app four times for fun.
  if (mentionsTriedAlready(text)) return true;
  if (looksLikeSloppyProblem(text)) return true;
  return WEAK_PROBLEM.test(text) && isLikelyInScope(text);
}

// Lead problem answers with the known-issue banner when the admin has set a
// non-operational service status — "invalid user" during a login outage is
// almost certainly the outage, not the user's typo.
function serviceStatusLine(service = null) {
  if (serviceStatusFor(service) === 'operational') return null;
  // Their service's note, not the other one's.
  const note = serviceNotesFor(service).join(' ');
  return `⚠️ We're aware of a service issue right now${note ? ` — ${note}` : ''}. This may be what you're seeing.`;
}

// During a KNOWN outage a problem report does not need the model at all.
// Walking somebody through restarting their box cannot fix a fault on our
// side — the model is already told that and answers in two lines — and an
// outage is exactly when thirty people report at once. Stress test, 25
// simultaneous reports on a node taking 1.2s each: 14 of them got "I'm
// helping a lot of people right now, give me a minute", because the AI queue
// is 8 deep and everything past it is turned away. Answering from code costs
// nothing, cannot queue, and says more than the model would.
// "Is it down?" — the single most asked question during an outage, and the
// one the bot can always answer without the model, from settings it already
// holds. It was out of scope: "is there a known issue", "is everything
// working", "any issues today" and "is it down for everyone" all carry no
// service vocabulary and got "Can't help with that one 😂".
//
// Answered from code on purpose. People ask this when things are broken,
// which is exactly when the AI node is busiest and most likely to be the
// thing that is broken.
const STATUS_QUESTION =
  /\b(?:is|are|anyone else|anybody else)\b[^.?!\n]{0,24}\b(?:it|this|everything|the service|server|servers|streams?|channels?)\b[^.?!\n]{0,16}\b(?:down|out|off|broken|working|up|ok|okay|alright)\b|\bany\s+(?:known\s+)?(?:issues?|problems?|outages?|downtime)\b|\bknown\s+(?:issue|problem|outage)\b|\b(?:service|server)\s+status\b|\bis\s+(?:it|everything|the service)\s+(?:working|ok|okay|alright|fine)\b|\beverything\s+(?:ok|okay|alright|working|down)\b|\bis\s+it\s+just\s+me\b|\bon\s+your\s+end\b|\b(?:any ?one|any ?body)\s+else\b[^.?!\n]{0,20}\b(?:having|getting|seeing|with)\b[^.?!\n]{0,16}\b(?:issues?|problems?|trouble|buffering|this)\b/i;

function looksLikeStatusQuestion(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 140) return false;
  return STATUS_QUESTION.test(t);
}

export const _looksLikeStatusQuestion = (t) => looksLikeStatusQuestion(t);

// What to tell them, for THEIR service.
function statusAnswer(service = null) {
  const status = serviceStatusFor(service);
  if (status !== 'operational') {
    const note = serviceNotesFor(service).join(' ');
    const word = status === 'maintenance' ? 'down for maintenance' : 'having problems';
    return `⚠️ Yes — we know about it. The service is ${word} right now${note ? ` — ${note}` : ''}. `
      + 'No need to reinstall anything or change your settings. We will say here when it is back.';
  }
  return "✅ Nothing reported our end — everything is showing as working right now. "
    + "If it is playing up for you, tell me what you're seeing and which app you're on and I'll sort it.";
}

function knownOutageReply(service = null) {
  const banner = serviceStatusLine(service);
  if (!banner) return null;
  return `${banner}\n\nNo need to reinstall anything or change your settings — it is not something on your end. `
    + 'We are on it and will say here when it is back. Shout if it is still playing up once we have given the all-clear.';
}

// Being spoken to by NAME counts as being spoken to. People do not type
// @Exclusive_Manager_Bot in a group, they type "bot, what channel is it on" —
// and that was landing as ordinary group chatter, so in the default
// questions-only mode (no question mark, no question word, just "bot ...") the
// bot sat there in silence while a customer addressed it directly.
// Anchored to the start, so "I asked the bot earlier" is still just chatter.
const ADDRESSED_BY_NAME = /^\s*(?:hey|hi|hello|oi|yo|ok|okay)?[\s,]*\b(?:bot|bots|robot|assistant)\b[\s,:;!?-]*/i;

function mentionsBot(ctx, text) {
  const username = state.bot.username;
  const t = String(text || '');
  if (username && t.toLowerCase().includes(`@${username.toLowerCase()}`)) return true;
  // The bot's own display name, if it has one worth matching.
  const first = String(state.bot.firstName || '').trim();
  if (first.length >= 4 && new RegExp(`^\\s*${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) return true;
  if (ADDRESSED_BY_NAME.test(t)) return true;
  return ctx.message?.reply_to_message?.from?.id === ctx.me?.id;
}

function onCooldown(userId) {
  const seconds = Number(getSetting('bot.cooldownSeconds')) || 0;
  if (!seconds) return false;
  // Admins are never rate-limited — rapid-fire testing must always answer.
  if (isAdminUser(userId)) return false;
  return Date.now() - (cooldowns.get(userId) || 0) < seconds * 1000;
}

// Is the bot waiting on an answer from this person? The rate limiter exists
// to stop someone firing new questions at the bot, NOT to throw away a reply
// the bot itself asked for. Dropping that is the worst thing it can do: the
// bot asks "which service are you on?", the customer answers, and nothing
// happens — which reads as broken, and leaves them stuck in a dead end with
// no way to tell that a timer did it.
function awaitingReplyFrom(ctx) {
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  return Boolean(
    pendingServiceQuestion.get(key) ||
    pendingUrl.get(key) ||
    pendingVodService.get(key) ||
    pendingVodConfirm.get(key) ||
    getProblemState(ctx.from.id)
  );
}

function bumpCooldown(userId) {
  cooldowns.set(userId, Date.now());
  if (cooldowns.size > 5000) cooldowns.clear();
}

// Does this message actually answer "is it sorted?"
//
// The soft close used to be a catch-all: anything that was not a question, a
// problem report or a recognisably new topic got "shout here if it plays up
// again". That is backwards — it claimed "Hello", "Now", "I want to invite my
// friend", and every fix was another exception bolted onto a rule that was
// wrong in the first place. It now has to look like a reply about the
// problem, and everything else goes to normal answering.
const PROBLEM_REPLY_WORDS = /\b(not|nope|no|havent|haven'?t|hasnt|hasn'?t|didnt|didn'?t|yet|tried|trying|checked|check|watched|watching|working|works|worked|fine|ok|okay|sorted|fixed|done|busy|later|today|tonight|tomorrow|morning|again|same|still|better|worse|good|great|cheers|thanks|ta)\b/i;

function answersIsItSorted(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (looksLikeGreeting(t) || mostlyGreeting(t)) return false;
  if (startsNewTopic(t)) return false;
  return looksLikeAcknowledgement(t) || looksLikeThanks(t) || PROBLEM_REPLY_WORDS.test(t);
}

// Has the customer moved on to something else entirely?
//
// After a case closes, their triage state is re-armed so a late "actually
// it's still broken" escalates straight away. But the check for that was only
// "is it a question, is it a problem" — so "I want to invite my friend to the
// service" was neither, and got answered with "shout here if it stops working
// again", which is nonsense and loses the sale.
//
// Anything that is plainly a fresh request belongs to normal answering.
const NEW_TOPIC_WORDS = /\b(invite|invites|inviting|sign\s?up|signup|join|joining|friend|mate|refer|referral|price|prices|pricing|cost|costs|renew|renewal|subscribe|subscription|buy|order|upgrade|install|download|code)\b/i;

function startsNewTopic(text) {
  return Boolean(
    anyVodRequest(text) ||
    parseAvailabilityQuestion(text) ||
    looksLikeGuideRequest(text) ||
    looksLikeWalletRequest(text) ||
    isUrlRequest(text) ||
    looksLikeChannelQuestion(text) ||
    looksLikeFixtureQuestion(text) ||
    NEW_TOPIC_WORDS.test(String(text || ''))
  );
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

// An admin saying a case is fixed, wherever they happen to say it: "#12 fixed"
// in the group, or just "fixed" as a reply to the alert DM that named it.
// Closing a case is the step that gets skipped when it means opening a web
// panel — the work is done, so the row quietly goes stale instead.
async function handleAdminCaseClose(ctx, text, logId) {
  if (!isAdminUser(ctx.from?.id)) return false;
  if (!looksLikeCaseClose(text)) return false;

  const own = caseNumbersIn(text);
  const replied = caseNumbersIn(ctx.message?.reply_to_message?.text || '');
  let ids = own.length ? own : replied;

  const reply = (msg) => ctx.api.sendMessage(ctx.chat.id, msg, {
    ...(ctx.chat?.type === 'private' ? {} : { reply_parameters: { message_id: ctx.message.message_id } }),
  }).catch(() => {});

  if (!ids.length) {
    // "Close case" with no number said plainly. Falling through sent it to
    // the customer flow, which answered "shout here if it plays up again" —
    // to the admin, about nothing. Only taken over when they actually said
    // "case": a bare "that's fixed now" in conversation still flows past.
    if (!/\bcases?\b/i.test(text)) return false;
    const open = openCaseIds();
    setLogSource(logId, 'case-ambiguous');
    if (!open.length) {
      await reply('No open cases to close. 🎉');
      return true;
    }
    if (open.length > 1) {
      await reply(`${open.length} cases are open — which one? Say "#${open[0]} fixed", or /cases to see them.`);
      return true;
    }
    ids = open; // exactly one open, so there is nothing to disambiguate
  }

  // Replying "fixed" to an alert that listed several cases says nothing about
  // which one — guessing would close someone else's open problem.
  if (!own.length && replied.length > 1) {
    setLogSource(logId, 'case-ambiguous');
    await reply(`That alert covered ${replied.map((n) => `#${n}`).join(', ')} — which one? Say "#${replied[0]} fixed".`);
    return true;
  }

  setLogSource(logId, 'case-closed');
  const lines = [];
  for (const id of ids.slice(0, 10)) lines.push(await closeCaseAsAdmin(id, `tg:${ctx.from.id}`));
  await reply(lines.join('\n'));
  return true;
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
// "I've restarted it 4 times already", "already cleared the cache and
// reinstalled". Someone listing the fixes they have ALREADY tried, which is
// both the most useful message a support bot can receive and the one it
// handled worst: no symptom word and no app name, so it carried no scope
// signal and got "Can't help with that one 😂" in reply to a customer doing
// our troubleshooting for us. It counts as a problem, and the steps named
// here are handed to the model so it stops suggesting them back.
const TRIED_ALREADY =
  /\b(?:i'?ve|ive|i have|already|just)\b[^.?!\n]{0,30}\b(?:restart\w*|reboot\w*|reinstall\w*|re-?install\w*|uninstall\w*|clear\w*|clean\w*|delet\w*|reset\w*|unplug\w*|power ?cycl\w*|log(?:ged)? ?(?:in|out)|sign\w* (?:in|out)|tried|try|changed|swapped|checked)\b|\b(?:restart\w*|reboot\w*|reinstall\w*|clear\w* the cache|logged (?:in|out))\b[^.?!\n]{0,25}\b(?:\d+ times?|twice|loads|already|several times|a few times|and it|but it)\b/i;

function mentionsTriedAlready(text) {
  return TRIED_ALREADY.test(String(text || ''));
}

// The same complaint, typed the way people actually type it on a phone with
// no punctuation. "bbc wun not wrkin", "cnt get in", "my box dont wrk since
// last nite", "wont connct" are all broken-service reports, and every one of
// them was answered with "Anyway — service stuff is where I shine 😄",
// because the vocabulary matcher is looking for words spelled correctly.
//
// Matched structurally rather than from a dictionary of misspellings: a
// negator, then within a few characters a verb that STARTS like work /
// connect / load / open / play / log in. The spelling after the stem does not
// matter, which is the whole point — no list of typos is ever complete.
const SLOPPY_BROKEN = new RegExp(
  String.raw`\b(?:not|no|nt|dont|dnt|don't|doesnt|doesn't|cant|cnt|can't|wont|wnt|won't|isnt|isn't|aint|ain't|hasnt|havent|stopped|stoped|quit|refuses?)\b[^.?!\n]{0,14}` +
  String.raw`\b(?:w[o0]?rk\w*|wrk\w*|wokr\w*|conn?e?c?t\w*|cnnct\w*|lo[ao]?d\w*|op[ae]n\w*|pla[iy]\w*|st[ae]?rt\w*|bo+t\w*|log\s?i?n\w*|sign\s?in\w*|get\s+(?:in|on)\b|in\b|on\b|up\b)`,
  'i'
);
// The verb on its own in a sentence that is plainly a complaint — "its wrkin
// funny", "nowt wrks".
const SLOPPY_VERB = /\b(?:wrkin|wrking|wrkng|wrks|wrk|workin|workng|wokring|connct|connet|conect)\b/i;

function looksLikeSloppyProblem(text) {
  const t = String(text || '');
  if (SLOPPY_BROKEN.test(t)) return true;
  // The bare misspelled verb only counts alongside a negator somewhere, or
  // "wrkin" in "its wrkin great" would be a fault report.
  return SLOPPY_VERB.test(t) && /\b(?:not|no|nt|dont|dnt|cant|cnt|wont|wnt|isnt|aint|stopped|nowt|nothing)\b/i.test(t);
}

function negatesFixes(text) {
  if (mentionsTriedAlready(text)) return true;
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

// The customer's own reference for a report. It only ever appeared in the
// admin digest and /case, so the person who reported it had nothing to quote
// and the admin could not say "that's #12" and be understood. Write {case} in
// the note to place it; without the placeholder it is added on its own line,
// so it works without anyone editing settings.
function caseNumberFor(ctx, st) {
  return st?.caseId
    ?? db.prepare('SELECT id FROM problem_reports WHERE tg_user_id = ? AND resolved = 0 ORDER BY id DESC LIMIT 1')
      .get(ctx.from?.id)?.id
    ?? null;
}

function withCaseNumber(text, caseId, { append = false } = {}) {
  const body = String(text || '');
  // No case to quote: drop the placeholder rather than printing "#{case}".
  if (!caseId) return body.replace(/\s*\(?#?\{case\}\)?/gi, '').trim();
  if (/\{case\}/i.test(body)) return body.replace(/\{case\}/gi, String(caseId));
  // Only the "we have flagged it" note gets the reference added for them. On
  // a note closing a case, "quote this if you come back" is the wrong thing
  // to say, so an admin who wants it there writes {case} where they want it.
  return append && body ? `${body}\nYour reference is #${caseId} — quote that if you come back about it.` : body;
}

// Canned replies pass through the AI reworder so the bot doesn't repeat
// itself word-for-word; the saved setting text is the meaning contract and
// the fallback (AI off/busy/slow/wrong → saved text goes out unchanged).
// Rewording a list mangles it: "installs, logins, buffering fixes, requests"
// came back as "those service stuff bits I excel at". These lines are short,
// deliberate and already in the house voice, so they go out as written.
const VERBATIM_LINES = new Set([
  // The capability message is a bulleted list of what the bot does. Rewording
  // a list mangles it — "installs, logins, buffering fixes, requests" came
  // back as "those service stuff bits I excel at" — and this one is read as a
  // menu, so it stays exactly as written.
  'bot.capabilityMessage',
  // The off-topic brush-off and the steer used to be here too, and they are
  // the two most repeated lines in the whole bot: a customer having a bit of
  // banter got the SAME sentence word for word, twice in a row, which is the
  // definition of sounding canned. They carry no facts and no list worth
  // protecting — just tone — so they are personalised like everything else
  // now. The saved text is still the meaning and the fallback.
  //
  // "Flagged to the team" came back as "You're all set now" — which is not
  // true of a problem nobody has fixed yet. A status line is a statement of
  // fact and must survive intact.
  'bot.problemFlaggedNote', 'bot.problemFollowupNote', 'bot.problemMoreFixesNote',
]);

// `question` is the customer's own message. Passing it turns the rewrite from
// "say this stock line differently" into "say this to THIS person about what
// they just asked", which is the difference between a bot that sounds canned
// and one that doesn't. Omitting it falls back to a plain reword.
async function spoken(key, question = null) {
  const msg = withAdminContact(String(getSetting(key) || '').trim());
  if (!msg) return '';
  return VERBATIM_LINES.has(key) ? msg : rephraseCanned(msg, { question });
}

// Off-topic banter free pass: per user, the FIRST off-topic question in a
// while gets one short friendly AI answer (small-talk mode — no questions
// back); anything more inside the window falls through to the brush-off.
const smallTalkUsed = new Map(); // userId -> timestamp the pass was spent

// Did the banter already point them back at support? Two of these words
// together means it named what we actually do, and the canned steer after it
// is just the same sentence again in a worse voice.
const STEER_WORDS = /\b(install\w*|logins?|log ?in|buffer\w*|playback|stream\w*|channels?|requests?|firestick|android|iphone|device|support|service|account|payments?|renewals?)\b/gi;

function alreadySteers(reply) {
  const hits = new Set((String(reply || '').match(STEER_WORDS) || []).map((w) => w.toLowerCase()));
  return hits.size >= 2;
}

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

  // The customer has sent a password. FIRST, before anything else in here —
  // the embedding call a few lines down would ship the raw text to an
  // external endpoint, and after that it would reach the model, the answer
  // cache, the DM history and the FAQ-draft pipeline.
  // The bot taught them to do this by asking for it; the asking is fixed at
  // the source, but the habit outlives the bug. Nothing on this path repeats
  // the password back — not the warning, not the admin alert.
  if (looksLikeCredentialDump(question)) {
    setLogSource(logId, 'credential-warning');
    const who = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || `id ${ctx.from?.id}`;
    alertAdmins('frustrated', `🔒 ${who} sent what looks like their password in ${isDm ? 'a DM' : 'the group'}. I warned them and did not repeat it — worth changing it for them.`);
    await ctx.api.sendMessage(ctx.chat.id, withAdminContact(CREDENTIAL_WARNING), replyParams).catch(() => {});
    return 'credential-warning';
  }

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
  // A missing vector only drops out of full-AI mode when embeddings have NEVER
  // worked here — not when one call times out. Ollama serves one model at a
  // time, so an embedding queued behind a running generation can fail on a
  // busy node, and treating that as "no embeddings" downgraded a perfectly
  // reachable AI to a canned entry. That is why the same narrow entry fired
  // verbatim at a broad question ("install guide for sky glass plus purple
  // plus tips") over and over, then a properly written answer appeared the
  // moment an embedding got through. Without a vector the model still answers;
  // it just picks its knowledge by keyword instead of by meaning.
  const fullAi = aiReady && (qVec !== null || embeddingsProven());

  // A question about the bot itself, answered from settings — never sent to the
  // model, so it still works when the endpoint is down, which is exactly when
  // a confused user is most likely to ask it.
  if (looksLikeCapabilityQuestion(question)) {
    const msg = String(getSetting('bot.capabilityMessage') || '').trim();
    if (msg) {
      setLogSource(logId, 'capability');
      await ctx.api.sendMessage(ctx.chat.id, withAdminContact(msg), replyParams);
      return 'capability';
    }
  }

  // Which service is this person on? Needed before anything that reads
  // per-service data, and asked for exactly once when it matters.
  const serviceNumber = serviceNumberFor(ctx, question);
  if (serviceNumber === null && serviceAmbiguous() && isServiceSpecific(question) &&
      (channelCount(1) || channelCount(2))) {
    if (await askWhichService(ctx, question,
      'The two services carry different channels, so I want to give you the right answer.', logId, replyParams)) {
      return 'service-ask';
    }
  }

  // "Where do I send it?" is answered from settings, never by the model. A
  // crypto address is the one value here where a single wrong character costs
  // the customer their money with no way back, so it is sent verbatim by code
  // or not at all — and the model's output is scrubbed of anything
  // address-shaped on the way out.
  if (looksLikeWalletRequest(question)) {
    const msg = walletMessage(question);
    if (msg) {
      setLogSource(logId, 'wallet', msg);
      await sendChunked(ctx.api, ctx.chat.id, msg, replyParams);
      return 'wallet';
    }
  }

  // "Can you send me the guide?" is answered by SENDING THE GUIDE. It used to
  // go to the model, which had not been given the guide (title-word matching
  // missed "payment" → "How to pay with crypto") and so pointed the customer
  // at a guides section that does not exist in Telegram, then said it had no
  // access to it. Both were true from where it sat. Nothing here involves the
  // model, so it also works when the endpoint is down.
  if (looksLikeGuideRequest(question)) {
    const historyKey = `${ctx.chat.id}:${ctx.from.id}`;
    const recent = (providedHistory ?? (isDm ? (dmHistory.get(historyKey) || []) : []))
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .reverse();
    const guide = findGuide(question, { context: recent });
    if (guide) {
      setLogSource(logId, 'guide');
      const lead = guideLeadIn(question, guide);
      await sendChunked(ctx.api, ctx.chat.id,
        redactServiceUrls(withAdminContact(`📖 ${guide.title}\n${lead ? `\n${lead}\n` : ''}\n${mdToPlain(guide.body_md)}`)), replyParams);
      return 'guide';
    }
    // Nothing stood out. A menu is a real answer; guessing the wrong guide is
    // not, and neither is telling them to go and look somewhere.
    const all = visibleGuides();
    if (all.length) {
      const kb = new InlineKeyboard();
      all.forEach((g) => kb.text(g.title.slice(0, 40), `guide:${g.id}`).row());
      setLogSource(logId, 'guide');
      await ctx.api.sendMessage(ctx.chat.id, 'Which one do you need?', { ...replyParams, reply_markup: kb });
      return 'guide';
    }
  }

  // A bare "okay" closes the conversation. It is not thanks and it is not a
  // question, so the bot acknowledges it briefly and stops — rather than
  // filling the silence with an offer nobody asked for.
  // The problem-state guard that used to be here was the same mistake as the
  // one on the help-ask branch below: triage has already been offered this
  // message and passed on it, so suppressing the quiet acknowledgement did
  // not hand "ok" to the case thread — it handed it to the model, which
  // answered a one-word "ok" with waffle or the off-topic brush-off. A bare
  // "ok" mid-case means "ok, I'll try that", and silence is the right answer
  // to it; the auto-close sweep follows the case up on its own schedule.
  if (looksLikeAcknowledgement(question)) {
    setLogSource(logId, 'acknowledged');
    return 'acknowledged';
  }

  // Someone saying hello is the first thing a new customer ever does, and
  // brushing that off is the one reply that actually costs money. A greeting
  // carries no "scope signal", so it never reached the model at all — it was
  // filtered out as off-script and got the brush-off on the way past. Checked
  // AFTER the shortcuts above, because "morning, whats the wallet address" is
  // a wallet request wearing a greeting.
  if (mostlyGreeting(question) && !getProblemState(ctx.from?.id)) {
    const hello = await spoken('bot.greetingMessage', question);
    if (hello) {
      setLogSource(logId, 'greeting');
      await ctx.api.sendMessage(ctx.chat.id, hello, replyParams);
      return 'greeting';
    }
  }

  // "Is it down?" — answered from settings, never from the model, so it still
  // works when the AI node is the thing that is down.
  if (looksLikeStatusQuestion(question) && !looksLikeProblem(question)) {
    setLogSource(logId, 'status');
    await ctx.api.sendMessage(ctx.chat.id, statusAnswer(serviceNumberFor(ctx, question)), replyParams).catch(() => {});
    return 'status';
  }

  // Asking for a person. Checked before the scope gate, which had this down
  // as banter — "can I speak to a human" answered with "service stuff is
  // where I shine 😄 Try me!" is the wrong answer to the clearest signal a
  // customer can send. Hand them over, and say so in one line.
  if (looksLikeHumanRequest(question)) {
    const msg = await spoken('bot.humanRequestMessage', question);
    if (msg) {
      setLogSource(logId, 'human-request', msg);
      await ctx.api.sendMessage(ctx.chat.id, msg, replyParams).catch(() => {});
      return 'human-request';
    }
  }

  // "I want to invite my friend." Handled entirely in code, because the model
  // cannot make an invite link and proved what it does instead: it asked the
  // customer for their username AND password, then returned an invented
  // domain with both in the query string. The real link comes from Telegram
  // and the wording is a constant — see invites.js.
  // The VOD parser wins ties: "can you add the friends boxset" is a request
  // for a show, not for a mate. "Friends" is a sitcom as well as a person.
  if (looksLikeInviteRequest(question) && !anyVodRequest(question)) {
    const res = await buildInvite(ctx);
    setLogSource(logId, 'invite');
    await ctx.api.sendMessage(ctx.chat.id,
      res.ok ? res.text : (res.reason === 'no-group' ? INVITE_NO_GROUP : INVITE_NO_PERMISSION),
      replyParams).catch(() => {});
    return 'invite';
  }

  // "I need assistance." Asked for help and nothing more — so ask what's
  // wrong. Before the FAQ matcher and before the scope gate, both of which
  // got this badly wrong: the matcher fuzzy-hit whichever entry shared the
  // word "help", and the scope gate had it down as off-topic banter.
  //
  // Deliberately NOT suppressed when a case is open. It was, copied from the
  // greeting and acknowledgement branches above without checking whether the
  // reasoning carried over — and it does not. Those two mean something
  // specific mid-triage ("ok" = it's sorted), which is why the triage handler
  // wants them. This does not: by the time anything reaches here the triage
  // handler has ALREADY been offered this message and passed on it, so the
  // guard did not hand the reply to the case thread, it handed it to the
  // off-topic brush-off. Live, with a case open from testing, "I need
  // assistance" got "Can't help with that one 😂".
  if (looksLikeHelpRequest(question)) {
    const ask = await spoken('bot.helpAskMessage', question);
    if (ask) {
      setLogSource(logId, 'help-ask');
      // With a case already open, "I need assistance" is ambiguous — same
      // problem or a new one? Name the open one so their answer lands in the
      // right place instead of starting a second thread about the same fault.
      const open = getProblemState(ctx.from?.id);
      const about = String(open?.firstText || '').trim().slice(0, 70);
      const msg = about ? `${ask}\n\n(If it's still about "${about}", just say so and I'll pick that back up.)` : ask;
      await ctx.api.sendMessage(ctx.chat.id, msg, replyParams);
      return 'help-ask';
    }
  }

  // Swearing at the bot, or giving up on it. There is nothing here for the
  // model to answer, and the two replies it used to get — banter, or "can't
  // help with that one 😂" — are the worst available. One warm line that
  // offers a human, and the admin is told, because this is a customer with
  // one foot out of the door and no case number to find them by.
  // Only when the bot is being spoken to: two members swearing at each other
  // in the group is not the bot's business.
  const upset = looksLikeFrustration(question);
  if (upset && (isDm || directed)) {
    const who = ctx.from?.username ? `@${ctx.from.username}`
      : [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || `id ${ctx.from?.id}`;
    alertAdmins('frustrated', `${upset === 'giving-up' ? '🚪' : '😤'} ${who} ${upset === 'giving-up' ? 'is giving up' : 'is not happy'} in ${isDm ? 'a DM' : 'the group'}: "${String(question).slice(0, 200)}" — worth a personal message.`);
    const msg = await spoken('bot.frustrationMessage', question);
    if (msg) {
      setLogSource(logId, 'frustrated', msg);
      await ctx.api.sendMessage(ctx.chat.id, msg, replyParams).catch(() => {});
      return 'frustrated';
    }
    return 'frustrated';
  }

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
      // Outside the try, so the finally that clears it can see it.
      let stopTyping = null;
      try {
        const historyKey = `${ctx.chat.id}:${ctx.from.id}`;
        const history = providedHistory ?? (isDm ? (dmHistory.get(historyKey) || []) : []);
        // A problem report, an FAQ near-miss, or plain app/device vocabulary
        // means we already KNOW this is on-topic — stop the model bailing to
        // OFFTOPIC on legit questions (e.g. "how do I enable developer options").
        // A channel or fixture question is in scope by definition — it is
        // asking about our own lineup. Without this the model was free to
        // call "what's on ITV 2" off-topic whenever it had no listings to
        // hand, and the customer got the banter brush-off for a perfectly
        // ordinary question about the service.
        // A scores or standings question is in scope by definition — it is
        // about the sport they pay us to watch, and the model must not be
        // free to call it off-topic.
        const sportsQuestion = sportsEnabled() && looksLikeSportsQuestion(question);
        const assumeOnTopic = forceOnTopic || looksLikeProblem(question) || Boolean(result.nearMiss)
          || isLikelyInScope(question) || isServiceSpecific(question) || sportsQuestion;
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
        // Whether the model actually got a say. Off-topic and "can't answer"
        // are both the MODEL'S verdict; with it unreachable the bot is
        // guessing, and must not dress a guess up as a judgement. Seeded from
        // the circuit so a message filtered out before the call (no scope
        // signal, no history) is treated the same as one the call failed on —
        // both reached a verdict the model never gave.
        let aiUnavailable = circuitOpen(String(getSetting('ai.baseUrl') || '').replace(/\/+$/, ''));
        if (!offScript) {
          // Telegram's typing indicator lasts about five seconds. This node
          // needs thirty to a hundred and eighty to write an answer, and with
          // ai.maxConcurrent at 1 a second question waits for the first to
          // finish — so the customer watched the indicator disappear and then
          // got nothing at all. Live transcript: "I want sky glass code" was
          // answered, "How do I install it" went silent, "Hello?" came back
          // instantly a minute later (canned reply, no model) and the next
          // install question went silent too. Nothing was broken; the bot
          // simply had no way of saying "still writing".
          //
          // Kept alive for the whole call so a slow node looks like someone
          // typing instead of a dead bot. Cleared in the finally below —
          // every path out of here has to stop it, including a throw.
          const typing = () => ctx.replyWithChatAction?.('typing')?.catch?.(() => {});
          await typing();
          stopTyping = setInterval(typing, 4000);
          // Never hold the process open on an interval nobody cleared.
          stopTyping.unref?.();
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
          // They have told us what they already tried. Handing that to the
          // model as an instruction is the difference between an answer and
          // an insult: "I've restarted it 4 times" answered with "try
          // restarting it" is the single fastest way to lose someone.
          const alreadyTried = mentionsTriedAlready(question);

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
            // "What channel is the F1 on?" is about OUR lineup, so it is
            // answerable from the panel the service runs on — and only from
            // there. Fetched per question rather than held in the prompt: the
            // lineup is thousands of channels and the model needs the few
            // that answer this one.
            // "Who's playing Derby tonight?" names no channel, so it never
            // looked like a channel question — and the bot had to say it has
            // no fixtures. The downloaded guide answers it, so the fixture
            // phrasings get the same grounding.
            //
            // Grounded against THEIR service: the two lineups differ, and
            // answering everybody from service 1 is not a neutral default, it
            // is telling half the customers something untrue about their own
            // service. serviceNumber is resolved (or asked for) further up.
            const channels = isServiceSpecific(question)
              ? await channelGrounding(question, { service: serviceNumber || 1 }).catch(() => null)
              : null;
            // The real classification, table or scoreline. Fetched per
            // question and cached, same as the lineup: there is no point
            // holding a league table in the prompt for someone asking how to
            // install an app.
            const sports = sportsQuestion
              ? await sportsGrounding(question).catch(() => null)
              : null;
            // Nothing cached matches what they asked. Answering that from code
            // rather than asking the model to is the whole point: handed an
            // empty block it either invents a channel or, as it did in the
            // group, reads its own brief out at the customer.
            // Only when we HAVE a lineup and nothing in it matches — that is
            // a real "we do not carry that". With nothing cached at all the
            // model still gets its go, as before.
            // ...unless we DID find the answer somewhere else. "Who won the
            // F1" matches no channel in the lineup, and without this it got
            // "I don't have a listing for that" while the real classification
            // sat ready in the next variable along.
            //
            // And only for questions actually about the LINEUP. The message
            // says "give me the channel name and I'll look it up", which is
            // the wrong answer to "is Mobland on exclusive?" — that is a show,
            // not a channel, and isServiceSpecific says yes to anything that
            // merely names a service. Live, that is exactly what happened.
            const aboutTheLineup = looksLikeChannelQuestion(question) || looksLikeFixtureQuestion(question);
            if (!sports && aboutTheLineup && !anyVodRequest(question) && !parseAvailabilityQuestion(question)
                && isServiceSpecific(question) && !channels && channelCount(serviceNumber || 1) > 0) {
              const noListing = withAdminContact(String(getSetting('bot.noListingMessage') || '').trim());
              if (noListing) {
                setLogSource(logId, 'no-listing', noListing);
                await ctx.api.sendMessage(ctx.chat.id, withSuffix(noListing), replyParams).catch(() => {});
                return 'no-listing';
              }
            }
            try {
              reply = await askAi(question, {
                history, assumeOnTopic, playback, grounding, secondRound: deepen, channels,
                // Their service, so a note that is only true for the OTHER
                // one never reaches them as if it were their problem.
                service: serviceNumber,
                // The banner above already said "we know". Walking someone
                // through restarting their box cannot fix a fault on our side,
                // and asking them to is a waste of their evening.
                knownOutage: Boolean(prefix) && getSetting('service.status') !== 'operational' && looksLikeProblem(question),
                knowledgeFaqs: retrieved.length ? retrieved.map((r) => r.faq) : null,
                alreadyTried,
                sports,
              });
            } catch (err) {
              // An unreachable endpoint must NOT skip the near-miss FAQ below.
              // It used to: the fallback sits after this call inside the same
              // try, so any throw jumped straight past it to "I couldn't
              // answer that" — while a perfectly good FAQ sat unused. Busy and
              // timeout keep their own handling, which tells the user plainly
              // that the bot is overloaded rather than guessing at an answer.
              if (err.code === 'AI_BUSY' || err.code === 'AI_TIMEOUT') throw err;
              console.error('AI error:', err.message);
              state.bot.lastError = `AI: ${String(err.message).slice(0, 280)}`;
              aiUnavailable = true;
              reply = null;
            }
            // A SECOND round that offers nothing to act on must not be sent.
            // The customer has just said the first fixes did not work; being
            // told "give it a shot and reply if it still doesn't work" repeats
            // what they already tried and loops them. Dropping it here makes
            // the caller escalate to a human, which is what they need.
            if (reply && deepen && offersNoNewHelp(reply)) {
              setLogSource(logId, 'no-new-help');
              return 'no-new-help';
            }
            // Saying the same thing again is not an answer. The customer has
            // already read it, and repeating it is what makes a bot feel like
            // a wall — it is the complaint that started this whole build.
            //
            // In TRIAGE the caller takes it from here: 'no-new-help' is its
            // signal to stop suggesting fixes and escalate. In an ordinary
            // conversation there is no caller to catch it, and returning here
            // sent the customer nothing at all — a question answered with
            // total silence, which reads as the bot ignoring them. So outside
            // triage it hands over to a human instead of just going quiet.
            const lastSaid = [...history].reverse().find((m) => m.role === 'assistant')?.content;
            if (reply && lastSaid && repeatsPreviousAnswer(reply, lastSaid)) {
              setLogSource(logId, 'no-new-help');
              // Only `deepen` has a caller that catches this and escalates.
              // Gating on "no case open" instead left an angry customer's
              // "sort it out" answered with nothing at all, mid-case, which
              // is the worst moment to go quiet.
              if (!deepen) {
                const msg = await spoken('bot.unsureMessage', question);
                if (msg) await ctx.api.sendMessage(ctx.chat.id, withSuffix(msg), replyParams).catch(() => {});
              }
              return 'no-new-help';
            }
            // Judged on what the answer was actually BUILT from, not on what
            // the question looked like. The question-shape tests are
            // deliberately loose — looksLikeChannelQuestion says yes to "which
            // app should I use on Firestick" — so using them here would stop
            // perfectly stable answers being cached at all. An answer written
            // from live data is never stored, so a stale one can never be
            // served: "who won the F1" would otherwise still be naming last
            // month's winner a month later, with total confidence.
            if (reply && canCache && !sports && !channels) {
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

        // The model refused or could not be reached, but knowledge covers this
        // — answer from it rather than saying nothing. A STRONG match counts
        // too, not just a near-miss: in full-AI mode the canned branch above
        // is skipped, so without this an unreachable model would throw away a
        // dead-on entry and reply "I couldn't answer that".
        const standIn = result.match || result.nearMiss;
        if (standIn) {
          db.prepare('UPDATE faqs SET hit_count = hit_count + 1 WHERE id = ?').run(standIn.id);
          const standInText = withAdminContact(redactServiceUrls(standIn.answer));
          setLogSource(logId, 'faq', standInText);
          recordUnanswered(question, ctx, 'ai-refused', standIn.id);
          const sent = await sendChunked(ctx.api, ctx.chat.id, withSuffix(standInText), {
            ...replyParams,
            reply_markup: feedbackKeyboard(),
          });
          if (sent) rememberReply(ctx.chat.id, sent.message_id, { question, faqId: standIn.id, source: 'faq' });
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
            // A channel question that produced nothing usable has a better
            // answer than "I'm not sure": we know what the question was about
            // and we know we have no listing for it. This is also where a
            // reply gets to after being suppressed for reciting the brief —
            // the customer must still get something that helps.
            const noListing = !aiUnavailable && isServiceSpecific(question)
              ? withAdminContact(String(getSetting('bot.noListingMessage') || '').trim())
              : '';
            const msg = noListing || await spoken(aiUnavailable ? 'bot.aiDownMessage' : 'bot.unsureMessage');
            if (msg) await ctx.api.sendMessage(ctx.chat.id, msg, replyParams);
          }
          return aiUnavailable ? 'ai-down' : 'unsure';
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
        // Scope is the model's call. Unreachable means the bot cannot tell an
        // off-topic message from a support question it simply has no FAQ for —
        // and "I need the sky glass code" being called off-topic is the worst
        // possible answer. Say what is actually wrong instead.
        if (aiUnavailable && (isDm || directed)) {
          setLogSource(logId, 'ai-down');
          recordUnanswered(question, ctx, 'ai-refused', null);
          const msg = await spoken('bot.aiDownMessage', question);
          if (msg) await ctx.api.sendMessage(ctx.chat.id, msg, replyParams);
          return 'ai-down';
        }
        if (getSetting('bot.offtopicBehavior') === 'redirect' && (isDm || directed)) {
          // Banter budget: the FIRST off-topic question in a while gets one
          // short friendly answer; the next inside the window gets the witty
          // brush-off with no AI call. Fun once, chat buddy never.
          const banter = await maybeSmallTalk(ctx, question);
          if (banter) {
            setLogSource(logId, 'smalltalk');
            // Steer back to support after banter — an admin-editable line
            // appended in code, never left to the model.
            //
            // Skipped when the banter already did the steering. Live, in the
            // group: "Bot give everyone a brief overview what you can do" was
            // answered with a perfectly good paragraph about installs,
            // playback and devices, and then had "Anyway — service stuff is
            // where I shine 😄 installs, logins, buffering fixes" stapled to
            // it. Two messages saying the same thing, the second one canned,
            // in front of everybody. If the answer already named what we do,
            // repeating it is not a steer, it is a stammer.
            const steer = alreadySteers(banter) ? '' : await spoken('bot.smallTalkSteer', question);
            await ctx.api.sendMessage(ctx.chat.id, steer ? `${banter}\n\n${steer}` : banter, replyParams);
            return 'smalltalk';
          }
          setLogSource(logId, 'offtopic');
          const msg = await spoken('bot.offtopicMessage', question);
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
          // A PROBLEM report that cannot get a slot must not be told to send
          // it again. We already have it — it is in problem_reports with a
          // case number — and asking the customer to repeat themselves during
          // a surge adds load at the exact moment there is none to spare.
          // Stress test, 25 simultaneous reports with auto-degradation off:
          // 16 of them hit this, and every one was invited to re-send.
          // Flag it to a human instead; that is what they wanted anyway.
          // Precisely "we already have this on file" — an open case row, or
          // live triage state. looksLikeProblem() alone was too loose: "what
          // does error 403 in the app mean?" is a question with the word
          // error in it, not a fault we are holding, and telling someone
          // that is logged and flagged would be a lie.
          const row = db.prepare('SELECT id FROM problem_reports WHERE tg_user_id = ? AND resolved = 0 ORDER BY id DESC LIMIT 1').get(ctx.from.id);
          if (row || getProblemState(ctx.from?.id)) {
            db.prepare('UPDATE problem_reports SET escalated = 1 WHERE tg_user_id = ? AND resolved = 0').run(ctx.from.id);
            setProblemState(ctx.from.id, { at: Date.now(), escalatedAt: Date.now() });
            queueProblemAlert({
              id: row?.id,
              tg_user: ctx.from?.username || ctx.from?.first_name,
              tg_user_id: ctx.from?.id,
              text: question,
              topic: extractProblemTopic(question),
            });
            const note = withAdminContact(String(getSetting('bot.busyProblemMessage') || '').trim());
            if (note) {
              await ctx.api.sendMessage(ctx.chat.id, withCaseNumber(note, row?.id), replyParams).catch(() => {});
            }
            return 'escalated';
          }
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
      } finally {
        // Every way out of the block above — the early returns for no-listing
        // and no-new-help, a thrown AI error, or an ordinary answer — has to
        // stop the typing keepalive, or it ticks forever against a chat
        // nobody is waiting on.
        if (stopTyping) { clearInterval(stopTyping); stopTyping = null; }
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
    const tail = circuitOpen(String(getSetting('ai.baseUrl') || '').replace(/\/+$/, ''))
      ? withAdminContact(String(getSetting('bot.aiDownMessage') || ''))
      : withAdminContact("I couldn't answer that one — {admin} and they'll help you personally.");
    if (tail) await ctx.api.sendMessage(ctx.chat.id, tail);
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

  // Before anything else: an admin closing a case.
  if (await handleAdminCaseClose(ctx, text, logId)) return;

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
  if (await handleServiceReply(ctx, text, logId, groupReplyParams)) return;
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
    const asking = parseAvailabilityQuestion(text);
    if (asking) {
      setLogSource(logId, 'vod-request');
      await sendAvailability(ctx, await answerAvailability(ctx, asking, text), groupReplyParams);
      return;
    }
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
      const msg = await spoken('bot.greetingMessage', text);
      if (msg) await ctx.api.sendMessage(ctx.chat.id, msg, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
      return;
    }
    if (looksLikeThanks(question)) {
      setLogSource(logId, 'thanks');
      const msg = await spoken('bot.thanksMessage', text);
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
  let reporterService = null;
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
    const msg = await spoken('bot.thanksMessage', text);
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
    const note = withCaseNumber(await spoken('bot.problemResolvedNote', text), caseNumberFor(ctx, st));
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
  // A POSITIVE match, as in the DM path: the question asked for a service
  // name or a username, so only one of those answers it. As a catch-all this
  // recorded "ok", "fuck this" and "i told you ive done that" as the service
  // the fault is on, and told the admin so.
  const serviceAnswer = st?.awaitingService ? serviceAnswerIn(text) : null;
  if (st?.awaitingService && serviceAnswer) {
    setProblemState(ctx.from.id, { awaitingService: false, at: Date.now() });
    const info = serviceAnswer;
    db.prepare('UPDATE problem_reports SET service = ? WHERE tg_user_id = ? AND escalated = 1 AND resolved = 0')
      .run(info, ctx.from.id);
    setLogSource(logId, 'service-info');
    if (getSetting('reports.alertProblems')) {
      hub.notifyAdmins(`↳ @${ctx.from?.username || ctx.from?.first_name} says the escalated problem is on: "${info}"`).catch(() => {});
    }
    await ctx.api.sendMessage(ctx.chat.id, '👍 Passed that along to the team.', { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
    return;
  }

  // Same as the DM path: a customer giving up mid-case goes to a human
  // immediately, not through another round of fixes.
  const upset = st ? looksLikeFrustration(text) : null;
  if (upset && !alreadyEscalated) {
    const who = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || `id ${ctx.from.id}`;
    const ref = caseNumberFor(ctx, st);
    alertAdmins('frustrated', `${upset === 'giving-up' ? '🚪' : '😤'} ${who} ${upset === 'giving-up' ? 'is giving up on' : 'is fed up with'} an open problem${ref ? ` (#${ref})` : ''} in the group: "${String(text).slice(0, 200)}" — about: "${String(st.firstText || '').slice(0, 160)}". Worth a personal message.`);
  }

  let isConfirmation = false;
  if (!alreadyEscalated) {
    if (st) {
      isConfirmation =
        isProblem ||
        saysStillBroken(text) ||
        negatesFixes(text) ||
        hasTimeDetail(text) ||
        Boolean(upset) ||
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
      tooQuick && !st.nudgedAt && !upset &&
      !negatesFixes(text) && !hasTimeDetail(text) &&
      // A wrong/faulty copy has no fixes that "take minutes to try" — the
      // quick-confirm pushback would be nonsense there.
      !isContentIssue(st?.firstText || text) &&
      getSetting('service.status') === 'operational'
    ) {
      setProblemState(ctx.from.id, { at: Date.now(), nudgedAt: Date.now() });
      setLogSource(logId, 'nudged');
      const nudge = await spoken('bot.problemNudgeMessage', text);
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
    if ((st?.fixRounds || 1) < maxRounds && !st?.fromAutoClose && !upset && getSetting('service.status') === 'operational'
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
      id: st?.caseId ?? db.prepare('SELECT id FROM problem_reports WHERE tg_user_id = ? AND resolved = 0 ORDER BY id DESC LIMIT 1').get(ctx.from.id)?.id,
      tg_user: ctx.from?.username || ctx.from?.first_name,
      tg_user_id: ctx.from?.id,
      text: alertText,
      topic: extractProblemTopic(st?.firstText || '') || extractProblemTopic(text),
    });
    setLogSource(logId, 'escalated');
    const ack = withCaseNumber(await spoken('bot.problemFlaggedNote'), caseNumberFor(ctx, st), { append: true });
    // Ask which service it's on — the answer goes to the admins too.
    // (Kept verbatim: it's an instruction, and it must stay a question.)
    const serviceQ = getSetting('bot.problemServiceQuestion');
    // Leading a fed-up customer with "✅ Flagged to the team" is tone-deaf.
    const sorry = upset ? "Sorry it's been a pain 😔" : '';
    const ackFull = [sorry, ack, serviceQ].filter(Boolean).join('\n');
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
  if (st?.fromAutoClose && isFollowUp && !looksLikeQuestion(text) && answersIsItSorted(text)) {
    setLogSource(logId, 'soft-close');
    const msg = await spoken('bot.problemSoftCloseMessage', text);
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
    // Which service they are on, resolved the same way every other
    // service-specific answer resolves it. Stored with the report so
    // degradation is judged per service instead of pooling both.
    reporterService = serviceNumberFor(ctx, text);
    problemId = recordProblem(ctx, text, { answered: false, service: reporterService });
    setProblemState(ctx.from.id, { caseId: problemId, topic: extractProblemTopic(text) });
    problemSuffix = followupNoteForRound(1);
    // Outage/degradation check BEFORE building the banner: the report that
    // tips the threshold gets the known-issue banner on its own answer.
    checkOutage();
    problemPrefix = serviceStatusLine(reporterService);
  }

  if (!shouldAnswer) return;

  // Cooldown drops are stamped in the log — a silently ignored question is
  // indistinguishable from a bug without this.
  if (!awaitingReplyFrom(ctx) && onCooldown(ctx.from.id)) {
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
  // A known outage is answered from code, not the model: it is the better
  // answer AND it is the moment the queue is under most pressure.
  const outageNow = problemId && knownOutageReply(reporterService);
  if (outageNow) {
    setLogSource(logId, 'known-outage', outageNow);
    await ctx.api.sendMessage(ctx.chat.id, outageNow, { reply_parameters: { message_id: ctx.message.message_id } }).catch(() => {});
    setProblemState(ctx.from.id, { at: Date.now(), answeredAt: Date.now() });
    return;
  }

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
    const msg = await spoken('bot.thanksMessage', text);
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
    const note = withCaseNumber(await spoken('bot.problemResolvedNote', text), caseNumberFor(ctx, st));
    if (note) await send(note);
    return true;
  }

  // Giving up, or swearing at the bot, with a case already open. More
  // troubleshooting is the one thing they have just told us they do not want,
  // so this skips the "have you actually tried it yet?" pushback AND the
  // second round of fixes and goes straight to a human — and the admin is
  // told at once rather than in the next batch, because this is the customer
  // who cancels tonight.
  //
  // Above the which-service question on purpose: that branch takes ANY reply
  // that is not a question or a problem, so "fuck this" was being filed as
  // the service the fault is on and DMed to the admin as "says the escalated
  // problem is on: fuck this".
  const upset = looksLikeFrustration(text);

  // Which-service answer for an escalated report.
  //
  // A POSITIVE match, not "anything that isn't a question". That exclusion
  // list grew an entry every time this branch ate something it shouldn't —
  // "ok", "fuck this", "i told you ive done that" were each filed as the
  // service the fault is on and DMed to the admin as fact. The question asked
  // for a service name or a username, so nothing but one of those answers it;
  // anything else falls through to normal handling with the ask still armed.
  const namedService = st.awaitingService ? serviceAnswerIn(text) : null;
  if (st.awaitingService && namedService) {
    setProblemState(ctx.from.id, { awaitingService: false, at: Date.now() });
    const info = namedService;
    db.prepare('UPDATE problem_reports SET service = ? WHERE tg_user_id = ? AND escalated = 1 AND resolved = 0')
      .run(info, ctx.from.id);
    setLogSource(logId, 'service-info');
    if (getSetting('reports.alertProblems')) {
      hub.notifyAdmins(`↳ @${ctx.from?.username || ctx.from?.first_name} says the escalated problem is on: "${info}"`).catch(() => {});
    }
    await send('👍 Passed that along to the team.');
    return true;
  }

  if (upset && !alreadyEscalated) {
    const who = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || `id ${ctx.from.id}`;
    const ref = caseNumberFor(ctx, st);
    alertAdmins('frustrated', `${upset === 'giving-up' ? '🚪' : '😤'} ${who} ${upset === 'giving-up' ? 'is giving up on' : 'is fed up with'} an open problem${ref ? ` (#${ref})` : ''}: "${String(text).slice(0, 200)}" — about: "${String(st.firstText || '').slice(0, 160)}". Worth a personal message.`);
  }

  let isConfirmation = false;
  if (!alreadyEscalated) {
    const shortAffirm =
      /^\s*(yes|yeah|yep|yup|aye|i (have|did)|did (that|them|it)|done (that|them|it|all)|tried)/i.test(text) &&
      text.trim().split(/\s+/).length <= 8;
    isConfirmation =
      isProblem || saysStillBroken(text) || negatesFixes(text) || hasTimeDetail(text) ||
      Boolean(upset) ||
      (shortAffirm && !st.fromAutoClose);
  }

  if (isConfirmation) {
    // Same physics check as the group: an instant "Yes" gets one pushback.
    const nudgeMinutes = Number(getSetting('bot.problemNudgeMinutes')) || 0;
    const sinceAnswer = st.answeredAt ? Date.now() - st.answeredAt : null;
    const tooQuick = nudgeMinutes > 0 && sinceAnswer !== null && sinceAnswer < nudgeMinutes * 60000;
    if (
      tooQuick && !st.nudgedAt && !upset &&
      !negatesFixes(text) && !hasTimeDetail(text) &&
      // A wrong/faulty copy has no fixes that "take minutes to try" — the
      // quick-confirm pushback would be nonsense there.
      !isContentIssue(st?.firstText || text) &&
      getSetting('service.status') === 'operational'
    ) {
      setProblemState(ctx.from.id, { at: Date.now(), nudgedAt: Date.now() });
      setLogSource(logId, 'nudged');
      const nudge = await spoken('bot.problemNudgeMessage', text);
      if (nudge) await send(nudge);
      return true;
    }

    // Same second-round triage as the group before flagging (DM history
    // gives the model the earlier fixes, so round two is genuinely new).
    const maxRounds = Math.max(1, Math.min(4, Number(getSetting('bot.problemFixRounds')) || 1));
    if ((st.fixRounds || 1) < maxRounds && !st.fromAutoClose && !upset && getSetting('service.status') === 'operational'
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
      id: st.caseId ?? db.prepare('SELECT id FROM problem_reports WHERE tg_user_id = ? AND resolved = 0 ORDER BY id DESC LIMIT 1').get(ctx.from.id)?.id,
      tg_user: ctx.from?.username || ctx.from?.first_name,
      tg_user_id: ctx.from?.id,
      text: alertText,
      topic: extractProblemTopic(st.firstText || '') || extractProblemTopic(text),
    });
    setLogSource(logId, 'escalated');
    const ack = withCaseNumber(await spoken('bot.problemFlaggedNote'), caseNumberFor(ctx, st), { append: true });
    const serviceQ = getSetting('bot.problemServiceQuestion');
    // Leading a fed-up customer with "✅ Flagged to the team" is tone-deaf.
    // The apology goes first; the status line still follows intact.
    const sorry = upset ? "Sorry it's been a pain 😔" : '';
    const ackFull = [sorry, ack, serviceQ].filter(Boolean).join('\n');
    if (ackFull) await send(ackFull);
    if (serviceQ) setProblemState(ctx.from.id, { awaitingService: true });
    return true;
  }

  // Neutral reply to the auto-close notice — soft close, door open. A fresh
  // request is not that, however neutrally it is phrased, and neither is a
  // message hours later: the re-armed state used to live indefinitely and
  // kept claiming unrelated one-word replies.
  const softCloseFresh = Date.now() - (st.at || 0) < problemWindowMs();
  if (st.fromAutoClose && softCloseFresh && !looksLikeQuestion(text) && !isProblem && answersIsItSorted(text)) {
    setLogSource(logId, 'soft-close');
    const msg = await spoken('bot.problemSoftCloseMessage', text);
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
  if (!awaitingReplyFrom(ctx) && onCooldown(ctx.from.id)) {
    setLogSource(logId, 'cooldown');
    return;
  }
  bumpCooldown(ctx.from.id);

  if (await handleAdminCaseClose(ctx, text, logId)) return;

  // Per-user service URL flow: answer a pending username reply, or start the
  // flow when they ask for a URL — only ever THEIR service's URL.
  if (await handleUrlServiceReply(ctx, text, logId, {})) return;
  if (await handleServiceReply(ctx, text, logId, {})) return;
  if (await handleVodConfirmReply(ctx, text, logId, {})) return;
  if (await handleVodServiceReply(ctx, text, logId, {})) return;
  if (isUrlRequest(text) && await handleUrlRequest(ctx, logId, {})) return;

  // "Request: Title (Year)" works in DMs too.
  {
    const asking = parseAvailabilityQuestion(text);
    if (asking) {
      setLogSource(logId, 'vod-request');
      await sendAvailability(ctx, await answerAvailability(ctx, asking, text), {});
      return;
    }
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
    const msg = await spoken('bot.greetingMessage', text);
    if (msg) await ctx.reply(msg).catch(() => {});
    return;
  }
  if (looksLikeThanks(text)) {
    setLogSource(logId, 'thanks');
    const msg = await spoken('bot.thanksMessage', text);
    if (msg) await ctx.reply(msg).catch(() => {});
    return;
  }

  // First report: record it for the panel, answer with the fixes, and
  // invite the user to confirm — the same fixes-first flow as the group.
  let problemId = null;
  let problemSuffix = null;
  let problemPrefix = null;
  let reporterService = null;
  if (looksLikeProblem(text) && !getProblemState(ctx.from.id)) {
    setProblemState(ctx.from.id, { at: Date.now(), escalatedAt: null, firstText: text.slice(0, 200), fromAutoClose: false });
    // Which service they are on, resolved the same way every other
    // service-specific answer resolves it. Stored with the report so
    // degradation is judged per service instead of pooling both.
    reporterService = serviceNumberFor(ctx, text);
    problemId = recordProblem(ctx, text, { answered: false, service: reporterService });
    setProblemState(ctx.from.id, { caseId: problemId, topic: extractProblemTopic(text) });
    problemSuffix = followupNoteForRound(1);
    checkOutage();
    problemPrefix = serviceStatusLine(reporterService);
  }
  // Same as the group: a known outage is answered from code.
  const dmOutage = problemId && knownOutageReply(reporterService);
  if (dmOutage) {
    setLogSource(logId, 'known-outage', dmOutage);
    await ctx.reply(dmOutage).catch(() => {});
    db.prepare('UPDATE problem_reports SET answered = 1 WHERE id = ?').run(problemId);
    setProblemState(ctx.from.id, { answeredAt: Date.now() });
    return;
  }

  const outcome = await answer(ctx, text, { isDm: true, logId, suffix: problemSuffix, prefix: problemPrefix });
  if (problemId) {
    const gotAnswer = ['faq', 'ai'].includes(outcome);
    db.prepare('UPDATE problem_reports SET answered = ? WHERE id = ?').run(gotAnswer ? 1 : 0, problemId);
    if (gotAnswer) setProblemState(ctx.from.id, { answeredAt: Date.now() });
  }
}
