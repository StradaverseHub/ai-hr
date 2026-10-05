/**
 * c063eea9 — "Correct hire details" on the Hired movement event.
 *
 * What is pinned here, in the order the plan promised it to the reporter:
 *   • the correction carries forward ONLY into later records that INHERITED the wrong value — a later
 *     deliberate choice (a Transfer to a new department) is kept, and so is everything after it;
 *   • the employee's current record changes only when it still holds the inherited value;
 *   • the original `employment.hired` event is never edited, superseded rows stay in the table, and the
 *     new `employment.hire.corrected` event carries actor, reason, per-field before/after and the row
 *     ids — and no salary;
 *   • the Hired row is marked "Hire details corrected" (not the rolled-back Corrected badge), keeps its
 *     place, and still shows what was originally recorded; correcting again is the undo;
 *   • a LATER Roll Back of a movement whose row the correction replaced still undoes that movement;
 *   • every new label is validated against the company of every record it lands on, the actor must
 *     administer each of those companies, only hr_admin / super_admin may correct, a reason is required,
 *     and fields the correction does not own are ignored even when posted;
 *   • a superseded row never matches an entitlement rule, so the recalculation actually moves the balance;
 *   • a pending scheduled movement is left alone and, when it applies, carries the corrected value.
 *
 * Dates in the past are fixed literals; the one future date (the scheduled movement) is derived from the
 * clock, per CLAUDE.md §8.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { withTenant } from '../db/client';
import { changeEmploymentCompany, hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { createJobGrade } from '../core/admin';
import {
  createMovementEvent,
  editMovementEvent,
  movementDetail,
  movementHistory,
  reverseMovementEvent,
} from '../core/movement';
import { sweepDueMovements } from '../core/movement-apply';
import {
  correctHireDetails,
  hireCorrectionView,
  HireCorrectionError,
  HireCorrectionNoChangeError,
  HireCorrectionReasonRequiredError,
  HIRE_CORRECTED_EVENT,
  parseHireCorrectionForm,
} from '../core/hire-correction';
import { resolveOrgCriteriaTargets } from '../core/org-criteria';
import { createEligibilityRule, createEntitlementTemplate } from '../core/entitlement-template';
import { reprojectEntitlementForEmployment } from '../core/leave';
import { partitionMovementRows } from '../lib/movement-visibility';
import { assignLabelToCompanies } from '../core/system-labels';
import { todayInKualaLumpur } from '../lib/hr-date';
import * as schema from '../db/schema';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const ctx = () => adminCtx(b);
const email = () => `hc_${randomUUID().slice(0, 8)}@t.local`;
const REASON = 'Department was keyed as Finance at hire; the offer letter says Human Resources.';

async function dept(name: string, opts?: { companyId?: string; sharedInto?: string }) {
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: opts?.companyId ?? b.companyId, name })
    .returning({ id: schema.department.id });
  // A System Label SHARED into another company (62de487d) — the way one label becomes usable by two.
  if (opts?.sharedInto) {
    await assignLabelToCompanies(ctx(), { kind: 'department', labelId: d.id, companyIds: [opts.sharedInto] });
  }
  return d.id;
}
async function pos(title: string) {
  const [p] = await owner.db
    .insert(schema.position)
    .values({ tenantId: b.tenantId, companyId: b.companyId, title })
    .returning({ id: schema.position.id });
  return p.id;
}
async function companyB() {
  const [co] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  return co.id;
}

async function hireOne(p?: {
  hiredOn?: string;
  departmentId?: string;
  positionId?: string | null;
  costCenterId?: string | null;
  managerEmploymentId?: string;
  grantAnnual?: boolean;
  name?: string;
}) {
  return hireEmployee(ctx(), {
    person: { fullName: p?.name ?? 'Nur Aisyah', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: p?.departmentId ?? b.deptA,
    positionId: p?.positionId === null ? undefined : (p?.positionId ?? b.positionId),
    costCenterId: p?.costCenterId === null ? undefined : (p?.costCenterId ?? b.costCenterId),
    employmentType: 'full_time',
    hiredOn: p?.hiredOn ?? '2025-01-01',
    reportingManagerEmploymentId: p?.managerEmploymentId,
    ...(p?.grantAnnual ? { grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }] } : {}),
  });
}

/** Live (non-superseded) assignment versions, in date order. */
async function liveVersions(employmentId: string) {
  return owner.db
    .select()
    .from(schema.assignment)
    .where(and(eq(schema.assignment.employmentId, employmentId), isNull(schema.assignment.supersededAt)))
    .orderBy(asc(schema.assignment.validFrom));
}
async function allVersions(employmentId: string) {
  return owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId, employmentId));
}
async function eventsOf(employmentId: string, type?: string) {
  const rows = await owner.db
    .select()
    .from(schema.domainEvent)
    .where(eq(schema.domainEvent.subjectEmploymentId, employmentId))
    .orderBy(asc(schema.domainEvent.sequence));
  return type ? rows.filter((r) => r.eventType === type) : rows;
}

