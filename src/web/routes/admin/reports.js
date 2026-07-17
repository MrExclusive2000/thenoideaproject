import { Router } from 'express';
import { db } from '../../../db/db.js';
import { getSetting, setSettings } from '../../../settings.js';
import { hub } from '../../../bot/hub.js';
import { sendDigest } from '../../../bot/reports.js';
import { audit, formatDate } from '../../../util.js';
import { flash } from '../../middleware.js';

export const reportsRouter = Router();

reportsRouter.get('/reports', (req, res) => {
  const digests = db.prepare('SELECT * FROM digests ORDER BY id DESC LIMIT 10').all();
  res.render('admin/reports', {
    title: 'Reports & status',
    s: {
      serviceStatus: getSetting('service.status'),
      serviceNote: getSetting('service.note'),
      announceChanges: getSetting('service.announceChanges'),
      adminTelegramIds: (getSetting('reports.adminTelegramIds') || []).join(', '),
      alertErrors: getSetting('reports.alertErrors'),
      alertBudget: getSetting('reports.alertBudget'),
      alertBannedWords: getSetting('reports.alertBannedWords'),
      alertTickets: getSetting('reports.alertTickets'),
      alertProblems: getSetting('reports.alertProblems'),
      degradeThreshold: getSetting('problems.degradeThreshold'),
      degradeWindowMinutes: getSetting('problems.degradeWindowMinutes'),
      degradeRecoverMinutes: getSetting('problems.degradeRecoverMinutes'),
      digest: getSetting('reports.digest'),
      digestHour: getSetting('reports.digestHour'),
      expiryReminderDays: getSetting('portal.expiryReminderDays'),
      expiryReminderMessage: getSetting('portal.expiryReminderMessage'),
      expiryUpsellMessage: getSetting('portal.expiryUpsellMessage'),
      suggestFaqs: getSetting('suggest.faqs'),
      retentionDays: getSetting('retention.messagesDays'),
    },
    digests,
    formatDate,
    botOnline: hub.online,
  });
});

reportsRouter.post('/reports/service', async (req, res) => {
  const status = ['operational', 'degraded', 'maintenance'].includes(req.body.status) ? req.body.status : 'operational';
  const note = String(req.body.note || '').trim().slice(0, 300);
  const previous = getSetting('service.status');
  setSettings({
    'service.status': status,
    'service.note': note,
    'service.announceChanges': req.body.announceChanges === '1',
    // An admin-set status is authoritative — stop the auto-degradation
    // recovery sweep from touching it.
    'service.autoDegradedAt': 0,
  });
  audit('admin', res.locals.admin.username, 'service.status', `${status}${note ? ` — ${note}` : ''}`, req.ip);

  if (getSetting('service.announceChanges') && status !== previous && hub.online) {
    const emoji = { operational: '✅', degraded: '⚠️', maintenance: '🛠' }[status];
    hub.sendToAllowedChats(`${emoji} Service status: ${status}${note ? `\n${note}` : ''}`)
      .catch((err) => console.error('status announce failed:', err.message));
  }
  flash(req, 'ok', 'Service status updated.');
  res.redirect('/admin/reports');
});

reportsRouter.post('/reports/settings', (req, res) => {
  const ids = String(req.body.adminTelegramIds || '')
    .split(/[\s,;]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n !== 0);
  setSettings({
    'reports.adminTelegramIds': ids,
    'reports.alertErrors': req.body.alertErrors === '1',
    'reports.alertBudget': req.body.alertBudget === '1',
    'reports.alertBannedWords': req.body.alertBannedWords === '1',
    'reports.alertTickets': req.body.alertTickets === '1',
    'reports.alertProblems': req.body.alertProblems === '1',
    'problems.degradeThreshold': Math.max(0, Math.min(50, Number(req.body.degradeThreshold) || 0)),
    'problems.degradeWindowMinutes': Math.max(5, Math.min(120, Number(req.body.degradeWindowMinutes) || 15)),
    'problems.degradeRecoverMinutes': Math.max(5, Math.min(720, Number(req.body.degradeRecoverMinutes) || 30)),
    'reports.digest': ['off', 'daily', 'weekly'].includes(req.body.digest) ? req.body.digest : 'off',
    'reports.digestHour': Math.max(0, Math.min(23, Number(req.body.digestHour) || 9)),
    'portal.expiryReminderDays': Math.max(1, Math.min(30, Number(req.body.expiryReminderDays) || 3)),
    'portal.expiryReminderMessage': String(req.body.expiryReminderMessage || '').slice(0, 500),
    'portal.expiryUpsellMessage': String(req.body.expiryUpsellMessage || '').slice(0, 500),
    'suggest.faqs': req.body.suggestFaqs === '1',
    'retention.messagesDays': Math.max(1, Math.min(365, Number(req.body.retentionDays) || 30)),
  });
  audit('admin', res.locals.admin.username, 'reports.settings', `${ids.length} admin id(s)`, req.ip);
  flash(req, 'ok', 'Reporting settings saved.');
  res.redirect('/admin/reports');
});

reportsRouter.post('/reports/test-alert', async (req, res) => {
  const ok = await hub.notifyAdmins(`🔔 Test alert from ${getSetting('branding.appName')} — your admin alerts are working.`);
  flash(req, ok ? 'ok' : 'err', ok
    ? 'Test alert sent — check your Telegram.'
    : 'Could not send. Is the bot online, your Telegram ID saved, and have you sent the bot a /start DM first?');
  res.redirect('/admin/reports');
});

reportsRouter.post('/reports/send-digest', async (req, res) => {
  try {
    const digest = await sendDigest('manual');
    flash(req, 'ok', digest.delivered
      ? 'Digest generated and sent to your Telegram.'
      : 'Digest generated (see below) but Telegram delivery failed — is the bot online and your admin ID set?');
  } catch (err) {
    flash(req, 'err', `Digest failed: ${err.message}`);
  }
  res.redirect('/admin/reports');
});
