import { createHash } from 'node:crypto';
import { db, now } from './db.js';
import { getSetting, setSetting } from '../settings.js';

// Starter content for the support group. Bump SEED_VERSION whenever the packs
// change: on the next boot, new entries are added and any entry the admin has
// NOT edited is upgraded in place. Edited content is never touched.
const SEED_VERSION = 33;

export const STARTER_FAQS = [
  {
    question: 'What is this service and what do you get?',
    answer: "Live TV channels, sports, and a full VOD library of movies and series on demand — streamed through our apps on Firestick, Android phones/tablets and iPhone/iPad (Sky Glass is the app we recommend now, with Purple, XC or Smarters as backups, and Smarters Player Lite on iOS). One login works across all your apps, and you can request VOD titles we don't have yet.\nInterested, or want pricing? Ask the admin here in the group, or {admin} and the team will get you set up.",
    keywords: 'service, offer, offers, about, channels, movies, series, sports, vod, demand, package, works, includes, included, get',
  },
  {
    question: 'How much does it cost / what are the prices?',
    answer: "Pricing depends on the package and how long you sign up for — the admin sorts you out directly with the current prices. Ask here in the group or {admin}. Payment is by crypto (Litecoin) and the step-by-step guide makes it easy, even if you've never used crypto before.",
    keywords: 'price, prices, pricing, cost, costs, how much, cheap, expensive, monthly, yearly, deal, deals, trial, free, quote, packages',
  },
  {
    // A person asking about THEMSELVES. The friend entry below owned the
    // words "signup", "sign up" and "interested", so the single most
    // valuable message this bot ever receives — "hi mate, thinking of
    // signing up" — was answered with "Happy to get them set up!" and three
    // steps about somebody who does not exist. Simulated as a brand-new
    // customer's opening line, which is exactly when it happens.
    question: 'How do I sign up?',
    answer: "Good to have you 👋 Three steps:\n1. Ask the admin here in the group, or {admin} — they sort your package and tell you the current price.\n2. Payment is by crypto (Litecoin or Bitcoin). Ask me for the payment guide and I'll post the steps — you can buy it with a normal bank card in about ten minutes, even if you've never touched crypto.\n3. Once you're activated you get your own login, and installing takes two minutes: enter code {skyglass} in the Downloader app, install Sky Glass and sign in. Ask me for the Firestick guide and I'll post the full steps.\nSigning up a mate rather than yourself? Same three steps for them — and send me /invite for a one-use link to get them into this group.\nWant to check something first — channels, devices, what's included? Just ask me.",
    keywords: 'sign up, signup, signing up, sign me up, join, joining, subscribe, interested, how do i start, want in, getting started',
  },
  {
    // Owns the device-less phrasings ("don't know how to install the apps");
    // the device FAQs below keep only their distinctive vocabulary.
    question: 'How do I install the apps?',
    answer: "Depends on your device:\n📺 Firestick: install the Downloader app from the Amazon store, open it and enter code {skyglass}, click Go, then install Sky Glass — that's the app we recommend now. The Purple App is on its own code, {purple}, if you want it as well.\n📱 Android phone/tablet: open https://aftv.news/{skyglass} in your browser (every Downloader code also works as an aftv.news link). Purple is at https://aftv.news/{purple}.\n🍏 iPhone/iPad: install Smarters Player Lite free from the App Store and log in with your username, password and the service URL (ask here if you don't have it).\nThen open the app and log in with your service details. If your device blocks the install, say so and I'll walk you through allowing it.",
    keywords: 'install, installing, installed, app, apps, get, setup, put',
    priority: 1,
  },
  {
    question: 'Which Firestick is best / which one should I buy?',
    answer: "Any Firestick running Fire OS (the Android-based one) works with our apps. Quick guide:\n- Best value: Fire TV Stick 4K — smooth, handles 4K streams, usually the sweet spot on price.\n- Fastest: Fire TV Stick 4K Max — worth it if you want the snappiest menus.\n- Budget: the basic Fire TV Stick or Lite is fine for HD viewing.\n⚠️ AVOID the Fire TV Stick 4K Select or anything running Amazon's new Vega OS — that isn't Android, so our apps CANNOT be installed on it. If the listing mentions Vega OS, skip it.\nAlso avoid very old sticks (2016 and earlier). Whichever you get, setup takes two minutes: ask me how to install and I'll walk you through it.",
    keywords: 'firestick, best, buy, buying, which one, recommend, recommended, model, models, 4k, max, lite, select, vega, vegas, os, upgrade, worth it',
  },
  {
    question: 'How do I install the app on my Firestick?',
    answer: 'Install the Downloader app from the Amazon app store, open it, enter code {skyglass} and click Go — that installs Sky Glass, the app we recommend now. The Purple App has its own code, {purple}, and XC or Smarters work as backups (the same login works in all of them).\nIf the Firestick blocks the install: Settings > My Fire TV > About > click the device name 7–10 times to unlock Developer Options, then enable both options in there and go back to Downloader.\nOnce installed, open the app and log in with your service details. Want the full step-by-step? Ask me for the Firestick guide and I\'ll post it here.',
    // No literal code numbers in here: a keyword list is a second place a code
    // has to be kept up to date, and it silently stops matching the day the
    // code changes. The codes live in Bot settings and reach the text as
    // {purple} / {skyglass}.
    keywords: 'firestick, fire, stick, downloader, tv, code, codes, sideload, app, apps, purple, download code, downloader code, setup, set up, setting up, first time, just got, new firestick',
    priority: 2,
  },
  {
    question: 'How do I install the app on an Android phone or tablet?',
    answer: 'Open https://aftv.news/{skyglass} in your phone’s browser for Sky Glass, the app we recommend — every Downloader code works as a link at aftv.news/CODE, so the Purple App is at https://aftv.news/{purple}. Pick the app you want and allow installs from unknown sources if your phone asks (the prompt varies by model). Install it, open it, and log in with your service details.',
    keywords: 'android, phone, tablet, mobile, apk, installer, link, aftv, samsung, pixel, app, apps',
  },
  {
    // Ships ENABLED: Sky Glass is the recommended app and its code comes from
    // Bot settings, so there is nothing to fill in first. Keywords are kept
    // deliberately narrow — see the general install entry above, which owns
    // every device-less and generic "what's the code" phrasing.
    question: 'How do I install the Sky Glass app?',
    answer: 'Sky Glass is the main app we recommend now. It has its own Downloader code, separate from the Purple App:\n📺 Firestick: open the Downloader app, enter code {skyglass} and click Go.\n📱 Android or any browser: open https://aftv.news/{skyglass}\nInstall it, open it and log in with your usual service details.\nIf the install gets blocked, the device needs permission first — ask me about Developer Options and I\'ll walk you through it.',
    keywords: 'sky, glass, skyglass, sky glass, main app, recommended app',
    enabled: 1,
  },
  {
    question: 'How do I install the app on an iPhone or iPad (iOS)?',
    answer: 'On iPhone/iPad use Smarters Player Lite — install it free from the App Store:\nhttps://apps.apple.com/gb/app/smarters-player-lite/id1628995509\nOpen it, accept the terms and choose "Login with Xtream Codes API", then enter:\n- Any name you like\n- Your username and password (your normal service login)\n- The service URL — don\'t have it? Ask me "what\'s the service URL?" and I\'ll sort you out\nTap Add User and your channels and VOD will load.',
    keywords: 'ios, iphone, ipad, apple, store, lite, url, install, installing, app, apps',
  },
  {
    // Added after the bot invented this procedure from nothing. Asked "clear
    // data and relogin instructions for sky glass" it replied: "Open the Sky
    // Glass app. Tap on the settings icon (gear). Select Clear Data." There
    // is no gear and no Clear Data inside the app — clearing app data is an
    // operating-system job, and the menu is in a different place on every
    // device. Told "No clear data", it then invented a power-button
    // sequence. Both answers sound right and send the customer round in
    // circles looking for buttons that are not there.
    question: 'How do I clear the app data and log back in?',
    answer: 'Clearing app data is done in your DEVICE settings, not inside the app — there is no "clear data" button in Purple, Sky Glass, XC or Smarters. It wipes the login and the cached guide, so have your username and password to hand before you start.\n📺 Firestick / Fire TV: Settings > Applications > Manage Installed Applications > pick the app > Clear data (then Clear cache too), then open it and log in again.\n📱 Android phone or tablet: Settings > Apps > pick the app > Storage > Clear storage (or Clear data), then open it and log in again.\n🍏 iPhone / iPad: there is no clear-data option — delete the app, reinstall it from the App Store and log in again.\n📺 Samsung / LG smart TV: uninstall the app and reinstall it from the TV\'s app store.\nIf you have lost your password, don\'t send it to me — {admin} and they will reset it.',
    keywords: 'clear, data, cache, clearing, storage, wipe, reset, relogin, re-login, log back in, logout, log out, fresh, start again, reinstall',
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
    answer: "Happy to get them set up!\n1. First they need their own login (username + password) — ask the admin here in the group, or {admin} to sort out access and pricing.\n2. Bring them into this group: send me /invite and I'll give you a personal one-use invite link for them.\n3. Once they have their login, installing takes two minutes: enter code {skyglass} in the Downloader app, install Sky Glass and sign in. Ask me for the Firestick guide and I'll post the full steps here.",
    // "signup", "sign up", "join", "joining" and "interested" moved to the
    // sign-up entry above: they are what somebody says about themselves, and
    // this entry answers in the third person. What is left is what actually
    // marks a message as being about someone else.
    // Not a single keyword here may contain the word "join": keywords are
    // tokenised, so "wants to join" hands this entry the word "join" and
    // "how do I join" — a person asking about themselves — lands back on
    // the third-person answer. "Wants" is the discriminator that works: you
    // want to join, your mate wants to.
    keywords: 'friend, friends, mate, mates, refer, referral, bring, invite, inviting, someone, somebody, else, another, wants, wanting, group',
  },
  {
    question: 'Which app should I use — Purple, XC or Smarters?',
    answer: 'Sky Glass is the app we recommend now — install that as your main one. Purple, XC and Smarters all work as backups, and it is worth having at least one of them installed. The same login works in every app, so if one ever plays up you just switch to another and carry on. On iPhone/iPad, use Smarters Player Lite from the App Store instead.\nIf one of the apps is misbehaving for everyone we post about it — send me /status to see the latest.',
    keywords: 'purple, xc, smarters, app, which, best, backup, main, recommend',
  },
  {
    question: 'The app keeps buffering, freezing or stuttering — how do I fix it?',
    answer: 'Try these in order — they fix most buffering:\n1. Restart the app and your device.\n2. Restart your router.\n3. Clear the app cache (Settings > Applications > Manage Installed Applications > the app > Clear cache).\n4. Use 5GHz WiFi if you can — 2.4GHz struggles with HD streams. (A Firestick has no ethernet port; wired needs Amazon’s Ethernet Adapter.)\n5. Switch to a backup app (XC or Smarters) with the same login — one app often runs better than another.\n6. Try a lower quality stream or a different link/server for the same channel.\n7. Run a speed test — HD needs about 10 Mbps, 4K about 25 Mbps.',
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
    answer: "Big live events are shown on the sports and PPV channels in Live TV — they usually go live shortly before the event starts, so check around fight or kickoff time.\nNot sure which channel? Just ask me — \"what channel is the boxing on?\", \"what's on Sky Sports Main Event?\" — and I'll look it up in our own channel list and TV guide and tell you the exact channel.\nMissed it? Big events usually land in VOD shortly after — check the VOD section, and if it's not there send a request: post \"Request: <event name>\" here or {admin}.",
    keywords: 'ufc, boxing, fight, ppv, sports, sport, football, match, event, events, live, tonight, watch, channel, vod',
  },
  {
    question: 'How do I request a movie, series or VOD?',
    answer: 'Send the exact title and year (for series: which season), e.g. "Request: Inception (2010)". Post it in the group or {admin}. Requests are added in batches — give it a little time and check the VOD section again.\nWondering if something WILL be on VOD (a new film, last night\'s event)? Check the VOD section first — new titles and event replays are added regularly — and if it\'s not there, request it the same way.',
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
    keywords: 'crash, crashes, crashing, crashed, keeps, wont, open, opening, opens, closes, closing, close, startup, reinstall, force, unresponsive, glitchy',
  },
  {
    question: 'What internet speed do I need?',
    answer: "HD streams want about 10 Mbps, 4K about 25 Mbps — most home connections are fine. What matters more:\n- Use 5GHz WiFi if you can; 2.4GHz WiFi is the #1 cause of buffering. (A Firestick is WiFi only — wired needs Amazon’s Ethernet Adapter.)\n- Run a speed test ON the streaming device, not your phone.\n- If your speed is fine but streams still stutter, try the buffering fixes — ask me about buffering.",
    keywords: 'speed, mbps, internet, broadband, bandwidth, fast, slow, connection, wired',
  },
  {
    question: 'Can I record shows or use catch-up?',
    answer: "There's no DVR-style recording, but you rarely need it:\n- Series and movies are in the VOD section on demand.\n- Big events usually get replays added to VOD shortly after they finish.\n- Many channels support pause and rewind right in the player.\nMissing something? Request it — post \"Request: <title>\" here or {admin}.",
    keywords: 'record, recording, recordings, dvr, catchup, catch, rewind, pause',
  },
  {
    question: 'What payment methods do you take — can I pay by card or PayPal?',
    answer: "We take crypto — Litecoin (LTC) or Bitcoin (BTC), whichever suits you. Don't let that put you off if you've never used it: you can buy either with a normal bank card in about 10 minutes (Exodus wallet + MoonPay), and I'll walk you through it — just ask me for the payment guide and I'll post the steps here.\nWhen you're ready to send, ask me for the wallet address and I'll give you the right one. Ask the admin if you need to arrange a different option.",
    keywords: 'card, paypal, bank, transfer, methods, method, revolut, cash, debit, credit, pay, paying',
  },
  {
    // Used to ship DISABLED carrying a literal DEFAULT-PIN placeholder, which
    // is worse than no entry: unfilled, the bot quotes "the default PIN is
    // DEFAULT-PIN" at a customer. It now names the PINs the apps themselves
    // ship with and falls back to a human, so there is nothing to fill in.
    // The channel lookup never lists adult channels — not in a genre
    // answer, not in a browse answer, and never in a group where everyone
    // sees it. So the question has to be answerable from knowledge, or
    // asking it plainly gets nothing at all.
    question: 'Is there an adult section, and how do I get into it?',
    answer: "Yes — there's an adult section in the app, and it's PIN-locked by default so it can't be opened by accident.\nIt's in the categories list with the rest; scroll to it and the app will ask for the PIN. Out of the box that's usually 0000 or 1234, and you can set your own in the app's settings under Parental Controls.\nI won't list those channels out in chat — have a look in the app and they're all there.",
    keywords: 'adult, adults, xxx, porn, 18, erotic, section, locked, hidden, blocked',
  },
  {
    question: 'What is the PIN for locked categories (parental controls)?',
    answer: "Some categories are PIN-locked (parental controls). Out of the box our apps use one of the usual defaults — try 0000 first, then 1234. Once you're in you can set your own in the app's settings under Parental Controls, so write it down somewhere.\nIf neither works, ask here and we'll sort it out — don't keep guessing, some apps lock you out for a while after a few wrong tries.",
    keywords: 'pin, locked, lock, parental, control, controls, categories, category, restricted',
  },
  {
    question: 'How do I update the app to the latest version?',
    answer: 'On a Firestick: open the Downloader app, enter your app\'s code again ({skyglass} for Sky Glass, {purple} for Purple) and install the newest version straight over the old one — your settings are kept. On Android: open https://aftv.news/{skyglass} or https://aftv.news/{purple} in your browser again. On iPhone/iPad: update Smarters Player Lite through the App Store. You can also message me /version to see the latest version.',
    keywords: 'update, upgrade, latest, version, new, old',
  },
  {
    question: 'How do I check or renew my subscription?',
    answer: 'To check your status and expiry date, or to renew, {admin}. We take crypto — Litecoin (LTC) or Bitcoin (BTC). Ask me for the payment guide and I’ll post the steps, and ask me for the wallet address when you’re ready — the admin confirms the exact amount.',
    keywords: 'renew, renewal, expire, expiry, expired, subscription, sub, payment, pay, account',
  },
  {
    question: 'How do I pay with crypto?',
    answer: "We take Litecoin (LTC) or Bitcoin (BTC), and any wallet works — Exodus is the easiest if you’re new:\n1. Download Exodus from exodus.com and set it up.\n2. Tap Buy Crypto, pick Litecoin or Bitcoin, and buy the amount we tell you (first time may need quick ID verification with the payment partner).\n3. Ask me for the wallet address — I’ll send you the right one for the coin you’re using. Tap Send in Exodus, paste it in, and check it matches before you confirm.\n4. Make sure you send the coin that matches the address — LTC to the LTC address, BTC to the BTC address. Sending the wrong coin loses it.\n5. Send us a screenshot of the confirmation and we’ll activate or renew you.\nWant the full walkthrough? Ask me for the payment guide and I’ll post it here.",
    keywords: 'pay, payment, crypto, litecoin, ltc, bitcoin, btc, coin, wallet, address, exodus, moonpay, buy, send',
  },
  {
    question: "The app says my login is wrong or my account doesn't work",
    answer: 'If it says "invalid user" or your login is rejected:\n1. Double-check the username and password — watch for extra spaces and capital letters.\n2. Make sure you\'re in the right app — the same login works in Sky Glass, Purple, XC and Smarters.\n3. If we\'ve posted about service issues (check /status or the group), it\'s likely on our side — hang tight and try again shortly.\n4. Still no luck? Your access may have expired — {admin} and we\'ll sort it.',
    keywords: 'login, log, password, credentials, invalid, wrong, cant, sign, denied, auth, user, username, details, incorrect, unauthorised, rejected',
  },
  {
    // Ships DISABLED — but there is no longer any text to hand-edit: the two
    // brand names come from Bot settings via {service1}/{service2}, so a name
    // can't drift out of step with the rest of the system. Set both names,
    // then enable this entry.
    question: 'Which service am I on?',
    answer: "Easy way to tell — look at the username you log in with:\n- If it's randomly generated (a mix of letters and numbers), you're on {service1}.\n- If it starts with THM, or it's a proper name rather than random characters, you're on {service2}.\nNot sure? Reply to this message with just your username (never your password!) and I'll tell you.",
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
    answer: "All services are used at your own discretion, and refunds may not be available once a service has been activated. If something isn't working, talk to us first — we're always happy to help fix it. {admin} and the team will look after you.",
    keywords: 'refund, refunds, money, back, cancel, guarantee, chargeback',
  },
];

