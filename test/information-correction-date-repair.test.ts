import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { appendEvents } from '../db/events';
import { assignment, domainEvent, employment, reportingLine } from '../db/schema';
import { informationCorrectionHistory } from '../core/information-correction';
import { createMovementEvent, movementDetail } from '../core/movement';
import { hireEmployee, ReportingLineAfterTerminationError, setReportingLine } from '../core/org';
import { applyManifest, createManifest, planCorrectionDateAlignments } from '../scripts/repair-information-correction-dates';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});

async function hire(code: string) {
  return (await hireEmployee(adminCtx(base), {
    person: { fullName: 'Date Repair ' + code, primaryEmail: code + '@fixture.test' },
    employeeCode: code,
    companyId: base.companyId,
    departmentId: base.deptA,
    positionId: base.positionId,
    employmentType: 'full_time',
    hiredOn: '2025-01-01',
  })).employmentId;
}

it('aligns all late dates once while preserving the original records and the reporting-line refusal', async () => {
  const ctx = adminCtx(base);
  const id = await hire('date-repair-subject');
  const managerId = await hire('date-repair-manager');
  const unrelatedId = await hire('date-repair-other');
  const cutoff = '2025-03-01';
  await createMovementEvent(ctx, {
    employmentId: id, kind: 'transfer', effectiveDate: cutoff, departmentId: base.deptB,
  });
  await setReportingLine(ctx, {
    subordinateEmploymentId: id, managerEmploymentId: managerId,
    lineType: 'administrative', validFrom: '2025-03-16',
  });
  const dates = ['2025-02-15', cutoff, '2025-03-15', '2025-03-20', '2025-03-25'];
  await owner.withTenant(ctx, tx => appendEvents(tx,
    [...dates.map(effectiveOn => ({ effectiveOn, subject: id })), { effectiveOn: '2025-03-20', subject: unrelatedId }]
      .map(({ effectiveOn, subject }, index) => ({
        tenantId: base.tenantId,
        aggregateId: subject,
        aggregateType: 'employment',
        subjectEmploymentId: subject,
        eventType: 'employment.information.corrected',
        actor: { type: 'user', id: base.adminUserId },
        payload: { effectiveOn, method: 'manual', fields: ['orgDivision'], after: { orgDivision: 'Value ' + index } },
      }))));
  const termination = () => createMovementEvent(ctx, {
    employmentId: id, kind: 'termination', effectiveDate: '2025-03-09',
    endDate: '2025-03-09', terminationReasonCode: 'redundancy',
  });
  await expect(termination()).rejects.toBeInstanceOf(ReportingLineAfterTerminationError);
  const originalEvents = () => owner.db.select().from(domainEvent).where(and(
    eq(domainEvent.subjectEmploymentId, id),
    eq(domainEvent.eventType, 'employment.information.corrected'),
  )).orderBy(asc(domainEvent.sequence));
  const physicalState = async () => ({
    employment: await owner.db.select().from(employment).where(eq(employment.id, id)),
    assignments: await owner.db.select().from(assignment).where(eq(assignment.employmentId, id)).orderBy(assignment.id),
    lines: await owner.db.select().from(reportingLine).where(eq(reportingLine.subordinateEmploymentId, id)).orderBy(reportingLine.id),
  });
  const original = await originalEvents();
  const before = await physicalState();
  const database = 'fictional-fixture';
  const manifest = await createManifest(owner, database, base.tenantId, base.adminUserId, id);
  expect(manifest.subjects).toHaveLength(1);
  expect(manifest.subjects[0].corrections.map(row => row.originalEffectiveOn).sort()).toEqual(dates.slice(2));
  const stale = structuredClone(manifest);
  stale.subjects[0].corrections[0].movementId = managerId;
  await expect(applyManifest(owner, stale)).rejects.toThrow('latest applied Movement Event changed');
  expect(await applyManifest(owner, manifest)).toEqual({ written: 3, alreadyAligned: 0 });
  expect(await applyManifest(owner, manifest)).toEqual({ written: 0, alreadyAligned: 3 });
  expect(await originalEvents()).toEqual(original);
  expect(await physicalState()).toEqual(before);
  const history = (await informationCorrectionHistory(ctx, id)).map(event => event.payload as { effectiveOn: string; after: unknown });
  expect(history.map(event => event.effectiveOn)).toEqual([cutoff, cutoff, cutoff, cutoff, dates[0]]);
  expect(history.map(event => event.after)).toEqual([...original].reverse().map(row => (row.payload as { after: unknown }).after));
  expect(((await informationCorrectionHistory(ctx, unrelatedId))[0].payload as { effectiveOn: string }).effectiveOn).toBe('2025-03-20');
  const movementId = manifest.subjects[0].corrections[0].movementId;
  const detail = await movementDetail(ctx, id, movementId);
  expect(detail?.after.informationEvidence?.orgDivision.value).toBe('Value 4');
  await expect(termination()).rejects.toBeInstanceOf(ReportingLineAfterTerminationError);
  expect(await physicalState()).toEqual(before);
});

it('requires a recorded applied Movement Event before planning amendments', () => {
  expect(planCorrectionDateAlignments([
    { id: 'correction', originalDate: '2025-03-20', alignedDate: null, alignmentMovementId: null },
  ], null)).toEqual([]);
});
