/**
 * Employment Information enhancement (2323f671) — setEmploymentInfo writer.
 *
 * Covers: new-field persistence + employeeDetail projection; the audited `employment.info.updated` event
 * with a before/after diff; date-relationship validation (confirmation ≥ hire, resignation ≥ hire) resolved
 * against RESULTING values (so a partial save is still validated against the stored hire date); non-negative
 * period validation; partial-update semantics (undefined = untouched, '' = clear); admin gating; and
 * backward compatibility (a legacy all-NULL employment reads + behaves unchanged).
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

async function hire(name = 'Info Test', hiredOn = '2026-01-01') {
  const r = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  return { id: r.employmentId };
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('setEmploymentInfo', () => {
  it('persists new employment-master-data fields and projects them via employeeDetail', async () => {
    const e = await hire();
    await setEmploymentInfo(adminCtx(b), {
      employmentId: e.id,
      probationMonths: 3,
      probationDays: 0,
      confirmationDate: '2026-04-01',
      resignationNoticeMonths: 1,
      resignationNoticeDays: 15,
      shortNoticeMonths: 0,
      shortNoticeDays: 7,
      orgBranch: 'HQ Branch',
      orgDivision: 'Delivery',
      orgRegion: 'Central',
      orgLine: 'Line A',
      orgSection: 'Sec 1',
      orgTeam: 'Alpha',
      orgBase: 'KL Base',
      employmentCategory: 'Executive',
    });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d).toBeTruthy();
    expect(d!.probationMonths).toBe(3);
    expect(d!.confirmationDate).toBe('2026-04-01');
    expect(d!.resignationNoticeDays).toBe(15);
    expect(d!.shortNoticeDays).toBe(7);
    expect(d!.orgBranch).toBe('HQ Branch');
    expect(d!.orgDivision).toBe('Delivery');
    expect(d!.orgRegion).toBe('Central');
    expect(d!.orgLine).toBe('Line A');
    expect(d!.orgSection).toBe('Sec 1');
    expect(d!.orgTeam).toBe('Alpha');
    expect(d!.orgBase).toBe('KL Base');
    expect(d!.employmentCategory).toBe('Executive');
  });

  it('appends an employment.info.updated event with a before/after diff', async () => {
    const e = await hire();
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, employmentCategory: 'Management' });
    const types = await eventTypesFor(b.tenantId, e.id);
    expect(types).toContain('employment.info.updated');
    const payload = await latestEventPayload(b.tenantId, e.id, 'employment.info.updated');
    expect(payload).toBeTruthy();
    expect((payload!.fields as string[])).toContain('employmentCategory');
    expect((payload!.before as Record<string, unknown>).employmentCategory).toBeNull();
    expect((payload!.after as Record<string, unknown>).employmentCategory).toBe('Management');
  });

  // 89ea527b — the hire date (Group Join Date) USED to be freely editable here. It is now movement-only:
  // this writer honours it solely under the `groupJoinDateCorrection` tag. That gate exists because
  // employment.hired_on is what core/leave.ts reads for service bands and minimum-service eligibility, so a
  // free edit silently re-priced somebody's leave entitlement.
  it('applies the hire date ONLY under the groupJoinDateCorrection movement tag', async () => {
    const e = await hire('Hire Edit', '2026-01-01');
    await setEmploymentInfo(adminCtx(b), {
      employmentId: e.id,
      hiredOn: '2026-02-01',
      movement: { type: 'groupJoinDateCorrection' },
    });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.hiredOn).toBe('2026-02-01');
  });

  it('silently ignores an untagged hire date rather than applying it', async () => {
    const e = await hire('Hire Forge', '2026-01-01');
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: e.id, hiredOn: '2026-02-01' }),
    ).rejects.toThrow(/nothing to change/i);
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.hiredOn).toBe('2026-01-01');
  });

  it('rejects a confirmation date earlier than the hire date', async () => {
    const e = await hire('Conf', '2026-06-01');
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: e.id, confirmationDate: '2026-05-01' }),
    ).rejects.toThrow(/Confirmation date/i);
  });

  it('rejects a resignation date earlier than the hire date', async () => {
    const e = await hire('Resign', '2026-06-01');
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: e.id, resignationDate: '2026-05-01' }),
    ).rejects.toThrow(/Resignation date/i);
  });

  it('validates the confirmation date against a NEW hire date supplied in the same save', async () => {
    const e = await hire('Combo', '2026-01-01');
    // Moving the hire date forward past the incoming confirmation date must fail even though the STORED
    // hire date would have passed — validation resolves against resulting values. 89ea527b: the hire date
    // now needs its movement tag to be part of the write set at all, so the tag is what makes this a
    // "same save" case; the resolution rule itself is unchanged.
    await expect(
      setEmploymentInfo(adminCtx(b), {
        employmentId: e.id,
        hiredOn: '2026-06-01',
        confirmationDate: '2026-03-01',
        movement: { type: 'groupJoinDateCorrection' },
      }),
    ).rejects.toThrow(/Confirmation date/i);
  });

  it('an UNTAGGED hire date drops out of that validation instead of driving it', async () => {
    // The converse of the case above, and the reason the gate is "ignore" rather than "reject": a forged
    // hiredOn must not be able to make an otherwise-valid confirmation date fail, either.
    const e = await hire('Combo Forge', '2026-01-01');
    await setEmploymentInfo(adminCtx(b), {
      employmentId: e.id,
      hiredOn: '2026-06-01',
      confirmationDate: '2026-03-01',
    });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.hiredOn).toBe('2026-01-01');
    expect(d!.confirmationDate).toBe('2026-03-01');
  });

  it('rejects negative period components', async () => {
    const e = await hire();
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: e.id, probationMonths: -1 }),
    ).rejects.toThrow(/0 or more/i);
  });

  it('leaves untouched fields alone on a partial save, and clears on explicit empty', async () => {
    const e = await hire();
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, orgBranch: 'B1', orgTeam: 'T1' });
    // A second save touching only orgBranch must NOT wipe orgTeam.
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, orgBranch: 'B2' });
    let d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.orgBranch).toBe('B2');
    expect(d!.orgTeam).toBe('T1');
    // Explicit empty string clears to null (the UI always submits every field, blank = clear).
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, orgTeam: '' });
    d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.orgTeam).toBeNull();
  });

  it('a legacy employment with no employment-info set reads as all-null (backward compatible)', async () => {
    const e = await hire();
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.probationMonths).toBeNull();
    expect(d!.confirmationDate).toBeNull();
    expect(d!.resignationDate).toBeNull();
    expect(d!.orgBranch).toBeNull();
    expect(d!.employmentCategory).toBeNull();
  });

  it('rejects a non-admin caller', async () => {
    const e = await hire();
    const nonAdmin: SessionContext = { tenantId: b.tenantId, userId: b.adminUserId, roles: ['employee'] };
    await expect(
      setEmploymentInfo(nonAdmin, { employmentId: e.id, employmentCategory: 'X' }),
    ).rejects.toThrow(/admin/i);
  });
});
