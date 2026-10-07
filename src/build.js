import { execFileSync } from 'node:child_process';
import { config } from './config.js';

// "Is what's running the latest?" is two separate questions: what IS running,
// and what's available. The first is free and never changes while the process
// lives. The second costs a network round trip, so it is cached and only
// refreshed on demand.
//
// SECURITY: the install writes the GitHub PAT into the remote URL
// (https://user:TOKEN@github.com/...). Nothing here may surface git's remote
// output — no `git remote -v`, no raw stderr — or the token ends up in a
// Telegram message.

const git = (args, timeout = 5000) =>
  execFileSync('git', args, {
    cwd: config.rootDir,
    timeout,
    stdio: ['ignore', 'pipe', 'ignore'], // stderr dropped: it can carry the remote URL
  }).toString().trim();

const tryGit = (args, timeout) => {
  try {
    return git(args, timeout);
  } catch {
    return null;
  }
};

let cachedLocal = null;

export function localBuild() {
  if (cachedLocal) return cachedLocal;
  const commit = tryGit(['log', '-1', '--format=%h']);
  cachedLocal = {
    commit,
    date: tryGit(['log', '-1', '--format=%cd', '--date=format:%d %b %Y %H:%M']),
    subject: tryGit(['log', '-1', '--format=%s']),
    branch: tryGit(['rev-parse', '--abbrev-ref', 'HEAD']),
    // Uncommitted edits on the server mean the next auto-update will throw
    // them away (the startup script does a hard reset), which is worth saying.
    dirty: Boolean(tryGit(['status', '--porcelain'])),
    isGit: Boolean(commit),
  };
  return cachedLocal;
}

let cachedRemote = { at: 0, result: null };
const REMOTE_TTL_MS = 5 * 60 * 1000;

// Returns { behind, ahead, error } — behind is how many commits exist upstream
// that this server does not have. Never throws.
export async function updateCheck({ force = false } = {}) {
  if (!force && cachedRemote.result && Date.now() - cachedRemote.at < REMOTE_TTL_MS) {
    return cachedRemote.result;
  }
  const local = localBuild();
  if (!local.isGit) {
    return { error: 'not-a-git-checkout' };
  }
  const branch = local.branch && local.branch !== 'HEAD' ? local.branch : null;
  if (!branch) return { error: 'detached-head' };

  // A fetch is the only way to know. Failure here is normal and expected —
  // no network, no credentials, a shallow clone — so it is reported, not thrown.
  const fetched = tryGit(['fetch', '--quiet', 'origin', branch], 20000) !== null;
  if (!fetched) {
    const result = { error: 'fetch-failed' };
    cachedRemote = { at: Date.now(), result };
    return result;
  }

  const counts = tryGit(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
  if (!counts) {
    const result = { error: 'compare-failed' };
    cachedRemote = { at: Date.now(), result };
    return result;
  }
  const [ahead, behind] = counts.split(/\s+/).map(Number);
  const result = {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
    latest: tryGit(['log', '-1', '--format=%h %s', `origin/${branch}`]),
  };
  cachedRemote = { at: Date.now(), result };
  return result;
}

const FAILURE_HINTS = {
  'not-a-git-checkout': "This server wasn't installed from git, so there's nothing to compare against.",
  'detached-head': 'This checkout is not on a branch, so there is no upstream to compare against.',
  'fetch-failed': "Couldn't reach GitHub to check — no network from the container, or the access token has expired.",
  'compare-failed': "Couldn't compare against the branch (a shallow clone can cause this).",
};

// One human-readable answer to "am I up to date?", used by the bot and panel.
export function describeUpdate(local, remote) {
  if (!local.isGit) return FAILURE_HINTS['not-a-git-checkout'];
  if (remote?.error) return FAILURE_HINTS[remote.error] || 'Update check unavailable.';
  if (remote.behind === 0) return "✅ Up to date — this is the latest commit on the branch.";

  const n = remote.behind;
  const restart = config.autoUpdate
    ? 'Restart the server and it will pull them automatically.'
    : 'Auto-update is OFF for this server, so a restart will NOT pull them — turn on the auto-update variable in the Startup tab, or update manually.';
  return `⚠️ ${n} newer commit${n > 1 ? 's' : ''} available.\n${remote.latest ? `Latest: ${remote.latest}\n` : ''}${restart}`;
}

// ---- applying an update -----------------------------------------------------
// Pulls the branch this server was installed from and reinstalls dependencies
// when the lockfile moved. Deliberately does NOT restart: the new code only
// runs after a restart, and bringing the bot down is the caller's decision to
// confirm, not a side effect of asking for an update.
export async function applyUpdate() {
  const local = localBuild();
  if (!local.isGit) return { ok: false, message: FAILURE_HINTS['not-a-git-checkout'] };
  const branch = local.branch && local.branch !== 'HEAD' ? local.branch : null;
  if (!branch) return { ok: false, message: FAILURE_HINTS['detached-head'] };

  if (tryGit(['fetch', '--quiet', 'origin', branch], 60000) === null) {
    return { ok: false, message: FAILURE_HINTS['fetch-failed'] };
  }

  const before = tryGit(['rev-parse', 'HEAD']);
  const target = tryGit(['rev-parse', `origin/${branch}`]);
  if (!before || !target) return { ok: false, message: FAILURE_HINTS['compare-failed'] };
  if (before === target) return { ok: true, changed: false, message: '✅ Already on the latest commit — nothing to pull.' };

  const changes = tryGit(['log', '--format=%h %s', `HEAD..origin/${branch}`]) || '';
  // Read the lockfile id from both sides BEFORE moving, so we know whether
  // dependencies actually changed rather than reinstalling every time.
  const lockBefore = tryGit(['rev-parse', 'HEAD:package-lock.json']);
  const lockAfter = tryGit(['rev-parse', `origin/${branch}:package-lock.json`]);

  if (tryGit(['reset', '--hard', target], 60000) === null) {
    return { ok: false, message: 'Could not apply the update — git refused to move the checkout.' };
  }
  cachedLocal = null; // the running build has changed on disk
  cachedRemote = { at: 0, result: null };

  let deps = 'unchanged';
  if (lockBefore !== lockAfter) {
    try {
      execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: config.rootDir, timeout: 10 * 60 * 1000, stdio: ['ignore', 'ignore', 'ignore'],
      });
      deps = 'reinstalled';
    } catch {
      // The pull succeeded, so say so plainly rather than implying it failed —
      // but a restart now would run new code against old dependencies.
      deps = 'FAILED';
    }
  }

  const lines = changes.split('\n').filter(Boolean);
  return {
    ok: true,
    changed: true,
    deps,
    count: lines.length,
    commits: lines,
    from: before.slice(0, 7),
    to: target.slice(0, 7),
  };
}
