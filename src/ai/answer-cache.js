import { db, now } from '../db/db.js';
import { getSetting } from '../settings.js';
import { embed, cosine, toBlob, fromBlob, embeddingsEnabled } from './embeddings.js';

// Support groups are extremely repetitive: the same twenty questions, phrased
// twenty different ways, forever. Keyword FAQs tried to exploit that and fired
// on the wrong question constantly. This does the same job on meaning instead:
// an answer the model already wrote is reused when a new question means
// essentially the same thing.
//
// This is what makes "the AI answers everything" affordable on a CPU node. It
// does not make a cache MISS any faster — a genuine new question still costs
// the full generation — it just stops the node re-deriving an answer it has
// already written.

const MAX_ENTRIES = 2000;

// A cached answer is only reusable if it did not depend on anything outside
// the question itself. An answer shaped by conversation history, by a specific
// playback context, or by this user's service/account is correct for that user
// and wrong for the next one, so it is never stored.
export function cacheable({ history = [], grounding = null, playback = null, secondRound = false, smallTalk = false } = {}) {
  return !history.length && !grounding && !playback && !secondRound && !smallTalk;
}

export function cacheEnabled() {
  return Boolean(getSetting('ai.cacheEnabled')) && embeddingsEnabled();
}

const threshold = () => {
  const v = Number(getSetting('ai.cacheThreshold'));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.95;
};

const maxAgeSeconds = () => (Number(getSetting('ai.cacheMaxAgeDays')) || 30) * 86400;

// Editing an FAQ or a guide changes the knowledge an answer was written from,
// so every answer older than that edit is suspect. Deriving the cutoff from
// the knowledge tables means invalidation cannot be forgotten at a call site —
// including call sites added later.
const knowledgeChangedAt = () => db.prepare(
  'SELECT MAX(t) t FROM (SELECT MAX(updated_at) t FROM faqs UNION ALL SELECT MAX(updated_at) t FROM guides)'
).get().t || 0;

// Returns { id, answer, score } for a near-identical question, or null.
// Takes a pre-computed vector when the caller already embedded the question
// (the retrieval path does), so a cache hit costs no extra embedding call.
export async function lookupAnswer(question, qVec = null) {
  if (!cacheEnabled()) return null;
  const vec = qVec ?? (await embed(question));
  if (!vec) return null;

  const floor = Math.max(now() - maxAgeSeconds(), knowledgeChangedAt());
  const rows = db.prepare(
    'SELECT id, answer, vector FROM answer_cache WHERE created_at >= ?'
  ).all(floor);
  if (!rows.length) return null;

  let best = null;
  for (const r of rows) {
    const score = cosine(vec, fromBlob(r.vector));
    if (!best || score > best.score) best = { id: r.id, answer: r.answer, score };
  }
  if (!best || best.score < threshold()) return null;

  db.prepare('UPDATE answer_cache SET hits = hits + 1, last_hit_at = ? WHERE id = ?').run(now(), best.id);
  return best;
}

export async function rememberAnswer(question, answer, { source = 'ai', vector = null } = {}) {
  if (!cacheEnabled()) return null;
  const text = String(answer || '').trim();
  if (!text) return null;
  const vec = vector ?? (await embed(question));
  if (!vec) return null;

  const info = db.prepare(
    'INSERT INTO answer_cache (question, vector, answer, source, hits, created_at, last_hit_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
  ).run(String(question).slice(0, 1000), toBlob(vec), text.slice(0, 4000), source, now(), now());

  // Keep the table bounded. Least-used first, oldest breaking the tie: an
  // entry nobody has hit is the one worth losing.
  const count = db.prepare('SELECT COUNT(*) n FROM answer_cache').get().n;
  if (count > MAX_ENTRIES) {
    db.prepare(
      'DELETE FROM answer_cache WHERE id IN (SELECT id FROM answer_cache ORDER BY hits ASC, created_at ASC LIMIT ?)'
    ).run(count - MAX_ENTRIES);
  }
  return info.lastInsertRowid;
}

// A thumbs-down means the answer was wrong — serving it to the next person who
// asks the same thing would repeat the mistake, so drop it immediately.
export function forgetAnswer(id) {
  if (id) db.prepare('DELETE FROM answer_cache WHERE id = ?').run(id);
}

export function forgetAnswerByText(answerText) {
  const text = String(answerText || '').trim();
  if (!text) return 0;
  return db.prepare('DELETE FROM answer_cache WHERE answer = ?').run(text.slice(0, 4000)).changes;
}

// Editing the knowledge invalidates answers written from the old knowledge.
export function clearAnswerCache() {
  return db.prepare('DELETE FROM answer_cache').run().changes;
}

export function answerCacheStats() {
  const row = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(hits), 0) hits FROM answer_cache').get();
  return { entries: row.n, hits: row.hits };
}
