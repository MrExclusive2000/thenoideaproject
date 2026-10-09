import { db, now } from '../db/db.js';
import { getSetting, withAdminContact } from '../settings.js';
import { tokens, tokensMatch } from '../faq/matcher.js';

export { withAdminContact };

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

// Every message in an allowed chat lands here — members, admins, questions,
// banter alike. `msg` is the raw Telegram message: its id and reply_to id are
// what later turn these flat rows back into threads, so an admin's answer can
// be paired with the question it answered. Text is kept long enough to hold a
// real answer; only runaway pastes get cut.
export function logMessage(chatId, from, text, replySource, msg = null, chatTitle = null) {
  const info = db.prepare(
    'INSERT INTO messages_log (chat_id, chat_title, tg_user_id, tg_username, text, reply_source, tg_msg_id, reply_to_tg_msg_id, is_admin, ts) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    chatId,
    chatTitle,
    from?.id || null,
    from?.username || from?.first_name || null,
    String(text || '').slice(0, 4000),
    replySource,
    msg?.message_id ?? null,
    msg?.reply_to_message?.message_id ?? null,
    from?.id && isAdminUser(from.id) ? 1 : 0,
    now()
  );
  return info.lastInsertRowid;
}

// `replyText` is what the bot actually sent back. Call sites that answer with
// real content pass it; the ones that only classify (cooldown, offtopic) do
// not, and leave the column null.
export function setLogSource(logId, source, replyText = null) {
  if (!logId) return;
  if (replyText == null) {
    db.prepare('UPDATE messages_log SET reply_source = ? WHERE id = ?').run(source, logId);
    return;
  }
  db.prepare('UPDATE messages_log SET reply_source = ?, bot_reply = ? WHERE id = ?')
    .run(source, String(replyText).slice(0, 4000), logId);
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
  // "My sub ran out yesterday" was banter: only the full word "subscription"
  // counted, and nobody types that. It is somebody telling you they want to
  // give you money, and it got "Ha, that one's a bit above my pay grade".
  // "Line" is the trade word for the same thing and was missing too.
  'sub', 'subs', 'line', 'lines', 'expires', 'expiring',
  'pay', 'payment', 'paying', 'crypto', 'litecoin', 'ltc', 'wallet', 'exodus',
  'vpn', 'router', 'ethernet', 'panel', 'portal', 'developer', 'url',
  'service', 'price', 'prices', 'cost', 'costs', 'trial', 'ufc', 'ppv',
  // A refund or cancellation is a real commercial request with a real answer
  // (the admin handles it). It was getting the off-topic brush-off.
  'refund', 'refunds', 'refunded', 'cancel', 'cancelled', 'cancellation', 'chargeback',
  // "What channel is the F1 on?" is a question about OUR lineup, so it is a
  // service question — it was landing out of scope while "who's playing Derby
  // tonight" landed in it, which is exactly backwards.
  'channel', 'channels', 'epg',
]);

