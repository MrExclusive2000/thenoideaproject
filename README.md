# Telegram Support Suite

A self-hosted support system for a Firestick / mobile app community, built to run as a **Pelican Panel egg**:

- 🤖 **Telegram AI/FAQ bot** — reads your group, answers instantly from your FAQ entries, falls back to your own self-hosted Llama (Ollama or any OpenAI-compatible endpoint), and **only ever talks about your app** (strict topic guardrails). Full conversation harvesting (every group message, threaded into question/answer pairs you can export), feedback buttons, welcome messages, broadcasts, admin alerts and AI-written digests included. Anything the bot can't answer is pointed at your Telegram handle — no ticket system to babysit.
- 🖥 **Admin web panel** — dashboard with setup checklist, bot & AI settings, FAQ manager with a live match tester, unanswered-questions inbox, conversation log with JSONL export, file/download manager, markdown guides editor, customer manager with expiry handling, broadcasts, service status, multi-admin with optional 2FA, audit log, branding, one-click backup.
- 📺 **Customer download portal** — Firestick-first (works in the Downloader app's browser with zero JavaScript), customer logins managed by you, direct APK downloads with SHA-256 shown, setup guides, and short typed codes like `your-address/d/ABC123` so nobody fights a TV remote.

Everything runs as **one Node.js process** with SQLite — no external database, no build step. All persistent data lives in `data/`.

## Quick start

**Pelican Panel (recommended):** import `egg/egg-support-suite.json`, create a server from it, fill in the variables, start. Full walkthrough: [docs/SETUP.md](docs/SETUP.md).

**Docker:** `cp .env.example .env`, edit it, then `docker compose up -d` → panel on port 8080.

**Bare Node 22+:** `npm ci --omit=dev && npm start`.

First boot creates the admin account (credentials from `ADMIN_USERNAME` / `ADMIN_PASSWORD` variables; a password is generated and printed to the console if you leave it empty). You are forced to set a new password at first login.

## Documentation

- [docs/SETUP.md](docs/SETUP.md) — Pelican install, BotFather setup (including disabling Group Privacy), connecting your Llama endpoint, go-live checklist
- [docs/ADMIN-GUIDE.md](docs/ADMIN-GUIDE.md) — every panel feature and bot command explained
- [docs/SECURITY.md](docs/SECURITY.md) — what's built in, what you should still do (HTTPS, 2FA, backups)

## Tests

```
npm test
```
