import { db, now } from './db.js';
import { getSetting, setSetting } from '../settings.js';

// Starter content for the support group. Bump SEED_VERSION whenever the packs
// change: on the next boot, new entries are added and any entry the admin has
// NOT edited is upgraded in place. Edited content is never touched.
const SEED_VERSION = 21;

export const STARTER_FAQS = [
  {
    question: 'What is this service and what do you get?',
    answer: "Live TV channels, sports, and a full VOD library of movies and series on demand — streamed through our apps on Firestick, Android phones/tablets and iPhone/iPad (the Purple App as your main one, XC and Smarters as backups, Smarters Player Lite on iOS). One login works across all your apps, and you can request VOD titles we don't have yet.\nInterested, or want pricing? Ask the admin here in the group, or message me /ticket and the team will get you set up.",
    keywords: 'service, offer, offers, about, channels, movies, series, sports, vod, demand, package, deal, works, price, cost, trial, includes, included',
  },
  {
    // Owns the device-less phrasings ("don't know how to install the apps");
    // the device FAQs below keep only their distinctive vocabulary.
    question: 'How do I install the apps?',
    answer: "Depends on your device:\n📺 Firestick: install the Downloader app from the Amazon store, open it and enter code 9804805, click Go, then install the Purple App (plus XC or Smarters as backups — same login works in all).\n📱 Android phone/tablet: open https://aftv.news/9804805 in your browser (every Downloader code also works as an aftv.news link) and pick the Purple App.\n🍏 iPhone/iPad: install Smarters Player Lite free from the App Store and log in with your username, password and the service URL (ask here if you don't have it).\nThen open the app and log in with your service details. If your device blocks the install, say so and I'll walk you through allowing it.",
    keywords: 'install, installing, installed, app, apps, get, setup, put',
    priority: 1,
  },
  {
    question: 'Which Firestick is best / which one should I buy?',
    answer: "Any Firestick running Fire OS (the Android-based one) works with our apps. Quick guide:\n- Best value: Fire TV Stick 4K — smooth, handles 4K streams, usually the sweet spot on price.\n- Fastest: Fire TV Stick 4K Max — worth it if you want the snappiest menus.\n- Budget: the basic Fire TV Stick or Lite is fine for HD viewing.\n⚠️ AVOID the Fire TV Stick 4K Select or anything running Amazon's new Vega OS — that isn't Android, so our apps CANNOT be installed on it. If the listing mentions Vega OS, skip it.\nAlso avoid very old sticks (2016 and earlier). Whichever you get, setup takes two minutes: ask me how to install and I'll walk you through it.",
    keywords: 'firestick, best, buy, buying, recommend, recommended, model, models, 4k, max, lite, select, vega, vegas, os, upgrade, new',
  },
  {
    question: 'How do I install the app on my Firestick?',
    answer: 'Install the Downloader app from the Amazon app store, open it and enter code 9804805, then click Go. That page has all our apps — install the Purple App as your main one, plus XC or Smarters as backups (the same login works in all of them).\nIf the Firestick blocks the install: Settings > My Fire TV > About > click the device name 7–10 times to unlock Developer Options, then enable both options in there and go back to Downloader.\nOnce installed, open the app and log in with your service details. Full walkthrough is in the Firestick guide.',
    keywords: 'firestick, fire, stick, downloader, tv, code, 9804805, sideload, app, apps',
    priority: 2,
  },
  {
    question: 'How do I install the app on an Android phone or tablet?',
    answer: 'Open https://aftv.news/9804805 in your phone’s browser — every Downloader code also works as a link at aftv.news/CODE. Pick the app you want — we recommend the Purple App — and allow installs from unknown sources if your phone asks (the prompt varies by model). Install it, open it, and log in with your service details.',
    keywords: 'android, phone, tablet, mobile, apk, installer, link, aftv, samsung, pixel, app, apps',
  },
  {
    // Ships DISABLED — replace SMARTERS-SKY-CODE with the real Downloader
    // code for these apps, then enable. Apps can have different codes; the
    // Firestick FAQ's code belongs to the Purple App page.
    question: 'How do I install Smarters or Sky Glass on the Firestick?',
    answer: 'Smarters and Sky Glass use their own Downloader code (different from the Purple App):\n1. Open the Downloader app on your Firestick.\n2. Enter code SMARTERS-SKY-CODE and click Go.\n3. Install the app, open it and log in with your service details.\nIf the install gets blocked, Developer Options need enabling first — ask me how and I\'ll walk you through it.',
    keywords: 'smarters, sky, glass, skyglass, code, install',
    enabled: 0,
  },
  {
    question: 'How do I install the app on an iPhone or iPad (iOS)?',
    answer: 'On iPhone/iPad use Smarters Player Lite — install it free from the App Store:\nhttps://apps.apple.com/gb/app/smarters-player-lite/id1628995509\nOpen it, accept the terms and choose "Login with Xtream Codes API", then enter:\n- Any name you like\n- Your username and password (your normal service login)\n- The service URL (ask here or message the admin if you don\'t have it)\nTap Add User and your channels and VOD will load.',
    keywords: 'ios, iphone, ipad, apple, store, lite, url, install, installing, app, apps',
  },
  {
    question: 'How do I enable Developer Options or allow apps from unknown sources on Firestick?',
    answer: 'If the Firestick blocks the install or asks for "unknown sources":\n1. Press the Home button on the remote.\n2. Go to Settings > My Fire TV > About.\n3. Highlight your device name and press it 7–10 times until it says Developer Options are enabled.\n4. Go back and open Developer Options.\n5. Turn ON both options (Apps from Unknown Sources / ADB debugging).\n6. Go back to the Downloader app and continue installing.\nThen open the app and log in with your service details.',
    keywords: 'developer, options, unknown, sources, enable, allow, permission, blocked, adb, about',
  },
  {
    question: "The install is blocked or says I can't install unknown apps",
    answer: 'That just means the device needs permission first. On Firestick: Settings > My Fire TV > About, press the device name 7–10 times to unlock Developer Options, then enable both options in there and try the install again. On Android: when you open the downloaded file and it asks, tap "Settings" and allow installs from that app/browser, then install.',
    keywords: 'blocked, unknown, install, cant, cannot, unable, permission, sources, allow, developer, options, prohibited, restricted',
  },
  {
    question: 'How can my friend join the service?',
    answer: "Happy to get them set up!\n1. First they need their own login (username + password) — ask the admin here in the group, or message me /ticket and the team will sort out access and pricing.\n2. Bring them into this group: send me /invite and I'll give you a personal one-use invite link for them.\n3. Once they have their login, installing takes two minutes: enter code 9804805 in the Downloader app, install the Purple App (plus XC or Smarters as backup) and sign in — full steps in the Firestick guide.",
    keywords: 'friend, join, joining, signup, sign up, mate, refer, referral, trial, interested, bring, invite, inviting, group',
  },
  {
    question: 'Which app should I use — Purple, XC or Smarters?',
    answer: 'Use the Purple App as your main app. XC and Smarters are backups — install at least one of them too. The same login works in every app, so if one ever plays up, just switch to a backup and carry on. On iPhone/iPad, use Smarters Player Lite from the App Store instead.',
    keywords: 'purple, xc, smarters, app, which, best, backup, main, recommend',
  },
  {
    question: 'The app keeps buffering, freezing or stuttering — how do I fix it?',
    answer: 'Try these in order — they fix most buffering:\n1. Restart the app and your device.\n2. Restart your router.\n3. Clear the app cache (Settings > Applications > Manage Installed Applications > the app > Clear cache).\n4. Use 5GHz WiFi or wired ethernet if you can — 2.4GHz struggles with HD streams.\n5. Switch to a backup app (XC or Smarters) with the same login — one app often runs better than another.\n6. Try a lower quality stream or a different link/server for the same channel.\n7. Run a speed test — HD needs about 10 Mbps, 4K about 25 Mbps.',
    keywords: 'buffering, buffer, freeze, freezing, stuck, loading, lag, stutter, spinning, slow',
  },
  {
    question: "An episode or movie won't play — what do I do?",
    answer: "1. Try another episode or a different movie first — if those play fine, it's just that one title.\n2. Exit the title fully and reopen it, or restart the app.\n3. Try the same title in a backup app (XC or Smarters) with the same login — their players handle some files differently.\n4. Still dead? Reply with the exact title (and season/episode number) and I'll flag it to the team — faulty copies get repaired or replaced.",
    keywords: 'episode, episodes, movie, film, series, vod, play, playing, wont, broken, failed, fails, working, copy, title',
  },
  {
    question: 'The audio is in the wrong language — how do I change it?',
    answer: "While the video is playing, open the player controls (press OK on the remote or tap the screen) and look for the audio/track button — usually a headphones or speech-bubble icon. Pick English (or whichever language you want) from the list. Subtitles are in the same player menu — look for the CC or subtitles icon to turn them on or off. The same login works in XC and Smarters too, and their players sometimes list audio tracks differently.\nIf only one language is listed, that copy only came with one audio track — reply with the exact title and the language you need and I'll flag it to the team to source a better copy.",
    keywords: 'language, languages, audio, track, tracks, dubbed, dub, subtitles, subtitle, subs, captions, cc, turn, spanish, french, german, italian, arabic, hindi, english, foreign, movie, film, episode, copy, only',
  },
  {
    question: 'Where can I watch live sports and events (UFC, boxing, PPV, football)?',
    answer: "Big live events are shown on the sports and PPV channels in Live TV — they usually go live shortly before the event starts, so check around fight or kickoff time. The sports guide in the customer panel shows what's on and where.\nMissed it? Big events usually land in VOD shortly after — check the VOD section, and if it's not there send a request: post \"Request: <event name>\" here or message me /ticket.",
    keywords: 'ufc, boxing, fight, ppv, sports, sport, football, match, event, events, live, tonight, watch, channel, vod',
  },
  {
    question: 'How do I request a movie, series or VOD?',
    answer: 'Send the exact title and year (for series: which season), e.g. "Request: Inception (2010)". Post it in the group or open a ticket with me in a private chat (/ticket). Requests are added in batches — give it a little time and check the VOD section again.\nWondering if something WILL be on VOD (a new film, last night\'s event)? Check the VOD section first — new titles and event replays are added regularly — and if it\'s not there, request it the same way. There are also VOD recommendations in the customer panel.',
    keywords: 'vod, request, movie, movies, film, series, show, season, episode, add, missing, available, replay, replays',
  },
  {
    question: "A channel or stream isn't working — what do I do?",
    answer: 'First try a different link/server for the same channel, or the same channel in a backup app (XC or Smarters) — and give it a minute, streams sometimes restart on their own. When you report a dead channel, the exact channel name, what you see (frozen / black screen / error message) and the time help us fix it fast.',
    keywords: 'channel, stream, not working, down, offline, black, screen, error, playback, broken',
  },
  {
    question: 'The TV guide (EPG) shows nothing, stops loading or is wrong — how do I fix it?',
    answer: "1. In the app's settings find EPG (or TV Guide) and press Refresh / Update EPG data — then give it a couple of minutes, the full guide is big.\n2. Restart the app after the refresh.\n3. Still empty? Try the same channel in a backup app (XC or Smarters) — same login.\n4. If the times look shifted, check the EPG time-offset setting in the app matches your timezone.\nStill wrong after all that? Reply here and I'll flag it to the team.",
    keywords: 'epg, guide, tv, listings, listing, programme, programmes, schedule, empty, nothing, tomorrow, today, data, times, offset',
  },
  {
    question: 'How many devices can I use — can I watch on two TVs at once?',
    answer: "Install the apps on as many devices as you like — Firestick, phone, tablet, iPad — the same login works everywhere. What's limited is how many STREAMS can play at the same time, and that depends on your plan (most are one stream at a time; multi-room is available). Ask the admin if you want to watch on two screens at once.\nOne thing: keep your login inside your own household — shared accounts get flagged and can be blocked.",
    keywords: 'devices, multiple, two, tvs, once, same, time, simultaneous, connections, connection, share, sharing, login, screens, multiroom, rooms',
  },
  {
    question: 'Does it work on a Samsung or LG smart TV?',
    answer: "Easiest and best: plug a Firestick into the TV's HDMI port and use our apps there — that works on ANY TV and is what we recommend (ask me which Firestick to buy).\nSome Samsung and LG smart TVs can also install an IPTV player app from their own app store that takes the same login (username, password and service URL) — ask here if you want a hand setting one up.",
    keywords: 'samsung, lg, smart, television, sony, tcl, hisense, hdmi, telly',
  },
  {
    question: "The app crashes or won't open — what do I do?",
    answer: "1. Force-stop the app and open it again (Settings > Applications > Manage Installed Applications > the app > Force stop).\n2. Clear the app's cache from the same menu.\n3. Restart the device (unplug a Firestick for 30 seconds).\n4. Still crashing? Reinstall the app — ask me how to install if you need the steps. Your login still works after a reinstall.\n5. Meanwhile, use a backup app (XC or Smarters) with the same login so you're not stuck.",
    keywords: 'crash, crashes, crashing, crashed, open, opening, closes, closing, startup, reinstall, force',
  },
  {
    question: 'What internet speed do I need?',
    answer: "HD streams want about 10 Mbps, 4K about 25 Mbps — most home connections are fine. What matters more:\n- Use 5GHz WiFi or wired ethernet if you can; 2.4GHz WiFi is the #1 cause of buffering.\n- Run a speed test ON the streaming device, not your phone.\n- If your speed is fine but streams still stutter, try the buffering fixes — ask me about buffering.",
    keywords: 'speed, mbps, internet, broadband, bandwidth, fast, slow, connection, wired',
  },
  {
    question: 'Can I record shows or use catch-up?',
    answer: "There's no DVR-style recording, but you rarely need it:\n- Series and movies are in the VOD section on demand.\n- Big events usually get replays added to VOD shortly after they finish.\n- Many channels support pause and rewind right in the player.\nMissing something? Request it — post \"Request: <title>\" here or message me /ticket.",
    keywords: 'record, recording, recordings, dvr, catchup, catch, rewind, pause',
  },
  {
    question: 'What payment methods do you take — can I pay by card or PayPal?',
    answer: "We take crypto — Litecoin (LTC). Don't let that put you off if you've never used it: the payment guide walks you through it step by step, and you can buy the LTC with a normal bank card in about 10 minutes (Exodus wallet + MoonPay). Ask the admin if you need to arrange a different option.",
    keywords: 'card, paypal, bank, transfer, methods, method, revolut, cash, debit, credit',
  },
  {
    // Ships DISABLED — set your apps' real default PIN first, then enable.
    question: 'What is the PIN for locked categories (parental controls)?',
    answer: "Some categories are PIN-locked (parental controls). The default PIN in our apps is DEFAULT-PIN — you can change it in the app's settings under Parental Controls. If that PIN doesn't work in your app, ask here and we'll sort it.",
    keywords: 'pin, locked, lock, parental, control, controls, categories, category, restricted',
    enabled: 0,
  },
  {
    question: 'How do I update the app to the latest version?',
    answer: 'On a Firestick: open the Downloader app, enter code 9804805 again and install the newest version straight over the old one — your settings are kept. On Android: open https://aftv.news/9804805 in your browser again. On iPhone/iPad: update Smarters Player Lite through the App Store. You can also message me /version to see the latest version.',
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
    answer: 'If it says "invalid user" or your login is rejected:\n1. Double-check the username and password — watch for extra spaces and capital letters.\n2. Make sure you\'re in the right app — the same login works in Purple, XC and Smarters.\n3. If we\'ve posted about service issues (check /status or the group), it\'s likely on our side — hang tight and try again shortly.\n4. Still no luck? Your access may have expired — message me /myaccount in a private chat, or /ticket and we\'ll sort it.',
    keywords: 'login, log, password, credentials, invalid, wrong, cant, sign, denied, auth, user, username, details, incorrect, unauthorised, rejected',
  },
  {
    // Ships DISABLED — the admin must replace the two service names first,
    // then enable it in the panel.
    question: 'Which service am I on?',
    answer: "Easy way to tell — look at the username you log in with:\n- If it's randomly generated (a mix of letters and numbers), you're on SERVICE-NAME-1.\n- If it starts with THM, you're on SERVICE-NAME-2.\nNot sure? Reply to this message with just your username (never your password!) and I'll tell you.",
    keywords: 'service, services, which, provider, thm, username, generated, subscribed',
    enabled: 0,
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
    visible: 1,
    body_md: `## Install the app

1. Open this link in the browser on your Android device: **https://aftv.news/9804805**
   (every Firestick Downloader code also works as a link — just put it after aftv.news/)
2. Select the app you would like to install — we recommend the **Purple App**.
3. If prompted, allow installation from unknown sources (this varies a little depending on your phone model).
4. Once installed, open the app and log in with your service details.

*Tip: install XC or Smarters as a backup too — the same login works in all our apps.*`,
  },
  {
    title: 'Install on iPhone / iPad (iOS)',
    slug: 'install-ios',
    visible: 0,
    body_md: `> **${EDIT_MARKER}** Replace YOUR-SERVICE-URL below with your real service URL, then set this guide to *visible*.

## Install Smarters Player Lite

1. On your iPhone or iPad, install **Smarters Player Lite** free from the App Store:
   https://apps.apple.com/gb/app/smarters-player-lite/id1628995509
2. Open the app and accept the terms.
3. Choose **Login with Xtream Codes API**.
4. Enter:
   - **Name:** anything you like
   - **Username / Password:** your normal service login
   - **URL:** YOUR-SERVICE-URL
5. Tap **Add User** — your channels and VOD will load.

*Tip: the same login works on Firestick and Android too — see the other install guides.*`,
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

// Earlier default texts, kept so the upgrade can tell "still the default"
// apart from "admin edited this" — only untouched entries are upgraded.
// Values are arrays: one entry per previous version of that answer.
const V3_BUFFERING =
  'Try these in order — they fix most buffering:\n1. Restart the app and your device.\n2. Restart your router.\n3. Clear the app cache (Settings > Applications > Manage Installed Applications > the app > Clear cache).\n4. Use 5GHz WiFi or wired ethernet if you can — 2.4GHz struggles with HD streams.\n5. Switch to a backup app (XC or Smarters) with the same login — one app often runs better than another.\n6. Try a lower quality stream or a different link/server for the same channel.\n7. Run a speed test — HD needs about 10 Mbps, 4K about 25 Mbps.\nStill buffering after all that? Tell us the channel and the time it happened.';
const V3_CHANNEL =
  "First try a different link/server for the same channel, or the same channel in a backup app (XC/Smarters) — and give it a minute, streams sometimes restart on their own. Still down? Report it with: the exact channel name, what you see (frozen / black screen / error message), and the time. That helps us fix it fast.";
const V2_LOGIN =
  'Double-check the username and password — watch for extra spaces and capital letters. If it still fails your access may have expired: message me /myaccount in a private chat, or contact the admin via /ticket and we’ll sort it.';
const V10_INSTALL_ANY =
  "Depends on your device:\n📺 Firestick: install the Downloader app from the Amazon store, open it and enter code 9804805, click Go, then install the Purple App (plus XC or Smarters as backups — same login works in all).\n📱 Android phone/tablet: open our Android installer link (ask here or check the customer panel if you don't have it) and pick the Purple App.\nThen open the app and log in with your service details. If your device blocks the install, say so and I'll walk you through allowing it.";
const V10_ANDROID =
  'Open our Android installer link on your device (ask here or check the customer panel if you don’t have it), pick the app you want — we recommend the Purple App — and allow installs from unknown sources if your phone asks (the prompt varies by model). Install it, open it, and log in with your service details.';
const V10_UPDATE =
  'On a Firestick: open the Downloader app, enter code 9804805 again and install the newest version straight over the old one — your settings are kept. On Android: use the installer link again. You can also message me /version to see the latest version.';
const V11_INSTALL_ANY =
  "Depends on your device:\n📺 Firestick: install the Downloader app from the Amazon store, open it and enter code 9804805, click Go, then install the Purple App (plus XC or Smarters as backups — same login works in all).\n📱 Android phone/tablet: open https://aftv.news/9804805 in your browser (every Downloader code also works as an aftv.news link) and pick the Purple App.\nThen open the app and log in with your service details. If your device blocks the install, say so and I'll walk you through allowing it.";
const V11_UPDATE =
  'On a Firestick: open the Downloader app, enter code 9804805 again and install the newest version straight over the old one — your settings are kept. On Android: open https://aftv.news/9804805 in your browser again. You can also message me /version to see the latest version.';
const V11_WHICH_APP =
  'Use the Purple App as your main app. XC and Smarters are backups — install at least one of them too. The same login works in every app, so if one ever plays up, just switch to a backup and carry on.';
const V20_LANGUAGE =
  "While the video is playing, open the player controls (press OK on the remote or tap the screen) and look for the audio/track button — usually a headphones or speech-bubble icon. Pick English (or whichever language you want) from the list. The same login works in XC and Smarters too, and their players sometimes list audio tracks differently.\nIf only one language is listed, that copy only came with one audio track — reply with the exact title and the language you need and I'll flag it to the team to source a better copy.";
const V19_VOD_REQUEST =
  'Send the exact title and year (for series: which season), e.g. "Request: Inception (2010)". Post it in the group or open a ticket with me in a private chat (/ticket). Requests are added in batches — give it a little time and check the VOD section again. There are also VOD recommendations in the customer panel.';
const V18_FIRESTICK_BUY =
  "Any current Firestick runs our apps. Quick guide:\n- Best value: Fire TV Stick 4K — smooth, handles 4K streams, usually the sweet spot on price.\n- Fastest: Fire TV Stick 4K Max — worth it if you want the snappiest menus.\n- Budget: the basic Fire TV Stick or Lite is fine for HD viewing.\nAvoid very old sticks (2016 and earlier) — they struggle with modern apps. Whichever you get, setup takes two minutes: ask me how to install and I'll walk you through it.";
const V16_WHAT_IS =
  "Live TV channels, movies, series and sports — streamed through our apps on Firestick, Android phones/tablets and iPhone/iPad (the Purple App as your main one, XC and Smarters as backups, Smarters Player Lite on iOS). One login works across all your apps.\nInterested, or want pricing? Ask the admin here in the group, or message me /ticket and the team will get you set up.";
const V13_WHICH_SERVICE =
  "Easy way to tell — look at the username you log in with:\n- If it's randomly generated (a mix of letters and numbers), you're on SERVICE-NAME-1.\n- If it starts with THM, you're on SERVICE-NAME-2.\nStill not sure? Ask here and we'll check for you.";

const V1_ANSWERS = {
  'How do I install the app on my Firestick?': 'Easiest way is with the Downloader app:\n1. On the Firestick go to Settings > My Fire TV > Developer Options and allow apps from unknown sources (or allow Downloader there).\n2. Install "Downloader" from the Amazon app store.\n3. Open Downloader and enter the download link or code from our portal.\n4. Install the APK when it finishes, open the app and sign in.\nGot a portal login? Message me /download in a private chat and I’ll send the file or a code.',
  'How do I install the app on an Android phone or tablet?': '1. Log in to the download portal and download the latest APK.\n2. Open the file — Android will ask you to allow installs from your browser; allow it.\n3. Install and sign in.\nYou can also message me /download in a private chat to get the file sent straight to you.',
  'The app keeps buffering, freezing or stuttering — how do I fix it?': 'Try these in order — they fix most buffering:\n1. Restart the app and your device.\n2. Restart your router.\n3. Clear the app cache (Settings > Applications > Manage Installed Applications > the app > Clear cache).\n4. Use 5GHz WiFi or wired ethernet if you can — 2.4GHz struggles with HD streams.\n5. Try a lower quality stream or a different link/server for the same channel.\n6. Run a speed test — HD needs about 10 Mbps, 4K about 25 Mbps.\nStill buffering after all that? Tell us the channel and the time it happened.',
  'How do I request a movie, series or VOD?': 'Send the exact title and year (for series: which season), e.g. "Request: Inception (2010)". Post it in the group or open a ticket with me in a private chat (/ticket). Requests are added in batches — give it a little time and check the VOD section again.',
  "A channel or stream isn't working — what do I do?": "First try a different link/server for the same channel if the app offers one, and give it a minute — streams sometimes restart on their own. Still down? Report it with: the exact channel name, what you see (frozen / black screen / error message), and the time. That helps us fix it fast.",
  'How do I update the app to the latest version?': 'Download the newest APK from the portal and install it straight over the old one — your settings are kept. On a Firestick, enter the download code or link in the Downloader app again. You can also message me /version to see the latest version and /download to get it.',
  'How do I check or renew my subscription?': 'Message me /myaccount in a private chat to see your status and expiry date (link your account once with /link plus the code from the portal’s Account page). To renew, contact the admin — in the group or via /ticket.',
};

function previousDefaults(question) {
  const out = [];
  if (V1_ANSWERS[question]) out.push(V1_ANSWERS[question]);
  if (question === 'The app keeps buffering, freezing or stuttering — how do I fix it?') out.push(V3_BUFFERING);
  if (question === "A channel or stream isn't working — what do I do?") out.push(V3_CHANNEL);
  if (question === "The app says my login is wrong or my account doesn't work") out.push(V2_LOGIN);
  if (question === 'How do I install the apps?') out.push(V10_INSTALL_ANY, V11_INSTALL_ANY);
  if (question === 'How do I install the app on an Android phone or tablet?') out.push(V10_ANDROID);
  if (question === 'How do I update the app to the latest version?') out.push(V10_UPDATE, V11_UPDATE);
  if (question === 'Which app should I use — Purple, XC or Smarters?') out.push(V11_WHICH_APP);
  if (question === 'Which service am I on?') out.push(V13_WHICH_SERVICE);
  if (question === 'What is this service and what do you get?') out.push(V16_WHAT_IS);
  if (question === 'Which Firestick is best / which one should I buy?') out.push(V18_FIRESTICK_BUY);
  if (question === 'How do I request a movie, series or VOD?') out.push(V19_VOD_REQUEST);
  if (question === 'The audio is in the wrong language — how do I change it?') out.push(V20_LANGUAGE);
  return out;
}

// Insert starter FAQs that don't already exist (matched by question text).
// Returns how many were added. Safe to call any number of times.
export function addStarterFaqs() {
  const exists = db.prepare('SELECT 1 FROM faqs WHERE question = ? COLLATE NOCASE');
  const insert = db.prepare(
    'INSERT INTO faqs (question, answer, keywords, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const t = now();
  let added = 0;
  const tx = db.transaction(() => {
    for (const faq of STARTER_FAQS) {
      if (exists.get(faq.question)) continue;
      insert.run(faq.question, faq.answer, faq.keywords, faq.enabled ?? 1, faq.priority || 0, t, t);
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
        db.prepare('INSERT INTO faqs (question, answer, keywords, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(faq.question, faq.answer, faq.keywords, faq.enabled ?? 1, faq.priority || 0, t, t);
        faqsAdded++;
      } else if (row.answer === faq.answer || previousDefaults(faq.question).includes(row.answer)) {
        // Unchanged from a shipped default (current or previous) — safe to
        // refresh, which also lets keyword-only upgrades through.
        db.prepare('UPDATE faqs SET answer = ?, keywords = ?, priority = ?, updated_at = ? WHERE id = ?')
          .run(faq.answer, faq.keywords, faq.priority || 0, t, row.id);
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
