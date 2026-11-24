/**
 * Refuses a migration whose number, journal idx or `when` another branch already uses (ADR 0181 follow-up).
 *
 * check-migration-order.mjs proves one branch's journal is append-only against its own base. It cannot see a
 * parallel branch. On 24 and 25 November 2026 two pairs of branches reserved the same slot (7210, then 7260) with
 * identical idx and `when`. Whichever installed first would have made drizzle silently skip the other, because a
 * `when` that is not above the applied watermark is never run.
 *
 * Rules for every entry this branch adds on top of main:
 *   1. Its number, idx and `when` are unused on main.
 *   2. Its `when` is above main's highest `when`, or an installation that already has main would skip it.
 *   3. Its number, idx and `when` are unused by any other open pull request's added entries. When two open PRs
 *      collide, the one opened later fails and the earlier one gets a warning, so they never block each other.
 * The same tag on two branches (a stacked PR) is the same migration and is not a collision.
 *
 *   node .github/ci/check-migration-collisions.mjs --ci              # pull_request workflow (GitHub API)
 *   node .github/ci/check-migration-collisions.mjs --local [--next] [--days 14]  # before reserving: main + the
 *     400 most recently updated remote branches within --days
 */
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const JOURNAL = 'db/migrations/meta/_journal.json';

export const migrationNumber = tag => {
  const match = /^(\d+)_/.exec(String(tag));
  return match ? Number(match[1]) : null;
};

const describe = entry => `${entry.tag} (idx ${entry.idx}, when ${entry.when})`;

function clash(a, b) {
  if (a.tag === b.tag) return null;
  const why = [];
  if (migrationNumber(a.tag) !== null && migrationNumber(a.tag) === migrationNumber(b.tag)) why.push('number');
  if (a.idx === b.idx) why.push('idx');
  if (a.when === b.when) why.push('when');
  return why.length ? why.join(', ') : null;
}

/** Entries of `entries` that main does not have, by tag. */
export function addedEntries(base, entries) {
  const known = new Set(base.map(entry => entry.tag));
  return entries.filter(entry => !known.has(entry.tag));
}

/**
 * @param {{base: object[], mine: object[], mineOpenedAt?: string|null,
 *          others: {ref: string, openedAt?: string|null, entries: object[]}[]}} input
 *   `openedAt` is an ISO time. An `other` without one (a branch with no PR) is treated as earlier, so the
 *   caller fails: a branch that only exists locally has not reserved anything yet.
 */
export function migrationCollisions({base, mine, mineOpenedAt = null, others = []}) {
  const errors = [], warnings = [];
  const added = addedEntries(base, mine);
  const highestWhen = base.reduce((top, entry) => Math.max(top, entry.when), -1);
  for (const entry of added) {
    for (const existing of base) {
      const why = clash(entry, existing);
      if (why) errors.push(`${describe(entry)} reuses the ${why} of ${describe(existing)} on main. Renumber above main.`);
    }
    if (entry.when <= highestWhen)
      errors.push(`${describe(entry)} has a \`when\` at or below main's highest (${highestWhen}). An installation that already has main would skip it. Renumber above main.`);
    for (const other of others) {
      for (const theirs of addedEntries(base, other.entries)) {
        const why = clash(entry, theirs);
        if (!why) continue;
        const theyAreEarlier = !mineOpenedAt || !other.openedAt || other.openedAt <= mineOpenedAt;
        const message = `${describe(entry)} reuses the ${why} of ${describe(theirs)} on ${other.ref}`;
        if (theyAreEarlier) errors.push(`${message}, which reserved it first. Renumber this branch.`);
        else warnings.push(`${message}, opened later. That branch must renumber.`);
      }
    }
  }
  return {added, errors, warnings};
}

