import { db } from './db/db.js';
import { tokens, tokensMatch } from './faq/matcher.js';

// Asking the bot for a guide used to be the one request it reliably failed.
// Guides reached the prompt only when a word of four or more characters from
// the TITLE appeared in the question, so "can I have the payment guide?"
// matched nothing ("payment" is not "pay") and "send me the guide" matched
// nothing at all. The model was then holding an FAQ saying "full walkthrough
// is in the Firestick guide" and no Firestick guide, so it did the only
// honest thing left and pointed at a document it could not see — and when
// pushed, said it had no access to it. Both are true from where it was
// sitting. The fix is to stop asking the model: a request for a guide is
// answered by sending the guide.

// Words that say "give me the thing" rather than naming which thing.
const ASKING = /\b(guide|walkthrough|walk\s?through|instructions|tutorial|steps|how\s?to)\b/i;
const SEND = /\b(send|share|give|show|post|have|get|link|copy|see|read|want|need)\b/i;

export function looksLikeGuideRequest(text) {
  const s = String(text || '');
  if (s.length > 200) return false;
  if (!ASKING.test(s)) return false;
  // "the guide says to clear the cache" is a statement, not a request.
  return SEND.test(s) || /\?\s*$/.test(s) || /^\s*(guide|guides|instructions)\b/i.test(s);
}

// Topic words that should pull a particular guide even though they appear
// nowhere in its title. These are the words customers actually use.
const TOPIC_HINTS = {
  'install-firestick': ['firestick', 'fire', 'stick', 'downloader', 'download', 'code', 'amazon', 'tv', 'sideload', 'skyglass', 'sky', 'glass', 'purple'],
  'install-android': ['android', 'phone', 'tablet', 'apk', 'mobile', 'samsung', 'aftv', 'browser'],
  'install-ios': ['ios', 'iphone', 'ipad', 'apple', 'smarters', 'lite'],
  // No request verbs in here. "send" was, because the guide says "send it to
  // us" — and that alone made "can you send me the guide" the payment guide,
  // beating the one the customer was actually talking about.
  'pay-with-crypto': ['pay', 'payment', 'paying', 'crypto', 'litecoin', 'ltc', 'bitcoin', 'btc', 'wallet', 'exodus', 'moonpay', 'renew', 'renewal', 'money', 'price', 'cost'],
  'customer-panel': ['panel', 'portal', 'account'],
};

export function scoreGuide(qTokens, guide) {
  const hints = TOPIC_HINTS[guide.slug] || [];
  const target = [...tokens(guide.title), ...hints];
  let score = 0;
  for (const q of qTokens) {
    for (const t of target) {
      if (q === t || tokensMatch(q, t)) {
        // A long word is a much stronger signal than "tv" or "pay".
        score += Math.max(t.length, q.length) >= 5 ? 3 : 1;
        break;
      }
    }
  }
  return score;
}

// Which guide does this message want? `context` carries recent user messages
// so a bare "well can you send me the guide" still lands on the one the
// conversation was already about, which is exactly where it failed before.
// Returns null when nothing stands out — the caller then offers the list
// rather than guessing, because the wrong guide is worse than a menu.
export function findGuide(question, { context = [] } = {}) {
  const guides = db.prepare('SELECT id, title, slug, body_md FROM guides WHERE visible = 1 ORDER BY sort, id').all();
  if (!guides.length) return null;

  const direct = tokens(question);
  const scored = guides
    .map((g) => ({ guide: g, score: scoreGuide(direct, g) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0].score > 0 && scored[0].score > (scored[1]?.score || 0)) return scored[0].guide;

  // Nothing in the message itself picks one out. Fall back to what they were
  // just talking about, most recent message first.
  for (const earlier of context) {
    const ctxTokens = tokens(earlier);
    const byContext = guides
      .map((g) => ({ guide: g, score: scoreGuide(ctxTokens, g) }))
      .sort((a, b) => b.score - a.score);
    if (byContext[0].score > 0 && byContext[0].score > (byContext[1]?.score || 0)) return byContext[0].guide;
  }

  // One visible guide and an unambiguous request for "the guide" — there is
  // nothing to disambiguate.
  if (guides.length === 1 && scored[0].score === 0) return guides[0];
  return scored[0].score > 0 ? scored[0].guide : null;
}

export const visibleGuides = () =>
  db.prepare('SELECT id, title FROM guides WHERE visible = 1 ORDER BY sort, id LIMIT 20').all();

// Very small markdown → plain text for sending guides in chat. Lives here
// rather than in the command handler now that the answer pipeline sends
// guides too, and both must render them the same way.
export function mdToPlain(md) {
  return String(md)
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ''))
    .replace(/^#{1,6}\s+(.+)$/gm, (m, h) => `\n${h.toUpperCase()}\n`)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1: $2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/[*_`]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
