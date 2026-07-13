import { Router } from 'express';
import { db, now } from '../../../db/db.js';
import { hub } from '../../../bot/hub.js';
import { audit, formatDate } from '../../../util.js';
import { flash } from '../../middleware.js';

export const broadcastsRouter = Router();

broadcastsRouter.get('/broadcasts', (req, res) => {
  const broadcasts = db.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 50').all();
  res.render('admin/broadcasts', {
    title: 'Broadcasts',
    broadcasts,
    formatDate,
    botOnline: hub.online,
  });
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
