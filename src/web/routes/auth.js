import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticator } from 'otplib';
import { attemptLogin } from '../accounts.js';
import { audit } from '../../util.js';
import { flash } from '../middleware.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts from this address. Try again later.',
  // An upstream proxy may add X-Forwarded-For even when TRUST_PROXY is off;
  // without this the validator turns every login into a 500. With trust
  // proxy disabled we key on the direct connection IP, which is correct.
  validate: { xForwardedForHeader: false },
});

function regenerate(req) {
  return new Promise((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve()))
  );
}

// ---- Admin ----------------------------------------------------------------

authRouter.get('/admin/login', (req, res) => {
  if (res.locals.admin) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

authRouter.post('/admin/login', loginLimiter, async (req, res) => {
  const { username, password, totp } = req.body;
  const result = attemptLogin('admins', username, password);

  if (!result.ok) {
    audit('system', String(username || ''), 'admin.login.fail', result.reason, req.ip);
    const error = result.reason === 'locked'
      ? 'Account temporarily locked after repeated failures. Try again in 15 minutes.'
      : 'Wrong username or password.';
    return res.status(401).render('admin/login', { error });
  }

  if (result.account.totp_secret) {
    if (!totp || !authenticator.check(String(totp).replace(/\s/g, ''), result.account.totp_secret)) {
      audit('system', result.account.username, 'admin.login.fail', '2fa', req.ip);
      return res.status(401).render('admin/login', { error: 'Two-factor code required or incorrect.' });
    }
  }

  await regenerate(req);
  req.session.adminId = result.account.id;
  audit('admin', result.account.username, 'admin.login', '', req.ip);
  res.redirect(result.account.must_change_password ? '/admin/password' : '/admin');
});

authRouter.post('/admin/logout', (req, res) => {
  const name = res.locals.admin?.username || '';
  delete req.session.adminId;
  audit('admin', name, 'admin.logout', '', req.ip);
  res.redirect('/admin/login');
});

// ---- Customer ---------------------------------------------------------------

authRouter.get('/login', (req, res) => {
  if (res.locals.customer) return res.redirect('/portal');
  res.render('portal/login', { error: null });
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const result = attemptLogin('customers', username, password);

  if (!result.ok) {
    audit('system', String(username || ''), 'customer.login.fail', result.reason, req.ip);
    const error = result.reason === 'locked'
      ? 'Too many wrong attempts. This account is locked for 15 minutes.'
      : 'Wrong username or password.';
    return res.status(401).render('portal/login', { error });
  }

  await regenerate(req);
  req.session.customerId = result.account.id;
  audit('customer', result.account.username, 'customer.login', '', req.ip);
  res.redirect('/portal');
});

authRouter.post('/logout', (req, res) => {
  const name = res.locals.customer?.username || '';
  delete req.session.customerId;
  audit('customer', name, 'customer.logout', '', req.ip);
  res.redirect('/login');
});
