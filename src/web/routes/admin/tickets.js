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

ticketsRouter.post('/tickets/:id/reply', async (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  const body = String(req.body.body || '').trim().slice(0, 3500);
  if (!ticket || !body) return res.redirect(`/admin/tickets/${req.params.id}`);

  db.prepare('INSERT INTO ticket_messages (ticket_id, sender, body, ts) VALUES (?, ?, ?, ?)')
    .run(ticket.id, `admin:${res.locals.admin.username}`, body, now());
  db.prepare("UPDATE tickets SET status = 'pending', updated_at = ? WHERE id = ?").run(now(), ticket.id);
  audit('admin', res.locals.admin.username, 'ticket.reply', `#${ticket.id}`, req.ip);

  // Relay to the customer over Telegram when possible.
  if (ticket.telegram_user_id && hub.online) {
    try {
      await hub.send(ticket.telegram_user_id, `💬 Support reply (ticket #${ticket.id}):\n\n${body}\n\nReply here to continue the conversation.`);
      flash(req, 'ok', 'Reply saved and sent to the customer on Telegram.');
    } catch (err) {
      flash(req, 'err', `Reply saved, but Telegram delivery failed: ${err.message}`);
    }
  } else {
    flash(req, 'ok', 'Reply saved. (No linked Telegram account to deliver it to — they will not see it unless they contact the bot.)');
  }
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
