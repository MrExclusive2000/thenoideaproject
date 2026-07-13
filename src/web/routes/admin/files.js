import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { db, now } from '../../../db/db.js';
import { config } from '../../../config.js';
import { getSetting, setSetting } from '../../../settings.js';
import { hub } from '../../../bot/hub.js';
import { audit, randomCode, formatBytes } from '../../../util.js';
import { flash, csrfAfterUpload } from '../../middleware.js';

export const filesRouter = Router();

const ALLOWED_EXTENSIONS = new Set(['.apk', '.zip', '.ipa', '.exe', '.pdf', '.txt', '.mp4']);
// Magic bytes: APK/ZIP/IPA are ZIP archives, EXE is MZ, PDF is %PDF.
const MAGIC = {
  '.apk': [Buffer.from('PK')],
  '.zip': [Buffer.from('PK')],
  '.ipa': [Buffer.from('PK')],
  '.exe': [Buffer.from('MZ')],
  '.pdf': [Buffer.from('%PDF')],
};

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`),
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
});

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

filesRouter.get('/files', (req, res) => {
  const files = db.prepare(`
    SELECT f.*, (SELECT COUNT(*) FROM downloads d WHERE d.file_id = f.id) AS download_count
    FROM files f ORDER BY f.id DESC
  `).all();
  const codes = db.prepare(`
    SELECT dc.*, f.display_name, c.username AS customer_name
    FROM download_codes dc
    JOIN files f ON f.id = dc.file_id
    LEFT JOIN customers c ON c.id = dc.customer_id
    WHERE dc.expires_at > ? ORDER BY dc.created_at DESC LIMIT 50
  `).all(now());
  const customers = db.prepare('SELECT id, username FROM customers WHERE active = 1 ORDER BY username').all();
  res.render('admin/files', {
    title: 'Downloads',
    files,
    codes,
    customers,
    formatBytes,
    autoAnnounce: getSetting('files.autoAnnounce'),
    maxUploadMb: config.maxUploadMb,
  });
});

filesRouter.post('/files/upload', upload.single('file'), csrfAfterUpload, async (req, res) => {
  const file = req.file;
  if (!file) {
    flash(req, 'err', 'No file received.');
    return res.redirect('/admin/files');
  }
  const cleanup = () => fs.unlink(file.path, () => {});

  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    cleanup();
    flash(req, 'err', `File type ${ext || '(none)'} is not allowed. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
    return res.redirect('/admin/files');
  }

  if (MAGIC[ext]) {
    const fd = fs.openSync(file.path, 'r');
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);
    if (!MAGIC[ext].some((sig) => head.subarray(0, sig.length).equals(sig))) {
      cleanup();
      flash(req, 'err', `That file does not look like a real ${ext} file — upload rejected.`);
      return res.redirect('/admin/files');
    }
  }

  const sha256 = await sha256File(file.path);
  const displayName = String(req.body.display_name || '').trim().slice(0, 120) || file.originalname;
  const version = String(req.body.version || '').trim().slice(0, 40);
  const description = String(req.body.description || '').trim().slice(0, 2000);
  const markLatest = req.body.is_latest === '1';

  const insert = db.transaction(() => {
    if (markLatest) db.prepare('UPDATE files SET is_latest = 0').run();
    return db.prepare(`
      INSERT INTO files (stored_name, display_name, original_name, description, version, category, size, sha256, is_latest, uploaded_by, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      path.basename(file.path), displayName, file.originalname, description, version,
      String(req.body.category || '').trim().slice(0, 40), file.size, sha256,
      markLatest ? 1 : 0, res.locals.admin.username, now()
    );
  });
  insert();

  audit('admin', res.locals.admin.username, 'file.upload', `${displayName} v${version} (${formatBytes(file.size)})`, req.ip);

  if (getSetting('files.autoAnnounce') && hub.online) {
    const url = config.publicUrl ? `${config.publicUrl}/login` : 'the customer portal';
    hub.sendToAllowedChats(
      `📦 New download available: ${displayName}${version ? ` v${version}` : ''}\n` +
      (description ? `${description.slice(0, 400)}\n` : '') +
      `Get it from ${url}`
    ).catch((err) => console.error('auto-announce failed:', err.message));
  }

  flash(req, 'ok', `Uploaded "${displayName}" (${formatBytes(file.size)}).`);
  res.redirect('/admin/files');
});

filesRouter.post('/files/:id/update', (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!file) return res.redirect('/admin/files');
  const markLatest = req.body.is_latest === '1';
  const tx = db.transaction(() => {
    if (markLatest) db.prepare('UPDATE files SET is_latest = 0').run();
    db.prepare('UPDATE files SET display_name = ?, version = ?, description = ?, is_latest = ? WHERE id = ?').run(
      String(req.body.display_name || '').trim().slice(0, 120) || file.display_name,
      String(req.body.version || '').trim().slice(0, 40),
      String(req.body.description || '').trim().slice(0, 2000),
      markLatest ? 1 : file.is_latest,
      file.id
    );
  });
  tx();
  audit('admin', res.locals.admin.username, 'file.update', file.display_name, req.ip);
  flash(req, 'ok', 'File details updated.');
  res.redirect('/admin/files');
});

filesRouter.post('/files/:id/toggle', (req, res) => {
  db.prepare('UPDATE files SET visible = 1 - visible WHERE id = ?').run(req.params.id);
  res.redirect('/admin/files');
});

filesRouter.post('/files/:id/delete', (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (file) {
    db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
    fs.unlink(path.join(config.uploadsDir, path.basename(file.stored_name)), () => {});
    audit('admin', res.locals.admin.username, 'file.delete', file.display_name, req.ip);
    flash(req, 'ok', `Deleted "${file.display_name}".`);
  }
  res.redirect('/admin/files');
});

// Mint a short download code (typed into the Downloader app on a Firestick).
filesRouter.post('/files/:id/code', (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!file) return res.redirect('/admin/files');
  const code = randomCode(6);
  const days = Math.max(1, Math.min(90, Number(req.body.days) || 7));
  const maxUses = Math.max(1, Math.min(1000, Number(req.body.max_uses) || 3));
  const customerId = req.body.customer_id ? Number(req.body.customer_id) : null;
  db.prepare('INSERT INTO download_codes (code, file_id, customer_id, max_uses, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(code, file.id, customerId, maxUses, now() + days * 86400, res.locals.admin.username, now());
  audit('admin', res.locals.admin.username, 'file.code.create', `${code} → ${file.display_name}`, req.ip);
  flash(req, 'ok', `Code ${code} created — customers can enter ${config.publicUrl || 'http://YOUR-ADDRESS'}/d/${code} in the Downloader app.`);
  res.redirect('/admin/files');
});

filesRouter.post('/files/codes/:code/delete', (req, res) => {
  db.prepare('DELETE FROM download_codes WHERE code = ?').run(req.params.code);
  audit('admin', res.locals.admin.username, 'file.code.delete', req.params.code, req.ip);
  res.redirect('/admin/files');
});

filesRouter.post('/files/auto-announce', (req, res) => {
  setSetting('files.autoAnnounce', req.body.enabled === '1');
  audit('admin', res.locals.admin.username, 'files.autoAnnounce', req.body.enabled === '1' ? 'on' : 'off', req.ip);
  res.redirect('/admin/files');
});