/** A suggested next free slot above everything seen. Record it in docs/MIGRATION-ALLOCATION.md before use. */
export function nextFreeSlot(journals) {
  // Loops, not spreads: a local scan can hold hundreds of journals of over a thousand entries each.
  let top = {when: -1, idx: -1, tag: ''}, highestNumber = 0, highestIdx = -1;
  for (const journal of journals) for (const entry of journal) {
    if (entry.when > top.when) top = entry;
    highestNumber = Math.max(highestNumber, migrationNumber(entry.tag) ?? 0);
    highestIdx = Math.max(highestIdx, entry.idx);
  }
  const number = (Math.floor(highestNumber / 10) + 1) * 10;
  return {number, idx: Math.floor(highestIdx / 10) * 10 + 10, when: top.when + (number - highestNumber), after: top.tag};
}

const entriesOf = text => {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.entries)) throw new Error('Journal has no entries array');
  return parsed.entries.map(({idx, when, tag}) => ({idx, when, tag}));
};

async function github(path, token, accept = 'application/vnd.github+json') {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {Accept: accept, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28'},
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return accept.endsWith('raw') ? response.text() : response.json();
}

async function ciInputs() {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  const self = Number(process.env.PR_NUMBER), baseRef = process.env.BASE_REF || 'main';
  if (!token || !repo || !Number.isSafeInteger(self)) throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are required');
  const raw = ref => github(`/repos/${repo}/contents/${JOURNAL}?ref=${encodeURIComponent(ref)}`, token, 'application/vnd.github.raw');
  const base = entriesOf(await raw(baseRef));
  const pulls = [];
  for (let page = 1; ; page++) {
    const batch = await github(`/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, token);
    pulls.push(...batch);
    if (batch.length < 100) break;
  }
  const mine = pulls.find(pull => pull.number === self);
  const others = [];
  for (const pull of pulls) {
    if (pull.number === self || pull.base.ref !== baseRef) continue;
    const text = await raw(pull.head.sha);
    if (text) others.push({ref: `#${pull.number} (${pull.head.ref})`, openedAt: pull.created_at, entries: entriesOf(text)});
  }
  return {base, mine: entriesOf(readFileSync(JOURNAL, 'utf8')), mineOpenedAt: mine?.created_at ?? process.env.PR_CREATED_AT ?? null, others};
}

function localInputs(days) {
  const git = (...args) => execFileSync('git', args, {encoding: 'utf8', maxBuffer: 64 * 1024 ** 2});
  git('fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*');
  const base = entriesOf(git('show', `origin/main:${JOURNAL}`));
  const since = Date.now() / 1000 - days * 86400, current = git('rev-parse', 'HEAD').trim();
  const others = [];
  for (const line of git('for-each-ref', '--sort=-committerdate', '--count=400', '--format=%(refname:short) %(objectname) %(committerdate:unix)', 'refs/remotes/origin').trim().split('\n')) {
    const [ref, sha, at] = line.split(' ');
    if (!ref || ref === 'origin/HEAD' || ref === 'origin/main' || sha === current || Number(at) < since) continue;
    try { others.push({ref, openedAt: null, entries: entriesOf(git('show', `${sha}:${JOURNAL}`))}); } catch { /* no journal */ }
  }
  return {base, mine: entriesOf(readFileSync(JOURNAL, 'utf8')), mineOpenedAt: null, others};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const days = Number(args[args.indexOf('--days') + 1]) || 14;
  const input = args.includes('--ci') ? await ciInputs() : localInputs(days);
  const {added, errors, warnings} = migrationCollisions(input);
  console.log(`Checked ${added.length} added migration(s) against main and ${input.others.length} other ${args.includes('--ci') ? 'open pull request' : 'recent branch'} journal(s).`);
  for (const warning of warnings) console.log(`warning: ${warning}`);
  for (const error of errors) console.error(`error: ${error}`);
  if (args.includes('--next')) {
    const next = nextFreeSlot([input.base, input.mine, ...input.others.map(other => other.entries)]);
    console.log(`Next free slot: ${next.number}_<name>, idx ${next.idx}, when ${next.when} (after ${next.after}). Record it in docs/MIGRATION-ALLOCATION.md before use.`);
  }
  process.exit(errors.length ? 1 : 0);
}
