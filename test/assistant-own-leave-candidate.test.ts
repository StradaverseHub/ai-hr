import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, domainEvent, employment, leaveLedger, leaveRequest, leaveType, roleAssignment } from '../db/schema';
import { readOwnLeaveCandidateTx } from '../core/assistant-actions/own-leave-candidate';
import { readOwnLeaveActorTx } from '../core/assistant-actions/own-leave-actor';
import { grantAssistant, revokeAssistant } from '../core/assistant-grant';
import { hireEmployee } from '../core/org';
import { previewLeaveDeduction, requestLeave } from '../packs/leave/service';
import { setAttendancePolicy } from '../packs/attendance/service';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner,
  resetDb, seedBase, setModule, type Base } from './harness';

describe('own-leave read-only candidate', () => {
  let base: Base;
  let ctx: SessionContext;
  let employmentId: string;
  let date: string;
  let nomination: Record<string, unknown>;
  let selection: { employmentId: string; leaveTypeId: string };
  const text = { reason: 'Fictional human reason', employeeRemark: 'Fictional human remark' };
  beforeAll(async () => { await migrateTestDb(); });
  afterAll(async () => { await closeAll(); });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'assistant', 'active');
    const person = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Fictional Own Leave Applicant', primaryEmail: 'candidate-own@acme.test' },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time',
      hiredOn: todayInKualaLumpur(),
    });
    employmentId = person.employmentId;
    const userId = await createAppUser(base.tenantId, person.personId, 'employee');
    await grantAssistant(adminCtx(base), { appUserId: userId });
    ctx = { ...await entitledCtx(base, ['employee']), userId, personId: person.personId,
      grants: [{ role: 'employee', companyId: null }] };
    await owner.db.insert(leaveLedger).values({ tenantId: base.tenantId, employmentId,
      leaveTypeId: base.annualLeaveTypeId, entryType: 'accrual', days: '10.00', effectiveOn: todayInKualaLumpur() });
    date = todayInKualaLumpur(new Date(Date.now() + 3 * 86_400_000));
    nomination = { action: 'leave.apply', contractVersion: 1, employmentId,
      leaveTypeId: base.annualLeaveTypeId, date, durationType: 'full_day' };
    selection = { employmentId, leaveTypeId: base.annualLeaveTypeId };
  });

  const read = (intent: unknown = nomination, selected: unknown = selection, humanText: unknown = text) =>
    withTenant(ctx, tx => readOwnLeaveCandidateTx(tx, ctx, intent, selected, humanText, 'en'));
  const sourceCounts = async () => Promise.all([
    owner.db.select({ count: count() }).from(leaveRequest).where(eq(leaveRequest.tenantId, base.tenantId)),
    owner.db.select({ count: count() }).from(domainEvent).where(eq(domainEvent.tenantId, base.tenantId)),
  ]);

  it('returns canonical estimates and human text without creating an action or submission', async () => {
    const before = await sourceCounts();
    const outcome = await read();
    expect(outcome.kind).toBe('candidate');
    if (outcome.kind !== 'candidate') throw new Error('Expected candidate');
    expect(outcome.candidate).toMatchObject({ binding: { userId: ctx.userId, personId: ctx.personId,
      employmentId, companyId: base.companyId }, humanText: text, deductionDays: 1,
      availableBalance: 10, estimatedAvailableAfter: 9, approvalRouting: 'unknown', holidayWarnings: [] });
    expect(outcome.candidate.intentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.candidate).not.toHaveProperty('actionId');
    expect(outcome.candidate).not.toHaveProperty('leaveRequestId');
    expect(await sourceCounts()).toEqual(before);
  });

  it('requires explicit human selection matching the model nomination', async () => {
    expect(await withTenant(ctx, tx => readOwnLeaveCandidateTx(tx, ctx, nomination, undefined, text)))
      .toEqual({ kind: 'needs_selection' });
    expect(await read(nomination, { ...selection, leaveTypeId: base.companyId })).toEqual({ kind: 'needs_selection' });
  });

  it('captures the separate human inputs and nomination before its first database await', async () => {
    const input = { ...nomination };
    const selected = { ...selection };
    const supplied = { reason: 'Fictional original human reason', employeeRemark: 'Fictional original remark' };
    const before = await sourceCounts();
    const outcome = await withTenant(ctx, async tx => {
      const pending = readOwnLeaveCandidateTx(tx, ctx, input, selected, supplied);
      input.date = '1900-01-01';
      input.leaveTypeId = base.companyId;
      selected.leaveTypeId = base.companyId;
      supplied.reason = 'Fictional changed reason';
      supplied.employeeRemark = 'Fictional changed remark';
      return pending;
    });
    expect(outcome.kind).toBe('candidate');
    if (outcome.kind === 'candidate') expect(outcome.candidate).toMatchObject({
      nomination: { date, leaveTypeId: base.annualLeaveTypeId },
      humanText: { reason: 'Fictional original human reason', employeeRemark: 'Fictional original remark' },
    });
    expect(await sourceCounts()).toEqual(before);
  });

  it.each([{ durationType: 'hourly' }, { reason: 'Model-invented reason' }, { execute: true }])(
    'hands unsupported or forged model input to the existing form: %j', extra => {
      return expect(read({ ...nomination, ...extra })).resolves.toEqual({ kind: 'use_leave_form' });
    },
  );

  it('refuses a revoked Assistant grant without returning source details', async () => {
    await revokeAssistant(adminCtx(base), { appUserId: ctx.userId! });
    expect(await read()).toEqual({ kind: 'unavailable' });
  });

  it('refreshes Assistant module authority instead of accepting the old session snapshot', async () => {
    expect((await read()).kind).toBe('candidate');
    await setModule(base.tenantId, 'assistant', 'disabled');
    const before = await sourceCounts();
    expect(await read()).toEqual({ kind: 'unavailable' });
    expect(await read({ execute: true }, null, { reason: 'x'.repeat(2001) }))
      .toEqual({ kind: 'unavailable' });
    expect(await sourceCounts()).toEqual(before);
  });

  it('refuses a relinked login while the supplied context still names the old person', async () => {
    expect((await read()).kind).toBe('candidate');
    await owner.db.update(appUser).set({ personId: null }).where(eq(appUser.id, ctx.userId!));
    const before = await sourceCounts();
    expect(await read()).toEqual({ kind: 'unavailable' });
    expect(await sourceCounts()).toEqual(before);
  });

  it('refuses stale claimed roles after the real role is removed', async () => {
    expect((await read()).kind).toBe('candidate');
    await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId, ctx.userId!));
    const before = await sourceCounts();
    expect(await read()).toEqual({ kind: 'unavailable' });
    expect(await sourceCounts()).toEqual(before);
  });

  it('refuses a transaction scoped to a different login, including an administrator', async () => {
    const before = await sourceCounts();
    expect(await withTenant(adminCtx(base), tx =>
      readOwnLeaveCandidateTx(tx, ctx, nomination, selection, text))).toEqual({ kind: 'unavailable' });
    expect(await sourceCounts()).toEqual(before);
  });

  it('does not attach broader in-memory role claims to the same login transaction', async () => {
    const forged: SessionContext = { ...ctx, roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: null }] };
    const before = await sourceCounts();
    expect(await withTenant(ctx, tx =>
      readOwnLeaveCandidateTx(tx, forged, nomination, selection, text))).toEqual({ kind: 'unavailable' });
    expect(await sourceCounts()).toEqual(before);
  });

  it('does not label an older report snapshot as fresh confirmation authority', async () => {
    expect(await withTenant(ctx, tx =>
      readOwnLeaveCandidateTx(tx, ctx, nomination, selection, text), { readOnlySnapshot: true }))
      .toEqual({ kind: 'unavailable' });
  });

  it('binds actor reads before yielding to the database, including nested role carriers', async () => {
    await withTenant(ctx, async tx => {
      const input: SessionContext = { ...ctx, roles: ctx.roles?.slice(),
        grants: ctx.grants?.map(grant => ({ ...grant })) };
      // Calling the async reader captures the identity before its first await. Mutate immediately
      // while its real access-lock query is pending; no timers, fake SQL answers or separate commit.
      const pending = readOwnLeaveActorTx(tx, input);
      input.userId = base.adminUserId;
      input.personId = null;
      input.roles!.push('hr_admin');
      input.grants![0].role = 'hr_admin';
      const actor = await pending;
      expect(actor).toMatchObject({ userId: ctx.userId, personId: ctx.personId,
        roles: ['employee'], grants: [{ role: 'employee', companyId: null }] });
      expect(actor?.grants).not.toBe(input.grants);
    });
  });

  it('refuses another person even when the caller is an HR admin who can read that employment', async () => {
    const other = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Fictional Other Applicant', primaryEmail: 'candidate-other@acme.test' },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: todayInKualaLumpur(),
    });
    const adminUserId = await createAppUser(base.tenantId, ctx.personId!, 'hr_admin');
    await grantAssistant(adminCtx(base), { appUserId: adminUserId });
    const admin: SessionContext = { ...await entitledCtx(base), userId: adminUserId, personId: ctx.personId,
      grants: [{ role: 'hr_admin', companyId: null }] };
    await withTenant(admin, async tx => {
      // Prove this exercises the own-subject guard, rather than a coincidental empty RLS read.
      expect(await tx.select({ id: employment.id }).from(employment).where(eq(employment.id, other.employmentId)))
        .toHaveLength(1);
      expect(await readOwnLeaveCandidateTx(tx, admin, { ...nomination, employmentId: other.employmentId },
        { ...selection, employmentId: other.employmentId }, text)).toEqual({ kind: 'unavailable' });
    });
  });

  it('uses pending-aware availability while preserving the legacy raw-ledger preview', async () => {
    const otherDate = todayInKualaLumpur(new Date(Date.now() + 4 * 86_400_000));
    await requestLeave(ctx, { employmentId, leaveTypeId: base.annualLeaveTypeId,
      startDate: otherDate, endDate: otherDate, today: todayInKualaLumpur() });
    const args = { employmentId, leaveTypeId: base.annualLeaveTypeId, startDate: date, endDate: date };
    const legacy = await previewLeaveDeduction(ctx, args);
    expect(legacy.balanceAvailable).toBe(10);
    expect(legacy).not.toHaveProperty('availableBalance');
    const outcome = await read();
    expect(outcome.kind).toBe('candidate');
    if (outcome.kind === 'candidate') expect(outcome.candidate)
      .toMatchObject({ availableBalance: 9, estimatedAvailableAfter: 8 });
  });

  it('keeps the engine weight when a full-day request deducts half a day', async () => {
    const saturday = Array.from({ length: 7 }, (_, index) =>
      todayInKualaLumpur(new Date(Date.now() + (index + 1) * 86_400_000)))
      .find(day => new Date(`${day}T00:00:00.000Z`).getUTCDay() === 6);
    expect(saturday).toBeDefined();
    await setAttendancePolicy(adminCtx(base), { companyId: base.companyId,
      workStart: '09:00', workEnd: '18:00', breakMinutes: 60, lateAfter: '09:15', halfDayBefore: '13:00',
      workingDays: [1, 2, 3, 4, 5], halfWorkingDays: [6] });
    await owner.db.update(leaveType).set({ counting: 'working_days' }).where(eq(leaveType.id, base.annualLeaveTypeId));
    const outcome = await read({ ...nomination, date: saturday });
    expect(outcome.kind).toBe('candidate');
    if (outcome.kind === 'candidate') expect(outcome.candidate)
      .toMatchObject({ deductionDays: 0.5, availableBalance: 10, estimatedAvailableAfter: 9.5 });
  });

  it('carries the canonical warning into review without appending the submission warning event', async () => {
    await setAttendancePolicy(adminCtx(base), { companyId: base.companyId,
      workStart: '09:00', workEnd: '18:00', breakMinutes: 60, lateAfter: '09:15', halfDayBefore: '13:00',
      workingDays: [1, 2, 3, 4, 5, 6, 7] });
    await owner.db.update(leaveType).set({ counting: 'working_days' }).where(eq(leaveType.id, base.annualLeaveTypeId));
    const before = await sourceCounts();
    const preview = await previewLeaveDeduction(ctx, { employmentId, leaveTypeId: base.annualLeaveTypeId,
      startDate: date, endDate: date, includeHolidayWarnings: true });
    expect(preview.holidayWarnings).toHaveLength(1);
    const outcome = await read();
    expect(outcome.kind).toBe('candidate');
    if (outcome.kind === 'candidate') expect(outcome.candidate.holidayWarnings).toEqual(preview.holidayWarnings);
    expect(await sourceCounts()).toEqual(before);
  });

  it('omits both availability estimates when the ESS owner hides them', async () => {
    await owner.db.update(leaveType).set({ essViewConfig: { available: false } })
      .where(eq(leaveType.id, base.annualLeaveTypeId));
    const outcome = await read();
    expect(outcome.kind).toBe('candidate');
    if (outcome.kind === 'candidate') expect(outcome.candidate)
      .toMatchObject({ availableBalance: null, estimatedAvailableAfter: null });
  });

  it('requests required human remarks rather than inventing them', async () => {
    await owner.db.update(leaveType).set({ employeeRemarkRequired: true })
      .where(eq(leaveType.id, base.annualLeaveTypeId));
    expect(await read(nomination, selection, {})).toEqual({ kind: 'needs_employee_remark' });
    expect(await read(nomination, selection, { employeeRemark: '   ' })).toEqual({ kind: 'needs_employee_remark' });
    const supplied = { employeeRemark: 'My exact human text\nkept inside' };
    const outcome = await read(nomination, selection, supplied);
    expect(outcome.kind).toBe('candidate');
    if (outcome.kind === 'candidate') expect(outcome.candidate.humanText).toEqual(supplied);
  });

  it.each(['  My exact human text', 'My exact human text\n', '', '   '])(
    'uses the form when canonical remark normalization would change the reviewed text: %j', async employeeRemark => {
      const before = await sourceCounts();
      expect(await read(nomination, selection, { reason: 'Exact human reason', employeeRemark }))
        .toEqual({ kind: 'use_leave_form' });
      expect(await sourceCounts()).toEqual(before);
    },
  );

  it.each([{ requiresDocument: true }, { role: 'sick' as const }, { country: 'SG' }, { paid: false }])(
    'hands cases outside ordinary own Annual Leave to the full form: %j', async change => {
      await owner.db.update(leaveType).set(change).where(eq(leaveType.id, base.annualLeaveTypeId));
      expect(await read()).toEqual({ kind: 'use_leave_form' });
    },
  );

  it('refuses a target date beyond the own employment lifecycle', async () => {
    await owner.db.update(employment).set({ terminatedOn: todayInKualaLumpur() })
      .where(eq(employment.id, employmentId));
    expect(await read()).toEqual({ kind: 'unavailable' });
  });

  it('hands an uncovered deduction to the full form even if the type permits negative balances', async () => {
    await owner.db.insert(leaveLedger).values({ tenantId: base.tenantId, employmentId,
      leaveTypeId: base.annualLeaveTypeId, entryType: 'adjustment', days: '-10.00', effectiveOn: todayInKualaLumpur() });
    expect(await read()).toEqual({ kind: 'use_leave_form' });
  });
});
