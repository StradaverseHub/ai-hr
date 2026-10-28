/**
 * D-P1-22 (ADR-0150): the cycle exclusion plan, pure. The database facts are hand-built here; the same model runs
 * for the preview and the save (packs/performance/onehr/unit-exclusion-service.ts), so this pins what the save does.
 */
import { describe, expect, it } from 'vitest';
import { dedupeChain, fullPanelTarget, planKpiLine, planUnitExclusion, type UnitExclusionFacts } from '../packs/performance/onehr/unit-exclusion-model';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CYCLE = id(1), CO = id(2), DEPT = id(3), M0 = id(10), M1 = id(11), M2 = id(12), A = id(13), S = id(20), C = id(21), Q = id(22);
const RS = id(30), RC = id(31), RQ = id(32), RF = id(33);

function facts(over: Partial<UnitExclusionFacts> = {}): UnitExclusionFacts {
  return {
    cycle: { id: CYCLE, status: 'open', companyId: null, revision: 3 },
    scope: { companyId: CO, departmentId: DEPT, companyExists: true, companyInCycle: true, departmentInCompany: true, headcount: 3 },
    activeRules: [],
    people: [{ reviewId: RQ, employmentId: Q, frozen: false, excludedBefore: false }],
    panels: [
      { requestId: id(40), reviewId: RS, subjectEmploymentId: S, raterEmploymentId: Q, submitted: true, frozen: false, subjectInScope: false, raterInScope: true },
      { requestId: id(41), reviewId: RQ, subjectEmploymentId: Q, raterEmploymentId: C, submitted: false, frozen: false, subjectInScope: true, raterInScope: false },
      { requestId: id(42), reviewId: RF, subjectEmploymentId: id(23), raterEmploymentId: Q, submitted: false, frozen: true, subjectInScope: false, raterInScope: true },
    ],
    panelSubjects: [{ reviewId: RS, grade: '12', live: 4 }],
    kpiLines: [
      { reviewId: RS, kpiId: 'untouched', subjectEmploymentId: S, subjectExcluded: false, hrOwned: false, locked: false, acted: false, approvers: [{ employmentId: M0, inScope: true, excluded: true, stepUp: M1 }] },
      { reviewId: RS, kpiId: 'acted', subjectEmploymentId: S, subjectExcluded: false, hrOwned: false, locked: false, acted: true, approvers: [{ employmentId: A, inScope: false, excluded: false, stepUp: null }, { employmentId: M0, inScope: true, excluded: true, stepUp: M1 }] },
      { reviewId: RS, kpiId: 'chain', subjectEmploymentId: S, subjectExcluded: false, hrOwned: false, locked: false, acted: false, approvers: [{ employmentId: M0, inScope: true, excluded: true, stepUp: M1 }, { employmentId: M1, inScope: false, excluded: false, stepUp: null }] },
      { reviewId: RC, kpiId: 'nobody', subjectEmploymentId: C, subjectExcluded: false, hrOwned: false, locked: false, acted: false, approvers: [{ employmentId: Q, inScope: true, excluded: true, stepUp: null }] },
    ],
    oneLevelUp: [{ reviewId: RS, employmentId: S, storedReviewerId: M0, storedInScope: true, frozen: false, subjectExcluded: false, before: M0, after: M1 }],
    hodOut: [], hodSessionsOut: [], seatsOut: [], sessionReviewersOut: [],
    ...over,
  };
}
const line = (over: Partial<UnitExclusionFacts['kpiLines'][number]>) => ({ ...facts().kpiLines[0], ...over });

describe('planKpiLine: which untouched lines move, and where', () => {
  it('moves an untouched line to the walk above the approver who is out', () => {
    expect(planKpiLine(line({}))).toEqual({ kind: 'move', from: [M0], to: [M1] });
  });
  it('never moves an HR-filled, locked or acted-on line, or a line of a subject who is out', () => {
    for (const over of [{ hrOwned: true }, { locked: true }, { acted: true }, { subjectExcluded: true }]) expect(planKpiLine(line(over)), JSON.stringify(over)).toEqual({ kind: 'skip' });
  });
  it('leaves a line naming nobody in the new scope alone', () => {
    expect(planKpiLine(line({ approvers: [{ employmentId: A, inScope: false, excluded: false, stepUp: null }] }))).toEqual({ kind: 'skip' });
  });
  it('does not move a line when any approver who is out has nobody above', () => {
    expect(planKpiLine(line({ approvers: [{ employmentId: M0, inScope: true, excluded: true, stepUp: M1 }, { employmentId: Q, inScope: false, excluded: true, stepUp: null }] }))).toEqual({ kind: 'nobody' });
  });
  it('replaces every approver who is out (including one out by an earlier rule) and de-duplicates in order', () => {
    expect(planKpiLine(line({ approvers: [{ employmentId: M0, inScope: true, excluded: true, stepUp: M1 }, { employmentId: A, inScope: false, excluded: true, stepUp: M2 }, { employmentId: M1, inScope: false, excluded: false, stepUp: null }] })))
      .toEqual({ kind: 'move', from: [M0, A, M1], to: [M1, M2] });
    expect(dedupeChain([M1, M2, M1, M2])).toEqual([M1, M2]);
  });
});

