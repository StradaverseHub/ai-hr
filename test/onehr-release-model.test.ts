/**
 * WP-E (CF-08) — the pure release rules (release-model.ts) and the screens' function-access registration.
 * Each rule is pinned with the case that fails when the rule is removed.
 */
import { describe, expect, it } from 'vitest';
import { chainSteps, decideRelease, ledRelease, ledSummary, matchesReleaseStatus, releaseRowState, requestedComponents, type LeaderChain } from '../packs/performance/onehr/release-model';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';

const t0 = new Date('2026-10-01T00:00:00Z'), now = new Date('2026-10-20T00:00:00Z');
const none = { employee: null, leader: null };

describe('decideRelease', () => {
  it('release 1 sets only the leader step and keeps the first timestamp', () => {
    expect(decideRelease('performance', none, 'leaders', 'release', true, now)).toEqual({ outcome: 'done', next: { employee: null, leader: now } });
    expect(decideRelease('performance', { employee: null, leader: t0 }, 'leaders', 'release', true, now)).toEqual({ outcome: 'unchanged', next: { employee: null, leader: t0 } });
  });
  it('a release needs a result that resolves', () => {
    expect(decideRelease('talent', none, 'both', 'release', false, now).outcome).toBe('no-result');
  });
  it('release 2 needs release 1 (leaders first)', () => {
    expect(decideRelease('potential', none, 'employees', 'release', true, now)).toEqual({ outcome: 'leaders-first', next: none });
    expect(decideRelease('potential', { employee: null, leader: t0 }, 'employees', 'release', true, now)).toEqual({ outcome: 'done', next: { employee: now, leader: t0 } });
  });
  it('revoking release 1 is refused while release 2 stands; revoking both clears both', () => {
    expect(decideRelease('performance', { employee: t0, leader: t0 }, 'leaders', 'revoke', true, now)).toEqual({ outcome: 'still-with-employee', next: { employee: t0, leader: t0 } });
    expect(decideRelease('performance', { employee: null, leader: t0 }, 'leaders', 'revoke', true, now)).toEqual({ outcome: 'done', next: { employee: null, leader: null } });
    expect(decideRelease('performance', { employee: t0, leader: t0 }, 'both', 'revoke', true, now)).toEqual({ outcome: 'done', next: { employee: null, leader: null } });
    expect(decideRelease('performance', { employee: t0, leader: t0 }, 'employees', 'revoke', true, now)).toEqual({ outcome: 'done', next: { employee: null, leader: t0 } });
  });
  it('the 360 report is single-step to the person', () => {
    expect(() => decideRelease('feedback', none, 'leaders', 'release', true, now)).toThrow(/person only/);
    expect(decideRelease('feedback', none, 'employees', 'release', true, now)).toEqual({ outcome: 'done', next: { employee: now, leader: null } });
  });
});

describe('requestedComponents', () => {
  it('three is performance, potential and talent; performance alone without a potential axis; release 1 drops the report', () => {
    expect(requestedComponents('three', 'leaders', true)).toEqual(['performance', 'potential', 'talent']);
    expect(requestedComponents('three', 'both', false)).toEqual(['performance']);
    expect(requestedComponents('feedback', 'leaders', true)).toEqual([]);
    expect(requestedComponents('feedback', 'employees', true)).toEqual(['feedback']);
  });
});

describe('board state', () => {
  const cell = (leaderAt: string | null, employeeAt: string | null, final = true) => ({ band: 'ME', final, leaderAt, employeeAt });
  it('derives the source row state over the components that have a result', () => {
    expect(releaseRowState([cell(null, null), cell(null, null, false)])).toEqual({ ready: true, leadOpen: true, withLeaders: false, toEmp: false, leadAll: false, notFinal: true });
    expect(releaseRowState([cell('a', null), cell('a', 'b')])).toEqual({ ready: false, leadOpen: false, withLeaders: true, toEmp: false, leadAll: true, notFinal: false });
    expect(releaseRowState([{ band: null, final: true, leaderAt: null, employeeAt: null }])).toEqual({ ready: false, leadOpen: false, withLeaders: false, toEmp: false, leadAll: false, notFinal: false });
  });
  it('filters by Show after the counts', () => {
    const cells = [cell('a', null)], s = releaseRowState(cells);
    expect(['pending', 'released', 'ready', 'with_leaders', 'to_emp', 'notfinal'].map((st) => matchesReleaseStatus(st as never, cells, s))).toEqual([true, false, false, true, false, false]);
    expect(matchesReleaseStatus(undefined, cells, s)).toBe(true);
  });
});

describe('the leader read summary', () => {
  const chain = (full: boolean): LeaderChain => ({ role: 'bu', midYear: false, frozen: true, talent: full ? 'Star' : null, axes: [
    { axis: 'performance', full, final: full ? 'AE' : null, hasResult: true, steps: [{ tier: 'self', band: 'ME', state: 'set', why: '' }, { tier: 'bu', band: 'AE', state: 'moved', why: 'r' }, { tier: 'bg', band: full ? 'AE' : null, state: full ? 'kept' : 'hidden', why: '' }] },
    { axis: 'potential', full, final: full ? 'Mid' : null, hasResult: false, steps: [] },
  ] });
  it('shows the leader’s last visible band before release 1 and the final band after', () => {
    expect(ledSummary(chain(false))).toEqual({ performance: 'AE', potential: null, talent: null, full: false, moves: 1, you: ['performance'], none: false });
    expect(ledSummary(chain(true))).toEqual({ performance: 'AE', potential: null, talent: 'Star', full: true, moves: 1, you: ['performance'], none: false });
    expect(ledSummary(null).none).toBe(true);
  });
  it('says where the release stands from the leader’s side', () => {
    const s = ledSummary(chain(false));
    expect(ledRelease('bu', s, false, null, null).key).toBe('inCalibration');
    expect(ledRelease('bu', s, true, null, null).key).toBe('withHod');
    expect(ledRelease('bu', ledSummary(chain(true)), false, 'x', null)).toEqual({ key: 'withYouSince', at: 'x', tone: 'you' });
    expect(ledRelease('bg', s, false, null, null).key).toBe('notReleasedYet');
    expect(ledRelease('lm', s, false, 'x', 'y')).toEqual({ key: 'releasedToThem', at: 'y', tone: 'ok' });
  });
  it('marks the direction of each move and the viewer’s own step', () => {
    expect(chainSteps(chain(false).axes[0], 'bu').map((s) => [s.tier, s.dir, s.you])).toEqual([['self', null, false], ['bu', 'up', true], ['bg', null, false]]);
  });
});

describe('function access', () => {
  it('registers the release page under performance administration and What you led under assignments', () => {
    expect(SCREENS.find((s) => s.screenKey === 'performance')?.routes).toContain('/performance/[cycleId]/release');
    expect(SCREENS.find((s) => s.screenKey === 'onehrAssignments')?.routes).toContain('/performance/led');
    expect(REGISTERED_ROUTES.has('/performance/[cycleId]/release') && REGISTERED_ROUTES.has('/performance/led')).toBe(true);
  });
});
