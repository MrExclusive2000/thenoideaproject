import { db, now } from '../db/db.js';
import { getSetting, setSettings } from '../settings.js';
import { hub } from './hub.js';
import { isContentIssue, isAdminUser } from './helpers.js';
import { audit } from '../util.js';

// Problem reports are batched into one admin DM per short window: a burst of
// "buffering on bbc1" from several people becomes a single alert, and 3+ in
// the window is flagged as a likely outage. Immediate-but-not-spammy.
const FLUSH_MS = 30000;
let problemQueue = [];
let problemTimer = null;

export function queueProblemAlert(report) {
  if (!getSetting('reports.alertProblems')) return;
  problemQueue.push(report);
  if (!problemTimer) {
    problemTimer = setTimeout(flushProblemAlerts, FLUSH_MS);
    if (problemTimer.unref) problemTimer.unref();
  }
}

export async function flushProblemAlerts() {
  problemTimer = null;
  const batch = problemQueue;
  problemQueue = [];
  if (!batch.length) return;

  const n = batch.length;
  const header = n >= 3
    ? `⚠️ Possible outage — ${n} problem reports in the last few minutes:`
    : `🛠 ${n} new problem report${n > 1 ? 's' : ''}:`;
  // The case number is what makes these actionable from Telegram: reply with
  // "#12 fixed", or /case 12, without opening the panel.
  const lines = batch.slice(0, 15).map(
    (r) => `• #${r.id} ${r.tg_user ? '@' + r.tg_user : 'user ' + r.tg_user_id}: "${String(r.text).slice(0, 120)}"`
  );

  // Highlight a shared symptom/channel so an outage jumps out.
  const topics = {};
  for (const r of batch) if (r.topic) topics[r.topic] = (topics[r.topic] || 0) + 1;
  const hot = Object.entries(topics).filter(([, c]) => c >= 2).map(([t, c]) => `${t} ×${c}`);

  const body =
    `${header}\n${lines.join('\n')}` +
    (hot.length ? `\nMost reported: ${hot.join(', ')}` : '') +
    '\n\nReply "#<number> fixed" to close one, or /case <number> to see it. Full list in the panel → Problem reports.';

  try {
    await hub.notifyAdmins(body);
  } catch {
    // bot offline — the reports are still saved for the panel
  }
}

// Test helper: drain the queue and cancel any pending flush.
export function _resetProblemQueue() {
  problemQueue = [];
  if (problemTimer) {
    clearTimeout(problemTimer);
    problemTimer = null;
  }
}

// ---- Admin resolve → tell the reporter -------------------------------------
// When the admin presses Resolve in the panel, close the loop with the user:
// tag them in the group the report came from (an HTML tg://user mention, so
// it pings even members without an @username), falling back to a DM if the
// group send fails. Template configurable; empty = resolve silently.

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// "the {topic} issue" reads as "the buffering issue"; with no detected topic
// it collapses to plain "the issue" (the old 'reported' filler produced
// "the reported issue you reported").
const fillTopic = (text, topic) => topic
  ? text.replace(/\{topic\}/g, topic)
  : text.replace(/\{topic\}\s+issue/g, 'issue').replace(/\{topic\}\s*/g, '');

