import { Router } from 'express';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { db } from '../../../db/db.js';
import { hashPassword } from '../../accounts.js';
import { audit } from '../../../util.js';
import { flash } from '../../middleware.js';
import { getSetting } from '../../../settings.js';
import bcrypt from 'bcryptjs';

export const accountRouter = Router();

accountRouter.get('/password', async (req, res) => {
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(res.locals.admin.id);
  let qrDataUrl = null;
  let pendingSecret = null;
  if (!admin.totp_secret && req.session.pendingTotpSecret) {
    pendingSecret = req.session.pendingTotpSecret;
    const uri = authenticator.keyuri(admin.username, getSetting('branding.appName'), pendingSecret);
    qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 200 });
  }
  res.render('admin/password', {
    title: 'Password & 2FA',
    mustChange: Boolean(admin.must_change_password),
    totpEnabled: Boolean(admin.totp_secret),
    qrDataUrl,
    pendingSecret,
  });
});

accountRouter.post('/password', (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(res.locals.admin.id);

  if (!bcrypt.compareSync(String(current_password || ''), admin.password_hash)) {
    flash(req, 'err', 'Current password is wrong.');
    return res.redirect('/admin/password');
  }
  if (!new_password || new_password.length < 10) {
    flash(req, 'err', 'New password must be at least 10 characters.');
    return res.redirect('/admin/password');
  }
  if (new_password !== confirm_password) {
    flash(req, 'err', 'New passwords do not match.');
    return res.redirect('/admin/password');
  }
  db.prepare('UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(hashPassword(new_password), admin.id);
  audit('admin', admin.username, 'admin.password.change', '', req.ip);
  flash(req, 'ok', 'Password updated.');
  res.redirect('/admin');
});

// --- TOTP 2FA -----------------------------------------------------------

accountRouter.post('/2fa/start', (req, res) => {
  req.session.pendingTotpSecret = authenticator.generateSecret();
  res.redirect('/admin/password');
});

accountRouter.post('/2fa/confirm', (req, res) => {
  const secret = req.session.pendingTotpSecret;
  const code = String(req.body.code || '').replace(/\s/g, '');
  if (!secret || !authenticator.check(code, secret)) {
    flash(req, 'err', 'That code did not match. Scan the QR again and retry.');
    return res.redirect('/admin/password');
  }
  db.prepare('UPDATE admins SET totp_secret = ? WHERE id = ?').run(secret, res.locals.admin.id);
  delete req.session.pendingTotpSecret;
  audit('admin', res.locals.admin.username, 'admin.2fa.enable', '', req.ip);
  flash(req, 'ok', 'Two-factor authentication enabled. You will need a code at every login.');
  res.redirect('/admin/password');
});

accountRouter.post('/2fa/disable', (req, res) => {
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(res.locals.admin.id);
  if (!bcrypt.compareSync(String(req.body.password || ''), admin.password_hash)) {
    flash(req, 'err', 'Password required to disable 2FA.');
    return res.redirect('/admin/password');
  }
  db.prepare('UPDATE admins SET totp_secret = NULL WHERE id = ?').run(admin.id);
  audit('admin', admin.username, 'admin.2fa.disable', '', req.ip);
  flash(req, 'ok', 'Two-factor authentication disabled.');
  res.redirect('/admin/password');
});