const EDIT_MARKER = 'Admin: edit this guide first!';

// Records WHAT WE SHIPPED so a later version can tell "still ours" from
// "the admin rewrote it". Guides run to thousands of characters, so keeping
// every previous body the way the FAQ upgrade does is not practical.
const seedHash = (body) => createHash('sha256').update(String(body)).digest('hex').slice(0, 32);

function insertGuide(g, sort, t) {
  db.prepare('INSERT INTO guides (title, slug, body_md, sort, visible, seed_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(g.title, g.slug, g.body_md, sort, g.visible, seedHash(g.body_md), t);
}

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
2. Enter this code: **{skyglass}**
3. Click **Go** and install **Sky Glass** — this is the app we recommend now.
4. We recommend installing more than one app for the best experience. Go back
   into Downloader and enter a second code:
   - **{purple}** — the **Purple App**
   - **XC** or **Smarters** also work — keep one as a backup (the same login
     works in all of them)
5. Open your chosen app and log in with your service details.

## If the install is blocked ("unknown sources")

1. Press the **Home** button on the remote.
2. Go to **Settings** → **My Fire TV** → **About**.
3. Highlight your device name and press it **7–10 times** until Developer Options are enabled.
4. Go back and open **Developer Options**.
5. Enable **both** available options.
6. Return to Downloader and continue the installation.

## Problems?

Ask in the group — the bot answers install questions instantly. For a human, {admin}.`,
  },
  {
    title: 'Install on Android phone / tablet',
    slug: 'install-android',
    visible: 1,
    body_md: `## Install the app

1. Open this link in the browser on your Android device: **https://aftv.news/{skyglass}**
   (every Firestick Downloader code also works as a link — just put it after aftv.news/)
2. That installs **Sky Glass**, the app we recommend now. The **Purple App** is
   at **https://aftv.news/{purple}** if you want it as well.
3. If prompted, allow installation from unknown sources (this varies a little depending on your phone model).
4. Once installed, open the app and log in with your service details.

*Tip: install a second app — Purple, XC or Smarters — as a backup too. The same login works in all our apps.*`,
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
    title: 'How to pay with crypto (Litecoin or Bitcoin)',
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

## Step 2 — Buy Litecoin (LTC) or Bitcoin (BTC)

We take either. Litecoin usually costs less to send, so pick that if you have no preference.

Exodus lets you buy in-app through payment partners like MoonPay.

1. Open Exodus and tap **Buy Crypto**.
2. Select **Litecoin (LTC)** or **Bitcoin (BTC)**.
3. Choose the amount — **we'll give you the exact amount** — and pick your payment method.
4. Follow the payment partner's steps (first purchase may need a quick ID verification).
5. The coins land in your wallet automatically after payment.

## Step 3 — Send it to us

1. **Ask the bot for the wallet address** — send it "whats the wallet address" and it gives you
   the right one. Every coin has its own address, so never reuse one for a different coin.
2. Go to the **Wallet** tab in Exodus and select the coin you bought.
3. Tap **Send**.
4. Paste the address and **check it character for character against the one the bot sent you**.
   A crypto transfer cannot be reversed or refunded, so this is the step to be slow on.
5. Enter the amount and press **Send** to confirm.
6. You'll see a confirmation and the transaction appears in your history — **send us a screenshot** and we'll activate or renew your service.

> **Addresses change between coins, never between payments.** Exodus may show you a fresh
> receive address of your own each time — that is normal and is for money coming IN to you.
> The address you send OUR payment to is the one the bot gives you.

## Important notice

We aim to provide the best support possible and are always happy to help where we can. Please note that all services are used at your own discretion, and refunds may not be available once the service has been activated.`,
  },
];

