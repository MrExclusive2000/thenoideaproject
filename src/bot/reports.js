import { db, now } from '../db/db.js';
import { getSetting, setSetting } from '../settings.js';
import { composeDigest, aiUsageToday } from '../ai/client.js';
import { hub } from './hub.js';
import { vetSweep } from './joiners.js';
import { autoCloseSweep, degradeRecoverySweep } from './problems.js';
import { sweepScheduledBroadcasts, expiryReminders, expiryUpsells, suggestFaqsSweep } from './scheduled.js';

// Instant alerts, throttled per type so a flapping error can't flood DMs.
const lastAlert = new Map();
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;

export async function alertAdmins(type, text) {
  const toggles = {
    error: 'reports.alertErrors',
    budget: 'reports.alertBudget',
    bannedWord: 'reports.alertBannedWords',
    ticket: 'reports.alertTickets',
    problem: 'reports.alertProblems',
  };
  const settingKey = toggles[type];
  if (settingKey && !getSetting(settingKey)) return;
  const last = lastAlert.get(type) || 0;
  if (type !== 'ticket' && Date.now() - last < ALERT_COOLDOWN_MS) return;
  lastAlert.set(type, Date.now());
  try {
    await hub.notifyAdmins(text);
  } catch {
    // bot offline — nothing to do
  }
}

export function buildStatsText(days) {
  const t = now();
  const since = t - days * 86400;
  const n = (sql, ...p) => db.prepare(sql).get(...p).n;

  const total = n('SELECT COUNT(*) n FROM messages_log WHERE ts > ?', since);
  const faq = n("SELECT COUNT(*) n FROM messages_log WHERE ts > ? AND reply_source = 'faq'", since);
  const ai = n("SELECT COUNT(*) n FROM messages_log WHERE ts > ? AND reply_source = 'ai'", since);
  const unanswered = n('SELECT COUNT(*) n FROM unanswered WHERE ts > ? AND resolved = 0', since);
  const openTickets = n("SELECT COUNT(*) n FROM tickets WHERE status != 'closed'");
  const newCustomers = n('SELECT COUNT(*) n FROM customers WHERE created_at > ?', since);
  const expiring = n('SELECT COUNT(*) n FROM customers WHERE active = 1 AND expires_at BETWEEN ? AND ?', t, t + 7 * 86400);
  const downloads = n('SELECT COUNT(*) n FROM downloads WHERE ts > ?', since);
  const up = n("SELECT COUNT(*) n FROM answer_feedback WHERE ts > ? AND rating = 'up'", since);
  const down = n("SELECT COUNT(*) n FROM answer_feedback WHERE ts > ? AND rating = 'down'", since);

  const topDownloads = db.prepare(`
    SELECT f.display_name, f.version, COUNT(*) c FROM downloads d JOIN files f ON f.id = d.file_id
    WHERE d.ts > ? GROUP BY d.file_id ORDER BY c DESC LIMIT 5
  `).all(since);
  const topUnanswered = db.prepare(
    'SELECT text FROM unanswered WHERE ts > ? AND resolved = 0 ORDER BY id DESC LIMIT 8'
  ).all(since);

  const lines = [
    `Period: last ${days} day(s)`,
    `Messages seen: ${total}`,
    `Answered by FAQ: ${faq} | by AI: ${ai}`,
    `AI usage today: ${aiUsageToday().calls} calls`,
    `Answer ratings: ${up} up / ${down} down`,
    `Unanswered questions waiting: ${unanswered}`,
    `Open tickets: ${openTickets}`,
    `New customers: ${newCustomers} | expiring within 7 days: ${expiring}`,
    `Downloads: ${downloads}`,
  ];
  if (topDownloads.length) {
    lines.push('Top downloads: ' + topDownloads.map((d) => `${d.display_name}${d.version ? ` v${d.version}` : ''} (${d.c})`).join(', '));
  }
  if (topUnanswered.length) {
    lines.push('Recent unanswered: ' + topUnanswered.map((u) => `"${u.text.slice(0, 60)}"`).join(' | '));
  }
  return lines.join('\n');
}

export async function sendDigest(period) {
  const days = period === 'weekly' ? 7 : 1;
  const stats = buildStatsText(days);
  const { body, ai } = await composeDigest(stats);
  const text = `📊 ${getSetting('branding.appName')} — ${period} report${ai ? '' : ' (raw stats — AI unavailable)'}\n\n${body}`;
  db.prepare('INSERT INTO digests (period, body, created_at) VALUES (?, ?, ?)').run(period, text, now());
  let delivered = false;
  try {
    delivered = await hub.notifyAdmins(text);
  } catch {
    delivered = false;
  }
  return { body: text, delivered };
}

// ---- schedulers -------------------------------------------------------------

function pruneOldData() {
  const days = Number(getSetting('retention.messagesDays')) || 30;
  const t = now();
  db.prepare('DELETE FROM messages_log WHERE ts < ?').run(t - days * 86400);
  db.prepare('DELETE FROM link_codes WHERE expires_at < ?').run(t - 86400);
  db.prepare('DELETE FROM download_codes WHERE expires_at < ?').run(t - 7 * 86400);
  db.prepare('DELETE FROM audit_log WHERE ts < ?').run(t - 365 * 86400);
}

async function digestTick() {
  const schedule = getSetting('reports.digest');
  if (schedule === 'off') return;
  const hour = Number(getSetting('reports.digestHour')) || 9;
  const nowDate = new Date();
  if (nowDate.getUTCHours() !== hour) return;
  const today = nowDate.toISOString().slice(0, 10);
  if (getSetting('reports.lastDigestDay') === today) return;
  if (schedule === 'weekly' && nowDate.getUTCDay() !== 1) return;
  setSetting('reports.lastDigestDay', today);
  try {
    await sendDigest(schedule);
  } catch (err) {
    console.error('digest failed:', err.message);
  }
}

export function startSchedulers() {
  let lastVetAt = 0;
  const timer = setInterval(() => {
    digestTick();
    expiryReminders().catch(() => {});
    expiryUpsells().catch(() => {});
    sweepScheduledBroadcasts().catch((err) => console.error('scheduled broadcast failed:', err.message));
    if (Date.now() - lastVetAt > 15 * 60 * 1000) {
      lastVetAt = Date.now();
      vetSweep().catch((err) => console.error('vet sweep failed:', err.message));
      autoCloseSweep().catch((err) => console.error('auto-close sweep failed:', err.message));
      degradeRecoverySweep().catch((err) => console.error('degrade recovery sweep failed:', err.message));
      suggestFaqsSweep().catch((err) => console.error('faq suggestion sweep failed:', err.message));
    }
  }, 60 * 1000);
  timer.unref();
  const pruneTimer = setInterval(pruneOldData, 6 * 3600 * 1000);
  pruneTimer.unref();
  pruneOldData();
}
