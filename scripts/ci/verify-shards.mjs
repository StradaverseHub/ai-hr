// Checks that the CI shards, together, ran every suite file exactly once and every one passed.
// Usage: node scripts/ci/verify-shards.mjs <report-dir> <shard-count>
// Each shard writes vitest's JSON report as shard-<n>.json. The suite is what vitest.config.ts includes:
// test/**/*.test.ts (node project) and test/**/*.dom.test.tsx (dom project).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const [dir, countArg] = process.argv.slice(2);
const shards = Number(countArg);
if (!dir || !Number.isInteger(shards) || shards < 1) {
  console.error('usage: verify-shards.mjs <report-dir> <shard-count>');
  process.exit(2);
}

function walk(d) {
  return readdirSync(d).flatMap((name) => {
    const p = join(d, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const suite = new Set(walk('test').filter((p) => /\.test\.ts$/.test(p) || /\.dom\.test\.tsx$/.test(p)));
const problems = [];
const seen = new Map();

for (let n = 1; n <= shards; n++) {
  let report;
  try {
    report = JSON.parse(readFileSync(join(dir, `shard-${n}.json`), 'utf8'));
  } catch (e) {
    problems.push(`shard ${n}: no readable report (${e.message})`);
    continue;
  }
  for (const r of report.testResults ?? []) {
    const file = relative(process.cwd(), r.name);
    seen.set(file, (seen.get(file) ?? 0) + 1);
    if (r.status !== 'passed') problems.push(`shard ${n}: ${file} ${r.status}`);
  }
}

for (const [file, times] of seen) {
  if (times > 1) problems.push(`ran ${times} times: ${file}`);
  if (!suite.has(file)) problems.push(`ran but is not a suite file: ${file}`);
}
// Listed last: when a whole shard is missing these run to hundreds and would hide the lines above.
const neverRan = [...suite].filter((file) => !seen.has(file));
if (neverRan.length) problems.push(`${neverRan.length} suite files never ran, e.g. ${neverRan.slice(0, 5).join(', ')}`);

console.log(`suite files: ${suite.size}  reported: ${seen.size}  shards: ${shards}`);
if (problems.length) {
  for (const p of problems.slice(0, 50)) console.log('  ✗ ' + p);
  if (problems.length > 50) console.log(`  … and ${problems.length - 50} more`);
  process.exit(1);
}
console.log('  ✓ every suite file ran exactly once and passed');
