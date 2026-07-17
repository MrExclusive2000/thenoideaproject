import { Router } from 'express';
import { db, now } from '../../../db/db.js';
import { hub } from '../../../bot/hub.js';
import { audit, formatDate } from '../../../util.js';
import { flash } from '../../middleware.js';

export const ticketsRouter = Router();

ticketsRouter.get('/tickets', (req, res) => {
  const show = req.query.show === 'closed' ? 'closed' : 'open';
  const tickets = db.prepare(`
    SELECT t.*, c.username AS customer_name,
      (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count,
      (SELECT body FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_message
    FROM tickets t LEFT JOIN customers c ON c.id = t.customer_id
    WHERE ${show === 'closed' ? "t.status = 'closed'" : "t.status != 'closed'"}
    ORDER BY t.updated_at DESC LIMIT 100
  `).all();
  res.render('admin/tickets', { title: 'Tickets', tickets, show, formatDate });
});

ticketsRouter.get('/tickets/:id', (req, res) => {
  const ticket = db.prepare(`
    SELECT t.*, c.username AS customer_name FROM tickets t
    LEFT JOIN customers c ON c.id = t.customer_id WHERE t.id = ?
  `).get(req.params.id);
  if (!ticket) return res.redirect('/admin/tickets');
  const messages = db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id').all(ticket.id);
  res.render('admin/ticket-view', { title: `Ticket #${ticket.id}`, ticket, messages, formatDate, botOnline: hub.online });
});

// Why a delivery attempt failed, in words the admin can act on.
function deliveryHint(err) {
  return /403|blocked|initiate|chat not found|deactivated/i.test(String(err?.message))
    ? " — Telegram only lets the bot DM people who have messaged it first. The reply is saved and will be DELIVERED AUTOMATICALLY the moment they message the bot (or use Resend later)."
    : '';
}

async function deliverTicketMessage(ticket, messageId, body) {
  try {
    await hub.send(ticket.telegram_user_id, `💬 Support reply (ticket #${ticket.id}):\n\n${body}\n\nReply here to continue the conversation.`);
    db.prepare('UPDATE ticket_messages SET delivered = 1 WHERE id = ?').run(messageId);
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

ticketsRouter.post('/tickets/:id/reply', async (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  const body = String(req.body.body || '').trim().slice(0, 3500);
  if (!ticket || !body) return res.redirect(`/admin/tickets/${req.params.id}`);

  const info = db.prepare('INSERT INTO ticket_messages (ticket_id, sender, body, ts, delivered) VALUES (?, ?, ?, ?, 0)')
    .run(ticket.id, `admin:${res.locals.admin.username}`, body, now());
  db.prepare("UPDATE tickets SET status = 'pending', updated_at = ? WHERE id = ?").run(now(), ticket.id);
  audit('admin', res.locals.admin.username, 'ticket.reply', `#${ticket.id}`, req.ip);

  // Relay to the customer over Telegram — and be HONEST about the outcome:
  // the message stays marked undelivered until Telegram actually accepted it.
  if (!ticket.telegram_user_id) {
    flash(req, 'err', 'Reply saved but NOT delivered — this ticket has no Telegram account attached, so the customer cannot receive it.');
  } else if (!hub.online) {
    flash(req, 'err', 'Reply saved but NOT delivered — the bot is offline. Use Resend when it is back (or it auto-delivers when the customer next messages the bot).');
  } else {
    const result = await deliverTicketMessage(ticket, info.lastInsertRowid, body);
    flash(req, result.ok ? 'ok' : 'err', result.ok
      ? 'Reply delivered to the customer on Telegram. ✓'
      : `Reply saved but NOT delivered: ${result.err.message}${deliveryHint(result.err)}`);
  }
  res.redirect(`/admin/tickets/${ticket.id}`);
});

ticketsRouter.post('/tickets/:id/resend/:msgId', async (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  const msg = db.prepare('SELECT * FROM ticket_messages WHERE id = ? AND ticket_id = ?').get(req.params.msgId, req.params.id);
  if (!ticket || !msg) return res.redirect('/admin/tickets');
  if (!ticket.telegram_user_id || !hub.online) {
    flash(req, 'err', !ticket.telegram_user_id ? 'No Telegram account attached to this ticket.' : 'Bot is offline.');
    return res.redirect(`/admin/tickets/${ticket.id}`);
  }
  const result = await deliverTicketMessage(ticket, msg.id, msg.body);
  flash(req, result.ok ? 'ok' : 'err', result.ok
    ? 'Delivered. ✓'
    : `Still not delivered: ${result.err.message}${deliveryHint(result.err)}`);
  res.redirect(`/admin/tickets/${ticket.id}`);
});

ticketsRouter.post('/tickets/:id/status', async (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.redirect('/admin/tickets');
  const status = ['open', 'pending', 'closed'].includes(req.body.status) ? req.body.status : 'open';
  db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), ticket.id);
  audit('admin', res.locals.admin.username, 'ticket.status', `#${ticket.id} → ${status}`, req.ip);
  if (status === 'closed' && ticket.telegram_user_id && hub.online) {
    hub.send(ticket.telegram_user_id, `✅ Your support ticket #${ticket.id} has been closed. Message me any time if you need more help.`)
      .catch(() => {});
  }
  flash(req, 'ok', `Ticket marked ${status}.`);
  res.redirect(`/admin/tickets/${ticket.id}`);
});
