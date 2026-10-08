import { db, now } from '../db/db.js';
import { getSetting } from '../settings.js';
import { hub } from './hub.js';
import { alertAdmins } from './reports.js';

// "Request: Maze Runner: The Death Cure (2018)" — the format the VOD FAQ
// teaches. Capture it, thank the requester, save it for the panel, and let
// the admin close the loop with one click ("Mark added" tags them back).

// Complaint/admin words that follow "request" but are NOT a VOD title —
// "Request a refund", "request my money back", "request to cancel".
const NOT_A_TITLE = /^(a |an |the |my |to |for )*\s*(refund|refunds|cancel|cancell?ed|cancell?ing|cancellation|money|payment|pay|callback|call ?back|help|support|assistance|password|login|log ?in|account|invoice|receipt|chargeback|renewal|renew|upgrade|change)\b/i;

export function parseVodRequest(text) {
  const m = stripLeadIn(text).match(/^\s*request\b\s*[:\-–]?\s*(.{2,200})/i);
  if (!m) return null;
  const title = stripTitleTail(m[1].trim().replace(/\s+/g, ' '));
  if (title.length < 2) return null;
  if (NOT_A_TITLE.test(title)) return null; // "Request a refund" etc. — not VOD
  return title;
}

// "Do you have The Big Bang Theory?" is not a request — it is a question with
// a factual answer, and the model used to invent one ("it is available in our
// VOD section"). Someone then goes looking for a show we may not carry. The
// library knows; the model does not.
const AVAILABILITY = /^\s*(?:(?:do|have)\s+(?:you|yous|u|ya|we)\s+(?:have|got|carry)|(?:is|are)\s+(?:there\s+)?|(?:got|have)\s+(?:you\s+)?(?:got\s+)?|(?:any\s+sign\s+of)|(?:where\s+(?:can|do)\s+i\s+(?:find|watch)))\s*(.{2,100}?)\s*(?:on(?:\s+(?:here|there|the\s+service|vod))?|available|in\s+(?:the\s+)?vod|on\s+demand|anywhere)?\s*[?!.]*\s*$/i;

// "Is big bang theory on exclusive" is a question about the VOD library that
// happens to be shaped exactly like "is the boxing on tonight" — and it was
// being read as the second one, so the bot asked which service carried the
// CHANNEL. The thing that tells them apart is the tail: a configured service
// name, or "here"/"the service"/"vod". "Is the F1 on Sky Sports" has a
// channel in that slot and stays a fixture question.
const serviceNames = () => ['services.name1', 'services.name2']
  .map((k) => String(getSetting(k) || '').trim())
  .filter((n) => n.length >= 3);

// The title is GREEDY so the split happens at the LAST "on". Lazy, it took
// the first one: "do you have Only On Flix on flix" split as title "Only",
// tail "Flix on flix" — a whole match, so the engine never tried again, and
// the tail was not a service name so the question went unrecognised.
const ON_WHAT = /^\s*(?:is|are|have\s+you\s+got|do\s+you\s+have|got|does\s+(?:it|he|she)\s+have)\s+(.{2,100})\s+on\s+([\w\s]{2,40}?)\s*[?!.]*$/i;

