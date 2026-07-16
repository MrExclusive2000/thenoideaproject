import { db } from './db/db.js';
import { config } from './config.js';

// All tunables live in the settings KV table so admins can change them from
// the panel without a restart. Env vars only seed the initial values.
export const DEFAULTS = {
  'branding.appName': 'Support Suite',
  'branding.accentColor': '#6366f1',
  'branding.logoFile': '',

  'bot.enabled': true,
  'bot.instructions':
    'You are the friendly support assistant for our streaming app. Help users install, ' +
    'update and troubleshoot the app on Firestick and mobile devices.',
  'bot.responseMode': 'questions', // mention | questions | all
  'bot.dmEnabled': true,
  'bot.offtopicBehavior': 'silent', // silent | redirect
  'bot.offtopicMessage': 'I can only help with questions about the app. Ask me anything about installing or using it!',
  'bot.fallbackMessage': '', // empty = stay silent when nothing matched and AI is off/down
  'bot.welcomeEnabled': false,
  'bot.welcomeText': 'Welcome {name}! Ask me anything about the app — or type /help to see what I can do.',
  'bot.cooldownSeconds': 15,
  'bot.aiDailyBudget': 500,

  'ai.enabled': true,
  'ai.baseUrl': config.ai.baseUrl,
  'ai.apiKey': config.ai.apiKey,
  'ai.model': config.ai.model,
  'ai.maxTokens': 350,
  'ai.temperature': 0.3,
  'ai.timeoutSeconds': 90,

  'faq.threshold': 0.5,

  'service.status': 'operational', // operational | degraded | maintenance
  'service.note': '',
  'service.announceChanges': false,

  'files.autoAnnounce': false,

  'reports.adminTelegramIds': [],
  'reports.alertErrors': true,
  'reports.alertBudget': true,
  'reports.alertBannedWords': false,
  'reports.alertTickets': true,
  'reports.digest': 'off', // off | daily | weekly
  'reports.digestHour': 9,

  'portal.expiryReminderDays': 3,
  'retention.messagesDays': 30,
};

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

const cache = new Map();

export function getSetting(key) {
  if (cache.has(key)) return cache.get(key);
  const row = getStmt.get(key);
  const value = row ? JSON.parse(row.value) : DEFAULTS[key];
  cache.set(key, value);
  return value;
}

export function setSetting(key, value) {
  setStmt.run(key, JSON.stringify(value));
  cache.set(key, value);
}

export function setSettings(entries) {
  const tx = db.transaction((pairs) => {
    for (const [key, value] of pairs) {
      setStmt.run(key, JSON.stringify(value));
      cache.set(key, value);
    }
  });
  tx(Object.entries(entries));
}
