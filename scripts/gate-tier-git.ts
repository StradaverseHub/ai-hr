/**
 * r417 (ADR-0094) — collect a diff from git for the pure tier classifier in scripts/gate-tier.ts.
 *
 *   node --import tsx scripts/gate-tier-git.ts <base> [--json <out.json>]
 *
 * Prints the verdict. Exit 0 = the affected tier is allowed, 3 = FULL GATE REQUIRED, 2 = could not
 * compute (bad ref, not a repo) — which callers must also treat as "full".
 *
 * The diff is `git diff BASE...HEAD` (three dots: against the merge base, so commits that landed on the
 * base side after the fork are not counted as ours) with --no-renames, so a rename is judged as the
 * delete of its old path AND the add of its new one.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { classifyChanges, describeVerdict, type ChangedFile, type TierVerdict } from './gate-tier';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function show(cwd: string, rev: string, path: string): string | null {
  try {
    const t = git(cwd, ['show', `${rev}:${path}`]);
    return t.includes('\u0000') ? null : t;
  } catch {
    return null;
  }
}

/** The changed files between `base` and `head`, with everything gate-tier.ts needs to judge them. */
export function collectChanges(base: string, head = 'HEAD', cwd = process.cwd()): ChangedFile[] {
  const mergeBase = git(cwd, ['merge-base', base, head]).trim();
  const nameStatus = git(cwd, ['diff', '--name-status', '--no-renames', `${base}...${head}`]).trim();
  if (!nameStatus) return [];
  return nameStatus.split('\n').map((line) => {
    const [status, ...rest] = line.split('\t');
    const path = rest.join('\t');
    const patch = git(cwd, ['diff', '--no-renames', '--no-color', '-U0', `${base}...${head}`, '--', path]);
    const diffLines = patch
      .split('\n')
      .filter((l) => (l.startsWith('+') && !l.startsWith('+++ ')) || (l.startsWith('-') && !l.startsWith('--- ')))
      .map((l) => l.slice(1));
    return {
      path,
      status: status ?? '?',
      diffLines,
      headText: status === 'D' ? null : show(cwd, head, path),
      baseText: status === 'A' ? null : show(cwd, mergeBase, path),
    };
  });
}

export function tierFor(base: string, head = 'HEAD', cwd = process.cwd()): { verdict: TierVerdict; changes: ChangedFile[] } {
  const changes = collectChanges(base, head, cwd);
  return { verdict: classifyChanges(changes), changes };
}

function main(): void {
  const base = process.argv[2];
  if (!base) {
    console.error('usage: gate-tier-git.ts <base-ref> [--json <out.json>]');
    process.exit(2);
  }
  const ji = process.argv.indexOf('--json');
  let result: ReturnType<typeof tierFor>;
  try {
    result = tierFor(base);
  } catch (e) {
    console.error(`FULL GATE REQUIRED — could not compute the diff from ${base}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const { verdict, changes } = result;
  console.log(describeVerdict(verdict, base));
  if (ji > 0 && process.argv[ji + 1]) {
    writeFileSync(
      process.argv[ji + 1],
      JSON.stringify({ base, tier: verdict.tier, reasons: verdict.reasons, files: changes.map((c) => ({ path: c.path, status: c.status })) }, null, 2),
    );
  }
  process.exit(verdict.tier === 'affected' ? 0 : 3);
}

if (process.argv[1] && /gate-tier-git\.ts$/.test(process.argv[1])) main();
