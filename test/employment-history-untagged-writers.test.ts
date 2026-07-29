/**
 * r78c — one movement, one Employment History row: closing the UNTAGGED WRITERS.
 *
 * The reporter recorded a single Promotion (salary + position + job grade) and got TWO rows: Promotion and
 * Grade Change. The Promotion itself was correct — the comparison writer tags every leg with one groupId,
 * first leg primary and the rest `secondary`, and core/movement.ts collapses them into one row. The extra
 * row came from a DIFFERENT screen writing the same fact without recording a movement: the Leave tab's
 * one-field Job Grade save emitted `employment.grade.changed` — a MOVEMENT_EVENT_TYPE — with no movement
 * tag, so the projection fell back to `kind: 'gradeChange'` and gave it its own row.
 *
 * The class of fault is "a writer outside the movement recorder emits a projected event type". This suite
 * pins the whole class rather than the one instance:
 *
 *  (1) the reported scenario — a multi-leg movement still projects exactly ONE row, and no loose Grade
 *      Change appears beside it;
 *  (2) the hire — a hire with a manager projects ONE row. Its own reporting-line.set used to open a second,
 *      same-day "Reporting Line Change";
 *  (3) Work Location (Attendance tab) — rerouted through the movement recorder: one tagged Transfer row,
 *      the business unit carried, and re-saving the same location writes nothing at all;
 *  (4) the LEDGER GUARD — after driving the real admin screens, every event of a projected assignment /
 *      grade / pay type in the ledger carries a movement tag with a groupId. This is the check that catches
 *      the NEXT writer someone adds, not just the ones fixed here. Reporting lines are deliberately
 *      exempt: Direct Superior stays editable outside Movement (clearing a superior emits
 *      `reporting-line.ended`, which is not a movement event type, so routing it through Movement would
 *      remove the only way to clear one) — that exemption is asserted explicitly so it cannot widen
 *      silently;
 *  (5) the requested COLUMNS — Company, Division, Department, Job Title, Basic — reconstructed AS OF each
 *      row's effective date, not read live. A live read would print today's placement on every row and make
 *      the history agree with itself by lying;
 *  (6) the columns actually reach the reader — the projection fields are rendered by the page, guarded at
 *      source so a field can never be computed and then dropped before the screen.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBusinessUnit, createJobGrade, createPosition } from '../core/admin';
import { createLocation } from '../core/location';
import { createMovementEvent, movementHistory } from '../core/movement';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// The action layer calls requireAdmin() (session), unavailable in the harness — hand it the seeded admin
// ctx so the action's writes run under the same RLS a real save would.
let ADMIN: ReturnType<typeof adminCtx>;
vi.mock('../lib/authz', () => ({ requireAdmin: async () => ADMIN }));
let LAST_REDIRECT = '';
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import * as personnelActions from '../app/admin/personnel/[employmentId]/actions';
import { setCompensationAction, setLocationAction } from '../app/admin/personnel/[employmentId]/actions';

let b: Base;

/** The event types core/movement.ts projects that describe an ASSIGNMENT, GRADE or PAY fact. Every one of
 *  these must be written by, or through, the movement recorder. `reporting-line.set` is deliberately absent
 *  — see (4). */
const TAG_REQUIRED_EVENT_TYPES = [
  'assignment.transferred',
  'employment.assignment.changed',
  'employment.grade.changed',
  'compensation.set',
];

type TaggedPayload = { movement?: { type?: string; groupId?: string; secondary?: boolean } };

async function projectedEvents(employmentId: string, types: string[]) {
  return owner.db
    .select({
      eventType: schema.domainEvent.eventType,
      payload: schema.domainEvent.payload,
      sequence: schema.domainEvent.sequence,
    })
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.subjectEmploymentId, employmentId),
        inArray(schema.domainEvent.eventType, types),
      ),
    )
    .orderBy(schema.domainEvent.sequence);
}

