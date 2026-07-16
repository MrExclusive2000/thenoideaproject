import { Router } from 'express';
import { db } from '../../../db/db.js';
import { getSetting, setSettings, setSetting } from '../../../settings.js';
import { testAiConnection } from '../../../ai/client.js';
import { audit } from '../../../util.js';
import { flash } from '../../middleware.js';

export const settingsRouter = Router();

// ---- Bot settings ----------------------------------------------------------

settingsRouter.get('/bot', (req, res) => {
  const bannedWords = db.prepare('SELECT * FROM banned_words ORDER BY word').all();
  const allowedChats = db.prepare('SELECT * FROM allowed_chats ORDER BY added_at DESC').all();
  res.render('admin/bot-settings', {
    allowedChats,
    title: 'Bot settings',
    s: {
      enabled: getSetting('bot.enabled'),
      instructions: getSetting('bot.instructions'),
      responseMode: getSetting('bot.responseMode'),
      dmEnabled: getSetting('bot.dmEnabled'),
      offtopicBehavior: getSetting('bot.offtopicBehavior'),
      offtopicMessage: getSetting('bot.offtopicMessage'),
      fallbackMessage: getSetting('bot.fallbackMessage'),
      welcomeEnabled: getSetting('bot.welcomeEnabled'),
      welcomeText: getSetting('bot.welcomeText'),
      cooldownSeconds: getSetting('bot.cooldownSeconds'),
      faqThreshold: getSetting('faq.threshold'),
    },
    bannedWords,
  });
});

settingsRouter.post('/bot', (req, res) => {
  const b = req.body;
  setSettings({
    'bot.enabled': b.enabled === '1',
    'bot.instructions': String(b.instructions || '').slice(0, 8000),
    'bot.responseMode': ['mention', 'questions', 'all'].includes(b.responseMode) ? b.responseMode : 'questions',
    'bot.dmEnabled': b.dmEnabled === '1',
    'bot.offtopicBehavior': b.offtopicBehavior === 'redirect' ? 'redirect' : 'silent',
    'bot.offtopicMessage': String(b.offtopicMessage || '').slice(0, 500),
    'bot.fallbackMessage': String(b.fallbackMessage || '').slice(0, 500),
    'bot.welcomeEnabled': b.welcomeEnabled === '1',
    'bot.welcomeText': String(b.welcomeText || '').slice(0, 1000),
    'bot.cooldownSeconds': Math.max(0, Math.min(600, Number(b.cooldownSeconds) || 0)),
    'faq.threshold': Math.max(0.1, Math.min(0.95, Number(b.faqThreshold) || 0.5)),
  });
  audit('admin', res.locals.admin.username, 'settings.bot.update', '', req.ip);
  flash(req, 'ok', 'Bot settings saved. They apply immediately.');
  res.redirect('/admin/bot');
});

settingsRouter.post('/bot/banned-words', (req, res) => {
  const word = String(req.body.word || '').trim().slice(0, 60);
  if (word) {
    db.prepare('INSERT OR IGNORE INTO banned_words (word) VALUES (?)').run(word);
    audit('admin', res.locals.admin.username, 'bannedword.add', word, req.ip);
  }
  res.redirect('/admin/bot');
});

settingsRouter.post('/bot/banned-words/:id/delete', (req, res) => {
  db.prepare('DELETE FROM banned_words WHERE id = ?').run(req.params.id);
  audit('admin', res.locals.admin.username, 'bannedword.delete', String(req.params.id), req.ip);
  res.redirect('/admin/bot');
});

settingsRouter.post('/bot/chats/:id/toggle', (req, res) => {
  db.prepare('UPDATE allowed_chats SET enabled = 1 - enabled WHERE chat_id = ?').run(req.params.id);
  audit('admin', res.locals.admin.username, 'chat.toggle', String(req.params.id), req.ip);
  res.redirect('/admin/bot');
});

settingsRouter.post('/bot/chats/:id/delete', (req, res) => {
  db.prepare('DELETE FROM allowed_chats WHERE chat_id = ?').run(req.params.id);
  audit('admin', res.locals.admin.username, 'chat.remove', String(req.params.id), req.ip);
  res.redirect('/admin/bot');
});

// ---- AI settings -----------------------------------------------------------

settingsRouter.get('/ai', (req, res) => {
  res.render('admin/ai-settings', {
    title: 'AI settings',
    s: {
      enabled: getSetting('ai.enabled'),
      baseUrl: getSetting('ai.baseUrl'),
      apiKey: getSetting('ai.apiKey'),
      model: getSetting('ai.model'),
      maxTokens: getSetting('ai.maxTokens'),
      temperature: getSetting('ai.temperature'),
      timeoutSeconds: getSetting('ai.timeoutSeconds'),
      dailyBudget: getSetting('bot.aiDailyBudget'),
    },
    testResult: req.session.aiTestResult || null,
  });
  delete req.session.aiTestResult;
});

settingsRouter.post('/ai', (req, res) => {
  const b = req.body;
  setSettings({
    'ai.enabled': b.enabled === '1',
    'ai.baseUrl': String(b.baseUrl || '').trim().replace(/\/+$/, '').slice(0, 300),
    'ai.apiKey': String(b.apiKey || '').trim().slice(0, 300),
    'ai.model': String(b.model || '').trim().slice(0, 120),
    'ai.maxTokens': Math.max(50, Math.min(4000, Number(b.maxTokens) || 350)),
    'ai.temperature': Math.max(0, Math.min(2, Number(b.temperature) ?? 0.3)),
    'ai.timeoutSeconds': Math.max(10, Math.min(600, Number(b.timeoutSeconds) || 90)),
    'bot.aiDailyBudget': Math.max(0, Math.min(100000, Number(b.dailyBudget) || 0)),
  });
  audit('admin', res.locals.admin.username, 'settings.ai.update', '', req.ip);
  flash(req, 'ok', 'AI settings saved.');
  res.redirect('/admin/ai');
});

settingsRouter.post('/ai/test', async (req, res) => {
  try {
    const result = await testAiConnection();
    req.session.aiTestResult = { ok: true, detail: `Connected — replied in ${result.ms}ms: "${result.sample}"` };
  } catch (err) {
    req.session.aiTestResult = { ok: false, detail: err.message };
  }
  res.redirect('/admin/ai');
});
