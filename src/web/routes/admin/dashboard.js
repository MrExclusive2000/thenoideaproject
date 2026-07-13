import { Router } from 'express';
import { db, now } from '../../../db/db.js';
import { config } from '../../../config.js';
import { state } from '../../../state.js';
import { aiUsageToday } from '../../../ai/client.js';
import { getSetting } from '../../../settings.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', (req, res) => {
  const t = now();
  const dayAgo = t - 86400;
  const weekAgo = t - 7 * 86400;

  const stats = {
    messages24h: db.prepare('SELECT COUNT(*) n FROM messages_log WHERE ts > ?').get(dayAgo).n,
    answered24h: db.prepare("SELECT COUNT(*) n FROM messages_log WHERE ts > ? AND reply_source IN ('faq','ai')").get(dayAgo).n,
    faqCount: db.prepare('SELECT COUNT(*) n FROM faqs WHERE enabled = 1').get().n,
    customers: db.prepare('SELECT COUNT(*) n FROM customers WHERE active = 1').get().n,
    expiringSoon: db.prepare('SELECT COUNT(*) n FROM customers WHERE active = 1 AND expires_at IS NOT NULL AND expires_at BETWEEN ? AND ?').get(t, t + 7 * 86400).n,
    downloads7d: db.prepare('SELECT COUNT(*) n FROM downloads WHERE ts > ?').get(weekAgo).n,
    openTickets: db.prepare("SELECT COUNT(*) n FROM tickets WHERE status != 'closed'").get().n,
    unanswered: db.prepare('SELECT COUNT(*) n FROM unanswered WHERE resolved = 0').get().n,
    ai: aiUsageToday(),
  };

  const recentActivity = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 10').all();
  const topFaqs = db.prepare('SELECT question, hit_count FROM faqs ORDER BY hit_count DESC LIMIT 5').all();
  const allowedChats = db.prepare('SELECT * FROM allowed_chats ORDER BY added_at DESC').all();

  const checklist = {
    botToken: Boolean(config.botToken),
    botOnline: state.bot.status === 'online',
    groupAdded: allowedChats.length > 0,
    privacyHint: state.bot.status === 'online' && allowedChats.length > 0 && state.bot.groupMessagesSeen === 0,
    aiConfigured: Boolean(getSetting('ai.baseUrl') && getSetting('ai.model')),
    hasFaqs: stats.faqCount > 0,
    hasFile: db.prepare('SELECT COUNT(*) n FROM files WHERE visible = 1').get().n > 0,
    adminIds: (getSetting('reports.adminTelegramIds') || []).length > 0,
  };
  const setupDone = checklist.botToken && checklist.botOnline && checklist.groupAdded && !checklist.privacyHint && checklist.hasFaqs;

  res.render('admin/dashboard', {
    title: 'Dashboard',
    stats,
    recentActivity,
    topFaqs,
    allowedChats,
    checklist,
    setupDone,
    bot: state.bot,
    uptimeHours: Math.floor((Date.now() - state.startedAt) / 3600000),
    aiBudget: Number(getSetting('bot.aiDailyBudget')) || 0,
  });
});
