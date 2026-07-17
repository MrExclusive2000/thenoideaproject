import { db } from './db/db.js';
import { config } from './config.js';

// All tunables live in the settings KV table so admins can change them from
// the panel without a restart. Env vars only seed the initial values.
export const DEFAULTS = {
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
  'bot.fallbackMessage': '', // empty = stay silent when nothing matched and AI is off/down
  // Sent when a message IS about the app/service but the bot can't answer it —
  // kinder than the off-topic line, and points the user to a human.
  'bot.unsureMessage': "I'm not totally sure on that one — send /ticket in a private message to me and the team will help you out.",
  // Appended to the FIRST answer to a problem report: invites the user to
  // confirm if the fixes don't help. Empty = off.
  'bot.problemFollowupNote': "Still happening after trying these? Reply here and I'll flag it straight to the team.",
  // Sent when a confirmed problem is escalated to the admins. Empty = off.
  'bot.problemFlaggedNote': "✅ Flagged to the team — they'll look into it. No need to report it again.",
  // Asked right after the flagged note so the admin knows which system to
  // check; the user's next reply is captured and forwarded. Empty = off.
  'bot.problemServiceQuestion': 'One more thing for the team — which service is this on? Reply with the service name, or the username you log in with (never the password).',
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
  // close silently). A reply to it escalates straight to the admins.
  'bot.problemAutoCloseMessage': "Haven't heard back {name}, so I'm assuming the {topic} issue got sorted — closing it off 👍 Still happening? Just reply here and I'll flag it straight to the team.",
  // Sent when the AI is overloaded (queue full or generation timed out).
  // Empty = stay silent.
  'bot.busyMessage': "I'm helping a lot of people right now 😅 — give me a minute and send your question again.",
  // Never auto-answer group messages from the admins listed in Reports —
  // their questions, mentions and replies to the bot still work.
  'bot.ignoreAdmins': false,
  'bot.welcomeEnabled': false,
  'bot.welcomeText': 'Welcome {name}! Ask me anything about the app — or type /help to see what I can do.',
  'bot.cooldownSeconds': 15,
  'bot.aiDailyBudget': 500,

  'ai.enabled': true,
  'ai.baseUrl': config.ai.baseUrl,
  'ai.apiKey': config.ai.apiKey,
  'ai.model': config.ai.model,
  'ai.maxTokens': 350,
  'ai.temperature': 0.3,
  'ai.timeoutSeconds': 90,
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
  // Rotating group promos ("recommend us", renewals) every N days.
  'promo.enabled': false,
  'promo.intervalDays': 3,
  'promo.hour': 19, // UTC hour to post at
  'promo.nextIndex': 0,
  'promo.lastSentAt': 0,
  'promo.messages': [
    "😄 Enjoying the service? Tell your mates! Send me /invite and I'll give you a personal invite link for this group — they'll need their own login, so point them at the admin or have them message me /ticket.",
    '👋 Quick reminder: I answer questions instantly — installs, buffering fixes, logins, what to watch it on. Just ask here in the group or DM me. /help shows everything I can do.',
    '📅 Renewals and new signups take minutes — message the admin here or send me /ticket. Paying with crypto is easier than it sounds; the step-by-step guide does the hard part.',
    '📺 Watching on more than one TV? Multi-room is available — ask the admin about adding a second stream to your plan.',
  ],
  // Weekly AI-drafted FAQ suggestions from unanswered questions.
  'suggest.faqs': true,
  'suggest.lastRunAt': 0,
  // DM sent N days BEFORE expiry ({name}, {days}). Empty = off.
  'portal.expiryReminderMessage': '⏰ Heads up {name}: your access expires in {days} day(s). Renewing only takes a few minutes — message me /ticket or ask in the group and we will sort you out.',
  // DM sent ON/after expiry day ({name}). Empty = off.
  'portal.expiryUpsellMessage': "😢 {name}, your access expired — but getting back takes minutes. Message me /ticket or ask in the group and we'll renew you today. Paying with crypto is easier than it sounds: the step-by-step guide does the hard part.",
  'reports.alertErrors': true,
  'reports.alertBudget': true,
  'reports.alertBannedWords': false,
  'reports.alertTickets': true,
  'reports.alertProblems': true, // DM admins when users report problems (buffering, channels down…)
  'reports.digest': 'off', // off | daily | weekly
  'reports.digestHour': 9,

  'portal.expiryReminderDays': 3,
  'retention.messagesDays': 30,

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

export function setSettings(entries) {
  const tx = db.transaction((pairs) => {
    for (const [key, value] of pairs) {
      setStmt.run(key, JSON.stringify(value));
      cache.set(key, value);
    }
  });
  tx(Object.entries(entries));
}
