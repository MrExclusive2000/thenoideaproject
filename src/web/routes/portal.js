import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db, now } from '../../db/db.js';
import { config } from '../../config.js';
import { getSetting } from '../../settings.js';
import { requireCustomer } from '../middleware.js';
import { audit, randomCode, renderMarkdown, formatBytes, formatDate } from '../../util.js';
import { flash } from '../middleware.js';

export const portalRouter = Router();

portalRouter.get('/', (req, res) => {
  res.redirect(res.locals.customer ? '/portal' : '/login');
});

portalRouter.get('/logo', (req, res) => {
  const logo = getSetting('branding.logoFile');
  if (!logo) return res.status(404).end();
  res.sendFile(path.join(config.brandingDir, path.basename(logo)));
});

// Sends the real bytes with attachment headers; used by both the portal list
// and short codes. Filenames end in the true extension so the Downloader app
// on Fire TV treats it as a file download.
function sendFileDownload(req, res, file, customerId, via) {
  const filePath = path.join(config.uploadsDir, path.basename(file.stored_name));
  if (!fs.existsSync(filePath)) {
    return res.status(410).render('error', { title: 'Gone', message: 'This file is no longer on the server. Contact support.' });
  }
  db.prepare('INSERT INTO downloads (file_id, customer_id, via, ip, ts) VALUES (?, ?, ?, ?, ?)')
    .run(file.id, customerId, via, req.ip, now());
  audit(customerId ? 'customer' : 'system', String(customerId || via), 'download', file.display_name, req.ip);

  const ext = path.extname(file.original_name) || '.bin';
  const safeBase = (file.display_name || 'download').replace(/[^a-zA-Z0-9._ -]/g, '').trim().replace(/\s+/g, '-') || 'download';
  const filename = safeBase.toLowerCase().endsWith(ext.toLowerCase()) ? safeBase : safeBase + ext;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.download(filePath, filename);
}

// ---- Logged-in portal ----------------------------------------------------------

portalRouter.get('/portal', requireCustomer, (req, res) => {
  const files = db.prepare(`
    SELECT * FROM files WHERE visible = 1
    ORDER BY is_latest DESC, uploaded_at DESC
  `).all();
  res.render('portal/home', {
    title: 'Downloads',
    subtitle: 'Your downloads',
    files,
    formatBytes,
    formatDate,
    serviceStatus: getSetting('service.status'),
    serviceNote: getSetting('service.note'),
  });
});

portalRouter.get('/portal/download/:id/:name?', requireCustomer, (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND visible = 1').get(req.params.id);
  if (!file) return res.status(404).render('error', { title: 'Not found', message: 'That file does not exist.' });
  sendFileDownload(req, res, file, res.locals.customer.id, 'portal');
});

portalRouter.get('/portal/guides', requireCustomer, (req, res) => {
  const guides = db.prepare('SELECT id, title, slug, updated_at FROM guides WHERE visible = 1 ORDER BY sort, id').all();
  res.render('portal/guides', { title: 'Guides', subtitle: 'Setup & help guides', guides, formatDate });
});

portalRouter.get('/portal/guides/:slug', requireCustomer, (req, res) => {
  const guide = db.prepare('SELECT * FROM guides WHERE slug = ? AND visible = 1').get(req.params.slug);
  if (!guide) return res.status(404).render('error', { title: 'Not found', message: 'That guide does not exist.' });
  res.render('portal/guide', { title: guide.title, subtitle: '', guide, body: renderMarkdown(guide.body_md), formatDate });
});

portalRouter.get('/portal/account', requireCustomer, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(res.locals.customer.id);
  const linkCode = db.prepare('SELECT * FROM link_codes WHERE customer_id = ? AND used = 0 AND expires_at > ?')
    .get(customer.id, now());
  res.render('portal/account', { title: 'Account', subtitle: 'Your account', c: customer, linkCode, formatDate, nowTs: now() });
});

// Customers can mint their own Telegram link code from the portal.
portalRouter.post('/portal/account/link-code', requireCustomer, (req, res) => {
  const customerId = res.locals.customer.id;
  db.prepare('DELETE FROM link_codes WHERE customer_id = ?').run(customerId);
  const code = randomCode(8);
  db.prepare('INSERT INTO link_codes (code, customer_id, expires_at) VALUES (?, ?, ?)')
    .run(code, customerId, now() + 48 * 3600);
  audit('customer', res.locals.customer.username, 'customer.linkCode.self', '', req.ip);
  res.redirect('/portal/account');
});

// ---- Short download codes (no login — typed into the Downloader app) ------------

const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Tolerate X-Forwarded-For from an untrusted upstream (see auth.js).
  validate: { xForwardedForHeader: false },
});

portalRouter.get('/d/:code', codeLimiter, (req, res) => {
  const raw = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  const code = db.prepare('SELECT * FROM download_codes WHERE code = ?').get(raw);
  if (!code || code.expires_at < now() || code.uses >= code.max_uses) {
    return res.status(404).render('portal/code-invalid', { title: 'Code not valid', subtitle: '' });
  }
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(code.file_id);
  if (!file) return res.status(404).render('portal/code-invalid', { title: 'Code not valid', subtitle: '' });

  db.prepare('UPDATE download_codes SET uses = uses + 1 WHERE code = ?').run(code.code);
  sendFileDownload(req, res, file, code.customer_id, `code:${code.code}`);
});
