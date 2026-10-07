import { createHash } from 'node:crypto';
import { db, now } from '../db/db.js';
import { getSetting } from '../settings.js';

// Why embeddings at all, on a node that generates at a few tokens a second:
// an embedding is ONE forward pass over a short string, not an autoregressive
// generation. On the same CPU that needs minutes to write an answer, a
// question embeds in well under a second. So retrieval can be made much better
// without touching the part that is slow.
//
// What this replaces: keyword/trigram scoring, where two of an FAQ's keywords
// appearing anywhere in a message was enough to fire that FAQ as a canned
// answer. "Add" and "season" in a sentence about something else entirely would
// serve the VOD FAQ to someone who never asked about VOD.

const EMBED_TIMEOUT_MS = 30 * 1000;

const textHash = (s) => createHash('sha1').update(String(s)).digest('hex');

export const toBlob = (vec) => Buffer.from(new Float32Array(vec).buffer);
export const fromBlob = (buf) =>
  Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));

// Vectors from the same model have the same magnitude characteristics, so a
// plain cosine is the right comparison. Returns 0 for mismatched dimensions
// rather than throwing — that happens when the embedding model is switched and
// old vectors are still cached, and a 0 just means "no match, re-embed".
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function embeddingsEnabled() {
  return Boolean(getSetting('ai.embedEnabled')) && Boolean(getSetting('ai.embedModel'));
}

// Returns null — never throws — when embeddings are off, the model is not
// pulled, or the endpoint is down. Every caller falls back to keyword matching,
// so a missing embedding model degrades the bot instead of breaking it.
export async function embed(text) {
  if (!embeddingsEnabled()) return null;
  const input = String(text || '').trim();
  if (!input) return null;

  const baseUrl = String(getSetting('ai.baseUrl') || '').replace(/\/+$/, '');
  const apiKey = getSetting('ai.apiKey');
  const model = getSetting('ai.embedModel');
  if (!baseUrl) return null;

  try {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input: input.slice(0, 4000) }),
    });
    if (!res.ok) {
      lastEmbedError = `${res.status} from ${baseUrl}/embeddings — is "${model}" pulled? (ollama pull ${model})`;
      return null;
    }
    const data = await res.json();
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || !vec.length) {
      lastEmbedError = 'endpoint returned no embedding';
      return null;
    }
    lastEmbedError = null;
    return vec;
  } catch (err) {
    lastEmbedError = String(err.cause?.code || err.message || err);
    return null;
  }
}

let lastEmbedError = null;
export const embedStatus = () => ({ enabled: embeddingsEnabled(), lastError: lastEmbedError });

// ---- FAQ vectors ------------------------------------------------------------
// Embedded once and cached in SQLite, keyed by a hash of the text that was
// embedded. Editing an FAQ changes the hash, which re-embeds it on next use —
// no manual reindex to forget about.

const faqVecStmt = db.prepare('SELECT faq_id, hash, vector FROM faq_vectors');
const upsertVecStmt = db.prepare(
  'INSERT INTO faq_vectors (faq_id, hash, vector, model, ts) VALUES (?, ?, ?, ?, ?) ' +
  'ON CONFLICT(faq_id) DO UPDATE SET hash = excluded.hash, vector = excluded.vector, model = excluded.model, ts = excluded.ts'
);

// An FAQ is matched on its question AND its keywords: the admin's keywords are
// real signal about how customers phrase it, they were just being used as a
// trigger instead of as context.
const faqText = (f) => [f.question, f.keywords || ''].filter(Boolean).join(' — ');

export async function ensureFaqVectors(faqs) {
  if (!embeddingsEnabled()) return new Map();
  const cached = new Map();
  for (const row of faqVecStmt.all()) cached.set(row.faq_id, row);

  const out = new Map();
  for (const f of faqs) {
    const hash = textHash(faqText(f));
    const hit = cached.get(f.id);
    if (hit && hit.hash === hash) {
      out.set(f.id, fromBlob(hit.vector));
      continue;
    }
    const vec = await embed(faqText(f));
    if (!vec) continue; // endpoint down — caller falls back to keywords
    upsertVecStmt.run(f.id, hash, toBlob(vec), getSetting('ai.embedModel'), now());
    out.set(f.id, vec);
  }
  return out;
}

// Top-k FAQs by semantic similarity. Returns [] when embeddings are
// unavailable, which is the caller's signal to fall back to keyword matching.
// `qVec` lets a caller that already embedded the question (the answer cache
// checks first) reuse it, so a question is embedded once per message.
export async function retrieveFaqs(question, faqs, { k = 6, floor = 0.35, qVec = null } = {}) {
  if (!embeddingsEnabled() || !faqs.length) return [];
  const vec = qVec ?? (await embed(question));
  if (!vec) return [];
  const vectors = await ensureFaqVectors(faqs);
  if (!vectors.size) return [];

  return faqs
    .map((f) => ({ faq: f, score: cosine(vec, vectors.get(f.id)) }))
    .filter((x) => x.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function forgetFaqVector(faqId) {
  db.prepare('DELETE FROM faq_vectors WHERE faq_id = ?').run(faqId);
}
