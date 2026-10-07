import { db, now } from './db/db.js';
import { getSetting } from './settings.js';

// The service runs on an Xtream Codes panel, which already knows the two
// things no public API can tell us: which channels THIS service carries, and
// what is on them. "What channel is the F1 on?" is a question about our own
// lineup, so a sports API would be answering a different question.
//
// SECURITY: the lookup account's password is a credential. It goes in the
// query string because that is the API's design, so nothing here may log a
// request URL, put one in an error message, or let one reach the model. Error
// text is written by hand rather than passed through from fetch for exactly
// that reason.

const TIMEOUT_MS = 20 * 1000;

export function xcAccount(service = 1) {
  const n = service === 2 ? 2 : 1;
  return {
    url: String(getSetting(`services.url${n}`) || '').trim().replace(/\/+$/, ''),
    username: String(getSetting(`services.xcUser${n}`) || '').trim(),
    password: String(getSetting(`services.xcPass${n}`) || '').trim(),
  };
}

export const xcConfigured = (service = 1) => {
  const a = xcAccount(service);
  return Boolean(a.url && a.username && a.password);
};

// Returns parsed JSON, or null. Never throws, never surfaces the URL.
async function call(service, params) {
  const a = xcAccount(service);
  if (!a.url || !a.username || !a.password) return null;
  const qs = new URLSearchParams({ username: a.username, password: a.password, ...params });
  try {
    const res = await fetch(`${a.url}/player_api.php?${qs}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      lastError = `panel returned ${res.status}`;
      return null;
    }
    const data = await res.json();
    // A wrong username or password answers 200 with {"user_info":{"auth":0}}
    // rather than an error status, so a bad login looks like success.
    if (data && data.user_info && Number(data.user_info.auth) === 0) {
      lastError = 'panel rejected the lookup username or password';
      return null;
    }
    lastError = null;
    return data;
  } catch (err) {
    lastError = /timeout|aborted/i.test(String(err.message))
      ? 'panel did not respond in time'
      : 'could not reach the panel';
    return null;
  }
}

let lastError = null;
export const xcLastError = () => lastError;

// ---- channel lineup ---------------------------------------------------------

const upsert = db.prepare(
  'INSERT INTO xc_channels (service, stream_id, name, category, epg_channel_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(service, stream_id) DO UPDATE SET name = excluded.name, category = excluded.category, ' +
  'epg_channel_id = excluded.epg_channel_id, updated_at = excluded.updated_at'
);

export async function refreshChannels(service = 1) {
  const cats = await call(service, { action: 'get_live_categories' });
  const streams = await call(service, { action: 'get_live_streams' });
  if (!Array.isArray(streams)) return { ok: false, error: lastError || 'no channel list returned' };

  const categoryName = new Map(
    (Array.isArray(cats) ? cats : []).map((c) => [String(c.category_id), String(c.category_name || '')])
  );
  const t = now();
  // Replace the service's rows wholesale rather than upserting and sweeping
  // whatever looks stale. A timestamp sweep silently keeps dropped channels
  // whenever two refreshes land in the same second, and the bot then sends
  // someone to a channel that no longer exists. Inside a transaction, readers
  // see either the old lineup or the new one, never an empty one.
  const write = db.transaction(() => {
    db.prepare('DELETE FROM xc_channels WHERE service = ?').run(service);
    for (const s of streams) {
      if (!s?.stream_id || !s?.name) continue;
      upsert.run(
        service, Number(s.stream_id), String(s.name).slice(0, 300),
        categoryName.get(String(s.category_id)) || null,
        s.epg_channel_id ? String(s.epg_channel_id).slice(0, 200) : null,
        t
      );
    }
  });
  write();
  return { ok: true, count: db.prepare('SELECT COUNT(*) n FROM xc_channels WHERE service = ?').get(service).n };
}

export function channelCount(service = 1) {
  return db.prepare('SELECT COUNT(*) n FROM xc_channels WHERE service = ?').get(service).n;
}

export function channelsUpdatedAt(service = 1) {
  return db.prepare('SELECT MAX(updated_at) t FROM xc_channels WHERE service = ?').get(service).t || 0;
}

// Words that appear in half the lineup and so say nothing about which channel
// someone means. Without this, "what channel is the F1 on" matches every
// "SPORTS: ..." entry on the word "sport".
const NOISE = new Set(['uk', 'hd', 'fhd', 'sd', '4k', 'tv', 'channel', 'the', 'on', 'is', 'what', 'whats', 'for', 'a', 'in']);

// Find channels whose NAME matches the words in a question. Deliberately
// name-only and capped: the result is injected into the prompt, and a prompt
// carrying 200 channel names is both slow and useless.
export function findChannels(query, { service = 1, limit = 8 } = {}) {
  const words = String(query || '').toLowerCase().match(/[a-z0-9+]{2,}/g) || [];
  const terms = words.filter((w) => !NOISE.has(w));
  if (!terms.length) return [];

  const rows = db.prepare('SELECT stream_id, name, category FROM xc_channels WHERE service = ?').all(service);
  const scored = [];
  for (const r of rows) {
    const name = String(r.name).toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (name.includes(t)) score += t.length >= 4 ? 2 : 1;
    }
    if (score) scored.push({ ...r, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length).slice(0, limit);
}

// ---- what's on --------------------------------------------------------------

const decodeMaybeBase64 = (v) => {
  const s = String(v || '');
  if (!s) return '';
  // The panel base64-encodes EPG titles and descriptions.
  try {
    const out = Buffer.from(s, 'base64').toString('utf8');
    return /[\x00-\x08\x0e-\x1f]/.test(out) ? s : out;
  } catch {
    return s;
  }
};

export async function shortEpg(streamId, { service = 1, limit = 4 } = {}) {
  const data = await call(service, { action: 'get_short_epg', stream_id: String(streamId), limit: String(limit) });
  const listings = data?.epg_listings;
  if (!Array.isArray(listings)) return [];
  return listings.slice(0, limit).map((l) => ({
    title: decodeMaybeBase64(l.title).slice(0, 200),
    description: decodeMaybeBase64(l.description).slice(0, 300),
    start: String(l.start || ''),
    end: String(l.end || ''),
  })).filter((l) => l.title);
}

// ---- grounding for the model ------------------------------------------------
// Returns a short block of REAL lineup/EPG facts for the question, or null.
// Only the handful of matching channels go in: the model needs the few that
// answer the question, not a dump of the lineup, which would cost a minute of
// prompt reading on a CPU node and bury the answer.

const CHANNEL_QUESTION = /\b(what|which|where)\b.{0,40}\b(channel|watch|showing|on)\b|\bis\s+(the\s+)?\w+\s+on\b|\bwhat'?s\s+on\b|\bchannel\s+(for|number)\b/i;

export const looksLikeChannelQuestion = (text) =>
  CHANNEL_QUESTION.test(String(text || '')) && String(text || '').length < 160;

const hhmm = (raw) => {
  const m = String(raw || '').match(/\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/);
  return m ? m[1] : '';
};

export async function channelGrounding(question, { service = 1 } = {}) {
  if (!xcConfigured(service)) return null;
  const hits = findChannels(question, { service, limit: 6 });
  if (!hits.length) return null;

  const lines = ['Channels in OUR lineup matching what they asked about (these names are exact — use them as written):'];
  for (const h of hits) lines.push(`- ${h.name}${h.category ? ` — ${h.category}` : ''}`);

  // Only the best match gets a listing: one EPG call, and "what's on" almost
  // always means the channel they named.
  const epg = await shortEpg(hits[0].stream_id, { service, limit: 3 });
  if (epg.length) {
    lines.push('', `What the guide shows next on ${hits[0].name}:`);
    for (const e of epg) lines.push(`- ${hhmm(e.start)} ${e.title}`.trim());
    lines.push('(These times come straight from the channel guide.)');
  }
  return lines.join('\n');
}
