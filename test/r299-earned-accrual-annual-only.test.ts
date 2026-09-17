/**
 * r299 (board 3de1453a) — EARNED ACCRUAL APPLIES TO ANNUAL LEAVE, AND NOTHING ELSE.
 *
 * THE REPORTER'S RULE, verbatim: "Only Annual Leave (*Annual Leave) is subject to the Earned Accrual concept.
 * All other leave types are managed based on entitlement and should not be included in the Earned Accrual
 * process."
 *
 * WHAT WAS WRONG, TWICE OVER. `accrueEarnedLeave` filtered `code IN STANDING_LEAVE_CODES` (ANNUAL · SICK ·
 * HOSPITALIZATION): SICK and HOSPITALIZATION were swept whenever they carried an earned method (the rule
 * forbids it), and the filter keyed on the CODE, so the reporter's own `AL` "*Annual Leave" could never
 * accrue a day. The fix is ONE predicate, `isEarnedAccrualType` = `leaveTypeIs(lt, 'annual')` — role
 * first, the seeded code ANNUAL only for an unclassified row — plus the "This is our Annual Leave" switch
 * that writes the role, and a service that refuses an earned method on anything else.
 *
 *   §1  the predicate, pure.
 *   §2  the ENGINE, against a real database: the role arm, the SICK and HOSPITALIZATION arms (dry run AND
 *       commit), the unscoped run, the unclassified-ANNUAL fallback, and a crafted non-Annual scope.
 *   §3  the SERVICES: every refusal, the one-save switch-on, unarchive, create, and the audit event.
 *   §4  LEAVE BALANCE HEALTH: the stranded-method finding, pure and through the real page loader.
 *   §5  the screens DERIVE — source shape, because the derivations live inline in `page.tsx` defaults.
 *   §6  FIX PASS — a STRANDED type READS as stranded: the balance status (/me, /leave, Personnel) and the
 *       Generate Entitlement label, each pinned BOTH WAYS — the stranded type gets the new reading, and Annual
 *       Leave on the very same method gets exactly the old one.
 *   §7  FIX PASS — a stranded LEGACY method (`earned_quarterly`) can be replaced: the service accepts None and
 *       Not configured from it (the form half is test/r288-earned-sweep-warning.dom.test.tsx §D).
 *
 * The RENDERED halves are test/r293-earned-accrual-picker.dom.test.tsx (the picker) and
 * test/r288-earned-sweep-warning.dom.test.tsx (the switch and the earning method), both rewritten for this
 * round rather than deleted.
 *
 * ⚠️ EVERY ENGINE ARM CARRIES A POSITIVE CONTROL in the same test, because "breakdown is empty" is just as
 * true of an engine that can never produce anything.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  accrueEarnedLeave,
  reprojectEntitlementForEmployment,
  annualLeaveSwitchState,
  isEarnedAccrualType,
  openLeaveYear,
  STANDING_LEAVE_CODES,
} from '../core/leave';
import { leaveEntitlementBreakdown } from '../core/read';
import { leaveGenerationRunCsv, previewLeaveGeneration, runLeaveGeneration } from '../core/leave-generation';
import {
  ENTITLEMENT_STATUS_LABEL_KEY,
  ENTITLEMENT_STATUS_TIP_KEY,
  entitlementStatusNeedsNotice,
  resolveEntitlementStatus,
} from '../lib/entitlement-status';
import {
  archiveLeaveType,
  createLeaveType,
  LeaveTypeRuleError,
  setLeaveTypeRules,
  updateLeaveType,
} from '../core/admin';
import { leaveTypeConfigHealth, type HealthLeaveType } from '../lib/leave-config-health';
import { loadEntitlementTablesData } from '../app/admin/leave/entitlements/templates/entitlement-tables-block';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

// The page loader reads three label namespaces through next-intl's server API, which has no request context
// in a node test. Its LABELS are not what §4 asserts — the per-row flag is — so they resolve to their keys
// (the same stub test/r269-default-entitlement-table.test.ts uses for this loader).
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');
/** Source with comment lines dropped — the headers discuss the retired constant by name, deliberately. */
const codeOf = (src: string) =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

// Dates derive from the clock, never hardcoded (CLAUDE.md §8).
const TODAY = todayInKualaLumpur();
const YEAR = Number(TODAY.slice(0, 4));
const JAN = `${YEAR}-01-01`;
const MID = `${YEAR}-06-15`;

let b: Base;
const ctx = () => adminCtx(b);

/** A raw leave type row — the engine arms must not depend on the service they are also testing. */
const mkType = async (code: string, name: string, role: schema.LeaveTypeRoleValue | null = null) => {
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name, role, paid: true, allowNegativeBalance: true })
    .returning({ id: schema.leaveType.id });
  return lt.id;
};

const setMethod = (leaveTypeId: string, method: string | null) =>
  owner.db
    .update(schema.leaveType)
    .set({ accrualMethod: method as never })
    .where(eq(schema.leaveType.id, leaveTypeId));

const setArchived = (leaveTypeId: string, archived: boolean) =>
  owner.db
    .update(schema.leaveType)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(schema.leaveType.id, leaveTypeId));

/** A fully configured type: a table in force from 1 Jan and a rule reaching everybody. */
const configure = (leaveTypeId: string) =>
  seedEntitlement(ctx(), { leaveTypeId, annualDays: 12, gradeId: null, validFrom: JAN });

