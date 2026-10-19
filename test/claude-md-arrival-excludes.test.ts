/**
 * CLAUDE.md §3 check 1 ("does production run main?") is a dry-run rsync typed by hand. It is only a
 * proof of arrival if it filters EXACTLY what the release ships: a missing exclude prints false
 * differences (r2026-10-20: 457 lines, all under the gate's gitignored /scratchpad/), and an extra one
 * hides real ones. Three rounds in a row recorded the drift as owed. This pins the documented command
 * to the release's own filter, deploymentRsyncArgs, as a SET of exclude patterns.
 */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { deploymentRsyncArgs } from '../scripts/improve/release';

const CLAUDE_MD = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');

function excludesOf(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--exclude') out.push(args[i + 1]);
  return out.sort();
}

it('the §3 arrival dry-run excludes exactly what the release excludes', () => {
  const start = CLAUDE_MD.indexOf('# 1. Does production run main?');
  const end = CLAUDE_MD.indexOf('# 2. The board', start);
  // Both markers found (indexOf is -1, which is truthy, when a marker is renamed) and the slice is the
  // real command, not an empty string that would make every comparison below vacuous.
  expect(start, 'CLAUDE.md §3 check 1 marker').toBeGreaterThanOrEqual(0);
  expect(end, 'CLAUDE.md §3 check 2 marker').toBeGreaterThan(start);
  const block = CLAUDE_MD.slice(start, end);
  expect(block).toContain('rsync -azi --delete --dry-run');

  const documented = [...block.matchAll(/--exclude\s+('([^']+)'|(\S+))/g)].map((m) => m[2] ?? m[3]).sort();
  const released = excludesOf(deploymentRsyncArgs('/src', '/dst/'));
  expect(released.length, 'the release filter itself must be non-trivial').toBeGreaterThan(10);
  expect(documented).toEqual(released);
});