/** Hired → Promotion (position only) → Transfer (department set explicitly) → a later non-department change. */
async function careerWithTransfer() {
  const hr = await dept('Human Resources');
  const p2 = await pos('Senior Executive');
  const p3 = await pos('Lead Executive');
  const hire = await hireOne();
  const id = hire.employmentId;
  await createMovementEvent(ctx(), { employmentId: id, kind: 'promotion', effectiveDate: '2025-03-01', positionId: p2 });
  await createMovementEvent(ctx(), { employmentId: id, kind: 'transfer', effectiveDate: '2025-06-01', departmentId: b.deptB });
  await createMovementEvent(ctx(), { employmentId: id, kind: 'orgAssignmentChange', effectiveDate: '2025-09-01', positionId: p3 });
  return { id, hr, p2, p3 };
}

describe('c063eea9 — the correction follows inheritance, and stops at an explicit choice', () => {
  it('the form preview names what each field would carry into and where it stops', async () => {
    const { id } = await careerWithTransfer();
    const view = await hireCorrectionView(ctx(), id);
    expect(view.hiredOn).toBe('2025-01-01');
    expect(view.companyId).toBe(b.companyId);
    const field = (f: string) => view.fields.find((x) => x.field === f)!;
    // Department: the Promotion inherited it; the Transfer set it; the current record does not change.
    expect(field('departmentId').currentLabel).toBe('Finance');
    expect(field('departmentId').originalLabel).toBe('Finance');
    expect(field('departmentId').carriesInto).toEqual([{ kind: 'promotion', effectiveDate: '2025-03-01' }]);
    expect(field('departmentId').stoppedBy).toEqual({ kind: 'transfer', effectiveDate: '2025-06-01' });
    expect(field('departmentId').reachesCurrent).toBe(false);
    // Position: the Promotion set it, so nothing later takes a correction of the hire's position.
    expect(field('positionId').carriesInto).toEqual([]);
    expect(field('positionId').stoppedBy).toEqual({ kind: 'promotion', effectiveDate: '2025-03-01' });
    // Cost centre: nobody ever set it, so every later record — the current one included — inherited it.
    expect(field('costCenterId').carriesInto.map((r) => r.effectiveDate)).toEqual(['2025-03-01', '2025-06-01', '2025-09-01']);
    expect(field('costCenterId').stoppedBy).toBeNull();
    expect(field('costCenterId').reachesCurrent).toBe(true);
  });

  it('the Promotion that inherited Finance takes the correction; the Transfer’s explicit department survives', async () => {
    const { id, hr, p2, p3 } = await careerWithTransfer();
    const res = await correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: hr }, reason: REASON });

    const live = await liveVersions(id);
    expect(live.map((v) => [v.validFrom, v.validTo])).toEqual([
      ['2025-01-01', '2025-03-01'],
      ['2025-03-01', '2025-06-01'],
      ['2025-06-01', '2025-09-01'],
      ['2025-09-01', null],
    ]);
    // Hired and the inheriting Promotion now hold Human Resources…
    expect(live[0].departmentId).toBe(hr);
    expect(live[1].departmentId).toBe(hr);
    // …the Transfer that SET Operations keeps it, and so does everything after it (NON-VACUITY anchor:
    // taking the "inherited" test out of the walk turns this into Human Resources).
    expect(live[2].departmentId).toBe(b.deptB);
    expect(live[3].departmentId).toBe(b.deptB);
    // Nothing else moved on any version.
    expect(live.map((v) => v.positionId)).toEqual([b.positionId, p2, p2, p3]);
    expect(live.every((v) => v.costCenterId === b.costCenterId)).toBe(true);
    expect(res.assignmentVersions).toBe(2);
    expect(res.currentRecordChanged).toEqual([]);
    expect(res.changes).toEqual([{ field: 'departmentId', before: b.deptA, after: hr }]);
  });

  it('the current record changes when it still holds the inherited value', async () => {
    const hr = await dept('Human Resources');
    const p2 = await pos('Senior Executive');
    const { employmentId: id } = await hireOne();
    await createMovementEvent(ctx(), { employmentId: id, kind: 'promotion', effectiveDate: '2025-03-01', positionId: p2 });
    const res = await correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: hr }, reason: REASON });
    const live = await liveVersions(id);
    expect(live.map((v) => v.departmentId)).toEqual([hr, hr]);
    expect(live[1].validTo).toBeNull();
    expect(res.currentRecordChanged).toEqual(['departmentId']);
  });

  it('a record whose value no longer matches its predecessor is not overwritten, even if its event said "inherited"', async () => {
    // Hired (Finance) → Transfer to Operations (explicit) → an assignment change that INHERITED Operations.
    // Rolling the Transfer back leaves the third record holding Operations right after the hire record —
    // its event still says before == after. The hire's Finance must not be carried over a value that is
    // not Finance.
    const hr = await dept('Human Resources');
    const p3 = await pos('Lead Executive');
    const { employmentId: id } = await hireOne();
    await createMovementEvent(ctx(), { employmentId: id, kind: 'transfer', effectiveDate: '2025-03-01', departmentId: b.deptB });
    await createMovementEvent(ctx(), { employmentId: id, kind: 'orgAssignmentChange', effectiveDate: '2025-06-01', positionId: p3 });
    const transfer = (await movementHistory(ctx(), id)).find((r) => r.kind === 'transfer')!;
    await reverseMovementEvent(ctx(), { employmentId: id, movementId: transfer.id, reason: 'Transfer keyed on the wrong person.' });
    expect((await liveVersions(id)).map((v) => [v.validFrom, v.departmentId])).toEqual([
      ['2025-01-01', b.deptA],
      ['2025-06-01', b.deptB],
    ]);
    await correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: hr }, reason: REASON });
    expect((await liveVersions(id)).map((v) => [v.validFrom, v.departmentId])).toEqual([
      ['2025-01-01', hr],
      ['2025-06-01', b.deptB],
    ]);
  });

  it('a position correction stops at the Promotion that set the position', async () => {
    const { id, p2 } = await careerWithTransfer();
    const p4 = await pos('Executive (corrected)');
    await correctHireDetails(ctx(), { employmentId: id, changes: { positionId: p4 }, reason: REASON });
    const live = await liveVersions(id);
    expect(live[0].positionId).toBe(p4);
    expect(live[1].positionId).toBe(p2);
  });
});