// Earlier default texts, kept so the upgrade can tell "still the default"
// apart from "admin edited this" — only untouched entries are upgraded.
// Values are arrays: one entry per previous version of that answer.
// The Firestick has no ethernet port, so two answers that told people to
// run a cable to one were corrected. Kept here so an install still
// holding the old wording is refreshed, and one the admin has edited is
// left exactly as they wrote it.
const V32_BUFFERING =
  'Try these in order — they fix most buffering:\n1. Restart the app and your device.\n2. Restart your router.\n3. Clear the app cache (Settings > Applications > Manage Installed Applications > the app > Clear cache).\n4. Use 5GHz WiFi or wired ethernet if you can — 2.4GHz struggles with HD streams.\n5. Switch to a backup app (XC or Smarters) with the same login — one app often runs better than another.\n6. Try a lower quality stream or a different link/server for the same channel.\n7. Run a speed test — HD needs about 10 Mbps, 4K about 25 Mbps.';
const V32_SPEED =
  "HD streams want about 10 Mbps, 4K about 25 Mbps — most home connections are fine. What matters more:\n- Use 5GHz WiFi or wired ethernet if you can; 2.4GHz WiFi is the #1 cause of buffering.\n- Run a speed test ON the streaming device, not your phone.\n- If your speed is fine but streams still stutter, try the buffering fixes — ask me about buffering.";

