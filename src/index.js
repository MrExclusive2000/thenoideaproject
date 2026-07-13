import { config } from './config.js';
import { closeDb } from './db/db.js';
import { bootstrapAdmin } from './web/accounts.js';
import { createApp } from './web/app.js';
import { startBot, stopBot } from './bot/bot.js';
import { startSchedulers } from './bot/reports.js';

bootstrapAdmin();

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  // The Pelican egg watches for this exact line to mark the server as started.
  console.log(`Panel listening on http://${config.host}:${config.port}`);
});

startBot();
startSchedulers();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down…`);
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  await stopBot();
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
