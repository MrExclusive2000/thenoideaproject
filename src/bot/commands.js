import fs from 'node:fs';
import path from 'node:path';
import { InlineKeyboard, InputFile } from 'grammy';
import { db, now } from '../db/db.js';
import { config } from '../config.js';
import { getSetting, setSetting, redactServiceUrls } from '../settings.js';
import { audit } from '../util.js';
import { sendChunked, isAdminUser, chatAllowed, linkedCustomer, latestFile, withAdminContact } from './helpers.js';
import { sendDigest, buildStatsText } from './reports.js';
import { caseNumberIn, caseSummary, closeCaseAsAdmin, openCasesList, looksLikeCaseClose } from './problems.js';
import { hub } from './hub.js';
import { state } from '../state.js';
import { localBuild, updateCheck, describeUpdate, applyUpdate } from '../build.js';
import { xcConfigured, refreshChannels, channelCount, channelsUpdatedAt, findChannels, xcLastError, epgCacheStats, refreshGuide, programmeCount, guideRefreshedAt, findProgrammes } from '../xc.js';
import { mdToPlain } from '../guides.js';
import { addressLooksValid, acceptedCoins } from '../payments.js';

const isPrivate = (ctx) => ctx.chat?.type === 'private';

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
        '/version — what is running · /update — pull the latest code',
        '/set skyglass 123456 — change a code · /note <text> — service note · /teach Q | A',
        '/channels — the live lineup · /channels refresh — re-pull it',
        'Or just reply "#12 fixed" to an alert.'
      );
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.command('status', cmdStatus);
  // /version means two different things depending on who asks. A customer
  // wants to know which app build to install; the admin wants to know whether
  // the server is running the latest code. Repurposing the command outright
  // would have taken the customer answer away.
  bot.command('version', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return cmdStatus(ctx);
    await ctx.replyWithChatAction?.('typing')?.catch?.(() => {});
    const local = localBuild();
    const remote = await updateCheck();
    const upHours = Math.floor((Date.now() - state.startedAt) / 3600000);
    const lines = [
      `🤖 ${getSetting('branding.appName')}`,
      local.isGit
        ? `Build ${local.commit} · ${local.date}`
        : 'Not installed from git — no build information.',
    ];
    if (local.subject) lines.push(`"${local.subject.slice(0, 120)}"`);
    if (local.branch) lines.push(`Branch: ${local.branch}`);
    lines.push(`Running for ${upHours}h`);
    if (local.dirty) {
      lines.push('', '⚠️ This checkout has local edits. A restart with auto-update on will discard them.');
    }
    lines.push('', describeUpdate(local, remote));
    await ctx.reply(lines.join('\n'));
  });

  // /update — pull the branch this server was installed from. Restarting is a
  // separate, confirmed step: the new code only runs after a restart, and
  // taking the bot down should never be a side effect of asking for an update.
  bot.command('update', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return;
    if (!isPrivate(ctx)) return ctx.reply('Send /update in a private message to me.');
    await ctx.reply('⏳ Pulling the latest code…');
    const r = await applyUpdate();
    if (!r.ok) return ctx.reply(`❌ ${r.message}`);
    if (!r.changed) return ctx.reply(r.message);

    const shown = r.commits.slice(0, 10).map((c) => `• ${c}`).join('\n');
    const more = r.count > 10 ? `\n…and ${r.count - 10} more` : '';
    const depsLine = r.deps === 'reinstalled'
      ? '\n📦 Dependencies changed and were reinstalled.'
      : r.deps === 'FAILED'
        ? '\n⚠️ Dependencies changed but the install FAILED. Do not restart yet — fix it from the panel console first, or the bot will come back up against the wrong packages.'
        : '';
    await ctx.reply(
      `✅ Updated ${r.from} → ${r.to} (${r.count} commit${r.count > 1 ? 's' : ''}):\n${shown}${more}${depsLine}\n\n` +
      'The files are updated but this process is still running the old code. Restart to apply:',
      r.deps === 'FAILED' ? {} : {
        reply_markup: { inline_keyboard: [[{ text: '🔄 Restart now', callback_data: 'update:restart' }]] },
      }
    );
  });

  bot.callbackQuery('update:restart', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Admins only.' });
    await ctx.answerCallbackQuery({ text: 'Restarting…' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    // Pelican treats a clean exit as "you stopped it" and leaves the server
    // off; a non-zero exit is a crash, which its crash detection restarts.
    // That is the only lever a process inside the container has, so say what
    // it depends on rather than promising it will come back.
    await ctx.reply(
      '🔄 Stopping now. The panel should bring me back within a few seconds.\n\n' +
      'If I am still offline after a minute, hit Start in the Pelican panel — this relies on auto-restart-on-crash being enabled for the server.'
    ).catch(() => {});
    setTimeout(() => process.exit(1), 1500);
  });

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

  // ---- managing the bot from Telegram ---------------------------------------
  // Codes change often and the panel is a laptop away. These are deliberately
  // narrow: a safelist of settings, never arbitrary keys, so a typo cannot
  // reconfigure the bot.
  const SETTABLE = {
    skyglass: { key: 'apps.skyGlassCode', label: 'Sky Glass code' },
    purple: { key: 'apps.purpleCode', label: 'Purple App code' },
    download: { key: 'bot.downloadCode', label: '/download code' },
    admin: { key: 'bot.adminContact', label: 'admin contact' },
    ltc: { key: 'payments.ltcAddress', label: 'Litecoin wallet address', coin: 'ltc' },
    btc: { key: 'payments.btcAddress', label: 'Bitcoin wallet address', coin: 'btc' },
  };

  bot.command('set', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return;
    const [nameRaw, ...rest] = String(ctx.match || '').trim().split(/\s+/);
    const name = String(nameRaw || '').toLowerCase().replace(/[^a-z]/g, '');
    const value = rest.join(' ').trim();
    const target = SETTABLE[name];
    if (!target) {
      return ctx.reply(
        `Usage: /set <what> <value>\n\n${Object.entries(SETTABLE)
          .map(([k, v]) => `/set ${k} — ${v.label} (now: ${getSetting(v.key) || 'not set'})`)
          .join('\n')}`
      );
    }
    if (!value) return ctx.reply(`${target.label} is currently: ${getSetting(target.key) || 'not set'}\n\nTo change it: /set ${name} <value>`);
    // A mistyped wallet address sends a customer's money nowhere recoverable,
    // so a value that is not even the right SHAPE is refused outright rather
    // than stored and handed out.
    if (target.coin && !addressLooksValid(target.coin, value)) {
      return ctx.reply(`\u274c That does not look like a ${target.label.replace(' wallet address', '')} address, so I have not saved it. Paste the receive address exactly as your wallet shows it.`);
    }
    const before = getSetting(target.key) || 'not set';
    setSetting(target.key, value.slice(0, 128));
    audit('admin', `tg:${ctx.from.id}`, 'settings.update', `${target.key}: ${before} -> ${value}`);
    if (target.coin) {
      const taking = acceptedCoins().map((c) => c.code).join(' and ');
      return ctx.reply(
        `✅ ${target.label} saved.\n\n${value}\n\nCheck that against your wallet before anyone pays — I hand this out exactly as written and a wrong address cannot be undone. Now taking: ${taking}.`
      );
    }
    await ctx.reply(`✅ ${target.label} changed from ${before} to ${value}.\n\nEvery entry using the placeholder now says ${value} — nothing else to edit.`);
  });

  // A temporary problem belongs in the service note, not in knowledge: the note
  // reaches the AI, /status and the portal, and deleting it clears all three.
  // Written into an entry it just rots there and keeps being told to customers.
  bot.command('note', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return;
    const text = String(ctx.match || '').trim();
    if (!text) {
      const current = getSetting('service.note');
      return ctx.reply(current
        ? `Current service note:\n"${current}"\n\nChange it: /note <text>  ·  Remove it: /note clear`
        : 'No service note set. Add one with: /note Purple is down for Exclusive customers, use Sky Glass');
    }
    if (/^(clear|none|off|remove)$/i.test(text)) {
      setSetting('service.note', '');
      audit('admin', `tg:${ctx.from.id}`, 'service.note', 'cleared');
      return ctx.reply('✅ Service note cleared — customers stop being told about it.');
    }
    setSetting('service.note', text.slice(0, 500));
    audit('admin', `tg:${ctx.from.id}`, 'service.note', text.slice(0, 120));
    await ctx.reply(`✅ Service note set:\n"${text}"\n\nThe AI now mentions this, /status shows it, and problem answers lead with it. Clear it with /note clear when it's fixed.`);
  });

  // Teach the bot something without opening the panel.
  bot.command('teach', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return;
    const arg = String(ctx.match || '').trim();
    const replied = ctx.message?.reply_to_message?.text || '';
    let question = '';
    let answer = '';

    if (arg.includes('|')) {
      [question, answer] = arg.split('|').map((x) => x.trim());
    } else if (replied && arg) {
      // Replying to an answer with "/teach <the question it answers>".
      question = arg;
      answer = replied;
    }
    if (!question || !answer) {
      return ctx.reply(
        'Two ways to teach me:\n' +
        '• /teach How do I install Sky Glass? | Open Downloader, enter {skyglass} and click Go.\n' +
        '• Reply to a message with: /teach <the question it answers>\n\n' +
        'Codes are placeholders: write {skyglass} or {purple} and I fill in the current one.'
      );
    }
    const t = now();
    const info = db.prepare(
      'INSERT INTO faqs (question, answer, keywords, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)'
    ).run(question.slice(0, 300), answer.slice(0, 2500), '', t, t);
    audit('admin', `tg:${ctx.from.id}`, 'faq.add', `#${info.lastInsertRowid} via telegram`);
    await ctx.reply(
      `✅ Learned it (entry #${info.lastInsertRowid}, live now):\n\nQ: ${question}\nA: ${withAdminContact(answer).slice(0, 400)}\n\n` +
      'Add keywords in the panel if you want the fallback to find it too — without them it is only matched by meaning.'
    );
  });

  // Pull the lineup from the service's own panel. Read-only, and the lookup
  // password never leaves settings.
  bot.command('channels', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return;
    const arg = String(ctx.match || '').trim();

    if (/^(refresh|update|sync)$/i.test(arg)) {
      await ctx.reply('⏳ Pulling the channel list…');
      const lines = [];
      for (const service of [1, 2]) {
        if (!xcConfigured(service)) continue;
        const r = await refreshChannels(service);
        lines.push(r.ok
          ? `✅ Service ${service}: ${r.count} channels cached.`
          : `❌ Service ${service}: ${r.error}`);
      }
      return ctx.reply(lines.length ? lines.join('\n') : 'No service has a lookup account set — add one in the panel under Bot settings.');
    }

    if (arg) {
      const hits = findChannels(arg, { service: 1, limit: 10 });
      return ctx.reply(hits.length
        ? `Matching channels:\n${hits.map((h) => `• ${h.name}${h.category ? ` — ${h.category}` : ''}`).join('\n')}`
        : `Nothing in the lineup matches "${arg}". Try /channels refresh if it is new.`);
    }

    const bits = [];
    for (const service of [1, 2]) {
      if (!xcConfigured(service)) continue;
      const n = channelCount(service);
      const at = channelsUpdatedAt(service);
      const age = at ? `${Math.round((Date.now() / 1000 - at) / 3600)}h ago` : 'never';
      const epg = epgCacheStats(service);
      bits.push(
        `Service ${service}: ${n} channels, updated ${age}` +
        (epg.channels ? `\n  guide cached for ${epg.channels} channel(s)` : '')
      );
    }
    if (!bits.length) {
      return ctx.reply(
        'No lookup account set yet. Add the Xtream Codes username and password for your service in the panel (Bot settings → service lookup), then send /channels refresh.' +
        (xcLastError() ? `\n\nLast error: ${xcLastError()}` : '')
      );
    }
    await ctx.reply(`${bits.join('\n')}\n\n/channels refresh — pull the latest\n/channels sky sports — search the lineup`);
  });

  // The whole TV guide: what answers "who's playing Derby tonight", where the
  // channel is the answer rather than part of the question.
  bot.command('guide', async (ctx) => {
    if (!isAdminUser(ctx.from.id)) return;
    const arg = String(ctx.match || '').trim();

    if (/^(refresh|update|sync|pull)$/i.test(arg)) {
      await ctx.reply('\u23f3 Downloading the full guide — this one is big, give it a minute…');
      const lines = [];
      for (const service of [1, 2]) {
        if (!xcConfigured(service)) continue;
        const r = await refreshGuide(service);
        lines.push(r.ok
          ? `\u2705 Service ${service}: ${r.count} programmes kept (of ${r.scanned} in the guide).`
          : `\u274c Service ${service}: ${r.error}`);
      }
      return ctx.reply(lines.length ? lines.join('\n') : 'No service has a lookup account set — add one under Bot settings.');
    }

    if (arg) {
      const hits = findProgrammes(arg, { service: 1, limit: 10 });
      return ctx.reply(hits.length
        ? `In the guide:\n${hits.map((h) => `\u2022 ${h.title} — ${h.channel}`).join('\n')}`
        : `Nothing in the guide matches "${arg}" in that time window. Try /guide refresh, or check the lineup with /channels.`);
    }

    const bits = [];
    for (const service of [1, 2]) {
      if (!xcConfigured(service)) continue;
      const at = guideRefreshedAt(service);
      const age = at ? `${Math.round((Date.now() / 1000 - at) / 3600)}h ago` : 'never';
      bits.push(`Service ${service}: ${programmeCount(service)} programmes, downloaded ${age}`);
    }
    if (!bits.length) return ctx.reply('No lookup account set yet — add the Xtream Codes username and password under Bot settings, then send /guide refresh.');
    await ctx.reply(`${bits.join('\n')}\n\n/guide refresh — download the latest\n/guide derby — search what's on`);
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
