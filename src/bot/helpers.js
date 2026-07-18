import { db, now } from '../db/db.js';
import { getSetting } from '../settings.js';
import { tokens, tokensMatch } from '../faq/matcher.js';

const TG_MAX = 4096;

function chunkText(text, size = TG_MAX) {
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

// Base support vocabulary — app names, device-setup steps, playback/account
// terms. Used to tell a real (if unanswerable) support question apart from
// genuine off-topic chatter so the bot never brushes off a legit user.
const BASE_SCOPE_TERMS = new Set([
  'app', 'apps', 'purple', 'smarters', 'downloader',
  'firestick', 'fire', 'stick', 'android', 'phone', 'tablet', 'device', 'devices', 'tv',
  'iphone', 'ipad', 'ios', 'apple',
  'install', 'installing', 'installed', 'reinstall', 'update', 'updating', 'version', 'apk', 'sideload',
  'setup', 'settings', 'developer', 'developers', 'options', 'option', 'unknown', 'sources', 'source',
  'enable', 'enabling', 'enabled', 'allow', 'allowing', 'allowed', 'permission', 'permissions', 'blocked',
  'code', 'link', 'download', 'downloads',
  'buffer', 'buffering', 'freeze', 'freezing', 'frozen', 'lag', 'lagging', 'stutter', 'glitch', 'crash', 'crashing',
  'stream', 'streaming', 'streams', 'channel', 'channels', 'vod', 'movie', 'movies', 'film', 'series', 'show',
  'season', 'episode', 'sports', 'sport', 'match', 'game', 'fixture', 'playback', 'black', 'screen',
  'sound', 'audio', 'picture', 'video', 'offline', 'error', 'buffered',
  'language', 'languages', 'subtitles', 'subs', 'track', 'tracks', 'dubbed',
  'login', 'password', 'account', 'subscription', 'renew', 'renewal', 'expire', 'expired', 'expiry',
  'pay', 'payment', 'crypto', 'litecoin', 'ltc', 'bitcoin', 'wallet', 'exodus', 'panel', 'portal',
  'vpn', 'wifi', 'internet', 'connection', 'router', 'ethernet', 'service',
]);

// Rebuilt at most every 30s so admin FAQ/guide edits are reflected without a
// query on every message.
let scopeVocabCache = null;
let scopeVocabAt = 0;
function scopeVocab() {
  if (scopeVocabCache && Date.now() - scopeVocabAt < 30000) return scopeVocabCache;
  const vocab = new Set(BASE_SCOPE_TERMS);
  try {
    for (const r of db.prepare('SELECT keywords, question FROM faqs WHERE enabled = 1').all()) {
      for (const t of tokens(`${r.keywords} ${r.question}`)) vocab.add(t);
    }
    for (const g of db.prepare('SELECT title FROM guides WHERE visible = 1').all()) {
      for (const t of tokens(g.title)) vocab.add(t);
    }
  } catch {
    // tables may not exist yet during first migration — base vocab is enough
  }
  scopeVocabCache = vocab;
  scopeVocabAt = Date.now();
  return scopeVocabCache;
}

// Unambiguous service terms — one of these alone proves the message is about
// the service. Generic words ('match', 'show', 'movie', 'game', 'error'…)
// stay in the weak vocabulary and need a second hit, so "who won the match
// last night" is NOT forced in-scope on a single word.
const STRONG_SCOPE_TERMS = new Set([
  'app', 'apps', 'purple', 'smarters', 'downloader', 'firestick', 'iphone', 'ipad', 'ios', 'apk', 'sideload',
  'install', 'installing', 'installed', 'reinstall', 'vod', 'iptv', 'buffering', 'playback',
  'login', 'password', 'username', 'invalid', 'subscription', 'renew', 'renewal', 'expiry', 'expired',
  'pay', 'payment', 'paying', 'crypto', 'litecoin', 'ltc', 'wallet', 'exodus',
  'vpn', 'router', 'ethernet', 'panel', 'portal', 'developer', 'url',
  'service', 'price', 'prices', 'cost', 'costs', 'trial', 'ufc', 'ppv',
]);

export function isLikelyInScope(text) {
  const vocab = scopeVocab();
  let hits = 0;
  for (const t of new Set(tokens(text))) {
    if (STRONG_SCOPE_TERMS.has(t)) return true;
    if (vocab.has(t)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

// Loosest possible scope check: does the message contain even ONE piece of
// support vocabulary? Fuzzy, so "signed" counts via the "sign" keyword and
// typos still land. Used to decide whether the AI should see a message at
// all — a message with zero vocabulary, no problem signal and no
// conversation context gives the model nothing on-topic to work with.
export function hasScopeSignal(text) {
  const vocab = scopeVocab();
  const toks = new Set(tokens(text));
  for (const t of toks) if (vocab.has(t)) return true;
  for (const t of toks) {
    for (const v of vocab) if (tokensMatch(t, v)) return true;
  }
  return false;
}

// A complaint about ONE title (a broken episode, a movie in the wrong
// language) is a content problem, not a service problem — it must never count
// toward automatic degradation detection, which watches for widespread
// symptoms like buffering or streams not loading.
// A wrong/faulty COPY of a title ("shameless uk is showing the US version"):
// no device or app fix can change the file — these skip troubleshooting
// rounds and go to the admin with the title. "Wrong version of the app" is
// an update problem, not a content one.
export function wrongCopyIssue(text) {
  const t = String(text);
  if (/\b(app|apk|apps|update|updated)\b/i.test(t)) return false;
  return /\b(wrong|us|american|bad|faulty|corrupt|censored|dubbed)\s+(version|copy|cut)\b/i.test(t) || /\bwrong (file|dub)\b/i.test(t);
}

export function isContentIssue(text) {
  return /\b(episode|episodes|season|series|movie|movies|film|films|documentary|s\d{1,2}\s?e\d{1,3})\b/i.test(String(text)) || wrongCopyIssue(text);
}

// LIVE vs VOD matters for the advice given: a live channel cannot be paused
// or rewound, so those fixes must never be suggested for it. Channel-ish and
// event-ish vocabulary marks a report as live playback; a named film/episode
// wins over channel words ("that film on bbc 1" is a VOD-style issue).
export function looksLikeLiveIssue(text) {
  const t = String(text);
  if (isContentIssue(t)) return false;
  return /\b(channels?|live|match|matches|game|fixture|fixtures|kick ?off|ppv|ufc|boxing|f1|racing|footy|football|sports?|news|bbc ?\d?|itv ?\d?|espn|tnt|sky sports)\b/i.test(t);
}

// Best-effort label for a problem report so admin alerts can group them
// ("buffering ×4"). Returns null when nothing recognizable is found.
export function extractProblemTopic(text) {
  const t = String(text).toLowerCase();
  // Specific symptoms win; the generic catch-alls ("keep getting", "wont
  // play") only label a report when nothing better is in the text — they
  // produced junk like "keep getting" as the topic for a playback error.
  const specific = t.match(
    /\b(buffer\w*|freez\w*|frozen|lag\w*|stutter\w*|glitch\w*|crash\w*|black ?screen|playback error|no (?:sound|audio|picture|video)|wrong (?:version|copy|language|audio)|missing episode|offline|error|not work\w*)\b/
  );
  if (specific) return specific[1].replace(/\s+/g, ' ');
  const generic = t.match(/\b(wont \w+|cant \w+|keeps? \w+)\b/);
  return generic ? generic[1].replace(/\s+/g, ' ') : null;
}

// One row per INCIDENT, not per message: while a user has an open recent
// report, further problem messages (the confirmation, extra details) are
// appended to it, so the panel shows the whole story in one entry.
const MERGE_WINDOW_S = 2 * 3600;

export function recordProblem(ctx, text, { answered = false } = {}) {
  const userId = ctx.from?.id ?? null;
  const t = String(text).slice(0, 500);
  if (userId != null) {
    const open = db.prepare(
      'SELECT id, text FROM problem_reports WHERE tg_user_id = ? AND resolved = 0 AND ts > ? ORDER BY id DESC LIMIT 1'
    ).get(userId, now() - MERGE_WINDOW_S);
    if (open) {
      const combined = `${open.text}\n↳ ${t}`.slice(0, 1500);
      db.prepare(
        'UPDATE problem_reports SET text = ?, topic = COALESCE(topic, ?), answered = CASE WHEN ? THEN 1 ELSE answered END WHERE id = ?'
      ).run(combined, extractProblemTopic(text), answered ? 1 : 0, open.id);
      return open.id;
    }
  }
  const info = db.prepare(
    'INSERT INTO problem_reports (chat_id, chat_title, tg_user_id, tg_user, text, topic, answered, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    ctx.chat?.id ?? null,
    ctx.chat?.title ?? null,
    userId,
    ctx.from?.username || ctx.from?.first_name || null,
    t,
    extractProblemTopic(text),
    answered ? 1 : 0,
    now()
  );
  return info.lastInsertRowid;
}