// Someone trying to give you money. These are the highest-value messages the
// bot ever receives and they were the worst handled: "how much is it" and
// "what do you charge" carry no support vocabulary at all — no app, no device,
// no symptom — so the scope gate filed them as banter and answered the one
// question a prospective customer always asks with "Can't help with that one
// 😂 I'm strictly service support". "How do I sign up" got silence.
//
// Phrases, not words, because that is how the gap shows up: "how much" is two
// words that mean nothing apart and only one thing together.
const PRESALES_RE =
  /\bhow many\b[^.?!\n]{0,20}\b(?:cost|a month|per month)\b|\bwhat(?:'?s| is| are)?\b[^.?!\n]{0,15}\b(?:the )?(?:price|prices|cost|costs|charge|charges|damage|rate|rates)\b|\bdo (?:you|u|yous|yas)\b[^.?!\n]{0,15}\b(?:charge|cost)\b|\bhow (?:do|can|would) (?:i|we|you)\b[^.?!\n]{0,20}\b(?:sign ?up|signup|join|subscribe|get (?:it|this|started|set ?up|on ?board)|become a member)\b|\b(?:sign ?me ?up|signing up|sign ?up)\b|\bfree trial\b|\btrial\b[^.?!\n]{0,20}\b(?:available|first|before)\b|\b(?:monthly|yearly|annual|3 month|6 month|12 month)\b[^.?!\n]{0,20}\b(?:price|cost|plan|package|sub|subscription|option)\b|\bwhat (?:do|does) (?:it|this|yous?) cost\b|\bhow (?:do|can) (?:i|we) (?:pay|order|buy)\b|\b(?:want|like) to (?:join|subscribe|sign ?up|get (?:a )?(?:sub|subscription|account))\b|\bwhat (?:packages?|plans?|options?|deals?)\b|\bwhat channels (?:do|have) (?:you|yous|u)\b|\bwhat(?:'?s| is)? included\b|\bwhat do (?:you|u|yous|yas|ye) (?:offer|do|provide|sell)\b|\bwhat(?:'?s| is| was)?\s+(?:this|that|it|all this)\b[^.?!\n]{0,20}\b(?:exactly|about|then|service|all about)?\s*$|\bwhat(?:'?s| is)\s+(?:this|the)\s+(?:service|thing|all about)\b|\bwhats this\b|\bwho are (?:you|yous|ye)\b[^.?!\n]{0,15}\b(?:lot|then|exactly)?\s*$|\bwhat (?:devices?|boxes?)\b[^.?!\n]{0,25}\b(?:work|support|use|run|on)\b|\b(?:can|could|will)\s+(?:i|we|you)\s+(?:watch|view|use|run|get|stream)\b[^.?!\n]{0,30}\b(?:on|with)\b|\b(?:does|do|will|would|can|could)\s+(?:it|this|that|they|the app|your app|yours)\s+(?:work|works|run|runs|play|stream)\s+(?:on|with)\b|\bis\s+(?:a|an|the)?\s*[\w ]{2,20}\s+supported\b|(?<!\bto\s)(?<!\bworking\s)\bwork\s+on\s+(?:a|an|my)\b/i;

// "How much" is how most people ask the price, and it is also how they ask
// the price of a pint. It only counts when the message is short enough to be
// about the obvious subject — us — or names something of ours.
const HOW_MUCH = /\bhow much\b|\bwhats? the damage\b/i;
const OURS = /\b(sub|subs|subscription|month|months|monthly|year|yearly|annual|service|package|packages|plan|plans|line|lines|connection|account|channels?|sports?|iptv|it|this)\b/i;

export function looksLikePreSales(text) {
  const t = String(text || '');
  if (PRESALES_RE.test(t)) return true;
  if (HOW_MUCH.test(t)) {
    const words = t.trim().split(/\s+/).length;
    const rest = t.replace(HOW_MUCH, ' ');
    // "how much is it" (4 words) yes; "how much is a pint" no — that needs a
    // word of ours in it to count.
    return words <= 4 || OURS.test(rest);
  }
  return false;
}

// Somebody else's product. "Install", "reinstall" and "update" are strong
// service vocabulary because they are how people ask about OUR app — which
// meant "How do I reinstall Windows 10" was forced in scope and answered with
// a five-step guide to the Media Creation Tool and BIOS boot order. We sell
// streaming, and a customer who follows that advice and wipes their laptop
// did it on our say-so.
const FOREIGN_PRODUCT =
  /\bwindows\s*(?:10|11|7|8|xp|vista)?\b|\bwin\s*(?:10|11)\b|\bmicrosoft\b|\bmac\s?os\b|\bosx\b|\bmacbook\b|\blinux\b|\bubuntu\b|\bchrome\s?os\b|\bchromebook\b|\btelegram\b|\bwhatsapp\b|\bsignal\b|\bfacebook\b|\binstagram\b|\btiktok\b|\bsnapchat\b|\btwitter\b|\bgmail\b|\boutlook\b|\bmicrosoft office\b|\bexcel\b|\bpowerpoint\b|\bphotoshop\b|\bxbox\b|\bplaystation\b|\bps[45]\b|\bnintendo\b|\bsteam\b|\bspotify\b|\bminecraft\b|\broblox\b|\bprinter\b|\bscanner\b|\bbios\b|\buefi\b|\bantivirus\b|\bmcafee\b|\bnorton\b/i;

