/**
 * r341 · 8d3a7bff — `planSharedGroupCeilings`, the one decision behind "one card for the pool".
 *
 * The screen and the server test both go through this function; these are the cases neither of them reaches
 * with real data, and each is a way it could ship wrong. Pure, no DB, no React.
 */
import { describe, expect, it } from 'vitest';
import { planSharedGroupCeilings, type PoolCardShape } from '../lib/shared-leave-pool';

const pool = (id: string, borrowers: string[]): PoolCardShape => ({
  leaveTypeId: id,
  sharedBalance: {
    sourceLeaveTypeId: id,
    contributions: borrowers.map((b) => ({ leaveTypeId: b })),
  },
});
const borrower = (id: string, source: string): PoolCardShape => ({
  leaveTypeId: id,
  sharedBalance: { sourceLeaveTypeId: source, contributions: [{ leaveTypeId: id }] },
});
const plain = (id: string): PoolCardShape => ({ leaveTypeId: id, sharedBalance: null });
const group = (id: string, members: string[]) => ({ id, members: members.map((m) => ({ id: m })) });

describe('8d3a7bff · planSharedGroupCeilings', () => {
  it('merges onto the card that HOLDS the pool, never onto a borrower that happens to be listed', () => {
    // A borrower's card can survive when its group is Hidden, so both halves can be present at once.
    const cards = [borrower('cpl', 'sp'), pool('sp', ['cpl', 'ndl']), plain('mrl')];
    const plan = planSharedGroupCeilings(cards, [group('g', ['cpl', 'ndl', 'mrl'])]);
    expect([...plan.mergedOnto.keys()]).toEqual(['sp']);
    expect(plan.standalone).toEqual([]);
    // A surviving borrower is not asked to repeat the ceiling either — the pool's card carries it.
    expect([...plan.alsoCounts.keys()].sort()).toEqual(['cpl', 'mrl']);
  });

  it('a pool whose borrowers are NOT itemised is still matched by the pool’s own id', () => {
    // `contributions` is optional (it post-dates the descriptor). Absent must not mean "no pool".
    const cards: PoolCardShape[] = [{ leaveTypeId: 'sp', sharedBalance: { sourceLeaveTypeId: 'sp' } }];
    expect([...planSharedGroupCeilings(cards, [group('g', ['sp'])]).mergedOnto.keys()]).toEqual(['sp']);
  });

  it('no pooled member anywhere ⇒ STANDALONE, and not one card gains a line', () => {
    const cards = [plain('mrl'), plain('exm')];
    const plan = planSharedGroupCeilings(cards, [group('g', ['mrl', 'exm'])]);
    expect(plan.standalone.map((g) => g.id)).toEqual(['g']);
    expect(plan.mergedOnto.size).toBe(0);
    // THE BYTE-IDENTICAL ARM: the tile still says what the ceiling is, so repeating it on every member card
    // would add a line to every tenant that has a group and no pooled type — the out-of-the-box shape.
    expect(plan.alsoCounts.size, 'no vanished tile, no ceiling lines').toBe(0);
  });

  it('two groups never stack on one card — the second one keeps its tile', () => {
    const cards = [pool('sp', ['cpl'])];
    const plan = planSharedGroupCeilings(cards, [group('g1', ['cpl']), group('g2', ['cpl'])]);
    expect([...plan.mergedOnto.values()].map((g) => g.id)).toEqual(['g1']);
    expect(plan.standalone.map((g) => g.id), 'two contradictory limits on one figure is not representable').toEqual(['g2']);
  });

  it('a member with no card of its own gains no line, and an empty group changes nothing', () => {
    const cards = [pool('sp', ['cpl']), plain('mrl')];
    const plan = planSharedGroupCeilings(cards, [group('g', ['cpl', 'mrl', 'gone'])]);
    expect(plan.alsoCounts.get('gone'), 'a folded member is not on screen to be captioned').toBeUndefined();
    expect(plan.alsoCounts.get('cpl'), 'likewise the folded borrower').toBeUndefined();
    expect([...plan.alsoCounts.keys()]).toEqual(['mrl']);
    expect(planSharedGroupCeilings(cards, []).standalone).toEqual([]);
    expect(planSharedGroupCeilings([], [group('g', ['cpl'])]).standalone.map((g) => g.id)).toEqual(['g']);
  });

  it('is deterministic: the host is the first POOL in the order the cards arrive', () => {
    const forward = planSharedGroupCeilings([pool('a', ['x']), pool('b', ['x'])], [group('g', ['x'])]);
    const reversed = planSharedGroupCeilings([pool('b', ['x']), pool('a', ['x'])], [group('g', ['x'])]);
    expect([...forward.mergedOnto.keys()]).toEqual(['a']);
    expect([...reversed.mergedOnto.keys()]).toEqual(['b']);
  });
});
