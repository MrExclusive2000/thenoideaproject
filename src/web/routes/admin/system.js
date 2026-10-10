import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { db, now } from '../../../db/db.js';
import { config } from '../../../config.js';
import { getSetting, setSettings, setSetting } from '../../../settings.js';
import { audit, formatDate } from '../../../util.js';
import { flash, csrfAfterUpload } from '../../middleware.js';
import { localBuild, updateCheck, describeUpdate } from '../../../build.js';
import { exportLineup } from '../../../lineup-export.js';

export const systemRouter = Router();

// ---- Audit log ---------------------------------------------------------------

systemRouter.get('/audit', (req, res) => {
  const page = Math.max(0, Number(req.query.page) || 0);
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100 OFFSET ?').all(page * 100);
  const total = db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;
  res.render('admin/audit', { title: 'Audit log', rows, page, total, formatDate });
});

// ---- Branding + backup ---------------------------------------------------------

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: config.brandingDir,
    filename: (req, file, cb) => cb(null, `logo-${Date.now()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

// Checking costs a network round trip, so it happens on request rather than
// on every page load. The result is cached in the module for a few minutes.
systemRouter.post('/system/check-updates', async (req, res) => {
  const remote = await updateCheck({ force: true });
  flash(req, remote?.error ? 'err' : 'ok', describeUpdate(localBuild(), remote));
  res.redirect('/admin/system');
});

systemRouter.get('/system', (req, res) => {
  const dbSize = fs.existsSync(config.dbFile) ? fs.statSync(config.dbFile).size : 0;
  let uploadsSize = 0;
  for (const f of fs.readdirSync(config.uploadsDir)) {
    try { uploadsSize += fs.statSync(path.join(config.uploadsDir, f)).size; } catch { /* ignore */ }
  }
  res.render('admin/system', {
    title: 'Branding & backup',
    build: localBuild(),
    autoUpdate: config.autoUpdate,
    s: {
      appName: getSetting('branding.appName'),
      accentColor: getSetting('branding.accentColor'),
      logoFile: getSetting('branding.logoFile'),
    },
    dbSizeMb: (dbSize / 1048576).toFixed(1),
    uploadsSizeMb: (uploadsSize / 1048576).toFixed(1),
    publicUrl: config.publicUrl,
  });
});

systemRouter.post('/system/branding', (req, res) => {
  const appName = String(req.body.appName || '').trim().slice(0, 60) || 'Support Suite';
  let accent = String(req.body.accentColor || '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(accent)) accent = '#6366f1';
  setSettings({ 'branding.appName': appName, 'branding.accentColor': accent });
  audit('admin', res.locals.admin.username, 'branding.update', appName, req.ip);
  flash(req, 'ok', 'Branding saved.');
  res.redirect('/admin/system');
});

systemRouter.post('/system/logo', logoUpload.single('logo'), csrfAfterUpload, (req, res) => {
  const file = req.file;
  if (!file) {
    flash(req, 'err', 'No image received.');
    return res.redirect('/admin/system');
  }
  const ext = path.extname(file.originalname).toLowerCase();
  const head = Buffer.alloc(8);
  const fd = fs.openSync(file.path, 'r');
  fs.readSync(fd, head, 0, 8, 0);
  fs.closeSync(fd);
  const isPng = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isJpg = head[0] === 0xff && head[1] === 0xd8;
  if (!['.png', '.jpg', '.jpeg'].includes(ext) || (!isPng && !isJpg)) {
    fs.unlink(file.path, () => {});
    flash(req, 'err', 'Logo must be a real PNG or JPG image.');
    return res.redirect('/admin/system');
  }
  const old = getSetting('branding.logoFile');
  if (old) fs.unlink(path.join(config.brandingDir, path.basename(old)), () => {});
  setSetting('branding.logoFile', path.basename(file.path));
  audit('admin', res.locals.admin.username, 'branding.logo', '', req.ip);
  flash(req, 'ok', 'Logo updated.');
  res.redirect('/admin/system');
});

systemRouter.post('/system/logo/remove', (req, res) => {
  const old = getSetting('branding.logoFile');
  if (old) fs.unlink(path.join(config.brandingDir, path.basename(old)), () => {});
  setSetting('branding.logoFile', '');
  flash(req, 'ok', 'Logo removed.');
  res.redirect('/admin/system');
});

systemRouter.get('/branding/logo', (req, res) => {
  const logo = getSetting('branding.logoFile');
  if (!logo) return res.status(404).end();
  res.sendFile(path.join(config.brandingDir, path.basename(logo)));
});

// The cached lineup and TV guide as a file, for sharing or for testing
// against. Separate from the backup above for one reason: the backup is the
// WHOLE database — panel URL, Xtream lookup password, wallet addresses, bot
// token, every customer and every message — and must never leave the admin's
// own machine. This is channel names, programme titles and times, which
// identify nobody and open nothing. See src/lineup-export.js for the exact
// columns; that list is the guarantee.
systemRouter.get('/system/lineup.json', (req, res) => {
  const data = exportLineup();
  audit('admin', res.locals.admin.username, 'lineup.export', `${data.channels.length} channels`, req.ip);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="lineup-${stamp}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(data, null, 1));
});

// Consistent snapshot via SQLite's online backup API — never copy a live WAL db.
systemRouter.post('/system/backup', async (req, res, next) => {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const target = path.join(config.dataDir, `backup-${stamp}.db`);
    await db.backup(target);
    audit('admin', res.locals.admin.username, 'backup.download', stamp, req.ip);
    res.download(target, `backup-${stamp}.db`, (err) => {
      fs.unlink(target, () => {});
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
});
