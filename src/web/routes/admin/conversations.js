import { Router } from 'express';
import { audit, formatDate } from '../../../util.js';
import {
  conversationMessages, conversationThreads, unansweredThreads, conversationStats, toJsonl,
} from '../../../conversations.js';

export const conversationsRouter = Router();

const sinceFrom = (query) => {
  const days = Number(query.days);
  if (!Number.isFinite(days) || days <= 0) return 0; // 0 = everything on record
  return Math.floor(Date.now() / 1000) - days * 86400;
};

const chatFrom = (query) => {
  const id = Number(query.chat);
  return Number.isFinite(id) && id !== 0 ? id : null;
};

conversationsRouter.get('/conversations', (req, res) => {
  const since = sinceFrom(req.query);
  const chatId = chatFrom(req.query);
  const show = ['threads', 'unanswered', 'all'].includes(req.query.show) ? req.query.show : 'threads';

  const stats = conversationStats(since);
  const threads = show === 'threads' ? conversationThreads({ chatId, since }).slice(-300).reverse() : [];
  const unanswered = show === 'unanswered' ? unansweredThreads({ chatId, since }).slice(-300).reverse() : [];
  const messages = show === 'all' ? conversationMessages({ chatId, since, limit: 300 }).reverse() : [];

  res.render('admin/conversations', {
    title: 'Conversations',
    stats, threads, unanswered, messages, show,
    days: req.query.days || '', chat: req.query.chat || '',
    formatDate,
  });
});

// The corpus itself. JSONL rather than CSV: answers are a nested list, and a
// spreadsheet would flatten exactly the structure that makes this useful.
conversationsRouter.get('/conversations/export.jsonl', (req, res) => {
  const since = sinceFrom(req.query);
  const chatId = chatFrom(req.query);
  const raw = req.query.raw === '1';
  const rows = raw
    ? conversationMessages({ chatId, since, limit: 100000 })
    : conversationThreads({ chatId, since, limit: 100000 });

  audit('admin', res.locals.admin.username, 'conversations.export', `${raw ? 'raw' : 'threads'} n=${rows.length}`, req.ip);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="conversations-${raw ? 'raw' : 'threads'}-${new Date().toISOString().slice(0, 10)}.jsonl"`
  );
  res.send(toJsonl(rows));
});
