// Compares the migration journal against a base commit (the PR base, or the previous main).
// test/migration-journal-ordering.test.ts checks the journal on its own; this checks it against what
// production may already have applied. drizzle skips, with exit 0, any entry whose `when` is below the
// last one applied — so a merge that slots a new entry in among existing ones passes the in-file check
// and still never runs in production.
// Usage: node scripts/ci/check-migration-order.mjs <base-commit>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const JOURNAL = 'db/migrations/meta/_journal.json';
const base = process.argv[2];
if (!base || /^0+$/.test(base)) {
  console.log('no base commit (new branch or first push): nothing to compare');
  process.exit(0);
}

let before;
try {
  before = JSON.parse(execFileSync('git', ['show', `${base}:${JOURNAL}`], { encoding: 'utf8' })).entries;
} catch (e) {
  console.error(`cannot read ${JOURNAL} at ${base}: ${e.message}`);
  process.exit(1);
}
const after = JSON.parse(readFileSync(process.env.JOURNAL_PATH ?? JOURNAL, 'utf8')).entries;
const problems = [];

// Every entry already on the base keeps its place: none removed, none moved, none edited.
before.forEach((b, i) => {
  const a = after[i];
  if (!a || a.tag !== b.tag || a.when !== b.when || a.idx !== b.idx) {
    problems.push(`entry ${i} changed: base has ${b.tag} (idx ${b.idx}, when ${b.when}), now ${a ? `${a.tag} (idx ${a.idx}, when ${a.when})` : 'missing'}`);
  }
});

// Every new entry sorts after everything the base already had.
const maxWhen = Math.max(...before.map((e) => e.when));
const maxIdx = Math.max(...before.map((e) => e.idx));
for (const a of after.slice(before.length)) {
  if (a.when <= maxWhen) problems.push(`new ${a.tag}: when ${a.when} is not above the base maximum ${maxWhen}`);
  if (a.idx <= maxIdx) problems.push(`new ${a.tag}: idx ${a.idx} is not above the base maximum ${maxIdx}`);
}

console.log(`journal: ${before.length} entries at base, ${after.length} now`);
if (problems.length) {
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('  ✓ existing entries unchanged; new entries sort after them');
