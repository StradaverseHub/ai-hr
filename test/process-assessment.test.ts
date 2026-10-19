import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  MIN_COMPLETED, PROCESS_IDS, PROCESS_PROFILES, assessProcesses, estimateLoad, parseBoundedInt, parseWindow, recommendRole,
  type ProcessMeasures,
} from '../core/process-assessment';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

describe('process assessment (ADR-0131 Phase 1)', () => {
  let base: Base;
  beforeAll(migrateTestDb);
  beforeEach(async () => { await resetDb(); base = await seedBase(); });
  afterAll(closeAll);

  async function fixture() {
    const hired = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Assessment fixture', primaryEmail: `assess-${randomUUID()}@example.test` },
      companyId: base.companyId, departmentId: base.deptA,
      employmentType: 'full_time', hiredOn: '2024-01-01', paymentMethod: 'bank_transfer',
    } as never);
    const employeeUserId = await createAppUser(base.tenantId, hired.personId, 'employee');
    return { ...hired, employeeUserId };
  }

  async function leave(employmentId: string, v: { created: Date; decided?: Date | null; status: 'pending' | 'approved' | 'rejected' | 'cancelled';
    imported?: boolean; group?: string }) {
    const [row] = await owner.db.insert(schema.leaveRequest).values({
      tenantId: base.tenantId, employmentId, leaveTypeId: base.annualLeaveTypeId,
      startDate: '2026-01-05', endDate: '2026-01-05', days: '1', status: v.status,
      createdAt: v.created, decidedAt: v.decided ?? null, importedHistory: v.imported ?? false, parentGroupId: v.group ?? null,
    }).returning({ id: schema.leaveRequest.id });
    return row.id;
  }

  async function event(aggregateId: string, actorType: 'user' | 'system', actorId: string | null, eventType: string, employmentId: string) {
    await owner.db.insert(schema.domainEvent).values({ tenantId: base.tenantId, aggregateType: 'leave-request', aggregateId,
      eventType, actorType, actorId, subjectEmploymentId: employmentId });
  }

  async function seedLeave() {
    const f = await fixture();
    const start = ago(10 * DAY);
    // Twelve approved cases taking 1..12 hours, each submitted by the employee and decided by HR.
    for (let h = 1; h <= 12; h++) {
      const id = await leave(f.employmentId, { created: start, decided: new Date(start.getTime() + h * HOUR), status: 'approved' });
      await event(id, 'user', f.employeeUserId, 'leave-request.submitted', f.employmentId);
      await event(id, 'user', base.adminUserId, 'leave-request.approved', f.employmentId);
    }
    const rejected = await leave(f.employmentId, { created: start, decided: new Date(start.getTime() + 24 * HOUR), status: 'rejected' });
    await event(rejected, 'user', f.employeeUserId, 'leave-request.submitted', f.employmentId);
    await event(rejected, 'user', base.adminUserId, 'leave-request.rejected', f.employmentId);
    // One submission split into two rows: ONE case, finished at the later decision (7h), two staff decisions.
    const group = randomUUID();
    const partA = await leave(f.employmentId, { created: start, decided: new Date(start.getTime() + 5 * HOUR), status: 'approved', group });
    const partB = await leave(f.employmentId, { created: start, decided: new Date(start.getTime() + 7 * HOUR), status: 'approved', group });
    await event(partA, 'user', f.employeeUserId, 'leave-request.submitted', f.employmentId);
    await event(partA, 'user', base.adminUserId, 'leave-request.step.approved', f.employmentId);
    await event(partB, 'user', base.adminUserId, 'leave-request.step.approved', f.employmentId);
    // Pending for nine days, with one automated escalation.
    const pending = await leave(f.employmentId, { created: ago(9 * DAY), status: 'pending' });
    await event(pending, 'user', f.employeeUserId, 'leave-request.submitted', f.employmentId);
    await event(pending, 'system', null, 'leave-request.escalation-due', f.employmentId);
    // Excluded: imported history and a case older than the window, each with a staff action.
    const imported = await leave(f.employmentId, { created: start, decided: start, status: 'approved', imported: true });
    await event(imported, 'user', base.adminUserId, 'leave-request.approved', f.employmentId);
    const old = await leave(f.employmentId, { created: ago(200 * DAY), decided: ago(199 * DAY), status: 'approved' });
    await event(old, 'user', base.adminUserId, 'leave-request.approved', f.employmentId);
    return f;
  }

  it('measures volume, elapsed time, rework and who acted, from the records alone', async () => {
    await seedLeave();
    const view = await assessProcesses(adminCtx(base), 90);
    const l = view.processes.find(p => p.id === 'leave')!;
    expect(l.enabled).toBe(true);
    expect(l.measures).toEqual({
      started: 15, completed: 14, open: 1, agedOpen: 1, rework: 1,
      // Sorted durations 1,2,3,4,5,6,7,7,8,9,10,11,12,24 h → median 7, p90 = 11 + 0.7 × (12 − 11).
      medianHours: 7, p90Hours: 11.7,
      staffActions: 15, employeeActions: 15, automatedActions: 1,
    });
    expect(l.staffActionsPer30).toBe(5);
    expect(l.role).toBe('automate_parts');
    // Leave has the most staff handling in this fixture, so it ranks first.
    expect(view.processes[0].id).toBe('leave');
    expect(view.processes.map(p => p.id).sort()).toEqual([...PROCESS_IDS].sort());
  });

  it('a narrower window excludes cases that started before it', async () => {
    await seedLeave();
    const l = (await assessProcesses(adminCtx(base), 30)).processes.find(p => p.id === 'leave')!;
    expect(l.measures!.started).toBe(15);
    expect(l.staffActionsPer30).toBe(15);
  });

  it('is scoped to what the caller could already open', async () => {
    await seedLeave();
    // A company administrator for another company sees none of these cases, although domain_event
    // itself is readable tenant-wide by administrators.
    const scoped = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: randomUUID() }] };
    const l = (await assessProcesses(scoped, 90)).processes.find(p => p.id === 'leave')!;
    expect(l.measures!.started).toBe(0);
    expect(l.measures!.staffActions).toBe(0);
    const other = await seedBase();
    const o = (await assessProcesses(adminCtx(other), 90)).processes.find(p => p.id === 'leave')!;
    expect(o.measures!.started).toBe(0);
  });

  it('refuses a caller who is not an administrator', async () => {
    const employee = { ...adminCtx(base), roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    await expect(assessProcesses(employee, 90)).rejects.toThrow('Only HR administrators');
  });
});

