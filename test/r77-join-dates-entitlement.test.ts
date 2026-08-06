/**
 * 89ea527b — WHICH date drives length of service, and therefore leave entitlement.
 *
 * The item defines the relationship between Group Join Date and Join Date, and says Group Join Date is the
 * master reference for Year of Service. Length of service feeds leave entitlement directly (service bands via
 * resolveGradePolicy, minimum-service eligibility), so getting the mapping wrong silently re-prices people's
 * leave. This suite exists to PROVE the mapping rather than assert it in a comment:
 *
 *   • employment.hired_on IS the Group Join Date, and it is the ONLY date entitlement reads.
 *   • employment.join_date drives NOTHING but display — moving it must not shift a single leave day.
 *
 * That mapping is what makes this item safe to ship: the plan's rule ("Year of Service reads Group Join
 * Date") is already how the system behaves, so defining the two dates moves nobody's entitlement. The tests
 * below are the regression net for anyone later tempted to "fix" service length to read join_date.
 *
 * It also pins the one place where a date change SHOULD move entitlement — a Group Join Date Correction —
 * and that the correction is wired to the recompute, because that recompute used to be a side effect of the
 * Employment tab's own save and is now the movement action's responsibility.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import { createMovementEvent } from '../core/movement';
import { openLeaveYear, serviceYearsAt } from '../core/leave';
import { employeeDetail } from '../core/read';
import type { ServiceBand } from '../core/leave-compute';
import {
  adminCtx,
  closeAll,
  ledgerBalance,
  migrateTestDb,
  resetDb,
  seedBase,
  seedEntitlement,
  type Base,
} from './harness';

let b: Base;

/** The feedback's own worked example: under-2 = 14 days, 2-to-under-5 = 16, 5-and-above = 18. */
const BANDS: ServiceBand[] = [
  { fromYears: 0, toYears: 2, days: 14 },
  { fromYears: 2, toYears: 5, days: 16 },
  { fromYears: 5, toYears: null, days: 18 },
];

const hire = (hiredOn: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Service', primaryEmail: `svc_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

const balance = (employmentId: string) => ledgerBalance(employmentId, b.annualLeaveTypeId);

/**
 * 6e9a126e RELEASE THREE — was `createLeavePolicy(annualDays 12, carryForwardMax 0, serviceBands BANDS)`.
 *
 * The BANDS are the whole point of this file and they move across UNCHANGED — the template layer stores the
 * same `ServiceBand[]` JSONB and resolves it through the same `bandDaysFor`. `carryForwardMax: 0` needed no
 * replacement: with no leave-type rules configured, `applyLeaveTypeRules` returns the band's carrier
 * untouched and a template band carries no cap, so carry forward is off — which is exactly what the 0 said.
 */
const bandedEntitlement = () =>
  seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    serviceBands: BANDS,
    // Early enough to cover every hire date used below — resolution at hire filters on validFrom.
    validFrom: '2010-01-01',
  });

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('the Group Join Date (hired_on) is the date entitlement reads', () => {
  // NOTE on the shape of these tests: the grant made AT HIRE always resolves the 0-year band (service at
  // hire is zero by definition), so the hire grant cannot distinguish the bands. openLeaveYear is where a
  // band is re-resolved against accumulated service, which is why each case opens a later year.
  it('service bands resolve off hired_on — two employees differing only in it land in different bands', async () => {
    await bandedEntitlement();
    const junior = await hire('2024-01-01');
    const senior = await hire('2018-01-01');
    expect(await balance(junior.employmentId)).toBe(14); // 0 years at hire, both
    expect(await balance(senior.employmentId)).toBe(14);

    // At 2026-01-01: junior has exactly 2 completed years ⇒ 16; senior has 8 ⇒ 18. carryForwardMax 0 means
    // the balance after opening the year IS that year's grant.
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(junior.employmentId)).toBe(16);
    expect(await balance(senior.employmentId)).toBe(18);
  });

  it('a Group Join Date Correction MOVES the band at the next leave year', async () => {
    await bandedEntitlement();
    // Hired 2024-01-01 ⇒ at 2026-01-01 they would have exactly 2 completed years ⇒ the 16-day band.
    const emp = await hire('2024-01-01');
    expect(await balance(emp.employmentId)).toBe(14); // hire grant, 0 years

    // Correct the group join date back to 2020 — the employee actually joined the group four years earlier.
    await createMovementEvent(adminCtx(b), {
      employmentId: emp.employmentId,
      kind: 'groupJoinDateCorrection',
      effectiveDate: '2020-01-01',
      remarks: 'Corrected from personnel file',
    });
    const d = await employeeDetail(adminCtx(b), emp.employmentId);
    expect(d!.hiredOn).toBe('2020-01-01');

    // At 2026-01-01 they now have 6 completed years, not 2 ⇒ the top band (18), not 16.
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(emp.employmentId)).toBe(18);
    expect(serviceYearsAt('2020-01-01', '2026-01-01')).toBe(6);
  });
});

