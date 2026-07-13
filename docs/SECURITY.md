# Security notes

## Built in

- **Passwords** hashed with bcrypt (cost 12). Initial admin password must be changed at first login. Customer passwords are always generated, never user-chosen.
- **Login protection**: rate limiting per IP plus per-account lockout (5 failures → 15 minutes) on both admin and customer logins. Login attempts are audited with IPs.
- **Sessions**: signed cookies (`HttpOnly`, `SameSite=Lax`), session ID regenerated at login, secret auto-generated on first boot and stored in `data/session-secret` (never a default in code). Admin and customer sessions are separate scopes.
- **CSRF tokens** on every state-changing request.
- **Optional TOTP 2FA** for admin accounts.
- **Headers**: helmet with a nonce-based CSP, `X-Content-Type-Options: nosniff`, frame-ancestors denied.
- **Uploads**: extension allowlist + magic-byte verification (an ".apk" that isn't really a ZIP is rejected), randomized storage names outside any static route, size caps. Downloads are served only through authenticated routes (or explicit short codes) with `Content-Disposition: attachment`, and every download is logged per customer.
- **Short download codes** use an unambiguous alphabet, expire, have use limits, and are revocable and audited.
- **LLM guardrails**: the model gets no tools; strict system prompt answers only from your knowledge with an OFFTOPIC escape hatch; output is length-capped, stripped, checked against your banned-word list, and suppressed if it quotes the system prompt. A daily AI call budget caps abuse; per-user cooldowns stop prompt-spam.
- **Bot scope**: the bot only ever responds in chats you explicitly `/adopt`ed; admin bot commands are restricted to your configured Telegram IDs.
- **Secrets** come from environment variables (Pelican egg variables), not files in the repo.

## What you should still do

1. **HTTPS.** A Pelican allocation is plain HTTP by default and the panel shows a red warning when used that way. If the panel/portal is internet-facing, put a reverse proxy with TLS in front (Caddy is two lines; Nginx + certbot works too), then set the `TRUST_PROXY=1` and `FORCE_SECURE_COOKIE=1` variables. Without TLS, logins cross the wire unencrypted.
2. **Enable 2FA** on your admin account (Password & 2FA page) the day you go live.
3. **Backups.** Download a database backup (Branding & backup) on a schedule you can live with, and copy `data/uploads` when you add files. Reinstall never touches `data/`, but disks die.
4. **Keep the GitHub PAT minimal** — fine-grained, read-only Contents, this repo only, with an expiry. Rotate it if it leaks; it's only used for install/update.
5. **Bot token hygiene** — anyone with the token can impersonate the bot. If it leaks, `/revoke` in BotFather and update the variable.
6. **Don't run two instances** with the same bot token (the dashboard will show *conflict* if you do).
7. The panel port is reachable by anyone who can reach the node — consider firewalling the allocation to your reverse proxy or trusted IPs if you can.
