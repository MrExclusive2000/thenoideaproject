import { Router } from 'express';
import { db } from '../../../db/db.js';
import { getSetting, setSetting, setSettings } from '../../../settings.js';
import { embed, embedStatus } from '../../../ai/embeddings.js';
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
      ignoreAdmins: getSetting('bot.ignoreAdmins'),
      offtopicBehavior: getSetting('bot.offtopicBehavior'),
      offtopicMessage: getSetting('bot.offtopicMessage'),
      offtopicChatMinutes: getSetting('bot.offtopicChatMinutes'),
      smallTalkSteer: getSetting('bot.smallTalkSteer'),
      bestServiceMessage: getSetting('bot.bestServiceMessage'),
      fallbackMessage: getSetting('bot.fallbackMessage'),
      unsureMessage: getSetting('bot.unsureMessage'),
      adminContact: getSetting('bot.adminContact'),
      aiDownMessage: getSetting('bot.aiDownMessage'),
      capabilityMessage: getSetting('bot.capabilityMessage'),
      downloadCode: getSetting('bot.downloadCode'),
      purpleCode: getSetting('apps.purpleCode'),
      skyGlassCode: getSetting('apps.skyGlassCode'),
      busyMessage: getSetting('bot.busyMessage'),
      greetingMessage: getSetting('bot.greetingMessage'),
      aiRephrase: getSetting('bot.aiRephrase'),
      requestAckMessage: getSetting('bot.requestAckMessage'),
      requestServiceQuestion: getSetting('bot.requestServiceQuestion'),
      imdbCheck: getSetting('vod.imdbCheck'),
      requestAddedMessage: getSetting('bot.requestAddedMessage'),
      serviceName1: getSetting('services.name1'),
      serviceUrl1: getSetting('services.url1'),
      serviceName2: getSetting('services.name2'),
      serviceUrl2: getSetting('services.url2'),
      servicePrefix2: getSetting('services.prefix2'),
      xcUser1: getSetting('services.xcUser1'),
      xcUser2: getSetting('services.xcUser2'),
      // Passwords are never sent back to the browser — only whether one is set.
      xcPass1Set: Boolean(String(getSetting('services.xcPass1') || '').trim()),
      xcPass2Set: Boolean(String(getSetting('services.xcPass2') || '').trim()),
      xcRefreshHours: getSetting('services.xcRefreshHours'),
      epgCacheMinutes: getSetting('services.epgCacheMinutes'),
      thanksMessage: getSetting('bot.thanksMessage'),
      photoMessage: getSetting('bot.photoMessage'),
      problemFollowupNote: getSetting('bot.problemFollowupNote'),
      problemMoreFixesNote: getSetting('bot.problemMoreFixesNote'),
      problemFlaggedNote: getSetting('bot.problemFlaggedNote'),
      problemServiceQuestion: getSetting('bot.problemServiceQuestion'),
      problemResolvedNote: getSetting('bot.problemResolvedNote'),
      problemResolvedByAdminMessage: getSetting('bot.problemResolvedByAdminMessage'),
      problemFixRounds: getSetting('bot.problemFixRounds'),
      problemNudgeMinutes: getSetting('bot.problemNudgeMinutes'),
      problemNudgeMessage: getSetting('bot.problemNudgeMessage'),
      problemAutoCloseMinutes: getSetting('bot.problemAutoCloseMinutes'),
      problemAutoCloseMessage: getSetting('bot.problemAutoCloseMessage'),
      problemSoftCloseMessage: getSetting('bot.problemSoftCloseMessage'),
      welcomeEnabled: getSetting('bot.welcomeEnabled'),
      welcomeText: getSetting('bot.welcomeText'),
      vetDays: getSetting('group.vetDays'),
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
    'bot.ignoreAdmins': b.ignoreAdmins === '1',
    'bot.offtopicBehavior': b.offtopicBehavior === 'redirect' ? 'redirect' : 'silent',
    'bot.offtopicMessage': String(b.offtopicMessage || '').slice(0, 500),
    'bot.offtopicChatMinutes': Math.max(0, Math.min(1440, Number(b.offtopicChatMinutes) || 0)),
    'bot.smallTalkSteer': String(b.smallTalkSteer || '').slice(0, 500),
    'bot.bestServiceMessage': String(b.bestServiceMessage || '').slice(0, 500),
    'bot.fallbackMessage': String(b.fallbackMessage || '').slice(0, 500),
    'bot.unsureMessage': String(b.unsureMessage || '').slice(0, 500),
    'bot.adminContact': String(b.adminContact || '').trim().slice(0, 64),
    'bot.aiDownMessage': String(b.aiDownMessage || '').slice(0, 600),
    'bot.capabilityMessage': String(b.capabilityMessage || '').slice(0, 1000),
    'bot.downloadCode': String(b.downloadCode || '').trim().slice(0, 32),
    'apps.purpleCode': String(b.purpleCode || '').trim().slice(0, 32),
    'apps.skyGlassCode': String(b.skyGlassCode || '').trim().slice(0, 32),
    'bot.busyMessage': String(b.busyMessage || '').slice(0, 500),
    'bot.greetingMessage': String(b.greetingMessage || '').slice(0, 500),
    'bot.aiRephrase': b.aiRephrase === '1',
    'bot.requestAckMessage': String(b.requestAckMessage || '').slice(0, 500),
    'bot.requestServiceQuestion': String(b.requestServiceQuestion || '').slice(0, 500),
    'vod.imdbCheck': b.imdbCheck === '1',
    'bot.requestAddedMessage': String(b.requestAddedMessage || '').slice(0, 500),
    'services.name1': String(b.serviceName1 || '').trim().slice(0, 60),
    'services.url1': String(b.serviceUrl1 || '').trim().slice(0, 200),
    'services.name2': String(b.serviceName2 || '').trim().slice(0, 60),
    'services.url2': String(b.serviceUrl2 || '').trim().slice(0, 200),
    'services.prefix2': String(b.servicePrefix2 || 'THM').trim().slice(0, 20),
    'services.xcUser1': String(b.xcUser1 || '').trim().slice(0, 120),
    'services.xcUser2': String(b.xcUser2 || '').trim().slice(0, 120),
    'services.xcRefreshHours': Math.max(0, Math.min(168, Number(b.xcRefreshHours) || 0)),
    // Floor of 1 minute: a 0 here would mean a live API call per question,
    // which is the thing the cache exists to stop.
    'services.epgCacheMinutes': Math.max(1, Math.min(720, Number(b.epgCacheMinutes) || 30)),
    'bot.thanksMessage': String(b.thanksMessage || '').slice(0, 500),
    'bot.photoMessage': String(b.photoMessage || '').slice(0, 500),
    'bot.problemFollowupNote': String(b.problemFollowupNote || '').slice(0, 500),
    'bot.problemMoreFixesNote': String(b.problemMoreFixesNote || '').slice(0, 500),
    'bot.problemFlaggedNote': String(b.problemFlaggedNote || '').slice(0, 500),
    'bot.problemServiceQuestion': String(b.problemServiceQuestion || '').slice(0, 500),
    'bot.problemResolvedNote': String(b.problemResolvedNote || '').slice(0, 500),
    'bot.problemResolvedByAdminMessage': String(b.problemResolvedByAdminMessage || '').slice(0, 500),
    'bot.problemFixRounds': Math.max(1, Math.min(4, Number(b.problemFixRounds) || 2)),
    'bot.problemNudgeMinutes': Math.max(0, Math.min(60, Number(b.problemNudgeMinutes) || 0)),
    'bot.problemNudgeMessage': String(b.problemNudgeMessage || '').slice(0, 500),
    'bot.problemAutoCloseMinutes': Math.max(0, Math.min(1440, Number(b.problemAutoCloseMinutes) || 0)),
    'bot.problemAutoCloseMessage': String(b.problemAutoCloseMessage || '').slice(0, 500),
    'bot.problemSoftCloseMessage': String(b.problemSoftCloseMessage || '').slice(0, 500),
    'bot.welcomeEnabled': b.welcomeEnabled === '1',
    'bot.welcomeText': String(b.welcomeText || '').slice(0, 1000),
    'group.vetDays': Math.max(0, Math.min(30, Number(b.vetDays) || 0)),
    'bot.cooldownSeconds': Math.max(0, Math.min(600, Number(b.cooldownSeconds) || 0)),
    'faq.threshold': Math.max(0.1, Math.min(0.95, Number(b.faqThreshold) || 0.5)),
  });
  // Passwords are write-only: the form never renders them back, so an empty
  // field means "left alone", not "clear it". Saving the page without retyping
  // one must not silently disconnect the channel lookup.
  for (const n of [1, 2]) {
    const typed = String(req.body[`xcPass${n}`] || '').trim();
    if (typed) setSetting(`services.xcPass${n}`, typed.slice(0, 200));
  }

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
      embedEnabled: getSetting('ai.embedEnabled'),
      embedModel: getSetting('ai.embedModel'),
      retrieveCount: getSetting('ai.retrieveCount'),
      cacheEnabled: getSetting('ai.cacheEnabled'),
      cacheThreshold: getSetting('ai.cacheThreshold'),
      maxConcurrent: getSetting('ai.maxConcurrent'),
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
    'ai.embedEnabled': b.embedEnabled === '1',
    'ai.embedModel': String(b.embedModel || '').trim().slice(0, 100),
    'ai.retrieveCount': Math.max(1, Math.min(20, Number(b.retrieveCount) || 6)),
    'ai.cacheEnabled': b.cacheEnabled === '1',
    'ai.cacheThreshold': Math.max(0.5, Math.min(1, Number(b.cacheThreshold) || 0.95)),
    'ai.maxConcurrent': Math.max(1, Math.min(8, Number(b.maxConcurrent) || 1)),
    'bot.aiDailyBudget': Math.max(0, Math.min(100000, Number(b.dailyBudget) || 0)),
  });
  audit('admin', res.locals.admin.username, 'settings.ai.update', '', req.ip);
  flash(req, 'ok', 'AI settings saved.');
  res.redirect('/admin/ai');
});

settingsRouter.post('/ai/test', async (req, res) => {
  try {
    const result = await testAiConnection();
    let detail = `Connected — replied in ${result.ms}ms: "${result.sample}"`;
    // The embedding model is pulled separately and is the most common thing to
    // be missing, so say so here rather than leaving it to fail quietly into
    // the keyword fallback.
    if (getSetting('ai.embedEnabled')) {
      const started = Date.now();
      const vec = await embed('test');
      detail += vec
        ? ` · embeddings OK (${vec.length} dims in ${Date.now() - started}ms)`
        : ` · ⚠️ embeddings NOT working (${embedStatus().lastError || 'no reason given'}) — the bot will fall back to keyword matching`;
    }
    req.session.aiTestResult = { ok: true, detail };
  } catch (err) {
    req.session.aiTestResult = { ok: false, detail: err.message };
  }
  res.redirect('/admin/ai');
});
