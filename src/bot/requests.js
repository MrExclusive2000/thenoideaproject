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
  const m = String(text).match(/^\s*request\b\s*[:\-–]?\s*(.{2,200})/i);
  if (!m) return null;
  const title = m[1].trim().replace(/\s+/g, ' ');
  if (title.length < 2) return null;
  if (NOT_A_TITLE.test(title)) return null; // "Request a refund" etc. — not VOD
  return title;
}

// Natural-language requests: "can we get The Batman", "can you add Dune 2",
// "any chance of adding Oppenheimer", "please add severance season 3".
const NATURAL_REQ = /^\s*(?:please |pls |plz )?(?:any chance (?:of |we can |you can )?(?:getting |adding |putting (?:on |up )?)?|(?:can|could|cud) (?:we|you|u|i) (?:get|add|have|put on|put up|upload) |(?:please|pls|plz) add )\s*(.{2,100}?)[\s?!.]*$/i;

// Words that mean a "can we get ..." is about the SERVICE, not a title —
// URLs, logins, devices, refunds. These flow to the normal FAQ/AI handling.
const NOT_VOD_TOPIC = /\b(urls?|codes?|links?|login|logins|password|passwords|account|accounts|sub|subs|subscription|trial|refund|refunds|discount|invite|invites|invited|help|support|admin|app|apps|apk|update|updates|updated|guide|guides|service|services|multiroom|multi ?room|stream|streams|connection|connections|screen|screens|firestick|fire stick|iphone|ipad|ios|android|phone|tablet|tv|telly|samsung|lg|box|device|devices|working|fixed|sorted|access|pin)\b/i;

export function parseNaturalVodRequest(text) {
  if (/\n/.test(String(text))) return null; // single-line asks only
  const m = String(text).match(NATURAL_REQ);
  if (!m) return null;
  let title = m[1].trim().replace(/\s+/g, ' ').replace(/\s*\b(please|pls|plz|thanks|thank you|ta|mate|m8)$/i, '').trim();
  if (title.length < 2 || title.length > 100) return null;
  // "can we get this sorted" / "can you add me" — pronouns, not titles.
  if (/^(it|this|that|them|these|those|me|us|my|your|our|in|on|at|to|back|going|him|her)\b/i.test(title)) return null;
  if (NOT_A_TITLE.test(title)) return null;
  if (NOT_VOD_TOPIC.test(title)) return null;
  return title;
}

const normTitle = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');

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
