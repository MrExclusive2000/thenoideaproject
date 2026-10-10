import { Router } from 'express';
import { db, now } from '../../../db/db.js';
import { hashPassword } from '../../accounts.js';
import { setSetting } from '../../../settings.js';
import { audit, randomPassword, formatDate } from '../../../util.js';
import { flash, portalLoginOn } from '../../middleware.js';

export const customersRouter = Router();

customersRouter.get('/customers', (req, res) => {
  const filter = req.query.filter || 'all';
  const q = String(req.query.q || '').trim();
  let where = '1=1';
  const params = [];
  if (filter === 'expiring') {
    where = 'active = 1 AND expires_at IS NOT NULL AND expires_at BETWEEN ? AND ?';
    params.push(now(), now() + 7 * 86400);
  } else if (filter === 'disabled') {
    where = 'active = 0';
  } else if (filter === 'expired') {
    where = 'expires_at IS NOT NULL AND expires_at < ?';
    params.push(now());
  }
  if (q) {
    where += ' AND (username LIKE ? OR display_name LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  const customers = db.prepare(`SELECT * FROM customers WHERE ${where} ORDER BY id DESC LIMIT 500`).all(...params);
  res.render('admin/customers', {
    title: 'Customers',
    customers,
    filter,
    q,
    formatDate,
    nowTs: now(),
    created: req.session.createdCustomers || null,
  });
  delete req.session.createdCustomers;
});

// The customer website's on/off switch lives here rather than in a settings
// page, because this is the page it changes the meaning of: with it off, the
// passwords this page mints are not used for anything.
customersRouter.post('/customers/portal-login', (req, res) => {
  const on = req.body.enabled === '1';
  setSetting('portal.customerLogin', on);
  audit('admin', res.locals.admin.username, on ? 'portal.login.enable' : 'portal.login.disable', '', req.ip);
  flash(req, 'ok', on
    ? 'Customer sign-in is ON. /login and the download pages are live again.'
    : 'Customer sign-in is OFF. Anyone already signed in has been signed out. Short download codes still work.');
  res.redirect('/admin/customers');
});

customersRouter.post('/customers', (req, res) => {
  const count = Math.max(1, Math.min(50, Number(req.body.count) || 1));
  const baseName = String(req.body.username || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40);
  const displayName = String(req.body.display_name || '').trim().slice(0, 100);
  const notes = String(req.body.notes || '').trim().slice(0, 500);
  const days = Number(req.body.expires_days) || 0;
  const expiresAt = days > 0 ? now() + days * 86400 : null;

  if (!baseName) {
    flash(req, 'err', 'Username is required.');
    return res.redirect('/admin/customers');
  }

  const created = [];
  for (let i = 0; i < count; i++) {
    const username = count === 1 ? baseName : `${baseName}${String(i + 1).padStart(2, '0')}`;
    if (db.prepare('SELECT 1 FROM customers WHERE username = ?').get(username)) {
      flash(req, 'err', `Username "${username}" already exists — nothing was created.`);
      return res.redirect('/admin/customers');
    }
    created.push({ username, password: randomPassword(10) });
  }

  const tx = db.transaction(() => {
    for (const c of created) {
      db.prepare(`INSERT INTO customers (username, password_hash, display_name, notes, expires_at, created_by, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(c.username, hashPassword(c.password), displayName, notes, expiresAt, res.locals.admin.username, now());
    }
  });
  tx();

  audit('admin', res.locals.admin.username, 'customer.create', created.map((c) => c.username).join(', '), req.ip);
  req.session.createdCustomers = created;
  flash(req, 'ok', portalLoginOn()
    ? `${created.length} account${created.length > 1 ? 's' : ''} created — passwords are shown below ONCE, copy them now.`
    : `${created.length} account${created.length > 1 ? 's' : ''} created. Customer sign-in is off, so the password is not used for anything — link their Telegram instead.`);
  res.redirect('/admin/customers');
});

customersRouter.get('/customers/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/admin/customers');
  const downloadHistory = db.prepare(`
    SELECT d.*, f.display_name FROM downloads d JOIN files f ON f.id = d.file_id
    WHERE d.customer_id = ? ORDER BY d.ts DESC LIMIT 50
  `).all(customer.id);
  res.render('admin/customer-edit', {
    title: `Customer: ${customer.username}`,
    customer,
    downloadHistory,
    formatDate,
    nowTs: now(),
    newPassword: req.session.newCustomerPassword || null,
  });
  delete req.session.newCustomerPassword;
});

customersRouter.post('/customers/:id/update', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/admin/customers');
  db.prepare('UPDATE customers SET display_name = ?, notes = ? WHERE id = ?')
    .run(String(req.body.display_name || '').trim().slice(0, 100), String(req.body.notes || '').trim().slice(0, 500), customer.id);
  flash(req, 'ok', 'Saved.');
  res.redirect(`/admin/customers/${customer.id}`);
});

customersRouter.post('/customers/:id/extend', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/admin/customers');
  let expiresAt;
  if (req.body.date) {
    expiresAt = Math.floor(new Date(`${req.body.date}T23:59:59Z`).getTime() / 1000);
    if (Number.isNaN(expiresAt)) {
      flash(req, 'err', 'Invalid date.');
      return res.redirect(`/admin/customers/${customer.id}`);
    }
  } else if (req.body.days === 'never') {
    expiresAt = null;
  } else {
    const days = Number(req.body.days) || 30;
    const base = customer.expires_at && customer.expires_at > now() ? customer.expires_at : now();
    expiresAt = base + days * 86400;
  }
  db.prepare('UPDATE customers SET expires_at = ?, reminder_sent_at = NULL WHERE id = ?').run(expiresAt, customer.id);
  audit('admin', res.locals.admin.username, 'customer.extend', `${customer.username} → ${expiresAt ? formatDate(expiresAt) : 'never'}`, req.ip);
  flash(req, 'ok', expiresAt ? `Now expires ${formatDate(expiresAt)}.` : 'Set to never expire.');
  res.redirect(`/admin/customers/${customer.id}`);
});

customersRouter.post('/customers/:id/reset-password', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/admin/customers');
  const password = randomPassword(10);
  db.prepare('UPDATE customers SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(hashPassword(password), customer.id);
  audit('admin', res.locals.admin.username, 'customer.resetPassword', customer.username, req.ip);
  req.session.newCustomerPassword = password;
  flash(req, 'ok', 'New password generated — shown once below.');
  res.redirect(`/admin/customers/${customer.id}`);
});

customersRouter.post('/customers/:id/toggle', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/admin/customers');
  db.prepare('UPDATE customers SET active = 1 - active WHERE id = ?').run(customer.id);
  audit('admin', res.locals.admin.username, customer.active ? 'customer.disable' : 'customer.enable', customer.username, req.ip);
  res.redirect(`/admin/customers/${customer.id}`);
});

customersRouter.post('/customers/:id/delete', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (customer) {
    db.prepare('DELETE FROM customers WHERE id = ?').run(customer.id);
    audit('admin', res.locals.admin.username, 'customer.delete', customer.username, req.ip);
    flash(req, 'ok', `Deleted ${customer.username}.`);
  }
  res.redirect('/admin/customers');
});

// Connecting a customer to their Telegram account is what drives expiry
// reminder DMs, new-member vetting and download attribution. It used to be
// self-service: the panel minted a code and the customer sent the bot
// /link CODE. /link is gone with the rest of the bot's account commands, so
// the admin sets the id directly — the member sends the bot /id, which still
// exists and answers with their user id, and passes it on.
customersRouter.post('/customers/:id/link', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/admin/customers');

  const raw = String(req.body.telegramUserId || '').trim().replace(/^@/, '');
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    flash(req, 'err', 'That is not a Telegram user ID. It is a number — ask them to send the bot /id and read back "Your user ID".');
    return res.redirect(`/admin/customers/${customer.id}`);
  }

  // telegram_user_id is UNIQUE: the same person cannot hold two accounts, and
  // silently stealing the id from another customer would break their expiry
  // DMs without anyone noticing.
  const clash = db.prepare('SELECT id, username FROM customers WHERE telegram_user_id = ? AND id != ?').get(id, customer.id);
  if (clash) {
    flash(req, 'err', `That Telegram ID is already linked to ${clash.username}. Unlink it there first.`);
    return res.redirect(`/admin/customers/${customer.id}`);
  }

  db.prepare('UPDATE customers SET telegram_user_id = ? WHERE id = ?').run(id, customer.id);
  audit('admin', res.locals.admin.username, 'customer.link', `${customer.username} -> tg:${id}`, req.ip);
  flash(req, 'ok', 'Linked. They will get expiry reminders from the bot.');
  res.redirect(`/admin/customers/${customer.id}`);
});

customersRouter.post('/customers/:id/unlink', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/admin/customers');
  db.prepare('UPDATE customers SET telegram_user_id = NULL WHERE id = ?').run(customer.id);
  audit('admin', res.locals.admin.username, 'customer.unlink', customer.username, req.ip);
  flash(req, 'ok', 'Telegram account unlinked.');
  res.redirect(`/admin/customers/${customer.id}`);
});
