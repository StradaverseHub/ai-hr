/**
 * P1 approvals matrix: the route-progress and next-seat helpers behind the Approvals board's Matrix view and its
 * decision labels. Pure; no database.
 */
import { describe, expect, it } from 'vitest';
import { rewardNextSeat, rewardRouteProgress } from '../packs/rewards/calendar';
import type { RewardRole } from '../packs/rewards/model';

const ANNUAL: RewardRole[] = ['bu', 'bg', 'gr', 'ctro', 'ec'];
const BG_ORIGIN: RewardRole[] = ['bg', 'gr', 'ctro'];
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 5, 1, minutes));
type Decision = { action: string; fromStage: string; toStage: string; createdAt: Date };
/** Newest first, as decisionHistory returns them. */
const newestFirst = (list: Decision[]) => [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
const forward = (from: string, to: string, minutes: number, action = from === 'draft' ? 'submit' : 'approve'): Decision => ({ action, fromStage: from, toStage: to, createdAt: at(minutes) });
const states = (steps: ReturnType<typeof rewardRouteProgress>) => steps?.map(s => `${s.seat}:${s.state}`);

describe('rewardRouteProgress', () => {
  it('annual at draft: BU current, everything else pending, payroll last', () => {
    const p = rewardRouteProgress('draft', ANNUAL, []);
    expect(states(p)).toEqual(['bu:current', 'bg:pending', 'gr:pending', 'ctro:pending', 'ec:pending', 'payroll:pending']);
    expect(p!.every(s => s.doneAt === null)).toBe(true);
  });
  it('annual at bg: BU done at its submit time', () => {
    const p = rewardRouteProgress('bg', ANNUAL, newestFirst([forward('draft', 'bg', 1)]));
    expect(states(p)).toEqual(['bu:done', 'bg:current', 'gr:pending', 'ctro:pending', 'ec:pending', 'payroll:pending']);
    expect(p![0].doneAt).toEqual(at(1));
  });
  it('annual at gr: each done step carries its own newest forward decision', () => {
    const p = rewardRouteProgress('gr', ANNUAL, newestFirst([forward('draft', 'bg', 1), forward('bg', 'gr', 2)]));
    expect(states(p)).toEqual(['bu:done', 'bg:done', 'gr:current', 'ctro:pending', 'ec:pending', 'payroll:pending']);
    expect(p!.map(s => s.doneAt)).toEqual([at(1), at(2), null, null, null, null]);
  });
  it('annual at ec after a return and resubmission: the newest submit wins, the return never counts', () => {
    const log = newestFirst([forward('draft', 'bg', 1), forward('bg', 'gr', 2), { action: 'return', fromStage: 'gr', toStage: 'draft', createdAt: at(3) },
      forward('draft', 'bg', 4), forward('bg', 'gr', 5), forward('gr', 'ctro', 6), forward('ctro', 'ec', 7)]);
    const p = rewardRouteProgress('ec', ANNUAL, log);
    expect(states(p)).toEqual(['bu:done', 'bg:done', 'gr:done', 'ctro:done', 'ec:current', 'payroll:pending']);
    expect(p!.map(s => s.doneAt)).toEqual([at(4), at(5), at(6), at(7), null, null]);
  });
  it('annual approved: every approver done, payroll current', () => {
    const log = newestFirst([forward('draft', 'bg', 1), forward('bg', 'gr', 2), forward('gr', 'ctro', 3), forward('ctro', 'ec', 4), forward('ec', 'approved', 5)]);
    const p = rewardRouteProgress('approved', ANNUAL, log);
    expect(states(p)).toEqual(['bu:done', 'bg:done', 'gr:done', 'ctro:done', 'ec:done', 'payroll:current']);
    expect(p![4].doneAt).toEqual(at(5));
  });
  it('a returned review (draft) is at step 1 again: older forward decisions do not mark later steps done', () => {
    const log = newestFirst([forward('draft', 'bg', 1), forward('bg', 'gr', 2), forward('gr', 'ctro', 3), { action: 'return', fromStage: 'ctro', toStage: 'draft', createdAt: at(4) }]);
    const p = rewardRouteProgress('draft', ANNUAL, log);
    expect(states(p)).toEqual(['bu:current', 'bg:pending', 'gr:pending', 'ctro:pending', 'ec:pending', 'payroll:pending']);
    expect(p!.every(s => s.doneAt === null)).toBe(true);
  });
  it('off-cycle BG-origin route [bg, gr, ctro]: step 1 is BG at draft', () => {
    expect(states(rewardRouteProgress('draft', BG_ORIGIN, []))).toEqual(['bg:current', 'gr:pending', 'ctro:pending', 'payroll:pending']);
    const p = rewardRouteProgress('ctro', BG_ORIGIN, newestFirst([forward('draft', 'gr', 1), forward('gr', 'ctro', 2)]));
    expect(states(p)).toEqual(['bg:done', 'gr:done', 'ctro:current', 'payroll:pending']);
    expect(p!.map(s => s.doneAt)).toEqual([at(1), at(2), null, null]);
  });
  it('decisions the viewer cannot read leave done steps without a time', () => {
    const p = rewardRouteProgress('ctro', ANNUAL, []);
    expect(states(p)).toEqual(['bu:done', 'bg:done', 'gr:done', 'ctro:current', 'ec:pending', 'payroll:pending']);
    expect(p!.map(s => s.doneAt)).toEqual([null, null, null, null, null, null]);
  });
  it('a status off the route is null', () => {
    expect(rewardRouteProgress('ec', BG_ORIGIN, [])).toBeNull();
    expect(rewardRouteProgress('posted', ANNUAL, [])).toBeNull();
    expect(rewardRouteProgress('withdrawn', ANNUAL, [])).toBeNull();
  });
});

describe('rewardNextSeat', () => {
  it('annual: each step names the seat a decision sends the review to, payroll after EC', () => {
    expect(['draft', 'bg', 'gr', 'ctro', 'ec'].map(s => rewardNextSeat(s as 'draft', ANNUAL))).toEqual(['bg', 'gr', 'ctro', 'ec', 'payroll']);
  });
  it('approved (at payroll) and off-route statuses have no next seat', () => {
    expect(rewardNextSeat('approved', ANNUAL)).toBeNull();
    expect(rewardNextSeat('posted', ANNUAL)).toBeNull();
    expect(rewardNextSeat('ec', BG_ORIGIN)).toBeNull();
  });
  it('off-cycle routes that end early go to payroll from their last approver', () => {
    expect(['draft', 'gr', 'ctro'].map(s => rewardNextSeat(s as 'draft', BG_ORIGIN))).toEqual(['gr', 'ctro', 'payroll']);
    expect(rewardNextSeat('gr', ['bu', 'bg', 'gr'])).toBe('payroll');
  });
});
