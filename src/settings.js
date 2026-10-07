import { db } from './db/db.js';
import { config } from './config.js';

// All tunables live in the settings KV table so admins can change them from
// the panel without a restart. Env vars only seed the initial values.
const DEFAULTS = {
  'branding.appName': 'Support Suite',
  'branding.accentColor': '#6366f1',
  'branding.logoFile': '',

  'bot.enabled': true,
  'bot.instructions':
    'You are the friendly support assistant for our streaming app. Help users install, ' +
    'update and troubleshoot the app on Firestick and mobile devices.',
  'bot.responseMode': 'questions', // mention | questions | all
  'bot.dmEnabled': true,
  'bot.offtopicBehavior': 'redirect', // silent | redirect
  'bot.offtopicMessage': "Can't help with that one 😂 I'm strictly service support — installs, logins, streams, payments. /help shows what I can do.",
  // Banter budget: the FIRST off-topic question a user asks gets ONE short,
  // friendly real answer; any more within this many minutes get the witty
  // brush-off above instead. 0 = always brush off. Redirect mode only.
  'bot.offtopicChatMinutes': 30,
  // Appended in code to every banter answer — always pushes back to support.
  // Empty = banter goes out bare.
  'bot.smallTalkSteer': "Anyway — service stuff is where I shine 😄 installs, logins, buffering fixes, requests. Try me!",
  // Canned answer for "which service is the best?" when two services are
  // configured ({name1}/{name2}). Biased to service 1 on purpose — the model
  // is never allowed to freestyle a comparison of your own products.
  'bot.bestServiceMessage': "Easy — {name1} 😄 That's the one we point people to first. {name2} holds its own too, but if you fancy giving {name1} a go, message the admin and they'll sort you out.",
  'bot.fallbackMessage': '', // empty = stay silent when nothing matched and AI is off/down
  // Sent when a message IS about the app/service but the bot can't answer it —
  // kinder than the off-topic line, and points the user to a human.
  'bot.unsureMessage': "I'm not totally sure on that one — {admin} and they'll sort you out.",
  // Where everyone goes when the bot can't help. {admin} in any bot message is
  // replaced with this; leave the handle empty and messages fall back to
  // "message an admin directly".
  'bot.adminContact': '',
  // The Downloader / aftv.news code for the current app build. The bot sends
  // the file itself when it fits in Telegram's 50MB bot limit and quotes this
  // code when it doesn't.
  'bot.downloadCode': '',
  // Appended to the LAST round of fixes — the next "still broken" reply
  // really does get flagged, so this note may promise it. Empty = off.
  'bot.problemFollowupNote': "Still happening after trying these? Reply here and I'll flag it straight to the team.",
  // Appended to EARLIER rounds instead, where a reply brings more steps —
  // promising a flag there would be a lie. Empty = use the note above.
  'bot.problemMoreFixesNote': "Still happening after trying these? Reply here and I'll dig up the next things to try.",
  // Sent when a confirmed problem is escalated to the admins. Empty = off.
  'bot.problemFlaggedNote': "✅ Flagged to the team — they'll look into it. No need to report it again.",
  // Asked right after the flagged note so the admin knows which system to
  // check; the user's next reply is captured and forwarded. Empty = off.
  'bot.problemServiceQuestion': 'One more thing for the team — which service is this on? Reply with the service name, or the username you log in with (never the password).',
  // How many rounds of fixes before a confirmed problem is flagged to the
  // team. 1 = flag on the first "still broken"; 2 (default) = answer that
  // with a second, DIFFERENT set of steps first and only flag when those
  // fail too. Skipped for auto-close re-entries (those were promised an
  // immediate flag) and during outages.
  'bot.problemFixRounds': 2,
  // A confirmation that arrives faster than this many minutes after the fixes
  // gets one friendly "actually try it first" pushback instead of escalating.
  // 0 = off. Exceptions: detailed confirmations, fix-negations, known outages.
  'bot.problemNudgeMinutes': 3,
  'bot.problemNudgeMessage': "That was quick! 😄 Some of those steps take a few minutes to do properly — a router restart alone takes two. Give them a real go, and if it's still playing up afterwards, reply here and I'll flag it straight to the team.",
  // Sent when the user says the problem is fixed. Empty = off.
  'bot.problemResolvedNote': "Great — glad it's sorted! 👍",
  // Sent to the reporter when the ADMIN presses Resolve in the panel.
  // {name} tags the user, {topic} is the detected symptom. Empty = silent.
  'bot.problemResolvedByAdminMessage': '✅ {name} — good news: the {topic} issue you reported has been fixed by the team. Give it another go, and shout here if anything is still off!',
  // Reports answered but never confirmed auto-close after this many minutes
  // (0 = off). Escalated reports are never auto-closed.
  'bot.problemAutoCloseMinutes': 60,
  // Sent once when auto-closing ({name} and {topic} are filled in; empty =
  // close silently). Replies: still-broken phrasing escalates to the admins,
  // clear resolutions close warmly, neutral updates get the soft close below.
  'bot.problemAutoCloseMessage': "Haven't heard back {name}, so I'm assuming the {topic} issue got sorted — closing it off 👍 Still happening? Just reply here and I'll flag it straight to the team.",
  // Reply to a NEUTRAL response to the auto-close notice ("we watched the
  // end & went to bed") — friendly close, door open. Empty = off.
  'bot.problemSoftCloseMessage': "👍 No problem — shout here if it starts playing up again and I'll flag it straight to the team.",
  // Sent when the AI is overloaded (queue full or generation timed out).
  // Empty = stay silent.
  'bot.busyMessage': "I'm helping a lot of people right now 😅 — give me a minute and send your question again.",
  // Never auto-answer group messages from the admins listed in Reports —
  // their questions, mentions and replies to the bot still work.
  'bot.ignoreAdmins': false,
  // Let the AI reword canned replies (greeting/thanks/brush-off/closes/
  // nudges) in fresh words each time — the saved text stays the meaning and
  // the fallback. Never applied to messages carrying URLs, codes, the
  // service question, or the auto-close notice. Skipped while the AI is
  // busy with real answers.
  'bot.aiRephrase': true,
  // Canned warmth: a bare "hey" or "cheers" gets these instead of the
  // off-topic brush-off. Empty = silent.
  'bot.greetingMessage': "Hey! 👋 I'm the team's support bot — ask me anything about the service: installs, buffering fixes, logins, what to watch it on. /help shows all my tricks. What can I sort for you?",
  'bot.thanksMessage': 'Anytime! 👍 Shout if you need anything else.',
  // Sent when someone shows the bot a photo/video/voice note it can't read —
  // in a DM always, in a group only when the media replies to the bot.
  // Empty = stay silent.
  'bot.photoMessage': "I can't open photos, videos or voice notes 📷 Type out what you're seeing — any error message word for word, plus the channel or film name — and I'll sort it from there.",
  'bot.welcomeEnabled': false,
  'bot.welcomeText': 'Welcome {name}! Ask me anything about the app — or type /help to see what I can do.',
  'bot.cooldownSeconds': 15,
  'bot.aiDailyBudget': 500,

  'ai.enabled': true,
  'ai.baseUrl': config.ai.baseUrl,
  'ai.apiKey': config.ai.apiKey,
  'ai.model': config.ai.model,
  // Kept modest on purpose: answers are meant to be 2-4 sentences, and every
  // extra token is real seconds on a CPU node (~4 tokens/sec generation).
  'ai.maxTokens': 220,
  'ai.temperature': 0.3,
  // CPU generation is slow — a full answer can take 60-90s. The old 90s
  // default cut answers off mid-generation (Ollama 500s). 180s gives them
  // room to finish; raise it further for a big model on weak hardware.
  'ai.timeoutSeconds': 180,
  // How many AI generations may run at once. Keep at 1 for CPU Ollama; raise
  // only if your endpoint genuinely serves parallel requests (GPU, cloud).
  'ai.maxConcurrent': 1,

  'faq.threshold': 0.5,

  'service.status': 'operational', // operational | degraded | maintenance
  'service.note': '',
  // Set (to a timestamp) when the status was flipped by auto-degradation —
  // lets the recovery sweep clear it without ever touching an admin-set one.
  'service.autoDegradedAt': 0,
  // Automatic degradation: this many DIFFERENT people reporting service-wide
  // problems (single episodes/movies excluded) within the window flips the
  // service status to 'degraded'. 0 = off.
  'problems.degradeThreshold': 3,
  'problems.degradeWindowMinutes': 15,
  'problems.degradeRecoverMinutes': 30,
  'service.announceChanges': false,

  'files.autoAnnounce': false,

  'reports.adminTelegramIds': [],
  'reports.alertVod': true,
  // "Request: Title (Year)" capture: ack to the requester ({title}), and the
  // tag-back when the admin marks it added ({name}, {title}).
  'bot.requestAckMessage': '📝 Noted! {title} is on the request list — new titles land in batches, keep an eye on the VOD section 👍',
  'bot.requestAddedMessage': '🎬 Good news {name} — your request has been added: {title}. Enjoy!',
  // Asked after capturing a request when two services are configured, so the
  // admin knows which library to add it to. Empty = don't ask.
  'bot.requestServiceQuestion': 'Which service is this for?',
  // Check captured titles against IMDb's public suggestion endpoint: exact
  // hits are canonicalized ("the batman" → "The Batman (2022)"), differing
  // guesses ask the requester to confirm. Off/slow/no-match = no change.
  'vod.imdbCheck': true,
  'vod.imdbBase': 'https://v2.sg.media-imdb.com',
  // Per-user service URLs. Deliberately kept OUT of the FAQ/AI knowledge:
  // a user only ever receives the URL matching THEIR username (prefix rule),
  // never the other service's. Empty URLs = the flow stays off.
  'services.name1': '',
  'services.url1': '',
  'services.name2': '',
  'services.url2': '',
  'services.prefix2': 'THM', // usernames starting with this → service 2
  // Rotating group promos ("recommend us", renewals) every N days.
  'promo.enabled': false,
  'promo.intervalDays': 3,
  'promo.hour': 19, // UTC hour to post at
  'promo.nextIndex': 0,
  'promo.lastSentAt': 0,
  'promo.messages': [
    "😄 Enjoying the service? Tell your mates! Send me /invite and I'll give you a personal invite link for this group — they'll need their own login, so {admin} to get them set up.",
    '👋 Quick reminder: I answer questions instantly — installs, buffering fixes, logins, what to watch it on. Just ask here in the group or DM me. /help shows everything I can do.',
    '📅 Renewals and new signups take minutes — {admin}. Paying with crypto is easier than it sounds; the step-by-step guide does the hard part.',
    '📺 Watching on more than one TV? Multi-room is available — ask the admin about adding a second stream to your plan.',
  ],
  // Weekly AI-drafted FAQ suggestions from unanswered questions.
  'suggest.faqs': true,
  'suggest.lastRunAt': 0,
  // DM sent N days BEFORE expiry ({name}, {days}). Empty = off.
  'portal.expiryReminderMessage': '⏰ Heads up {name}: your access expires in {days} day(s). Renewing only takes a few minutes — {admin} or ask in the group and we will sort you out.',
  // DM sent ON/after expiry day ({name}). Empty = off.
  'portal.expiryUpsellMessage': "😢 {name}, your access expired — but getting back takes minutes. {admin} or ask in the group and we'll renew you today. Paying with crypto is easier than it sounds: the step-by-step guide does the hard part.",
  'reports.alertErrors': true,
  'reports.alertBudget': true,
  'reports.alertBannedWords': false,
  'reports.alertProblems': true, // DM admins when users report problems (buffering, channels down…)
  'reports.digest': 'off', // off | daily | weekly
  'reports.digestHour': 9,

  'portal.expiryReminderDays': 3,
  'retention.messagesDays': 30,
  // The message log is the only record of how questions actually got answered
  // in the group — yours, the bot's and other members'. That corpus is what
  // new FAQ/knowledge entries get written from, so it is kept by default and
  // retention.messagesDays no longer applies to it. Turn this off to go back
  // to pruning. (Text only; SQLite carries years of group chat without fuss.)
  'retention.keepConversations': true,

  // New-member vetting: after this many days, joiners without a linked
  // customer account are DM'd to the admin with Keep/Remove buttons. 0 = off.
  'group.vetDays': 0,
};

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

