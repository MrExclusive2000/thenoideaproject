import { db, now } from './db.js';
import { getSetting, setSetting } from '../settings.js';

// Starter content for the support group. Bump SEED_VERSION whenever the packs
// change: on the next boot, new entries are added and any entry the admin has
// NOT edited is upgraded in place. Edited content is never touched.
const SEED_VERSION = 3;

export const STARTER_FAQS = [
  {
    question: 'How do I install the app on my Firestick?',
    answer: 'Install the Downloader app from the Amazon app store, open it and enter code 9804805, then click Go. That page has all our apps — install the Purple App as your main one, plus XC or Smarters as backups (the same login works in all of them).\nIf the Firestick blocks the install: Settings > My Fire TV > About > click the device name 7–10 times to unlock Developer Options, then enable both options in there and go back to Downloader.\nOnce installed, open the app and log in with your service details. Full walkthrough is in the Firestick guide.',
    keywords: 'install, firestick, fire, stick, downloader, setup, tv, code, 9804805, sideload',
  },
  {
    question: 'How do I install the app on an Android phone or tablet?',
    answer: 'Open our Android installer link on your device (ask here or check the customer panel if you don’t have it), pick the app you want — we recommend the Purple App — and allow installs from unknown sources if your phone asks (the prompt varies by model). Install it, open it, and log in with your service details.',
    keywords: 'android, phone, tablet, mobile, apk, installer, samsung, pixel',
  },
  {
    question: 'How do I enable Developer Options or allow apps from unknown sources on Firestick?',
    answer: 'If the Firestick blocks the install or asks for "unknown sources":\n1. Press the Home button on the remote.\n2. Go to Settings > My Fire TV > About.\n3. Highlight your device name and press it 7–10 times until it says Developer Options are enabled.\n4. Go back and open Developer Options.\n5. Turn ON both options (Apps from Unknown Sources / ADB debugging).\n6. Go back to the Downloader app and continue installing.\nThen open the app and log in with your service details.',
    keywords: 'developer, options, unknown, sources, enable, allow, apps, permission, blocked, install, sideload, adb, about',
  },
  {
    question: "The install is blocked or says I can't install unknown apps",
    answer: 'That just means the device needs permission first. On Firestick: Settings > My Fire TV > About, press the device name 7–10 times to unlock Developer Options, then enable both options in there and try the install again. On Android: when you open the downloaded file and it asks, tap "Settings" and allow installs from that app/browser, then install.',
    keywords: 'blocked, unknown, install, cant, cannot, unable, permission, sources, allow, developer, options, prohibited, restricted',
  },
  {
    question: 'Which app should I use — Purple, XC or Smarters?',
    answer: 'Use the Purple App as your main app. XC and Smarters are backups — install at least one of them too. The same login works in every app, so if one ever plays up, just switch to a backup and carry on.',
    keywords: 'purple, xc, smarters, app, which, best, backup, main, recommend',
  },
  {
    question: 'The app keeps buffering, freezing or stuttering — how do I fix it?',
    answer: 'Try these in order — they fix most buffering:\n1. Restart the app and your device.\n2. Restart your router.\n3. Clear the app cache (Settings > Applications > Manage Installed Applications > the app > Clear cache).\n4. Use 5GHz WiFi or wired ethernet if you can — 2.4GHz struggles with HD streams.\n5. Switch to a backup app (XC or Smarters) with the same login — one app often runs better than another.\n6. Try a lower quality stream or a different link/server for the same channel.\n7. Run a speed test — HD needs about 10 Mbps, 4K about 25 Mbps.\nStill buffering after all that? Tell us the channel and the time it happened.',
    keywords: 'buffering, buffer, freeze, freezing, stuck, loading, lag, stutter, spinning, slow',
  },
  {
    question: 'How do I request a movie, series or VOD?',
    answer: 'Send the exact title and year (for series: which season), e.g. "Request: Inception (2010)". Post it in the group or open a ticket with me in a private chat (/ticket). Requests are added in batches — give it a little time and check the VOD section again. There are also VOD recommendations in the customer panel.',
    keywords: 'vod, request, movie, movies, film, series, show, season, episode, add, missing',
  },
  {
    question: "A channel or stream isn't working — what do I do?",
    answer: "First try a different link/server for the same channel, or the same channel in a backup app (XC/Smarters) — and give it a minute, streams sometimes restart on their own. Still down? Report it with: the exact channel name, what you see (frozen / black screen / error message), and the time. That helps us fix it fast.",
    keywords: 'channel, stream, not working, down, offline, black, screen, error, playback, broken',
  },
  {
    question: 'How do I update the app to the latest version?',
    answer: 'On a Firestick: open the Downloader app, enter code 9804805 again and install the newest version straight over the old one — your settings are kept. On Android: use the installer link again. You can also message me /version to see the latest version.',
    keywords: 'update, upgrade, latest, version, new, old',
  },
  {
    question: 'How do I check or renew my subscription?',
    answer: 'Message me /myaccount in a private chat to see your status and expiry date (link your account once with /link plus the code from the portal’s Account page). To renew, contact the admin — we take crypto (Litecoin): the payment guide walks you through it step by step, and we’ll send you the wallet address and exact amount. Payment info is also in the customer panel.',
    keywords: 'renew, renewal, expire, expiry, expired, subscription, sub, payment, pay, account',
  },
  {
    question: 'How do I pay with crypto?',
    answer: "We take Litecoin (LTC), and any wallet works — Exodus is the easiest if you’re new:\n1. Download Exodus from exodus.com and set it up.\n2. Tap Buy Crypto, pick Litecoin (LTC), and buy the amount we tell you (first time may need quick ID verification with the payment partner).\n3. Tap Send, paste the wallet address we give you (double-check it — LTC only), enter the amount and confirm.\n4. Send us a screenshot of the confirmation and we’ll activate or renew you.\nFull walkthrough with pictures is in the payment guide.",
    keywords: 'pay, payment, crypto, litecoin, ltc, bitcoin, wallet, exodus, moonpay, buy, send',
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
  {
    question: 'Do you offer refunds?',
    answer: "All services are used at your own discretion, and refunds may not be available once a service has been activated. If something isn't working, talk to us first — we're always happy to help fix it. Message me /ticket in a private chat and the team will look after you.",
    keywords: 'refund, refunds, money, back, cancel, guarantee, chargeback',
  },
  {
    question: "What's in the customer panel?",
    answer: 'The customer panel has everything in one place: service maintenance updates, app download links, URLs and setup info, VOD recommendations, the sports guide, your account details, FAQs and payment information. Log in with your account details and everything assigned to you appears automatically. Ask here if you need the panel link.',
    keywords: 'panel, customer, portal, account, links, sports, maintenance, info, url',
  },
];

const EDIT_MARKER = 'Admin: edit this guide first!';

const STARTER_GUIDES = [
  {
    title: 'Install on Firestick (step by step)',
    slug: 'install-firestick',
    visible: 1,
    body_md: `## 1. Set up your Firestick

1. Turn on your Firestick.
2. Brand-new stick? Finish the on-screen setup first.
3. From the home screen, use **Search** (or Alexa) to find **Downloader** and install it.

## 2. Get the apps

1. Open **Downloader** — you'll see a search/address bar.
2. Enter this code: **9804805**
3. Click **Go** — a page opens where you can install all our available apps.
4. We recommend installing more than one app for the best experience:
   - **Purple App** — use this as your main app
   - **XC** or **Smarters** — keep as backups (the same login works in all of them)
5. Open your chosen app and log in with your service details.

## If the install is blocked ("unknown sources")

1. Press the **Home** button on the remote.
2. Go to **Settings** → **My Fire TV** → **About**.
3. Highlight your device name and press it **7–10 times** until Developer Options are enabled.
4. Go back and open **Developer Options**.
5. Enable **both** available options.
6. Return to Downloader and continue the installation.

## Problems?

Ask in the group — the bot answers install questions instantly. For a human, message the bot **/ticket** in a private chat.`,
  },
  {
    title: 'Install on Android phone / tablet',
    slug: 'install-android',
    visible: 0,
    body_md: `> **${EDIT_MARKER}** Replace ANDROID-INSTALLER-LINK below with your real installer link, then set this guide to *visible*.

## Install the app

1. Open this link on your Android device: **ANDROID-INSTALLER-LINK**
2. Select the app you would like to install — we recommend the **Purple App**.
3. If prompted, allow installation from unknown sources (this varies a little depending on your phone model).
4. Once installed, open the app and log in with your service details.

*Tip: install XC or Smarters as a backup too — the same login works in all our apps.*`,
  },
  {
    title: 'The customer panel',
    slug: 'customer-panel',
    visible: 0,
    body_md: `> **${EDIT_MARKER}** Replace YOUR-PANEL-LINK with the real customer panel address, then set this guide to *visible*.

Everything you need in one place: **YOUR-PANEL-LINK**

The panel includes:

- Service maintenance updates
- App download links
- URLs and setup info
- VOD recommendations
- Sports guide
- Your account details
- FAQs
- Payment information

Simply log in with your account details and all services assigned to you appear automatically.`,
  },
  {
    title: 'How to pay with crypto (Litecoin)',
    slug: 'pay-with-crypto',
    visible: 1,
    body_md: `> 🚨 **This is just a guide — you can use ANY wallet.** Exodus is simply an easy one to start with.

## What you need first

- The **Exodus wallet** app (or any crypto wallet), set up on your phone
- Access to your email and device security for verification
- A credit/debit card if you're buying the crypto

## Step 1 — Download and set up Exodus

1. Go to https://www.exodus.com
2. Download the wallet for your device and set it up.

## Step 2 — Buy Litecoin (LTC)

Exodus lets you buy in-app through payment partners like MoonPay.

1. Open Exodus and tap **Buy Crypto**.
2. Select **Litecoin (LTC)**.
3. Choose the amount — **we'll give you the exact amount** — and pick your payment method.
4. Follow the payment partner's steps (first purchase may need a quick ID verification).
5. The LTC lands in your wallet automatically after payment.

## Step 3 — Send it to us

1. Go to the **Wallet** tab and select **Litecoin (LTC)**.
2. Tap **Send**.
3. Enter the wallet address **we give you** — double-check it's exactly right and that it's the LTC address.
4. Enter the amount and press **Send** to confirm.
5. You'll see a confirmation and the transaction appears in your history — **send us a screenshot** and we'll activate or renew your service.

## Important notice

We aim to provide the best support possible and are always happy to help where we can. Please note that all services are used at your own discretion, and refunds may not be available once the service has been activated.`,
  },
];

// v1 pack contents, kept so the upgrade can tell "still the default" apart
// from "admin edited this" — only untouched entries are upgraded.
const V1_ANSWERS = {
  'How do I install the app on my Firestick?': 'Easiest way is with the Downloader app:\n1. On the Firestick go to Settings > My Fire TV > Developer Options and allow apps from unknown sources (or allow Downloader there).\n2. Install "Downloader" from the Amazon app store.\n3. Open Downloader and enter the download link or code from our portal.\n4. Install the APK when it finishes, open the app and sign in.\nGot a portal login? Message me /download in a private chat and I’ll send the file or a code.',
  'How do I install the app on an Android phone or tablet?': '1. Log in to the download portal and download the latest APK.\n2. Open the file — Android will ask you to allow installs from your browser; allow it.\n3. Install and sign in.\nYou can also message me /download in a private chat to get the file sent straight to you.',
  'The app keeps buffering, freezing or stuttering — how do I fix it?': 'Try these in order — they fix most buffering:\n1. Restart the app and your device.\n2. Restart your router.\n3. Clear the app cache (Settings > Applications > Manage Installed Applications > the app > Clear cache).\n4. Use 5GHz WiFi or wired ethernet if you can — 2.4GHz struggles with HD streams.\n5. Try a lower quality stream or a different link/server for the same channel.\n6. Run a speed test — HD needs about 10 Mbps, 4K about 25 Mbps.\nStill buffering after all that? Tell us the channel and the time it happened.',
  'How do I request a movie, series or VOD?': 'Send the exact title and year (for series: which season), e.g. "Request: Inception (2010)". Post it in the group or open a ticket with me in a private chat (/ticket). Requests are added in batches — give it a little time and check the VOD section again.',
  "A channel or stream isn't working — what do I do?": "First try a different link/server for the same channel if the app offers one, and give it a minute — streams sometimes restart on their own. Still down? Report it with: the exact channel name, what you see (frozen / black screen / error message), and the time. That helps us fix it fast.",
  'How do I update the app to the latest version?': 'Download the newest APK from the portal and install it straight over the old one — your settings are kept. On a Firestick, enter the download code or link in the Downloader app again. You can also message me /version to see the latest version and /download to get it.',
  'How do I check or renew my subscription?': 'Message me /myaccount in a private chat to see your status and expiry date (link your account once with /link plus the code from the portal’s Account page). To renew, contact the admin — in the group or via /ticket.',
};

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

// Upgrade pass for an existing install: add missing entries, and refresh
// entries whose content is still the untouched previous default.
function upgradeStarterContent() {
  const t = now();
  let faqsAdded = 0;
  let faqsUpgraded = 0;
  const tx = db.transaction(() => {
    const getFaq = db.prepare('SELECT * FROM faqs WHERE question = ? COLLATE NOCASE');
    for (const faq of STARTER_FAQS) {
      const row = getFaq.get(faq.question);
      if (!row) {
        db.prepare('INSERT INTO faqs (question, answer, keywords, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)')
          .run(faq.question, faq.answer, faq.keywords, t, t);
        faqsAdded++;
      } else if (V1_ANSWERS[faq.question] && row.answer === V1_ANSWERS[faq.question]) {
        db.prepare('UPDATE faqs SET answer = ?, keywords = ?, updated_at = ? WHERE id = ?')
          .run(faq.answer, faq.keywords, t, row.id);
        faqsUpgraded++;
      }
    }

    const getGuide = db.prepare('SELECT * FROM guides WHERE slug = ?');
    STARTER_GUIDES.forEach((g, i) => {
      const row = getGuide.get(g.slug);
      if (!row) {
        db.prepare('INSERT INTO guides (title, slug, body_md, sort, visible, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(g.title, g.slug, g.body_md, i, g.visible, t);
      } else if (row.body_md.includes(EDIT_MARKER)) {
        // Still the unedited placeholder version — replace with the new one.
        db.prepare('UPDATE guides SET title = ?, body_md = ?, visible = ?, updated_at = ? WHERE id = ?')
          .run(g.title, g.body_md, g.visible, t, row.id);
      }
    });
  });
  tx();
  if (faqsAdded || faqsUpgraded) {
    console.log(`Starter content upgraded: ${faqsAdded} FAQs added, ${faqsUpgraded} refreshed.`);
  }
}

// Runs on every boot; does work at most once per SEED_VERSION.
export function seedStarterContent() {
  const seeded = Number(getSetting('seed.version') || 0);
  if (seeded >= SEED_VERSION) return;

  if (db.prepare('SELECT COUNT(*) n FROM faqs').get().n === 0 &&
      db.prepare('SELECT COUNT(*) n FROM guides').get().n === 0) {
    const added = addStarterFaqs();
    const t = now();
    const insert = db.prepare('INSERT INTO guides (title, slug, body_md, sort, visible, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
      STARTER_GUIDES.forEach((g, i) => insert.run(g.title, g.slug, g.body_md, i, g.visible, t));
    });
    tx();
    console.log(`Seeded ${added} starter FAQs and ${STARTER_GUIDES.length} guides (guides with placeholders ship hidden — edit them in the panel, then make them visible).`);
  } else {
    upgradeStarterContent();
  }

  setSetting('seed.version', SEED_VERSION);
}
