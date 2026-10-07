import { Router } from 'express';
import { db, now } from '../../../db/db.js';
import { recurringUnresolved } from '../../../ai/learn.js';
import { audit, formatDate } from '../../../util.js';
import { flash } from '../../middleware.js';
import { notifyResolved } from '../../../bot/problems.js';

export const problemsRouter = Router();

problemsRouter.get('/problems', (req, res) => {
  const show = req.query.show === 'resolved' ? 'resolved' : 'open';
  const reports = db.prepare(
    'SELECT * FROM problem_reports WHERE resolved = ? ORDER BY id DESC LIMIT 300'
  ).all(show === 'resolved' ? 1 : 0);

  // Shared symptoms in the last 24h — an outage jumps out here.
  const hot = db.prepare(`
    SELECT topic, COUNT(*) c, MAX(ts) last FROM problem_reports
    WHERE resolved = 0 AND topic IS NOT NULL AND ts > ?
    GROUP BY topic HAVING c >= 2 ORDER BY c DESC LIMIT 8
  `).all(now() - 86400);

  // Different question from `hot` above: not "what is breaking right now"
  // but "what has the bot never managed to fix". These are the gaps worth an
  // admin writing an answer for — and deliberately NOT auto-drafted, because
  // the bot already had an answer here and it did not work.
  const recurring = recurringUnresolved({ sinceDays: 30, minCount: 3 });

  res.render('admin/problems', { title: 'Problem reports', reports, hot, recurring, show, formatDate });
});

problemsRouter.post('/problems/:id/resolve', async (req, res) => {
  const r = db.prepare('SELECT * FROM problem_reports WHERE id = ?').get(req.params.id);
  if (!r || r.resolved) {
    res.redirect('/admin/problems');
    return;
  }
  db.prepare("UPDATE problem_reports SET resolved = 1, resolved_by = 'admin' WHERE id = ?").run(r.id);
  audit('admin', res.locals.admin.username, 'problems.resolve', String(r.id), req.ip);
  const notified = await notifyResolved(r).catch(() => false);
  flash(req, 'ok', notified
    ? `Resolved — ${r.tg_user || 'the reporter'} has been told it's fixed.`
    : 'Marked resolved. (Reporter not notified — bot offline or the message template is empty.)');
  res.redirect('/admin/problems');
});

problemsRouter.post('/problems/resolve-all', (req, res) => {
  db.prepare("UPDATE problem_reports SET resolved = 1, resolved_by = 'admin' WHERE resolved = 0").run();
  audit('admin', res.locals.admin.username, 'problems.resolveAll', '', req.ip);
  flash(req, 'ok', 'All open problem reports marked resolved.');
  res.redirect('/admin/problems');
});

problemsRouter.post('/problems/clear-resolved', (req, res) => {
  db.prepare('DELETE FROM problem_reports WHERE resolved = 1').run();
  audit('admin', res.locals.admin.username, 'problems.clearResolved', '', req.ip);
  flash(req, 'ok', 'Cleared resolved problem reports.');
  res.redirect('/admin/problems?show=resolved');
});
