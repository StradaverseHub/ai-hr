/**
 * D-P1-22 X1 (ADR-0150): who takes part while a unit is left out. app.assessment_review_participates gains the unit
 * rule after the terminated arm and before the per-person override; a frozen result is exempt (D7); a closed cycle
 * reads the set pinned at close (D8). Every read runs as ai_hr_app (the cycle administrator unless stated).
 */
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import * as perf from '../packs/performance/service';
import { closeAll, owner } from './harness';
import {
  bringBack, buildFixture, exclude, flagAs, moveTo, participatesAs, refusal, reviewOf, type Fixture,
} from './performance-unit-exclusion-fixture';

let f: Fixture;
let rid: Record<string, string>;
beforeEach(async () => {
  f = await buildFixture();
  rid = {};
  for (const name of ['M0', 'S', 'C', 'P', 'Q', 'E1', 'E2']) rid[name] = await reviewOf(f.cycleId, f.P[name]);
});
afterAll(closeAll);

const participates = (name: string) => participatesAs(f.a, rid[name]);
async function participant(employmentId: string) {
  const view = (await perf.getOnehrCycle(f.a, f.cycleId))!;
  return { revision: view.revision, row: view.participants.find((p) => p.employmentId === employmentId) };
}
async function setOverride(employmentId: string, mode: 'add' | 'remove' | 'clear') {
  const { revision, row } = await participant(employmentId);
  return perf.setAssessmentParticipation(f.a, f.cycleId, revision, employmentId, row?.revision ?? null, mode);
}

