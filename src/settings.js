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
  // The most-sent line in the whole bot, and it used to read like a door
  // closing: "Can't help with that one 😂 I'm STRICTLY service support".
  // Laughing at someone's question and then calling yourself strict is not
  // the voice you want in front of a paying customer, or in front of someone
  // deciding whether to become one. Same meaning, warmer, and it ends with
  // the door open instead of shut.
  'bot.offtopicMessage': "Ha, you've lost me there 😄 Streaming's my thing — installs, logins, picture problems, payments, requests. Anything along those lines and I'm all yours.",
  // Banter budget: the FIRST off-topic question a user asks gets ONE short,
  // friendly real answer; any more within this many minutes get the witty
  // brush-off above instead. 0 = always brush off. Redirect mode only.
  'bot.offtopicChatMinutes': 30,
  // Appended in code to every banter answer — always pushes back to support.
  // Empty = banter goes out bare.
  // Short, and only used when the banter did NOT already steer. The long
  // version was being stapled onto an answer that had already said the same
  // thing, and the personalised rewrite then opened by parroting the
  // customer's own words back: "Hey how we doing brother — I'm right here to
  // help with installs, logins, buffering fixes, and requests."
  'bot.smallTalkSteer': "What can I help you with?",
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
  // Sent instead of the "can't help" and off-topic lines while the AI endpoint
  // is unreachable. Those lines both tell the user their question was out of
  // scope — but scope is the MODEL'S verdict, and without it the bot is
  // guessing. Saying so is honest and tells them to come back; calling an
  // in-scope question off-topic is just wrong.
  // "What can you do?" is the one question the bot can always answer, and it
  // used to get the off-topic brush-off. Empty = fall through to normal handling.
  'bot.capabilityMessage':
    "Here's what I can help with:\n" +
    '• Installing and updating the apps (Firestick, Android, iPhone, TVs)\n' +
    '• Logins, accounts, renewals and prices\n' +
    '• Buffering, freezing, channels or streams not working\n' +
    '• Requesting films and series\n\n' +
    'Just ask in your own words — no need for commands. Anything I can\'t do, {admin}.',
  // "You a real person or a bot?" is a friendly question and it was answered
  // with the bulleted list above and nothing else — a leaflet handed to
  // somebody who said hello. Owning it in one warm line first costs nothing
  // and is the difference between a brochure and a conversation. The list
  // still follows, because what it can do is the actual answer they want.
  // Empty = the list goes out on its own as before.
  'bot.botAdmissionMessage': "Guilty — I'm a bot 🤖 A quick one though, and there's always a real person behind me.",
  // Sent for a channel or fixture question we have nothing cached for. Code
  // answers it rather than the model, which given an empty hand will either
  // invent a channel or recite its own brief at the customer. Empty = let the
  // model try anyway.
  'bot.noListingMessage': "I don't have a listing for that at the moment. The TV guide inside the app shows what's on — or give me the channel name and I'll look it up.",
  'bot.aiDownMessage': "⚠️ I can't reach my AI right now, so I can only answer things in my FAQ list. Try me again in a minute — or {admin} if it's urgent.",
  'bot.adminContact': '',
  // The Downloader / aftv.news code for the current app build. The bot sends
  // the file itself when it fits in Telegram's 50MB bot limit and quotes this
  // code when it doesn't.
  'bot.downloadCode': '3793766',
  // Downloader / aftv.news codes per app. Referenced from knowledge entries,
  // guides and canned messages as {purple} and {skyglass}, so changing a code
  // is one edit here rather than a hunt through every entry that quotes it.
  // Shipped with the current live codes so a fresh install answers install
  // questions correctly on day one instead of printing "[code not set]".
  'apps.purpleCode': '3775005',
  'apps.skyGlassCode': '3793766',
  // Wallet addresses. A coin with no address set is not offered to anyone —
  // saying "we take Bitcoin" with nowhere to send it is worse than not
  // offering it. These NEVER enter the AI prompt and never come out of the
  // model: the bot sends them itself, verbatim (see src/payments.js).
  'payments.ltcAddress': '',
  'payments.btcAddress': '',
  // Appended to the LAST round of fixes — the next "still broken" reply
  // really does get flagged, so this note may promise it. Empty = off.
  'bot.problemFollowupNote': "Still happening after trying these? Reply here and I'll flag it straight to the team.",
  // Appended to EARLIER rounds instead, where a reply brings more steps —
  // promising a flag there would be a lie. Empty = use the note above.
  'bot.problemMoreFixesNote': "Still happening after trying these? Reply here and I'll dig up the next things to try.",
  // Sent when a confirmed problem is escalated to the admins. Empty = off.
  // {case} is the reporter's own reference number. Without one they have
  // nothing to quote, and the admin cannot say "that's #12" and be understood
  // — the number only ever appeared in the admin's digest. Leave it out and
  // it is added on its own line anyway.
  'bot.problemFlaggedNote': "✅ Flagged to the team — they'll look into it. No need to report it again. Your reference is #{case}.",
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
  // How long a reply still counts as being about the open problem. The fixes
  // the bot hands out take real minutes to carry out, so a short window closes
  // the thread while the customer is still off doing what it asked.
  'bot.problemWindowMinutes': 720,
  'bot.problemNudgeMinutes': 3,
  'bot.problemNudgeMessage': "That was quick! 😄 Some of those steps take a few minutes to do properly — a router restart alone takes two. Give them a real go, and if it's still playing up afterwards, reply here and I'll flag it straight to the team.",
  // Sent when the user says the problem is fixed. Empty = off.
  'bot.problemResolvedNote': "Great — glad it's sorted! 👍",
  // Sent to the reporter when the ADMIN presses Resolve in the panel.
  // {name} tags the user, {topic} is the detected symptom. Empty = silent.
  // {name}, {topic}, {case} (their reference number) and {report} (a short
  // echo of what they actually said) are filled in. "The issue you reported"
  // means nothing to someone who has reported more than one thing.
  'bot.problemResolvedByAdminMessage': '✅ {name} — good news: #{case} ("{report}") has been fixed by the team. Give it another go, and shout here if anything is still off!',
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
  // Sent instead of the busy line when the message was a PROBLEM REPORT and
  // the AI could not get a slot. Never asks them to send it again: we already
  // have the report, and during a surge a re-send is load we cannot afford.
  'bot.busyProblemMessage': "✅ Got that — it's logged and the team can see it, no need to send it again. Your reference is #{case}. We're busy right now so I'll leave the troubleshooting to a person; {admin} if it's urgent.",
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
  // Short on purpose. The old one was a four-line introduction with a feature
  // list and a /help plug, sent to someone who typed "hey bro" — it reads
  // like a brochure, and a returning customer gets the same brochure every
  // time. A person would say hello back and ask what is up.
  'bot.greetingMessage': "Hey 👋 What can I sort for you?",
  'bot.thanksMessage': 'Anytime! 👍 Shout if you need anything else.',
  // "I need help" with nothing else in it. No service vocabulary, so the
  // scope gate used to call it off-topic and brush off the one person who had
  // actually asked for help. Sent from code, so it still works with the AI
  // down — which is exactly when people start asking this. Empty = silent.
  'bot.helpAskMessage': "Course 👍 What's up? Tell me what's happening — which app you're using and what you're seeing — and I'll sort it.",
  // "Can I speak to a human?" — the clearest signal a customer can send that
  // the bot is not going to be enough. It used to get the banter line. This
  // also covers "can you ring me": we have no phone, and the honest answer is
  // where the human actually is. Empty = silent.
  'bot.humanRequestMessage': "Of course 👍 {admin} — they pick up messages here and will sort you out personally. If you tell me what's up in the meantime I'll have a go myself, but no pressure either way.",
  // Swearing at the bot, or giving up on it. Content-free, so the model has
  // nothing to work with and banter is the worst possible reply. One warm,
  // self-deprecating line that offers a human instead. Empty = silent.
  'bot.frustrationMessage': "Sorry — I'm clearly not getting this right 😅 Tell me what's not working and I'll have another go, or {admin} and they'll take it from here personally.",
  // The bot says "✅ Flagged to the team — no need to report it again. Your
  // reference is #1." The customer, one message later, says "it's still
  // cutting out" — and got "I'm not totally sure on that one, message the
  // admin". It disowned a case it had just taken, and told them to go and do
  // the thing it had told them not to bother doing. Empty = let it fall
  // through to normal answering, which is what used to happen.
  'bot.problemAlreadyFlaggedNote': "Still with the team, that one — ref #{case}. Nothing more you need to do, they'll come back to you here. 👍",
  // Somebody mid-rant sends three of these in a row, and apologising three
  // times in the same words is its own kind of insult — it reads as a machine
  // that did not hear any of it. The second one onward says the thing that
  // has actually changed: a human now knows. Empty = repeat the line above.
  'bot.frustrationRepeatMessage': "I hear you 😔 The team already has this and they'll come to you directly. If you tell me what's actually going wrong I'll keep digging in the meantime.",
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
  // An install guide is legitimately 200+ words, and 220 tokens cut them off
  // mid-step. The old cap was defence against a failure mode that no longer
  // exists: answers stream now, and hitting the time budget returns what the
  // model has written rather than throwing it away, so a long answer is no
  // longer all-or-nothing.
  'ai.maxTokens': 500,
  'ai.temperature': 0.3,
  // CPU generation is slow — a full answer can take 60-90s. The old 90s
  // default cut answers off mid-generation (Ollama 500s). 180s gives them
  // room to finish; raise it further for a big model on weak hardware.
  'ai.timeoutSeconds': 180,
  // How many AI generations may run at once. Keep at 1 for CPU Ollama; raise
  // only if your endpoint genuinely serves parallel requests (GPU, cloud).
  'ai.maxConcurrent': 1,
  // Semantic retrieval. An embedding is one forward pass, so it stays cheap on
  // the same CPU node that generates at a few tokens a second. Switch this off
  // and the bot falls back to the old keyword/trigram matcher.
  'ai.embedEnabled': true,
  'ai.embedModel': 'nomic-embed-text',
  // How many FAQs are handed to the model as knowledge for a question.
  'ai.retrieveCount': 6,
  // Reuse an answer the model already wrote when a new question means
  // essentially the same thing. This is what keeps AI-for-everything viable on
  // a slow node; it does not speed up a genuine new question.
  'ai.cacheEnabled': true,
  'ai.cacheThreshold': 0.95,
  'ai.cacheMaxAgeDays': 30,

  'faq.threshold': 0.5,

  'service.status': 'operational', // operational | degraded | maintenance
  // Per-service status. A fault is usually on ONE of the two panels, and
  // telling the other service's customers "we're aware of a service issue"
  // when theirs is fine sends them looking for a problem they do not have.
  // The global one above still applies to everybody — use it when both are
  // down, or when you do not know which.
  'service.status1': 'operational',
  'service.status2': 'operational',
  // Affects BOTH services. A note that is only true for one of them belongs
  // in the per-service fields below, or a customer on the other service gets
  // told about a problem that is not theirs — which is how "Purple is down
  // for Exclusive customers" reached a Flix customer.
  'service.note': '',
  'service.note1': '',
  'service.note2': '',
  // Set (to a timestamp) when the status was flipped by auto-degradation —
  // lets the recovery sweep clear it without ever touching an admin-set one.
  'service.autoDegradedAt': 0,
  // Automatic degradation: this many DIFFERENT people reporting service-wide
  // problems (single episodes/movies excluded) within the window flips the
  // service status to 'degraded'. 0 = off.
  'problems.degradeThreshold': 3,
  'problems.degradeWindowMinutes': 15,
  'problems.degradeRecoverMinutes': 30,
  // When the bot decides there is a service-wide problem it offers to tell the
  // group, rather than telling them. The threshold is a heuristic (several
  // people, short window) and a false positive would put "we have an outage"
  // in front of paying customers with nobody checking, so the admin taps a
  // button. {note} is the auto-written summary of what people are reporting.
  'problems.announceMessage': "⚠️ Heads up everyone — {note} We're on it and will update you here. No need to reinstall anything or message in individually.",
  'problems.recoveredMessage': '✅ All clear — the problem reported earlier is sorted. Give it a go and shout if you still have trouble.',
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
  // A lookup account on each service's own Xtream Codes panel. Used read-only
  // to pull the channel lineup and EPG, so the bot can answer "what channel is
  // the F1 on" from the real listing instead of guessing. Use a spare account,
  // not your own: the password is stored here and sent to the panel on every
  // lookup. It is never shown to customers, logged, or put in the AI prompt.
  'services.xcUser1': '',
  'services.xcPass1': '',
  'services.xcUser2': '',
  'services.xcPass2': '',
  // Refresh the cached lineup this often (hours). 0 = only on demand.
  'services.xcRefreshHours': 24,
  // How long a channel's guide is served from the cache before going back to
  // the panel (minutes). Without it, every "what's on" was a live API call,
  // so the same question asked twice cost two. A finished run is dropped
  // early regardless, so raising this does not mean serving yesterday's guide.
  // A day. A cached run is dropped the moment the panel's own timestamps say
  // everything in it has finished, so this is a backstop rather than the thing
  // doing the work — and a run the panel gave no end time for is held for 30
  // minutes whatever this says.
  'services.epgCacheMinutes': 1440,
  // Download the WHOLE guide (xmltv.php) this often, in hours. 0 = off. This
  // is what answers "who's playing Derby tonight" — a question where the
  // channel is the answer — so it cannot be done per channel on demand.
  // Once a day. The kept window (below) is wider than this interval on
  // purpose, so there is always at least a day of listings ahead even in the
  // hour before the next download.
  'services.xmltvRefreshHours': 24,
  // How far ahead of now the downloaded guide is kept. These questions are
  // about tonight and tomorrow; a week of listings for several hundred
  // channels just makes the title search slower.
  'services.epgWindowHours': 48,
  'services.guideFetchedAt1': 0,
  'services.guideFetchedAt2': 0,
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
  // Also draft FAQs from questions the ADMIN answered in the group. The
  // answer is real rather than inferred, so these drafts arrive complete —
  // but they may carry one customer's details, so they are flagged and never
  // auto-enabled. Needs replies to be sent with Telegram's reply action, which
  // is what links an answer to its question.
  'suggest.fromAnswers': true,
  // Also draft FAQs from cases the customer confirmed were fixed, and report
  // topics that keep recurring without ever being resolved.
  'suggest.fromCases': true,
  'suggest.lastRunAt': 0,
  // DM sent N days BEFORE expiry ({name}, {days}). Empty = off.
  'portal.expiryReminderMessage': '⏰ Heads up {name}: your access expires in {days} day(s). Renewing only takes a few minutes — {admin} or ask in the group and we will sort you out.',
  // DM sent ON/after expiry day ({name}). Empty = off.
  'portal.expiryUpsellMessage': "😢 {name}, your access expired — but getting back takes minutes. {admin} or ask in the group and we'll renew you today. Paying with crypto is easier than it sounds: the step-by-step guide does the hard part.",
  // Scores, tables and race results.
  // F1 comes from Jolpica (the free Ergast successor): no key, no account, so
  // it works the moment the bot starts. Football needs a free API key from
  // football-data.org — without one that half simply stays off and the bot
  // says it has no scores rather than guessing at one.
  // Send the film or series poster with an availability answer. IMDb supplies
  // it; nothing else is ever sent as an image.
  'vod.posters': true,

  'sports.f1Enabled': true,
  'sports.footballApiKey': '',
  // football-data competition codes. PL Premier League, ELC Championship,
  // CL Champions League, PD La Liga, SA Serie A, BL1 Bundesliga, FL1 Ligue 1.
  'sports.footballCompetitions': 'PL',
  // Tables barely move between matches and a free tier has a rate limit, so
  // the answers are held rather than re-fetched per message.
  'sports.cacheMinutes': 30,
  // Let the AI call it like someone who watched it ("Max gapped Lando for
  // P2") instead of reading the table out. The FACTS still come only from the
  // feed — this changes the delivery, never the numbers.
  'sports.commentary': true,

  'reports.alertErrors': true,
  'reports.alertBudget': true,
  'reports.alertBannedWords': false,
  'reports.alertProblems': true, // DM admins when users report problems (buffering, channels down…)
  // A customer swearing at the bot or giving up on it. Never throttled: each
  // one is a different person about to cancel, and losing the second because
  // the first was 10 minutes ago defeats the point of telling you at all.
  'reports.alertFrustrated': true,
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

  // Download codes change, and they were written out by hand in a dozen
  // different entries — which is exactly why they drift out of date, and why
  // a customer ends up installing last month's build. Writing {purple} or
  // {skyglass} in an entry, a guide or a canned message means one field in
  // Bot settings updates every one of them at once.
  const codes = {
    purple: String(getSetting('apps.purpleCode') || '').trim(),
    skyglass: String(getSetting('apps.skyGlassCode') || '').trim(),
  };

  // Same reasoning for the two brand names: the "which service am I on?"
  // entry used to carry SERVICE-NAME-1/2 placeholders the admin had to edit by
  // hand, so the names could disagree with Bot settings. These read from the
  // one place they are configured. Names only — never a service URL, which is
  // per-user and goes out through its own flow (see redactServiceUrls).
  const names = {
    service1: String(getSetting('services.name1') || '').trim(),
    service2: String(getSetting('services.name2') || '').trim(),
  };

  return String(text ?? '')
    .replace(/\{admin\}/gi, phrase)
    .replace(/\{(purple|skyglass)\}/gi, (whole, name) => {
      const code = codes[name.toLowerCase()];
      // An unset code must never render as an empty string in the middle of
      // "enter code  and click Go" — say it is missing so it gets noticed.
      return code || `[${name} code not set]`;
    })
    .replace(/\{(service1|service2)\}/gi, (whole, name) => {
      const key = name.toLowerCase();
      return names[key] || `[${key === 'service1' ? 'service 1' : 'service 2'} name not set]`;
    });
}


