import { db, now } from './db/db.js';
import { getSetting } from './settings.js';

// Scores, tables and race results — the questions customers were always going
// to ask a bot that sells them sport, and that it could only ever answer with
// "I don't have fixtures, check the guide".
//
// Two sources, deliberately different in how much they ask of the admin:
//   * F1 — Jolpica, the free successor to Ergast. No key, no account, no
//     rate limit worth worrying about. It works the moment the code lands.
//   * Football — football-data.org, which needs a free API key. Without one
//     the football half simply stays off and the bot says it has no scores,
//     exactly as it does today. It never guesses.
//
// Same discipline as the panel client next door: the request URL and the key
// never reach a log, an error string, a customer message or the AI prompt.
// Every error here is hand-written.

const TIMEOUT_MS = 8000;
const F1_BASE = 'https://api.jolpi.ca/ergast/f1';
const FOOTBALL_BASE = 'https://api.football-data.org/v4';

let lastError = null;
export const sportsLastError = () => lastError;

export const f1Enabled = () => getSetting('sports.f1Enabled') !== false;
export const footballKey = () => String(getSetting('sports.footballApiKey') || '').trim();
export const footballEnabled = () => footballKey().length > 8;
export const sportsEnabled = () => f1Enabled() || footballEnabled();

const cacheMinutes = () => Math.max(2, Number(getSetting('sports.cacheMinutes')) || 30);

// Cached in the database rather than in memory: the answers survive a restart,
// and a free API with a rate limit is not something to spend on every message.
function cached(key) {
  const row = db.prepare('SELECT body, fetched_at FROM sports_cache WHERE key = ?').get(key);
  if (!row) return null;
  if (now() - row.fetched_at > cacheMinutes() * 60) return null;
  try {
    return JSON.parse(row.body);
  } catch {
    return null;
  }
}

function store(key, body) {
  db.prepare(`INSERT INTO sports_cache (key, body, fetched_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`)
    .run(key, JSON.stringify(body), now());
}

// One fetch helper for both. `headers` carries the football key when there is
// one; it is never logged and never returned.
async function get(url, { headers = {}, label = 'the sports feed' } = {}) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json', ...headers },
    });
    if (res.status === 429) {
      lastError = `${label} is rate limiting us — try again shortly`;
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      lastError = `${label} rejected the API key`;
      return null;
    }
    if (!res.ok) {
      lastError = `${label} returned ${res.status}`;
      return null;
    }
    lastError = null;
    return await res.json();
  } catch (err) {
    lastError = /timeout|aborted/i.test(String(err.message))
      ? `${label} did not respond in time`
      : `could not reach ${label}`;
    return null;
  }
}

async function f1(path, key) {
  if (!f1Enabled()) return null;
  const hit = cached(key);
  if (hit) return hit;
  const data = await get(`${F1_BASE}/${path}`, { label: 'the F1 feed' });
  if (data) store(key, data);
  return data;
}

async function football(path, key) {
  if (!footballEnabled()) return null;
  const hit = cached(key);
  if (hit) return hit;
  const data = await get(`${FOOTBALL_BASE}/${path}`, {
    headers: { 'X-Auth-Token': footballKey() },
    label: 'the football feed',
  });
  if (data) store(key, data);
  return data;
}

// ---- F1 ---------------------------------------------------------------------

export async function f1DriverStandings() {
  const d = await f1('current/driverstandings/?format=json', 'f1:drivers');
  const list = d?.MRData?.StandingsTable?.StandingsLists?.[0];
  if (!list?.DriverStandings?.length) return null;
  return {
    round: list.round,
    season: list.season,
    rows: list.DriverStandings.map((s) => ({
      pos: Number(s.position),
      name: `${s.Driver.givenName} ${s.Driver.familyName}`,
      team: s.Constructors?.[0]?.name || '',
      points: Number(s.points),
      wins: Number(s.wins),
    })),
  };
}