const V3_BUFFERING =
  'Try these in order — they fix most buffering:\n1. Restart the app and your device.\n2. Restart your router.\n3. Clear the app cache (Settings > Applications > Manage Installed Applications > the app > Clear cache).\n4. Use 5GHz WiFi or wired ethernet if you can — 2.4GHz struggles with HD streams.\n5. Switch to a backup app (XC or Smarters) with the same login — one app often runs better than another.\n6. Try a lower quality stream or a different link/server for the same channel.\n7. Run a speed test — HD needs about 10 Mbps, 4K about 25 Mbps.\nStill buffering after all that? Tell us the channel and the time it happened.';
const V3_CHANNEL =
  "First try a different link/server for the same channel, or the same channel in a backup app (XC/Smarters) — and give it a minute, streams sometimes restart on their own. Still down? Report it with: the exact channel name, what you see (frozen / black screen / error message), and the time. That helps us fix it fast.";
const V2_LOGIN =
  'Double-check the username and password — watch for extra spaces and capital letters. If it still fails your access may have expired: {admin} and we’ll sort it.';
const V10_INSTALL_ANY =
  "Depends on your device:\n📺 Firestick: install the Downloader app from the Amazon store, open it and enter code {purple}, click Go, then install the Purple App (plus XC or Smarters as backups — same login works in all).\n📱 Android phone/tablet: open our Android installer link (ask here or check the customer panel if you don't have it) and pick the Purple App.\nThen open the app and log in with your service details. If your device blocks the install, say so and I'll walk you through allowing it.";
