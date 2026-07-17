import { Router } from 'express';
import { db, now } from '../../../db/db.js';
import { getSetting, setSettings } from '../../../settings.js';
import { hub } from '../../../bot/hub.js';
import { audit, formatDate } from '../../../util.js';
import { flash } from '../../middleware.js';

export const broadcastsRouter = Router();

broadcastsRouter.get('/broadcasts', (req, res) => {
  const broadcasts = db.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 50').all();
  const scheduled = db.prepare('SELECT * FROM scheduled_broadcasts ORDER BY enabled DESC, send_at ASC LIMIT 50').all();
  res.render('admin/broadcasts', {
    title: 'Broadcasts',
    broadcasts,
    scheduled,
    serverNow: new Date().toISOString().slice(0, 16).replace('T', ' '),
    promo: {
      enabled: getSetting('promo.enabled'),
      intervalDays: getSetting('promo.intervalDays'),
      hour: getSetting('promo.hour'),
      messages: (getSetting('promo.messages') || []).join('\n---\n'),
    },
    formatDate,
    botOnline: hub.online,
  });
});

broadcastsRouter.post('/broadcasts/promo', (req, res) => {
  const messages = String(req.body.messages || '')
    .split(/\n\s*---\s*\n?/)
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((m) => m.slice(0, 1000));
  setSettings({
    'promo.enabled': req.body.enabled === '1' && messages.length > 0,
    'promo.intervalDays': Math.max(1, Math.min(30, Number(req.body.intervalDays) || 3)),
    'promo.hour': Math.max(0, Math.min(23, Number(req.body.hour) || 0)),
    'promo.messages': messages,
  });
  audit('admin', res.locals.admin.username, 'promo.settings', `${messages.length} message(s), every ${req.body.intervalDays}d`, req.ip);
  flash(req, 'ok', messages.length ? 'Promo rotation saved.' : 'Promo rotation saved (no messages — rotation off).');
  res.redirect('/admin/broadcasts');
});

// Compute the next occurrence of HH:MM (optionally on a weekday) in UTC.
function nextOccurrence(hour, minute, dow = null) {
  const d = new Date();
  d.setUTCHours(hour, minute, 0, 0);
  if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
  if (dow !== null) {
    while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  }
  return Math.floor(d.getTime() / 1000);
}

broadcastsRouter.post('/broadcasts/schedule', (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 3500);
  const repeat = ['once', 'daily', 'weekly'].includes(req.body.repeat) ? req.body.repeat : 'once';
  if (!body) {
    flash(req, 'err', 'Message is empty.');
    return res.redirect('/admin/broadcasts');
  }

  let sendAt = null;
  if (repeat === 'once') {
    // datetime-local, interpreted as server time (UTC).
    const parsed = Date.parse(`${String(req.body.sendAt || '')}Z`);
    if (!Number.isFinite(parsed) || parsed <= Date.now()) {
      flash(req, 'err', 'Pick a date and time in the future (server time).');
      return res.redirect('/admin/broadcasts');
    }
    sendAt = Math.floor(parsed / 1000);
  } else {
    const hour = Math.max(0, Math.min(23, Number(req.body.hour) || 0));
    const minute = Math.max(0, Math.min(59, Number(req.body.minute) || 0));
    const dow = repeat === 'weekly' ? Math.max(0, Math.min(6, Number(req.body.dow) || 0)) : null;
    sendAt = nextOccurrence(hour, minute, dow);
  }

  db.prepare('INSERT INTO scheduled_broadcasts (body, send_at, repeat, enabled, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run(body, sendAt, repeat, res.locals.admin.username, now());
  audit('admin', res.locals.admin.username, 'broadcast.schedule', `${repeat} — ${body.slice(0, 60)}`, req.ip);
  flash(req, 'ok', `Scheduled (${repeat}). First send: ${formatDate(sendAt)} server time.`);
  res.redirect('/admin/broadcasts');
});

broadcastsRouter.post('/broadcasts/schedule/:id/toggle', (req, res) => {
  db.prepare('UPDATE scheduled_broadcasts SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
  audit('admin', res.locals.admin.username, 'broadcast.schedule.toggle', String(req.params.id), req.ip);
  res.redirect('/admin/broadcasts');
});

broadcastsRouter.post('/broadcasts/schedule/:id/delete', (req, res) => {
  db.prepare('DELETE FROM scheduled_broadcasts WHERE id = ?').run(req.params.id);
  audit('admin', res.locals.admin.username, 'broadcast.schedule.delete', String(req.params.id), req.ip);
  flash(req, 'ok', 'Scheduled broadcast deleted.');
  res.redirect('/admin/broadcasts');
});

broadcastsRouter.post('/broadcasts', async (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 3500);
  if (!body) {
    flash(req, 'err', 'Message is empty.');
    return res.redirect('/admin/broadcasts');
  }
  const info = db.prepare('INSERT INTO broadcasts (body, status, created_by, created_at) VALUES (?, ?, ?, ?)')
    .run(body, 'pending', res.locals.admin.username, now());
  audit('admin', res.locals.admin.username, 'broadcast.create', body.slice(0, 80), req.ip);

  try {
    const results = await hub.sendToAllowedChats(body);
    const ok = results.filter((r) => r.ok).length;
    const summary = results.map((r) => `${r.chat}: ${r.ok ? 'sent' : `failed (${r.error})`}`).join('; ');
    db.prepare('UPDATE broadcasts SET status = ?, result = ?, sent_at = ? WHERE id = ?')
      .run(ok > 0 ? 'sent' : 'failed', summary, now(), info.lastInsertRowid);
    flash(req, ok > 0 ? 'ok' : 'err', ok > 0 ? `Broadcast sent to ${ok} chat${ok > 1 ? 's' : ''}.` : `Broadcast failed: ${summary}`);
  } catch (err) {
    db.prepare('UPDATE broadcasts SET status = ?, result = ? WHERE id = ?').run('failed', err.message, info.lastInsertRowid);
    flash(req, 'err', `Broadcast failed: ${err.message}`);
  }
  res.redirect('/admin/broadcasts');
});

broadcastsRouter.post('/broadcasts/:id/retry', async (req, res) => {
  const bc = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(req.params.id);
  if (!bc) return res.redirect('/admin/broadcasts');
  try {
    const results = await hub.sendToAllowedChats(bc.body);
    const ok = results.filter((r) => r.ok).length;
    db.prepare('UPDATE broadcasts SET status = ?, result = ?, sent_at = ? WHERE id = ?')
      .run(ok > 0 ? 'sent' : 'failed', results.map((r) => `${r.chat}: ${r.ok ? 'sent' : 'failed'}`).join('; '), now(), bc.id);
    flash(req, ok > 0 ? 'ok' : 'err', ok > 0 ? 'Broadcast sent.' : 'Still failing.');
  } catch (err) {
    flash(req, 'err', `Failed: ${err.message}`);
  }
  res.redirect('/admin/broadcasts');
});
