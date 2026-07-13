import { Router } from 'express';
import { db, now } from '../../../db/db.js';
import { audit, renderMarkdown, slugify } from '../../../util.js';
import { flash } from '../../middleware.js';

export const guidesRouter = Router();

guidesRouter.get('/guides', (req, res) => {
  const guides = db.prepare('SELECT * FROM guides ORDER BY sort, id').all();
  res.render('admin/guides', { title: 'Guides', guides });
});

guidesRouter.get('/guides/new', (req, res) => {
  res.render('admin/guide-edit', { title: 'New guide', guide: null, preview: null });
});

guidesRouter.get('/guides/:id', (req, res) => {
  const guide = db.prepare('SELECT * FROM guides WHERE id = ?').get(req.params.id);
  if (!guide) return res.redirect('/admin/guides');
  res.render('admin/guide-edit', { title: `Edit: ${guide.title}`, guide, preview: renderMarkdown(guide.body_md) });
});

guidesRouter.post('/guides', (req, res) => {
  const { id, title, body_md, sort, visible } = req.body;
  const cleanTitle = String(title || '').trim().slice(0, 150);
  if (!cleanTitle) {
    flash(req, 'err', 'Title is required.');
    return res.redirect('/admin/guides');
  }
  const body = String(body_md || '').slice(0, 60000);
  const sortVal = Number(sort) || 0;
  const visibleVal = visible === '1' ? 1 : 0;
  const t = now();

  if (id) {
    db.prepare('UPDATE guides SET title = ?, body_md = ?, sort = ?, visible = ?, updated_at = ? WHERE id = ?')
      .run(cleanTitle, body, sortVal, visibleVal, t, id);
    audit('admin', res.locals.admin.username, 'guide.update', cleanTitle, req.ip);
    flash(req, 'ok', 'Guide saved.');
    return res.redirect(`/admin/guides/${id}`);
  }

  let slug = slugify(cleanTitle);
  if (db.prepare('SELECT 1 FROM guides WHERE slug = ?').get(slug)) slug = `${slug}-${Date.now() % 10000}`;
  const info = db.prepare('INSERT INTO guides (title, slug, body_md, sort, visible, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(cleanTitle, slug, body, sortVal, visibleVal, t);
  audit('admin', res.locals.admin.username, 'guide.create', cleanTitle, req.ip);
  flash(req, 'ok', 'Guide created.');
  res.redirect(`/admin/guides/${info.lastInsertRowid}`);
});

guidesRouter.post('/guides/:id/delete', (req, res) => {
  const guide = db.prepare('SELECT title FROM guides WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM guides WHERE id = ?').run(req.params.id);
  audit('admin', res.locals.admin.username, 'guide.delete', guide?.title || '', req.ip);
  flash(req, 'ok', 'Guide deleted.');
  res.redirect('/admin/guides');
});
