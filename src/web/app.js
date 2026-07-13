import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { config } from '../config.js';
import { db } from '../db/db.js';
import { SqliteSessionStore } from '../db/session-store.js';
import { locals, csrfProtect } from './middleware.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin/index.js';
import { portalRouter } from './routes/portal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../views'));
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
      // Old Fire TV WebViews choke on some modern headers; keep COEP off.
      crossOriginEmbedderPolicy: false,
      hsts: false,
    })
  );

  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.use(
    session({
      store: new SqliteSessionStore(db),
      secret: config.sessionSecret,
      name: 'ss.sid',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.forceSecureCookie,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    })
  );

  app.use(locals);
  app.use(csrfProtect);
  app.use('/assets', express.static(path.join(__dirname, '../public'), { maxAge: '1h' }));

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use(authRouter);
  app.use('/admin', adminRouter);
  app.use(portalRouter);

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('web error:', err);
    if (res.headersSent) return;
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `File too large (limit ${config.maxUploadMb} MB).`
      : 'Something went wrong. Check the server logs.';
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 500).render('error', { title: 'Error', message });
  });

  return app;
}