describe('c063eea9 — the original hire is never edited; history is kept', () => {
  it('leaves employment.hired byte-identical, keeps the superseded rows, and records one correction event with no salary', async () => {
    const hr = await dept('Human Resources');
    const p2 = await pos('Senior Executive');
    const { employmentId: id } = await hireOne();
    await setCompensation(ctx(), { employmentId: id, basicSalary: 4321, effectiveFrom: '2025-01-01' });
    await createMovementEvent(ctx(), { employmentId: id, kind: 'promotion', effectiveDate: '2025-03-01', positionId: p2 });
    const [hiredBefore] = await eventsOf(id, 'employment.hired');
    const eventCountBefore = (await eventsOf(id)).length;
    const originals = await liveVersions(id);

    await correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: hr }, reason: REASON });

    const hiredAfter = await eventsOf(id, 'employment.hired');
    expect(hiredAfter).toHaveLength(1);
    expect(hiredAfter[0]).toEqual(hiredBefore);
    expect((hiredAfter[0].payload as { departmentId: string }).departmentId).toBe(b.deptA);
    // Exactly one new ledger entry: the correction.
    const after = await eventsOf(id);
    expect(after.length).toBe(eventCountBefore + 1);
    const [corr] = await eventsOf(id, HIRE_CORRECTED_EVENT);
    expect(corr.actorId).toBe(b.adminUserId);

    // The superseded originals are still there, unchanged but for superseded_at.
    const all = await allVersions(id);
    for (const o of originals) {
      const row = all.find((r) => r.id === o.id)!;
      expect(row.supersededAt).not.toBeNull();
      expect(row.departmentId).toBe(b.deptA);
      expect([row.validFrom, row.validTo]).toEqual([o.validFrom, o.validTo]);
    }
    // …each beside a replacement over exactly the same range.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = corr.payload as any;
    expect(p.reason).toBe(REASON);
    expect(p.hiredEventId).toBe(hiredBefore.id);
    expect(p.changes).toEqual([{ field: 'departmentId', before: b.deptA, after: hr }]);
    expect(p.assignment.map((r: { supersededId: string }) => r.supersededId).sort()).toEqual(originals.map((o) => o.id).sort());
    for (const r of p.assignment as { supersededId: string; replacementId: string }[]) {
      const sup = all.find((x) => x.id === r.supersededId)!;
      const rep = all.find((x) => x.id === r.replacementId)!;
      expect(rep.supersededAt).toBeNull();
      expect([rep.validFrom, rep.validTo]).toEqual([sup.validFrom, sup.validTo]);
      expect(rep.departmentId).toBe(hr);
    }
    // No salary rides on the correction (ADR-0030 has nothing to redact).
    const json = JSON.stringify(p);
    expect(json).not.toMatch(/salary|basic|compensation|4321/i);
  });
});

