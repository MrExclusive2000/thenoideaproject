import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');

for (const dir of [dataDir, path.join(dataDir, 'uploads'), path.join(dataDir, 'branding')]) {
  fs.mkdirSync(dir, { recursive: true });
}

// The session secret is generated once and persisted so restarts don't
// invalidate sessions and a shipped default can never be used to forge them.
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretFile = path.join(dataDir, 'session-secret');
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // fall through to generation
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

// Which build is actually running — shown in the panel so "did my restart
// pick up the update?" is never a guessing game.
function detectBuildId() {
  try {
    return execSync('git log -1 --format=%h·%cd --date=format:%d.%m.%Y', {
      cwd: rootDir, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export const config = {
  rootDir,
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  brandingDir: path.join(dataDir, 'branding'),
  dbFile: path.join(dataDir, 'app.db'),
  // Pelican injects SERVER_PORT; PORT is the generic fallback for other hosts.
  port: Number(process.env.SERVER_PORT || process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  sessionSecret: loadSessionSecret(),
  botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  ai: {
    baseUrl: (process.env.AI_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''),
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || 'llama3.1',
  },
  initialAdmin: {
    username: (process.env.ADMIN_USERNAME || 'admin').trim(),
    password: process.env.ADMIN_PASSWORD || '',
  },
  trustProxy: bool(process.env.TRUST_PROXY),
  forceSecureCookie: bool(process.env.FORCE_SECURE_COOKIE),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 512),
  buildId: detectBuildId(),
};
