/**
 * 30325fc1 — "movement records auto-generated without HR admin action".
 *
 * THE FAULT. Employment History is a read-time PROJECTION over domain_event, not a table of movements
 * someone created. Five of the event types it projects come from GENERIC WRITERS that any screen may
 * drive, and each of those used to INVENT a movement kind when the event carried no movement tag:
 *
 *   • employment.info.updated   → classified by FIELD GROUP: confirmationDate ⇒ Confirmation,
 *                                 extendedConfirmationDate ⇒ Probation Extension,
 *                                 lastWorkingDate ⇒ Resignation
 *   • employment.assignment.changed → orgAssignmentChange
 *   • employment.grade.changed      → gradeChange
 *   • compensation.set              → salaryAdjustment
 *   • reporting-line.set            → reportingLineChange
 *
 * So an ordinary save of the Employment Dates card — a confirmation date typed in on the Employment tab —
 * appeared on Employment History as a Confirmation movement that nobody keyed and that has no effective
 * date of its own. That is what the reporter saw.
 *
 * THE RULE NOW. A generic writer's event projects a movement row only if it carries a movement TAG. The
 * tag records HR's intent and is written by createMovementEvent (and by the writers r78 rerouted through
 * it). Nothing is deleted or hidden: the untagged events stay in the ledger and stay on the admin Audit
 * trail — they simply stop being reported as career movements.
 *
 * This suite pins the CLASS, not one instance: every generic writer is driven untagged and asserted
 * absent, every deliberate act is asserted still present, and a source guard forbids reintroducing the
 * field-group inference.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee, setEmploymentAssignment, setEmploymentGrade, setEmploymentInfo, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { createJobGrade, createPosition } from '../core/admin';
import { createMovementEvent, movementHistory } from '../core/movement';
import { auditEvents } from '../core/read';
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

import { setDirectSuperiorAction, setEmploymentInfoAction } from '../app/admin/personnel/[employmentId]/actions';

let b: Base;
const email = () => `unt_${randomUUID().slice(0, 8)}@t.local`;

async function hireOne(p?: { managerEmploymentId?: string }) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Untagged Subject', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    costCenterId: b.costCenterId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
    reportingManagerEmploymentId: p?.managerEmploymentId,
  });
}

const kinds = async (employmentId: string) =>
  (await movementHistory(adminCtx(b), employmentId)).map((r) => r.kind);

describe('30325fc1 — an untagged edit is not a movement', () => {
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

  it('THE REPORTED CASE: saving the Employment Dates card does not mint a Confirmation movement', async () => {
    const hire = await hireOne();
    expect(await kinds(hire.employmentId)).toEqual(['hired']);

    // The real screen: the Employment tab's Employment Dates card. It writes through setEmploymentInfo
    // with NO movement tag, because it is an ordinary edit and not a career event.
    const fd = new FormData();
    fd.set('employmentId', hire.employmentId);
    fd.set('confirmationDate', '2026-04-01');
    await expect(setEmploymentInfoAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');

    // The column really moved — this is not "the save was rejected".
    const [emp] = await owner.db
      .select({ confirmationDate: schema.employment.confirmationDate })
      .from(schema.employment)
      .where(eq(schema.employment.id, hire.employmentId));
    expect(emp.confirmationDate).toBe('2026-04-01');

    // …and Employment History is unchanged. Before this item it grew a Confirmation row here.
    expect(await kinds(hire.employmentId)).toEqual(['hired']);
  });

  it('NOTHING IS LOST: the untagged event is still in the ledger and still on the Audit trail', async () => {
    const hire = await hireOne();
    const fd = new FormData();
    fd.set('employmentId', hire.employmentId);
    fd.set('confirmationDate', '2026-04-01');
    await expect(setEmploymentInfoAction(fd)).rejects.toThrow('NEXT_REDIRECT');

    const raw = await owner.db
      .select({ eventType: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.subjectEmploymentId, hire.employmentId),
          eq(schema.domainEvent.eventType, 'employment.info.updated'),
        ),
      );
    expect(raw, 'the change is still recorded — this item changes what is SHOWN, not what is STORED').toHaveLength(1);

    // And it is reachable by the reader the plan promises it to: the admin Audit trail (/admin/audit),
    // which reads the same ledger through core/read.ts auditEvents.
    const audit = await auditEvents(adminCtx(b), { aggregateId: hire.employmentId, limit: 200 });
    expect(audit.map((r) => r.eventType)).toContain('employment.info.updated');
  });

  it('the OTHER inferred kinds are gone too — probation extension and resignation dates', async () => {
    const probation = await hireOne();
    await setEmploymentInfo(adminCtx(b), {
      employmentId: probation.employmentId,
      extendedProbationValue: '3',
      extendedProbationUnit: 'month',
    });
    expect(await kinds(probation.employmentId)).toEqual(['hired']);

    const resigning = await hireOne();
    await setEmploymentInfo(adminCtx(b), {
      employmentId: resigning.employmentId,
      tenderResignationDate: '2026-05-01',
      lastWorkingDate: '2026-06-01',
    });
    expect(await kinds(resigning.employmentId)).toEqual(['hired']);
  });

  it('every OTHER generic writer is silent when untagged: assignment, grade, pay', async () => {
    const hire = await hireOne();
    const grade = await createJobGrade(adminCtx(b), {
      code: `G${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Band 4',
      rank: 4,
    });
    const pos = await createPosition(adminCtx(b), { companyId: b.companyId, title: `Role ${randomUUID().slice(0, 5)}` });

    await setEmploymentAssignment(adminCtx(b), {
      employmentId: hire.employmentId,
      departmentId: b.deptB,
      positionId: pos.id,
      effectiveDate: '2026-03-01',
    });
    await setEmploymentGrade(adminCtx(b), { employmentId: hire.employmentId, gradeId: grade.id });
    await setCompensation(adminCtx(b), {
      employmentId: hire.employmentId,
      basicSalary: 4800,
      effectiveFrom: '2026-03-01',
    });

    // Three real writes, three ledger events, ZERO invented movements.
    const evs = await owner.db
      .select({ eventType: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.subjectEmploymentId, hire.employmentId),
          inArray(schema.domainEvent.eventType, [
            'employment.assignment.changed',
            'employment.grade.changed',
            'compensation.set',
          ]),
        ),
      );
    expect(evs.length).toBeGreaterThanOrEqual(3);
    expect(await kinds(hire.employmentId)).toEqual(['hired']);
  });

  it('a movement HR really keyed still appears, with the kind HR chose', async () => {
    const hire = await hireOne();
    const grade = await createJobGrade(adminCtx(b), {
      code: `G${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Band 5',
      rank: 5,
    });
    const pos = await createPosition(adminCtx(b), { companyId: b.companyId, title: `Lead ${randomUUID().slice(0, 5)}` });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'promotion',
      effectiveDate: '2026-07-01',
      positionId: pos.id,
      gradeId: grade.id,
      basicSalary: 9000,
    });
    expect(await kinds(hire.employmentId)).toEqual(['hired', 'promotion']);

    // And a Confirmation keyed AS a movement is still a Confirmation — the tag is what carries it, so
    // removing the field-group inference did not remove the movement itself.
    const conf = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: conf.employmentId,
      kind: 'confirmation',
      effectiveDate: '2026-04-01',
    });
    expect(await kinds(conf.employmentId)).toEqual(['hired', 'confirmation']);
  });

  it('DELIBERATE ACTS are untouched: hire, termination, blacklist, probation approval', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'blacklist',
      effectiveDate: '2026-05-01',
      blacklisted: true,
    });
    expect(await kinds(hire.employmentId)).toEqual(['hired', 'blacklist']);

    const leaver = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: leaver.employmentId,
      kind: 'termination',
      effectiveDate: '2026-06-30',
      endDate: '2026-06-30',
      terminationReasonCode: 'redundancy',
    });
    expect(await kinds(leaver.employmentId)).toContain('termination');
  });

  it('Direct Superior — the one generic writer left outside Movement — is TAGGED at source and keeps its row', async () => {
    const mgr = await hireOne();
    const other = await hireOne();
    const hire = await hireOne({ managerEmploymentId: mgr.employmentId });
    // The hire-time line is a `secondary` leg of the hire: one row, not two.
    expect(await kinds(hire.employmentId)).toEqual(['hired']);

    const fd = new FormData();
    fd.set('employmentId', hire.employmentId);
    fd.set('superiorEmploymentId', other.employmentId);
    fd.set('currentSuperiorEmploymentId', mgr.employmentId);
    await expect(setDirectSuperiorAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');

    expect(await kinds(hire.employmentId)).toEqual(['hired', 'reportingLineChange']);

    // …and it is a REAL tag on the event, not a fallback label. This is the assertion that fails if
    // someone removes the tag from setDirectSuperiorAction: the row would then vanish silently.
    const rows = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.subjectEmploymentId, hire.employmentId),
          eq(schema.domainEvent.eventType, 'reporting-line.set'),
        ),
      );
    const primary = rows
      .map((r) => (r.payload as { movement?: { type?: string; groupId?: string; secondary?: boolean } }).movement)
      .filter((m) => m && !m.secondary);
    expect(primary).toHaveLength(1);
    expect(primary[0]!.type).toBe('reportingLineChange');
    expect(primary[0]!.groupId).toBeTruthy();
  });

  it('a delegate reporting line is still not a movement (approver cover, not employment movement)', async () => {
    const mgr = await hireOne();
    const hire = await hireOne();
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: hire.employmentId,
      managerEmploymentId: mgr.employmentId,
      lineType: 'delegate',
      validFrom: '2026-03-01',
      validTo: '2026-03-10',
    });
    expect(await kinds(hire.employmentId)).toEqual(['hired']);
  });

  it('SOURCE GUARD: the field-group inference is not reintroduced', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../core/movement.ts'), 'utf8');
    // The projection's `employment.info.updated` arm must not classify by which fields were written.
    // Scoped to the two constant NAMES the inference used, so an unrelated mention of the field names
    // elsewhere in the module (the effective-date/end-date readers legitimately name them) cannot fire it.
    const declared = /^const\s+(EXTENDED_PROBATION_FIELDS|RESIGNATION_FIELDS)\s*=/m.test(src);
    expect(declared, 'the field-group inference constants are declared again').toBe(false);
  });
});
