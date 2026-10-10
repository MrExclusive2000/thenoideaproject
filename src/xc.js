import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { db, now } from './db/db.js';
import { getSetting, setSetting } from './settings.js';

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
  // A panel mid-restart can answer 200 with an empty array. Taking that at
  // face value wipes a working lineup and the bot then answers no channel
  // question at all until the next sweep, which is up to a day away. An empty
  // list is only believed when there was nothing cached to lose.
  if (!streams.length && channelCount(service) > 0) {
    return { ok: false, error: 'panel returned an empty channel list — keeping the cached lineup' };
  }

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
// Words that must never pick a channel. The list started as the obvious
// lineup decoration and grew the day "what's on it tonight" came back
// "we carry UK: ITV2, UK: ITV1 HD, UK: MTV Hits" — "it" is two characters
// and every ITV channel contains them, so a pronoun chose the answer.
//
// Short words stay matchable on purpose (E4, S4C, 5USA are real channels),
// so the fix is naming the fillers rather than setting a length floor.
const NOISE = new Set([
  'uk', 'hd', 'fhd', 'sd', '4k', 'uhd', 'tv', 'channel', 'channels',
  'the', 'on', 'is', 'what', 'whats', 'for', 'a', 'an', 'in', 'at', 'of', 'to', 'by', 'up',
  'it', 'its', 'me', 'my', 'we', 'us', 'you', 'your', 'i', 'im', 'ive',
  'any', 'some', 'all', 'more', 'other', 'else', 'got', 'get', 'have', 'has', 'had',
  'are', 'am', 'be', 'do', 'does', 'did', 'can', 'could', 'would', 'will',
  'this', 'that', 'there', 'here', 'now', 'tonight', 'today', 'tomorrow', 'later', 'tonite',
  'please', 'pls', 'mate', 'bot', 'and', 'or', 'but', 'so', 'just', 'still', 'not', 'no', 'yes',
  'watch', 'watching', 'show', 'showing', 'see', 'find', 'know', 'tell', 'ask',
]);

// Find channels whose NAME matches the words in a question. Deliberately
// name-only and capped: the result is injected into the prompt, and a prompt
// carrying 200 channel names is both slow and useless.
// Lineups write the same channel as "BBC 1", "BBC1" and "BBC One", and
// customers use all three. The number is the entire point of the question —
// "bbc" on its own matches BBC One, Two, News, Scotland and fifty others, and
// the tiebreak then picks whichever has the shortest name.
const NUMBER_WORD = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };
const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// "(AR) TNT SPORTS" and "CL: TNT SPORTS FHD" carry a country tag. Only
// parenthesised or colon-suffixed forms count — "BBC ONE" would otherwise
// read as a country called BBC.
const tagOf = (name) => {
  const m = String(name).match(/^\s*(?:\(([A-Za-z]{2,3})\)|([A-Za-z]{2,3}):)/);
  return (m?.[1] || m?.[2] || '').toLowerCase();
};

// Whole-word containment, with the channel-name punctuation (|, :, parens,
// decorations) treated as a boundary like whitespace.
const wordIn = (haystack, needle) => {
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    const before = i === 0 ? '' : haystack[i - 1];
    const after = haystack[i + needle.length] ?? '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    i = haystack.indexOf(needle, i + 1);
  }
  return false;
};

export function findChannels(query, { service = 1, limit = 8 } = {}) {
  const raw = String(query || '').toLowerCase().match(/[a-z0-9+]+/g) || [];
  const terms = [];   // matched against the name as written
  const joined = [];  // matched against the name with punctuation squeezed out
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    const next = raw[i + 1];
    if (next && /^[a-z]{2,}$/.test(w) && /^\d{1,2}$/.test(next)) {
      joined.push(w + next);                                  // "bbc 1" -> bbc1
      if (NUMBER_WORD[next]) joined.push(w + NUMBER_WORD[next]); // and bbcone
    }
    // Already written as one word ("bbc1", "itv2"): same two forms.
    const together = w.match(/^([a-z]{2,})(\d{1,2})$/);
    if (together) {
      joined.push(w);
      if (NUMBER_WORD[together[2]]) joined.push(together[1] + NUMBER_WORD[together[2]]);
    }
    if (w.length >= 2 && !NOISE.has(w)) terms.push(w);
  }
  if (!terms.length && !joined.length) return [];

  // The meaningful words run together, for the phrase test below.
  const phrase = terms.join('');
  const rows = db.prepare('SELECT stream_id, name, category, epg_channel_id FROM xc_channels WHERE service = ?').all(service);
  const scored = [];
  for (const r of rows) {
    const name = String(r.name).toLowerCase();
    const flat = squash(name);
    let score = 0;
    for (const t of terms) {
      // On a word boundary. A plain substring test answered "any hunting
      // channels?" with "US NBC 3 (WSAZ) Huntington" and "US CBS 13 (WOWK)
      // Huntington" — two local news stations in West Virginia — because
      // "hunting" is inside "Huntington". On a 26,000-channel lineup that
      // kind of accident is not rare, it is constant.
      if (wordIn(name, t)) score += t.length >= 4 ? 2 : 1;
    }
    // A joined hit is the strong signal: it is the one that tells BBC One
    // apart from BBC Two, so it has to outweigh every loose word match.
    for (const j of joined) {
      if (flat.includes(j)) score += 6;
    }
    // The whole phrase, in order, is far stronger evidence than the sum of
    // its words — and the per-word score works against exactly the tokens
    // that pin a channel down. "sky sports f1" scored f1 at 1 (two
    // characters) against sports at 2, so "SKY Sports 1", "SKY sports 16"
    // and "SKY sports 21" came back alongside the F1 channel as though they
    // were just as good an answer.
    if (score && phrase && flat.includes(phrase)) score += 10;
    if (score) scored.push({ ...r, score });
  }

  // "Do you have TNT Sports?" came back leading with "(AR) TNT SPORTS". A
  // lineup this size carries the same brand for a dozen countries, and the
  // ones meant for somewhere else are tagged — "(AR) ", "CL: ".
  //
  // Judged WITHIN the results rather than against a fixed idea of home: a
  // tagged channel is demoted only when the set also holds an untagged one,
  // or one whose tag the question actually asked for. A lineup that prefixes
  // everything with "UK:" has no discriminator there and nothing is touched,
  // which is the case that matters — penalising a prefix every channel
  // carries would bury the whole lineup.
  const asked = (code) => code && new RegExp(`\\b${code}\\b`, 'i').test(query);
  const preferred = scored.some((r) => { const c = tagOf(r.name); return !c || asked(c); });
  if (preferred) {
    for (const r of scored) {
      const c = tagOf(r.name);
      if (c && !asked(c)) r.score -= 2;
    }
  }

  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, limit);
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