describe('c063eea9 — the Hired row on Employment History', () => {
  it('is marked "hire details corrected", keeps its place and shows what was originally recorded', async () => {
    const { id, hr } = await careerWithTransfer();
    const before = await movementHistory(ctx(), id);
    await correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: hr }, reason: REASON });
    const rows = await movementHistory(ctx(), id);

    expect(rows.map((r) => [r.kind, r.effectiveDate])).toEqual(before.map((r) => [r.kind, r.effectiveDate]));
    expect(rows[0].kind).toBe('hired');
    const hired = rows[0];
    expect(hired.reversed).toBeNull();
    expect(hired.status).toBe('applied');
    expect(hired.canEdit).toBe(false);
    expect(hired.canReverse).toBe(false);
    expect(hired.department).toBe('Human Resources');
    expect(hired.hireCorrection).toMatchObject({
      count: 1,
      reason: REASON,
      fields: [{ field: 'departmentId', original: 'Finance', corrected: 'Human Resources' }],
    });
    expect(rows.filter((r) => r.kind !== 'hired').every((r) => r.hireCorrection === null)).toBe(true);
    expect(rows.find((r) => r.kind === 'promotion')!.department).toBe('Human Resources');
    expect(rows.find((r) => r.kind === 'transfer')!.department).toBe('Operations');
    // Not a correction artefact: the default view still draws it.
    expect(partitionMovementRows(rows, false).visible.map((r) => r.id)).toContain(hired.id);

    const detail = await movementDetail(ctx(), id, hired.id);
    expect(detail!.after.department).toBe('Human Resources');
    expect(detail!.hireCorrection?.fields).toEqual([
      { field: 'departmentId', original: 'Finance', corrected: 'Human Resources' },
    ]);
  });

  it('correcting again is the undo — the walk still finds the replaced rows’ origins', async () => {
    const hr = await dept('Human Resources');
    const p2 = await pos('Senior Executive');
    const { employmentId: id } = await hireOne();
    await createMovementEvent(ctx(), { employmentId: id, kind: 'promotion', effectiveDate: '2025-03-01', positionId: p2 });
    await correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: hr }, reason: REASON });
    await correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: b.deptA }, reason: 'Reverting.' });
    expect((await liveVersions(id)).map((v) => v.departmentId)).toEqual([b.deptA, b.deptA]);
    const hired = (await movementHistory(ctx(), id))[0];
    expect(hired.hireCorrection).toMatchObject({
      count: 2,
      reason: 'Reverting.',
      fields: [{ field: 'departmentId', original: 'Finance', corrected: 'Finance' }],
    });
    expect((await allVersions(id)).filter((v) => v.supersededAt).length).toBe(4);
  });
});

describe('c063eea9 — later corrections of the movements still work on the corrected rows', () => {
  it('a later Roll Back of the Promotion reopens the corrected hire row (it does not find a superseded one and stop)', async () => {
    const hr = await dept('Human Resources');
    const p2 = await pos('Senior Executive');
    const { employmentId: id } = await hireOne();
    await createMovementEvent(ctx(), { employmentId: id, kind: 'promotion', effectiveDate: '2025-03-01', positionId: p2 });
    await correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: hr }, reason: REASON });
    const promo = (await movementHistory(ctx(), id)).find((r) => r.kind === 'promotion')!;
    expect(promo.canReverse).toBe(true);
    await reverseMovementEvent(ctx(), { employmentId: id, movementId: promo.id, reason: 'Promotion keyed in error.' });

    const live = await liveVersions(id);
    expect(live).toHaveLength(1);
    expect([live[0].validFrom, live[0].validTo]).toEqual(['2025-01-01', null]);
    expect(live[0].departmentId).toBe(hr);
    expect(live[0].positionId).toBe(b.positionId);
  });

  it('an Edit of the latest movement after a correction replays on top of the corrected value', async () => {
    const hr = await dept('Human Resources');
    const p2 = await pos('Senior Executive');
    const p3 = await pos('Principal');
    const { employmentId: id } = await hireOne();
    await createMovementEvent(ctx(), { employmentId: id, kind: 'promotion', effectiveDate: '2025-03-01', positionId: p2 });
    await correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: hr }, reason: REASON });
    const promo = (await movementHistory(ctx(), id)).find((r) => r.kind === 'promotion' && !r.reversed)!;
    await editMovementEvent(ctx(), {
      employmentId: id,
      movementId: promo.id,
      kind: 'promotion',
      effectiveDate: '2025-03-01',
      positionId: p3,
      reason: 'Wrong position on the promotion.',
    });
    const live = await liveVersions(id);
    expect(live.map((v) => [v.validFrom, v.departmentId, v.positionId])).toEqual([
      ['2025-01-01', hr, b.positionId],
      ['2025-03-01', hr, p3],
    ]);
  });

  it('a pending scheduled movement is left alone, and applies on top of the corrected value', async () => {
    const hr = await dept('Human Resources');
    const p2 = await pos('Senior Executive');
    const { employmentId: id } = await hireOne();
    const t = Date.parse(`${todayInKualaLumpur()}T00:00:00Z`) + 30 * 86_400_000;
    const future = new Date(t).toISOString().slice(0, 10);
    await createMovementEvent(ctx(), { employmentId: id, kind: 'promotion', effectiveDate: future, positionId: p2 });
    const res = await correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: hr }, reason: REASON });
    // The pending movement wrote nothing, so the hire version is still the current record.
    expect(res.currentRecordChanged).toEqual(['departmentId']);
    const pending = (await movementHistory(ctx(), id)).find((r) => r.kind === 'promotion')!;
    expect(pending.status).toBe('pending');
    expect(pending.reversed).toBeNull();

    await sweepDueMovements(ctx(), { today: future });
    const live = await liveVersions(id);
    expect(live.map((v) => [v.validFrom, v.departmentId, v.positionId])).toEqual([
      ['2025-01-01', hr, b.positionId],
      [future, hr, p2],
    ]);
  });
});