// The per-user service login URLs must never ride along in FAQ/guide text or
// AI answers — each user gets THEIR url from the dedicated flow only, so a
// URL the admin pasted into an FAQ would leak to the other service's
// customers. Replace any occurrence with a pointer to the flow. (The URL
// flow itself sends the real value on purpose and does not use this.)
// The notes that actually apply to this customer. With a known service that
// is the shared note plus theirs; with an unknown one, every note, each
// labelled with whose it is, so nothing is ever quietly attributed to the
// wrong service.
// The status that applies to THIS customer: their own service's, or the
// global one when it is set. Returns 'operational' when neither is.
export function serviceStatusFor(service = null) {
  const global = String(getSetting('service.status') || 'operational');
  if (global !== 'operational') return global;
  if (service === 1 || service === 2) {
    return String(getSetting(`service.status${service}`) || 'operational');
  }
  // Service unknown: only speak up if BOTH are down, or nobody would know
  // whether the warning was meant for them.
  const a = String(getSetting('service.status1') || 'operational');
  const b = String(getSetting('service.status2') || 'operational');
  return a !== 'operational' && a === b ? a : 'operational';
}

export function serviceNotesFor(service = null) {
  const shared = String(getSetting('service.note') || '').trim();
  const per = {
    1: String(getSetting('service.note1') || '').trim(),
    2: String(getSetting('service.note2') || '').trim(),
  };
  const label = (n) => String(getSetting(`services.name${n}`) || '').trim() || `service ${n}`;
  const out = [];
  if (shared) out.push(shared);
  if (service === 1 || service === 2) {
    if (per[service]) out.push(per[service]);
  } else {
    for (const n of [1, 2]) if (per[n]) out.push(`${label(n)}: ${per[n]}`);
  }
  return out;
}

export const serviceNoteText = (service = null) => serviceNotesFor(service).join('\n');

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
