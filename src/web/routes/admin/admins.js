import { Router } from 'express';
import { db, now } from '../../../db/db.js';
import { hashPassword } from '../../accounts.js';
import { requireOwner } from '../../middleware.js';
import { audit, randomPassword, formatDate } from '../../../util.js';
import { flash } from '../../middleware.js';

export const adminsRouter = Router();

adminsRouter.get('/admins', (req, res) => {
  const admins = db.prepare('SELECT id, username, role, totp_secret, last_login_at, created_at FROM admins ORDER BY id').all();
  res.render('admin/admins', {
    title: 'Admins',
    admins,
    formatDate,
    isOwner: res.locals.admin.role === 'owner',
    created: req.session.createdAdmin || null,
  });
  delete req.session.createdAdmin;
});

adminsRouter.post('/admins', requireOwner, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40);
  if (!username) {
    flash(req, 'err', 'Username is required.');
    return res.redirect('/admin/admins');
  }
  if (db.prepare('SELECT 1 FROM admins WHERE username = ?').get(username)) {
    flash(req, 'err', 'That username already exists.');
    return res.redirect('/admin/admins');
  }
  const password = randomPassword(14);
  db.prepare('INSERT INTO admins (username, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(username, hashPassword(password), 'admin', now());
  audit('admin', res.locals.admin.username, 'admin.create', username, req.ip);
  req.session.createdAdmin = { username, password };
  flash(req, 'ok', 'Admin created — the password below is shown once. They must change it at first login.');
  res.redirect('/admin/admins');
});

adminsRouter.post('/admins/:id/delete', requireOwner, (req, res) => {
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/admin/admins');
  if (target.id === res.locals.admin.id) {
    flash(req, 'err', 'You cannot delete your own account.');
    return res.redirect('/admin/admins');
  }
  if (target.role === 'owner') {
    flash(req, 'err', 'The owner account cannot be deleted.');
    return res.redirect('/admin/admins');
  }
  db.prepare('DELETE FROM admins WHERE id = ?').run(target.id);
  audit('admin', res.locals.admin.username, 'admin.delete', target.username, req.ip);
  flash(req, 'ok', `Deleted admin ${target.username}.`);
  res.redirect('/admin/admins');
});

adminsRouter.post('/admins/:id/reset-password', requireOwner, (req, res) => {
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/admin/admins');
  const password = randomPassword(14);
  db.prepare('UPDATE admins SET password_hash = ?, must_change_password = 1, totp_secret = NULL, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(hashPassword(password), target.id);
  audit('admin', res.locals.admin.username, 'admin.resetPassword', target.username, req.ip);
  req.session.createdAdmin = { username: target.username, password };
  flash(req, 'ok', 'Password reset (2FA also cleared) — shown once below.');
  res.redirect('/admin/admins');
});