describe('the Join Date (join_date) drives NO entitlement', () => {
  it('a Join Date Change leaves the leave entitlement untouched', async () => {
    await bandedEntitlement();
    const emp = await hire('2018-01-01');

    // The plan's internal-transfer example: the employee moves to another group company, so their
    // current-company join date restarts while their group service continues.
    await createMovementEvent(adminCtx(b), {
      employmentId: emp.employmentId,
      kind: 'joinDateChange',
      effectiveDate: '2026-08-01',
      remarks: 'Internal transfer to Company B',
    });

    const d = await employeeDetail(adminCtx(b), emp.employmentId);
    expect(d!.joinDate).toBe('2026-08-01');
    expect(d!.hiredOn).toBe('2018-01-01'); // group service continues — the whole point of two dates

    // At 2027-01-01 group service is 9 years ⇒ the top band. Were service length ever to read join_date,
    // this employee would show ~0 years and drop to the 14-day band the moment they transferred internally.
    await openLeaveYear(adminCtx(b), { year: 2027 });
    expect(await balance(emp.employmentId)).toBe(18);
    expect(serviceYearsAt(d!.hiredOn, '2027-01-01')).toBe(9);
    expect(serviceYearsAt(d!.joinDate!, '2027-01-01')).toBe(0); // what the WRONG mapping would have used
  });

  it('the creation-time sync cannot move anyone: a seeded join_date equals hired_on', async () => {
    await bandedEntitlement();
    const emp = await hire('2018-01-01');
    const d = await employeeDetail(adminCtx(b), emp.employmentId);
    // Both dates identical at creation (expected behaviour #1 of the item)…
    expect(d!.joinDate).toBe(d!.hiredOn);
    // …and the grant is exactly the one hired_on alone produces, so seeding the column moved nothing.
    expect(await balance(emp.employmentId)).toBe(14);
  });
});

// ── Source-level guards: the mapping, and the recompute wiring ──
const REPO = path.resolve(__dirname, '..');
const leaveSrc = fs.readFileSync(path.join(REPO, 'core/leave.ts'), 'utf8');
const actionsSrc = fs.readFileSync(
  path.join(REPO, 'app/admin/personnel/[employmentId]/actions.ts'),
  'utf8',
);

describe('drift guard — nothing in the entitlement engine may read join_date', () => {
  it('core/leave.ts never references joinDate', () => {
    // The whole safety argument for this item is that join_date reaches no entitlement path. If a future
    // change reads it here, that argument silently stops being true — and the symptom (someone's leave
    // quietly resetting after an internal transfer) would not look like a code change.
    expect(leaveSrc).not.toMatch(/\bjoinDate\b/);
    expect(leaveSrc).not.toMatch(/\bjoin_date\b/);
  });

  it('a Group Join Date Correction triggers the entitlement recompute', () => {
    // Before 89ea527b the recompute happened because hired_on was edited through setEmploymentInfoAction,
    // which always recomputes. The movement is now the only writer, so the movement action must carry it —
    // otherwise a corrected service date leaves the employee on a stale band with no visible symptom.
    const start = actionsSrc.indexOf('export async function createMovementEventAction');
    expect(start).toBeGreaterThan(-1);
    const body = actionsSrc.slice(start, actionsSrc.indexOf('\n}\n', start));
    expect(body).toContain("p.kind === 'groupJoinDateCorrection'");
    expect(body).toContain('recomputeEntitlement');
  });
});
