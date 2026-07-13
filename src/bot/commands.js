import fs from 'node:fs';
import path from 'node:path';
import { InlineKeyboard, InputFile } from 'grammy';
import { db, now } from '../db/db.js';
import { config } from '../config.js';
import { getSetting } from '../settings.js';
import { audit, randomCode } from '../util.js';
import { sendChunked, isAdminUser, chatAllowed, linkedCustomer, customerUsable, latestFile } from './helpers.js';
import { alertAdmins, sendDigest, buildStatsText } from './reports.js';
import { hub } from './hub.js';

const isPrivate = (ctx) => ctx.chat?.type === 'private';

// Very small markdown → plain text for sending guides in chat.
function mdToPlain(md) {
  return String(md)
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ''))
    .replace(/^#{1,6}\s+(.+)$/gm, (m, h) => `\n${h.toUpperCase()}\n`)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1: $2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/[*_`]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function portalUrl() {
  return config.publicUrl ? `${config.publicUrl}/login` : null;
}

function statusText() {
  const status = getSetting('service.status');
  const note = getSetting('service.note');
  const emoji = { operational: '✅', degraded: '⚠️', maintenance: '🛠' }[status] || '';
  const file = latestFile();
  const lines = [`${emoji} Service status: ${status}${note ? ` — ${note}` : ''}`];
  if (file) lines.push(`Latest version: ${file.display_name}${file.version ? ` v${file.version}` : ''}`);
  const url = portalUrl();
  if (url) lines.push(`Downloads & guides: ${url}`);
  return lines.join('\n');
}

function startMenu() {
  return new InlineKeyboard()
    .text('📦 Latest download', 'menu:download').text('📖 Guides', 'menu:guides').row()
    .text('👤 My account', 'menu:account').text('📡 Status', 'menu:status').row()
    .text('🎫 Open a ticket', 'menu:ticket');
}

async function cmdStatus(ctx) {
  await ctx.reply(statusText());
}

async function cmdAccount(ctx) {
  const customer = linkedCustomer(ctx.from.id);
  if (!customer) {
    return ctx.reply('Your Telegram is not linked to a customer account yet. Get a link code from the portal (Account page) or from the admin, then send: /link YOURCODE');
  }
  const lines = [`👤 Account: ${customer.display_name || customer.username}`];
  if (!customer.active) lines.push('Status: ❌ disabled — contact support.');
  else if (customer.expires_at && customer.expires_at < now()) lines.push('Status: ⏰ expired — contact us to renew.');
  else lines.push('Status: ✅ active');
  if (customer.expires_at) {
    const daysLeft = Math.ceil((customer.expires_at - now()) / 86400);
    lines.push(`Access until: ${new Date(customer.expires_at * 1000).toISOString().slice(0, 10)}${daysLeft > 0 ? ` (${daysLeft} days left)` : ''}`);
  } else {
    lines.push('Access: never expires');
  }
  const url = portalUrl();
  if (url) lines.push(`Portal: ${url}`);
  await ctx.reply(lines.join('\n'));
}

