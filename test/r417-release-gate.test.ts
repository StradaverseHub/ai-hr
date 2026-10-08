/**
 * r417 (ADR-0094) — release.ts's test-gate decision (scripts/improve/release-gate.ts).
 *
 * The release never runs the suite any more. It ships a HEAD only when a gate receipt covers it; an
 * affected-tier receipt additionally needs the DEPLOYED→HEAD diff to still be presentational.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyChanges, type ChangedFile } from '../scripts/gate-tier';
import { decideReleaseGate, type DeployedVerdict } from '../scripts/improve/release-gate';

const HEAD = 'a'.repeat(40);
const DEPLOYED = 'd'.repeat(40);
const ch = (path: string): ChangedFile => ({ path, status: 'M', diffLines: ['<p className="x">'], headText: '', baseText: '' });
const presentational: DeployedVerdict = { deployedRef: DEPLOYED, verdict: classifyChanges([ch('components/a.tsx'), ch('messages/en.json')]) };
const nowFull: DeployedVerdict = { deployedRef: DEPLOYED, verdict: classifyChanges([ch('components/a.tsx'), ch('lib/permissions.ts')]) };
const never = (): DeployedVerdict => {
  throw new Error('the deployed diff must not be consulted for this receipt');
};

describe('refusals — the release never falls back to running the suite', () => {
  it('no receipt → refused, and told to run the gate', () => {
    const d = decideReleaseGate({ receipt: null, receiptError: 'missing in /wt', head: HEAD, deployedVerdict: never });
    expect(d.ok).toBe(false);
    expect(d.lines.join('\n')).toMatch(/REFUSED.*missing/);
    expect(d.lines.join('\n')).toContain('scripts/gate-chunked.sh');
    expect(d.lines.join('\n')).toContain('scripts/gate-affected.sh');
  });
  it('a stale receipt (another sha) → refused', () => {
    const d = decideReleaseGate({ receipt: { sha: 'b'.repeat(40), result: 'PASS', tier: 'full' }, head: HEAD, deployedVerdict: never });
    expect(d.ok).toBe(false);
    expect(d.lines[0]).toMatch(/stale/);
  });
  it('a FAIL receipt for HEAD → refused', () => {
    const d = decideReleaseGate({ receipt: { sha: HEAD, result: 'FAIL', tier: 'full' }, head: HEAD, deployedVerdict: never });
    expect(d.ok).toBe(false);
  });
  it('an unknown tier → refused', () => {
    const d = decideReleaseGate({ receipt: { sha: HEAD, result: 'PASS', tier: 'quick' }, head: HEAD, deployedVerdict: never });
    expect(d.ok).toBe(false);
  });
});

describe('full tier', () => {
  it('ships, prints the tier, and does not consult the deployed diff', () => {
    const d = decideReleaseGate({ receipt: { sha: HEAD, result: 'PASS', tier: 'full' }, head: HEAD, deployedVerdict: never });
    expect(d).toMatchObject({ ok: true, tier: 'full' });
    expect(d.lines[0]).toContain('tier=full');
  });
  it('a receipt from before tiers existed was the full gate', () => {
    const d = decideReleaseGate({ receipt: { sha: HEAD, result: 'PASS' }, head: HEAD, deployedVerdict: never });
    expect(d).toMatchObject({ ok: true, tier: 'full' });
  });
});

describe('affected tier — re-judged from the DEPLOYED commit', () => {
  const receipt = { sha: HEAD, result: 'PASS', tier: 'affected', base: DEPLOYED };
  it('still presentational → ships, saying so', () => {
    const d = decideReleaseGate({ receipt, head: HEAD, deployedVerdict: () => presentational });
    expect(d).toMatchObject({ ok: true, tier: 'affected' });
    expect(d.lines[0]).toContain('tier=affected');
  });
  it('the deployed→HEAD diff now needs FULL (e.g. more commits landed) → refused WITH the reason', () => {
    const d = decideReleaseGate({ receipt, head: HEAD, deployedVerdict: () => nowFull });
    expect(d.ok).toBe(false);
    const text = d.lines.join('\n');
    expect(text).toContain('FULL gate');
    expect(text).toContain('lib/permissions.ts');
    expect(text).toContain('scripts/gate-chunked.sh');
  });
  it('the deployed ref cannot be read → refused (cannot check is not presentational)', () => {
    const d = decideReleaseGate({ receipt, head: HEAD, deployedVerdict: () => ({ error: 'ssh: connect timed out' }) });
    expect(d.ok).toBe(false);
    expect(d.lines.join('\n')).toContain('ssh: connect timed out');
  });
});

describe('release.ts wiring (source shape — the decision itself is executed above)', () => {
  const src = readFileSync('scripts/improve/release.ts', 'utf8');
  const body = src.slice(src.indexOf('export async function deployWorktree('), src.indexOf('export async function releaseBuiltItem('));
  it('deployWorktree decides through decideReleaseGate and throws on a refusal', () => {
    expect(body.length).toBeGreaterThan(2000);
    expect(body).toContain('decideReleaseGate(');
    expect(body).toMatch(/if \(!decision\.ok\)\s*\{\s*throw new Error/);
  });
  it('no bare vitest run is left anywhere in release.ts', () => {
    expect(src).not.toMatch(/\[\s*'vitest'\s*,\s*'run'/);
    expect(src).not.toMatch(/run\(\s*'pnpm'\s*,\s*\[\s*'vitest'/);
  });
});

describe('r417 · release.ts runs tsc with a heap it can finish in', () => {
  it('adds --max-old-space-size=6144 unless the operator set one', async () => {
    const { tscEnv } = await import('../scripts/improve/release');
    expect(tscEnv({}).NODE_OPTIONS).toBe('--max-old-space-size=6144');
    expect(tscEnv({ NODE_OPTIONS: '--enable-source-maps' }).NODE_OPTIONS).toBe('--enable-source-maps --max-old-space-size=6144');
    expect(tscEnv({ NODE_OPTIONS: '--max-old-space-size=8192' }).NODE_OPTIONS).toBe('--max-old-space-size=8192');
  });
});
