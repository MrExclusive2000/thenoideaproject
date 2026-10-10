import { Router } from 'express';
import { db, now } from '../../../db/db.js';
import { requireAdmin } from '../../middleware.js';
import { navGroups, sectionFor } from '../../nav.js';
import { dashboardRouter } from './dashboard.js';
import { accountRouter } from './account.js';
import { settingsRouter } from './settings.js';
import { faqsRouter } from './faqs.js';
import { filesRouter } from './files.js';
import { guidesRouter } from './guides.js';
import { customersRouter } from './customers.js';
import { adminsRouter } from './admins.js';
import { broadcastsRouter } from './broadcasts.js';
import { problemsRouter } from './problems.js';
import { requestsRouter } from './requests.js';
import { reportsRouter } from './reports.js';
import { conversationsRouter } from './conversations.js';
import { systemRouter } from './system.js';

export const adminRouter = Router();

adminRouter.use(requireAdmin);

// The numbers beside the menu items. They are the reason the panel is worth
// opening: before this, finding out whether anything needed doing meant
// visiting four pages, so a problem report could sit unread for a day on a
// panel that looked idle. Five indexed COUNTs on small tables, once per page.
function inboxCounts() {
  const t = now();
  return {
    problems: db.prepare('SELECT COUNT(*) n FROM problem_reports WHERE resolved = 0').get().n,
    requests: db.prepare("SELECT COUNT(*) n FROM vod_requests WHERE status = 'open'").get().n,
    unanswered: db.prepare('SELECT COUNT(*) n FROM unanswered WHERE resolved = 0').get().n,
    knowledge: db.prepare("SELECT COUNT(*) n FROM suggested_faqs WHERE status = 'pending'").get().n,
    expiring: db.prepare(
      'SELECT COUNT(*) n FROM customers WHERE active = 1 AND expires_at IS NOT NULL AND expires_at BETWEEN ? AND ?'
    ).get(t, t + 7 * 86400).n,
  };
}

adminRouter.use((req, res, next) => {
  // The logo is served from in here and is fetched once per page render.
  if (req.path === '/branding/logo') return next();
  const counts = inboxCounts();
  res.locals.navCounts = counts;
  res.locals.nav = navGroups(res.locals.path, counts);
  res.locals.section = sectionFor(res.locals.path);
  res.locals.inboxTotal = counts.problems + counts.requests + counts.unanswered;
  next();
});

adminRouter.use(accountRouter);
adminRouter.use(dashboardRouter);
adminRouter.use(settingsRouter);
adminRouter.use(faqsRouter);
adminRouter.use(filesRouter);
adminRouter.use(guidesRouter);
adminRouter.use(customersRouter);
adminRouter.use(adminsRouter);
adminRouter.use(broadcastsRouter);
adminRouter.use(problemsRouter);
adminRouter.use(requestsRouter);
adminRouter.use(reportsRouter);
adminRouter.use(conversationsRouter);
adminRouter.use(systemRouter);
