/**
 * scripts/improve/release-ci.ts — the release ships only a commit GitHub Actions' `gate` workflow passed.
 * The decision is pure and executed here; test/r291-detached-deploy.test.ts drives it through the real CLI.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ciGate, decideCiGate, type CiRun } from '../scripts/improve/release-ci';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const run = (o: Partial<CiRun> = {}): CiRun => ({
  name: 'gate', head_sha: HEAD, status: 'completed', conclusion: 'success', html_url: 'https://ci.invalid/1',
  event: 'pull_request', verify: 'success', ...o,
});

describe('decideCiGate', () => {
  it('ships a completed, successful gate run for HEAD whose verify job passed', () => {
    expect(decideCiGate({ head: HEAD, runs: [run()] }).ok).toBe(true);
  });
  it('refuses when no run of any kind exists for HEAD', () => {
    const d = decideCiGate({ head: HEAD, runs: [] });
    expect(d.ok).toBe(false);
    expect(d.lines[0]).toContain('no gate run for HEAD');
  });
  it('refuses failed, cancelled and in-progress runs, listing each', () => {
    for (const o of [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { status: 'in_progress', conclusion: null }]) {
      const d = decideCiGate({ head: HEAD, runs: [run({ ...o, verify: null })] });
      expect(d.ok, JSON.stringify(o)).toBe(false);
      expect(d.lines.join('\n')).toContain('https://ci.invalid/1');
    }
  });
  it('refuses a successful run whose verify job did not run (every job skipped on a draft PR)', () => {
    expect(decideCiGate({ head: HEAD, runs: [run({ verify: null })] }).ok).toBe(false);
    expect(decideCiGate({ head: HEAD, runs: [run({ verify: 'skipped' })] }).ok).toBe(false);
  });
  it('a green run for another commit, or of another workflow, does not count', () => {
    expect(decideCiGate({ head: HEAD, runs: [run({ head_sha: OTHER })] }).ok).toBe(false);
    expect(decideCiGate({ head: HEAD, runs: [run({ name: 'smoke' })] }).ok).toBe(false);
  });
  it('ships when one green run sits beside older red ones for the same commit', () => {
    expect(decideCiGate({ head: HEAD, runs: [run({ conclusion: 'failure', verify: null }), run()] }).ok).toBe(true);
  });
  it('refuses when the runs could not be read', () => {
    const d = decideCiGate({ head: HEAD, runs: null, error: 'gh: not logged in' });
    expect(d.ok).toBe(false);
    expect(d.lines[0]).toContain('gh: not logged in');
  });
});

describe('ciGate override', () => {
  const never = () => { throw new Error('must not query GitHub'); };
  it('only the exact value github-outage overrides, and it says so', () => {
    const d = ciGate({ head: HEAD, cwd: '.', override: 'github-outage', fetch: never });
    expect(d).toMatchObject({ ok: true, overridden: true });
    expect(d.lines[0]).toContain('CI CHECK OVERRIDDEN');
  });
  it('any other non-empty value refuses without querying GitHub', () => {
    for (const v of ['1', 'yes', 'true', 'GITHUB-OUTAGE']) {
      expect(ciGate({ head: HEAD, cwd: '.', override: v, fetch: never }), v).toMatchObject({ ok: false, overridden: false });
    }
  });
  it('unset or empty queries GitHub, and a fetch error refuses', () => {
    expect(ciGate({ head: HEAD, cwd: '.', fetch: () => [run()] })).toMatchObject({ ok: true, overridden: false });
    expect(ciGate({ head: HEAD, cwd: '.', override: '', fetch: () => [] })).toMatchObject({ ok: false });
    expect(ciGate({ head: HEAD, cwd: '.', fetch: () => { throw new Error('network down'); } }).lines[0]).toContain('network down');
  });
});

describe('release.ts wiring (source shape)', () => {
  const src = readFileSync('scripts/improve/release.ts', 'utf8');
  const start = src.indexOf('export async function deployWorktree(');
  const end = src.indexOf('export async function releaseBuiltItem(');
  const body = src.slice(start, end);
  it('the CI check runs before the receipt, tsc and any transfer, and a refusal throws', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(body.length).toBeGreaterThan(2000);
    const ci = body.indexOf('ciGate(');
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(body).toMatch(/if \(!ci\.ok\)\s*\{\s*throw new Error/);
    for (const later of ['decideReleaseGate(', "'tsc', '--noEmit'", 'deploymentRsyncArgs(']) {
      const at = body.indexOf(later);
      expect(at, later).toBeGreaterThan(ci);
    }
  });
  it('the receipt is consulted only under the override', () => {
    expect(body).toMatch(/if \(ci\.overridden\) \{[\s\S]*decideReleaseGate\(/);
  });
});