describe('planUnitExclusion', () => {
  const plan = planUnitExclusion(facts(), { panelTarget: 5 });
  it('archives own rows and places, never a frozen review\'s rows (D7)', () => {
    // Canonical order: by review, then request (RS < RQ).
    expect(plan.archive.map((a) => [a.requestId, a.side, a.submitted])).toEqual([[id(40), 'place', true], [id(41), 'own', false]]);
    expect(plan.frozenSkipped).toEqual([{ requestId: id(42), reviewId: RF }]);
    expect(plan.counts).toMatchObject({ own: 1, places: 1, submitted: 1, frozenSkipped: 1, people: 1 });
  });
  it('lists people still taking part who drop below a full panel', () => {
    expect(plan.belowFullPanel).toEqual([{ reviewId: RS, before: 4, after: 3, target: 5 }]);
    expect(fullPanelTarget('12', 5)).toBe(5);
    expect(fullPanelTarget('JG 9', 5)).toBe(5);
    expect(fullPanelTarget('M1', 5)).toBe(1);
  });
  it('moves untouched lines, keeps acted-on ones and lists the subject of a line that cannot move', () => {
    expect(plan.moves.map((m) => [m.kpiId, m.to])).toEqual([['chain', [M1]], ['untouched', [M1]]]);
    expect(plan.nobodyAbove).toEqual([{ reviewId: RC, employmentId: C, reason: 'kpi' }]);
  });
  it('shows the reviewer one level up, and nobody above when the walk finds nobody', () => {
    expect(plan.oneLevelUp).toEqual([{ reviewId: RS, employmentId: S, from: M0, to: M1 }]);
    const none = planUnitExclusion(facts({ oneLevelUp: [{ reviewId: RS, employmentId: S, storedReviewerId: M0, storedInScope: true, frozen: false, subjectExcluded: false, before: M0, after: null }] }), { panelTarget: 5 });
    expect(none.oneLevelUp).toEqual([]);
    expect(none.nobodyAbove).toContainEqual({ reviewId: RS, employmentId: S, reason: 'review' });
  });
  it('an identical active rule makes the plan a no-op; a whole-company scope subsumes the company\'s department rules', () => {
    const quiet = planUnitExclusion(facts({ activeRules: [{ id: id(90), companyId: CO, departmentId: DEPT }] }), { panelTarget: 5 });
    expect(quiet.alreadyActiveRuleId).toBe(id(90));
    expect([quiet.archive, quiet.moves, quiet.people, quiet.nobodyAbove]).toEqual([[], [], [], []]);
    const whole = planUnitExclusion(facts({ scope: { ...facts().scope, departmentId: null }, activeRules: [{ id: id(91), companyId: CO, departmentId: DEPT }, { id: id(92), companyId: id(99), departmentId: id(98) }] }), { panelTarget: 5 });
    expect(whole.subsumedRuleIds).toEqual([id(91)]);
    expect(whole.alreadyActiveRuleId).toBeNull();
  });
  it('the digest is stable for the same facts and changes when a fact the save acts on changes', () => {
    expect(planUnitExclusion(facts(), { panelTarget: 5 }).digest).toBe(plan.digest);
    const panels = facts().panels.map((p) => (p.requestId === id(41) ? { ...p, submitted: true } : p));
    expect(planUnitExclusion(facts({ panels }), { panelTarget: 5 }).digest).not.toBe(plan.digest);
    expect(planUnitExclusion(facts({ cycle: { ...facts().cycle, revision: 9 } }), { panelTarget: 5 }).digest, 'the revision is a separate token').toBe(plan.digest);
    const reordered = facts({ kpiLines: [...facts().kpiLines].reverse() });
    expect(planUnitExclusion(reordered, { panelTarget: 5 }).digest, 'canonical order').toBe(plan.digest);
  });
});
