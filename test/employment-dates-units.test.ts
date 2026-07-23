/**
 * Enhance Employment Dates Management (feedback 955c7de4).
 *
 * The Employment Dates card was redesigned: each period is now a value + unit ('month'|'week'|'day') pair, and
 * the full lifecycle is captured — extended probation, extended/final confirmation dates, tender resignation
 * and last working date. Covers: value+unit persistence + employeeDetail projection; the DERIVED
 * finalConfirmationDate (= extendedConfirmationDate ?? confirmationDate) recomputed + audited on save; unit
 * membership + non-negative validation; the lifecycle date-ordering guards; the audited
 * employment.info.updated before/after carrying the new fields; backward-compat (all-null legacy row);
 * and admin gating.
 *
 * d27961e3 — Extended/Final Confirmation Date were removed from the Employment Dates card; probation
 * extensions are managed EXCLUSIVELY through the Movement module. setEmploymentInfo now honours
 * extendedConfirmationDate only under the `probationExtension` movement tag (how createMovementEvent calls
 * it) — the tagged calls below exercise that path; the derivation itself is unchanged. Forge-proofing of
 * the untagged path is covered in test/employment-dates-simplify.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { type SessionContext } from '../db/client';
import { hireEmployee, setEmploymentInfo } from '../core/org';
import { employeeDetail } from '../core/read';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

async function hire(name = 'Dates Test', hiredOn = '2020-01-01') {
  const r = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  return { id: r.employmentId };
}

/** d27961e3 — the movement-writer shape: extendedConfirmationDate rides the probationExtension tag ('' clears). */
const extendProbation = (employmentId: string, endDate: string) =>
  setEmploymentInfo(adminCtx(b), {
    employmentId,
    extendedConfirmationDate: endDate,
    movement: { type: 'probationExtension', ...(endDate ? { endDate } : {}) },
  });

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('setEmploymentInfo — Employment Dates value+unit + lifecycle (955c7de4)', () => {
  it('persists each period as a value + unit and projects them via employeeDetail', async () => {
    const e = await hire('Persist');
    await setEmploymentInfo(adminCtx(b), {
      employmentId: e.id,
      probationValue: 3,
      probationUnit: 'month',
      extendedProbationValue: 2,
      extendedProbationUnit: 'week',
      noticeBeforeConfirmationValue: 14,
      noticeBeforeConfirmationUnit: 'day',
      noticeAfterConfirmationValue: 1,
      noticeAfterConfirmationUnit: 'month',
    });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.probationValue).toBe(3);
    expect(d!.probationUnit).toBe('month');
    expect(d!.extendedProbationValue).toBe(2);
    expect(d!.extendedProbationUnit).toBe('week');
    expect(d!.noticeBeforeConfirmationValue).toBe(14);
    expect(d!.noticeBeforeConfirmationUnit).toBe('day');
    expect(d!.noticeAfterConfirmationValue).toBe(1);
    expect(d!.noticeAfterConfirmationUnit).toBe('month');
  });

  it('persists the lifecycle dates', async () => {
    const e = await hire('Lifecycle');
    await setEmploymentInfo(adminCtx(b), {
      employmentId: e.id,
      confirmationDate: '2020-04-01',
      tenderResignationDate: '2026-01-05',
      resignationDate: '2026-02-05',
      lastWorkingDate: '2026-02-28',
    });
    // d27961e3 — the extension is movement-only now; it persists via the tagged (movement-writer) path.
    await extendProbation(e.id, '2020-06-01');
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.confirmationDate).toBe('2020-04-01');
    expect(d!.extendedConfirmationDate).toBe('2020-06-01');
    expect(d!.tenderResignationDate).toBe('2026-01-05');
    expect(d!.resignationDate).toBe('2026-02-05');
    expect(d!.lastWorkingDate).toBe('2026-02-28');
  });

  it('derives finalConfirmationDate = extended when present', async () => {
    const e = await hire('FinalExtended');
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, confirmationDate: '2020-04-01' });
    await extendProbation(e.id, '2020-06-01');
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.finalConfirmationDate).toBe('2020-06-01');
  });

  it('derives finalConfirmationDate = confirmation when no extension, and re-derives when extension cleared', async () => {
    const e = await hire('FinalPlain');
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, confirmationDate: '2020-04-01' });
    let d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.finalConfirmationDate).toBe('2020-04-01');
    // Add an extension → final follows it.
    await extendProbation(e.id, '2020-07-01');
    d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.finalConfirmationDate).toBe('2020-07-01');
    // Clear the extension → final falls back to the normal confirmation date.
    await extendProbation(e.id, '');
    d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.finalConfirmationDate).toBe('2020-04-01');
  });

  it('rejects an invalid period unit', async () => {
    const e = await hire('BadUnit');
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: e.id, probationValue: 3, probationUnit: 'year' }),
    ).rejects.toThrow(/unit/i);
  });

  it('accepts unit case-insensitively and normalises to lowercase', async () => {
    const e = await hire('CaseUnit');
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, probationValue: 3, probationUnit: 'Month' });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.probationUnit).toBe('month');
  });

  it('rejects a negative period value', async () => {
    const e = await hire('NegValue');
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: e.id, probationValue: -1, probationUnit: 'month' }),
    ).rejects.toThrow(/whole numbers/i);
  });

  it('rejects tender resignation later than resignation', async () => {
    const e = await hire('TenderOrder');
    await expect(
      setEmploymentInfo(adminCtx(b), {
        employmentId: e.id,
        tenderResignationDate: '2026-03-01',
        resignationDate: '2026-02-01',
      }),
    ).rejects.toThrow(/tender/i);
  });

  it('rejects resignation later than last working date', async () => {
    const e = await hire('LastWorkingOrder');
    await expect(
      setEmploymentInfo(adminCtx(b), {
        employmentId: e.id,
        resignationDate: '2026-03-01',
        lastWorkingDate: '2026-02-01',
      }),
    ).rejects.toThrow(/last working/i);
  });

  it('rejects extended confirmation earlier than confirmation (movement path)', async () => {
    const e = await hire('ExtConfOrder');
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, confirmationDate: '2020-06-01' });
    await expect(extendProbation(e.id, '2020-04-01')).rejects.toThrow(/extended confirmation/i);
  });

  it('validates ordering against stored siblings across separate saves', async () => {
    const e = await hire('CrossSave');
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, resignationDate: '2026-02-01' });
    // A later save of only the last working date must still be checked against the stored resignation date.
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: e.id, lastWorkingDate: '2026-01-01' }),
    ).rejects.toThrow(/last working/i);
  });

  it('appends employment.info.updated with the new fields in before/after', async () => {
    const e = await hire('Audit');
    await setEmploymentInfo(adminCtx(b), {
      employmentId: e.id,
      probationValue: 3,
      probationUnit: 'month',
      confirmationDate: '2020-04-01',
      lastWorkingDate: '2026-02-28',
    });
    const types = await eventTypesFor(b.tenantId, e.id);
    expect(types).toContain('employment.info.updated');
    const payload = await latestEventPayload(b.tenantId, e.id, 'employment.info.updated');
    const fields = payload!.fields as string[];
    expect(fields).toContain('probationValue');
    expect(fields).toContain('probationUnit');
    const before = payload!.before as Record<string, unknown>;
    const after = payload!.after as Record<string, unknown>;
    expect(before.probationValue).toBeNull();
    expect(after.probationValue).toBe(3);
    expect(after.finalConfirmationDate).toBe('2020-04-01'); // derived (= confirmation, no extension)

    // d27961e3 — a movement-tagged extension is audited the same way, with the derived final following it.
    await extendProbation(e.id, '2020-06-01');
    const extPayload = await latestEventPayload(b.tenantId, e.id, 'employment.info.updated');
    const extFields = extPayload!.fields as string[];
    expect(extFields).toContain('extendedConfirmationDate');
    expect(extFields).toContain('finalConfirmationDate'); // derived field also audited
    const extAfter = extPayload!.after as Record<string, unknown>;
    expect(extAfter.finalConfirmationDate).toBe('2020-06-01');
    expect((extPayload!.movement as Record<string, unknown>).type).toBe('probationExtension');
  });

  it('is backward compatible: a legacy employment reads every new field as null', async () => {
    const e = await hire('Legacy');
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.probationValue).toBeNull();
    expect(d!.probationUnit).toBeNull();
    expect(d!.extendedProbationValue).toBeNull();
    expect(d!.noticeBeforeConfirmationValue).toBeNull();
    expect(d!.noticeAfterConfirmationValue).toBeNull();
    expect(d!.extendedConfirmationDate).toBeNull();
    expect(d!.finalConfirmationDate).toBeNull();
    expect(d!.tenderResignationDate).toBeNull();
    expect(d!.lastWorkingDate).toBeNull();
  });

  it('rejects a non-admin caller', async () => {
    const e = await hire('NonAdmin');
    const nonAdmin: SessionContext = { tenantId: b.tenantId, userId: b.adminUserId, roles: ['employee'] };
    await expect(
      setEmploymentInfo(nonAdmin, { employmentId: e.id, probationValue: 3, probationUnit: 'month' }),
    ).rejects.toThrow(/admin/i);
  });
});
