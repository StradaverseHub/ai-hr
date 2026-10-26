/** Authored source-interval acceptance; UNRUN until the coordinated local runtime window. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, terminateEmployment } from '../core/org';
import { createMovementEvent, createMovementEventTx, rehearseMovementSequenceTx, editMovementEvent } from '../core/movement';
import { applyLeaveAdjustmentBatch } from '../core/leave-adjustment';
import { lockLeaveDependenciesTx } from '../core/leave-dependency-lock';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

let b: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
afterAll(closeAll);

describe('participating canonical termination and Movement creation', () => {
  it.each(['direct', 'movement', 'movement-caller-tx'] as const)('%s refuses a protected employee interval without lifecycle effects, then commits after release', async path => {
    const ctx = adminCtx(b), today = todayInKualaLumpur();
    const employee = await hireEmployee(ctx, { person: { fullName: 'Fictional Lifecycle Participation',
      primaryEmail: `lifecycle-${randomUUID()}@t.local` }, companyId: b.companyId,
      departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${Number(today.slice(0, 4)) - 2}-01-01` });
    const employmentId = employee.employmentId;
    const input = { employmentId, kind: 'termination' as const, effectiveDate: today, endDate: today,
      terminationReasonCode: 'redundancy', remarks: 'Fictional concurrency acceptance' };
    const mutate = () => path === 'direct'
      ? terminateEmployment(ctx, { employmentId, terminationDate: today, terminationType: 'voluntary', terminationReason: 'Fictional concurrency acceptance' })
      : path === 'movement' ? createMovementEvent(ctx, input) : withTenant(ctx, tx => createMovementEventTx(tx, ctx, input));
    const state = async () => ({
      employment: await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId)),
      assignments: await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId, employmentId)).orderBy(schema.assignment.id),
      reporting: await owner.db.select().from(schema.reportingLine).where(eq(schema.reportingLine.tenantId, b.tenantId)).orderBy(schema.reportingLine.id),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state(); expect(before.employment[0].terminatedOn).toBeNull();
    let ready!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; failed = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { failed(new Error('owned lifecycle handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => {
      await lockLeaveDependenciesTx(tx, b.tenantId, [employmentId]); ready(); await finish;
    });
    void holder.catch(failed);
    try {
      await started; await expect(mutate()).rejects.toThrow('Leave source is unavailable');
      expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    await mutate();
    const after = await state(); expect(after.employment[0].terminatedOn).toBe(today);
    expect(after.assignments).toHaveLength(before.assignments.length);
    expect(after.assignments.filter(row => row.validTo === null)).toHaveLength(0);
    expect(after.events.filter(row => row.aggregateId === employmentId && row.eventType === 'employment.terminated')).toHaveLength(1);
  });
});


describe('Movement rehearsal outer dependency ownership — authored, unrun acceptance', () => {
  it('retains ownership after rehearsal rollback until actual replay commits, then releases it', async () => {
    const ctx = adminCtx(b), today = todayInKualaLumpur();
    const employee = await hireEmployee(ctx, { person: { fullName: 'Fictional Rehearsal Interval',
      primaryEmail: `rehearsal-${randomUUID()}@t.local` }, companyId: b.companyId,
      departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${Number(today.slice(0, 4)) - 2}-01-01` });
    const employmentId = employee.employmentId;
    const input = { employmentId, kind: 'secondment' as const, effectiveDate: today, remarks: 'Fictional rehearsal interval' };
    const state = async () => ({
      ledger: await owner.db.select().from(schema.leaveLedger).where(eq(schema.leaveLedger.employmentId, employmentId)).orderBy(schema.leaveLedger.id),
      batches: await owner.db.select().from(schema.leaveAdjustmentBatch).where(eq(schema.leaveAdjustmentBatch.tenantId, b.tenantId)).orderBy(schema.leaveAdjustmentBatch.id),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state();
    let ready!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; failed = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { failed(new Error('owned outer rehearsal handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => {
      const prepared = await rehearseMovementSequenceTx(tx, ctx, async (_shadow, create) => { await create(input); });
      ready(); await finish;
      await prepared.replay(input);
    });
    void holder.catch(failed);
    const adjust = () => applyLeaveAdjustmentBatch(ctx, { leaveTypeIds: [b.annualLeaveTypeId], days: 2,
      effectiveOn: today, reason: 'Fictional protected interval', targetMode: 'individual', employmentIds: [employmentId] });
    try {
      await started;
      // Rehearsal writes were rolled back; ownership was acquired outside that savepoint.
      expect(await state()).toEqual(before);
      await expect(adjust()).rejects.toThrow('Leave source is unavailable');
      expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    const replayed = await state();
    expect(replayed.events.filter(row => row.aggregateId === employmentId && row.eventType === 'employment.movement.recorded')).toHaveLength(1);
    expect(replayed.ledger).toEqual(before.ledger); expect(replayed.batches).toEqual(before.batches);
    expect((await adjust()).written).toBe(1);
    const after = await state(); expect(after.ledger).toHaveLength(before.ledger.length + 1);
    expect(after.batches).toHaveLength(before.batches.length + 1);
  });
});


describe('Movement correction source interval — authored, unrun acceptance', () => {
  it('refuses a protected interval before correction and preserves the original immutable record', async () => {
    const ctx = adminCtx(b), today = todayInKualaLumpur();
    const employee = await hireEmployee(ctx, { person: { fullName: 'Fictional Correction Interval',
      primaryEmail: `correction-${randomUUID()}@t.local` }, companyId: b.companyId,
      departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${Number(today.slice(0, 4)) - 2}-01-01` });
    const employmentId = employee.employmentId;
    await createMovementEvent(ctx, { employmentId, kind: 'secondment', effectiveDate: today, remarks: 'Fictional original' });
    const events = () => owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.subjectEmploymentId, employmentId)).orderBy(schema.domainEvent.id);
    const before = await events(), original = before.find(row => row.eventType === 'employment.movement.recorded');
    expect(original).toBeDefined();
    const correct = () => editMovementEvent(ctx, { employmentId, movementId: original!.id,
      kind: 'secondment', effectiveDate: today, remarks: 'Fictional corrected', reason: 'Correct fictional record' });
    let ready!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; failed = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { failed(new Error('owned correction handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => {
      await lockLeaveDependenciesTx(tx, b.tenantId, [employmentId]); ready(); await finish;
    });
    void holder.catch(failed);
    try {
      await started; await expect(correct()).rejects.toThrow('Leave source is unavailable');
      expect(await events()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    await correct();
    const after = await events();
    expect(after.find(row => row.id === original!.id)).toEqual(original);
    expect(after.filter(row => row.eventType === 'employment.movement.reversed')).toHaveLength(1);
    expect(after.filter(row => row.eventType === 'employment.movement.recorded')).toHaveLength(2);
    const corrected = after.find(row => row.id !== original!.id && row.eventType === 'employment.movement.recorded');
    expect(corrected?.payload).toMatchObject({ remarks: 'Fictional corrected' });
  });
});

/** Authored actual new-subject/cohort writer cases; UNRUN pending coordinated local admission. */
describe('canonical hire configuration participant', () => {
  it.each(['direct', 'caller-tx'] as const)('%s refuses before creating any hire graph or opening grant, then succeeds after release', async path => {
    const ctx = adminCtx(b), today = todayInKualaLumpur();
    const existing = await hireEmployee(ctx, { person: { fullName: 'Fictional Existing Interval',
      primaryEmail: `hire-holder-${randomUUID()}@t.local` }, companyId: b.companyId,
      departmentId: b.deptA, employmentType: 'full_time', hiredOn: today });
    await seedEntitlement(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 12,
      validFrom: `${today.slice(0, 4)}-01-01`, name: 'Fictional guarded hire entitlement' });
    const input = { person: { fullName: 'Fictional Protected Hire', primaryEmail: `hire-target-${randomUUID()}@t.local` },
      companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time' as const, hiredOn: today,
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }] };
    const hire = () => path === 'direct' ? hireEmployee(ctx, input) : withTenant(ctx, tx => hireEmployee(ctx, input, tx));
    const state = async () => ({
      persons: await owner.db.select().from(schema.person).where(eq(schema.person.tenantId, b.tenantId)).orderBy(schema.person.id),
      employments: await owner.db.select().from(schema.employment).where(eq(schema.employment.tenantId, b.tenantId)).orderBy(schema.employment.id),
      assignments: await owner.db.select().from(schema.assignment).where(eq(schema.assignment.tenantId, b.tenantId)).orderBy(schema.assignment.id),
      reporting: await owner.db.select().from(schema.reportingLine).where(eq(schema.reportingLine.tenantId, b.tenantId)).orderBy(schema.reportingLine.id),
      ledger: await owner.db.select().from(schema.leaveLedger).where(eq(schema.leaveLedger.tenantId, b.tenantId)).orderBy(schema.leaveLedger.id),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state();
    let ready!: () => void, fail!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; fail = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { fail(new Error('owned hire handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => { await lockLeaveDependenciesTx(tx, b.tenantId, [existing.employmentId]); ready(); await finish; });
    void holder.catch(fail);
    try {
      await started; await expect(hire()).rejects.toThrow('Leave source is unavailable');
      expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    const created = await hire(), after = await state();
    expect(after.persons).toHaveLength(before.persons.length + 1);
    expect(after.employments).toHaveLength(before.employments.length + 1);
    expect(after.assignments.filter(row => row.employmentId === created.employmentId)).toHaveLength(1);
    const grants = after.ledger.filter(row => row.employmentId === created.employmentId && row.leaveTypeId === b.annualLeaveTypeId);
    expect(grants).toHaveLength(1); expect(Number(grants[0].days)).toBeGreaterThan(0);
  });
});