const cache = new Map();

export function getSetting(key) {
  if (cache.has(key)) return cache.get(key);
  const row = getStmt.get(key);
  const value = row ? JSON.parse(row.value) : DEFAULTS[key];
  cache.set(key, value);
  return value;
}

export function setSetting(key, value) {
  setStmt.run(key, JSON.stringify(value));
  cache.set(key, value);
}

// Every "we can't help here, go to a human" line funnels through one phrase so
// there is a single place to change who that human is. Applied to canned bot
// messages, to FAQ answers (seeded text references it) and to the AI prompt,
// so a {admin} placeholder never reaches a customer raw. An unset handle still
// reads naturally rather than naming nobody.
export function withAdminContact(text) {
  const handle = String(getSetting('bot.adminContact') || '').trim();
  const phrase = handle
    ? `message ${handle.startsWith('@') ? handle : `@${handle}`} directly`
    : 'message an admin directly';
  return String(text ?? '').replace(/\{admin\}/gi, phrase);
}

// The per-user service login URLs must never ride along in FAQ/guide text or
// AI answers — each user gets THEIR url from the dedicated flow only, so a
// URL the admin pasted into an FAQ would leak to the other service's
// customers. Replace any occurrence with a pointer to the flow. (The URL
// flow itself sends the real value on purpose and does not use this.)
export function redactServiceUrls(text) {
  let out = String(text ?? '');
  const needles = [];
  for (const key of ['services.url1', 'services.url2']) {
    const url = String(getSetting(key) || '').trim();
    if (url.length < 8) continue;
    const bare = url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const host = bare.split('/')[0].split(':')[0];
    for (const n of [url, bare, host]) if (n.length >= 8 && !needles.includes(n)) needles.push(n);
  }
  needles.sort((a, b) => b.length - a.length);
  const pointer = 'your service URL (send me "whats the service URL" and I\'ll give you yours)';
  for (const n of needles) {
    if (pointer.toLowerCase().includes(n.toLowerCase())) continue; // never loop on a degenerate needle
    let idx;
    while ((idx = out.toLowerCase().indexOf(n.toLowerCase())) !== -1) {
      out = out.slice(0, idx) + pointer + out.slice(idx + n.length);
    }
  }
  return out;
}

export function setSettings(entries) {
  const tx = db.transaction((pairs) => {
    for (const [key, value] of pairs) {
      setStmt.run(key, JSON.stringify(value));
      cache.set(key, value);
    }
  });
  tx(Object.entries(entries));
}