describe('c063eea9 — validation and refusals', () => {
  it('refuses a label the hire’s own company cannot use, and writes nothing', async () => {
    const coB = await companyB();
    const foreign = await dept('Beta Finance', { companyId: coB });
    const { employmentId: id } = await hireOne();
    const before = (await eventsOf(id)).length;
    await expect(
      correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: foreign }, reason: REASON }),
    ).rejects.toThrow(/not a valid option for Acme Sdn Bhd, the company the employee was hired into/);
    expect((await allVersions(id)).every((v) => v.supersededAt === null)).toBe(true);
    expect((await eventsOf(id)).length).toBe(before);
  });

  it('refuses when a LATER record that inherited the value belongs to a company that cannot use the new label', async () => {
    const coB = await companyB();
    const globalDept = await dept('Group Finance', { sharedInto: coB });
    const acmeOnly = await dept('Acme Admin');
    const globalHr = await dept('Group HR', { sharedInto: coB });
    const { employmentId: id } = await hireOne({ departmentId: globalDept, positionId: null, costCenterId: null });
    // Entity Transfer to Beta, keeping the (global) department — so Beta's version INHERITED it.
    await createMovementEvent(ctx(), { employmentId: id, kind: 'entityTransfer', effectiveDate: '2025-06-01', companyId: coB });
    const live0 = await liveVersions(id);
    expect(live0.map((v) => [v.companyId, v.departmentId])).toEqual([
      [b.companyId, globalDept],
      [coB, globalDept],
    ]);

    await expect(
      correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: acmeOnly }, reason: REASON }),
    ).rejects.toThrow(/not a valid option for Beta Sdn Bhd, the company on the record from 2025-06-01/);
    expect((await allVersions(id)).every((v) => v.supersededAt === null)).toBe(true);

    // A label BOTH companies may use is carried into the Beta record.
    await correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: globalHr }, reason: REASON });
    expect((await liveVersions(id)).map((v) => [v.companyId, v.departmentId])).toEqual([
      [b.companyId, globalHr],
      [coB, globalHr],
    ]);
  });

  it('only hr_admin / super_admin may correct; a reason is required; a no-op and a blank department are refused', async () => {
    const hr = await dept('Human Resources');
    const { employmentId: id } = await hireOne();
    const manager: SessionContext = { ...ctx(), roles: ['manager'] };
    await expect(
      correctHireDetails(manager, { employmentId: id, changes: { departmentId: hr }, reason: REASON }),
    ).rejects.toThrow('Only an admin can correct hire details.');
    await expect(
      correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: hr }, reason: '   ' }),
    ).rejects.toBeInstanceOf(HireCorrectionReasonRequiredError);
    await expect(
      correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: b.deptA }, reason: REASON }),
    ).rejects.toBeInstanceOf(HireCorrectionNoChangeError);
    await expect(
      correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: null }, reason: REASON }),
    ).rejects.toThrow('Department is required.');
    expect((await allVersions(id)).every((v) => v.supersededAt === null)).toBe(true);
    // super_admin passes the role gate.
    await correctHireDetails({ ...ctx(), roles: ['super_admin'] }, { employmentId: id, changes: { departmentId: hr }, reason: REASON });
    expect((await liveVersions(id))[0].departmentId).toBe(hr);
  });

  it('the actor must administer the company of EVERY record the correction touches', async () => {
    const coB = await companyB();
    const globalDept = await dept('Group Finance', { sharedInto: coB });
    const globalHr = await dept('Group HR', { sharedInto: coB });
    const { employmentId: id } = await hireOne({ departmentId: globalDept, positionId: null, costCenterId: null });
    await createMovementEvent(ctx(), { employmentId: id, kind: 'entityTransfer', effectiveDate: '2025-06-01', companyId: coB });

    // An admin of Beta only (the employee's company TODAY) cannot reach back into the Acme hire record.
    const betaOnly: SessionContext = { ...ctx(), roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: coB }] };
    await expect(
      correctHireDetails(betaOnly, { employmentId: id, changes: { departmentId: globalHr }, reason: REASON }),
    ).rejects.toThrow(/only correct these hire details if you manage Acme Sdn Bhd/);
    expect((await allVersions(id)).every((v) => v.supersededAt === null)).toBe(true);

    // An admin of both companies may.
    const both: SessionContext = {
      ...ctx(),
      roles: ['hr_admin'],
      grants: [
        { role: 'hr_admin', companyId: b.companyId },
        { role: 'hr_admin', companyId: coB },
      ],
    };
    await correctHireDetails(both, { employmentId: id, changes: { departmentId: globalHr }, reason: REASON });
    expect((await liveVersions(id)).map((v) => v.departmentId)).toEqual([globalHr, globalHr]);
  });

  it('fields the correction does not own are ignored even when posted — service and form parser alike', async () => {
    const hr = await dept('Human Resources');
    const coB = await companyB();
    const grade = await createJobGrade(ctx(), { code: `G${randomUUID().slice(0, 6)}`, name: 'Forged Grade' });
    const { employmentId: id } = await hireOne();
    await setCompensation(ctx(), { employmentId: id, basicSalary: 3000, effectiveFrom: '2025-01-01' });
    const empBefore = (await owner.db.select().from(schema.employment).where(eq(schema.employment.id, id)))[0];
    const compBefore = await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId, id));

    await correctHireDetails(ctx(), {
      employmentId: id,
      changes: {
        departmentId: hr,
        companyId: coB,
        gradeId: grade.id,
        employmentType: 'contract',
        hiredOn: '2020-01-01',
        joinDate: '2020-01-01',
        basicSalary: 1,
      },
      reason: REASON,
    });
    const empAfter = (await owner.db.select().from(schema.employment).where(eq(schema.employment.id, id)))[0];
    expect(empAfter).toEqual(empBefore);
    expect(await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId, id))).toEqual(compBefore);
    const live = await liveVersions(id);
    expect(live[0].departmentId).toBe(hr);
    expect(live[0].employmentType).toBe('full_time');
    expect(live[0].companyId).toBe(b.companyId);
    const [corr] = await eventsOf(id, HIRE_CORRECTED_EVENT);
    expect((corr.payload as { changes: { field: string }[] }).changes.map((c) => c.field)).toEqual(['departmentId']);

    const fd = new FormData();
    for (const [k, v] of Object.entries({
      departmentId: hr,
      positionId: '',
      companyId: coB,
      gradeId: grade.id,
      employmentType: 'contract',
      hiredOn: '2020-01-01',
      joinDate: '2020-01-01',
      basicSalary: '1',
      tab: 'careerMovement',
    }))
      fd.set(k, v);
    // Absent = untouched, blank = clear, anything else is never read.
    expect(parseHireCorrectionForm(fd)).toEqual({ departmentId: hr, positionId: null });
  });
});

