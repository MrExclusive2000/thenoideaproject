import crypto from 'node:crypto';
import { db, now } from '../db/db.js';
import { getSetting } from '../settings.js';
import { state } from '../state.js';

export function locals(req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  res.locals.appName = getSetting('branding.appName');
  res.locals.accentColor = getSetting('branding.accentColor');
  res.locals.hasLogo = Boolean(getSetting('branding.logoFile'));
  res.locals.path = req.path;
  res.locals.csrf = csrfToken(req);
  res.locals.flash = req.session?.flash || null;
  if (req.session?.flash) delete req.session.flash;
  res.locals.admin = null;
  res.locals.customer = null;
  res.locals.botState = state.bot;
  // Plain-HTTP warning for the admin panel (expected reality on a game-panel
  // allocation, but the admin should see it every time).
  res.locals.httpWarning = !req.secure && !['localhost', '127.0.0.1'].includes(req.hostname);

  if (req.session?.adminId) {
    res.locals.admin = db.prepare('SELECT id, username, role, must_change_password FROM admins WHERE id = ?')
      .get(req.session.adminId) || null;
    if (!res.locals.admin) delete req.session.adminId;
  }
  if (req.session?.customerId) {
    res.locals.customer = db.prepare('SELECT id, username, display_name, active, expires_at FROM customers WHERE id = ?')
      .get(req.session.customerId) || null;
    if (!res.locals.customer) delete req.session.customerId;
  }
  next();
}

export function flash(req, type, message) {
  req.session.flash = { type, message };
}

function csrfToken(req) {
  if (!req.session) return '';
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}

function csrfValid(req) {
  const sent = req.body?._csrf || req.get('x-csrf-token');
  if (!sent || !req.session?.csrf) return false;
  return crypto.timingSafeEqual(
    Buffer.from(String(sent).padEnd(64).slice(0, 64)),
    Buffer.from(String(req.session.csrf).padEnd(64).slice(0, 64))
  );
}

function csrfReject(res) {
  return res.status(403).render('error', { title: 'Blocked', message: 'Invalid or missing security token. Go back and try again.' });
}

export function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Multipart bodies are parsed later by multer — those routes must apply
  // csrfAfterUpload right after their multer middleware instead.
  if ((req.get('content-type') || '').startsWith('multipart/form-data')) return next();
  if (!csrfValid(req)) return csrfReject(res);
  next();
}

// Place immediately after multer on multipart routes.
export function csrfAfterUpload(req, res, next) {
  if (csrfValid(req)) return next();
  if (req.file) {
    import('node:fs').then((fs) => fs.unlink(req.file.path, () => {}));
  }
  return csrfReject(res);
}

export function requireAdmin(req, res, next) {
  if (!res.locals.admin) return res.redirect('/admin/login');
  // req.path is relative to the router's mount point (/admin).
  const fullPath = (req.baseUrl || '') + req.path;
  if (res.locals.admin.must_change_password && fullPath !== '/admin/password') {
    return res.redirect('/admin/password');
  }
  next();
}

export function requireOwner(req, res, next) {
  if (res.locals.admin?.role !== 'owner') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Only the owner account can do this.' });
  }
  next();
}

export function requireCustomer(req, res, next) {
  const customer = res.locals.customer;
  if (!customer) return res.redirect('/login');
  if (!customer.active) return res.status(403).render('portal/blocked', { reason: 'disabled' });
  if (customer.expires_at && customer.expires_at < now()) {
    return res.status(403).render('portal/blocked', { reason: 'expired' });
  }
  next();
}