// The service someone named in their own message, so the bot does not ask
// which service they are on when they just said.
export function serviceNamedIn(text) {
  const s = String(text || '').toLowerCase();
  const [one, two] = ['services.name1', 'services.name2'].map((k) => String(getSetting(k) || '').trim());
  const hitOne = one.length >= 3 && new RegExp(`\\b${one.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s);
  const hitTwo = two.length >= 3 && new RegExp(`\\b${two.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s);
  if (hitOne && !hitTwo) return 1;
  if (hitTwo && !hitOne) return 2;
  return null;
}

function availabilityOnService(s) {
  const m = s.match(ON_WHAT);
  if (!m) return null;
  const tail = m[2].trim().toLowerCase().replace(/^the\s+/, '');
  const known = [...serviceNames().map((n) => n.toLowerCase()), 'here', 'there', 'vod', 'demand', 'service', 'your service', 'the app', 'app'];
  if (!known.includes(tail)) return null;
  return m[1].trim();
}

export function parseAvailabilityQuestion(text) {
  // A short multi-line message is one question with the address on its own
  // line. Try each line rather than discarding the lot.
  if (/\n/.test(String(text))) {
    for (const line of questionLines(text)) {
      const hit = parseAvailabilityQuestion(line);
      if (hit) return hit;
    }
    return null;
  }
  const s = stripLeadIn(text).trim();
  if (s.length > 120) return null;
  const onService = availabilityOnService(s);
  // It has to actually be asking whether we HAVE something.
  if (!onService && !/\b(have|got|carry|available|on here|on there|in vod|on demand|where can i (?:find|watch))\b/i.test(s)) return null;
  const m = onService ? [null, onService] : s.match(AVAILABILITY);
  if (!m) return null;
  let title = stripTitleTail(m[1].trim().replace(/\s+/g, ' '));
  if (title.length < 2 || title.length > 100) return null;
  if (/^(it|this|that|them|these|those|me|us|my|your|our|any|anything|everything|a|an|the)$/i.test(title)) return null;
  if (NOT_A_TITLE.test(title)) return null;
  if (NOT_VOD_TOPIC.test(title)) return null;
  return title;
}

// Natural-language requests: "can we get The Batman", "can you add Dune 2",
// "any chance of adding Oppenheimer", "please add severance season 3".
// The word "request" used like a human uses it. This was the gap that let
// "I'd like to request The Big Bang Theory" fall through to the model, which
// answered by telling the customer the format to type — so nothing was
// captured, nothing was acked, and nobody was asked which service it was for.
const REQUEST_VERB = /^\s*(?:please |pls |plz )?(?:(?:i(?:'| a|a)?d like to|i would like to|i want to|i wanna|id like to|(?:can|could|may|might) i|(?:can|could) we|wanting to|looking to|here to)\s+(?:request|ask\s+for)|(?:can|could|may|might)\s+i\s+ask\s+(?:for|about)|requesting|request(?:ing)? for|(?:would|is)\s+it\s+(?:be\s+)?possible\s+to\s+(?:add|get)|asking\s+for)\s+(.{2,100}?)[\s?!.]*$/i;

// A message that opens with a greeting is the normal case, not the exception
// — "Good morning, can I ask for Reacher to be added" matched nothing at all
// because every pattern here is anchored to the start of the message. The
// greeting is stripped first so the request underneath is seen.
// "please" is deliberately NOT in here: it is not a greeting, and the request
// patterns below already allow a leading one — stripping it broke
// "please add severance season 3".
// "bot" belongs here too: people address it before asking, and the address is
// not part of the question. Live: "Hey bot / Is Mobland on exclusive?" parsed
// as nothing at all, so a straight "have you got this show" question fell
// through to the channel-lookup path and came back "give me the channel name".
const LEAD_IN = /^(?:\s*(?:hi|hey|hello|heya|hiya|yo|oi|alright|alreet|morning|afternoon|evening|good\s+(?:morning|afternoon|evening)|sorry|excuse\s+me|quick\s+one|mate|m8|pal|bud|boss|guys|lads|team|folks|bot|bots|robot|assistant)\b[\s,!.:;–—-]*)+/i;

export function stripLeadIn(text) {
  const out = String(text || '').replace(LEAD_IN, '').trim();
  // Never strip the whole message away: "morning!" on its own is a greeting,
  // and the greeting handler should still see it as one.
  return out.length >= 2 ? out : String(text || '');
}

// People put the address on its own line — "Hey bot" then the question. A
// blanket "any newline means this is not a question" threw those away whole.
// Long pasted blocks are still ignored; a couple of short lines are not a
// paste, they are someone typing the way people type.
export function questionLines(text) {
  const lines = String(text || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines.length > 3) return [];
  if (lines.some((l) => l.length > 140)) return [];
  return lines;
}

const NATURAL_REQ = /^\s*(?:please |pls |plz )?(?:any chance (?:of |we can |you can )?(?:getting |adding |putting (?:on |up )?)?|(?:can|could|cud) (?:we|you|u|i) (?:get|add|have|put on|put up|upload) |(?:please|pls|plz) add )\s*(.{2,100}?)[\s?!.]*$/i;

// Trailing words that describe the KIND of thing, not its name. "The Big Bang
// Theory series" is a request for "The Big Bang Theory"; left on, the title
// never matches the library and never matches another request for the same
// show.
const TITLE_TAIL = /\s+(?:the\s+)?(?:tv\s+)?(?:series|show|boxset|box\s?set|collection|movie|film|all\s+(?:the\s+)?seasons?|complete(?:\s+series)?)\s*$/i;

// Trailing words that say what to DO with it, not what it is called.
// "Can I get big bang theory added" was filed as "big bang theory added",
// which matches no library entry and no other request for the same show.
const TITLE_VERB_TAIL = /\s+(?:added|adding|uploaded|uploading|put\s+(?:on|up)|on\s+(?:here|there|the\s+service|vod)|to\s+(?:the\s+)?(?:vod|service|list)|to\s+be|sorted|please|plz|pls|thanks|ta|cheers)\s*$/i;

export function stripTitleTail(title) {
  let out = String(title).trim();
  for (let i = 0; i < 4; i++) {
    const next = out.replace(TITLE_VERB_TAIL, '').replace(TITLE_TAIL, '').trim();
    if (next === out) break;
    // Never strip it away to nothing — "The Movie" is a title in its own right.
    if (next.length < 2) break;
    out = next;
  }
  return out;
}

// Words that mean a "can we get ..." is about the SERVICE, not a title —
// URLs, logins, devices, refunds. These flow to the normal FAQ/AI handling.
const NOT_VOD_TOPIC = /\b(urls?|codes?|links?|login|logins|password|passwords|account|accounts|sub|subs|subscription|trial|refund|refunds|discount|invite|invites|invited|help|support|admin|app|apps|apk|update|updates|updated|guide|guides|service|services|multiroom|multi ?room|stream|streams|connection|connections|screen|screens|firestick|fire stick|iphone|ipad|ios|android|phone|tablet|tv|telly|samsung|lg|box|device|devices|working|fixed|sorted|access|pin)\b/i;

export function parseNaturalVodRequest(text) {
  if (/\n/.test(String(text))) return null; // single-line asks only
  const lead = stripLeadIn(text);
  const m = lead.match(REQUEST_VERB) || lead.match(NATURAL_REQ);
  if (!m) return null;
  let title = m[1].trim().replace(/\s+/g, ' ').replace(/\s*\b(please|pls|plz|thanks|thank you|ta|mate|m8)$/i, '').trim();
  title = stripTitleTail(title);
  if (title.length < 2 || title.length > 100) return null;
  // "can we get this sorted" / "can you add me" — pronouns, not titles.
  if (/^(it|this|that|them|these|those|me|us|my|your|our|in|on|at|to|back|going|him|her)\b/i.test(title)) return null;
  if (NOT_A_TITLE.test(title)) return null;
  if (NOT_VOD_TOPIC.test(title)) return null;
  return title;
}

const normTitle = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');

// Look the title up on IMDb's public suggestion endpoint (the one their own
// search box uses — no API key). Returns { title, year, canonical } for the
// best film/series hit, or null when off, down, slow or no match — callers
// must treat null as "behave exactly as without IMDb". Hard 2.5s timeout so
// a wobbly IMDb never delays a request.
export async function lookupImdb(title) {
  if (!getSetting('vod.imdbCheck')) return null;
  const base = String(getSetting('vod.imdbBase') || 'https://v2.sg.media-imdb.com').replace(/\/+$/, '');
  const q = String(title).toLowerCase().trim().slice(0, 60);
  const first = q.replace(/[^a-z0-9]/g, '')[0] || 'a';
  try {
    const res = await fetch(`${base}/suggestion/${first}/${encodeURIComponent(q)}.json`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const hit = (data?.d || []).find((x) => /^tt/.test(x?.id || '') && x.l && x.y && x.q !== 'video game');
    return hit ? { title: hit.l, year: hit.y, canonical: `${hit.l} (${hit.y})` } : null;
  } catch {
    return null;
  }
}

// Rename a request to its confirmed/corrected title. If another OPEN request
// already carries that title, the two merge (ask counts combine) — returns
// the surviving row id either way.
export function canonicalizeRequest(requestId, newTitle) {
  const r = db.prepare('SELECT * FROM vod_requests WHERE id = ?').get(requestId);
  if (!r) return requestId;
  const norm = normTitle(newTitle);
  if (norm === r.norm_title) return requestId;
  const other = db.prepare("SELECT * FROM vod_requests WHERE norm_title = ? AND status = 'open' AND id != ?").get(norm, requestId);
  if (other) {
    db.prepare('UPDATE vod_requests SET ask_count = ask_count + ? WHERE id = ?').run(r.ask_count, other.id);
    db.prepare('DELETE FROM vod_requests WHERE id = ?').run(requestId);
    return other.id;
  }
  db.prepare('UPDATE vod_requests SET title = ?, norm_title = ? WHERE id = ?').run(String(newTitle).slice(0, 200), norm, requestId);
  return requestId;
}

// Returns { ack, requestId, deduped } — ack is always sendable text.
export function recordVodRequest(ctx, title) {
  const t = now();
  const norm = normTitle(title);
  const existing = db.prepare("SELECT * FROM vod_requests WHERE norm_title = ? AND status = 'open'").get(norm);
  if (existing) {
    db.prepare('UPDATE vod_requests SET ask_count = ask_count + 1 WHERE id = ?').run(existing.id);
    return { ack: `👍 ${title} is already on the request list — it'll land in one of the next batches.`, requestId: existing.id, deduped: true };
  }
  const info = db.prepare('INSERT INTO vod_requests (title, norm_title, tg_user_id, tg_user, chat_id, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title, norm, ctx.from?.id ?? null, ctx.from?.username || ctx.from?.first_name || null, ctx.chat?.id ?? null, t);
  alertAdmins('vod', `🎬 VOD request from @${ctx.from?.username || ctx.from?.first_name || 'someone'}: "${title}" — panel → Requests.`);
  const template = String(getSetting('bot.requestAckMessage') || '');
  const ack = template.replace(/\{title\}/g, title).trim() || `📝 Noted! ${title} is on the request list 👍`;
  return { ack, requestId: info.lastInsertRowid, deduped: false };
}

// Attach the service the request is for (the bot asks after capturing) and
// let the admins know, so they add it to the right library.
export function setRequestService(requestId, serviceName) {
  const r = db.prepare('SELECT * FROM vod_requests WHERE id = ?').get(requestId);
  if (!r) return;
  db.prepare('UPDATE vod_requests SET service = ? WHERE id = ?').run(serviceName, requestId);
  alertAdmins('vod', `↳ @${r.tg_user || r.tg_user_id}'s request "${r.title}" is for: ${serviceName}`);
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// "Mark added" in the panel: tell the requester in the chat they asked in
// (real tg://user mention so it pings without an @username), DM fallback.
export async function notifyRequestAdded(request) {
  const template = String(getSetting('bot.requestAddedMessage') || '').trim();
  if (!template || !hub.online || !request?.tg_user_id) return false;
  const mention = `<a href="tg://user?id=${request.tg_user_id}">${escHtml(request.tg_user || 'there')}</a>`;
  const body = escHtml(template)
    .replace(/\{name\}/g, mention)
    .replace(/\{title\}/g, escHtml(request.title))
    .trim();
  for (const target of [request.chat_id, request.tg_user_id].filter(Boolean)) {
    try {
      await hub.send(target, body, { parse_mode: 'HTML' });
      return true;
    } catch {
      // try the next target
    }
  }
  return false;
}