// Ours. Naming one of these alongside a foreign product means the question is
// still about us — "my Firestick won't talk to my Windows PC" is our problem,
// "how do I reinstall Windows" is not. The watching verbs matter as much as
// the nouns: "can I watch it on my MacBook" is a question about our service
// that happens to name their laptop, and my first version called it foreign.
const OUR_SUBJECT =
  /\bapps?\b|\bpurple\b|\bsmarters\b|\bsky ?glass\b|\bdownloader\b|\bfirestick\b|\bfire ?stick\b|\bfire ?tv\b|\biptv\b|\bvod\b|\bchannels?\b|\bstreams?\b|\bepg\b|\bguide\b|\bbuffer\w*\b|\bplayback\b|\blog ?in\b|\blogin\b|\busername\b|\bsubscription\b|\bservice\b|\bm3u\b|\bplaylist\b|\bsubs(?:cription)?\b|\brenew\w*\b|\bwatch\w*\b|\bview\w*\b|\bcast\b|\bstreaming\b|\bwork(?:s|ing)? (?:on|with)\b|\bsupported\b/i;

export function namesForeignProduct(text) {
  const t = String(text || '');
  if (!FOREIGN_PRODUCT.test(t)) return false;
  // Both named: ours wins, it is a question about using our thing on theirs.
  return !OUR_SUBJECT.test(t);
}

// "I want my money back" contains no service vocabulary whatsoever — no app,
// no symptom, not even the word refund, which IS in the strong list. So it was
// filed as banter, and a customer asking for their money back was answered
// with "Ha, that one's a bit above my pay grade". It is the most expensive
// sentence a customer can type and it needs to reach a human, every time.
const MONEY_BACK =
  /\bmoney back\b|\brefund\w*\b|\bmy money\b|\bcharge ?backs?\b|\bcompensat\w*\b|\bpaid (?:for|up)\b[^.?!\n]{0,25}\b(?:nothing|nowt|no good|not work\w*)\b|\bwant (?:a |my )?(?:refund|money)\b/i;

export function asksForMoneyBack(text) {
  return MONEY_BACK.test(String(text || ''));
}