const V10_ANDROID =
  'Open our Android installer link on your device (ask here or check the customer panel if you don’t have it), pick the app you want — we recommend the Purple App — and allow installs from unknown sources if your phone asks (the prompt varies by model). Install it, open it, and log in with your service details.';
const V10_UPDATE =
  'On a Firestick: open the Downloader app, enter code {purple} again and install the newest version straight over the old one — your settings are kept. On Android: use the installer link again. You can also message me /version to see the latest version.';
const V11_INSTALL_ANY =
  "Depends on your device:\n📺 Firestick: install the Downloader app from the Amazon store, open it and enter code {skyglass}, click Go, then install Sky Glass — that's the app we recommend now. The Purple App is on its own code, {purple}, if you want it as well.\n📱 Android phone/tablet: open https://aftv.news/{skyglass} in your browser (every Downloader code also works as an aftv.news link). Purple is at https://aftv.news/{purple}.\nThen open the app and log in with your service details. If your device blocks the install, say so and I'll walk you through allowing it.";
const V11_UPDATE =
  'On a Firestick: open the Downloader app, enter code {purple} again and install the newest version straight over the old one — your settings are kept. On Android: open https://aftv.news/{purple} in your browser again. You can also message me /version to see the latest version.';
const V11_WHICH_APP =
  'Use the Purple App as your main app. XC and Smarters are backups — install at least one of them too. The same login works in every app, so if one ever plays up, just switch to a backup and carry on.';
// v22 shipped a URL FAQ that would have sent BOTH services' URLs to anyone —
// replaced in v23 by the code-side per-user URL flow (see bot/pipeline.js).
// Kept only so the upgrade can delete untouched leftovers.
const V22_URL_FAQ =
  "The service URL depends on which service you're on — check the username you log in with:\n- Randomly generated (a mix of letters and numbers): use SERVICE-URL-1\n- Starts with THM: use SERVICE-URL-2\nEnter it exactly as written, together with your normal username and password.\nNot sure which you are? Reply to this message with just your username (never your password!) and I'll tell you.";
const V12_IOS =
  'On iPhone/iPad use Smarters Player Lite — install it free from the App Store:\nhttps://apps.apple.com/gb/app/smarters-player-lite/id1628995509\nOpen it, accept the terms and choose "Login with Xtream Codes API", then enter:\n- Any name you like\n- Your username and password (your normal service login)\n- The service URL (ask here or message the admin if you don\'t have it)\nTap Add User and your channels and VOD will load.';
