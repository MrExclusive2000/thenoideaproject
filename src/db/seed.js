import { db, now } from './db.js';

// Starter content for a streaming-app support group. FAQs are generic on
// purpose (no invented links or codes) so they are safe to enable as-is;
// guides ship hidden because they contain placeholders the admin must edit.
export const STARTER_FAQS = [
  {
    question: 'How do I install the app on my Firestick?',
    answer: 'Easiest way is with the Downloader app:\n1. On the Firestick go to Settings > My Fire TV > Developer Options and allow apps from unknown sources (or allow Downloader there).\n2. Install "Downloader" from the Amazon app store.\n3. Open Downloader and enter the download link or code from our portal.\n4. Install the APK when it finishes, open the app and sign in.\nGot a portal login? Message me /download in a private chat and I’ll send the file or a code.',
    keywords: 'install, firestick, fire, stick, downloader, setup, tv, sideload',
  },
  {
    question: 'How do I install the app on an Android phone or tablet?',
    answer: '1. Log in to the download portal and download the latest APK.\n2. Open the file — Android will ask you to allow installs from your browser; allow it.\n3. Install and sign in.\nYou can also message me /download in a private chat to get the file sent straight to you.',
    keywords: 'android, phone, tablet, mobile, apk, samsung, pixel',
  },
  {
    question: 'The app keeps buffering, freezing or stuttering — how do I fix it?',
    answer: 'Try these in order — they fix most buffering:\n1. Restart the app and your device.\n2. Restart your router.\n3. Clear the app cache (Settings > Applications > Manage Installed Applications > the app > Clear cache).\n4. Use 5GHz WiFi or wired ethernet if you can — 2.4GHz struggles with HD streams.\n5. Try a lower quality stream or a different link/server for the same channel.\n6. Run a speed test — HD needs about 10 Mbps, 4K about 25 Mbps.\nStill buffering after all that? Tell us the channel and the time it happened.',
    keywords: 'buffering, buffer, freeze, freezing, stuck, loading, lag, stutter, spinning, slow',
  },
  {
    question: 'How do I request a movie, series or VOD?',
    answer: 'Send the exact title and year (for series: which season), e.g. "Request: Inception (2010)". Post it in the group or open a ticket with me in a private chat (/ticket). Requests are added in batches — give it a little time and check the VOD section again.',
    keywords: 'vod, request, movie, movies, film, series, show, season, episode, add, missing',
  },
  {
    question: "A channel or stream isn't working — what do I do?",
    answer: "First try a different link/server for the same channel if the app offers one, and give it a minute — streams sometimes restart on their own. Still down? Report it with: the exact channel name, what you see (frozen / black screen / error message), and the time. That helps us fix it fast.",
    keywords: 'channel, stream, not working, down, offline, black, screen, error, playback, broken',
  },
  {
    question: 'How do I update the app to the latest version?',
    answer: 'Download the newest APK from the portal and install it straight over the old one — your settings are kept. On a Firestick, enter the download code or link in the Downloader app again. You can also message me /version to see the latest version and /download to get it.',
    keywords: 'update, upgrade, latest, version, new, old',
  },
  {
    question: 'How do I check or renew my subscription?',
    answer: 'Message me /myaccount in a private chat to see your status and expiry date (link your account once with /link plus the code from the portal’s Account page). To renew, contact the admin — in the group or via /ticket.',
    keywords: 'renew, renewal, expire, expiry, expired, subscription, sub, payment, pay, account',
  },
  {
    question: "The app says my login is wrong or my account doesn't work",
    answer: 'Double-check the username and password — watch for extra spaces and capital letters. If it still fails your access may have expired: message me /myaccount in a private chat, or contact the admin via /ticket and we’ll sort it.',
    keywords: 'login, log, password, credentials, invalid, wrong, cant, sign, denied, auth',
  },
  {
    question: 'Can I use a VPN with the app?',
    answer: "Yes. If your internet provider blocks or throttles streams, a VPN often fixes buffering and 'stream not available' errors — connect to a nearby server and restart the app. If a stream only fails WITH the VPN on, switch VPN servers or turn it off for that stream.",
    keywords: 'vpn, blocked, isp, provider, throttling, nord, express',
  },
];

const STARTER_GUIDES = [
  {
    title: 'Install on Firestick (step by step)',
    slug: 'install-firestick',
    body_md: `> **Admin: edit this guide first!** Replace the placeholder below with your real download code or address, then set the guide to *visible*.

## 1. Allow apps from unknown sources

1. From the Firestick home screen go to **Settings** → **My Fire TV** → **Developer Options**.
2. Choose **Install unknown apps** (or *Apps from Unknown Sources*) and allow it for **Downloader** (after step 2 below).

*No Developer Options? Go to Settings → My Fire TV → About, and click the device name 7 times.*

## 2. Install Downloader

Search for **Downloader** (orange icon) in the Amazon app store and install it.

## 3. Get the app

1. Open Downloader.
2. Enter: \`YOUR-PORTAL-ADDRESS/d/YOUR-CODE\`
3. Wait for the download, then press **Install**.
4. Open the app and sign in with the details you were given.

## Problems?

Ask in the group or message the bot — it answers install questions instantly.`,
  },
  {
    title: 'Install on Android phone / tablet',
    slug: 'install-android',
    body_md: `> **Admin: edit this guide first!** Replace the placeholder below with your real portal address, then set the guide to *visible*.

## 1. Download the APK

Open \`YOUR-PORTAL-ADDRESS\` in your phone browser, log in, and download the latest version.

## 2. Allow the install

When you open the downloaded file, Android asks you to allow installs from your browser — allow it (Settings → Install unknown apps).

## 3. Install and sign in

Install the APK, open the app, and sign in with the details you were given.

*Tip: you can also link your Telegram on the portal's Account page and get the app sent to you by messaging the bot /download.*`,
  },
];

// Insert starter FAQs that don't already exist (matched by question text).
// Returns how many were added. Safe to call any number of times.
export function addStarterFaqs() {
  const exists = db.prepare('SELECT 1 FROM faqs WHERE question = ? COLLATE NOCASE');
  const insert = db.prepare(
    'INSERT INTO faqs (question, answer, keywords, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)'
  );
  const t = now();
  let added = 0;
  const tx = db.transaction(() => {
    for (const faq of STARTER_FAQS) {
      if (exists.get(faq.question)) continue;
      insert.run(faq.question, faq.answer, faq.keywords, t, t);
      added++;
    }
  });
  tx();
  return added;
}

// First-boot seeding: only when the tables are completely empty, so user
// content is never touched.
export function seedStarterContent() {
  if (db.prepare('SELECT COUNT(*) n FROM faqs').get().n === 0) {
    const added = addStarterFaqs();
    if (added) console.log(`Seeded ${added} starter FAQs (edit them in the panel: FAQ manager).`);
  }
  if (db.prepare('SELECT COUNT(*) n FROM guides').get().n === 0) {
    const insert = db.prepare(
      'INSERT INTO guides (title, slug, body_md, sort, visible, updated_at) VALUES (?, ?, ?, ?, 0, ?)'
    );
    const t = now();
    const tx = db.transaction(() => {
      STARTER_GUIDES.forEach((g, i) => insert.run(g.title, g.slug, g.body_md, i, t));
    });
    tx();
    console.log('Seeded starter install guides (hidden — edit the placeholders in the panel, then make them visible).');
  }
}