export async function f1ConstructorStandings() {
  const d = await f1('current/constructorstandings/?format=json', 'f1:constructors');
  const list = d?.MRData?.StandingsTable?.StandingsLists?.[0];
  if (!list?.ConstructorStandings?.length) return null;
  return {
    season: list.season,
    rows: list.ConstructorStandings.map((s) => ({
      pos: Number(s.position),
      name: s.Constructor.name,
      points: Number(s.points),
      wins: Number(s.wins),
    })),
  };
}

export async function f1LastRace() {
  const d = await f1('current/last/results/?format=json', 'f1:last');
  const race = d?.MRData?.RaceTable?.Races?.[0];
  if (!race?.Results?.length) return null;
  return {
    name: race.raceName,
    circuit: race.Circuit?.circuitName || '',
    date: race.date,
    round: race.round,
    results: race.Results.map((r) => ({
      pos: Number(r.position),
      name: `${r.Driver.givenName} ${r.Driver.familyName}`,
      team: r.Constructor?.name || '',
      grid: Number(r.grid),
      status: r.status,
      time: r.Time?.time || null,
      points: Number(r.points),
      fastestLap: r.FastestLap?.rank === '1',
    })),
  };
}

export async function f1NextRace() {
  const d = await f1('current/next/?format=json', 'f1:next');
  const race = d?.MRData?.RaceTable?.Races?.[0];
  if (!race) return null;
  return {
    name: race.raceName,
    circuit: race.Circuit?.circuitName || '',
    date: race.date,
    time: race.time || null,
    round: race.round,
  };
}

// ---- football ---------------------------------------------------------------

// The competitions the admin cares about, as football-data codes.
// PL Premier League · ELC Championship · CL Champions League · PD La Liga
// SA Serie A · BL1 Bundesliga · FL1 Ligue 1
const COMP_NAMES = {
  PL: 'Premier League', ELC: 'Championship', CL: 'Champions League',
  PD: 'La Liga', SA: 'Serie A', BL1: 'Bundesliga', FL1: 'Ligue 1',
  DED: 'Eredivisie', PPL: 'Primeira Liga', EC: 'Euros', WC: 'World Cup',
};

export function competitions() {
  const raw = String(getSetting('sports.footballCompetitions') || 'PL')
    .split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
  return raw.filter((c) => COMP_NAMES[c]);
}

export const competitionName = (code) => COMP_NAMES[code] || code;

export async function footballStandings(code) {
  const d = await football(`competitions/${code}/standings`, `fb:table:${code}`);
  const table = d?.standings?.find((s) => s.type === 'TOTAL')?.table;
  if (!table?.length) return null;
  return {
    competition: d?.competition?.name || competitionName(code),
    rows: table.map((r) => ({
      pos: r.position,
      team: r.team?.shortName || r.team?.name || '',
      played: r.playedGames,
      won: r.won,
      drawn: r.draw,
      lost: r.lost,
      gd: r.goalDifference,
      points: r.points,
      form: r.form || '',
    })),
  };
}

// Finished matches in the last few days. Live scores are deliberately NOT
// offered: a score that is one API cache behind is worse than no score, and
// polling a free tier for them would burn the rate limit in an afternoon.
export async function footballResults(code, { days = 4 } = {}) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const d = await football(
    `competitions/${code}/matches?status=FINISHED&dateFrom=${iso(from)}&dateTo=${iso(to)}`,
    `fb:results:${code}:${iso(from)}`
  );
  if (!d?.matches?.length) return null;
  return {
    competition: d?.competition?.name || competitionName(code),
    matches: d.matches.map((m) => ({
      home: m.homeTeam?.shortName || m.homeTeam?.name || '',
      away: m.awayTeam?.shortName || m.awayTeam?.name || '',
      homeGoals: m.score?.fullTime?.home,
      awayGoals: m.score?.fullTime?.away,
      date: m.utcDate?.slice(0, 10) || '',
    })).filter((m) => m.homeGoals !== null && m.homeGoals !== undefined),
  };
}