// A short human label for a case. The topic is extracted where it can be, but
// it is often empty — a login failure produced none — and "the issue you
// reported" means nothing to someone who has reported three things. Their own
// words always exist, so they are the fallback.
export function caseLabel(report, max = 60) {
  const topic = String(report?.topic || '').trim();
  if (topic) return topic;
  const text = String(report?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export async function notifyResolved(report) {
  const template = String(getSetting('bot.problemResolvedByAdminMessage') || '').trim();
  if (!template || !hub.online || !report?.tg_user_id) return false;

  const mention = `<a href="tg://user?id=${report.tg_user_id}">${escHtml(report.tg_user || 'there')}</a>`;
  const body = fillTopic(escHtml(template), report.topic ? escHtml(report.topic) : null)
    .replace(/\{case\}/g, String(report.id ?? ''))
    .replace(/\{report\}/g, escHtml(caseLabel(report)))
    .replace(/\{name\}/g, mention)
    .replace(/\s+,/g, ',')
    .replace(/ {2,}/g, ' ')
    .trim();

  const targets = [report.chat_id, report.tg_user_id].filter(Boolean);
  for (const target of targets) {
    try {
      await hub.send(target, body, { parse_mode: 'HTML' });
      // A late "no, still broken" from them should escalate directly.
      rearmHook?.(report.tg_user_id);
      return true;
    } catch {
      // try the next target (group first, then DM)
    }
  }
  return false;
}

// ---- Automatic degradation -------------------------------------------------
// Several DIFFERENT people reporting service-wide symptoms (buffering,
// streams not loading, login failures) inside a short window almost always
// means real degradation. Flip the service status automatically: the bot then
// leads every problem answer with the known-issue banner, /status and the
// portal show it, and the AI knows. Single-title complaints (one episode, one
// movie) never count — those reach the admin through normal escalation.
// An admin-set status is never overwritten, and the auto-set one recovers by
// itself once reports stop.

export function maybeAutoDegrade() {
  const threshold = Number(getSetting('problems.degradeThreshold')) || 0;
  if (!threshold) return false;

  const windowMin = Number(getSetting('problems.degradeWindowMinutes')) || 15;
  const recent = db.prepare('SELECT tg_user_id, text, topic, service_num FROM problem_reports WHERE ts > ?')
    .all(now() - windowMin * 60)
    .filter((r) => !isContentIssue(r.text));
  if (!recent.length) return false;

  const describe = (rows) => {
    const counts = {};
    for (const r of rows) if (r.topic) counts[r.topic] = (counts[r.topic] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    return top ? `${top} problems` : 'playback problems';
  };
  const recoverMin = Number(getSetting('problems.degradeRecoverMinutes')) || 30;
  const label2 = (n) => String(getSetting(`services.name${n}`) || '').trim() || `service ${n}`;

  const announce = (scope, rows, people) => {
    const label = describe(rows);
    const note = `We're seeing several reports of ${label} and are looking into it.`;
    const who = scope === 'all' ? 'Service' : label2(scope);
    setSettings(scope === 'all'
      ? { 'service.status': 'degraded', 'service.note': note, 'service.autoDegradedAt': now() }
      : { [`service.status${scope}`]: 'degraded', [`service.note${scope}`]: note, [`service.autoDegradedAt${scope}`]: now() });
    hub.notifyAdmins(
      `🔴 ${who} marked DEGRADED automatically: ${people} different people reported ${label} in the last ${windowMin} minutes.\n` +
      (scope === 'all'
        ? 'Reporters now see the known-issue banner, and /status + the portal show it.\n'
        : `Only ${label2(scope)} customers see the known-issue banner — the other service is untouched.\n`) +
      `It clears itself after ${recoverMin} quiet minutes — or set the status yourself in the panel → Reports.\n\n` +
      'Nobody else has been told. Tap below to post it to the group:',
      { reply_markup: announceKeyboard('outage') }
    ).catch(() => {});
  };

  // Per service first. A fault is usually on ONE of the two panels, and
  // flipping the global status told the other service's customers "we're
  // aware of a service issue" when theirs was fine — sending them hunting for
  // a problem they did not have, and burying the real one.
  let fired = false;
  for (const n of [1, 2]) {
    if (getSetting(`service.status${n}`) !== 'operational') continue;
    const rows = recent.filter((r) => r.service_num === n);
    const people = new Set(rows.map((r) => r.tg_user_id));
    if (people.size < threshold) continue;
    announce(n, rows, people.size);
    fired = true;
  }
  if (fired) return true;

  // Reports we could not pin to a service. Counted on their OWN — a Flix
  // customer reporting alongside four Exclusive ones is not evidence that
  // both services are down, and treating it that way put the banner in front
  // of Flix customers whose service was fine. If both services really do have
  // a problem, each trips its own check above and each gets its own notice.
  if (getSetting('service.status') !== 'operational') return false;
  const unattributed = recent.filter((r) => r.service_num !== 1 && r.service_num !== 2);
  const people = new Set(unattributed.map((r) => r.tg_user_id));
  if (people.size < threshold) return false;
  announce('all', unattributed, people.size);
  return true;
}

// The threshold is a heuristic — several people, short window — so the bot
// offers the announcement instead of making it. A false positive would put
// "we have an outage" in front of paying customers with nobody checking.
function announceKeyboard(kind) {
  return {
    inline_keyboard: [[
      { text: '📢 Announce to the group', callback_data: `announce:${kind}` },
      { text: 'No thanks', callback_data: 'announce:dismiss' },
    ]],
  };
}

// Fills {note} with whatever the bot wrote about what people are reporting.
export function announcementText(kind) {
  const key = kind === 'recovered' ? 'problems.recoveredMessage' : 'problems.announceMessage';
  const template = String(getSetting(key) || '').trim();
  if (!template) return null;
  return template.replace(/\{note\}/g, String(getSetting('service.note') || 'there is a service issue').trim());
}

export function registerOutageAnnounce(bot) {
  bot.callbackQuery(/^announce:(outage|recovered|dismiss)$/, async (ctx) => {
    const kind = ctx.match[1];
    if (!isAdminUser(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Admins only.' });
    if (kind === 'dismiss') {
      await ctx.answerCallbackQuery({ text: 'Left it — nothing posted.' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return;
    }
    const text = announcementText(kind);
    if (!text) return ctx.answerCallbackQuery({ text: 'That message is empty in Bot settings.' });
    await ctx.answerCallbackQuery({ text: 'Posting…' });
    try {
      const results = await hub.sendToAllowedChats(text);
      const ok = results.filter((r) => r.ok).length;
      // The buttons go once used, so a second tap cannot double-post.
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.reply(`📢 Posted to ${ok}/${results.length} chat(s).`).catch(() => {});
    } catch (err) {
      await ctx.reply(`Could not post: ${err.message}`).catch(() => {});
    }
  });
}

// Runs on the scheduler: once reports stop, put the status back — but only
// if it was set automatically and the admin hasn't changed it meanwhile.
export async function degradeRecoverySweep() {
  const recoverMin = Number(getSetting('problems.degradeRecoverMinutes')) || 30;
  const since = now() - recoverMin * 60;
  const recent = db.prepare('SELECT text, service_num FROM problem_reports WHERE ts > ?')
    .all(since)
    .filter((r) => !isContentIssue(r.text));
  const label2 = (n) => String(getSetting(`services.name${n}`) || '').trim() || `service ${n}`;

  const clear = async (scope) => {
    setSettings(scope === 'all'
      ? { 'service.status': 'operational', 'service.note': '', 'service.autoDegradedAt': 0 }
      : { [`service.status${scope}`]: 'operational', [`service.note${scope}`]: '', [`service.autoDegradedAt${scope}`]: 0 });
    try {
      await hub.notifyAdmins(
        `🟢 ${scope === 'all' ? 'Service status' : `${label2(scope)} status`} back to operational — `
        + `no service-wide problem reports for ${recoverMin} minutes (auto-degradation cleared).\n\n`
        + 'If you announced the problem, the group is still waiting to hear it is fixed:',
        { reply_markup: announceKeyboard('recovered') }
      );
    } catch {
      // bot offline — status is reset either way
    }
  };

  // Each service clears on its OWN quiet period. Without this a service the
  // bot degraded on its own would stay degraded forever, because the global
  // recovery check never looked at it.
  for (const n of [1, 2]) {
    const at = Number(getSetting(`service.autoDegradedAt${n}`)) || 0;
    if (!at) continue;
    if (getSetting(`service.status${n}`) !== 'degraded') {
      setSettings({ [`service.autoDegradedAt${n}`]: 0 }); // admin took over
      continue;
    }
    // Only reports from THAT service keep it degraded. An unattributed one
    // counts too — it may well be theirs, and clearing early is the worse
    // mistake of the two.
    if (recent.some((r) => r.service_num === n || r.service_num == null)) continue;
    await clear(n);
  }

  const at = Number(getSetting('service.autoDegradedAt')) || 0;
  if (!at) return;
  if (getSetting('service.status') !== 'degraded') {
    setSettings({ 'service.autoDegradedAt': 0 }); // admin took over
    return;
  }
  if (recent.length) return;
  await clear('all');
}

// ---- Auto-close ------------------------------------------------------------
// Silence usually means resolved: reports that were answered but never
// confirmed get closed after bot.problemAutoCloseMinutes, with one friendly
// group message that doubles as a last chance — the pipeline re-arms the
// user's triage state so a late "no, still broken" escalates directly.
// Escalated reports are NEVER auto-closed; those are in the admin's hands.

let rearmHook = null;
export function setProblemRearmHook(fn) {
  rearmHook = fn;
}

export async function autoCloseSweep() {
  const minutes = Number(getSetting('bot.problemAutoCloseMinutes')) || 0;
  if (!minutes) return;
  const t = now();
  const stale = db.prepare('SELECT * FROM problem_reports WHERE resolved = 0 AND escalated = 0 AND ts < ?')
    .all(t - minutes * 60);
  if (!stale.length) return;

  const template = String(getSetting('bot.problemAutoCloseMessage') || '');
  const ancient = t - 24 * 3600;
  const toMessage = new Map(); // one message per chat+user, not per report

  for (const r of stale) {
    db.prepare("UPDATE problem_reports SET resolved = 1, resolved_by = 'auto-close' WHERE id = ?").run(r.id);
    // Ancient backlog and never-answered reports close silently.
    if (r.ts < ancient || !r.answered || !r.chat_id) continue;
    const key = `${r.chat_id}:${r.tg_user_id}`;
    if (!toMessage.has(key)) toMessage.set(key, r);
  }

  if (!template.trim() || !hub.online) return;
  for (const r of toMessage.values()) {
    const msg = fillTopic(template, r.topic || null)
      .replace(/\{name\}/g, r.tg_user ? `@${r.tg_user}` : '')
      .replace(/\s+,/g, ',')
      .replace(/ {2,}/g, ' ')
      .trim();
    try {
      await hub.send(r.chat_id, msg);
      rearmHook?.(r.tg_user_id);
    } catch (err) {
      console.error('auto-close message failed:', err.message);
    }
  }
}

// ---- admin case control from Telegram ---------------------------------------
// The panel could already close a case, but the admin is usually in Telegram
// when they learn it is fixed — they have just restarted something, or the
// customer told them directly. Making them open a web panel to record that is
// how cases end up stale: the work is done, the row stays open.

const RESOLVE_WORDS = /\b(fixed|sorted|resolved|done|closed?|working( now)?|all good|back up)\b/i;

export const looksLikeCaseClose = (text) => RESOLVE_WORDS.test(String(text || ''));

// "#12", "case 12", "case #12" — the # form is what the alert DMs print.
export function caseNumberIn(text) {
  const m = String(text || '').match(/(?:case\s*#?|#)(\d{1,9})\b/i);
  return m ? Number(m[1]) : null;
}

// An alert DM can name several cases at once, so a bare "fixed" replying to
// it is ambiguous — better to ask than to close the wrong one.
export function caseNumbersIn(text) {
  return [...new Set(
    [...String(text || '').matchAll(/(?:case\s*#?|#)(\d{1,9})\b/gi)].map((m) => Number(m[1]))
  )];
}

export function caseSummary(r) {
  const age = Math.round((now() - r.ts) / 60);
  const when = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
  const who = r.tg_user ? `@${r.tg_user}` : `user ${r.tg_user_id}`;
  return [
    `#${r.id} — ${r.resolved ? `closed (${r.resolved_by || 'unknown'})` : 'OPEN'}${r.escalated ? ' · escalated' : ''}`,
    `${who}${r.topic ? ` · ${r.topic}` : ''} · ${when}`,
    `"${String(r.text).slice(0, 400)}"`,
  ].join('\n');
}

// Closes the case and tells the person who reported it. Returns a line to send
// back to the admin, so every path answers rather than going quiet.
export async function closeCaseAsAdmin(id, by) {
  const r = db.prepare('SELECT * FROM problem_reports WHERE id = ?').get(id);
  if (!r) return `No case #${id}.`;
  if (r.resolved) return `#${id} was already closed (${r.resolved_by || 'unknown'}).`;
  db.prepare("UPDATE problem_reports SET resolved = 1, resolved_by = 'admin' WHERE id = ?").run(id);
  audit('admin', by, 'problems.resolve', `#${id} via telegram`);
  const notified = await notifyResolved(r).catch(() => false);
  // Say WHAT was closed. Closing three in a row, "#1 closed" tells you
  // nothing about which of them you just signed off.
  const label = caseLabel(r);
  const what = label ? ` — "${label}"` : '';
  return notified
    ? `✅ #${id} closed${what}\n${r.tg_user ? '@' + r.tg_user : 'The reporter'} has been told it's fixed.`
    : `✅ #${id} closed${what}\n(Reporter not told — the resolved message is empty in Bot settings.)`;
}

export function openCaseIds(limit = 20) {
  return db.prepare('SELECT id FROM problem_reports WHERE resolved = 0 ORDER BY id DESC LIMIT ?')
    .all(limit).map((r) => r.id);
}

export function openCasesList(limit = 15) {
  const rows = db.prepare(
    'SELECT * FROM problem_reports WHERE resolved = 0 ORDER BY escalated DESC, id DESC LIMIT ?'
  ).all(limit);
  if (!rows.length) return 'No open cases. 🎉';
  return `Open cases (${rows.length}):\n` + rows.map((r) =>
    `#${r.id} ${r.escalated ? '🔴' : '·'} ${r.tg_user ? '@' + r.tg_user : r.tg_user_id}${r.topic ? ` — ${r.topic}` : ''}: "${String(r.text).slice(0, 70)}"`
  ).join('\n') + '\n\nClose one with "#<number> fixed", or /case <number> for the detail.';
}
