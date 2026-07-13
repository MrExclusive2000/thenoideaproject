# Deploying the Store on Pelican Panel

*How to run the brand's WooCommerce store as an egg on the existing panel. This uses a maintained upstream egg rather than a hand-rolled one — fewer moving parts to own, and it's already proven on Pelican.*

## The egg (linked, not vendored)

**[Sigma-Production/ptero-eggs](https://github.com/Sigma-Production/ptero-eggs) → `egg-web-host-egg.json`** — an nginx + PHP-FPM webhosting egg with optional WordPress auto-install.

- Import URL (paste into the panel): `https://raw.githubusercontent.com/Sigma-Production/ptero-eggs/main/egg-web-host-egg.json`
- Tested **13 July 2026**: JSON imports clean; images `ghcr.io/sigma-production/nginx-ptero:8.1`–`8.4`; variables include `WORDPRESS` (0/1 auto-install toggle), `STARTUP_CMD`, `COMPOSER_MODULES`, `GIT_ADDRESS`/`BRANCH`/`AUTO_UPDATE` (git-deploy, unused here), `USER_UPLOAD`, `NAMELESSMC`. Webroot lives at `/home/container/webroot`.
- **Why linked rather than copied into this repo:** the egg ships under the *Sigma Public License 1.2*, which permits unmodified copies but prohibits modified/rebranded redistribution. Importing by URL keeps us unambiguously compliant and picks up upstream fixes. If upstream ever moves, grab the JSON from their [releases page](https://github.com/Sigma-Production/ptero-eggs/releases).

## Walkthrough

### 1. Import the egg
Admin area → **Eggs → Import** → paste the URL above (or upload the downloaded JSON).

### 2. Create the server
- Egg: *WebHost Egg*; Docker image: **PHP 8.4** (`nginx-ptero:8.4`).
- Resources: 1–2 GB RAM, 5–10 GB disk is plenty at this scale.
- One network allocation (this is the HTTP port).
- Variables: **`WORDPRESS` = `1`** (auto-installs WordPress on first boot); leave `GIT_ADDRESS`/`COMPOSER_MODULES` empty; `AUTO_UPDATE` off (we update deliberately, monthly — see STORE-SETUP §3).

### 3. Database
Server → **Databases** → create one (the panel provisions MySQL/MariaDB and shows host, name, user, password). No separate DB container needed.

### 4. WordPress first run
Browse to `http://<node-ip>:<port>` → WordPress setup wizard → enter the panel database credentials → create the admin account (unique username, long password — and install a 2FA plugin before anything else).

### 5. WooCommerce + Stripe
1. Plugins → install **WooCommerce**; run its wizard: GB store address, GBP, **UK-only shipping zone** (compliance decision, BUSINESS-PLAN §7.3), flat rate £3.20 / free over £50.
2. Install **WooCommerce Stripe Gateway** → connect Stripe (card data never touches the server; PCI scope stays SAQ-A).
3. Products: the 2–4 white-label designs (DESIGN-DIRECTION.md), plus sold-out archive pages for past drops.
4. Optional: the official **Printful** plugin if any POD SKUs stay on the own store.

### 6. Theme = brand
Install **Storefront** (free, WooCommerce-native), then Appearance → Customize → Additional CSS:

```css
:root {
  --dl-bg: #FAF7F2;      /* light bg      */
  --dl-ink: #1C1B22;     /* text          */
  --dl-indigo: #4A4E8F;  /* links/buttons */
  --dl-ember: #B0431F;   /* CTAs/badges   */
}
body { background: var(--dl-bg); color: var(--dl-ink); }
a { color: var(--dl-indigo); }
.button, .single_add_to_cart_button { background: var(--dl-indigo); }
.onsale { background: var(--dl-ember); }
```

Typography per BRAND §2: **Space Grotesk** (headings/logotype) + **Inter** (body) — both OFL; self-host the font files in the child theme rather than loading Google Fonts (no third-party calls, no cookie-banner complication).

### 7. Domain, proxy, TLS
Point `deskloom.co.uk` (post-clearance) at the node; run **Nginx Proxy Manager or Caddy** on the host → proxy the domain to the allocation port with a Let's Encrypt cert. The container never faces the internet raw (STORE-SETUP §4). Set the WordPress site URL to the https domain after the proxy works.

### 8. Hardening (15 minutes, once)
- 2FA on wp-admin (done in step 4), login rate-limiting plugin.
- `wp-config.php`: fresh salts + `define('DISALLOW_FILE_EDIT', true);`
- WordPress auto-minor-updates on; WooCommerce/plugins updated manually, monthly.
- Delete unused themes/plugins; least-privilege: no other users on the WP instance.

### 9. Backups
- Panel: Server → **Schedules** → daily backup task (retain 7).
- In-app: **UpdraftPlus** (free) nightly DB + `wp-content/uploads` export to off-box storage (e.g. a cloud bucket) — two independent recovery paths.

### 10. Launch checklist (phase 3, months 5–7)
- [ ] Trademark cleared + filed (BRAND §4) — before the domain goes live
- [ ] Products, prices (£29–35), returns policy (14-day), privacy policy pages
- [ ] Email capture with 10%-off-second-mat offer (MARKETING §5)
- [ ] QR insert in every marketplace parcel points here (PLAYBOOK §5)
- [ ] Plausible analytics (cookieless) as a second container if wanted — not Google Analytics