describe('process assessment rules', () => {
  const measures = (completed: number): ProcessMeasures => ({ started: completed, completed, open: 0, agedOpen: 0, rework: 0,
    medianHours: 1, p90Hours: 1, staffActions: 0, employeeActions: 0, automatedActions: 0 });

  it('never recommends automating a consequential decision, and asks for data first', () => {
    expect(recommendRole(PROCESS_PROFILES.claims, true, measures(MIN_COMPLETED))).toBe('assist');
    expect(recommendRole(PROCESS_PROFILES.leave, true, measures(MIN_COMPLETED))).toBe('automate_parts');
    expect(recommendRole(PROCESS_PROFILES.leave, true, measures(MIN_COMPLETED - 1))).toBe('measure_first');
    expect(recommendRole(PROCESS_PROFILES.leave, false, null)).toBe('off');
  });

  it('candidate actions never decide, approve, reject or pay', () => {
    const ids = Object.values(PROCESS_PROFILES).flatMap(p => p.actions.map(a => a.id));
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(id).not.toMatch(/(^|_)(approve|decide|reject|pay|terminate|grant)(_|$)/);
    // ADR-0131 §2: only reminders, information requests and engine-verifiable steps run without a click.
    const automatic = new Set(Object.values(PROCESS_PROFILES).flatMap(p => p.actions.filter(a => a.tier === 'automatic').map(a => a.id)));
    expect([...automatic].sort()).toEqual(['chase_overdue_approver', 'chase_step_owner', 'check_completeness',
      'request_missing_evidence', 'request_missing_information', 'tick_system_verified_steps']);
  });

  it('produces no time figure without the administrator’s own inputs', () => {
    expect(estimateLoad(30, null, 160)).toBeNull();
    expect(estimateLoad(30, 10, null)).toEqual({ hours: 5, fte: null });
    expect(estimateLoad(30, 10, 160)).toEqual({ hours: 5, fte: 0.03 });
    expect(parseBoundedInt('10', 1, 480)).toBe(10);
    for (const bad of ['', ' ', '0', '481', '1.5', '-3', 'ten', undefined]) expect(parseBoundedInt(bad, 1, 480)).toBeNull();
    expect(parseWindow('30')).toBe(30);
    expect(parseWindow('45')).toBe(90);
    expect(parseWindow(undefined)).toBe(90);
  });
});
