import { Router } from 'express';
import { db, now } from '../../../db/db.js';
import { getSetting } from '../../../settings.js';
import { matchFaq, scoreFaq } from '../../../faq/matcher.js';
import { audit } from '../../../util.js';
import { flash } from '../../middleware.js';

export const faqsRouter = Router();

faqsRouter.get('/faqs', (req, res) => {
  const faqs = db.prepare('SELECT * FROM faqs ORDER BY priority DESC, id DESC').all();
  const editing = req.query.edit
    ? db.prepare('SELECT * FROM faqs WHERE id = ?').get(req.query.edit)
    : null;

  let test = null;
  if (req.query.q) {
    const result = matchFaq(req.query.q, faqs, Number(getSetting('faq.threshold')));
    test = {
      q: req.query.q,
      matched: result.match,
      threshold: Number(getSetting('faq.threshold')),
      rows: result.scores.slice(0, 8).map((s) => ({
        question: s.faq.question,
        score: s.score.toFixed(3),
        keywordHits: s.keywordHits,
      })),
    };
  }

  res.render('admin/faqs', { title: 'FAQ manager', faqs, editing, test });
});

faqsRouter.post('/faqs', (req, res) => {
  const { id, question, answer, keywords, priority } = req.body;
  const q = String(question || '').trim().slice(0, 500);
  const a = String(answer || '').trim().slice(0, 3000);
  if (!q || !a) {
    flash(req, 'err', 'Question and answer are both required.');
    return res.redirect('/admin/faqs');
  }
  const kw = String(keywords || '').trim().slice(0, 300);
  const prio = Math.max(0, Math.min(10, Number(priority) || 0));
  const t = now();

  if (id) {
    db.prepare('UPDATE faqs SET question = ?, answer = ?, keywords = ?, priority = ?, updated_at = ? WHERE id = ?')
      .run(q, a, kw, prio, t, id);
    audit('admin', res.locals.admin.username, 'faq.update', q.slice(0, 80), req.ip);
    flash(req, 'ok', 'FAQ updated.');
  } else {
    db.prepare('INSERT INTO faqs (question, answer, keywords, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(q, a, kw, prio, t, t);
    audit('admin', res.locals.admin.username, 'faq.create', q.slice(0, 80), req.ip);
    flash(req, 'ok', 'FAQ added. The bot can use it immediately.');
  }
  res.redirect('/admin/faqs');
});

faqsRouter.post('/faqs/:id/toggle', (req, res) => {
  db.prepare('UPDATE faqs SET enabled = 1 - enabled, updated_at = ? WHERE id = ?').run(now(), req.params.id);
  res.redirect('/admin/faqs');
});

faqsRouter.post('/faqs/:id/delete', (req, res) => {
  db.prepare('DELETE FROM faqs WHERE id = ?').run(req.params.id);
  audit('admin', res.locals.admin.username, 'faq.delete', String(req.params.id), req.ip);
  flash(req, 'ok', 'FAQ deleted.');
  res.redirect('/admin/faqs');
});

// ---- Unanswered inbox --------------------------------------------------------

faqsRouter.get('/unanswered', (req, res) => {
  const items = db.prepare(`
    SELECT u.*, f.question AS near_miss_question
    FROM unanswered u LEFT JOIN faqs f ON f.id = u.near_miss_faq_id
    WHERE u.resolved = 0 ORDER BY u.id DESC LIMIT 200
  `).all();
  res.render('admin/unanswered', { title: 'Unanswered questions', items });
});

faqsRouter.post('/unanswered/:id/resolve', (req, res) => {
  db.prepare('UPDATE unanswered SET resolved = 1 WHERE id = ?').run(req.params.id);
  res.redirect('/admin/unanswered');
});

faqsRouter.post('/unanswered/resolve-all', (req, res) => {
  db.prepare('UPDATE unanswered SET resolved = 1 WHERE resolved = 0').run();
  flash(req, 'ok', 'Inbox cleared.');
  res.redirect('/admin/unanswered');
});

// One click: turn an unanswered question into a prefilled FAQ form.
faqsRouter.post('/unanswered/:id/convert', (req, res) => {
  const item = db.prepare('SELECT * FROM unanswered WHERE id = ?').get(req.params.id);
  if (!item) return res.redirect('/admin/unanswered');
  const t = now();
  const info = db.prepare('INSERT INTO faqs (question, answer, keywords, enabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(item.text.slice(0, 500), '(write the answer, then enable)', '', t, t);
  db.prepare('UPDATE unanswered SET resolved = 1 WHERE id = ?').run(item.id);
  audit('admin', res.locals.admin.username, 'faq.fromUnanswered', item.text.slice(0, 80), req.ip);
  flash(req, 'ok', 'Draft FAQ created (disabled) — write the answer and enable it.');
  res.redirect(`/admin/faqs?edit=${info.lastInsertRowid}`);
});
