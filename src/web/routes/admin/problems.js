import { Router } from 'express';
import { db, now } from '../../../db/db.js';
import { audit, formatDate } from '../../../util.js';
import { flash } from '../../middleware.js';

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

  res.render('admin/problems', { title: 'Problem reports', reports, hot, show, formatDate });
});

problemsRouter.post('/problems/:id/resolve', (req, res) => {
  db.prepare('UPDATE problem_reports SET resolved = 1 WHERE id = ?').run(req.params.id);
  res.redirect('/admin/problems');
});

problemsRouter.post('/problems/resolve-all', (req, res) => {
  db.prepare('UPDATE problem_reports SET resolved = 1 WHERE resolved = 0').run();
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
