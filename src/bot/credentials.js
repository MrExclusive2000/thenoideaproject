import { db } from '../db/db.js';

// A customer sending the bot their password. It happened because the bot
// ASKED for it ("share your username and password so I can create the link"),
// which is fixed at the source — but the habit outlives the bug, and a
// password typed into a chat window is already out of the customer's hands:
// it sits in Telegram's history on both ends, in the admin's conversation
// log, and in whatever the model was about to be told next.
//
// Detection is deliberately narrow. There is no reliable way to tell a
// password from any other short string, so guessing would mean warning people
// about their own usernames and channel names. These are the shapes that are
// unambiguous:
//   1. They labelled it. "password: hunter2", "my pass is hunter2".
//   2. A username we actually hold, followed by one more token — the exact
//      shape of the message in the transcript ("Georgewilliam1 WEe7NdeF").
const LABELLED =
  /\b(?:pass(?:word|wd)?|pwd|login|log-?in|credentials)\b[ \t]*(?:is|was|=|:|-)?[ \t]*([^\s,;.!?]{4,})/i;

// "username and password are X and Y" / "user: X pass: Y"
// The gaps must not cross a sentence boundary. "I have a new user name and
// it password. Using iPhone" matched: username … password … "." … " " …
// "Using" — and a customer who had sent nothing of the kind was told off in
// front of the group for sharing their password.
const PAIRED =
  /\b(?:user(?:name)?|login)\b[^\n.!?]{0,20}\b(?:pass(?:word|wd)?|pwd)\b[^\n.!?]{0,10}[:=\s]([^\s,;.!?]{4,})/i;

// The captured value has to look like a credential rather than the next
// English word in the sentence. This was the whole bug: the patterns above
// matched the keyword followed by ANY four characters, so "it's let me login
// before", "my login doesn't work", "login details please" and "the password
// doesn't work" — four of the most ordinary support messages there are —
// each told a customer off for sending a password they had not sent, in
// public, and DMed the admin to go and change it for them.
//
// A real one has a digit, or mixed case, or a symbol. A password of plain
// lowercase letters slips through, and that is the right trade: the cost of
// a false positive is accusing a paying customer of something they did not
// do, over and over, and training them to ignore the one warning that
// matters.
function looksLikeAValue(raw) {
  const v = String(raw || '').replace(/[.?!,;:'")\]]+$/, '');
  if (v.length < 4) return false;
  // "password is wrong" / "login doesnt work" — the sentence carrying on.
  if (/^(?:is|was|are|were|been|the|my|your|our|their|not|isnt|isn'?t|dont|don'?t|doesnt|doesn'?t|wont|won'?t|cant|can'?t|didnt|didn'?t|and|but|or|for|with|from|into|onto|that|this|they|them|it|its|it'?s|again|before|after|now|then|today|tonight|yesterday|tomorrow|please|plz|details?|detail|info|information|page|screen|button|box|form|field|error|issue|issues|problem|problems|broken|working|work|works|worked|failed|failing|fails|invalid|incorrect|wrong|correct|right|fine|okay|still|just|only|also|very|really|here|there|back|out|down|keeps|keep|says|saying|wouldnt|wouldn'?t|changed|change|reset|forgot|forgotten|lost|need|needs|want|help|same|anymore|expired|accepted|rejected|refused)$/i.test(v)) {
    return false;
  }
  // Mixed case has to be INTERNAL. "Using" is a capitalised ordinary word at
  // the start of a sentence; "WEe7NdeF" and "myPass" are not.
  const internalCaps = /[a-z]/.test(v) && /[A-Z]/.test(v.slice(1));
  return /\d/.test(v) || internalCaps || /[^A-Za-z0-9]/.test(v);
}

function knownUsernames() {
  try {
    return db.prepare('SELECT username FROM customers').all().map((r) => String(r.username || '').toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

export function looksLikeCredentialDump(text) {
  const t = String(text || '');
  if (!t.trim() || t.length > 300) return false;
  const paired = t.match(PAIRED);
  if (paired && looksLikeAValue(paired[1])) return true;
  const labelled = t.match(LABELLED);
  if (labelled && looksLikeAValue(labelled[1])) return true;
  // "Georgewilliam1 WEe7NdeF" — a username on our books plus one more token,
  // and nothing else. Checked last because it needs a database read.
  const words = t.trim().split(/\s+/);
  if (words.length !== 2) return false;
  const names = knownUsernames();
  if (!names.length) return false;
  const first = words[0].toLowerCase();
  // The second token has to look like a password rather than a sentence: no
  // spaces (already true), long enough to be one, not a plain English word
  // the customer might have typed after their username.
  // The second token has to look like a password rather than an ordinary
  // word the customer typed after their username ("THM4821 firestick"), so
  // it needs both a digit and a letter. A password of plain words slips
  // through; that is the right trade, because the cost of a false positive
  // is lecturing someone about their own device name.
  const second = words[1];
  if (second.length < 6 || !/\d/.test(second) || !/[a-z]/i.test(second)) return false;
  return names.includes(first);
}

// What the bot says back. Written here, never by the model: the one thing it
// must not do is repeat the password while discussing it.
export const CREDENTIAL_WARNING =
  '🔒 Careful — that looks like your password, and you should never send it to anyone, including me.\n\n' +
  // {admin} already expands to "message @handle directly" — prefixing it with
  // another "message" produced "message message @ExclusiveDoctor directly".
  'I never need it: everything I do works without it. Delete that message if you can, then ' +
  '{admin} to get your password changed, just to be safe.\n\n' +
  // The message that carries a password usually carries a problem too — the
  // live one was "cant log in. username is X password is Y". The warning
  // answered the password half and dropped the other half, so the customer's
  // next message ("so what do i do") arrived with no context at all and got
  // the off-topic brush-off. The message itself can never go any further than
  // this function — it must not reach the model, the cache or the history —
  // so the only safe way to pick the thread back up is to ask for it again
  // without the password in it.
  'Now — what was it actually doing? Tell me that bit (no password needed) and I\'ll get it sorted.';