async function openAssignment(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.assignment)
    .where(
      and(
        eq(schema.assignment.employmentId, employmentId),
        isNull(schema.assignment.validTo),
        isNull(schema.assignment.supersededAt),
      ),
    )
    .limit(1);
  return row;
}

const email = () => `r78c_${randomUUID().slice(0, 8)}@t.local`;

async function hireOne(p?: { managerEmploymentId?: string }) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'History Subject', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    costCenterId: b.costCenterId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
    reportingManagerEmploymentId: p?.managerEmploymentId,
  });
}

describe('r78c — one movement, one Employment History row', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    ADMIN = adminCtx(b);
    LAST_REDIRECT = '';
  });
  afterAll(async () => {
    await closeAll();
  });

  it('(1) the reported scenario: a Promotion moving salary + position + grade projects exactly ONE row', async () => {
    const hire = await hireOne();
    await setCompensation(adminCtx(b), {
      employmentId: hire.employmentId,
      basicSalary: 4000,
      effectiveFrom: '2026-01-01', // at the hire date — part of Hired, never its own row
    });
    const grade = await createJobGrade(adminCtx(b), {
      code: `G${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Senior',
      rank: 3,
    });
    const pos = await createPosition(adminCtx(b), {
      companyId: b.companyId,
      title: `Lead ${randomUUID().slice(0, 5)}`,
    });

    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'promotion',
      effectiveDate: '2026-07-29',
      positionId: pos.id,
      gradeId: grade.id,
      basicSalary: 6000,
      remarks: 'Annual promotion',
    });

    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.map((r) => r.kind)).toEqual(['hired', 'promotion']);
    expect(rows.map((r) => r.kind), 'the reported duplicate').not.toContain('gradeChange');
    expect(rows.map((r) => r.kind)).not.toContain('salaryAdjustment');
    expect(rows[1].effectiveDate).toBe('2026-07-29');

    // Three legs in the ledger, ONE primary: that is what collapses them to one row.
    const evs = await projectedEvents(hire.employmentId, TAG_REQUIRED_EVENT_TYPES);
    const legs = evs.filter((e) => (e.payload as TaggedPayload).movement?.type === 'promotion');
    expect(legs).toHaveLength(3);
    const groupIds = new Set(legs.map((e) => (e.payload as TaggedPayload).movement?.groupId));
    expect(groupIds.size, 'all three legs share ONE groupId').toBe(1);
    expect(legs.filter((e) => !(e.payload as TaggedPayload).movement?.secondary)).toHaveLength(1);
  });

  it('(2) a hire with a manager projects ONE row — the hire-time reporting line is part of the hire', async () => {
    const mgr = await hireOne();
    const hire = await hireOne({ managerEmploymentId: mgr.employmentId });
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.map((r) => r.kind)).toEqual(['hired']);

    // The event is still written — the tag is additive, the audit trail did not shrink.
    const [rl] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.subjectEmploymentId, hire.employmentId),
          eq(schema.domainEvent.eventType, 'reporting-line.set'),
        ),
      );
    expect(rl, 'the hire-time reporting line still emits its event').toBeTruthy();
    expect((rl.payload as TaggedPayload).movement?.secondary).toBe(true);
    expect((rl.payload as TaggedPayload).movement?.groupId).toBeTruthy();
  });

  it('(3) Work Location goes through the movement recorder: one tagged row, business unit kept, no-op is silent', async () => {
    const hire = await hireOne();
    const bu = await createBusinessUnit(adminCtx(b), {
      companyId: b.companyId,
      code: `BU${randomUUID().slice(0, 4).toUpperCase()}`,
      name: `Unit ${randomUUID().slice(0, 6)}`,
    });
    await owner.db
      .update(schema.assignment)
      .set({ businessUnitId: bu.id })
      .where(eq(schema.assignment.employmentId, hire.employmentId));
    const loc = await createLocation(adminCtx(b), {
      companyId: b.companyId,
      code: `HQ${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'HQ Annexe',
      country: 'MY',
      state: 'Selangor',
    });

    const fd = new FormData();
    fd.set('employmentId', hire.employmentId);
    fd.set('locationId', loc.id);
    fd.set('effectiveDate', '2026-04-01');
    await expect(setLocationAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');

    const asg = await openAssignment(hire.employmentId);
    expect(asg.locationId, 'the requested change took effect').toBe(loc.id);
    // r73 Decision 3's cautionary case: the old writer dropped business_unit_id on every CLOSE+INSERT.
    expect(asg.businessUnitId, 'the business unit was not collateral damage').toBe(bu.id);

    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.map((r) => r.kind)).toEqual(['hired', 'transfer']);

    // Re-saving the SAME location records nothing: no second assignment version, no second row, no error.
    LAST_REDIRECT = '';
    const again = new FormData();
    again.set('employmentId', hire.employmentId);
    again.set('locationId', loc.id);
    again.set('effectiveDate', '2026-05-01');
    await expect(setLocationAction(again)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT, 'a no-op save is not an error the admin can act on').toContain('toast=Saved');
    expect((await movementHistory(adminCtx(b), hire.employmentId)).map((r) => r.kind)).toEqual([
      'hired',
      'transfer',
    ]);
  });

  it('(4) LEDGER GUARD: every projected assignment / grade / pay event carries a movement tag with a groupId', async () => {
    const mgr = await hireOne();
    const hire = await hireOne({ managerEmploymentId: mgr.employmentId });
    const grade = await createJobGrade(adminCtx(b), {
      code: `G${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Band 2',
      rank: 2,
    });
    const loc = await createLocation(adminCtx(b), {
      companyId: b.companyId,
      code: `LC${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'Branch',
      country: 'MY',
      state: 'Johor',
    });
    // The initial salary at the hire date — the one compensation.set the projection suppresses.
    await setCompensation(adminCtx(b), {
      employmentId: hire.employmentId,
      basicSalary: 3500,
      effectiveFrom: '2026-01-01',
    });

    // Drive the real admin screens, in the order an admin would.
    const sal = new FormData();
    sal.set('employmentId', hire.employmentId);
    sal.set('basicSalary', '4200');
    sal.set('effectiveFrom', '2026-03-01');
    await expect(setCompensationAction(sal)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');

    const locFd = new FormData();
    locFd.set('employmentId', hire.employmentId);
    locFd.set('locationId', loc.id);
    locFd.set('effectiveDate', '2026-04-01');
    await expect(setLocationAction(locFd)).rejects.toThrow('NEXT_REDIRECT');

    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'promotion',
      effectiveDate: '2026-06-01',
      gradeId: grade.id,
      basicSalary: 5000,
    });

    // Every admin action above produced exactly one row, and nothing produced two.
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.map((r) => r.kind)).toEqual(['hired', 'salaryAdjustment', 'transfer', 'promotion']);

    // The invariant that matters to the reader: EVERY row on the screen is backed by a TAGGED event. A row
    // id IS the id of the event that projected it, so this walks from what is displayed back to the ledger
    // rather than trusting a list of writers someone remembered to update.
    const backing = await owner.db
      .select({
        id: schema.domainEvent.id,
        eventType: schema.domainEvent.eventType,
        payload: schema.domainEvent.payload,
      })
      .from(schema.domainEvent)
      .where(inArray(schema.domainEvent.id, rows.map((r) => r.id)));
    expect(backing, 'every row resolves to a real ledger event').toHaveLength(rows.length);
    const looseRows = backing
      .filter((e) => TAG_REQUIRED_EVENT_TYPES.includes(e.eventType))
      .filter((e) => !(e.payload as TaggedPayload).movement?.groupId)
      .map((e) => e.eventType);
    expect(looseRows, `rows with no movement behind them: ${looseRows.join(', ')}`).toEqual([]);

    // …and the ledger-wide sweep, which also covers legs that project NO row of their own (the secondary
    // ones). The single exemption is the initial salary written at the hire date: it is part of Hired, the
    // projection suppresses it (core/movement.ts) so it can never open a row, and it is written by the hire
    // flow — not by a screen that edits an existing employee.
    const evs = await projectedEvents(hire.employmentId, TAG_REQUIRED_EVENT_TYPES);
    expect(evs.length).toBeGreaterThan(0);
    const untagged = evs
      .filter((e) => !(e.payload as TaggedPayload).movement?.groupId)
      .filter((e) => (e.payload as { effectiveFrom?: string }).effectiveFrom !== '2026-01-01')
      .map((e) => `${e.eventType}#${e.sequence}`);
    expect(untagged, `untagged projected events: ${untagged.join(', ')}`).toEqual([]);

    // The ONE deliberate exemption, asserted so it cannot widen by accident: Direct Superior is not routed
    // through Movement, because the clear path (endReportingLine → `reporting-line.ended`) is not a movement
    // event type, so routing the set path alone would leave no way to clear a superior. Its event therefore
    // still exists untagged — but ONLY on the reporting-line type, never on the four above.
    const rl = await projectedEvents(hire.employmentId, ['reporting-line.set']);
    expect(rl.length, 'the hire-time line (tagged) — the Direct Superior path is untouched').toBe(1);
  });

  it('(5) the requested columns are reconstructed AS OF each row, not read live', async () => {
    const hire = await hireOne();
    await setCompensation(adminCtx(b), {
      employmentId: hire.employmentId,
      basicSalary: 3000,
      effectiveFrom: '2026-01-01',
    });
    const pos2Title = `Manager ${randomUUID().slice(0, 5)}`;
    const pos2 = await createPosition(adminCtx(b), { companyId: b.companyId, title: pos2Title });

    // One movement that moves department, job title, the flat Division column and pay together.
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-05-01',
      departmentId: b.deptB,
      positionId: pos2.id,
      orgDivision: 'Northern',
      basicSalary: 7000,
    });

    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.map((r) => r.kind)).toEqual(['hired', 'transfer']);

    const [hired, transfer] = rows;
    expect(hired.company).toBe('Acme Sdn Bhd');
    expect(transfer.company).toBe('Acme Sdn Bhd');

    // The Hired row must still show the placement the employee had AT HIRE — the whole point of the
    // as-of reconstruction. Reading the live columns would print the post-transfer values here.
    expect(hired.department).not.toBe(transfer.department);
    expect(hired.jobTitle).not.toBe(transfer.jobTitle);
    expect(hired.basic).toBe('MYR 3000.00');
    expect(transfer.basic).toBe('MYR 7000.00');
    expect(transfer.jobTitle).toBe(pos2Title);

    // Division is a FLAT, non-dated column: its as-of value has to be replayed from the ledger, so the
    // Hired row shows the value before the movement (none) and the movement's row shows what it set.
    expect(hired.division, 'the flat column replayed, not read live').toBeNull();
    expect(transfer.division).toBe('Northern');
  });

  it('(6) the columns reach the reader — the page renders every projection field', () => {
    // A projection field that is computed and then never rendered is invisible to the person who reported
    // the bug. Asserted at source rather than by rendering the component with hand-made props: a component
    // test can pass on a fixture that never crossed the RSC transport.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'),
      'utf8',
    );
    for (const field of ['company', 'division', 'department', 'jobTitle', 'basic']) {
      expect(src, `Employment History renders m.${field}`).toContain(`{m.${field} ?? '—'}`);
      expect(src, `Employment History heads ${field}`).toContain(`t('movement.columns.${field}')`);
    }
    // And the writer the reported row came from is gone from the module's exports.
    expect(Object.keys(personnelActions)).not.toContain('setEmploymentGradeAction');
    expect(Object.keys(personnelActions), 'the unreferenced untagged transfer endpoint').not.toContain(
      'transferAction',
    );
  });
});