const V20_LANGUAGE =
  "While the video is playing, open the player controls (press OK on the remote or tap the screen) and look for the audio/track button — usually a headphones or speech-bubble icon. Pick English (or whichever language you want) from the list. The same login works in XC and Smarters too, and their players sometimes list audio tracks differently.\nIf only one language is listed, that copy only came with one audio track — reply with the exact title and the language you need and I'll flag it to the team to source a better copy.";
const V19_VOD_REQUEST =
  'Send the exact title and year (for series: which season), e.g. "Request: Inception (2010)". Post it in the group or {admin}. Requests are added in batches — give it a little time and check the VOD section again. There are also VOD recommendations in the customer panel.';
const V18_FIRESTICK_BUY =
  "Any current Firestick runs our apps. Quick guide:\n- Best value: Fire TV Stick 4K — smooth, handles 4K streams, usually the sweet spot on price.\n- Fastest: Fire TV Stick 4K Max — worth it if you want the snappiest menus.\n- Budget: the basic Fire TV Stick or Lite is fine for HD viewing.\nAvoid very old sticks (2016 and earlier) — they struggle with modern apps. Whichever you get, setup takes two minutes: ask me how to install and I'll walk you through it.";
const V16_WHAT_IS =
  "Live TV channels, movies, series and sports — streamed through our apps on Firestick, Android phones/tablets and iPhone/iPad (the Purple App as your main one, XC and Smarters as backups, Smarters Player Lite on iOS). One login works across all your apps.\nInterested, or want pricing? Ask the admin here in the group, or {admin} and the team will get you set up.";
const V13_WHICH_SERVICE =
  "Easy way to tell — look at the username you log in with:\n- If it's randomly generated (a mix of letters and numbers), you're on SERVICE-NAME-1.\n- If it starts with THM, you're on SERVICE-NAME-2.\nStill not sure? Ask here and we'll check for you.";
const V14_WHICH_SERVICE =
  "Easy way to tell — look at the username you log in with:\n- If it's randomly generated (a mix of letters and numbers), you're on SERVICE-NAME-1.\n- If it starts with THM, you're on SERVICE-NAME-2.\nNot sure? Reply to this message with just your username (never your password!) and I'll tell you.";

const V1_ANSWERS = {
  'How do I install the app on my Firestick?': 'Easiest way is with the Downloader app:\n1. On the Firestick go to Settings > My Fire TV > Developer Options and allow apps from unknown sources (or allow Downloader there).\n2. Install "Downloader" from the Amazon app store.\n3. Open Downloader and enter the download link or code from our portal.\n4. Install the APK when it finishes, open the app and sign in.\nGot a portal login? Message me /download in a private chat and I’ll send the file or a code.',
  'How do I install the app on an Android phone or tablet?': '1. Log in to the download portal and download the latest APK.\n2. Open the file — Android will ask you to allow installs from your browser; allow it.\n3. Install and sign in.\nYou can also message me /download in a private chat to get the file sent straight to you.',
  'The app keeps buffering, freezing or stuttering — how do I fix it?': 'Try these in order — they fix most buffering:\n1. Restart the app and your device.\n2. Restart your router.\n3. Clear the app cache (Settings > Applications > Manage Installed Applications > the app > Clear cache).\n4. Use 5GHz WiFi or wired ethernet if you can — 2.4GHz struggles with HD streams.\n5. Try a lower quality stream or a different link/server for the same channel.\n6. Run a speed test — HD needs about 10 Mbps, 4K about 25 Mbps.\nStill buffering after all that? Tell us the channel and the time it happened.',
  'How do I request a movie, series or VOD?': 'Send the exact title and year (for series: which season), e.g. "Request: Inception (2010)". Post it in the group or {admin}. Requests are added in batches — give it a little time and check the VOD section again.',
  "A channel or stream isn't working — what do I do?": "First try a different link/server for the same channel if the app offers one, and give it a minute — streams sometimes restart on their own. Still down? Report it with: the exact channel name, what you see (frozen / black screen / error message), and the time. That helps us fix it fast.",
  'How do I update the app to the latest version?': 'Download the newest APK from the portal and install it straight over the old one — your settings are kept. On a Firestick, enter the download code or link in the Downloader app again. You can also message me /version to see the latest version and /download to get it.',
  'How do I check or renew my subscription?': 'To check your status, expiry date or to renew, {admin}.',
};

// The generation shipped before Sky Glass became the main app and before
// download codes moved to {purple}/{skyglass} placeholders. Recorded so an
// install still carrying this exact text is recognised as untouched and
// gets refreshed, instead of looking hand-edited and being left behind.
const V21_INSTALL_ANY =
  "Depends on your device:\n📺 Firestick: install the Downloader app from the Amazon store, open it and enter code 9804805, click Go, then install the Purple App (plus XC or Smarters as backups — same login works in all).\n📱 Android phone/tablet: open https://aftv.news/9804805 in your browser (every Downloader code also works as an aftv.news link) and pick the Purple App.\n🍏 iPhone/iPad: install Smarters Player Lite free from the App Store and log in with your username, password and the service URL (ask here if you don't have it).\nThen open the app and log in with your service details. If your device blocks the install, say so and I'll walk you through allowing it.";
const V21_FIRESTICK =
  'Install the Downloader app from the Amazon app store, open it and enter code 9804805, then click Go. That page has all our apps — install the Purple App as your main one, plus XC or Smarters as backups (the same login works in all of them).\nIf the Firestick blocks the install: Settings > My Fire TV > About > click the device name 7–10 times to unlock Developer Options, then enable both options in there and go back to Downloader.\nOnce installed, open the app and log in with your service details. Full walkthrough is in the Firestick guide.';
