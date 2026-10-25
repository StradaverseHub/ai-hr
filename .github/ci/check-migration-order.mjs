/** Append-only journal AND applied SQL bytes, compared to the PR's base commit. */
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
const JOURNAL = 'db/migrations/meta/_journal.json';
export function migrationProblems(before, after, previousSql, currentSql) {
  const problems = [];
  if (!Array.isArray(before) || !Array.isArray(after)) return ['Missing migration entries'];
  const tags = new Set(); let lastWhen = Math.max(-1, ...before.map(e => e.when)), lastIdx = Math.max(-1, ...before.map(e => e.idx));
  for (const [i, entry] of after.entries()) {
    if (!entry || !/^[a-zA-Z0-9_-]+$/.test(entry.tag) || tags.has(entry.tag) ||
        !Number.isSafeInteger(entry.when) || entry.when < 0 ||
        !Number.isSafeInteger(entry.idx) || entry.idx < 0 ||
        (i >= before.length && (entry.when <= lastWhen || entry.idx <= lastIdx))) {
      problems.push(`Invalid, duplicate or non-increasing migration entry ${i}`); continue;
    }
    tags.add(entry.tag); if (i >= before.length) { lastWhen = entry.when; lastIdx = entry.idx; }
    try {
      if (!currentSql(entry.tag).length) problems.push(`Empty SQL: ${entry.tag}`);
      if (i < before.length && !Buffer.from(previousSql(entry.tag)).equals(Buffer.from(currentSql(entry.tag)))) problems.push(`Applied SQL changed: ${entry.tag}`);
    } catch { problems.push(`Missing SQL: ${entry.tag}`); }
  }
  before.forEach((entry, i) => { if (!isDeepStrictEqual(entry, after[i])) problems.push(`Applied journal entry changed at index ${i}`); });
  return problems;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  if (!base || /^0+$/.test(base)) throw Error('An existing base commit is required');
  // Resolve a commit first, so untrusted ref text cannot become an option to git show.
  const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', base + '^{commit}'], {encoding:'utf8'}).trim();
  const previous = path => execFileSync('git', ['show', `${commit}:${path}`]);
  const before = JSON.parse(previous(JOURNAL).toString()).entries, after = JSON.parse(readFileSync(JOURNAL, 'utf8')).entries;
  const path = tag => `db/migrations/${tag}.sql`;
  const problems = migrationProblems(before, after, tag => previous(path(tag)), tag => readFileSync(path(tag)));
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
  else console.log(`Journal ${before.length} -> ${after.length}: existing entries and SQL unchanged; additions strictly increasing`);
}