// ---- is this even a sports question? ---------------------------------------

const F1_WORDS =
  /\bf1\b|formula\s?(?:1|one)\b|grand\s?prix\b|\bgp\b|\bquali(?:fying)?\b|\bpole\b|\bpodium\b|\bconstructors?\b|\bdrivers?\s+(?:championship|standings)\b|\b(?:verstappen|hamilton|norris|leclerc|piastri|russell|alonso|sainz|perez|hulkenberg|tsunoda|gasly|ocon|stroll|albon|bottas|antonelli|hadjar|bearman|colapinto|lawson)\b/i;

const FOOTBALL_WORDS =
  /\b(?:premier\s?league|prem\b|champions\s?league|championship|la\s?liga|serie\s?a|bundesliga|ligue\s?1|eredivisie|europa|efl|fa\s?cup)\b|\b(?:arsenal|liverpool|chelsea|spurs|tottenham|man\s?(?:utd|united|city)|newcastle|everton|villa|west\s?ham|leeds|wolves|brighton|forest|fulham|palace|brentford|bournemouth|burnley|sunderland|rangers|celtic|barcelona|real\s?madrid|bayern|psg|juventus|inter|milan)\b/i;

const RESULT_WORDS =
  /\b(?:score|scores|result|results|final\s?score|who\s+won|how\s+did[^.?!\n]{0,20}\s+(?:get\s+on|do)|full\s?time|ft\b|standings?|table|league\s?table|top\s+of\s+the|points?\b|position|where\s+are\b|how\s+many\s+points)\b/i;

const RACE_RESULT_WORDS =
  /\b(?:who\s+won|won|win|wins|result|results|finished|finish|podium|standings?|championship|points?|p\d\b|pole|fastest\s?lap|next\s+race|when\s+is|retired|crashed|dnf|leading|leads?)\b/i;

// "What channel is the F1 on?" is a question about OUR lineup, and the channel
// list already answers it properly. Sending it to a results feed would answer
// a question nobody asked.
const LINEUP_QUESTION =
  /\bwhat\s+channel\b|\bwhich\s+channel\b|\bwhat\s+number\b|\bis\s+(?:it|the\s+\w+)\s+on\b|\bon\s+what\b|\bshowing\s+on\b|\bwhere\s+(?:can|do)\s+i\s+watch\b|\bdo\s+(?:you|we)\s+have\b|\bhave\s+(?:you|we)\s+got\b/i;

export function looksLikeSportsQuestion(text) {
  const t = String(text || '');
  if (!t.trim() || t.length > 200) return false;
  if (LINEUP_QUESTION.test(t)) return false;
  if (F1_WORDS.test(t)) return RACE_RESULT_WORDS.test(t) || /\bf1\b|formula/i.test(t);
  if (FOOTBALL_WORDS.test(t)) return RESULT_WORDS.test(t);
  // "who won last night" with no sport named — only counts when something
  // else in the sentence says which.
  return false;
}

export const asksAboutF1 = (text) => F1_WORDS.test(String(text || ''));
export const asksAboutFootball = (text) => FOOTBALL_WORDS.test(String(text || ''));

// ---- the block handed to the model -----------------------------------------

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th';
  return `${n}${s}`;
};

function f1RaceLines(race) {
  const lines = [`${race.name} (round ${race.round}, ${race.date}) — final classification:`];
  for (const r of race.results.slice(0, 10)) {
    const moved = r.grid && r.grid !== r.pos
      ? ` [started ${ordinal(r.grid)}, ${r.grid > r.pos ? `gained ${r.grid - r.pos}` : `lost ${r.pos - r.grid}`}]`
      : '';
    const dnf = /^(?:Finished|\+\d)/.test(r.status) ? '' : ` [${r.status}]`;
    lines.push(`P${r.pos} ${r.name} (${r.team})${r.time ? ` ${r.time}` : ''}${moved}${dnf}${r.fastestLap ? ' [fastest lap]' : ''}`);
  }
  const dnfs = race.results.filter((r) => !/^(?:Finished|\+\d)/.test(r.status));
  if (dnfs.length) lines.push(`Did not finish: ${dnfs.map((d) => `${d.name} (${d.status})`).join(', ')}`);
  return lines;
}