const V21_ANDROID =
  'Open https://aftv.news/9804805 in your phone’s browser — every Downloader code also works as a link at aftv.news/CODE. Pick the app you want — we recommend the Purple App — and allow installs from unknown sources if your phone asks (the prompt varies by model). Install it, open it, and log in with your service details.';
const V21_UPDATE =
  'On a Firestick: open the Downloader app, enter code 9804805 again and install the newest version straight over the old one — your settings are kept. On Android: open https://aftv.news/9804805 in your browser again. On iPhone/iPad: update Smarters Player Lite through the App Store. You can also message me /version to see the latest version.';

// v25: the generation that still named the Purple App as the main app, left a
// DEFAULT-PIN placeholder in the parental-controls entry, and pointed people at
// the customer panel the bot no longer links to. Recorded so an install still
// carrying this exact text is recognised as untouched and refreshed.
const V25_WHAT_IS =
  "Live TV channels, sports, and a full VOD library of movies and series on demand — streamed through our apps on Firestick, Android phones/tablets and iPhone/iPad (the Purple App as your main one, XC and Smarters as backups, Smarters Player Lite on iOS). One login works across all your apps, and you can request VOD titles we don't have yet.\nInterested, or want pricing? Ask the admin here in the group, or {admin} and the team will get you set up.";
const V25_WHICH_APP =
  'Use the Purple App as your main app. XC and Smarters are backups — install at least one of them too. The same login works in every app, so if one ever plays up, just switch to a backup and carry on. On iPhone/iPad, use Smarters Player Lite from the App Store instead.';
const V25_SPORTS =
  "Big live events are shown on the sports and PPV channels in Live TV — they usually go live shortly before the event starts, so check around fight or kickoff time. The sports guide in the customer panel shows what's on and where.\nMissed it? Big events usually land in VOD shortly after — check the VOD section, and if it's not there send a request: post \"Request: <event name>\" here or {admin}.";
const V25_VOD_REQUEST =
  'Send the exact title and year (for series: which season), e.g. "Request: Inception (2010)". Post it in the group or {admin}. Requests are added in batches — give it a little time and check the VOD section again.\nWondering if something WILL be on VOD (a new film, last night\'s event)? Check the VOD section first — new titles and event replays are added regularly — and if it\'s not there, request it the same way. There are also VOD recommendations in the customer panel.';
const V25_PIN =
  "Some categories are PIN-locked (parental controls). The default PIN in our apps is DEFAULT-PIN — you can change it in the app's settings under Parental Controls. If that PIN doesn't work in your app, ask here and we'll sort it.";
const V25_LOGIN_WRONG =
  'If it says "invalid user" or your login is rejected:\n1. Double-check the username and password — watch for extra spaces and capital letters.\n2. Make sure you\'re in the right app — the same login works in Purple, XC and Smarters.\n3. If we\'ve posted about service issues (check /status or the group), it\'s likely on our side — hang tight and try again shortly.\n4. Still no luck? Your access may have expired — {admin} and we\'ll sort it.';
const V25_WHICH_SERVICE =
  "Easy way to tell — look at the username you log in with:\n- If it's randomly generated (a mix of letters and numbers), you're on SERVICE-NAME-1.\n- If it starts with THM, or it's a proper name rather than random characters, you're on SERVICE-NAME-2.\nNot sure? Reply to this message with just your username (never your password!) and I'll tell you.";
// Retired in v26: the bot no longer links to the customer panel, so an entry
// whose whole job was to advertise it only ever ends in "ask here for the
// link". Kept so untouched leftovers can be deleted.
const V25_PANEL_FAQ =
  'The customer panel has everything in one place: service maintenance updates, app download links, URLs and setup info, VOD recommendations, the sports guide, your account details, FAQs and payment information. Log in with your account details and everything assigned to you appears automatically. Ask here if you need the panel link.';

// v26: the generation that ended install answers with "full walkthrough is in
// the Firestick guide". A Telegram customer has no guides section to go to,
// and the phrasing taught the model to answer a request for a guide by
// pointing at one — which is exactly what it did, twice, in the group.
const V26_FIRESTICK =
  'Install the Downloader app from the Amazon app store, open it, enter code {skyglass} and click Go — that installs Sky Glass, the app we recommend now. The Purple App has its own code, {purple}, and XC or Smarters work as backups (the same login works in all of them).\nIf the Firestick blocks the install: Settings > My Fire TV > About > click the device name 7\u201310 times to unlock Developer Options, then enable both options in there and go back to Downloader.\nOnce installed, open the app and log in with your service details. Full walkthrough is in the Firestick guide.';
const V26_FRIEND =
  "Happy to get them set up!\n1. First they need their own login (username + password) \u2014 ask the admin here in the group, or {admin} to sort out access and pricing.\n2. Bring them into this group: send me /invite and I'll give you a personal one-use invite link for them.\n3. Once they have their login, installing takes two minutes: enter code {skyglass} in the Downloader app, install Sky Glass and sign in \u2014 full steps in the Firestick guide.";

// v27: Litecoin only, and the payment answers ended by pointing at a guide
// the customer could not reach.
const V27_METHODS =
  "We take crypto \u2014 Litecoin (LTC). Don't let that put you off if you've never used it: the payment guide walks you through it step by step, and you can buy the LTC with a normal bank card in about 10 minutes (Exodus wallet + MoonPay). Ask the admin if you need to arrange a different option.";
