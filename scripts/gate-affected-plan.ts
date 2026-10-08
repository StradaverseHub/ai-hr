/**
 * r417 (ADR-0094) — WHICH TESTS THE AFFECTED TIER RUNS. Called by scripts/gate-affected.sh, under the
 * test lock, only after scripts/gate-tier.ts has said the diff is presentational.
 *
 *   node --import tsx scripts/gate-affected-plan.ts <changed-files.json> <out-plan.json>
 *
 * The set is the union of:
 *   (i)   `vitest related` over the changed non-test files — vitest's own import graph, read through its
 *         node API so the list is known BEFORE anything runs (that is what lets the script decide whether
 *         a cluster rebuild is needed, and count what it asked for);
 *   (ii)  every test file whose SOURCE TEXT mentions a changed file's repo path, or its basename without
 *         the extension, as a whole word (`git grep -lwF`) — the many guards that read source with fs
 *         are invisible to (i);
 *   (iii) the repo-sweeping guards, by NAME: the fixed list in ALWAYS_RUN plus every *pack-drift* file and
 *         every test whose name ends in -guard or -drift. A glob, so a new guard joins without an edit;
 *   plus every changed test file itself.
 * Browser tests (`*.browser.test.tsx`) are not in this set: (iv) runs the whole `pnpm test:browser`
 * project whenever a .tsx or .css file changed, and the plan says so.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { classifyTestFiles } from './gate-db-classify';

/** Named guards that sweep the repo. Matched as a file-name prefix under test/. */
export const ALWAYS_RUN = [
  'function-access',
  'i18n-coverage',
  'server-client-boundary',
  'rsc-boundary-guard',
  'r394-route-loading',
  'module-catalog-drift',
  'topbar-overlap-guard',
  'today-in-myt-drift',
] as const;

export function isTestFile(p: string): boolean {
  return /^test\/.+\.test\.ts$/.test(p) || /^test\/.+\.dom\.test\.tsx$/.test(p);
}

/** (iii): the always-run guards, out of the suite's file list. */
export function guardFiles(all: string[]): string[] {
  return all.filter((f) => {
    const name = basename(f);
    if (ALWAYS_RUN.some((g) => name === `${g}.test.ts` || name.startsWith(`${g}.`) || name.startsWith(`${g}-`))) return true;
    if (name.includes('pack-drift')) return true;
    return /-(guard|drift)\.(dom\.)?test\.tsx?$/.test(name);
  });
}

/** (ii): the strings a test would mention to read one changed file. */
export function grepPatterns(path: string): string[] {
  const noExt = path.replace(/\.[^./]+$/, '');
  const base = basename(noExt);
  return [...new Set([path, noExt, base])].filter((s) => s.length > 0);
}

export function needsBrowser(changed: string[]): boolean {
  return changed.some((p) => p.endsWith('.tsx') || p.endsWith('.css'));
}

function suiteFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'test'], { encoding: 'utf8' });
  return out.split('\n').filter(isTestFile).sort();
}

function grepTests(patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  const args = ['grep', '-l', '-w', '-F'];
  for (const p of patterns) args.push('-e', p);
  args.push('--', 'test/*.test.ts', 'test/*.dom.test.tsx');
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  } catch (e) {
    // git grep exits 1 when nothing matches — that is an empty answer, not a failure.
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

async function relatedTests(sources: string[]): Promise<string[]> {
  if (sources.length === 0) return [];
  const root = process.cwd();
  const { createVitest } = await import('vitest/node');
  const ctx = await createVitest('test', {
    run: true,
    watch: false,
    related: sources.map((s) => resolve(root, s)),
    passWithNoTests: true,
  });
  try {
    const specs = await ctx.getRelevantTestSpecifications();
    return [...new Set(specs.map((s) => relative(root, s.moduleId)))].filter(isTestFile).sort();
  } finally {
    await ctx.close();
  }
}

async function main(): Promise<void> {
  const [inFile, outFile] = process.argv.slice(2);
  if (!inFile || !outFile) {
    console.error('usage: gate-affected-plan.ts <changed-files.json> <out-plan.json>');
    process.exit(2);
  }
  const changedJson = JSON.parse(readFileSync(inFile, 'utf8')) as { files: { path: string; status: string }[] };
  const changed = changedJson.files.map((f) => f.path);
  const present = changedJson.files.filter((f) => f.status !== 'D').map((f) => f.path);

  const all = suiteFiles();
  const changedTests = present.filter(isTestFile);
  const sources = present.filter((p) => !isTestFile(p) && !p.endsWith('.browser.test.tsx'));

  const related = await relatedTests(sources);
  const grepped = grepTests(changed.flatMap(grepPatterns));
  const guards = guardFiles(all);

  const allSet = new Set(all);
  const run = [...new Set([...changedTests, ...related, ...grepped, ...guards])].filter((f) => allSet.has(f)).sort();

  const read = (p: string): string | null => {
    try {
      return statSync(p).isFile() ? readFileSync(p, 'utf8') : null;
    } catch {
      return null;
    }
  };
  const { db, nodb } = classifyTestFiles(run, read);

  const plan = {
    changed,
    sources,
    changedTests,
    related,
    grepped,
    guards,
    run,
    db,
    nodb,
    browser: needsBrowser(changed),
  };
  writeFileSync(outFile, JSON.stringify(plan, null, 2));
  console.log(
    `▸ affected set: ${run.length} file(s) — related ${related.length}, source-text mentions ${grepped.length}, ` +
      `guards ${guards.length}, changed tests ${changedTests.length}; ${nodb.length} no-DB + ${db.length} DB; ` +
      `browser project: ${plan.browser ? 'yes' : 'no'}`,
  );
}

if (process.argv[1] && /gate-affected-plan\.ts$/.test(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
