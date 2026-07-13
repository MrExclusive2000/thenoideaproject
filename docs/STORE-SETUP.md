# Store Setup — Self-Hosted Shop as a Pelican Egg

*Spec only — nothing is built in this round. The store is phase-3 work (months 5–7), after marketplaces prove the designs. This doc pins the decisions so the build session can start cold.*

## 1. Role of the own store

The marketplaces do discovery; the own store does **margin and ownership**:

- 67% gross margin vs 55–61% on marketplaces (only Stripe's 1.5% + 20p comes off).
- The QR insert in every shipped package routes buyers here for their *second* mat.
- Email list + customer data are owned assets — the only channel no platform can re-price.
- It runs on the Pelican panel that already exists, so hosting is effectively free.

Traffic to it comes from packaging QRs, link-in-bio, and content — it is **not** expected to out-sell marketplaces in year one.

## 2. Platform choice: WooCommerce (WordPress) in Docker

**Decision: WooCommerce.** Rationale over the alternatives:

| Option | Verdict |
|---|---|
| **WooCommerce** | ✅ Mature, huge plugin ecosystem (Printful has a first-party integration for the residual POD SKUs; BaseLinker syncs it alongside the marketplaces), themeable to the BRAND.md identity, runs fine in a single container + DB, endless documentation |
| Medusa (headless Node) | Modern and egg-friendly, but needs a custom storefront build — more build/maintenance for zero revenue difference at this scale |
| Shopify | Rejected: £25+/mo, and violates the self-hosted constraint |
| Saleor / Vendure | Overkill (enterprise headless) for a single-brand store |

## 3. Egg / container spec

Two-container layout (Pelican supports allocating both under one server, or use the DB egg separately):

**App container**
- Image: `wordpress:php8.3-apache` (official) with WooCommerce installed on first run
- Port allocation: one HTTP port (reverse-proxied; TLS terminates at the proxy — see §4)
- Persistent volume: `/var/www/html` (themes, uploads, plugins)
- Env vars: `WORDPRESS_DB_HOST`, `WORDPRESS_DB_NAME`, `WORDPRESS_DB_USER`, `WORDPRESS_DB_PASSWORD` (from the panel's variable system, never hardcoded)
- Startup: default Apache entrypoint; healthcheck on `/wp-login.php`

**Database**
- `mariadb:11` with its own persistent volume, not exposed publicly (bind to the internal allocation only)

**Egg definition notes (for the future build session)**
- Base it on the community `pelican-eggs` generic/wordpress patterns; variables for DB creds, site URL, admin email
- Backup script: nightly `mysqldump` + tar of `wp-content/uploads` to a second volume/off-box target — the panel's schedule feature can drive this
- Update policy: WordPress auto-minor-updates on; WooCommerce/plugin updates manually, monthly

## 4. Front door & security baseline

- Reverse proxy (Nginx Proxy Manager or Caddy on the node) → TLS via Let's Encrypt; the store container never faces the internet raw.
- Hardening: admin 2FA plugin, login rate-limiting, `wp-config.php` salts, disable file editing (`DISALLOW_FILE_EDIT`), automated core minor updates, least-privilege DB user.
- Payments: **Stripe** (UK cards 1.5% + 20p) via the official WooCommerce Stripe gateway — card data never touches the server (Stripe Elements), which keeps PCI scope at SAQ-A.
- GDPR basics: privacy policy page, cookie banner (only if analytics added — prefer a cookieless analytics tool like Plausible, which can also run as a container on the panel), customer-data export/erase via WooCommerce's built-in GDPR tools.

## 5. Store content at launch (phase 3)

- 2–4 white-label designs + "sold out" archive pages for past drops (scarcity is honest here — batches are genuinely 100 units).
- The wall of desks (customer setups, with permission) as social proof.
- Email capture: 10% off the second mat; drops announced to the list first.
- Product pages reuse the marketplace photography; brand palette and type per `BRAND.md`.