const V27_RENEW =
  'To check your status and expiry date, or to renew, {admin}. We take crypto (Litecoin): the payment guide walks you through it step by step, and we\u2019ll send you the wallet address and exact amount.';
const V27_CRYPTO =
  "We take Litecoin (LTC), and any wallet works \u2014 Exodus is the easiest if you\u2019re new:\n1. Download Exodus from exodus.com and set it up.\n2. Tap Buy Crypto, pick Litecoin (LTC), and buy the amount we tell you (first time may need quick ID verification with the payment partner).\n3. Tap Send, paste the wallet address we give you (double-check it \u2014 LTC only), enter the amount and confirm.\n4. Send us a screenshot of the confirmation and we\u2019ll activate or renew you.\nFull walkthrough with pictures is in the payment guide.";

function previousDefaults(question) {
  const out = [];
  if (V1_ANSWERS[question]) out.push(V1_ANSWERS[question]);
  if (question === 'The app keeps buffering, freezing or stuttering — how do I fix it?') out.push(V3_BUFFERING, V32_BUFFERING);
  if (question === "A channel or stream isn't working — what do I do?") out.push(V3_CHANNEL);
  if (question === 'What internet speed do I need?') out.push(V32_SPEED);
  if (question === "The app says my login is wrong or my account doesn't work") out.push(V2_LOGIN);
  if (question === 'How do I install the apps?') out.push(V10_INSTALL_ANY, V11_INSTALL_ANY, V21_INSTALL_ANY);
  if (question === 'How do I install the app on my Firestick?') out.push(V21_FIRESTICK, V26_FIRESTICK);
  if (question === 'How can my friend join the service?') out.push(V26_FRIEND);
  if (question === 'What payment methods do you take — can I pay by card or PayPal?') out.push(V27_METHODS);
  if (question === 'How do I check or renew my subscription?') out.push(V27_RENEW);
  if (question === 'How do I pay with crypto?') out.push(V27_CRYPTO);
  if (question === 'How do I install the app on an Android phone or tablet?') out.push(V10_ANDROID, V21_ANDROID);
  if (question === 'How do I update the app to the latest version?') out.push(V10_UPDATE, V11_UPDATE, V21_UPDATE);
  if (question === 'Which app should I use — Purple, XC or Smarters?') out.push(V11_WHICH_APP, V25_WHICH_APP);
  if (question === 'Which service am I on?') out.push(V13_WHICH_SERVICE, V14_WHICH_SERVICE, V25_WHICH_SERVICE);
  if (question === 'What is this service and what do you get?') out.push(V16_WHAT_IS, V25_WHAT_IS);
  if (question === 'Which Firestick is best / which one should I buy?') out.push(V18_FIRESTICK_BUY);
  if (question === 'How do I request a movie, series or VOD?') out.push(V19_VOD_REQUEST, V25_VOD_REQUEST);
  if (question === 'The audio is in the wrong language — how do I change it?') out.push(V20_LANGUAGE);
  if (question === 'How do I install the app on an iPhone or iPad (iOS)?') out.push(V12_IOS);
  if (question === 'Where can I watch live sports and events (UFC, boxing, PPV, football)?') out.push(V25_SPORTS);
  if (question === 'What is the PIN for locked categories (parental controls)?') out.push(V25_PIN);
  if (question === "The app says my login is wrong or my account doesn't work") out.push(V25_LOGIN_WRONG);
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
    // The parental-controls entry shipped DISABLED only because it carried an
    // unfilled DEFAULT-PIN placeholder. The replacement has nothing to fill
    // in, so an install still holding that exact placeholder text — i.e. one
    // the admin never touched — gets it switched on as part of the refresh.
    // Gated on the OLD text so it fires once and never second-guesses an entry
    // the admin turned off deliberately.
    db.prepare('UPDATE faqs SET enabled = 1 WHERE question = ? AND answer = ?')
      .run('What is the PIN for locked categories (parental controls)?', V25_PIN);

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

    // Retired starter content: remove only when still the untouched default.
    db.prepare('DELETE FROM faqs WHERE question = ? AND answer = ?')
      .run('What is the service URL to log in with?', V22_URL_FAQ);
    db.prepare('DELETE FROM faqs WHERE question = ? AND answer = ?')
      .run("What's in the customer panel?", V25_PANEL_FAQ);

    const getGuide = db.prepare('SELECT * FROM guides WHERE slug = ?');
    STARTER_GUIDES.forEach((g, i) => {
      const row = getGuide.get(g.slug);
      if (!row) {
        insertGuide(g, i, t);
        return;
      }
      // Replace when the admin has not touched it: either the recorded hash
      // of what we seeded still matches, or it is an old install that still
      // carries the "edit me first" placeholder. An edited guide is their
      // work and is never overwritten — but it also never gets our fixes, so
      // the hash is re-recorded on every refresh to keep the chain going.
      const untouched = row.seed_hash
        ? row.seed_hash === seedHash(row.body_md)
        : row.body_md.includes(EDIT_MARKER);
      if (!untouched) return;
      db.prepare('UPDATE guides SET title = ?, body_md = ?, visible = ?, seed_hash = ?, updated_at = ? WHERE id = ?')
        .run(g.title, g.body_md, g.visible, seedHash(g.body_md), t, row.id);
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
    const tx = db.transaction(() => {
      STARTER_GUIDES.forEach((g, i) => insertGuide(g, i, t));
    });
    tx();
    console.log(`Seeded ${added} starter FAQs and ${STARTER_GUIDES.length} guides (guides with placeholders ship hidden — edit them in the panel, then make them visible).`);
  } else {
    upgradeStarterContent();
  }

  setSetting('seed.version', SEED_VERSION);
}
