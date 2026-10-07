import fs from 'node:fs';
import path from 'node:path';
import { InlineKeyboard, InputFile } from 'grammy';
import { db, now } from '../db/db.js';
import { config } from '../config.js';
import { getSetting, redactServiceUrls } from '../settings.js';
import { audit } from '../util.js';
import { sendChunked, isAdminUser, chatAllowed, linkedCustomer, latestFile, withAdminContact } from './helpers.js';
import { sendDigest, buildStatsText } from './reports.js';
import { caseNumberIn, caseSummary, closeCaseAsAdmin, openCasesList, looksLikeCaseClose } from './problems.js';
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

function statusText() {
  const status = getSetting('service.status');
  const note = getSetting('service.note');
  const emoji = { operational: '✅', degraded: '⚠️', maintenance: '🛠' }[status] || '';
  const file = latestFile();
  const lines = [`${emoji} Service status: ${status}${note ? ` — ${note}` : ''}`];
  if (file) lines.push(`Latest version: ${file.display_name}${file.version ? ` v${file.version}` : ''}`);
  return lines.join('\n');
}

function startMenu() {
  return new InlineKeyboard()
    .text('📦 Latest download', 'menu:download').text('📖 Guides', 'menu:guides').row()
    .text('📡 Status', 'menu:status');
}

async function cmdStatus(ctx) {
  await ctx.reply(statusText());
}

// The account gate here used to be /link, which no longer exists — keeping it
// would have left /download permanently refusing everyone. The bot only takes
// commands in chats an admin adopted (or a DM to a bot only members are given),
// and the same build ships publicly as an aftv.news code anyway, so the gate
// was guarding nothing the code below does not already hand out.
async function cmdDownload(ctx) {
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
    const customer = linkedCustomer(ctx.from.id);
    db.prepare('INSERT INTO downloads (file_id, customer_id, via, ts) VALUES (?, ?, ?, ?)')
      .run(file.id, customer?.id ?? null, 'telegram', now());
    return;
  }

  // Too big for Telegram. The Downloader code the admin publishes doubles as a
  // plain link (aftv.news/CODE), so it covers Firestick and Android with one
  // value and needs no portal.
  const code = String(getSetting('bot.downloadCode') || '').trim().replace(/^.*aftv\.news\//i, '');
  if (!code) {
    return ctx.reply(`${caption}\n\nThis build is too big for me to send here — ${withAdminContact('{admin}')} for the download code.`);
  }
  await ctx.reply(
    `${caption}\n\nThis one's too big for me to send directly, so use the code instead:\n\n` +
    `On a Firestick: open the Downloader app and enter ${code}\n` +
    `On Android or any browser: open https://aftv.news/${code}\n\n` +
    '(On a phone you may need to allow installs from unknown sources.)'
  );
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
      '/download — get the latest app file',
      '/invite — get a one-use invite link for a friend',
      '',
      `Need a human? ${withAdminContact('{admin}')} — I'll hand you over rather than guess.`,
    ];
    if (isAdminUser(ctx.from.id)) {
      lines.push(
        '',
        'Admin: /adopt /mute /unmute /report /broadcast <text> /id',
        '/cases — open cases · /case 12 — read one · /case 12 fixed — close it',
        'Or just reply "#12 fixed" to an alert.'
      );
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.command(['status', 'version'], cmdStatus);
  bot.command('faq', cmdFaq);
  bot.command('guides', cmdGuides);

  // ---- customer (private) ----------------------------------------------------
  bot.command('download', async (ctx) => {
    if (!isPrivate(ctx)) return ctx.reply('Message me privately for downloads.');
    await cmdDownload(ctx);
  });

  // Personal one-use invite link so members can bring a friend — joins through
  // it are attributed to the inviter for the vetting flow.
  bot.command('invite', async (ctx) => {
    let chatId = null;
    let chatTitle = '';
    if (!isPrivate(ctx)) {
      if (!chatAllowed(ctx.chat.id)) return;
      chatId = ctx.chat.id;
      chatTitle = ctx.chat.title || 'the group';
    } else {
      const chat = db.prepare('SELECT chat_id, title FROM allowed_chats WHERE enabled = 1 ORDER BY added_at LIMIT 1').get();
      if (!chat) return ctx.reply('No group connected yet.');
      chatId = chat.chat_id;
      chatTitle = chat.title || 'the group';
    }
    try {
      const link = await ctx.api.createChatInviteLink(chatId, {
        name: `ref:${ctx.from.id}`.slice(0, 32),
        member_limit: 1,
      });
      await ctx.reply(
        `🎟 Here's a personal invite to ${chatTitle} for one friend:\n${link.invite_link}\n\nIt works exactly once. Heads up: they'll need their own login — once they're in, tell them to ${withAdminContact('{admin}')} to get set up.`,
        isPrivate(ctx) ? {} : { reply_parameters: { message_id: ctx.message.message_id } }
      );
    } catch {
      await ctx.reply('I can\'t create invite links yet — an admin needs to make me a group admin with the "invite users via link" permission.');
    }
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

  // /cases — what is still open. /case 12 — read one. /case 12 fixed — close it.
  bot.command('cases', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return;
    await ctx.reply(openCasesList());
  });

  bot.command('case', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return;
    const arg = String(ctx.match || '').trim();
    const id = caseNumberIn(arg) ?? Number(arg.match(/^\d+/)?.[0]);
    if (!id) return ctx.reply('Usage: /case 12 — show case 12. /case 12 fixed — close it. /cases lists the open ones.');
    if (looksLikeCaseClose(arg)) {
      return ctx.reply(await closeCaseAsAdmin(id, `tg:${ctx.from.id}`));
    }
    const r = db.prepare('SELECT * FROM problem_reports WHERE id = ?').get(id);
    if (!r) return ctx.reply(`No case #${id}.`);
    await ctx.reply(`${caseSummary(r)}\n\nClose it with: /case ${id} fixed`);
  });

  bot.command('id', async (ctx) => {
    await ctx.reply(`Chat ID: ${ctx.chat.id}\nYour user ID: ${ctx.from.id}`);
  });

  // ---- inline menu callbacks -----------------------------------------------------
  bot.callbackQuery(/^menu:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const action = ctx.match[1];
    if (action === 'status') return cmdStatus(ctx);
    if (action === 'download') return cmdDownload(ctx);
    if (action === 'guides') return cmdGuides(ctx);
  });

  bot.callbackQuery(/^guide:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const guide = db.prepare('SELECT * FROM guides WHERE id = ? AND visible = 1').get(ctx.match[1]);
    if (!guide) return;
    // Guides can carry a pasted service URL — per-user URLs only ever come
    // from the dedicated flow, so scrub them here.
    await sendChunked(ctx.api, ctx.chat.id, redactServiceUrls(`📖 ${guide.title}\n\n${mdToPlain(guide.body_md)}`));
  });
}
