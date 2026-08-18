/**
 * Redesign Employment Joining Date Structure (feedback 24c4d02e), as amended by 89ea527b.
 *
 * hired_on is KEPT as the durable "Group Join Date" (relabelled in the UI, never renamed); a nullable
 * join_date captures the current-company effective join.
 *
 * 89ea527b defines how the two relate, and makes BOTH movement-only after creation:
 *   • hireEmployee seeds join_date = hired_on — the one-time synchronisation, so the pair is explicit from
 *     day one instead of relying on the `join_date ?? hired_on` read fallback.
 *   • setEmploymentInfo IGNORES hiredOn without the `groupJoinDateCorrection` movement tag, and joinDate
 *     without the `joinDateChange` tag (the forge-proof gate d27961e3 established for extendedConfirmationDate).
 *   • createMovementEvent is the only route to either, so each change carries an effective date and a reason.
 *
 * Covers: the creation-time sync; both movement writers; the forge-proof gate in both directions; the
 * "join can't precede the group join date" guard STILL firing on the movement path; the null-join_date
 * backward-compatibility fallback for legacy rows; and the pure dual service-length helper.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { type SessionContext } from '../db/client';
import { hireEmployee, setEmploymentInfo } from '../core/org';
import { createMovementEvent, movementHistory } from '../core/movement';
import { employeeDetail } from '../core/read';
import { serviceYearsAt, serviceYearsMonthsAt } from '../core/leave';
import { withTenant } from '../db/client';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
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

async function hire(name = 'JoinDate Test', hiredOn = '2018-01-01') {
  const r = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  return { id: r.employmentId };
}

/** Force join_date back to NULL, reproducing a pre-89ea527b (legacy / imported) row. */
async function nullJoinDate(employmentId: string) {
  await withTenant(adminCtx(b), (tx) =>
    tx.update(schema.employment).set({ joinDate: null }).where(eq(schema.employment.id, employmentId)),
  );
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('serviceYearsMonthsAt (pure)', () => {
  it('breaks service into whole years + residual months, consistent with serviceYearsAt', () => {
    expect(serviceYearsMonthsAt('2018-01-01', '2026-07-01')).toEqual({ years: 8, months: 6 });
    expect(serviceYearsMonthsAt('2025-01-01', '2026-07-01')).toEqual({ years: 1, months: 6 });
    // .years always equals serviceYearsAt for the same inputs.
    for (const [from, asOf] of [
      ['2018-01-01', '2026-07-01'],
      ['2025-06-15', '2026-07-15'],
      ['2026-03-31', '2026-03-30'],
    ] as const) {
      expect(serviceYearsMonthsAt(from, asOf).years).toBe(serviceYearsAt(from, asOf));
    }
  });
  it('clamps to zero when asOf precedes the start date', () => {
    expect(serviceYearsMonthsAt('2026-06-01', '2026-01-01')).toEqual({ years: 0, months: 0 });
  });
  it('drops the partial month when the day-of-month has not yet been reached', () => {
    expect(serviceYearsMonthsAt('2025-01-20', '2026-07-10')).toEqual({ years: 1, months: 5 });
  });
});

describe('89ea527b — creation-time synchronisation', () => {
  it('seeds Join Date from Group Join Date at hire, so both dates start identical', async () => {
    const e = await hire('Synced', '2026-01-01');
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.hiredOn).toBe('2026-01-01');
    expect(d!.joinDate).toBe('2026-01-01');
  });

  it('synchronises ONCE — a later Join Date Change does not drag the Group Join Date with it', async () => {
    const e = await hire('Once', '2020-01-01');
    await createMovementEvent(adminCtx(b), {
      employmentId: e.id,
      kind: 'joinDateChange',
      effectiveDate: '2026-08-01',
      remarks: 'Internal transfer to Company B',
    });
    const d = await employeeDetail(adminCtx(b), e.id);
    // The plan's worked example: group service continues, current-company service restarts.
    expect(d!.hiredOn).toBe('2020-01-01');
    expect(d!.joinDate).toBe('2026-08-01');
  });
});

