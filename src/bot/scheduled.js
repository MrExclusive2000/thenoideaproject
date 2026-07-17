import { db, now } from '../db/db.js';
import { getSetting, setSetting } from '../settings.js';
import { hub } from './hub.js';
import { tokens, matchFaq } from '../faq/matcher.js';
import { composeFaqSuggestion } from '../ai/client.js';

// ---- Scheduled broadcasts ---------------------------------------------------
// One-off ("UFC reminder Saturday 9pm") or recurring (daily/weekly). send_at
// always holds the NEXT fire time; after firing, recurring rows advance into
// the future — a server that was down does NOT spam catch-up messages.

const PERIODS = { daily: 86400, weekly: 7 * 86400 };

export async function sweepScheduledBroadcasts() {
  const t = now();
  const due = db.prepare('SELECT * FROM scheduled_broadcasts WHERE enabled = 1 AND send_at <= ?').all(t);
  for (const b of due) {
    if (!hub.online) return; // retry next minute without advancing
    let ok = 0;
    let summary = '';
    try {
      const results = await hub.sendToAllowedChats(b.body);
      ok = results.filter((r) => r.ok).length;
      summary = results.map((r) => `${r.chat}: ${r.ok ? 'sent' : `failed (${r.error})`}`).join('; ');
    } catch (err) {
      summary = err.message;
    }
    db.prepare('INSERT INTO broadcasts (body, status, result, sent_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.body, ok > 0 ? 'sent' : 'failed', summary, t, 'scheduler', t);
    const period = PERIODS[b.repeat];
    if (period) {
      let next = b.send_at;
      while (next <= t) next += period;
      db.prepare('UPDATE scheduled_broadcasts SET send_at = ?, last_sent_at = ? WHERE id = ?').run(next, t, b.id);
    } else {
      db.prepare('UPDATE scheduled_broadcasts SET enabled = 0, last_sent_at = ? WHERE id = ?').run(t, b.id);
    }
  }
}

// ---- Customer expiry messages ----------------------------------------------
// Reminder BEFORE expiry, one upsell ON/after expiry day. Both templated
// ({name}, {days}); an empty template switches that message off. Only
// customers who linked their Telegram can be DMed.

function fillTemplate(template, c, daysLeft = null) {
  return template
    .replace(/\{name\}/g, c.display_name || c.username || 'there')
    .replace(/\{days\}/g, daysLeft === null ? '' : String(daysLeft))
    .replace(/ {2,}/g, ' ')
    .trim();
}

export async function expiryReminders() {
  if (!hub.online) return;
  const template = String(getSetting('portal.expiryReminderMessage') || '').trim();
  if (!template) return;
  const daysBefore = Number(getSetting('portal.expiryReminderDays')) || 3;
  const t = now();
  const rows = db.prepare(`
    SELECT * FROM customers
    WHERE active = 1 AND telegram_user_id IS NOT NULL
      AND expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?
      AND (reminder_sent_at IS NULL OR reminder_sent_at < expires_at - ?)
  `).all(t, t + daysBefore * 86400, daysBefore * 86400);
  for (const c of rows) {
    const daysLeft = Math.max(1, Math.ceil((c.expires_at - t) / 86400));
    try {
      await hub.send(c.telegram_user_id, fillTemplate(template, c, daysLeft));
    } catch {
      // user may have blocked the bot — don't retry every sweep
    }
    db.prepare('UPDATE customers SET reminder_sent_at = ? WHERE id = ?').run(t, c.id);
  }
}

export async function expiryUpsells() {
  if (!hub.online) return;
  const template = String(getSetting('portal.expiryUpsellMessage') || '').trim();
  if (!template) return;
  const t = now();
  // Expired within the last 3 days and not yet messaged since THIS expiry —
  // older lapses stay quiet (nagging someone gone for weeks feels spammy).
  const rows = db.prepare(`
    SELECT * FROM customers
    WHERE active = 1 AND telegram_user_id IS NOT NULL
      AND expires_at IS NOT NULL AND expires_at <= ? AND expires_at > ?
      AND (upsell_sent_at IS NULL OR upsell_sent_at < expires_at)
  `).all(t, t - 3 * 86400);
  for (const c of rows) {
    try {
      await hub.send(c.telegram_user_id, fillTemplate(template, c));
    } catch {
      // blocked or never DMed the bot — mark anyway, no retry loop
    }
    db.prepare('UPDATE customers SET upsell_sent_at = ? WHERE id = ?').run(t, c.id);
  }
}

// ---- Suggested FAQs ---------------------------------------------------------
// Weekly: cluster recent unanswered questions, draft an FAQ per cluster with
// the AI (template fallback when it's down), store as pending suggestions for
// the admin to approve in the panel, and DM the admin a summary.

function clusterUnanswered(rows) {
  const clusters = [];
  for (const row of rows) {
    const toks = new Set(tokens(row.text));
    if (!toks.size) continue;
    let placed = false;
    for (const c of clusters) {
      const shared = [...toks].filter((tk) => c.toks.has(tk));
      // Two shared words, or one DISTINCTIVE shared word ("chromecast",
      // "buffering") — short generic tokens ("app", "work") never cluster
      // on their own.
      if (shared.length >= 2 || shared.some((tk) => tk.length >= 6)) {
        c.rows.push(row);
        for (const tk of toks) c.toks.add(tk);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ rows: [row], toks: new Set(toks) });
  }
  return clusters.sort((a, b) => b.rows.length - a.rows.length);
}

export async function generateFaqSuggestions({ maxSuggestions = 5, sinceDays = 14 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM unanswered
    WHERE resolved = 0 AND ts > ? AND source IN ('ai-refused', 'nomatch')
    ORDER BY id DESC LIMIT 200
  `).all(now() - sinceDays * 86400);
  if (!rows.length) return [];

  const faqs = db.prepare('SELECT * FROM faqs WHERE enabled = 1').all();
  const pending = db.prepare("SELECT question, answer, keywords FROM suggested_faqs WHERE status = 'pending'").all()
    .map((s) => ({ ...s, enabled: 1 }));
  const created = [];

  for (const cluster of clusterUnanswered(rows)) {
    if (created.length >= maxSuggestions) break;
    const samples = cluster.rows.slice(0, 5).map((r) => r.text);
    // Already answerable, or already suggested? Skip the cluster.
    if (matchFaq(samples[0], faqs, 0.5).match) continue;
    if (pending.length && matchFaq(samples[0], pending, 0.45).match) continue;

    let draft = null;
    if (getSetting('ai.enabled')) {
      try {
        draft = await composeFaqSuggestion(samples);
      } catch {
        // AI down — template fallback below
      }
    }
    if (!draft) {
      draft = {
        question: samples[0].slice(0, 300),
        answer: '[ADMIN: write the answer — the bot could not answer this]',
        keywords: [...new Set(tokens(samples.join(' ')))].slice(0, 10).join(', '),
      };
    }
    const t = now();
    db.prepare('INSERT INTO suggested_faqs (question, answer, keywords, ask_count, samples, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(draft.question, draft.answer, draft.keywords, cluster.rows.length, JSON.stringify(samples.slice(0, 3)), 'pending', t);
    // The source questions are handled now — clear them from the inbox.
    const ids = cluster.rows.map((r) => r.id);
    db.prepare(`UPDATE unanswered SET resolved = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    created.push(draft);
    pending.push({ ...draft, enabled: 1 });
  }
  return created;
}

export async function suggestFaqsSweep() {
  if (!getSetting('suggest.faqs')) return;
  const last = Number(getSetting('suggest.lastRunAt')) || 0;
  if (now() - last < 7 * 86400) return;
  setSetting('suggest.lastRunAt', now());
  const created = await generateFaqSuggestions();
  if (created.length) {
    await hub.notifyAdmins(
      `💡 ${created.length} suggested FAQ${created.length > 1 ? 's' : ''} drafted from recent unanswered questions:\n` +
      created.map((c) => `• ${c.question}`).join('\n') +
      '\n\nReview and approve them in the panel → FAQs.'
    ).catch(() => {});
  }
}