describe('c063eea9 — reporting manager at hire', () => {
  it('replaces only the line in force at hire; a later Direct Superior choice is kept', async () => {
    const m1 = await hireOne({ name: 'Siti Aminah' });
    const m2 = await hireOne({ name: 'Later Superior' });
    const m3 = await hireOne({ name: 'Correct Manager' });
    const { employmentId: id } = await hireOne({ managerEmploymentId: m1.employmentId });
    await setReportingLine(ctx(), {
      subordinateEmploymentId: id,
      managerEmploymentId: m2.employmentId,
      lineType: 'administrative',
      validFrom: '2025-06-01',
      movement: { type: 'reportingLineChange', groupId: randomUUID() },
    });
    const view = await hireCorrectionView(ctx(), id);
    const mgr = view.fields.find((f) => f.field === 'managerEmploymentId')!;
    expect(mgr.currentLabel).toBe('Siti Aminah');
    expect(mgr.stoppedBy).toEqual({ kind: 'reportingLineChange', effectiveDate: '2025-06-01' });
    expect(mgr.reachesCurrent).toBe(false);

    const res = await correctHireDetails(ctx(), {
      employmentId: id,
      changes: { managerEmploymentId: m3.employmentId },
      reason: 'Wrong manager keyed at hire.',
    });
    expect(res.currentRecordChanged).toEqual([]);
    const lines = await owner.db
      .select()
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.subordinateEmploymentId, id))
      .orderBy(asc(schema.reportingLine.validFrom));
    const live = lines.filter((l) => !l.supersededAt);
    expect(live.map((l) => [l.validFrom, l.validTo, l.managerEmploymentId])).toEqual([
      ['2025-01-01', '2025-06-01', m3.employmentId],
      ['2025-06-01', null, m2.employmentId],
    ]);
    // The original line to Siti Aminah stays, superseded.
    expect(lines.filter((l) => l.supersededAt).map((l) => l.managerEmploymentId)).toEqual([m1.employmentId]);
    const hired = (await movementHistory(ctx(), id))[0];
    expect(hired.hireCorrection?.fields).toEqual([
      { field: 'managerEmploymentId', original: 'Siti Aminah', corrected: 'Correct Manager' },
    ]);
  });

  it('adds a manager where none was recorded at hire, and can clear one; refuses a reporting cycle', async () => {
    const m = await hireOne({ name: 'Manager' });
    const { employmentId: id } = await hireOne();
    const res = await correctHireDetails(ctx(), {
      employmentId: id,
      changes: { managerEmploymentId: m.employmentId },
      reason: 'Manager was not keyed at hire.',
    });
    expect(res.currentRecordChanged).toEqual(['managerEmploymentId']);
    const liveLines = async () =>
      (await owner.db.select().from(schema.reportingLine).where(eq(schema.reportingLine.subordinateEmploymentId, id))).filter(
        (l) => !l.supersededAt,
      );
    expect((await liveLines()).map((l) => [l.validFrom, l.validTo, l.managerEmploymentId])).toEqual([
      ['2025-01-01', null, m.employmentId],
    ]);

    // A subordinate of this employee cannot become their manager at hire.
    const sub = await hireOne({ name: 'Subordinate', managerEmploymentId: id });
    await expect(
      correctHireDetails(ctx(), { employmentId: id, changes: { managerEmploymentId: sub.employmentId }, reason: 'x' }),
    ).rejects.toThrow(/reporting cycle/);
    await expect(
      correctHireDetails(ctx(), { employmentId: id, changes: { managerEmploymentId: id }, reason: 'x' }),
    ).rejects.toBeInstanceOf(HireCorrectionError);

    await correctHireDetails(ctx(), { employmentId: id, changes: { managerEmploymentId: null }, reason: 'No manager at hire.' });
    expect(await liveLines()).toEqual([]);
  });
});

