import { db, now } from '../db/db.js';
import { getSetting, redactServiceUrls } from '../settings.js';
import { tokens, matchFaq } from '../faq/matcher.js';
import { conversationThreads } from '../conversations.js';
import { embed, cosine } from './embeddings.js';
import { composeFaqFromAnswer } from './client.js';

// The admin answers questions in the group all day. Those answers are the best
// knowledge the system will ever have — better than anything the model can
// infer — and until now they were recorded and never read.
//
// The existing suggestion sweep learns from FAILURES: questions the bot could
// not answer. It drafts from existing FAQs and leaves "[ADMIN: fill this in]"
// wherever the real answer needs something only the admin knows. This learns
// from SUCCESSES instead, so that gap is already filled.
//
// The risk runs the other way, though. A failure-driven draft can only be
// incomplete; an answer-driven draft can be *too specific* — one customer's
// download code, one person's expiry date, a handle — promoted into an entry
// every future customer is shown. So nothing is ever enabled automatically,
// and anything carrying per-person detail is flagged rather than quietly
// included.

const MIN_ANSWER_CHARS = 30;
const MIN_QUESTION_CHARS = 10;
const CLUSTER_SIMILARITY = 0.82;

// Flagged, not dropped: these are usually fine in context and the admin is the
// one who can tell. The panel shows the reason next to the draft.
const FLAGS = [
  [/\b\d{5,}\b/, 'contains a long number — check it is not one person\'s code'],
  [/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/, 'contains a date'],
  [/\b\d{1,2}(?:st|nd|rd|th)\b/i, 'contains a date'],
  [/@[a-z0-9_]{3,}/i, 'mentions a @handle'],
  [/[£$€]\s?\d/, 'quotes a price'],
  [/\byour (?:account|sub|subscription|access|plan|expiry|username|login)\b/i, 'talks about one person\'s account'],
];

// Dropped outright: an FAQ is shown to everyone, and no amount of admin review
// makes a credential or an email address belong in one.
const HARD_BLOCK = [
  [/[\w.+-]+@[\w-]+\.[a-z]{2,}/i, 'email address'],
  [/\b(?:user(?:name)?|login|pass(?:word)?)\s*[:=]\s*\S+/i, 'looks like credentials'],
];

export function reviewFlags(text) {
  const s = String(text || '');
  return [...new Set(FLAGS.filter(([re]) => re.test(s)).map(([, why]) => why))];
}

export function blockedReason(text) {
  const s = String(text || '');
  const hit = HARD_BLOCK.find(([re]) => re.test(s));
  return hit ? hit[1] : null;
}

// Is this exchange worth learning from at all? Most group traffic is not: a
// thumbs-up, "sorted mate", a one-word confirmation. Knowledge needs a real
// question and a real answer.
export function worthLearning(question, answer) {
  const q = String(question || '').trim();
  const a = String(answer || '').trim();
  if (q.length < MIN_QUESTION_CHARS || a.length < MIN_ANSWER_CHARS) return false;
  if (blockedReason(a)) return false;
  // An answer that is mostly a mention or an emoji carries no information.
  const words = a.replace(/@\S+/g, '').match(/[a-z0-9]{2,}/gi) || [];
  if (words.length < 6) return false;
  return true;
}

// Greedy clustering so the same question asked five different ways produces
// ONE draft (with an ask_count the admin can sort by) rather than five.
// Embeddings when they are available, shared vocabulary when they are not.
async function clusterCandidates(items) {
  const clusters = [];
  for (const item of items) {
    const vec = await embed(item.question);
    let placed = false;
    for (const c of clusters) {
      const similar = vec && c.vec
        ? cosine(vec, c.vec) >= CLUSTER_SIMILARITY
        : sharesVocabulary(item.question, c.items[0].question);
      if (similar) {
        c.items.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ vec, items: [item] });
  }
  return clusters.sort((a, b) => b.items.length - a.items.length);
}

function sharesVocabulary(a, b) {
  const ta = new Set(tokens(a));
  const shared = tokens(b).filter((t) => ta.has(t));
  return shared.length >= 2 || shared.some((t) => t.length >= 6);
}

// Every question in a thread the admin replied to, within the window.
export function adminAnsweredThreads({ sinceDays = 14, limit = 400 } = {}) {
  const since = now() - sinceDays * 86400;
  const out = [];
  for (const t of conversationThreads({ since, limit })) {
    if (t.asked_by_admin) continue; // the admin talking to themselves is not a question
    for (const a of t.answers) {
      if (a.from !== 'admin') continue;
      if (!worthLearning(t.question, a.text)) continue;
      out.push({ question: t.question, answer: a.text, ts: t.ts });
      break; // one answer per question is enough to draft from
    }
  }
  return out;
}

export async function harvestAdminAnswers({ sinceDays = 14, maxDrafts = 5 } = {}) {
  const candidates = adminAnsweredThreads({ sinceDays });
  if (!candidates.length) return [];

  const faqs = db.prepare('SELECT * FROM faqs WHERE enabled = 1').all();
  const pending = db.prepare("SELECT question, answer, keywords FROM suggested_faqs WHERE status = 'pending'").all()
    .map((s) => ({ ...s, enabled: 1 }));

  const created = [];
  for (const cluster of await clusterCandidates(candidates)) {
    if (created.length >= maxDrafts) break;
    const sample = cluster.items[0];
    // Already answerable, or already waiting in the queue? Leave it alone.
    if (matchFaq(sample.question, faqs, 0.5).match) continue;
    if (pending.length && matchFaq(sample.question, pending, 0.45).match) continue;

    const pairs = cluster.items.slice(0, 4).map((i) => ({ question: i.question, answer: i.answer }));
    let draft = null;
    if (getSetting('ai.enabled')) {
      try {
        draft = await composeFaqFromAnswer(pairs);
      } catch {
        // AI down — the admin's own words are a perfectly good fallback.
      }
    }
    // The model judged this exchange too person-specific to generalise. Drop
    // the cluster: falling back to the verbatim answer here would publish the
    // very thing it refused to reuse.
    if (draft?.skip) continue;
    if (!draft) {
      draft = {
        question: sample.question.slice(0, 300),
        answer: sample.answer.slice(0, 2500),
        keywords: [...new Set(tokens(sample.question))].slice(0, 10).join(', '),
      };
    }

    // Redact last, over whatever the model produced as well as the fallback.
    const answer = redactServiceUrls(draft.answer);
    if (blockedReason(answer)) continue;
    // Flags are raised against the SOURCE answers too: the model is told to
    // generalise, and a draft that quietly dropped a date is still worth the
    // admin's eye on the original.
    const flags = [...new Set([
      ...reviewFlags(answer),
      ...pairs.flatMap((p) => reviewFlags(p.answer)),
    ])];

    const info = db.prepare(
      'INSERT INTO suggested_faqs (question, answer, keywords, ask_count, samples, status, source, needs_review, created_at) ' +
      "VALUES (?, ?, ?, ?, ?, 'pending', 'admin-answer', ?, ?)"
    ).run(
      redactServiceUrls(draft.question).slice(0, 300),
      answer.slice(0, 2500),
      String(draft.keywords || '').slice(0, 300),
      cluster.items.length,
      JSON.stringify(pairs.map((p) => p.question)).slice(0, 2000),
      flags.length ? flags.join('; ') : null,
      now()
    );
    pending.push({ question: draft.question, answer, keywords: draft.keywords, enabled: 1 });
    created.push({ id: info.lastInsertRowid, question: draft.question, flags });
  }
  return created;
}
