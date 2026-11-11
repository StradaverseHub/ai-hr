/**
 * Board 2260a06b — Contract End Date and Internship End Date through the whole employee lifecycle.
 *
 * Draft activation keeps both dates; the Employment tab writer (setEmploymentInfo) maintains them per type;
 * Employment Movement, Correct Hire Details and Information-Only Correction carry them; a change to Intern no
 * longer always fails; an open contract renewal refuses contract date edits from those places; the employee
 * import refuses an internship date for a non-Intern row; and the backfill fills pre-release interns from the
 * provisional date. Fictional people only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, setEmploymentInfo } from '../core/org';
import { employeeDetail } from '../core/read';
import { computeReviewWindow } from '../core/employment-review';
import { createMovementEvent, movementDetail, movementHistory, reverseMovementEvent } from '../core/movement';
import { sweepDueMovements } from '../core/movement-apply';
import { correctHireDetails, hireCorrectionView } from '../core/hire-correction';
import { correctInformation, previewInformationCorrection } from '../core/information-correction';
import { backfillInternshipEndDates } from '../scripts/backfill-internship-end-date';
import { INFORMATION_HEADERS_V2 } from '../lib/information-correction';
import { IMPORT_COLUMNS } from '../lib/import-schema';
import { MOVEMENT_RULE_FIELDS } from '../lib/movement-field-rules';
import { todayInKualaLumpur } from '../lib/hr-date';
import type { InformationChanges } from '../lib/information-correction';

let b: Base;
const ctx = () => adminCtx(b);
const plusDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const TODAY = todayInKualaLumpur();
const PAST = plusDays(TODAY, -30);
const FUTURE = plusDays(TODAY, 30);

async function hire(type: 'full_time' | 'part_time' | 'contract' | 'intern', provisionalEndOn: string | null = null) {
  return hireEmployee(ctx(), {
    person: { fullName: 'Siti Fixture', primaryEmail: `ed_${randomUUID().slice(0, 8)}@example.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: type,
    hiredOn: '2026-01-01',
    provisionalEndOn,
  });
}
const row = (id: string) =>
  owner.db.select().from(schema.employment).where(eq(schema.employment.id, id)).limit(1).then((r) => r[0]);
const openType = (id: string) =>
  owner.db
    .select({ type: schema.assignment.employmentType })
    .from(schema.assignment)
    .where(and(eq(schema.assignment.employmentId, id), sql`valid_to is null and superseded_at is null`))
    .then((r) => r[0]?.type);
async function correction(id: string, changes: InformationChanges, reason = 'Correct the signed employment record') {
  const p = await previewInformationCorrection(ctx(), { employmentId: id, changes, reason });
  return correctInformation(ctx(), { employmentId: id, changes, reason, fingerprint: p.fingerprint, method: 'manual' });
}
async function openRenewal(employmentId: string, state = 'decision_pending') {
  const termId = randomUUID();
  await owner.db.execute(sql`insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision)
    values(${termId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employmentId}::uuid,1,'project','2026-01-01','2026-12-31','fixture')`);
  await owner.db.execute(sql`insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data)
    values(gen_random_uuid(),${b.tenantId}::uuid,${b.companyId}::uuid,${employmentId}::uuid,${termId}::uuid,${'CC-' + randomUUID().slice(0, 6)},1,
    ${JSON.stringify({ revision: 1, state })}::jsonb)`);
}

beforeAll(() => migrateTestDb());
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('2260a06b · activation and the Employment tab', () => {
  it('keeps the Draft end date on activation for an intern and a contract hire, but not for full-time', async () => {
    const intern = await hire('intern', '2026-12-31');
    const contract = await hire('contract', '2027-06-30');
    const full = await hire('full_time', '2026-04-01');
    expect(await row(intern.employmentId)).toMatchObject({ internshipEndDate: '2026-12-31', provisionalEndOn: '2026-12-31', contractEndDate: null });
    expect(await row(contract.employmentId)).toMatchObject({ contractEndDate: '2027-06-30', contractStartDate: '2026-01-01', internshipEndDate: null });
    expect(await row(full.employmentId)).toMatchObject({ internshipEndDate: null, contractEndDate: null, provisionalEndOn: '2026-04-01' });
    expect((await employeeDetail(ctx(), intern.employmentId))!.internshipEndDate).toBe('2026-12-31');
    // The internship review reads the typed column; its due date is unchanged from the provisional fallback.
    const r = await row(intern.employmentId);
    expect(computeReviewWindow('intern', r)).toEqual(computeReviewWindow('intern', { ...r, internshipEndDate: null }));
  });

  it('maintains the internship date with the same checks, and keeps the provisional copy aligned', async () => {
    const intern = await hire('intern', '2026-12-31');
    await setEmploymentInfo(ctx(), { employmentId: intern.employmentId, internshipEndDate: '2027-01-31' });
    expect(await row(intern.employmentId)).toMatchObject({ internshipEndDate: '2027-01-31', provisionalEndOn: '2027-01-31' });
    await expect(setEmploymentInfo(ctx(), { employmentId: intern.employmentId, internshipEndDate: null }))
      .rejects.toThrow('Internship end date is required for an intern employee.');
    await expect(setEmploymentInfo(ctx(), { employmentId: intern.employmentId, internshipEndDate: '2025-12-31' }))
      .rejects.toThrow('Internship end date must be later than the join date.');
    const full = await hire('full_time', '2026-04-01');
    await expect(setEmploymentInfo(ctx(), { employmentId: full.employmentId, internshipEndDate: '2026-12-31' }))
      .rejects.toThrow('Internship end date applies only to Intern employees.');
    // A full-time provisional (probation) date is never moved by these writers.
    expect((await row(full.employmentId)).provisionalEndOn).toBe('2026-04-01');
  });

  it('refuses a contract date change while a renewal is open, but still accepts an unchanged re-save', async () => {
    const contract = await hire('contract', '2026-12-31');
    await openRenewal(contract.employmentId);
    await expect(setEmploymentInfo(ctx(), { employmentId: contract.employmentId, contractStartDate: '2026-01-01', contractEndDate: '2027-03-31' }))
      .rejects.toThrow('A contract renewal is in progress');
    await setEmploymentInfo(ctx(), { employmentId: contract.employmentId, contractStartDate: '2026-01-01', contractEndDate: '2026-12-31', contractRemark: 'Unchanged dates' });
    expect((await row(contract.employmentId)).contractRemark).toBe('Unchanged dates');
  });

  it('allows the change once the renewal is closed', async () => {
    const contract = await hire('contract', '2026-12-31');
    await openRenewal(contract.employmentId, 'renewed');
    await setEmploymentInfo(ctx(), { employmentId: contract.employmentId, contractStartDate: '2026-01-01', contractEndDate: '2027-03-31' });
    expect((await row(contract.employmentId)).contractEndDate).toBe('2027-03-31');
  });
});

describe('2260a06b · Employment Movement', () => {
  it('offers both dates in Field Controls and asks for the matching date when the type changes', async () => {
    expect(MOVEMENT_RULE_FIELDS).toEqual(expect.arrayContaining(['contractEndDate', 'internshipEndDate']));
    const intern = await hire('intern', '2026-12-31');
    await expect(createMovementEvent(ctx(), { employmentId: intern.employmentId, kind: 'employmentTypeChange', effectiveDate: PAST, employmentType: 'contract' }))
      .rejects.toThrow('Contract end date is required when the employment type changes to Contract.');
    await expect(createMovementEvent(ctx(), { employmentId: intern.employmentId, kind: 'employmentTypeChange', effectiveDate: PAST, employmentType: 'contract', contractEndDate: PAST }))
      .rejects.toThrow('Contract end date must be later than the effective date.');
    expect(await openType(intern.employmentId)).toBe('intern');
  });

  it('changes Intern to Contract with the new contract period, records it in history, and rolls it back', async () => {
    const intern = await hire('intern', '2026-12-31');
    await createMovementEvent(ctx(), {
      employmentId: intern.employmentId, kind: 'employmentTypeChange', effectiveDate: PAST,
      employmentType: 'contract', contractEndDate: '2027-12-31',
      // A date for the type the employee is leaving is ignored, never stored.
      internshipEndDate: '2030-01-01',
    });
    expect(await openType(intern.employmentId)).toBe('contract');
    expect(await row(intern.employmentId)).toMatchObject({ contractStartDate: PAST, contractEndDate: '2027-12-31', internshipEndDate: '2026-12-31' });
    const move = (await movementHistory(ctx(), intern.employmentId)).find((r) => r.kind === 'employmentTypeChange')!;
    const detail = await movementDetail(ctx(), intern.employmentId, move.id);
    expect(detail!.flatChanges).toEqual(expect.arrayContaining([
      { field: 'contractEndDate', before: null, after: '2027-12-31' },
      { field: 'contractStartDate', before: null, after: PAST },
    ]));
    expect(move.canReverse).toBe(true);
    await reverseMovementEvent(ctx(), { employmentId: intern.employmentId, movementId: move.id, reason: 'Recorded against the wrong intern' });
    expect(await openType(intern.employmentId)).toBe('intern');
    expect(await row(intern.employmentId)).toMatchObject({ contractStartDate: null, contractEndDate: null, internshipEndDate: '2026-12-31' });
  });

  it('moves an existing contract end date without a type change and validates it against the start', async () => {
    const contract = await hire('contract', '2026-12-31');
    await createMovementEvent(ctx(), { employmentId: contract.employmentId, kind: 'promotion', effectiveDate: PAST, contractEndDate: '2027-06-30' });
    expect((await row(contract.employmentId)).contractEndDate).toBe('2027-06-30');
    await expect(createMovementEvent(ctx(), { employmentId: contract.employmentId, kind: 'promotion', effectiveDate: PAST, contractEndDate: '2025-06-30' }))
      .rejects.toThrow('Contract end date must be later than the contract start date.');
  });

  it('holds a future change to Intern pending and applies the internship date on its effective date', async () => {
    const full = await hire('full_time', '2026-04-01');
    await createMovementEvent(ctx(), { employmentId: full.employmentId, kind: 'employmentTypeChange', effectiveDate: FUTURE, employmentType: 'intern', internshipEndDate: plusDays(FUTURE, 90) });
    expect(await row(full.employmentId)).toMatchObject({ internshipEndDate: null });
    expect(await openType(full.employmentId)).toBe('full_time');
    expect((await sweepDueMovements(ctx(), { today: FUTURE })).applied).toBe(1);
    expect(await openType(full.employmentId)).toBe('intern');
    expect((await row(full.employmentId)).internshipEndDate).toBe(plusDays(FUTURE, 90));
  });

  it('refuses a contract end date change through a movement while a renewal is open', async () => {
    const contract = await hire('contract', '2026-12-31');
    await openRenewal(contract.employmentId);
    await expect(createMovementEvent(ctx(), { employmentId: contract.employmentId, kind: 'promotion', effectiveDate: PAST, contractEndDate: '2027-06-30' }))
      .rejects.toThrow('A contract renewal is in progress');
  });
});

describe('2260a06b · Correct Hire Details', () => {
  it('offers and corrects only the current type end date, without touching Employee Type', async () => {
    const intern = await hire('intern', '2026-12-31');
    expect((await hireCorrectionView(ctx(), intern.employmentId)).endDate).toMatchObject({ field: 'internshipEndDate', value: '2026-12-31' });
    await expect(correctHireDetails(ctx(), { employmentId: intern.employmentId, changes: {}, endDates: { contractEndDate: '2027-01-31' }, reason: 'Wrong field' }))
      .rejects.toThrow("does not apply to this employee's current Employee Type");
    const res = await correctHireDetails(ctx(), { employmentId: intern.employmentId, changes: {}, endDates: { internshipEndDate: '2027-02-28' }, reason: 'Keyed the wrong internship end' });
    expect(res.endDateChange).toEqual({ field: 'internshipEndDate', before: '2026-12-31', after: '2027-02-28' });
    expect(await row(intern.employmentId)).toMatchObject({ internshipEndDate: '2027-02-28', provisionalEndOn: '2027-02-28' });
    expect(await openType(intern.employmentId)).toBe('intern');
    expect((await hireCorrectionView(ctx(), (await hire('full_time')).employmentId)).endDate).toBeUndefined();
  });
});

describe('2260a06b · Information-Only Correction', () => {
  it('changes the type to Intern with its date in one correction and creates no movement event', async () => {
    const full = await hire('full_time', '2026-04-01');
    const before = (await movementHistory(ctx(), full.employmentId)).length;
    await expect(correction(full.employmentId, { employmentType: 'intern' })).rejects.toThrow('Intern employment requires an internship end date.');
    await expect(correction(full.employmentId, { employmentType: 'full_time', internshipEndDate: '2026-12-31' })).rejects.toThrow('Internship End Date applies only to Intern employees.');
    const saved = await correction(full.employmentId, { employmentType: 'intern', internshipEndDate: '2026-12-31' });
    expect(saved.changed).toBe(true);
    expect(saved.preview.changed).toEqual(['employmentType', 'internshipEndDate']);
    expect(await openType(full.employmentId)).toBe('intern');
    expect((await row(full.employmentId)).internshipEndDate).toBe('2026-12-31');
    expect((await movementHistory(ctx(), full.employmentId)).length).toBe(before);
    const events = await owner.db.select({ type: schema.domainEvent.eventType }).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.subjectEmploymentId, full.employmentId), eq(schema.domainEvent.eventType, 'employment.information.corrected')));
    expect(events).toHaveLength(1);
  });

  it('corrects a contract end date and refuses it while a renewal is open; the workbook carries both columns', async () => {
    expect(INFORMATION_HEADERS_V2).toEqual(expect.arrayContaining(['Contract End Date', 'Internship End Date']));
    const contract = await hire('contract', '2026-12-31');
    await correction(contract.employmentId, { contractEndDate: '2027-01-31' });
    expect((await row(contract.employmentId)).contractEndDate).toBe('2027-01-31');
    await expect(correction(contract.employmentId, { contractEndDate: '2025-12-31' })).rejects.toThrow();
    await openRenewal(contract.employmentId);
    await expect(correction(contract.employmentId, { contractEndDate: '2027-03-31' })).rejects.toThrow('A contract renewal is in progress');
  });
});

describe('2260a06b · imports and backfill', () => {
  it('offers internship_end_date on the employee import template', () => {
    expect(IMPORT_COLUMNS.optional).toEqual(expect.arrayContaining(['internship_end_date', 'contract_end_date']));
  });

  it('fills a pre-release intern from the provisional date, leaves others alone, and is re-runnable', async () => {
    const legacy = await hire('intern', '2026-12-31');
    const kept = await hire('intern', '2026-10-31');
    const full = await hire('full_time', '2026-04-01');
    // Reproduce the pre-release shape: the typed column was never written at activation.
    await owner.db.update(schema.employment).set({ internshipEndDate: null }).where(eq(schema.employment.id, legacy.employmentId));
    await owner.db.update(schema.employment).set({ internshipEndDate: '2026-11-30' }).where(eq(schema.employment.id, kept.employmentId));
    const dry = await backfillInternshipEndDates(owner.db, { apply: false });
    expect(dry).toEqual({ before: 1, written: 0, after: 1 });
    expect((await row(legacy.employmentId)).internshipEndDate).toBeNull();
    expect(await backfillInternshipEndDates(owner.db, { apply: true, batch: 1 })).toEqual({ before: 1, written: 1, after: 0 });
    expect((await row(legacy.employmentId)).internshipEndDate).toBe('2026-12-31');
    expect((await row(kept.employmentId)).internshipEndDate).toBe('2026-11-30');
    expect((await row(full.employmentId)).internshipEndDate).toBeNull();
    expect(await backfillInternshipEndDates(owner.db, { apply: true })).toEqual({ before: 0, written: 0, after: 0 });
  });
});
