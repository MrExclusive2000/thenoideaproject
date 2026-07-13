import { Router } from 'express';
import { db, now } from '../../../db/db.js';
import { hashPassword } from '../../accounts.js';
import { audit, randomCode, randomPassword, formatDate } from '../../../util.js';
import { flash } from '../../middleware.js';

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
  flash(req, 'ok', `${created.length} account${created.length > 1 ? 's' : ''} created — passwords are shown below ONCE, copy them now.`);
  res.redirect('/admin/customers');
});

customersRouter.get('/customers/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/admin/customers');
  const downloadHistory = db.prepare(`
    SELECT d.*, f.display_name FROM downloads d JOIN files f ON f.id = d.file_id
    WHERE d.customer_id = ? ORDER BY d.ts DESC LIMIT 50
  `).all(customer.id);
  const linkCode = db.prepare('SELECT * FROM link_codes WHERE customer_id = ? AND used = 0 AND expires_at > ? ORDER BY expires_at DESC')
    .get(customer.id, now());
  const tickets = db.prepare('SELECT * FROM tickets WHERE customer_id = ? ORDER BY id DESC LIMIT 20').all(customer.id);
  res.render('admin/customer-edit', {
    title: `Customer: ${customer.username}`,
    customer,
    downloadHistory,
    linkCode,
    tickets,
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

// One-time code the customer sends to the bot as /link CODE to connect their
// Telegram account (enables /myaccount, /download, expiry reminder DMs).
customersRouter.post('/customers/:id/link-code', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/admin/customers');
  db.prepare('DELETE FROM link_codes WHERE customer_id = ?').run(customer.id);
  const code = randomCode(8);
  db.prepare('INSERT INTO link_codes (code, customer_id, expires_at) VALUES (?, ?, ?)')
    .run(code, customer.id, now() + 48 * 3600);
  audit('admin', res.locals.admin.username, 'customer.linkCode', customer.username, req.ip);
  flash(req, 'ok', `Link code created. Tell the customer to DM the bot: /link ${code} (valid 48h).`);
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
