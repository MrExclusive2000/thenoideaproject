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
  /\b(?:pass(?:word|wd)?|pwd|login|log-?in|credentials)\b\s*(?:is|was|=|:|-)?\s*[^\s,;]{4,}/i;

// "username and password are X and Y" / "user: X pass: Y"
const PAIRED =
  /\b(?:user(?:name)?|login)\b[^\n]{0,20}\b(?:pass(?:word|wd)?|pwd)\b[^\n]{0,10}[:=\s][^\s,;]{4,}/i;

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
  if (PAIRED.test(t) || LABELLED.test(t)) return true;
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
  '{admin} to get your password changed, just to be safe.';