describe('c063eea9 — entitlement follows the corrected department', () => {
  it('a superseded row never matches an org criterion', async () => {
    const hr = await dept('Human Resources');
    const { employmentId: id } = await hireOne();
    await correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: hr }, reason: REASON });
    const at = (departmentIds: string[]) =>
      withTenant(ctx(), (tx) => resolveOrgCriteriaTargets(tx, { criteria: { departmentIds }, asOf: '2025-02-01', employmentIds: [id] }));
    expect(await at([b.deptA])).toEqual([]);
    expect(await at([hr])).toEqual([id]);
  });

  it('the recalculation the correction triggers moves the balance to the corrected department’s table', async () => {
    const c = ctx();
    const hr = await dept('Human Resources');
    const finance = await createEntitlementTemplate(c, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Finance Annual',
      serviceBands: [{ fromYears: 0, toYears: null, days: 8 }],
      validFrom: '2020-01-01',
    });
    const hrTable = await createEntitlementTemplate(c, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'HR Annual',
      serviceBands: [{ fromYears: 0, toYears: null, days: 16 }],
      validFrom: '2020-01-01',
    });
    await createEligibilityRule(c, { name: 'Finance', templateLineageId: finance.lineageId, criteria: { departmentIds: [b.deptA] }, validFrom: '2020-01-01' });
    await createEligibilityRule(c, { name: 'HR', templateLineageId: hrTable.lineageId, criteria: { departmentIds: [hr] }, validFrom: '2020-01-01' });
    const { employmentId: id } = await hireOne({ hiredOn: '2026-01-01', grantAnnual: true });
    const balance = async () => {
      const rows = await owner.db.select({ days: schema.leaveLedger.days }).from(schema.leaveLedger).where(
        and(eq(schema.leaveLedger.employmentId, id), eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId)),
      );
      return rows.reduce((s, r) => s + Number(r.days), 0);
    };
    expect(await balance()).toBe(8);

    const res = await correctHireDetails(c, { employmentId: id, changes: { departmentId: hr }, reason: REASON });
    // What correctHireDetailsAction runs after the save, with its trigger.
    await reprojectEntitlementForEmployment(c, {
      employmentId: id,
      asOf: '2026-06-30',
      trigger: 'hire_corrected',
      changeEffectiveOn: res.hiredOn,
    });
    expect(await balance()).toBe(16);
    const audit = await owner.db
      .select()
      .from(schema.leaveEntitlementRecalcAudit)
      .where(eq(schema.leaveEntitlementRecalcAudit.employmentId, id));
    expect(audit.map((a) => [a.reason, Number(a.previousEntitlement), Number(a.newEntitlement)])).toEqual([
      ['hire_corrected', 8, 16],
    ]);
  });
});

describe('c063eea9 — the pre-transaction company correction leaves a zero-length version at hire', () => {
  it('the correction targets the re-homed hire version, validated against its company', async () => {
    const coB = await companyB();
    const betaOps = await dept('Beta Operations', { companyId: coB });
    const betaHr = await dept('Beta HR', { companyId: coB });
    const { employmentId: id } = await hireOne({ positionId: null, costCenterId: null });
    // Activation always writes the hire-date salary; it no longer locks the Company (c063eea9 (1)).
    await setCompensation(ctx(), { employmentId: id, basicSalary: 3000, effectiveFrom: '2025-01-01' });
    await changeEmploymentCompany(ctx(), { employmentId: id, newCompanyId: coB, departmentId: betaOps });
    const all0 = await liveVersions(id);
    expect(all0.some((v) => v.validTo === v.validFrom)).toBe(true);

    const view = await hireCorrectionView(ctx(), id);
    expect(view.companyId).toBe(coB);
    expect(view.fields.find((f) => f.field === 'departmentId')!.currentId).toBe(betaOps);
    await correctHireDetails(ctx(), { employmentId: id, changes: { departmentId: betaHr }, reason: REASON });
    const open = (await liveVersions(id)).filter((v) => v.validTo === null);
    expect(open.map((v) => [v.companyId, v.departmentId])).toEqual([[coB, betaHr]]);
  });
});

describe('c063eea9 — the screen and the action', () => {
  const root = path.resolve(__dirname, '..');
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  it('every hireCorrection string exists in all six locales with the same keys, plus the recalc reason', () => {
    const en = JSON.parse(read('messages/en.json')).people.detail;
    const keys = Object.keys(en.movement.hireCorrection).sort();
    expect(keys.length).toBeGreaterThan(30);
    for (const l of ['ms', 'zh', 'ta', 'th', 'vi']) {
      const m = JSON.parse(read(`messages/${l}.json`)).people.detail;
      expect(Object.keys(m.movement.hireCorrection).sort()).toEqual(keys);
      for (const k of keys) expect(String(m.movement.hireCorrection[k]).trim().length).toBeGreaterThan(0);
      expect(typeof m.recalcReason.hire_corrected).toBe('string');
    }
    expect(en.recalcReason.hire_corrected).toBe('Hire details corrected');
  });

  it('the action recomputes entitlement with trigger hire_corrected and redacts errors through publicErrorMessage', () => {
    const src = read('app/admin/personnel/[employmentId]/actions.ts');
    const start = src.indexOf('export async function correctHireDetailsAction');
    const end = src.indexOf('export async function', start + 10);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body.length).toBeGreaterThan(400);
    expect(body).toContain("recomputeEntitlement(s, employmentId, 'hire_corrected'");
    expect(body).toContain('publicErrorMessage(e)');
    expect(body).toContain('parseHireCorrectionForm(formData)');
  });

  it('the Hired row offers the action and wears its own badge, not the rolled-back Corrected badge', () => {
    const src = read('app/admin/personnel/[employmentId]/page.tsx');
    expect(src).toContain("canCreateMovement && m.kind === 'hired'");
    expect(src).toContain("t('movement.hireCorrection.action')");
    expect(src).toContain("t('movement.hireCorrection.badge')");
    expect(src).toContain('{hireCorrectionCard}');
  });
});

