import { Router } from 'express';
import { db } from '../../../db/db.js';
import { audit, formatDate } from '../../../util.js';
import { flash } from '../../middleware.js';
import { notifyRequestAdded } from '../../../bot/requests.js';

export const requestsRouter = Router();

requestsRouter.get('/requests', (req, res) => {
  const show = req.query.show === 'done' ? 'done' : 'open';
  const requests = db.prepare(
    show === 'open'
      ? "SELECT * FROM vod_requests WHERE status = 'open' ORDER BY ask_count DESC, id DESC LIMIT 300"
      : "SELECT * FROM vod_requests WHERE status != 'open' ORDER BY id DESC LIMIT 300"
  ).all();
  res.render('admin/requests', { title: 'VOD requests', requests, show, formatDate });
});

requestsRouter.post('/requests/:id/added', async (req, res) => {
  const r = db.prepare("SELECT * FROM vod_requests WHERE id = ? AND status = 'open'").get(req.params.id);
  if (!r) return res.redirect('/admin/requests');
  db.prepare("UPDATE vod_requests SET status = 'added' WHERE id = ?").run(r.id);
  audit('admin', res.locals.admin.username, 'vod.added', r.title.slice(0, 80), req.ip);
  const notified = await notifyRequestAdded(r).catch(() => false);
  flash(req, 'ok', notified
    ? `Marked added — ${r.tg_user || 'the requester'} has been told. 🎬`
    : 'Marked added. (Requester not notified — bot offline or the message template is empty.)');
  res.redirect('/admin/requests');
});

requestsRouter.post('/requests/:id/dismiss', (req, res) => {
  db.prepare("UPDATE vod_requests SET status = 'dismissed' WHERE id = ? AND status = 'open'").run(req.params.id);
  audit('admin', res.locals.admin.username, 'vod.dismiss', String(req.params.id), req.ip);
  res.redirect('/admin/requests');
});

requestsRouter.post('/requests/clear-done', (req, res) => {
  db.prepare("DELETE FROM vod_requests WHERE status != 'open'").run();
  audit('admin', res.locals.admin.username, 'vod.clearDone', '', req.ip);
  flash(req, 'ok', 'Cleared handled requests.');
  res.redirect('/admin/requests?show=done');
});
