// Fuzzy FAQ matching: normalized token overlap against the stored question,
// character-trigram similarity to survive typos, and a strong boost for
// admin-defined keywords. Pure functions — no DB access — so it's unit-testable.

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'he', 'she', 'they', 'them',
  'this', 'that', 'these', 'those', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from',
  'and', 'or', 'but', 'not', 'no', 'so', 'if', 'then', 'than', 'as', 'by', 'about',
  'what', 'when', 'where', 'why', 'how', 'which', 'who', 'can', 'could', 'should',
  'would', 'will', 'shall', 'may', 'might', 'have', 'has', 'had', 'get', 'got', 'there',
  'here', 'just', 'please', 'pls', 'hi', 'hello', 'hey', 'thanks', 'thank', 'anyone',
  'any', 'some', 'im', 'ive', 'dont', 'cant', 'wont', 'guys', 'help', 'need', 'someone',
]);

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(text) {
  return normalize(text).split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function trigrams(text) {
  const s = `  ${normalize(text)} `;
  const grams = new Set();
  for (let i = 0; i < s.length - 2; i++) grams.add(s.slice(i, i + 3));
  return grams;
}

function dice(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  return (2 * inter) / (setA.size + setB.size);
}

// Token-level typo tolerance: "bufering" should count as "buffering".
function tokensMatch(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 3) return false;
  // A token embedded at the END of a longer one is a different word, not a
  // typo — extra leading characters change meaning ("iphone" vs "phone").
  // Trailing morphology (install/installer/installing) stays fuzzy-matchable.
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer !== shorter && longer.endsWith(shorter) && !longer.startsWith(shorter)) return false;
  return dice(trigrams(a), trigrams(b)) >= 0.55;
}

function fuzzyIntersection(qTokens, targetTokens) {
  let count = 0;
  for (const q of qTokens) {
    for (const t of targetTokens) {
      if (tokensMatch(q, t)) {
        count++;
        break;
      }
    }
  }
  return count;
}

export function scoreFaq(query, faq) {
  const qTokens = new Set(tokens(query));
  const fTokens = new Set(tokens(faq.question));
  const kwTokens = new Set(tokens(faq.keywords || ''));

  const overlap = fuzzyIntersection(qTokens, fTokens);
  const union = qTokens.size + fTokens.size - overlap;
  const tokenScore = union ? overlap / union : 0;
  const trigramScore = dice(trigrams(query), trigrams(faq.question));

  const keywordHits = fuzzyIntersection(qTokens, kwTokens);
  const keywordScore = kwTokens.size ? Math.min(1, keywordHits / Math.min(kwTokens.size, Math.max(1, qTokens.size))) : 0;

  // Guard against coincidental character similarity: demand real shared
  // vocabulary (or a keyword hit) before a match can count at all.
  const hasAnchor = keywordHits > 0 || overlap >= 2 || (overlap >= 1 && qTokens.size <= 2);
  if (!hasAnchor) return { score: 0, keywordHits, overlap };

  // Two or more admin-chosen keywords matching is near-conclusive evidence —
  // worth a flat bonus on top of the proportional keyword score.
  const multiKeywordBonus = keywordHits >= 2 ? 0.15 : 0;
  const score = Math.min(1, 0.45 * tokenScore + 0.3 * trigramScore + 0.5 * keywordScore + multiKeywordBonus + (faq.priority || 0) * 0.01);
  return { score, keywordHits, overlap };
}

// Returns { match, score, scores } — match is null when nothing clears the
// threshold or the winner doesn't beat the runner-up by a clear margin.
export function matchFaq(query, faqs, threshold = 0.5) {
  const scores = faqs
    .filter((f) => f.enabled === undefined || f.enabled)
    .map((faq) => ({ faq, ...scoreFaq(query, faq) }))
    .sort((a, b) => b.score - a.score);

  if (!scores.length) return { match: null, score: 0, scores };
  const [best, second] = scores;
  const margin = second ? best.score - second.score : 1;
  const clearsThreshold = best.score >= threshold && (margin >= 0.05 || best.score >= 0.75);
  // Admin-curated keywords are deliberate triggers: two or more hits with a
  // clear lead over the runner-up is a match even below the blended threshold
  // ("can you add the new season of X" → VOD FAQ via keywords add + season).
  const strongKeywords =
    best.keywordHits >= 2 &&
    best.score >= 0.3 &&
    (!second || best.keywordHits > (second.keywordHits || 0) || margin >= 0.05);
  if (clearsThreshold || strongKeywords) {
    return { match: best.faq, score: best.score, scores };
  }
  return { match: null, score: best.score, nearMiss: best.score >= threshold * 0.6 ? best.faq : null, scores };
}