const hire = () =>
  hireEmployee(ctx(), {
    person: { fullName: 'Accrual', primaryEmail: `r299_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: JAN,
    gradeId: null,
    grantLeaveTypes: [],
  });

const ledgerRowsFor = (leaveTypeId: string) =>
  owner.db
    .select({ id: schema.leaveLedger.id, entryType: schema.leaveLedger.entryType })
    .from(schema.leaveLedger)
    .where(eq(schema.leaveLedger.leaveTypeId, leaveTypeId))
    .orderBy(asc(schema.leaveLedger.id));

const rowOf = async (id: string) => {
  const [row] = await owner.db
    .select({
      role: schema.leaveType.role,
      code: schema.leaveType.code,
      accrualMethod: schema.leaveType.accrualMethod,
      archivedAt: schema.leaveType.archivedAt,
    })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, id))
    .limit(1);
  return row!;
};

const updatedEvents = (leaveTypeId: string) =>
  owner.db
    .select({ payload: schema.domainEvent.payload })
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.aggregateId, leaveTypeId),
        eq(schema.domainEvent.eventType, 'leave-type.updated'),
      ),
    )
    .orderBy(asc(schema.domainEvent.sequence));

const accrualRunEvents = () =>
  owner.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'leave.earned-accrual.run')));

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

describe('§1 the predicate — role first, the seeded code only for an unclassified row', () => {
  it('Annual Leave by role or by the unclassified ANNUAL code, and nothing else', () => {
    expect(isEarnedAccrualType({ role: 'annual', code: 'AL' })).toBe(true); // the reporter's switch
    expect(isEarnedAccrualType({ role: null, code: 'ANNUAL' })).toBe(true); // an unclassified tenant, unchanged
    // THE TWO CODES THE OLD CONSTANT SWEPT, and the reporter's rule excludes.
    expect(isEarnedAccrualType({ role: null, code: 'SICK' })).toBe(false);
    expect(isEarnedAccrualType({ role: null, code: 'HOSPITALIZATION' })).toBe(false);
    expect(isEarnedAccrualType({ role: 'sick', code: 'SICK' })).toBe(false);
    // ROLE WINS over the code, in both directions.
    expect(isEarnedAccrualType({ role: 'sick', code: 'ANNUAL' })).toBe(false);
    expect(isEarnedAccrualType({ role: null, code: 'AL' })).toBe(false);
    expect(isEarnedAccrualType(null)).toBe(false);
    // The constant itself is untouched — openLeaveYear still reads it.
    expect([...STANDING_LEAVE_CODES]).toEqual(['ANNUAL', 'SICK', 'HOSPITALIZATION']);
  });

  it('the switch state agrees with the predicate by construction', () => {
    expect(annualLeaveSwitchState({ role: 'annual', code: 'AL' })).toBe('on');
    expect(annualLeaveSwitchState({ role: null, code: 'AL' })).toBe('off');
    expect(annualLeaveSwitchState({ role: null, code: 'ANNUAL' })).toBe('by_code');
    expect(annualLeaveSwitchState({ role: 'maternity', code: 'MTL' })).toBe('other_role');
    for (const row of [
      { role: 'annual', code: 'AL' },
      { role: null, code: 'AL' },
      { role: null, code: 'ANNUAL' },
      { role: 'sick', code: 'ANNUAL' },
    ]) {
      const s = annualLeaveSwitchState(row);
      expect(s === 'on' || s === 'by_code', JSON.stringify(row)).toBe(isEarnedAccrualType(row));
    }
  });
});

describe('§2 the engine sweeps Annual Leave only', () => {
  it('ROLE ARM — a type switched on by role, on a non-ANNUAL code, IS swept (this was type_not_swept)', async () => {
    // The production shape: the seeded ANNUAL archived, the tenant's own `AL` "*Annual Leave" active.
    await setArchived(b.annualLeaveTypeId, true);
    const al = await mkType('AL', '*Annual Leave', 'annual');
    await setMethod(al, 'earned_monthly');
    await configure(al);
    await hire();

    const preview = await accrueEarnedLeave(ctx(), { asOf: MID, leaveTypeIds: [al], dryRun: true });
    expect(preview.emptyReason).toBeNull();
    expect(preview.breakdown.map((g) => g.leaveTypeId)).toEqual([al]);
    expect(preview.breakdown[0].entitlementGenerated).toBeGreaterThan(0);

    const commit = await accrueEarnedLeave(ctx(), { asOf: MID, leaveTypeIds: [al] });
    expect(commit.granted).toBe(1);
    expect((await ledgerRowsFor(al)).map((r) => r.entryType)).toEqual(['accrual']);

    // CONTROL — the same row with the role cleared is not Annual Leave, and is declined by name.
    await owner.db.update(schema.leaveType).set({ role: null }).where(eq(schema.leaveType.id, al));
    const declined = await accrueEarnedLeave(ctx(), { asOf: MID, leaveTypeIds: [al], dryRun: true });
    expect(declined.emptyReason?.kind).toBe('type_not_swept');
  });

  for (const [code, name] of [
    ['SICK', 'Medical Leave'],
    ['HOSPITALIZATION', 'Hospitalisation Leave'],
  ] as const) {
    it(`${code} ARM — an earned method on ${code} is NOT swept and writes no ledger row, dry run and commit`, async () => {
      const typeId = await mkType(code, name);
      await setMethod(typeId, 'earned_monthly');
      await configure(typeId);
      await hire();

      const preview = await accrueEarnedLeave(ctx(), { asOf: MID, leaveTypeIds: [typeId], dryRun: true });
      expect(preview.breakdown).toEqual([]);
      expect(preview.emptyReason).toEqual({
        kind: 'type_not_swept',
        leaveTypeNames: [name],
        // The tenant's ACTIVE Annual Leave, by its own name — the seeded, unclassified ANNUAL.
        sweptLeaveTypeNames: ['Annual Leave'],
      });

      const commit = await accrueEarnedLeave(ctx(), { asOf: MID, leaveTypeIds: [typeId] });
      expect(commit.granted).toBe(0);
      expect(commit.breakdown).toEqual([]);
      expect(await ledgerRowsFor(typeId)).toEqual([]);

      // POSITIVE CONTROL — the identical configuration on Annual Leave accrues.
      await setMethod(b.annualLeaveTypeId, 'earned_monthly');
      await configure(b.annualLeaveTypeId);
      const ok = await accrueEarnedLeave(ctx(), { asOf: MID, leaveTypeIds: [b.annualLeaveTypeId] });
      expect(ok.granted).toBe(1);
      expect((await ledgerRowsFor(b.annualLeaveTypeId)).length).toBe(1);
    });
  }

  it('the PROFILE RECALCULATION agrees: a stranded earned method on SICK is not topped up, Annual Leave still is', async () => {
    // An accrual row the OLD sweep would have posted this cycle, before this release narrowed it. Without the
    // boundary in reprojectEntitlementForEmployment an ordinary profile save corrects it upward.
    const sick = await mkType('SICK', 'Medical Leave');
    await setMethod(sick, 'earned_monthly');
    await configure(sick);
    await setMethod(b.annualLeaveTypeId, 'earned_monthly');
    await configure(b.annualLeaveTypeId);
    const { employmentId } = await hire();
    for (const leaveTypeId of [sick, b.annualLeaveTypeId]) {
      await owner.db.insert(schema.leaveLedger).values({
        tenantId: b.tenantId,
        employmentId,
        leaveTypeId,
        entryType: 'accrual',
        days: '0.50',
        effectiveOn: JAN,
      });
    }
    const before = (await ledgerRowsFor(sick)).length;
    await reprojectEntitlementForEmployment(ctx(), { employmentId, asOf: MID, trigger: 'r299-test' });
    expect(await ledgerRowsFor(sick), 'nothing is calculated, added or changed for a non-Annual type').toHaveLength(before);
    // POSITIVE CONTROL — the same shape on Annual Leave IS corrected, so the arm above is not vacuous.
    expect((await ledgerRowsFor(b.annualLeaveTypeId)).length, 'Annual Leave is still corrected').toBeGreaterThan(1);
  });

  it('an UNSCOPED run ("All leave types") posts Annual Leave rows only', async () => {
    const sick = await mkType('SICK', 'Medical Leave');
    const hosp = await mkType('HOSPITALIZATION', 'Hospitalisation Leave');
    for (const id of [b.annualLeaveTypeId, sick, hosp]) {
      await setMethod(id, 'earned_monthly');
      await configure(id);
    }
    await hire();

    const preview = await accrueEarnedLeave(ctx(), { asOf: MID, dryRun: true });
    expect([...new Set(preview.breakdown.map((g) => g.leaveTypeId))]).toEqual([b.annualLeaveTypeId]);

    const commit = await accrueEarnedLeave(ctx(), { asOf: MID });
    expect([...new Set(commit.breakdown.map((g) => g.leaveTypeId))]).toEqual([b.annualLeaveTypeId]);
    const byType = await owner.db
      .select({ leaveTypeId: schema.leaveLedger.leaveTypeId, n: sql<number>`count(*)::int` })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.tenantId, b.tenantId))
      .groupBy(schema.leaveLedger.leaveTypeId)
      .orderBy(asc(schema.leaveLedger.leaveTypeId));
    expect(byType.map((r) => r.leaveTypeId)).toEqual([b.annualLeaveTypeId]);
    expect(await ledgerRowsFor(sick)).toEqual([]);
    expect(await ledgerRowsFor(hosp)).toEqual([]);
  });

  it('FALLBACK — an unclassified ANNUAL-coded type still sweeps, exactly as before', async () => {
    expect((await rowOf(b.annualLeaveTypeId)).role).toBeNull();
    await setMethod(b.annualLeaveTypeId, 'earned_daily');
    await configure(b.annualLeaveTypeId);
    await hire();
    const res = await accrueEarnedLeave(ctx(), { asOf: MID, dryRun: true });
    expect(res.emptyReason).toBeNull();
    expect(res.breakdown.map((g) => g.leaveTypeId)).toEqual([b.annualLeaveTypeId]);
  });

  it('a crafted scope naming ONLY a non-Annual id returns the typed reason and writes nothing', async () => {
    // The picker disables such a row; this is the engine being the control anyway.
    const sick = await mkType('SICK', 'Medical Leave');
    await setMethod(sick, 'earned_monthly');
    await configure(sick);
    await hire();

    const res = await accrueEarnedLeave(ctx(), { asOf: MID, leaveTypeIds: [sick] });
    expect(res.emptyReason?.kind).toBe('type_not_swept');
    expect(res.granted).toBe(0);
    const [{ n }] = await owner.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.tenantId, b.tenantId));
    expect(n).toBe(0);
    expect((await accrualRunEvents())[0].n).toBe(0);
  });

  it('with NO active Annual Leave the reason names none, and an archived earned Annual Leave is hinted', async () => {
    const sick = await mkType('SICK', 'Medical Leave');
    await setMethod(sick, 'earned_monthly');
    await setMethod(b.annualLeaveTypeId, 'earned_monthly');
    await setArchived(b.annualLeaveTypeId, true);
    const res = await accrueEarnedLeave(ctx(), { asOf: MID, leaveTypeIds: [sick], dryRun: true });
    expect(res.emptyReason).toEqual({ kind: 'type_not_swept', leaveTypeNames: ['Medical Leave'], sweptLeaveTypeNames: [] });
    // The archived-hint arm asks the same predicate: the archived Annual Leave with an earned method.
    expect(res.archivedHint.map((a) => a.id)).toEqual([b.annualLeaveTypeId]);
  });
});

describe('§3 the services', () => {
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error('expected the save to be refused, and it was accepted');
  };

  it('an earned method is REFUSED on a type that is not Annual Leave, and nothing is written', async () => {
    const sick = await mkType('SICK', 'Medical Leave');
    for (const method of ['earned_monthly', 'earned_daily']) {
      const e = await refusal(setLeaveTypeRules(ctx(), { id: sick, accrualMethod: method, accrualDay: 1 }));
      expect(e).toBeInstanceOf(LeaveTypeRuleError);
      expect((e as Error).message).toContain('Medical Leave is not your Annual Leave');
    }
    expect((await rowOf(sick)).accrualMethod).toBeNull();
    // CONTROL — the non-earned method on the same type saves, and so does an earned one on Annual Leave.
    await setLeaveTypeRules(ctx(), { id: sick, accrualMethod: 'grant_on_hire_prorated' });
    expect((await rowOf(sick)).accrualMethod).toBe('grant_on_hire_prorated');
    await setLeaveTypeRules(ctx(), { id: b.annualLeaveTypeId, accrualMethod: 'earned_monthly', accrualDay: 1 });
    expect((await rowOf(b.annualLeaveTypeId)).accrualMethod).toBe('earned_monthly');
  });

  it('switching ON and choosing Monthly Accrual in ONE save is accepted, and the role is recorded', async () => {
    await setArchived(b.annualLeaveTypeId, true);
    const al = await mkType('AL', '*Annual Leave');
    await setLeaveTypeRules(ctx(), { id: al, isAnnualLeave: true, accrualMethod: 'earned_monthly', accrualDay: 1 });
    const row = await rowOf(al);
    expect(row.role).toBe('annual');
    expect(row.accrualMethod).toBe('earned_monthly');
    const events = await updatedEvents(al);
    expect(events.map((e) => e.payload)).toContainEqual({
      before: { name: '*Annual Leave', role: null },
      after: { name: '*Annual Leave', role: 'annual' },
    });
  });

  it('updateLeaveType records the before/after role on leave-type.updated', async () => {
    await setArchived(b.annualLeaveTypeId, true);
    const al = await mkType('AL', '*Annual Leave');
    await updateLeaveType(ctx(), { id: al, name: '*Annual Leave', isAnnualLeave: true });
    expect((await rowOf(al)).role).toBe('annual');
    const payloads = (await updatedEvents(al)).map((e) => e.payload as { before: { role?: unknown }; after: { role?: unknown } });
    expect(payloads.some((p) => p.before.role === null && p.after.role === 'annual')).toBe(true);
    // A save that does not post the switch records no role at all — the tri-state holds.
    await updateLeaveType(ctx(), { id: al, name: '*Annual Leave' });
    const last = (await updatedEvents(al)).map((e) => e.payload as { before: object; after: object });
    expect(last.filter((p) => !('role' in p.before))).toHaveLength(1);
    expect((await rowOf(al)).role).toBe('annual');
  });

  it('a SECOND active Annual Leave is refused, naming the one that already is', async () => {
    // The seeded ANNUAL is active and unclassified — Annual Leave by its code.
    const al = await mkType('AL', '*Annual Leave');
    for (const save of [
      () => updateLeaveType(ctx(), { id: al, name: '*Annual Leave', isAnnualLeave: true }),
      () => setLeaveTypeRules(ctx(), { id: al, isAnnualLeave: true }),
    ]) {
      const e = await refusal(save());
      expect(e).toBeInstanceOf(LeaveTypeRuleError);
      expect((e as Error).message).toContain('Annual Leave is already your Annual Leave');
    }
    expect((await rowOf(al)).role).toBeNull();
    // CONTROL — archive the other one and the same save goes through.
    await setArchived(b.annualLeaveTypeId, true);
    await updateLeaveType(ctx(), { id: al, name: '*Annual Leave', isAnnualLeave: true });
    expect((await rowOf(al)).role).toBe('annual');
  });

  it('…including through UNARCHIVE, which is refused while another Annual Leave is active', async () => {
    await setArchived(b.annualLeaveTypeId, true);
    const al = await mkType('AL', '*Annual Leave', 'annual');
    const e = await refusal(archiveLeaveType(ctx(), { id: b.annualLeaveTypeId, archived: false }));
    expect(e).toBeInstanceOf(LeaveTypeRuleError);
    expect((e as Error).message).toContain('cannot be restored');
    expect((await rowOf(b.annualLeaveTypeId)).archivedAt).not.toBeNull();
    // A non-Annual archived type restores freely — the refusal is about Annual Leave, not about unarchive.
    const sick = await mkType('SICK', 'Medical Leave');
    await setArchived(sick, true);
    await archiveLeaveType(ctx(), { id: sick, archived: false });
    expect((await rowOf(sick)).archivedAt).toBeNull();
    // CONTROL — switch the other one off and the Annual Leave restores.
    await updateLeaveType(ctx(), { id: al, name: '*Annual Leave', isAnnualLeave: false });
    await archiveLeaveType(ctx(), { id: b.annualLeaveTypeId, archived: false });
    expect((await rowOf(b.annualLeaveTypeId)).archivedAt).toBeNull();
  });

  it('…and through CREATE of a type the code fallback would make Annual Leave', async () => {
    await setArchived(b.annualLeaveTypeId, true);
    await mkType('AL', '*Annual Leave', 'annual');
    const e = await refusal(createLeaveType(ctx(), { code: 'ANNUAL', name: 'Annual Leave 2' }));
    expect(e).toBeInstanceOf(LeaveTypeRuleError);
    // CONTROL — an ordinary code creates as it always did.
    await createLeaveType(ctx(), { code: 'STUDY', name: 'Study Leave' });
  });

  it('switching OFF while an earned method is stored is refused — unless the same save changes the method', async () => {
    await setArchived(b.annualLeaveTypeId, true);
    const al = await mkType('AL', '*Annual Leave', 'annual');
    await setMethod(al, 'earned_monthly');
    for (const save of [
      () => updateLeaveType(ctx(), { id: al, name: '*Annual Leave', isAnnualLeave: false }),
      () => setLeaveTypeRules(ctx(), { id: al, isAnnualLeave: false }),
      () => setLeaveTypeRules(ctx(), { id: al, isAnnualLeave: false, accrualMethod: 'earned_monthly' }),
    ]) {
      const e = await refusal(save());
      expect(e).toBeInstanceOf(LeaveTypeRuleError);
      expect((e as Error).message).toContain('Change its earning method first');
    }
    expect(await rowOf(al)).toMatchObject({ role: 'annual', accrualMethod: 'earned_monthly' });
    // ONE save that also changes the method to a non-earned one is accepted.
    await setLeaveTypeRules(ctx(), { id: al, isAnnualLeave: false, accrualMethod: 'grant_on_hire_prorated' });
    expect(await rowOf(al)).toMatchObject({ role: null, accrualMethod: 'grant_on_hire_prorated' });
  });

  it('a DIFFERENT existing role is refused, and the role is untouched', async () => {
    await setArchived(b.annualLeaveTypeId, true);
    const mat = await mkType('MTL', 'Maternity Leave', 'maternity');
    const e = await refusal(updateLeaveType(ctx(), { id: mat, name: 'Maternity Leave', isAnnualLeave: true }));
    expect(e).toBeInstanceOf(LeaveTypeRuleError);
    expect((e as Error).message).toContain('different kind of leave');
    expect((await rowOf(mat)).role).toBe('maternity');
  });

  it('CONCURRENT switch-ons on two types leave exactly ONE active Annual Leave, every time', async () => {
    // r299 fix pass — the verifier measured two active Annual Leave types in 9 of 10 concurrent attempts
    // before the advisory lock. The conflicting row is a DIFFERENT row, so only serialising the check works.
    await setArchived(b.annualLeaveTypeId, true);
    const one = await mkType('AL1', 'Annual Leave One');
    const two = await mkType('AL2', 'Annual Leave Two');
    for (let round = 0; round < 5; round++) {
      await owner.db.update(schema.leaveType).set({ role: null }).where(eq(schema.leaveType.id, one));
      await owner.db.update(schema.leaveType).set({ role: null }).where(eq(schema.leaveType.id, two));
      const results = await Promise.allSettled([
        updateLeaveType(ctx(), { id: one, name: 'Annual Leave One', isAnnualLeave: true }),
        setLeaveTypeRules(ctx(), { id: two, isAnnualLeave: true }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled'), `round ${round}: exactly one save wins`).toHaveLength(1);
      const roles = [(await rowOf(one)).role, (await rowOf(two)).role].filter((r) => r === 'annual');
      expect(roles, `round ${round}: exactly one active Annual Leave`).toHaveLength(1);
    }
  });

  it('an ANNUAL-coded type that CARRIES the role cannot be switched OFF either — the code would keep it Annual Leave', async () => {
    await owner.db.update(schema.leaveType).set({ role: 'annual' }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const e = await refusal(setLeaveTypeRules(ctx(), { id: b.annualLeaveTypeId, isAnnualLeave: false }));
    expect(e).toBeInstanceOf(LeaveTypeRuleError);
    expect((e as Error).message).toContain('by its code');
    expect((await rowOf(b.annualLeaveTypeId)).role).toBe('annual');
  });

  it('switching ON is refused while employees are blocked from applying — the statutory promise must be true on day one', async () => {
    await setArchived(b.annualLeaveTypeId, true);
    const al = await mkType('AL', '*Annual Leave');
    await owner.db.update(schema.leaveType).set({ employeeCanApply: false }).where(eq(schema.leaveType.id, al));
    const e = await refusal(updateLeaveType(ctx(), { id: al, name: '*Annual Leave', isAnnualLeave: true }));
    expect(e).toBeInstanceOf(LeaveTypeRuleError);
    expect((e as Error).message).toContain('blocked from applying');
    expect((await rowOf(al)).role).toBeNull();
    // CONTROL — allow applications and the same save goes through.
    await owner.db.update(schema.leaveType).set({ employeeCanApply: true }).where(eq(schema.leaveType.id, al));
    await updateLeaveType(ctx(), { id: al, name: '*Annual Leave', isAnnualLeave: true });
    expect((await rowOf(al)).role).toBe('annual');
  });

  it('an unclassified ANNUAL-coded type cannot be switched OFF — there is no role to clear', async () => {
    const e = await refusal(setLeaveTypeRules(ctx(), { id: b.annualLeaveTypeId, isAnnualLeave: false }));
    expect(e).toBeInstanceOf(LeaveTypeRuleError);
    expect((e as Error).message).toContain('by its code');
  });

  it('a STRANDED earned method is never rewritten: an unchanged re-post saves, a change to another earned method is refused', async () => {
    const sick = await mkType('SICK', 'Medical Leave');
    await setMethod(sick, 'earned_monthly'); // saved before this rule existed
    // The earning form re-posts the stored value verbatim on a rounding-only save.
    await setLeaveTypeRules(ctx(), { id: sick, accrualMethod: 'earned_monthly', accrualDay: 1, roundingMethod: null });
    expect((await rowOf(sick)).accrualMethod).toBe('earned_monthly');
    const e = await refusal(setLeaveTypeRules(ctx(), { id: sick, accrualMethod: 'earned_daily' }));
    expect(e).toBeInstanceOf(LeaveTypeRuleError);
    expect((await rowOf(sick)).accrualMethod).toBe('earned_monthly');
  });
});

describe('§4 Leave Balance Health — the stranded method is a BLOCKING finding', () => {
  const healthType = (over: Partial<HealthLeaveType> = {}): HealthLeaveType => ({
    id: 'lt-sick',
    name: 'Medical Leave',
    accrualMethod: 'earned_monthly',
    accrualUnconfigured: false,
    defaultEntitlementTemplateLineageId: null,
    archived: false,
    earnedMethodNotAnnualLeave: true,
    ...over,
  });
  const TABLE = [{ lineageId: 'l1', leaveTypeId: 'lt-sick', name: 'MC', validFrom: JAN, validTo: null, serviceBands: [{ days: 14 }] }];

  it('raises the finding on the flag, and not without it', () => {
    const stranded = leaveTypeConfigHealth({ leaveType: healthType(), templates: TABLE, rules: [], grades: [], today: TODAY });
    expect(stranded.findings).toContain('earned_method_not_annual_leave');
    expect(stranded.status).toBe('blocked');
    const fine = leaveTypeConfigHealth({
      leaveType: healthType({ earnedMethodNotAnnualLeave: false }),
      templates: TABLE,
      rules: [],
      grades: [],
      today: TODAY,
    });
    expect(fine.findings).not.toContain('earned_method_not_annual_leave');
    expect(fine.status).toBe('ready');
  });

  it('the page loader decides the flag with the engine’s predicates, per row', async () => {
    const sick = await mkType('SICK', 'Medical Leave');
    await setMethod(sick, 'earned_monthly');
    const alOff = await mkType('AL2', 'Annual Leave (old)');
    await setMethod(alOff, 'grant_on_hire_prorated');
    await setMethod(b.annualLeaveTypeId, 'earned_monthly');
    const data = await loadEntitlementTablesData(ctx());
    const flag = (id: string) => data.leaveTypes.find((x) => x.id === id)?.earnedMethodNotAnnualLeave;
    expect(flag(sick)).toBe(true); // earned, not Annual Leave
    expect(flag(b.annualLeaveTypeId)).toBe(false); // earned, Annual Leave by code
    expect(flag(alOff)).toBe(false); // not earned

    // …and it flips with the ROLE, which is what the switch writes.
    await owner.db.update(schema.leaveType).set({ role: 'annual' }).where(eq(schema.leaveType.id, sick));
    const again = await loadEntitlementTablesData(ctx());
    expect(again.leaveTypes.find((x) => x.id === sick)?.earnedMethodNotAnnualLeave).toBe(false);
  });

  it('the finding has a sentence in all six catalogues, rendered by the health card', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const et = JSON.parse(read(`messages/${loc}.json`)).admin.entitlementTemplates;
      expect(et.healthEarnedMethodNotAnnualLeave, loc).toBeTruthy();
    }
    expect(read('components/leave/leave-config-health.tsx')).toContain(
      "case 'earned_method_not_annual_leave':\n      return t('healthEarnedMethodNotAnnualLeave');",
    );
  });
});

describe('§5 the screens derive from the predicate — they do not restate it', () => {
  it('no screen, card or picker reads STANDING_LEAVE_CODES any more', () => {
    for (const rel of [
      'app/admin/leave-config/earned-accrual/page.tsx',
      'app/admin/leave-config/types/page.tsx',
      'app/admin/leave-config/types/leave-type-sub-forms.tsx',
      'components/earned-accrual-card.tsx',
      'components/leave/earned-accrual-dialog.tsx',
    ]) {
      expect(codeOf(read(rel)), rel).not.toContain('STANDING_LEAVE_CODES');
    }
  });

  it('Run Earned Accrual: one boolean per option, and the Annual Leave names, from the predicate', () => {
    const page = read('app/admin/leave-config/earned-accrual/page.tsx');
    expect(page).toContain("import { entitlementYearOptions, isEarnedAccrualType } from '@/core/leave';");
    expect(page).toContain('swept: isEarnedAccrualType(lt),');
    expect(page).toContain('const sweptLeaveTypeNames = accrualTypes');
  });

  it('the leave type editor: the switch state and the other Annual Leave names, from the server', () => {
    const page = read('app/admin/leave-config/types/page.tsx');
    expect(page).toContain('annualSwitch: annualLeaveSwitchState(lt),');
    expect(page).toContain('.filter((lt) => !lt.archivedAt && isEarnedAccrualType(lt))');
    expect(page).toContain('otherAnnualLeaveTypeNames: activeAnnualLeave.filter((a) => a.id !== lt.id).map((a) => a.name),');
  });

  it('the rules action forwards the switch only on its own marker', () => {
    const actions = read('app/admin/actions.ts');
    expect(actions).toContain("const annualLeaveRendered = formData.get('annualLeaveRendered') != null;");
    expect(actions).toContain("...(annualLeaveRendered ? { isAnnualLeave: formData.get('isAnnualLeave') === '1' } : {}),");
  });

  it('the engine’s filter is the predicate, over rows that carry the role', () => {
    const engine = read('core/leave.ts');
    const start = engine.indexOf('export async function accrueEarnedLeave(');
    const body = engine.slice(start, engine.indexOf('\n}\n', start));
    expect(body).toContain('const types = activeTypes.filter((t) => isEarnedAccrualType(t));');
    expect(codeOf(body)).not.toContain('STANDING_LEAVE_CODES');
    expect(body).toContain('role: leaveType.role, name: leaveType.name, yearCycleOverride');
  });
});

describe('§6 FIX PASS — a stranded type READS as stranded, and Annual Leave reads exactly as before', () => {
  // The facts of a type with a table in force and an earned method, before any accrual row.
  const earnedFacts = (over: Partial<Parameters<typeof resolveEntitlementStatus>[0]> = {}) => ({
    hasTemplateInForce: true,
    leaveTypeHasTemplates: true,
    maxBalanceDays: null as number | null,
    accrualUnconfigured: false,
    earnedMethod: true,
    earnedMethodNotAnnualLeave: false,
    entitlementDays: 12,
    hasAccrualRowInCycle: false,
    ...over,
  });

  it('PURE — stranded ⇒ its own status whatever the ledger, cap or days say; Annual Leave ⇒ the old answers', () => {
    for (const hasAccrualRowInCycle of [false, true]) {
      for (const maxBalanceDays of [null, 0, 30]) {
        for (const entitlementDays of [0, 12]) {
          const label = `row=${hasAccrualRowInCycle}/cap=${maxBalanceDays}/days=${entitlementDays}`;
          expect(
            resolveEntitlementStatus(earnedFacts({ earnedMethodNotAnnualLeave: true, hasAccrualRowInCycle, maxBalanceDays, entitlementDays })),
            label,
          ).toBe('earned_method_not_annual_leave');
        }
      }
    }
    // ANNUAL LEAVE ON THE SAME METHOD — the answers it always had.
    expect(resolveEntitlementStatus(earnedFacts())).toBe('earned_accrual');
    expect(resolveEntitlementStatus(earnedFacts({ hasAccrualRowInCycle: true }))).toBe('granted');
    expect(resolveEntitlementStatus(earnedFacts({ maxBalanceDays: 0 }))).toBe('capped_by_max_balance');
    // Unconfigured still outranks it (the engine's gate ignores the method), and so does an unresolved table.
    expect(resolveEntitlementStatus(earnedFacts({ earnedMethodNotAnnualLeave: true, accrualUnconfigured: true }))).toBe('earning_method_missing');
    expect(resolveEntitlementStatus(earnedFacts({ earnedMethodNotAnnualLeave: true, hasTemplateInForce: false }))).toBe('no_eligibility_match');
    // It is ANNOUNCED, with its own label and tip — never `earned_accrual`'s.
    expect(entitlementStatusNeedsNotice('earned_method_not_annual_leave')).toBe(true);
    expect(ENTITLEMENT_STATUS_LABEL_KEY.earned_method_not_annual_leave).toBe('statusEarnedMethodNotAnnualLeave');
    expect(ENTITLEMENT_STATUS_TIP_KEY.earned_method_not_annual_leave).toBe('statusEarnedMethodNotAnnualLeaveTip');
    expect(ENTITLEMENT_STATUS_LABEL_KEY.earned_accrual).toBe('statusEarnedAccrual');
    expect(ENTITLEMENT_STATUS_TIP_KEY.earned_accrual).toBe('statusEarnedAccrualTip');
  });

  for (const method of ['earned_monthly', 'earned_quarterly'] as const) {
    it(`THE BALANCE READ (${method}) — SICK is stranded; Annual Leave on the same method is earned_accrual, then granted`, async () => {
      const sick = await mkType('SICK', 'Medical Leave');
      for (const id of [sick, b.annualLeaveTypeId]) {
        await setMethod(id, method);
        await configure(id);
      }
      const { employmentId } = await hire();

      const sickBd = await leaveEntitlementBreakdown(ctx(), employmentId, sick, MID);
      const annualBd = await leaveEntitlementBreakdown(ctx(), employmentId, b.annualLeaveTypeId, MID);
      expect(sickBd!.entitlementStatus).toBe('earned_method_not_annual_leave');
      expect(annualBd!.entitlementStatus).toBe('earned_accrual');

      // A row the OLD sweep posted before Earned Accrual narrowed: the SICK figure is not "the answer", because
      // nothing will add to it; the same row on Annual Leave is `granted`, exactly as before.
      for (const leaveTypeId of [sick, b.annualLeaveTypeId]) {
        await owner.db.insert(schema.leaveLedger).values({
          tenantId: b.tenantId,
          employmentId,
          leaveTypeId,
          entryType: 'accrual',
          days: '1.00',
          effectiveOn: JAN,
        });
      }
      expect((await leaveEntitlementBreakdown(ctx(), employmentId, sick, MID))!.entitlementStatus).toBe(
        'earned_method_not_annual_leave',
      );
      expect((await leaveEntitlementBreakdown(ctx(), employmentId, b.annualLeaveTypeId, MID))!.entitlementStatus).toBe('granted');
    });
  }

  it('THE BALANCE READ asks the ROLE — the same SICK-coded row switched on as Annual Leave is no longer stranded', async () => {
    await setArchived(b.annualLeaveTypeId, true);
    const typeId = await mkType('SICK', 'Medical Leave');
    await setMethod(typeId, 'earned_monthly');
    await configure(typeId);
    const { employmentId } = await hire();
    expect((await leaveEntitlementBreakdown(ctx(), employmentId, typeId, MID))!.entitlementStatus).toBe(
      'earned_method_not_annual_leave',
    );
    await owner.db.update(schema.leaveType).set({ role: 'annual' }).where(eq(schema.leaveType.id, typeId));
    expect((await leaveEntitlementBreakdown(ctx(), employmentId, typeId, MID))!.entitlementStatus).toBe('earned_accrual');
  });

  it('GENERATE ENTITLEMENT — the stranded line is flagged, Annual Leave is not; the STORED outcome is unchanged', async () => {
    const sick = await mkType('SICK', 'Medical Leave');
    for (const id of [sick, b.annualLeaveTypeId]) {
      await setMethod(id, 'earned_monthly');
      await configure(id);
    }
    const { employmentId } = await hire();

    const engine = await openLeaveYear(ctx(), { year: YEAR, employmentIds: [employmentId], dryRun: true });
    const lineFor = (rows: { leaveTypeId: string; outcome: string; earnedMethodNotAnnualLeave: boolean }[], id: string) =>
      rows.filter((r) => r.leaveTypeId === id).map((r) => ({ outcome: r.outcome, flag: r.earnedMethodNotAnnualLeave }));
    expect(lineFor(engine.rows, sick)).toEqual([{ outcome: 'earned_method', flag: true }]);
    expect(lineFor(engine.rows, b.annualLeaveTypeId)).toEqual([{ outcome: 'earned_method', flag: false }]);
    // Every non-earned line carries false — the flag is a property of the earned branch only.
    expect(engine.rows.filter((r) => r.outcome !== 'earned_method').every((r) => r.earnedMethodNotAnnualLeave === false)).toBe(true);

    // The screen's preview carries the flag through to the line it labels.
    const req = { year: YEAR, targetMode: 'individual' as const, employmentIds: [employmentId] };
    const preview = await previewLeaveGeneration(ctx(), req);
    expect(lineFor(preview.lines, sick)).toEqual([{ outcome: 'earned_method', flag: true }]);
    expect(lineFor(preview.lines, b.annualLeaveTypeId)).toEqual([{ outcome: 'earned_method', flag: false }]);

    // NOT A NEW STORED VALUE: the processing log keeps the engine's outcome verbatim for both.
    const run = await runLeaveGeneration(ctx(), req);
    const stored = await owner.db
      .select({ leaveTypeId: schema.leaveGenerationRunItem.leaveTypeId, outcome: schema.leaveGenerationRunItem.outcome })
      .from(schema.leaveGenerationRunItem)
      .where(eq(schema.leaveGenerationRunItem.runId, run.runId!))
      .orderBy(asc(schema.leaveGenerationRunItem.leaveTypeId));
    expect(stored.filter((r) => r.leaveTypeId === sick).map((r) => r.outcome)).toEqual(['earned_method']);
    expect(stored.filter((r) => r.leaveTypeId === b.annualLeaveTypeId).map((r) => r.outcome)).toEqual(['earned_method']);
    const csv = await leaveGenerationRunCsv(ctx(), { runId: run.runId! });
    expect(csv.content).not.toContain('not_annual');
  });

  it('COPY — the five new strings exist in all six catalogues, translated, with the body placeholder kept', () => {
    const en = JSON.parse(read('messages/en.json'));
    const pick = (m: Record<string, any>) => ({
      label: m.me.leaveBalanceTable.statusEarnedMethodNotAnnualLeave,
      tip: m.me.leaveBalanceTable.statusEarnedMethodNotAnnualLeaveTip,
      title: m.leave.breakdown.statusEarnedMethodNotAnnualLeaveTitle,
      body: m.leave.breakdown.statusEarnedMethodNotAnnualLeaveBody,
      gen: m.admin.leave.generateOutcomeEarnedMethodNotAnnualLeave,
    });
    const base = pick(en);
    // ANNUAL LEAVE'S OWN STRINGS ARE UNTOUCHED, byte for byte.
    expect(en.me.leaveBalanceTable.statusEarnedAccrual).toBe('Accrues through the year');
    expect(en.admin.leave.generateOutcome_earned_method).toBe(
      'Earned monthly, so it accrues through the year instead of being granted now',
    );
    // …and the stranded copy never borrows the accruing promise.
    for (const v of Object.values(base)) {
      expect(v).not.toContain('accrues through the year');
      expect(v).not.toContain('as each accrual run posts them');
    }
    expect(base.tip).toContain('Earning Method step');
    expect(base.body).toContain('{typeName}');
    for (const loc of ['ms', 'ta', 'th', 'vi', 'zh']) {
      const got = pick(JSON.parse(read(`messages/${loc}.json`)));
      for (const k of Object.keys(base) as (keyof typeof base)[]) {
        expect(typeof got[k], `${loc} ${k}`).toBe('string');
        expect(got[k], `${loc} ${k} is the English string`).not.toBe(base[k]);
      }
      expect(got.body, `${loc} body lost {typeName}`).toContain('{typeName}');
    }
  });

  it('SOURCE — every screen reads the SERVER’s decision; no client component restates the predicate', () => {
    const readSrc = read('core/read.ts');
    expect(readSrc).toContain('earnedMethodNotAnnualLeave: earned && !isEarnedAccrualType(type),');
    const engine = read('core/leave.ts');
    expect(engine).toContain("rows.push(logRow(e.employmentId, t.id, 'earned_method', !isEarnedAccrualType(t)));");
    const form = read('components/leave/generate-form.tsx');
    expect(form).toContain('{l.earnedMethodNotAnnualLeave');
    expect(form).toContain("? t('generateOutcomeEarnedMethodNotAnnualLeave')");
    for (const rel of [
      'components/leave/generate-form.tsx',
      'components/leave/LeaveDetailsPanel.tsx',
      'components/leave/leave-balance-table.tsx',
      'lib/entitlement-status.ts',
    ]) {
      const code = codeOf(read(rel));
      expect(code, rel).not.toContain('isEarnedAccrualType');
      expect(code, rel).not.toMatch(/'earned_(monthly|quarterly|daily)'/);
    }
  });
});

describe('§7 FIX PASS — a stranded LEGACY method can be replaced, and is still never rewritten unasked', () => {
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error('expected the save to be refused, and it was accepted');
  };

  it('earned_quarterly on SICK: re-posted unchanged it saves; None is ACCEPTED; another earned method is refused', async () => {
    const sick = await mkType('SICK', 'Medical Leave');
    await setMethod(sick, 'earned_quarterly');
    // The select's `legacy` choice re-posts the stored value verbatim on a rounding-only save.
    await setLeaveTypeRules(ctx(), { id: sick, accrualMethod: 'earned_quarterly', accrualDay: null, roundingMethod: null });
    expect((await rowOf(sick)).accrualMethod).toBe('earned_quarterly');
    // A CHANGE to an earned method is still refused on a type that is not Annual Leave.
    const e = await refusal(setLeaveTypeRules(ctx(), { id: sick, accrualMethod: 'earned_monthly', accrualDay: 1 }));
    expect(e).toBeInstanceOf(LeaveTypeRuleError);
    expect((await rowOf(sick)).accrualMethod).toBe('earned_quarterly');
    // THE FIX THE NOTE AND THE HEALTH FINDING NAME — None — goes through.
    await setLeaveTypeRules(ctx(), { id: sick, accrualMethod: 'grant_on_hire_prorated', accrualDay: null, roundingMethod: null });
    expect((await rowOf(sick)).accrualMethod).toBe('grant_on_hire_prorated');
    // …and the balance read stops calling it stranded.
    await configure(sick);
    const { employmentId } = await hire();
    expect((await leaveEntitlementBreakdown(ctx(), employmentId, sick, MID))!.entitlementStatus).not.toBe(
      'earned_method_not_annual_leave',
    );
  });

  it('an UNCONFIGURED type holding earned_quarterly: the Not configured placeholder’s save (method empty) is accepted and keeps the marker', async () => {
    const sick = await mkType('SICK', 'Medical Leave');
    await owner.db
      .update(schema.leaveType)
      .set({ accrualMethod: 'earned_quarterly' as never, accrualUnconfigured: new Date() })
      .where(eq(schema.leaveType.id, sick));
    await setLeaveTypeRules(ctx(), { id: sick, accrualMethod: null, accrualDay: null, roundingMethod: null });
    const [row] = await owner.db
      .select({ accrualMethod: schema.leaveType.accrualMethod, accrualUnconfigured: schema.leaveType.accrualUnconfigured })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, sick));
    expect(row.accrualMethod).toBeNull();
    expect(row.accrualUnconfigured).not.toBeNull();
  });
});