describe('89ea527b — the Employment tab can no longer write either date (forge-proof)', () => {
  it('IGNORES an untagged joinDate, even alongside a legitimate change', async () => {
    const e = await hire('Forge Join', '2018-01-01');
    await setEmploymentInfo(adminCtx(b), {
      employmentId: e.id,
      confirmationDate: '2018-04-01',
      joinDate: '2025-01-01',
    });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.confirmationDate).toBe('2018-04-01'); // the real change lands…
    expect(d!.joinDate).toBe('2018-01-01'); // …the forged one is dropped, still the hire-time value
  });

  it('IGNORES an untagged hiredOn, even alongside a legitimate change', async () => {
    const e = await hire('Forge Hire', '2018-01-01');
    await setEmploymentInfo(adminCtx(b), {
      employmentId: e.id,
      confirmationDate: '2018-04-01',
      hiredOn: '2016-01-01',
    });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.hiredOn).toBe('2018-01-01');
  });

  it('a save carrying ONLY a gated date changes nothing at all', async () => {
    const e = await hire('Forge Only', '2018-01-01');
    for (const forged of [{ joinDate: '2025-01-01' }, { hiredOn: '2016-01-01' }]) {
      await expect(
        setEmploymentInfo(adminCtx(b), { employmentId: e.id, ...forged }),
      ).rejects.toThrow(/nothing to change/i);
    }
  });

  it('a forged blank cannot CLEAR a movement-set Join Date', async () => {
    const e = await hire('Forge Clear', '2018-01-01');
    await createMovementEvent(adminCtx(b), {
      employmentId: e.id,
      kind: 'joinDateChange',
      effectiveDate: '2025-01-01',
    });
    await setEmploymentInfo(adminCtx(b), {
      employmentId: e.id,
      confirmationDate: '2018-04-01',
      joinDate: '',
    });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.joinDate).toBe('2025-01-01');
  });

  it('the tagged writers DO apply — the gate is on the tag, not on the field', async () => {
    const e = await hire('Tagged', '2018-01-01');
    await setEmploymentInfo(adminCtx(b), {
      employmentId: e.id,
      joinDate: '2025-01-01',
      movement: { type: 'joinDateChange' },
    });
    await setEmploymentInfo(adminCtx(b), {
      employmentId: e.id,
      hiredOn: '2017-01-01',
      movement: { type: 'groupJoinDateCorrection' },
    });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.joinDate).toBe('2025-01-01');
    expect(d!.hiredOn).toBe('2017-01-01');
  });

  it('the WRONG movement tag does not unlock the other date (tags are not interchangeable)', async () => {
    const e = await hire('Wrong Tag', '2018-01-01');
    await expect(
      setEmploymentInfo(adminCtx(b), {
        employmentId: e.id,
        hiredOn: '2016-01-01',
        movement: { type: 'joinDateChange' },
      }),
    ).rejects.toThrow(/nothing to change/i);
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.hiredOn).toBe('2018-01-01');
  });
});