describe('the subject arm', () => {
  it('an employee in a left-out department does not take part; a colleague does', async () => {
    expect([await participates('M0'), await participates('C')], 'non-vacuous: both take part before the rule').toEqual([true, true]);
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect([await participates('M0'), await participates('Q'), await participates('C'), await participates('S')]).toEqual([false, false, true, true]);
  });

  it('a whole-company rule covers every department of that company and nothing else', async () => {
    await exclude(f.a, f.cycleId, f.companyB, null);
    expect([await participates('E2'), await participates('E1'), await participates('M0')]).toEqual([false, true, true]);
  });

  it('a sub-department is not covered by its parent\'s rule (D2)', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(await participates('P')).toBe(true);
    expect(await participates('M0')).toBe(false);
  });

  it('the rule beats a per-person add; adding is refused while the unit is out; remove and clear still work', async () => {
    await setOverride(f.P.M0.employmentId, 'add');
    expect(await participates('M0')).toBe(true);
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(await participates('M0'), 'terminated, then the unit rule, then the override').toBe(false);
    expect(await refusal(setOverride(f.P.M0.employmentId, 'add'))).toMatch(/Bring the unit back before including them/);
    await setOverride(f.P.M0.employmentId, 'remove');
    await setOverride(f.P.M0.employmentId, 'clear');
    const [row] = await owner.db.select({ override: schema.assessmentParticipationSnapshot.override }).from(schema.assessmentParticipationSnapshot)
      .where(eq(schema.assessmentParticipationSnapshot.employmentId, f.P.M0.employmentId));
    expect(row.override).toBeNull();
  });

  it('a remove override persists across Bring back', async () => {
    await setOverride(f.P.M0.employmentId, 'remove');
    const { saved } = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    await bringBack(f.a, f.cycleId, saved.ruleId);
    expect(await participates('M0')).toBe(false);
    expect(await participates('Q'), 'non-vacuous: the unit itself is back').toBe(true);
  });

  it('a frozen result is never hidden or changed by the rule (D7)', async () => {
    await withTenant(f.a, (tx) => tx.insert(schema.onehrResult).values({ tenantId: f.b.tenantId, reviewId: rid.M0, cycleId: f.cycleId, employmentId: f.P.M0.employmentId, result: { version: 1 }, digest: 'fixture-frozen' }));
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(await participates('M0')).toBe(true);
    expect(await participates('Q'), 'non-vacuous: an unfrozen colleague in the unit is out').toBe(false);
    const [stored] = await owner.db.select({ digest: schema.onehrResult.digest }).from(schema.onehrResult).where(eq(schema.onehrResult.reviewId, rid.M0));
    expect(stored.digest).toBe('fixture-frozen');
    expect((await perf.getOnehrCycle(f.a, f.cycleId))!.participants.find((p) => p.employmentId === f.P.M0.employmentId)?.reason).not.toBe('unit_out');
  });

  it('a joiner into a left-out department is out at once, with no step', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    const joiner = await f.hire('Joiner', f.b.companyId, f.dept.X);
    expect(await flagAs(f.a, sql`app.assessment_unit_out(${f.cycleId}::uuid,${joiner.employmentId}::uuid)`)).toBe(true);
    expect(await refusal(setOverride(joiner.employmentId, 'add'))).toMatch(/Bring the unit back before including them/);
    const other = await f.hire('Other joiner', f.b.companyId, f.dept.Y);
    expect(await flagAs(f.a, sql`app.assessment_unit_out(${f.cycleId}::uuid,${other.employmentId}::uuid)`)).toBe(false);
  });

  it('a mover out of the unit is back in and a mover into it is out, effective today', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect([await participates('M0'), await participates('C')]).toEqual([false, true]);
    await moveTo(f.P.M0, f.dept.Y);
    await moveTo(f.P.C, f.dept.X);
    expect([await participates('M0'), await participates('C')]).toEqual([true, false]);
  });

  it('a second employment outside the scope is unaffected (D9)', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect([await participates('E1'), await participates('E2')]).toEqual([false, true]);
  });

  it('Bring back restores participation at once', async () => {
    const { saved } = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(await participates('M0')).toBe(false);
    await bringBack(f.a, f.cycleId, saved.ruleId);
    expect(await participates('M0')).toBe(true);
  });

  it('the participants list reports unit_out on its own reason', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    const rows = (await perf.getOnehrCycle(f.a, f.cycleId))!.participants;
    const of = (e: { employmentId: string }) => rows.find((p) => p.employmentId === e.employmentId);
    expect(of(f.P.M0)).toMatchObject({ takingPart: false, reason: 'unit_out' });
    expect(of(f.P.Q)).toMatchObject({ takingPart: false, reason: 'unit_out' });
    expect(of(f.P.C)).toMatchObject({ takingPart: true });
    expect(of(f.P.C)?.reason).not.toBe('unit_out');
    expect(of(f.P.P)?.reason, 'the child department is not covered').not.toBe('unit_out');
  });

  it('a closed cycle keeps the exclusion pinned at close (D8)', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    await perf.closeCycle(f.a, { cycleId: f.cycleId });
    const pins = await owner.db.select({ employmentId: schema.assessmentUnitExclusionPin.employmentId }).from(schema.assessmentUnitExclusionPin)
      .where(eq(schema.assessmentUnitExclusionPin.cycleId, f.cycleId)).orderBy(asc(schema.assessmentUnitExclusionPin.employmentId));
    expect(pins.map((p) => p.employmentId)).toEqual([f.P.M0, f.P.Q, f.P.T, f.P.E1].map((e) => e.employmentId).sort());
    await moveTo(f.P.M0, f.dept.Y);
    await moveTo(f.P.C, f.dept.X);
    expect([await participates('M0'), await participates('C')], 'history does not drift with later moves').toEqual([false, true]);
  });

  it('excluded subjects leave calibration cohorts; their entries are kept', async () => {
    const session = await withTenant(f.a, async (tx) => {
      const [s] = await tx.insert(schema.onehrCalibration).values({ tenantId: f.b.tenantId, cycleId: f.cycleId, companyId: null, name: 'Group cohort', tier: 'bu', reviewerUserIds: [f.U.M2.userId!] }).returning();
      for (const name of ['S', 'C', 'M0']) await tx.insert(schema.onehrCalibrationEntry).values({ tenantId: f.b.tenantId, sessionId: s.id, reviewId: rid[name], employmentId: f.P[name].employmentId });
      return s.id;
    });
    const entriesAs = async () => (await withTenant(f.U.M2, (tx) => tx.select({ reviewId: schema.onehrCalibrationEntry.reviewId }).from(schema.onehrCalibrationEntry)
      .where(eq(schema.onehrCalibrationEntry.sessionId, session)).orderBy(asc(schema.onehrCalibrationEntry.reviewId)))).map((r) => r.reviewId);
    expect(await entriesAs(), 'non-vacuous: the reviewer sees all three first').toEqual([rid.S, rid.C, rid.M0].sort());
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(await entriesAs()).toEqual([rid.S, rid.C].sort());
    expect(await owner.db.select().from(schema.onehrCalibrationEntry).where(eq(schema.onehrCalibrationEntry.sessionId, session))).toHaveLength(3);
  });

  it('with no active rule, every review\'s participation is unchanged', async () => {
    const reviews = await owner.db.select({ id: schema.onehrReview.reviewId }).from(schema.onehrReview).where(eq(schema.onehrReview.cycleId, f.cycleId)).orderBy(asc(schema.onehrReview.reviewId));
    expect(reviews.length).toBeGreaterThan(10);
    const all = async () => { const out: boolean[] = []; for (const r of reviews) out.push(await participatesAs(f.a, r.id)); return out; };
    const before = await all();
    const { saved } = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect((await all()).some((v) => !v), 'non-vacuous: the active rule changes something').toBe(true);
    await bringBack(f.a, f.cycleId, saved.ruleId);
    expect(await all()).toEqual(before);
  });
});