// Everything the model is allowed to say, as facts. Nothing here is optional
// decoration: a position or a scoreline it did not get from this block is one
// it made up, and a customer who repeats an invented result in the group looks
// daft because of us.
export async function sportsGrounding(question) {
  if (!sportsEnabled()) return null;
  const q = String(question || '');
  const lines = [];

  if (f1Enabled() && asksAboutF1(q)) {
    const wantsStandings = /\bstandings?\b|\bchampionship\b|\btable\b|\bpoints?\b|\bleading\b|\btop\b/i.test(q);
    const wantsNext = /\bnext\b|\bwhen\b|\bupcoming\b/i.test(q);

    if (wantsNext) {
      const next = await f1NextRace().catch(() => null);
      if (next) lines.push(`Next race: ${next.name} at ${next.circuit}, ${next.date}${next.time ? ` ${next.time} UTC` : ''} (round ${next.round}).`);
    }
    if (!wantsNext || wantsStandings) {
      const race = await f1LastRace().catch(() => null);
      if (race) lines.push(...f1RaceLines(race));
    }
    if (wantsStandings || /\bchampionship\b/i.test(q)) {
      const drivers = await f1DriverStandings().catch(() => null);
      if (drivers) {
        lines.push('', `Drivers' championship after round ${drivers.round}:`);
        for (const d of drivers.rows.slice(0, 10)) lines.push(`${d.pos}. ${d.name} (${d.team}) — ${d.points} pts${d.wins ? `, ${d.wins} win${d.wins === 1 ? '' : 's'}` : ''}`);
      }
      const teams = await f1ConstructorStandings().catch(() => null);
      if (teams) {
        lines.push('', "Constructors' championship:");
        for (const t of teams.rows.slice(0, 6)) lines.push(`${t.pos}. ${t.name} — ${t.points} pts`);
      }
    }
  }

  if (footballEnabled() && asksAboutFootball(q)) {
    const wantsTable = /\btable\b|\bstandings?\b|\bposition\b|\bpoints?\b|\btop\b|\bbottom\b/i.test(q);
    for (const code of competitions()) {
      // Only the competitions whose name or a team in them was asked about,
      // unless they asked generally — otherwise every question drags four
      // tables into the prompt.
      if (wantsTable) {
        const table = await footballStandings(code).catch(() => null);
        if (table) {
          lines.push('', `${table.competition} table:`);
          for (const r of table.rows.slice(0, 10)) {
            lines.push(`${r.pos}. ${r.team} — ${r.points} pts (P${r.played} W${r.won} D${r.drawn} L${r.lost}, GD ${r.gd > 0 ? '+' : ''}${r.gd})`);
          }
        }
      } else {
        const res = await footballResults(code).catch(() => null);
        if (res?.matches?.length) {
          lines.push('', `${res.competition} — recent final scores:`);
          for (const m of res.matches.slice(0, 12)) lines.push(`${m.home} ${m.homeGoals}-${m.awayGoals} ${m.away} (${m.date})`);
        }
      }
    }
  }

  if (!lines.length) return null;
  return lines.join('\n');
}

// Stats for the admin panel.
export function sportsCacheStats() {
  const row = db.prepare('SELECT COUNT(*) n, MAX(fetched_at) last FROM sports_cache').get();
  return { entries: row?.n || 0, lastFetch: row?.last || null };
}

export function clearSportsCache() {
  db.prepare('DELETE FROM sports_cache').run();
}