// How long a cached run of listings is served for. Long enough that a channel
// asked about repeatedly costs one call, short enough that the guide is still
// the guide. Overridable because a panel on a thin connection wants longer.
const epgTtlSeconds = () => Math.max(60, (Number(getSetting('services.epgCacheMinutes')) || 30) * 60);

// A cached run is also dropped early once everything in it has finished — a
// 20-minute TTL is too long for back-to-back half-hour shows and too short for
// a three-hour match. But only after this much time, so a panel reporting
// nonsense timestamps can't defeat the cache completely, which is the whole
// point of having one.
const MIN_CACHE_SECONDS = 10 * 60;

const readEpg = db.prepare('SELECT * FROM xc_epg WHERE service = ? AND stream_id = ?');
const writeEpg = db.prepare(
  'INSERT INTO xc_epg (service, stream_id, listings, last_end, fetched_at) VALUES (?, ?, ?, ?, ?) ' +
  'ON CONFLICT(service, stream_id) DO UPDATE SET listings = excluded.listings, ' +
  'last_end = excluded.last_end, fetched_at = excluded.fetched_at'
);

const parseListings = (row) => {
  try {
    const out = JSON.parse(row.listings);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
};

// How long a run may be held when the panel gave us NO stop_timestamp. With
// one, a long TTL is safe because the run expires the moment it finishes —
// that is what does the real work, and the TTL is just a backstop. Without
// one we cannot tell a finished run from a current one, and the TTL is the
// only thing standing between a customer and "next on Sky Sports: a match
// that ended yesterday". So a blind entry is held briefly whatever the
// setting says.
const BLIND_CACHE_SECONDS = 30 * 60;

function epgIsFresh(row, t) {
  const age = t - row.fetched_at;
  const blind = row.last_end <= 0;
  if (age >= (blind ? Math.min(epgTtlSeconds(), BLIND_CACHE_SECONDS) : epgTtlSeconds())) return false;
  if (age < MIN_CACHE_SECONDS) return true;
  // last_end is the panel's own epoch, so it needs no timezone guesswork —
  // but it is only trusted to SHORTEN the entry's life, never to extend it.
  return !(row.last_end > 0 && row.last_end <= t);
}

// Two customers asking about the same channel in the same breath must not
// both go to the panel. The second one waits on the first one's call.
const inFlight = new Map();

// A panel that just failed is not back a second later, and a failure costs the
// full request timeout. Without a pause, a panel that is down makes EVERY
// channel question wait twenty seconds before the bot answers without the
// guide. Scoped to this automatic path on purpose: an admin running /channels
// refresh always gets a real attempt, never a cached complaint.
const FAIL_BACKOFF_MS = 60 * 1000;
const failedUntil = new Map();
export const _resetXcBackoff = () => failedUntil.clear();

export async function shortEpg(streamId, { service = 1, limit = 4, force = false } = {}) {
  const id = Number(streamId);
  const t = now();
  const cached = readEpg.get(service, id);
  if (!force && cached && epgIsFresh(cached, t)) return parseListings(cached).slice(0, limit);
  if (!force && (failedUntil.get(service) || 0) > Date.now()) {
    return cached ? parseListings(cached).slice(0, limit) : [];
  }

  const key = `${service}:${id}`;
  if (inFlight.has(key)) return (await inFlight.get(key)).slice(0, limit);

  const job = (async () => {
    // Always fetch the same number of listings, whatever this caller wants to
    // show. Fetching `limit` would cache a 3-listing run and then silently
    // serve 3 to a caller asking for 8, and the cache would be the reason the
    // answer got shorter.
    const data = await call(service, { action: 'get_short_epg', stream_id: String(id), limit: '8' });
    if (data === null) {
      // The panel failed, which is not the same as "nothing is on". Serve the
      // stale run rather than nothing, and leave the cache as it was so a
      // blip doesn't erase a guide we already had.
      failedUntil.set(service, Date.now() + FAIL_BACKOFF_MS);
      return cached ? parseListings(cached) : [];
    }
    failedUntil.delete(service);
    // The panel answered. An empty guide IS an answer and gets cached, or
    // every question about a channel with no listings is a fresh call.
    const raw = Array.isArray(data.epg_listings) ? data.epg_listings : [];
    const listings = raw.map((l) => ({
      title: decodeMaybeBase64(l.title).slice(0, 200),
      description: decodeMaybeBase64(l.description).slice(0, 300),
      start: String(l.start || ''),
      end: String(l.end || ''),
    })).filter((l) => l.title);
    const lastEnd = raw.reduce((max, l) => Math.max(max, Number(l.stop_timestamp) || 0), 0);
    writeEpg.run(service, id, JSON.stringify(listings), lastEnd, t);
    return listings;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return (await job).slice(0, limit);
}

export function epgCacheStats(service = 1) {
  const r = db.prepare(
    'SELECT COUNT(*) n, MAX(fetched_at) t FROM xc_epg WHERE service = ?'
  ).get(service);
  return { channels: r.n, updatedAt: r.t || 0 };
}

// Channels that left the lineup keep no guide, and a run nobody has asked
// about in a week is not worth storing.
export function pruneEpgCache(maxAgeDays = 7) {
  const cutoff = now() - maxAgeDays * 86400;
  db.prepare('DELETE FROM xc_epg WHERE fetched_at < ?').run(cutoff);
  db.prepare(
    'DELETE FROM xc_epg WHERE NOT EXISTS (SELECT 1 FROM xc_channels c WHERE c.service = xc_epg.service AND c.stream_id = xc_epg.stream_id)'
  ).run();
}

// ---- grounding for the model ------------------------------------------------
// Returns a short block of REAL lineup/EPG facts for the question, or null.
// Only the handful of matching channels go in: the model needs the few that
// answer the question, not a dump of the lineup, which would cost a minute of
// prompt reading on a CPU node and bury the answer.

// "On Exclusive are there any hunting channels on Live TV" matched none of
// these — no what/which/where, no "is X on" — so no lineup went to the
// model and it answered from nothing: "Yes, hunting channels are available
// on the sports and PPV channels in Live TV." There is no such thing, and
// the customer went looking. The lineup was sitting in the database.
//
// Asking whether a KIND of channel exists is as much a lineup question as
// asking which number one is on, and it is the shape people use for
// anything not mainstream — hunting, fishing, Polish, racing, horror.
const CHANNEL_CATEGORY =
  /\b(?:any|some)\b[^.?!]{0,30}?\bchannels?\b|\b(?:are|is)\s+there\b[^.?!]{0,40}?\bchannels?\b|\b(?:do|does|have|has)\s+(?:you|yous|u|ya|we)\b[^.?!]{0,40}?\bchannels?\b/i;

const CHANNEL_QUESTION = /\b(what|which|where)\b.{0,40}\b(channel|watch|showing|on)\b|\bis\s+(the\s+)?\w+\s+on\b|\bwhat'?s\s+on\b|\bchannel\s+(for|number)\b/i;

// The category shape on its own. The pipeline needs to tell it apart from
// "what channel is BBC One": a generic FAQ can reasonably answer the second
// one, and can never answer the first — see the comment where it is used.
export const looksLikeChannelCategoryQuestion = (text) =>
  CHANNEL_CATEGORY.test(String(text || '')) && String(text || '').length < 160;

export const looksLikeChannelQuestion = (text) =>
  (CHANNEL_QUESTION.test(String(text || '')) || CHANNEL_CATEGORY.test(String(text || '')))
  && String(text || '').length < 160;

const hhmm = (raw) => {
  const m = String(raw || '').match(/\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/);
  return m ? m[1] : '';
};

const timeOfDay = (ts) => {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// What is on ONE named channel, straight from the guide already downloaded.
//
// findProgrammes searches programme TITLES, which answers "who's playing
// Derby tonight" but nothing at all for "what's on BBC One" — a channel name
// matches no programme name, so the whole 213,000-row guide sat there while
// the bot told the customer to go and look in the app themselves. This reads
// the rows for that channel instead: local, instant, and no API call.
export function programmesOnChannel(service, epgChannelId, { limit = 4, from = null } = {}) {
  if (!epgChannelId) return [];
  const t = from ?? now();
  return db.prepare(`
    SELECT title, start_ts, stop_ts
    FROM xc_programmes
    WHERE service = ? AND channel_id = ? AND stop_ts > ?
    ORDER BY start_ts
    LIMIT ?
  `).all(service, epgChannelId, t, limit);
}

// Panels decorate names with unicode letterforms — "Sports Desk ᴸᴵᵛᴱ", "BBC
// One ᴴᴰ". They render as mangled little capitals in Telegram and the model
// repeats them verbatim because it is told to use the names exactly. NFKD maps
// those modifier letters back to plain ASCII.
export function cleanTitle(text) {
  const raw = String(text || '');
  const flat = raw.normalize('NFKD').replace(/\s+/g, ' ').trim();
  // A decorated tag comes back mixed-case because the panel mixes modifier
  // capitals and smalls — "Sports Desk ᴸᴵᵛᴱ" flattens to "Sports Desk LIvE".
  // When the original WAS decorated, the tag is panel decoration rather than
  // part of the programme's name, so it goes.
  if (flat !== raw.replace(/\s+/g, ' ').trim()) {
    return flat.replace(/[\s|•·-]*\b(?:live|new|hd|fhd|uhd|4k)\b[\s|•·-]*$/i, '').trim() || flat;
  }
  return flat;
}

// SD, HD and FHD of the same channel are three rows in the lineup and ONE
// channel to a customer. Left alone, "what's on Sky Sports News" fetched
// listings for all three and the answer came back "The current show on Sky
// Sports News SD, HD, and FHD is...", and "what's on bbc 1" turned into a
// paragraph repeating the same programme three times. "+1" is deliberately
// NOT stripped: an hour behind is a different channel.
// Real lineups also label the frame rate and decorate with superscripts, so
// "Sky Sports Main Event FHD" and "Sky Sports Main Event FHD 50FPS" came
// back as two channels and the customer got the same one twice.
const VARIANT_WORDS =
  /\b(?:sd|hd|fhd|uhd|4k|8k|hevc|h265|h\.265|raw|vip|backup|alt|multi|low|lq|hq|\d{2,3}\s?fps)\b|[\u1D2C-\u1D6A\u2070-\u209F\u25A0-\u25FF\u2600-\u27BF]/gi;

export function baseChannelName(name) {
  return cleanTitle(name)
    .replace(/[|[\]()]/g, ' ')
    .replace(VARIANT_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// One row per real channel, keeping whichever matched best — the name shown is
// still a real one from the lineup, because that is what they will see in the
// app when they go looking for it.
export function dedupeVariants(rows) {
  const seen = new Map();
  // Every variant scores the same, so first-past-the-post handed back whatever
  // the panel happened to list first — usually the SD one, which is the one
  // nobody watches. Prefer the better picture when the match is just as good.
  const rank = (name) => {
    const n = String(name).toUpperCase();
    if (/\bFHD\b/.test(n)) return 0;
    if (/\b(?:UHD|4K)\b/.test(n)) return 1;
    if (/\bHD\b/.test(n)) return 2;
    if (/\bSD\b/.test(n)) return 4;
    return 3; // unlabelled: a real name, better than SD
  };
  for (const r of rows) {
    const key = baseChannelName(r.name);
    if (!key) continue;
    const held = seen.get(key);
    if (!held || (r.score ?? 0) > (held.score ?? 0)
        || ((r.score ?? 0) === (held.score ?? 0) && rank(r.name) < rank(held.name))) {
      seen.set(key, r);
    }
  }
  return [...seen.values()];
}

// The same programme on the SD/HD/FHD rows of one channel is one listing.
// "What's on" matched a title across all three and the answer named each.
function dedupeProgrammeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const p of rows) {
    const key = `${baseChannelName(p.channel)}|${cleanTitle(p.title).toLowerCase()}|${p.start_ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// Channels by CATEGORY, for "have you got any kids channels?".
//
// findChannels searches names, which is right for "what channel is BBC One"
// and useless for a genre: not one of CBeebies, Nick Jr or Cartoon Network
// has "kids" in its name, and the lineup files all three under "UK | KIDS".
// Simulated against a real two-service lineup, every genre question came
// back "I don't have a listing for that" while the channels sat in the
// table — the honest-sounding version of the same wrong answer the model
// used to invent.
//
// Separate from findChannels on purpose. Folding categories into the name
// search would make "sky sports" match all forty channels filed under
// SPORTS and bury the one they asked for.
const CATEGORY_NOISE = new Set([
  'any', 'some', 'channel', 'channels', 'got', 'have', 'you', 'there', 'are', 'is', 'the', 'on',
  'live', 'tv', 'do', 'we', 'us', 'mate', 'please', 'uk', 'hd', 'all', 'other', 'more', 'bot',
]);

export function findChannelsByCategory(query, { service = 1, limit = 8 } = {}) {
  const words = (String(query || '').toLowerCase().match(/[a-z]{3,}/g) || [])
    .filter((w) => !CATEGORY_NOISE.has(w));
  if (!words.length) return [];
  const rows = db.prepare(
    'SELECT stream_id, name, category, epg_channel_id FROM xc_channels WHERE service = ? AND category IS NOT NULL'
  ).all(service);
  const scored = [];
  for (const r of rows) {
    const cat = String(r.category).toLowerCase();
    // Matched on a prefix, because the word and the category label are
    // almost never the same shape: "documentary" has to find
    // "DOCUMENTARIES", "movie" has to find "MOVIES", "kid" has to find
    // "KIDS". Suffix stripping gets the plurals and misses the y/ies pair,
    // which is the one that matters most here.
    const hit = words.some((w) => cat.includes(w) || cat.includes(w.slice(0, 6)));
    if (hit) scored.push(r);
  }
  return scored.slice(0, limit);
}

export async function channelGrounding(question, { service = 1 } = {}) {
  if (!xcConfigured(service)) return null;
  const lines = [];

  // Searching the WHOLE guide by title is what answers "who's playing Derby
  // tonight?" and "what channel is the Arsenal game on?" — questions where
  // the channel is the answer, not part of the question.
  // When the customer NAMED a channel, searching every programme title as
  // well is noise: "what's on sky sports news" matched "BBC News at Six" on
  // the word "news" and offered it up as a listing. The title search exists
  // for the opposite case — "who's playing Derby tonight", where the channel
  // is the answer rather than the question.
  const namedChannels = dedupeVariants(findChannels(question, { service, limit: 12 }));
  // Compared squashed and with the number spelled both ways, because people
  // type "bbc 1" for a channel the panel calls "BBC ONE".
  const WORD_NUMBER = { one: '1', two: '2', three: '3', four: '4', five: '5' };
  const askedKey = squash(baseChannelName(question));
  const namedOne = namedChannels.some((c) => {
    const base = baseChannelName(c.name);
    const forms = [base, base.replace(/\b(one|two|three|four|five)\b/g, (m) => WORD_NUMBER[m])];
    return forms.some((f) => squash(f).length >= 4 && askedKey.includes(squash(f)));
  });

  // "Are there any kids channels?" is a question about the LINEUP, and
  // searching programme titles for it answered with "Dzieciaki rządzą w
  // 4FUN KIDS is on PL|4Fun Kids" — a Polish children's programme, to
  // somebody asking what channels exist. Same for music and news.
  const programmes = namedOne || looksLikeChannelCategoryQuestion(question)
    ? []
    : findProgrammes(question, { service, limit: 6 });
  if (programmes.length) {
    lines.push('From OUR TV guide — what is on, and the channel carrying it (exact, use as written):');
    for (const p of dedupeProgrammeRows(programmes)) {
      lines.push(`- ${timeOfDay(p.start_ts)} ${cleanTitle(p.title)} — on ${cleanTitle(p.channel)}`);
    }
    lines.push('(These come from the guide and are the only listings available.)');
  }

  // Deduped BEFORE the limit, or six results are the same channel six times
  // and the genuinely different ones never make the list.
  // For a GENRE question the category column is the authority, not the
  // channel names. Running it only as a fallback meant "any kids channels?"
  // was answered by whatever happened to have "kids" in its NAME — ABC Kids,
  // HU Kids, AU-FT|Kids — while the channels filed under a Kids category
  // were never looked at.
  const byCategory = looksLikeChannelCategoryQuestion(question)
    ? dedupeVariants(findChannelsByCategory(question, { service, limit: 12 }))
    : [];
  const hits = (byCategory.length ? byCategory : namedChannels).slice(0, 6);
  if (hits.length) {
    if (lines.length) lines.push('');
    lines.push('Channels in OUR lineup matching what they asked about (these names are exact — use them as written):');
    for (const h of hits) lines.push(`- ${cleanTitle(h.name)}${h.category ? ` — ${cleanTitle(h.category)}` : ''}`);

    // Listings for the best few matches rather than only the top one. "What's
    // on sky sports" can match half a dozen channels, and now that the guide
    // is cached per channel the extra lookups are usually free.
    for (const h of hits.slice(0, 3)) {
      // The downloaded guide first — it is already here, costs nothing, and
      // covers every channel. The per-channel API call is the fallback for
      // channels the bulk guide happens not to carry.
      const stored = programmesOnChannel(service, h.epg_channel_id, { limit: 4 });
      if (stored.length) {
        const t = now();
        lines.push('', `What the guide shows on ${cleanTitle(h.name)}:`);
        // Back-to-back entries for the same programme are one programme. The
        // guide splits a rolling news block into half-hour slots, which came
        // out as "Sports Desk is on now until 17:00, and after that it will be
        // Sports Desk".
        const merged = [];
        for (const p of stored) {
          const last = merged[merged.length - 1];
          if (last && cleanTitle(last.title).toLowerCase() === cleanTitle(p.title).toLowerCase()) {
            last.stop_ts = Math.max(last.stop_ts, p.stop_ts);
            continue;
          }
          merged.push({ ...p });
        }
        for (const p of merged.slice(0, 3)) {
          // Say which one is actually ON — otherwise the model announces a
          // programme already half over as "next up".
          const when = p.start_ts <= t && p.stop_ts > t
            ? `ON NOW until ${timeOfDay(p.stop_ts)}`
            : `from ${timeOfDay(p.start_ts)}`;
          lines.push(`- ${when}: ${cleanTitle(p.title)}`);
        }
        continue;
      }
      const epg = await shortEpg(h.stream_id, { service, limit: 3 });
      if (!epg.length) continue;
      lines.push('', `What the guide shows next on ${cleanTitle(h.name)}:`);
      for (const e of epg) lines.push(`- ${hhmm(e.start)} ${cleanTitle(e.title)}`.trim());
    }
    if (lines.some((l) => l.startsWith('What the guide shows'))) {
      lines.push('(These times come from the channel guide.)');
    }
  }

  return lines.length ? lines.join('\n') : null;
}

// ---- the whole guide (xmltv.php) --------------------------------------------
//
// The per-channel endpoint above answers "what's on Sky Sports Main Event?"
// because the question names the channel. It cannot answer "who's playing
// Derby tonight?", where the channel is what the customer wants to be TOLD —
// that means searching programme titles across the lineup, and doing it with
// get_short_epg would be one call per channel.
//
// xmltv.php returns the lot in one download. It is big (tens of MB, sometimes
// gzipped), so it is streamed and parsed in chunks rather than held in memory
// as one string: this runs on the same small box as the bot, and an OOM here
// takes the bot down with it.

const XMLTV_TIMEOUT_MS = 5 * 60 * 1000;
const XMLTV_MAX_BYTES = 250 * 1024 * 1024;
// Written to disk this many at a time, and refused outright beyond this many.
// The cap is a safety valve, not a target: a feed that large means the window
// is wrong, and filling the disk helps nobody.
const BATCH_ROWS = 2000;
const MAX_PROGRAMMES = 400_000;

// Bytes from the response, gunzipped if the body is raw gzip. fetch already
// decompresses a Content-Encoding: gzip response, but panels commonly serve
// gzip bytes with no such header, and then it arrives compressed.
async function* xmltvBytes(body) {
  const iterator = body[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return;
  const head = Buffer.from(first.value);
  const rest = { [Symbol.asyncIterator]: () => iterator };

  async function* source() {
    yield head;
    for await (const chunk of rest) yield Buffer.from(chunk);
  }
  if (!(head[0] === 0x1f && head[1] === 0x8b)) {
    yield* source();
    return;
  }
  const gunzip = createGunzip();
  Readable.from(source()).pipe(gunzip);
  yield* gunzip;
}

// "20261007180000 +0100" → epoch seconds. The offset is what makes this safe
// to compare against our own clock; without one the panel's wall clock is all
// we have, so it is read as UTC and said so.
export function xmltvTime(raw) {
  const m = String(raw || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, sec, off] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(sec || 0)) / 1000;
  if (!off) return wall;
  const sign = off[0] === '-' ? -1 : 1;
  return wall - sign * (Number(off.slice(1, 3)) * 3600 + Number(off.slice(3, 5)) * 60);
}

const unescapeXml = (s) => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&')
  .trim();

// Exported for the tests: one <programme> block → a row, or null.
export function parseProgramme(block) {
  const start = block.match(/\bstart="([^"]+)"/);
  const stop = block.match(/\bstop="([^"]+)"/);
  const channel = block.match(/\bchannel="([^"]+)"/);
  const title = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
  if (!start || !channel || !title) return null;
  const text = unescapeXml(title[1]).slice(0, 200);
  if (!text) return null;
  const startTs = xmltvTime(start[1]);
  if (!startTs) return null;
  return {
    channelId: unescapeXml(channel[1]).slice(0, 200),
    title: text,
    startTs,
    stopTs: stop ? xmltvTime(stop[1]) : startTs,
  };
}

let guideRefreshing = false;

export async function refreshGuide(service = 1) {
  const a = xcAccount(service);
  if (!a.url || !a.username || !a.password) return { ok: false, error: 'no lookup account set' };
  // One at a time: this is a large download and a second one would double the
  // memory and the bandwidth for the same data.
  if (guideRefreshing) return { ok: false, error: 'a guide refresh is already running' };
  guideRefreshing = true;

  const windowHours = Math.max(6, Number(getSetting('services.epgWindowHours')) || 48);
  const t = now();
  const from = t - 3 * 3600;
  const to = t + windowHours * 3600;
  let seen = 0;
  let total = 0;
  let kept = 0;
  let batch = [];

  // Rows go to disk in small batches rather than piling up in memory. A real
  // panel is hundreds of thousands of programmes; holding them all cost
  // 300MB, which is an OOM kill on a small container — and a bot that dies,
  // restarts, downloads again and dies again looks exactly like a bot that
  // has stopped responding.
  const stage = db.prepare('INSERT INTO xc_programmes_staging (service, channel_id, title, start_ts, stop_ts) VALUES (?, ?, ?, ?, ?)');
  const writeBatch = db.transaction((rows) => {
    for (const p of rows) stage.run(service, p.channelId, p.title, p.startTs, p.stopTs);
  });
  const flush = async () => {
    if (!batch.length) return;
    writeBatch(batch);
    kept += batch.length;
    batch = [];
    // Hand the loop back between batches. better-sqlite3 is synchronous, so
    // without this the bot cannot poll Telegram while the guide is written.
    await new Promise((r) => setImmediate(r));
  };
  db.prepare('DELETE FROM xc_programmes_staging WHERE service = ?').run(service);

  try {
    const qs = new URLSearchParams({ username: a.username, password: a.password });
    const res = await fetch(`${a.url}/xmltv.php?${qs}`, {
      signal: AbortSignal.timeout(XMLTV_TIMEOUT_MS),
      headers: { Accept: 'application/xml' },
    });
    if (!res.ok) return { ok: false, error: `panel returned ${res.status}` };
    if (!res.body) return { ok: false, error: 'panel sent no guide data' };

    const decoder = new TextDecoder('utf-8');
    let buf = '';
    for await (const chunk of xmltvBytes(res.body)) {
      seen += chunk.length;
      if (seen > XMLTV_MAX_BYTES) return { ok: false, error: 'guide download was unreasonably large — stopped' };
      buf += decoder.decode(chunk, { stream: true });

      let end;
      while ((end = buf.indexOf('</programme>')) !== -1) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + '</programme>'.length);
        const open = block.lastIndexOf('<programme');
        if (open === -1) continue;
        total++;
        const p = parseProgramme(block.slice(open));
        // Only the window around now is kept. These questions are about
        // tonight and tomorrow, and a week of listings for several hundred
        // channels makes the title scan slow for nothing.
        if (p && p.startTs < to && (p.stopTs || p.startTs) > from) batch.push(p);
      }
      if (batch.length >= BATCH_ROWS) await flush();
      if (kept + batch.length > MAX_PROGRAMMES) {
        return { ok: false, error: 'guide had more listings than we can hold — narrow the window' };
      }
      // A document with no </programme> at all must not grow the buffer
      // without limit — drop everything except a possible partial tag.
      if (buf.length > 1_000_000) buf = buf.slice(-64);
    }
    await flush();
  } catch (err) {
    // SECURITY: the password is in the query string, so no fetch error text
    // and no URL may be passed through. These strings are written by hand.
    return {
      ok: false,
      error: /timeout|aborted/i.test(String(err?.message)) ? 'the guide download timed out' : 'could not download the guide',
    };
  } finally {
    guideRefreshing = false;
  }

  if (!total) {
    db.prepare('DELETE FROM xc_programmes_staging WHERE service = ?').run(service);
    return { ok: false, error: 'the panel returned no guide data' };
  }

  // The swap is one short transaction of pure SQL — no JS objects, nothing
  // held in memory — so readers see the old guide or the new one, never half
  // of one, and the loop is blocked for a moment rather than a second.
  db.transaction(() => {
    db.prepare('DELETE FROM xc_programmes WHERE service = ?').run(service);
    db.prepare(
      'INSERT INTO xc_programmes (service, channel_id, title, start_ts, stop_ts) ' +
      'SELECT service, channel_id, title, start_ts, stop_ts FROM xc_programmes_staging WHERE service = ?'
    ).run(service);
    db.prepare('DELETE FROM xc_programmes_staging WHERE service = ?').run(service);
  })();
  setSetting(`services.guideFetchedAt${service === 2 ? 2 : 1}`, now());
  return { ok: true, count: kept, scanned: total };
}

// Recorded on success only, so a panel that is refusing the guide is retried
// on the sweep's own short backoff rather than being written off for hours.
export function guideRefreshedAt(service = 1) {
  return Number(getSetting(`services.guideFetchedAt${service === 2 ? 2 : 1}`)) || 0;
}

export function programmeCount(service = 1) {
  return db.prepare('SELECT COUNT(*) n FROM xc_programmes WHERE service = ?').get(service).n;
}

export function guideSpan(service = 1) {
  const r = db.prepare('SELECT MIN(start_ts) a, MAX(start_ts) b FROM xc_programmes WHERE service = ?').get(service);
  return { from: r.a || 0, to: r.b || 0 };
}

// ---- searching the guide ----------------------------------------------------

// Words that say when, not what.
const WHEN_WORDS = {
  now: () => [now() - 1800, now() + 1800],
  tonight: () => dayWindow(0, 16, 30),
  today: () => dayWindow(0, 0, 24),
  tomorrow: () => dayWindow(1, 0, 24),
};

// Day boundaries come from the server's own clock, so the host should be set
// to the same timezone as the service. "Tonight" is otherwise ambiguous in a
// way no amount of code can resolve.
function dayWindow(dayOffset, startHour, endHour) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(startHour, 0, 0, 0);
  const from = Math.floor(d.getTime() / 1000);
  return [Math.max(from, now() - 3600), from + (endHour - startHour) * 3600];
}

export function timeWindow(question) {
  const s = String(question || '').toLowerCase();
  for (const [word, fn] of Object.entries(WHEN_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(s)) return fn();
  }
  return [now() - 1800, now() + 24 * 3600];
}

// Words that appear in half the questions and name no programme.
const PROG_NOISE = new Set([
  'what', 'whats', 'which', 'where', 'when', 'who', 'whos', 'how', 'the', 'is', 'are', 'on', 'at',
  'in', 'to', 'for', 'of', 'a', 'an', 'and', 'or', 'it', 'its', 'i', 'me', 'my', 'we', 'you',
  'channel', 'channels', 'watch', 'watching', 'showing', 'shown', 'playing', 'play', 'game',
  'match', 'live', 'tv', 'time', 'kick', 'off', 'kickoff', 'tonight', 'today', 'tomorrow', 'now',
  'can', 'do', 'does', 'did', 'will', 'be', 'got', 'get', 'any', 'anyone', 'please', 'pls',
  'vs', 'v', 'against', 'uk', 'hd', 'sport', 'sports',
]);

// Nobody writes "football" in a listing. The guide says "Premier League:
// Derby County v Leeds United" and "UEFA Champions League: Arsenal v Inter
// Milan", so a customer asking what football is on matched no title at all
// and got the generic sports entry back — which is what happened live to
// "What football is showing this weekend".
//
// The sport is the one word they are most likely to use and the one word
// least likely to appear, so each sport is expanded into the competitions
// that actually get written down.
const SPORT_SYNONYMS = {
  football: ['football', 'soccer', 'premier league', 'premiership', 'champions league', 'uefa',
    'europa', 'fa cup', 'efl', 'carabao', 'la liga', 'serie a', 'bundesliga', 'ligue 1',
    'eredivisie', 'scottish prem', 'world cup', 'womens super league', 'league cup',
    'conference league', 'internationals'],
  boxing: ['boxing', 'fight night', 'title fight', 'heavyweight', 'undercard', 'welterweight'],
  f1: ['formula 1', 'formula one', 'grand prix', 'qualifying', 'practice', 'f1'],
  formula: ['formula 1', 'formula one', 'grand prix', 'qualifying', 'practice'],
  cricket: ['cricket', 'test match', 'odi', 't20', 'the ashes', 'the hundred'],
  rugby: ['rugby', 'six nations', 'premiership rugby', 'super league', 'challenge cup'],
  golf: ['golf', 'open championship', 'pga', 'ryder cup', 'masters'],
  tennis: ['tennis', 'wimbledon', 'atp', 'wta', 'french open', 'australian open'],
  darts: ['darts', 'pdc', 'matchplay'],
  ufc: ['ufc', 'mma', 'bellator'],
  mma: ['ufc', 'mma', 'bellator'],
  nfl: ['nfl', 'super bowl'],
  nba: ['nba'],
  snooker: ['snooker', 'crucible'],
  racing: ['racing', 'handicap', 'stakes', 'hurdle', 'chase'],
  horse: ['racing', 'handicap', 'stakes', 'hurdle', 'chase'],
};

// Find programmes whose TITLE matches the question, within its time window.
// Joined to the lineup so the answer is a channel NAME — the epg id means
// nothing to a customer.
export function findProgrammes(question, { service = 1, limit = 6 } = {}) {
  const terms = (String(question || '').toLowerCase().match(/[a-z0-9']{3,}/g) || [])
    .map((w) => w.replace(/'/g, ''))
    .filter((w) => w.length >= 3 && !PROG_NOISE.has(w));
  if (!terms.length) return [];

  // Everything still to come, not just the question's window. A window that
  // EXCLUDES is the wrong trade here: someone asking at lunchtime who is
  // playing "tonight" should not be told we have no listing for a match we
  // are holding, just because they picked the wrong word for 5pm. The window
  // ranks instead — asked-for time first, then everything else.
  const [wantFrom, wantTo] = timeWindow(question);
  // The title filter runs in SQLite, not in JS. Pulling every unfinished
  // programme back and sieving them here meant tens of thousands of row
  // objects built per question, on top of a join that had no index to use.
  // An INNER JOIN also drops programmes whose channel is not in the lineup,
  // which were being discarded a moment later anyway.
  // A sport name is expanded into the competitions a listing actually
  // writes, both for the SQL filter and for the scoring below.
  const expanded = [];
  for (const t of terms) for (const syn of SPORT_SYNONYMS[t] || [t]) {
    if (!expanded.includes(syn)) expanded.push(syn);
  }
  // Generous, because the cap used to be shorter than the synonym list
  // itself: "football" expands past ten patterns, so "scottish prem" fell
  // off the end and a Scottish Premiership fixture was invisible to anyone
  // who called it football. The query already scans with leading-wildcard
  // LIKEs, so a few more ORs cost nothing it was not paying.
  const likes = expanded.slice(0, 24);
  const rows = db.prepare(`
    SELECT p.title, p.start_ts, p.stop_ts, c.name AS channel
    FROM xc_programmes p
    JOIN xc_channels c ON c.service = p.service AND c.epg_channel_id = p.channel_id
    WHERE p.service = ? AND p.stop_ts > ?
      AND (${likes.map(() => 'p.title LIKE ?').join(' OR ')})
    ORDER BY p.start_ts
    LIMIT 400
  `).all(service, now() - 3600, ...likes.map((t) => `%${t}%`));

  const scored = [];
  for (const r of rows) {
    const title = r.title.toLowerCase();
    let score = 0;
    for (const term of expanded) if (title.includes(term)) score += term.length >= 5 ? 3 : 1;
    if (!score) continue;
    if (r.start_ts < wantTo && r.stop_ts > wantFrom) score += 2;
    scored.push({ ...r, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.start_ts - b.start_ts)
    .slice(0, limit);
}

// Is this a question about a fixture rather than about a channel?
// "what time is it" is a question about the clock, not about our lineup, and
// asking which service someone is on before answering it is absurd. Anything
// else after "what time" IS asking the time of something — "what time is the
// arsenal game" names no verb at all, so requiring one missed it.
const FIXTURE_QUESTION = /\bwho('?s| is| are)?\s+(playing|on|against)\b|\bwho\s+\w+\s+playing\b|\bwhat\s+time\b(?!\s+is\s+it\b)|\bkick\s?off\b|\bis\s+(the\s+)?[\w\s]{2,30}\s+(on|playing)\b|\bany\s+(football|boxing|games?|matches)\b/i;

// A message that is nothing but a sport, which is how people ask the second
// time: "and the football", "what about the cricket". Anchored to the whole
// message so it cannot swallow "and the wifi", and the sports are a closed
// list, so this is only ever read as a fixture question when a fixture
// question is the only thing it could be.
const BARE_SPORT =
  /^\s*(?:and|also|what\s+about|how\s+about|plus|then)?\s*(?:the\s+)?(?:football|soccer|boxing|cricket|rugby|golf|tennis|darts|snooker|racing|f1|formula\s?1|ufc|mma|nfl|nba|hockey)\b[\s?!.]*$/i;

export const looksLikeFixtureQuestion = (text) =>
  (FIXTURE_QUESTION.test(String(text || '')) || BARE_SPORT.test(String(text || '')))
  && String(text || '').length < 160;

// ---- the VOD library --------------------------------------------------------
//
// "Can we get Oppenheimer?" was always filed as a request, even when the
// service already carried it. The customer then waits for a batch that will
// never come, and the admin closes a request for a title they already have.
// The panel knows the answer, so ask it.
//
// Per service on purpose: the two libraries are not the same, which is why
// answering this properly means knowing which service the person is on.

const normName = (s) => String(s || '')
  .toLowerCase()
  .replace(/\b(19|20)\d{2}\b/g, ' ')        // a year is not part of the name
  .replace(/\b(s\d{1,2}|season\s*\d{1,2}|complete|collection|saga)\b/g, ' ')
  .replace(/[^a-z0-9]/g, '');

const dropArticle = (n) => String(n || '').replace(/^(?:the|a|an)/, '');

// The same normalisation but keeping word boundaries. normName above squeezes
// every space out, which makes "MobLand" and "Mob Land" the identical string —
// and they are two different titles: a 2025 series and a 2023 film. Asked
// about the series, the bot answered "Good news, Mob Land - 2023 is already on
// the service, open the Movies section", with total confidence, about
// something we do not carry. Spacing alone is not enough to claim certainty.
// Quality and format tags a panel bolts onto a name. "Oppenheimer (2023) 4K"
// is Oppenheimer; the 4K is how it was encoded, not what it is called.
const DECOR = /\b(?:4k|uhd|fhd|hd|sd|imax|remux|hevc|x26[45]|h\.?26[45]|[0-9]{3,4}p|bluray|blu-ray|bdrip|dvdrip|webrip|web-?dl|web|multi|dual|vip|raw)\b/g;

const normWords = (s) => String(s || '')
  .toLowerCase()
  .replace(/\b(19|20)\d{2}\b/g, ' ')
  .replace(/\b(s\d{1,2}|season\s*\d{1,2}|complete|collection|saga)\b/g, ' ')
  .replace(DECOR, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const dropArticleWords = (n) => String(n || '').replace(/^(?:the|a|an)\s+/, '');

// The year the library row carries, if any — the one piece of information that
// tells a customer which "Mob Land" we actually hold.
const yearIn = (name) => (String(name || '').match(/\b(19|20)\d{2}\b/) || [null])[0];

export async function refreshVod(service = 1) {
  const movies = await call(service, { action: 'get_vod_streams' });
  const series = await call(service, { action: 'get_series' });
  if (!Array.isArray(movies) && !Array.isArray(series)) {
    return { ok: false, error: lastError || 'no library returned' };
  }
  const rows = [];
  for (const m of Array.isArray(movies) ? movies : []) {
    if (m?.name) rows.push({ kind: 'movie', name: String(m.name).slice(0, 300), category: m.category_id ?? null });
  }
  for (const s of Array.isArray(series) ? series : []) {
    if (s?.name) rows.push({ kind: 'series', name: String(s.name).slice(0, 300), category: s.category_id ?? null });
  }
  // Same reasoning as the lineup: an empty answer from a panel mid-restart
  // must not wipe a library we are using to tell people what we carry.
  if (!rows.length && vodCount(service) > 0) {
    return { ok: false, error: 'panel returned an empty library — keeping the cached one' };
  }

  const t = now();
  const insert = db.prepare('INSERT INTO xc_vod (service, kind, name, norm_name, category, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM xc_vod WHERE service = ?').run(service);
    for (const r of rows) {
      const norm = normName(r.name);
      if (norm) insert.run(service, r.kind, r.name, norm, r.category === null ? null : String(r.category), t);
    }
  })();
  return { ok: true, count: vodCount(service) };
}

export function vodCount(service = 1) {
  return db.prepare('SELECT COUNT(*) n FROM xc_vod WHERE service = ?').get(service).n;
}

export function vodUpdatedAt(service = 1) {
  return db.prepare('SELECT MAX(updated_at) t FROM xc_vod WHERE service = ?').get(service).t || 0;
}

export const vodKnown = (service = 1) => vodCount(service) > 0;

// Is this title already in the library? Deliberately strict: telling someone
// a film is already there when it is not sends them hunting through the app
// and makes the bot look like it is fobbing them off, which is worse than
// taking a duplicate request.
export function findVodTitle(title, { service = 1, limit = 3 } = {}) {
  const norm = normName(title);
  // Short titles are real ("Up", "It", "Her"). They are only rejected for the
  // CONTAINMENT pass below, where being a fragment of a longer name is a
  // coincidence rather than a match.
  if (norm.length < 2) return [];
  const rows = db.prepare('SELECT kind, name, norm_name FROM xc_vod WHERE service = ?').all(service);

  // A leading article is dropped on both sides before comparing. People say
  // "big bang theory" for "The Big Bang Theory" constantly, and without this
  // it falls through to the fuzzy pass and gets answered with a hedge ("I
  // think we already have that... not the one you meant?") for a show that is
  // plainly the one they asked for. Compared rather than stored that way, so
  // it works against rows written by an older version too.
  const loose = dropArticle(norm);
  const words = normWords(title);
  const looseWords = dropArticleWords(words);

  // Certain only when the words line up too. "The Big Bang Theory" for "big
  // bang theory" still counts; "Mob Land" for "MobLand" does not.
  const sure = rows.filter((r) => {
    const rw = normWords(r.name);
    return rw === words || dropArticleWords(rw) === looseWords;
  });
  if (sure.length) {
    return sure.slice(0, limit).map((r) => ({ ...r, exact: true, year: yearIn(r.name) }));
  }

  // Matches once the spaces are squeezed out — probably right, possibly a
  // different title that happens to collapse to the same letters. Offered as
  // a suggestion with its year and kind, so the customer can tell at a glance.
  const squashed = rows.filter((r) => r.norm_name === norm || dropArticle(r.norm_name) === loose);
  if (squashed.length) {
    return squashed.slice(0, limit).map((r) => ({ ...r, exact: false, year: yearIn(r.name) }));
  }

  // A library name usually carries extra decoration ("Oppenheimer 4K",
  // "The Batman [2022] IMAX"), so a contained match counts — but only when
  // the asked-for title is long enough that containment means something.
  // "Up" or "It" inside a longer name is a coincidence, not a hit.
  if (norm.length < 6) return [];
  return rows
    .filter((r) => r.norm_name.includes(norm))
    .sort((a, b) => a.norm_name.length - b.norm_name.length)
    .slice(0, limit)
    .map((r) => ({ ...r, exact: false, year: yearIn(r.name) }));
}