describe('89ea527b — the movement path keeps every guard and leaves a history row', () => {
  it('still rejects a join date earlier than the group join date', async () => {
    const e = await hire('Guard', '2020-06-01');
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: e.id,
        kind: 'joinDateChange',
        effectiveDate: '2019-01-01',
      }),
    ).rejects.toThrow(/Join date/i);
  });

  it('still rejects a group join date correction that would post-date the current join date', async () => {
    const e = await hire('Guard2', '2018-01-01');
    await createMovementEvent(adminCtx(b), {
      employmentId: e.id,
      kind: 'joinDateChange',
      effectiveDate: '2020-01-01',
    });
    // Group join AFTER the current-company join is the contradiction the guard exists for: you cannot
    // join a company inside the group before joining the group.
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: e.id,
        kind: 'groupJoinDateCorrection',
        effectiveDate: '2021-01-01',
      }),
    ).rejects.toThrow(/Join date/i);
  });

  it('appends an employment.info.updated event carrying join_date in before/after', async () => {
    const e = await hire('Audit', '2018-01-01');
    await createMovementEvent(adminCtx(b), {
      employmentId: e.id,
      kind: 'joinDateChange',
      effectiveDate: '2025-01-01',
    });
    const types = await eventTypesFor(b.tenantId, e.id);
    expect(types).toContain('employment.info.updated');
    const payload = await latestEventPayload(b.tenantId, e.id, 'employment.info.updated');
    expect(payload!.fields as string[]).toContain('joinDate');
    expect((payload!.before as Record<string, unknown>).joinDate).toBe('2018-01-01');
    expect((payload!.after as Record<string, unknown>).joinDate).toBe('2025-01-01');
  });

  it('projects ONE history row per date movement, dated by the value it set', async () => {
    const e = await hire('History', '2018-01-01');
    await createMovementEvent(adminCtx(b), {
      employmentId: e.id,
      kind: 'joinDateChange',
      effectiveDate: '2025-03-01',
      remarks: 'Transferred to Company B',
    });
    await createMovementEvent(adminCtx(b), {
      employmentId: e.id,
      kind: 'groupJoinDateCorrection',
      effectiveDate: '2017-09-01',
      remarks: 'Corrected from personnel file',
    });
    const rows = await movementHistory(adminCtx(b), e.id);

    // Exactly one row each — the r76 duplicate-row failure mode is a second, untagged row for the same change.
    const join = rows.filter((r) => r.kind === 'joinDateChange');
    const group = rows.filter((r) => r.kind === 'groupJoinDateCorrection');
    expect(join).toHaveLength(1);
    expect(group).toHaveLength(1);

    // The row's Effective Date is the date the movement SET, not the day it was keyed in.
    expect(join[0].effectiveDate).toBe('2025-03-01');
    expect(join[0].remarks).toBe('Transferred to Company B');
    expect(group[0].effectiveDate).toBe('2017-09-01');
    expect(group[0].remarks).toBe('Corrected from personnel file');
  });

  // The carry-forward rule, and the reason it exists. Without it a Group Join Date Correction is unusable in
  // the FORWARD direction for anyone who never transferred: the dates are seeded identical at hire, so
  // join === hire, and moving hire forward by even one day trips the "join cannot precede the group join
  // date" guard — with no way out, because moving the join date first needs the other movement tag.
  it('carries the Join Date along when the two dates are still synchronised', async () => {
    const e = await hire('Sync Carry', '2020-01-01');
    await createMovementEvent(adminCtx(b), {
      employmentId: e.id,
      kind: 'groupJoinDateCorrection',
      effectiveDate: '2020-03-15', // FORWARD — the direction that used to be impossible
    });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.hiredOn).toBe('2020-03-15');
    expect(d!.joinDate).toBe('2020-03-15'); // still synchronised, no divergence invented
  });

  it('does NOT carry the Join Date once the two have legitimately diverged', async () => {
    const e = await hire('Diverged', '2020-01-01');
    await createMovementEvent(adminCtx(b), {
      employmentId: e.id,
      kind: 'joinDateChange',
      effectiveDate: '2026-08-01', // transferred to another group company
    });
    // Backward correction of the group date: allowed, and the company join date must NOT be dragged with it —
    // the employee really did join Company B on 2026-08-01.
    await createMovementEvent(adminCtx(b), {
      employmentId: e.id,
      kind: 'groupJoinDateCorrection',
      effectiveDate: '2019-11-01',
    });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.hiredOn).toBe('2019-11-01');
    expect(d!.joinDate).toBe('2026-08-01');
  });

  it('rejects a non-admin caller on both kinds', async () => {
    const e = await hire('NonAdmin', '2018-01-01');
    const nonAdmin: SessionContext = { tenantId: b.tenantId, userId: b.adminUserId, roles: ['employee'] };
    for (const kind of ['joinDateChange', 'groupJoinDateCorrection'] as const) {
      await expect(
        createMovementEvent(nonAdmin, { employmentId: e.id, kind, effectiveDate: '2025-01-01' }),
      ).rejects.toThrow(/admin/i);
    }
  });
});

describe('89ea527b — a legacy row with a NULL join_date still reads correctly', () => {
  it('falls back to the group date for current-company service (no backfill required)', async () => {
    const e = await hire('Legacy', '2018-01-01');
    await nullJoinDate(e.id); // pre-89ea527b shape
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.joinDate).toBeNull();
    // The UI computes current-company service from join_date ?? hired_on — with null it equals group service,
    // which is why leaving existing rows untouched changes nothing anyone can see. What is asserted here is
    // that FALLBACK, not the format: since 4ea70bb7 the Employment tab renders the day-precise
    // serviceYearsMonthsDaysAt instead of the whole-month function used below, and the fallback survived the
    // change unaltered (test/personnel-year-of-service.test.ts pins the rendered strings).
    const asOf = '2026-07-01';
    const group = serviceYearsMonthsAt(d!.hiredOn, asOf);
    const current = serviceYearsMonthsAt(d!.joinDate ?? d!.hiredOn, asOf);
    expect(current).toEqual(group);
    expect(group).toEqual({ years: 8, months: 6 });
  });
});
