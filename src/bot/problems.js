import { db, now } from '../db/db.js';
import { getSetting, setSettings } from '../settings.js';
import { hub } from './hub.js';
import { isContentIssue } from './helpers.js';

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
  const lines = batch.slice(0, 15).map(
    (r) => `• ${r.tg_user ? '@' + r.tg_user : 'user ' + r.tg_user_id}: "${String(r.text).slice(0, 120)}"`
  );

  // Highlight a shared symptom/channel so an outage jumps out.
  const topics = {};
  for (const r of batch) if (r.topic) topics[r.topic] = (topics[r.topic] || 0) + 1;
  const hot = Object.entries(topics).filter(([, c]) => c >= 2).map(([t, c]) => `${t} ×${c}`);

  const body =
    `${header}\n${lines.join('\n')}` +
    (hot.length ? `\nMost reported: ${hot.join(', ')}` : '') +
    '\n\nReview them in the panel → Problem reports.';

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

export async function notifyResolved(report) {
  const template = String(getSetting('bot.problemResolvedByAdminMessage') || '').trim();
  if (!template || !hub.online || !report?.tg_user_id) return false;

  const mention = `<a href="tg://user?id=${report.tg_user_id}">${escHtml(report.tg_user || 'there')}</a>`;
  const body = escHtml(template)
    .replace(/\{name\}/g, mention)
    .replace(/\{topic\}/g, escHtml(report.topic || 'reported'))
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
  if (getSetting('service.status') !== 'operational') return false;

  const windowMin = Number(getSetting('problems.degradeWindowMinutes')) || 15;
  const wide = db.prepare('SELECT tg_user_id, text, topic FROM problem_reports WHERE ts > ?')
    .all(now() - windowMin * 60)
    .filter((r) => !isContentIssue(r.text));
  const users = new Set(wide.map((r) => r.tg_user_id));
  if (users.size < threshold) return false;

  const counts = {};
  for (const r of wide) if (r.topic) counts[r.topic] = (counts[r.topic] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const label = top ? `${top} problems` : 'playback problems';
  const recoverMin = Number(getSetting('problems.degradeRecoverMinutes')) || 30;

  setSettings({
    'service.status': 'degraded',
    'service.note': `We're seeing several reports of ${label} and are looking into it.`,
    'service.autoDegradedAt': now(),
  });
  hub.notifyAdmins(
    `🔴 Service marked DEGRADED automatically: ${users.size} different people reported ${label} in the last ${windowMin} minutes.\n` +
    'Reporters now see the known-issue banner, and /status + the portal show it.\n' +
    `It clears itself after ${recoverMin} quiet minutes — or set the status yourself in the panel → Reports.`
  ).catch(() => {});
  return true;
}

// Runs on the scheduler: once reports stop, put the status back — but only
// if it was set automatically and the admin hasn't changed it meanwhile.
export async function degradeRecoverySweep() {
  const at = Number(getSetting('service.autoDegradedAt')) || 0;
  if (!at) return;
  if (getSetting('service.status') !== 'degraded') {
    setSettings({ 'service.autoDegradedAt': 0 }); // admin took over
    return;
  }
  const recoverMin = Number(getSetting('problems.degradeRecoverMinutes')) || 30;
  const recent = db.prepare('SELECT text FROM problem_reports WHERE ts > ?')
    .all(now() - recoverMin * 60)
    .filter((r) => !isContentIssue(r.text));
  if (recent.length) return;

  setSettings({ 'service.status': 'operational', 'service.note': '', 'service.autoDegradedAt': 0 });
  try {
    await hub.notifyAdmins(`🟢 Service status back to operational — no service-wide problem reports for ${recoverMin} minutes (auto-degradation cleared).`);
  } catch {
    // bot offline — status is reset either way
  }
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
    db.prepare('UPDATE problem_reports SET resolved = 1 WHERE id = ?').run(r.id);
    // Ancient backlog and never-answered reports close silently.
    if (r.ts < ancient || !r.answered || !r.chat_id) continue;
    const key = `${r.chat_id}:${r.tg_user_id}`;
    if (!toMessage.has(key)) toMessage.set(key, r);
  }

  if (!template.trim() || !hub.online) return;
  for (const r of toMessage.values()) {
    const msg = template
      .replace(/\{name\}/g, r.tg_user ? `@${r.tg_user}` : '')
      .replace(/\{topic\}/g, r.topic || 'reported')
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
