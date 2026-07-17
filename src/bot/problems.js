import { db, now } from '../db/db.js';
import { getSetting } from '../settings.js';
import { hub } from './hub.js';

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
