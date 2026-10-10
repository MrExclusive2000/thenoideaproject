// The admin panel's menu, written down once.
//
// It used to be eighteen hand-written links in the sidebar template, each
// carrying its own `path.startsWith(...)` ternary to decide whether it was the
// current page. Adding a page meant editing the template, picking a group by
// eye, and getting the prefix test right — and nothing else in the panel knew
// the menu existed, so the heading at the top of each page, the sidebar and
// any "where do I change X?" answer were three separate descriptions of the
// same panel, free to drift apart.
//
// Grouping is by the job the admin is doing, not by which table the page
// reads. "Inbox" is everything with a number next to it that wants dealing
// with; "Settings" is everything you set once and forget. The blurbs are
// here rather than in the templates because the settings index renders them
// too, and one sentence per page is the whole point of that page.
export const NAV = [
  {
    group: 'Inbox',
    items: [
      { href: '/admin', label: 'Dashboard', exact: true, blurb: 'Bot health, today’s numbers, and anything half-finished in the setup.' },
      { href: '/admin/problems', label: 'Problem reports', count: 'problems', blurb: 'What customers said was broken, newest first.' },
      { href: '/admin/requests', label: 'VOD requests', count: 'requests', blurb: 'Films and series people have asked for.' },
      { href: '/admin/unanswered', label: 'Unanswered', count: 'unanswered', blurb: 'Questions the bot could not answer — the list your knowledge is missing.' },
      { href: '/admin/conversations', label: 'Conversations', blurb: 'Every message the bot can see, threaded, searchable, exportable.' },
    ],
  },
  {
    group: 'What the bot knows',
    items: [
      { href: '/admin/faqs', label: 'Knowledge', count: 'knowledge', blurb: 'The facts the AI answers from, plus entries it has drafted for you to approve.' },
      { href: '/admin/guides', label: 'Guides', blurb: 'Longer setup and troubleshooting write-ups. Visible ones are read by the AI.' },
      { href: '/admin/files', label: 'Downloads', blurb: 'The app builds /download hands out, and the short codes for the Downloader app.' },
    ],
  },
  {
    group: 'Customers',
    items: [
      { href: '/admin/customers', label: 'Customers', count: 'expiring', blurb: 'Who is on the service, when they expire, which Telegram account is theirs.' },
      { href: '/admin/broadcasts', label: 'Broadcasts', blurb: 'Announce something to every connected chat, now or on a schedule.' },
    ],
  },
  {
    group: 'Settings',
    items: [
      { href: '/admin/settings', label: 'All settings', exact: true, blurb: 'Every settings page in one list, with what each one is for.' },
      { href: '/admin/bot', label: 'Bot settings', blurb: 'Where the bot answers, what it says, its tone, and the lines it never improvises.' },
      { href: '/admin/ai', label: 'AI settings', blurb: 'Which model answers, how hard it tries, and the daily spend cap.' },
      { href: '/admin/reports', label: 'Reports & status', blurb: 'What gets DMed to you, the daily digest, and the service status customers see.' },
      { href: '/admin/system', label: 'Branding & backup', blurb: 'Name, colour, logo, database size, backups and updates.' },
    ],
  },
  {
    group: 'Your account',
    items: [
      { href: '/admin/admins', label: 'Admins', blurb: 'Who else can get into this panel.' },
      { href: '/admin/audit', label: 'Audit log', blurb: 'Every admin action, login and download, with a timestamp.' },
      { href: '/admin/password', label: 'Password & 2FA', blurb: 'Change your own password and turn on two-factor.' },
    ],
  },
];

// `/admin` must match only itself, or it would be the current page
// everywhere. Everything else owns its sub-paths: /admin/faqs/review is
// still Knowledge, /admin/customers/12 is still Customers.
function isCurrent(item, path) {
  return item.exact ? path === item.href : path === item.href || path.startsWith(`${item.href}/`);
}

// The menu as the sidebar renders it: counts resolved, current page marked.
export function navGroups(path, counts = {}) {
  return NAV.map((g) => ({
    group: g.group,
    items: g.items.map((item) => ({
      ...item,
      current: isCurrent(item, path),
      badge: item.count ? Number(counts[item.count]) || 0 : 0,
    })),
  }));
}

// What to call the page at the top of the screen. Falls back to the page's
// own title for the handful of pages that are not in the menu (editing one
// guide, reviewing knowledge), where the title is more specific anyway.
export function sectionFor(path) {
  for (const g of NAV) {
    for (const item of g.items) if (isCurrent(item, path)) return item.label;
  }
  return '';
}

// Only the groups worth an index page of their own.
export function navGroup(name) {
  return NAV.find((g) => g.group === name) || { group: name, items: [] };
}