describe('c063eea9 (2) — a join date cannot move across payslips', () => {
  /** A payslip for `period`, in a batch of `status`, optionally with coverage dates. */
  async function payslipFor(employmentId: string, period: string, status: 'draft' | 'processed' | 'closed', coverage?: [string, string]) {
    const [pp] = await owner.db
      .insert(schema.payPeriod)
      .values({ tenantId: b.tenantId, companyId: b.companyId, period, status: status === 'closed' ? 'closed' : 'open' })
      .returning({ id: schema.payPeriod.id });
    const [batch] = await owner.db
      .insert(schema.payrollBatch)
      .values({ tenantId: b.tenantId, companyId: b.companyId, payPeriodId: pp.id, payPeriod: period, batchDate: `${period}-25`, status })
      .returning({ id: schema.payrollBatch.id });
    await owner.db.insert(schema.payslip).values({
      tenantId: b.tenantId,
      batchId: batch.id,
      employmentId,
      basicSalary: '3000.00',
      grossPay: '3000.00',
      statutory: {},
      totalDeductions: '0.00',
      netPay: '3000.00',
      employerCost: '3000.00',
      ...(coverage ? { coverageFrom: coverage[0], coverageTo: coverage[1] } : {}),
    });
  }
  const datesOf = async (id: string) =>
    (
      await owner.db
        .select({ hiredOn: schema.employment.hiredOn, joinDate: schema.employment.joinDate })
        .from(schema.employment)
        .where(eq(schema.employment.id, id))
    )[0];

  it('a Group Join Date Correction back across a prorated, closed payslip is refused, with the periods named', async () => {
    const { employmentId: id } = await hireOne({ hiredOn: '2025-01-15' });
    // A mid-month joiner's January payslip covers the 15th onwards; moving the start to the 1st changes it.
    await payslipFor(id, '2025-01', 'closed', ['2025-01-15', '2025-01-31']);
    await payslipFor(id, '2025-02', 'closed');
    await expect(
      createMovementEvent(ctx(), { employmentId: id, kind: 'groupJoinDateCorrection', effectiveDate: '2025-01-01' }),
    ).rejects.toThrow('Payslips already exist between 2025-01-15 and 2025-01-01 (payroll 2025-01)');
    // Forward, into the paid month, too.
    await expect(
      createMovementEvent(ctx(), { employmentId: id, kind: 'groupJoinDateCorrection', effectiveDate: '2025-02-10' }),
    ).rejects.toThrow('(payroll 2025-01, 2025-02)');
    expect(await datesOf(id)).toEqual({ hiredOn: '2025-01-15', joinDate: '2025-01-15' });
  });

  it('any payslip counts — a draft run is still a payslip', async () => {
    const { employmentId: id } = await hireOne({ hiredOn: '2025-01-15' });
    await payslipFor(id, '2025-01', 'draft');
    await expect(
      createMovementEvent(ctx(), { employmentId: id, kind: 'groupJoinDateCorrection', effectiveDate: '2025-01-10' }),
    ).rejects.toThrow(/Group Join Date cannot be moved across them/);
  });

  it('a correction that crosses no payslip goes through (and carries the synchronised Join Date)', async () => {
    const { employmentId: id } = await hireOne({ hiredOn: '2025-01-15' });
    await payslipFor(id, '2025-06', 'closed');
    await createMovementEvent(ctx(), { employmentId: id, kind: 'groupJoinDateCorrection', effectiveDate: '2025-01-02' });
    expect(await datesOf(id)).toEqual({ hiredOn: '2025-01-02', joinDate: '2025-01-02' });
  });

  it('a Join Date Change across a payslip is refused; one that crosses none goes through', async () => {
    const { employmentId: id } = await hireOne({ hiredOn: '2025-01-15' });
    await payslipFor(id, '2025-03', 'processed');
    await expect(
      createMovementEvent(ctx(), { employmentId: id, kind: 'joinDateChange', effectiveDate: '2025-04-01' }),
    ).rejects.toThrow('Payslips already exist between 2025-01-15 and 2025-04-01 (payroll 2025-03), so the Join Date cannot be moved across them.');
    expect((await datesOf(id)).joinDate).toBe('2025-01-15');
    await createMovementEvent(ctx(), { employmentId: id, kind: 'joinDateChange', effectiveDate: '2025-02-01' });
    expect((await datesOf(id)).joinDate).toBe('2025-02-01');
  });
});
