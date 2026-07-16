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