async function cmdDownload(ctx) {
  const customer = linkedCustomer(ctx.from.id);
  const usable = customerUsable(customer);
  if (!usable.ok) {
    const why = {
      'not-linked': 'Link your account first: get a code from the portal or admin, then send /link YOURCODE',
      disabled: 'Your account is disabled — contact support.',
      expired: 'Your access has expired — contact us to renew, then try again.',
    }[usable.why];
    return ctx.reply(why);
  }
  const file = latestFile();
  if (!file) return ctx.reply('No downloads are published yet.');

  const filePath = path.join(config.uploadsDir, path.basename(file.stored_name));
  const caption = `${file.display_name}${file.version ? ` v${file.version}` : ''}${file.description ? `\n${file.description.slice(0, 500)}` : ''}`;

  // Telegram caps bot uploads at 50 MB — send the file directly when we can.
  if (file.size <= 48 * 1024 * 1024 && fs.existsSync(filePath)) {
    await ctx.reply('Sending your file…');
    const ext = path.extname(file.original_name) || '.bin';
    const filename = `${file.display_name.replace(/[^a-zA-Z0-9._ -]/g, '').replace(/\s+/g, '-') || 'app'}${ext}`;
    await ctx.api.sendDocument(ctx.chat.id, new InputFile(filePath, filename), { caption });
    db.prepare('INSERT INTO downloads (file_id, customer_id, via, ts) VALUES (?, ?, ?, ?)')
      .run(file.id, customer.id, 'telegram', now());
    return;
  }

  // Too big for Telegram — mint a personal 48h code instead (easy to type
  // into the Downloader app on a Firestick).
  const code = randomCode(6);
  db.prepare('INSERT INTO download_codes (code, file_id, customer_id, max_uses, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(code, file.id, customer.id, 3, now() + 48 * 3600, 'bot', now());
  const base = config.publicUrl || 'http://YOUR-SERVER';
  await ctx.reply(`${caption}\n\nOn your Firestick, open the Downloader app and enter:\n${base}/d/${code}\n\n(Code valid 48h, up to 3 uses.)`);
}

async function cmdGuides(ctx) {
  const guides = db.prepare('SELECT id, title FROM guides WHERE visible = 1 ORDER BY sort, id LIMIT 20').all();
  if (!guides.length) return ctx.reply('No guides published yet.');
  const kb = new InlineKeyboard();
  guides.forEach((g, i) => {
    kb.text(g.title.slice(0, 40), `guide:${g.id}`);
    if (i % 1 === 0) kb.row();
  });
  await ctx.reply('📖 Pick a guide:', { reply_markup: kb });
}

async function cmdFaq(ctx) {
  const faqs = db.prepare('SELECT question FROM faqs WHERE enabled = 1 ORDER BY priority DESC, hit_count DESC LIMIT 10').all();
  if (!faqs.length) return ctx.reply('No FAQs yet — just ask your question!');
  await ctx.reply('Common questions I can answer straight away:\n\n' + faqs.map((f, i) => `${i + 1}. ${f.question}`).join('\n') + '\n\nJust ask in your own words!');
}

async function cmdTicket(ctx, subjectText) {
  if (!isPrivate(ctx)) return ctx.reply('Tickets are opened in a private chat — message me directly.');
  const existing = db.prepare("SELECT * FROM tickets WHERE telegram_user_id = ? AND status != 'closed'").get(ctx.from.id);
  if (existing) {
    return ctx.reply(`You already have ticket #${existing.id} open — just type your message here and it goes to the team. (/close to close it.)`);
  }
  const customer = linkedCustomer(ctx.from.id);
  const subject = String(subjectText || '').trim().slice(0, 150) || null;
  const t = now();
  const info = db.prepare('INSERT INTO tickets (customer_id, telegram_user_id, tg_username, subject, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(customer?.id ?? null, ctx.from.id, ctx.from.username || ctx.from.first_name || null, subject, 'open', t, t);
  if (subject) {
    db.prepare('INSERT INTO ticket_messages (ticket_id, sender, body, ts) VALUES (?, ?, ?, ?)')
      .run(info.lastInsertRowid, 'customer', subject, t);
  }
  alertAdmins('ticket', `🎫 New ticket #${info.lastInsertRowid} from @${ctx.from?.username || ctx.from?.first_name}${customer ? ` (${customer.username})` : ''}${subject ? `:\n"${subject}"` : ''}`);
  await ctx.reply(
    `🎫 Ticket #${info.lastInsertRowid} opened${subject ? '' : ' — now describe your problem in one or more messages'}. ` +
    'Everything you type here goes straight to the team, and their replies appear here. Send /close when it is sorted.'
  );
}

export function registerCommands(bot) {
  // ---- everyone -------------------------------------------------------------
  bot.command('start', async (ctx) => {
    if (!isPrivate(ctx)) return;
    const appName = getSetting('branding.appName');
    await ctx.reply(
      `👋 Welcome to ${appName} support! Ask me anything about the app — installing, updating, fixing issues.\n\nOr use the menu:`,
      { reply_markup: startMenu() }
    );
  });

  bot.command('help', async (ctx) => {
    const lines = [
      'Ask me any question about the app — I answer instantly.',
      '',
      '/status — service status & latest version',
      '/faq — common questions',
      '/guides — setup guides',
      '/myaccount — your access & expiry (linked)',
      '/download — get the latest file (linked)',
      '/link CODE — connect your customer account',
      '/ticket — talk to a human',
    ];
    if (isAdminUser(ctx.from.id)) {
      lines.push('', 'Admin: /adopt /mute /unmute /report /broadcast <text> /tickets /id');
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.command(['status', 'version'], cmdStatus);
  bot.command('faq', cmdFaq);
  bot.command('guides', cmdGuides);

  // ---- customer (private) ----------------------------------------------------
  bot.command('link', async (ctx) => {
    if (!isPrivate(ctx)) return ctx.reply('Please send /link in a private message to me.');
    const code = String(ctx.match || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) return ctx.reply('Usage: /link YOURCODE — get a code from the portal (Account page) or from the admin.');
    const row = db.prepare('SELECT * FROM link_codes WHERE code = ? AND used = 0 AND expires_at > ?').get(code, now());
    if (!row) return ctx.reply('That code is not valid or has expired. Ask for a fresh one.');
    const clash = db.prepare('SELECT id FROM customers WHERE telegram_user_id = ?').get(ctx.from.id);
    if (clash && clash.id !== row.customer_id) {
      db.prepare('UPDATE customers SET telegram_user_id = NULL WHERE id = ?').run(clash.id);
    }
    db.prepare('UPDATE customers SET telegram_user_id = ? WHERE id = ?').run(ctx.from.id, row.customer_id);
    db.prepare('UPDATE link_codes SET used = 1 WHERE code = ?').run(code);
    audit('customer', String(ctx.from.id), 'customer.link.telegram', `code ${code}`);
    await ctx.reply('✅ Linked! You can now use /myaccount, /download and /guides — and I will remind you before your access expires.');
  });

  bot.command(['myaccount', 'expiry'], async (ctx) => {
    if (!isPrivate(ctx)) return;
    await cmdAccount(ctx);
  });

  bot.command('download', async (ctx) => {
    if (!isPrivate(ctx)) return ctx.reply('Message me privately for downloads.');
    await cmdDownload(ctx);
  });

  bot.command('ticket', async (ctx) => cmdTicket(ctx, ctx.match));

  bot.command('close', async (ctx) => {
    if (!isPrivate(ctx)) return;
    const ticket = db.prepare("SELECT * FROM tickets WHERE telegram_user_id = ? AND status != 'closed'").get(ctx.from.id);
    if (!ticket) return ctx.reply('You have no open ticket.');
    db.prepare("UPDATE tickets SET status = 'closed', updated_at = ? WHERE id = ?").run(now(), ticket.id);
    await ctx.reply(`✅ Ticket #${ticket.id} closed. Ask me anything any time!`);
  });

  // ---- admin ------------------------------------------------------------------
  bot.command('adopt', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return;
    if (isPrivate(ctx)) return ctx.reply('Send /adopt inside the group you want me to support.');
    db.prepare('INSERT INTO allowed_chats (chat_id, title, enabled, added_at) VALUES (?, ?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, enabled = 1')
      .run(ctx.chat.id, ctx.chat.title || String(ctx.chat.id), now());
    audit('admin', String(ctx.from.id), 'chat.adopt', ctx.chat.title || String(ctx.chat.id));
    await ctx.reply(`✅ I am now supporting this group (${ctx.chat.title || ctx.chat.id}). Manage me from the admin panel.`);
  });

  bot.command('mute', async (ctx) => {
    if (!isAdminUser(ctx.from.id) || isPrivate(ctx)) return;
    db.prepare('UPDATE allowed_chats SET enabled = 0 WHERE chat_id = ?').run(ctx.chat.id);
    await ctx.reply('🔇 Muted here. Use /unmute to bring me back.');
  });

  bot.command('unmute', async (ctx) => {
    if (!isAdminUser(ctx.from.id) || isPrivate(ctx)) return;
    db.prepare('UPDATE allowed_chats SET enabled = 1 WHERE chat_id = ?').run(ctx.chat.id);
    await ctx.reply('🔊 Back! Ask me anything.');
  });

  bot.command('report', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return;
    await ctx.reply('Generating your report…');
    try {
      await sendDigest('manual');
    } catch (err) {
      await ctx.reply(`Report failed: ${err.message}\n\nRaw stats:\n${buildStatsText(1)}`);
    }
  });

  bot.command('broadcast', async (ctx) => {
    if (!isAdminUser(ctx.from.id) || !isPrivate(ctx)) return;
    const text = String(ctx.match || '').trim();
    if (!text) return ctx.reply('Usage: /broadcast Your announcement text');
    try {
      const results = await hub.sendToAllowedChats(text);
      const ok = results.filter((r) => r.ok).length;
      db.prepare('INSERT INTO broadcasts (body, status, result, sent_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(text, ok ? 'sent' : 'failed', results.map((r) => `${r.chat}:${r.ok ? 'ok' : 'fail'}`).join(', '), now(), `tg:${ctx.from.id}`, now());
      await ctx.reply(`📢 Sent to ${ok}/${results.length} chat(s).`);
    } catch (err) {
      await ctx.reply(`Broadcast failed: ${err.message}`);
    }
  });

  bot.command('tickets', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return;
    const rows = db.prepare(`
      SELECT t.id, t.subject, t.status, c.username FROM tickets t
      LEFT JOIN customers c ON c.id = t.customer_id
      WHERE t.status != 'closed' ORDER BY t.updated_at DESC LIMIT 15
    `).all();
    if (!rows.length) return ctx.reply('No open tickets. 🎉');
    await ctx.reply('Open tickets:\n' + rows.map((r) => `#${r.id} [${r.status}] ${r.username || 'unlinked'} — ${(r.subject || '').slice(0, 60)}`).join('\n'));
  });

  bot.command('id', async (ctx) => {
    await ctx.reply(`Chat ID: ${ctx.chat.id}\nYour user ID: ${ctx.from.id}`);
  });

  // ---- inline menu callbacks -----------------------------------------------------
  bot.callbackQuery(/^menu:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const action = ctx.match[1];
    if (action === 'status') return cmdStatus(ctx);
    if (action === 'account') return cmdAccount(ctx);
    if (action === 'download') return cmdDownload(ctx);
    if (action === 'guides') return cmdGuides(ctx);
    if (action === 'ticket') return cmdTicket(ctx, '');
  });

  bot.callbackQuery(/^guide:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const guide = db.prepare('SELECT * FROM guides WHERE id = ? AND visible = 1').get(ctx.match[1]);
    if (!guide) return;
    await sendChunked(ctx.api, ctx.chat.id, `📖 ${guide.title}\n\n${mdToPlain(guide.body_md)}`);
  });
}