export function isLikelyInScope(text) {
  // A sales question is in scope by definition — it is about buying the thing
  // this bot exists to support. It is checked BEFORE the foreign-product veto
  // because "can I use it on Windows" names only their product and is still a
  // question about ours: the shape of the question carries the subject.
  if (looksLikePreSales(text)) return true;
  if (asksForMoneyBack(text)) return true;
  if (namesForeignProduct(text)) return false;
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
  if (looksLikePreSales(text)) return true;
  if (asksForMoneyBack(text)) return true;
  if (namesForeignProduct(text)) return false;
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

// A LOGIN failure is not a playback problem and must not be answered like
// one. Live, "Sky glass is saying invalid login" came back with "try a
// different link or stream for the channel, or use the backup app (XC or
// Smarters) with the same login details" — the generic live-stream playbook,
// because nothing had told the model what kind of fault this was. The backup
// app takes the SAME details and refuses them the same way, so that advice
// sends the customer round a loop that cannot work while the real cause (a
// mistyped character, or an expired line) goes unexamined.
export function looksLikeLoginIssue(text) {
  const t = String(text || '');
  return /\binvalid\s+(?:login|log ?in|user|username|password|credentials|details|account|subscription)\b|\b(?:login|log ?in|sign ?in|username|user ?name|password|credentials)\b[^.?!\n]{0,24}\b(?:invalid|incorrect|wrong|rejected|refused|declined|not accepted|failed|failing|expired|not recognis\w*|not recogniz\w*)\b|\b(?:invalid|incorrect|wrong|expired|rejected)\b[^.?!\n]{0,20}\b(?:login|log ?in|user|username|password|credentials|details)\b|\bunauthori[sz]ed\b|\bauthentication (?:failed|error)\b|\bcant (?:log ?in|sign ?in)\b|\bcan'?t (?:log ?in|sign ?in)\b|\bwon'?t let me (?:log ?in|sign ?in|in)\b|\bwont let me (?:log ?in|sign ?in|in)\b|\blogged (?:me )?out\b|\blogin (?:failed|error)\b|\bmax(?:imum)? connections?\b|\btoo many (?:devices|connections)\b/i.test(t);
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
  // A login failure had no label, so an auth outage — the one failure that
  // hits everybody at once and looks identical in every report — could not
  // group. "invalid login ×7" is the clearest signal the panel can show.
  // Checked first: "invalid login" also contains "error"-ish words in some
  // phrasings, and the specific label is the useful one.
  const auth = t.match(
    /\b(invalid (?:login|log ?in|user|username|password|credentials|subscription)|login (?:failed|error|expired)|unauthori[sz]ed|authentication (?:failed|error)|max(?:imum)? connections?|too many (?:devices|connections))\b/
  );
  if (auth) return auth[1].replace(/\s+/g, ' ');
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

export function recordProblem(ctx, text, { answered = false, service = null } = {}) {
  const userId = ctx.from?.id ?? null;
  const t = String(text).slice(0, 500);
  if (userId != null) {
    const open = db.prepare(
      'SELECT id, text, topic FROM problem_reports WHERE tg_user_id = ? AND resolved = 0 AND ts > ? ORDER BY id DESC LIMIT 1'
    ).get(userId, now() - MERGE_WINDOW_S);
    // Follow-up detail merges into the open report, but only when it is about
    // the SAME thing. Two different problems reported in the same hour are two
    // cases — merging them hid the second one completely, and resolving the
    // first silently closed both.
    const newTopic = extractProblemTopic(text);
    const sameProblem = open && (!newTopic || !open.topic || newTopic === open.topic);
    if (open && sameProblem) {
      const combined = `${open.text}\n↳ ${t}`.slice(0, 1500);
      db.prepare(
        'UPDATE problem_reports SET text = ?, topic = COALESCE(topic, ?), answered = CASE WHEN ? THEN 1 ELSE answered END WHERE id = ?'
      ).run(combined, extractProblemTopic(text), answered ? 1 : 0, open.id);
      return open.id;
    }
  }
  const info = db.prepare(
    'INSERT INTO problem_reports (chat_id, chat_title, tg_user_id, tg_user, text, topic, answered, ts, service_num) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    ctx.chat?.id ?? null,
    ctx.chat?.title ?? null,
    userId,
    ctx.from?.username || ctx.from?.first_name || null,
    t,
    extractProblemTopic(text),
    answered ? 1 : 0,
    now(),
    // Which service they are on, when the bot already knows. Null means
    // unattributed, and an unattributed report never flips one service's
    // status on its own.
    service === 1 || service === 2 ? service : null
  );
  return info.lastInsertRowid;
}

// What the customer has told us they already did. Each entry is a fix the
// bot can suggest, the phrases a customer uses to say they have done it, and
// the phrases the bot uses to suggest it — so a claim made in message one
// can be matched against a suggestion made in message six.
//
// "I've already uninstalled and reinstalled it twice" was answered two
// messages later with "uninstall the app and reinstall it". That is the
// single most insulting thing a support bot does, and the prompt asking
// nicely was the only thing standing against it.
const FIX_KINDS = [
  { key: 'reinstall',
    claimed: /\b(?:re-?install\w*|un-?install\w*|deleted (?:and|then) .{0,12}install|fresh install|installed it again)\b/i,
    offered: /\b(?:re-?install|un-?install|delete the app|remove the app)\b/i },
  { key: 'restart-app',
    claimed: /\b(?:force[\s-]?(?:stopped|closed|quit)|closed (?:the )?app|re-?opened (?:the )?app|killed (?:the )?app)\b/i,
    offered: /\b(?:force[\s-]?(?:stop|close|quit)|close the app|reopen the app|re-?open it)\b/i },
  { key: 'restart-device',
    claimed: /\b(?:re-?started|re-?booted|power[\s-]?cycl\w*|turned it off and on|unplugged)\b[^.?!\n]{0,30}\b(?:it|box|stick|firestick|fire ?tv|tv|telly|device|phone|ipad)\b|\b(?:re-?started|re-?booted|power[\s-]?cycl\w*)\b(?![^.?!\n]{0,20}\brouter\b)/i,
    offered: /\b(?:restart|reboot|power[\s-]?cycle|turn it off and)\b[^.?!\n]{0,24}\b(?:it|box|stick|firestick|fire ?tv|tv|device|app)\b/i },
  { key: 'restart-router',
    claimed: /\b(?:re-?started|re-?booted|power[\s-]?cycl\w*|unplugged|reset)\b[^.?!\n]{0,20}\b(?:router|hub|modem|broadband)\b/i,
    offered: /\b(?:restart|reboot|power[\s-]?cycle|unplug)\b[^.?!\n}]{0,20}\b(?:router|hub|modem)\b/i },
  { key: 'wifi',
    claimed: /\b(?:switched|changed|moved|swapped|tried|on)\b[^.?!\n]{0,24}\b(?:5\s?ghz|5g band|2\.4|ethernet|wired|cable|hard ?wired)\b|\b(?:5\s?ghz|ethernet|hard ?wired)\b[^.?!\n]{0,20}\balready\b/i,
    offered: /\b(?:5\s?ghz|ethernet|wired|hard ?wire)\b/i },
  { key: 'cache',
    claimed: /\b(?:cleared|clearing|wiped|emptied)\b[^.?!\n]{0,20}\bcache\b/i,
    offered: /\bclear\w*\b[^.?!\n]{0,20}\bcache\b/i },
  { key: 'link',
    claimed: /\b(?:tried|changed|switched|picked|used)\b[^.?!\n]{0,24}\b(?:different|another|other)\b[^.?!\n]{0,12}\b(?:link|links|stream|streams|source|sources|server)\b|\ball the links\b/i,
    offered: /\b(?:different|another|other)\b[^.?!\n]{0,12}\b(?:link|stream|source|server)\b/i },
  { key: 'backup-app',
    claimed: /\b(?:tried|used|installed|on)\b[^.?!\n]{0,20}\b(?:backup app|smarters|tivimate|xc ?iptv|ibo ?player)\b/i,
    offered: /\b(?:backup app|smarters|tivimate|xc ?iptv|ibo ?player)\b/i },
  { key: 'vpn',
    claimed: /\b(?:turned off|disabled|removed|no|without|dont have a|don'?t have a|havent got a|haven'?t got a)\b[^.?!\n]{0,16}\bvpn\b/i,
    offered: /\bvpn\b/i },
  { key: 'update',
    claimed: /\b(?:updated|on the latest|latest (?:build|version))\b[^.?!\n]{0,20}\b(?:app|build|version)?\b/i,
    offered: /\bupdate\b[^.?!\n]{0,16}\b(?:the )?app\b|\blatest (?:build|version)\b/i },
];

// Only count a claim when the message is actually claiming it — "should I
// restart it?" is a question, not a report of having done so.
const NOT_A_CLAIM = /\?\s*$|\bshould i\b|\bdo i (?:need|have) to\b|\bhow do i\b|\bwhat if i\b|\bcan i\b|\bwill (?:re-?install|restart)\w*\b/i;

// Causes the customer has RULED OUT, as opposed to fixes they have tried.
// "It's not my wifi, I get 500mb down and everything else streams fine" was
// answered with "power-cycle the box", and then "I already told you it's not
// the wifi" with "move the box onto the 5GHz band". Telling somebody the
// thing they have just ruled out, immediately after they ruled it out, is
// the single most infuriating thing a support bot does.
//
// Ruled out and already tried have the same consequence — do not suggest it
// — so they feed the same list and the same guardrail.
const RULED_OUT = [
  { key: 'wifi',
    re: /\b(?:not|isn'?t|aint|ain'?t)\s+(?:my|the|a)?\s*(?:wifi|wi-?fi|internet|broadband|connection|network|router|line speed|bandwidth)\b|\b(?:wifi|wi-?fi|internet|broadband|connection|speed|router)\b[^.?!\n]{0,24}\b(?:is|are|runs?)\s+(?:fine|ok|okay|perfect|great|good|solid|spot on)\b|\b\d{2,4}\s?(?:mb|mbps|meg|megs|gb)\b[^.?!\n]{0,30}\b(?:down|download|speed)?\b|\beverything else\b[^.?!\n]{0,24}\b(?:streams?|works?|fine|ok)\b/i },
  { key: 'restart-router',
    re: /\b(?:not|isn'?t|aint)\s+(?:my|the)?\s*router\b|\brouter\b[^.?!\n]{0,16}\b(?:is|runs)\s+fine\b/i },
  { key: 'restart-device',
    re: /\b(?:not|isn'?t)\s+(?:my|the)?\s*(?:firestick|fire ?stick|box|stick|device|tv)\b[^.?!\n]{0,20}\b(?:fault|problem|issue)?\b|\b(?:firestick|box|device)\b[^.?!\n]{0,16}\bis\s+fine\b/i },
  { key: 'reinstall',
    re: /\b(?:not|isn'?t)\s+(?:the\s+)?app\b[^.?!\n]{0,20}\b(?:fault|problem|issue)\b|\bapp\s+(?:is|was)\s+fine\b/i },
];

// "I already told you it's not the wifi" — the claim restated, crossly. It
// counts the same as the first time; the whole point is that they should not
// have to say it twice.
export function ruledOutCauses(text) {
  const t = String(text || '');
  if (!t.trim()) return [];
  return RULED_OUT.filter((r) => r.re.test(t)).map((r) => r.key);
}

export function claimedFixes(text) {
  const t = String(text || '');
  if (!t.trim() || NOT_A_CLAIM.test(t)) return [];
  return FIX_KINDS.filter((f) => f.claimed.test(t)).map((f) => f.key);
}

// Does this sentence suggest one of the fixes they say they already did?
export function offersClaimedFix(sentence, tried) {
  if (!tried?.length) return false;
  const s = String(sentence || '');
  return FIX_KINDS.some((f) => tried.includes(f.key) && f.offered.test(s));
}

// Readable for the prompt and for the admin alert.
export const FIX_LABELS = {
  'reinstall': 'reinstalling the app',
  'restart-app': 'force-closing and reopening the app',
  'restart-device': 'restarting the device',
  'restart-router': 'restarting the router',
  'wifi': 'the network (5GHz, cable, router) — tried or ruled out',
  'cache': 'clearing the cache',
  'link': 'a different link or stream',
  'backup-app': 'the backup app',
  'vpn': 'turning off the VPN',
  'update': 'updating the app',
};

// A Fire TV Stick has no ethernet port. Every stick in the range — Lite, 4K,
// 4K Max — is HDMI and WiFi only; wired needs Amazon's Ethernet Adapter,
// which goes into the micro-USB power port and is a separate purchase. The
// Fire TV CUBE is the exception in the family: it has a port built in.
//
// This matters because "use 5GHz WiFi or run an ethernet cable to it" is
// standard buffering advice, it was in the seeded knowledge, in the
// second-round prompt, and it sends a Firestick customer hunting for a
// socket that does not exist on their device.
const FIRESTICK = /\bfire\s?stick\b|\bfirestick\b|\bfire\s?tv\s?stick\b|\bfire\s?stick\s?(?:lite|4k|max)\b|\bffstick\b/i;
const ETHERNET_CAPABLE = /\bfire\s?tv\s?cube\b|\bcube\b|\bnvidia\s?shield\b|\bshield\s?tv\b|\bandroid\s?box\b|\bmag\s?box\b|\bformuler\b|\bsmart\s?tv\b|\bsamsung\b|\blg\b|\bsky\s?glass\b|\bppc\b|\bpc\b|\blaptop\b/i;

export function namesFirestick(text) {
  const t = String(text || '');
  if (!FIRESTICK.test(t)) return false;
  // "I've got a Firestick and a Cube" — the advice is fine for one of them,
  // so leave it alone rather than strip something that may be right.
  return !ETHERNET_CAPABLE.test(t);
}
