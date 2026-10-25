import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { domainEvent, employment, holiday, leaveApprovalStep, leaveLedger, leaveRequest, leaveType } from '../db/schema';
import { hireEmployee } from '../core/org';
import { LeaveReviewedEffectError, previewLeaveDeduction, requestLeave, type ReviewedOwnLeaveEffect } from '../packs/leave/service';
import { setAttendancePolicy } from '../packs/attendance/service';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { applyLeaveAdjustmentBatch } from '../core/leave-adjustment';
import { readOwnLeaveSubmissionReferenceTx } from '../core/read';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('reviewed own-leave precondition at the canonical write', () => {
  let base: Base;
  let ctx: SessionContext;
  let args: { employmentId: string; leaveTypeId: string; startDate: string; endDate: string; durationType: 'full_day' };
  let reviewed: ReviewedOwnLeaveEffect;
  beforeAll(async () => { await migrateTestDb(); });
  afterAll(async () => { await closeAll(); });
  beforeEach(async () => {
    await resetDb(); base = await seedBase();
    const date = todayInKualaLumpur();
    const employee = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Fictional Reviewed Applicant', primaryEmail: 'reviewed-own@acme.test' },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: date,
    });
    const userId = await createAppUser(base.tenantId, employee.personId, 'hr_admin');
    ctx = { ...adminCtx(base), userId, personId: employee.personId, grants: [{ role: 'hr_admin', companyId: null }] };
    await owner.db.insert(leaveLedger).values({ tenantId: base.tenantId, employmentId: employee.employmentId,
      leaveTypeId: base.annualLeaveTypeId, entryType: 'accrual', days: '10.00', effectiveOn: date });
    args = { employmentId: employee.employmentId, leaveTypeId: base.annualLeaveTypeId,
      startDate: date, endDate: date, durationType: 'full_day' };
    reviewed = { employmentId: employee.employmentId, companyId: base.companyId,
      leaveTypeId: base.annualLeaveTypeId, date, days: 1, availableBalance: 10, holidayWarnings: [] };
  });
  const counts = (tx: Tx) => Promise.all([
    tx.select({ count: count() }).from(leaveRequest).where(eq(leaveRequest.tenantId, base.tenantId)),
    tx.select({ count: count() }).from(domainEvent).where(eq(domainEvent.tenantId, base.tenantId)),
  ]);

  it('records one canonical pending request, without claiming an approval or action receipt', async () => {
    await withTenant(ctx, async tx => {
      const result = await requestLeave(ctx, args, tx, reviewed);
      expect(result.days).toBe(1); expect(result.parentGroupId).toBeNull();
      expect(result.children).toHaveLength(1);
      expect(result.submittedEventId).toEqual(expect.any(String));
      expect(await tx.select({ aggregate: domainEvent.aggregateId, type: domainEvent.eventType,
        subject: domainEvent.subjectEmploymentId, actor: domainEvent.actorId })
        .from(domainEvent).where(eq(domainEvent.id, result.submittedEventId!)).orderBy(domainEvent.id))
        .toEqual([{ aggregate: result.leaveRequestId, type: 'leave-request.submitted',
          subject: args.employmentId, actor: ctx.userId }]);
      expect(await tx.select({ status: leaveRequest.status }).from(leaveRequest).where(eq(leaveRequest.id, result.leaveRequestId)))
        .toEqual([{ status: 'pending' }]);
    });
  });

  it('returns the submitted event rather than a later holiday-warning companion', async () => {
    await setAttendancePolicy(adminCtx(base), { companyId: base.companyId,
      workStart: '09:00', workEnd: '18:00', breakMinutes: 60, lateAfter: '09:15', halfDayBefore: '13:00',
      workingDays: [1, 2, 3, 4, 5, 6, 7] });
    await owner.db.update(leaveType).set({ counting: 'working_days' }).where(eq(leaveType.id, base.annualLeaveTypeId));
    // A second real login exercises the own-subject event SELECT policy, without an admin grant.
    const userId = await createAppUser(base.tenantId, ctx.personId!, 'employee');
    const employeeCtx: SessionContext = { ...ctx, userId, roles: ['employee'],
      grants: [{ role: 'employee', companyId: null }] };
    await withTenant(employeeCtx, async tx => {
      const preview = await previewLeaveDeduction(employeeCtx,
        { ...args, includeAvailableBalance: true, includeHolidayWarnings: true }, tx);
      expect(preview.holidayWarnings).toHaveLength(1);
      const result = await requestLeave(employeeCtx, args, tx, { ...reviewed,
        days: preview.days, availableBalance: preview.availableBalance!, holidayWarnings: preview.holidayWarnings! });
      expect(result.holidayWarnings).toHaveLength(1);
      const events = await tx.select({ id: domainEvent.id, type: domainEvent.eventType })
        .from(domainEvent).where(eq(domainEvent.aggregateId, result.leaveRequestId)).orderBy(domainEvent.sequence);
      expect(events.filter(event => event.type === 'leave-request.submitted'))
        .toEqual([{ id: result.submittedEventId, type: 'leave-request.submitted' }]);
      expect(events.filter(event => event.type === 'holiday.completeness.warned')).toHaveLength(1);
      const submittedIndex = events.findIndex(event => event.type === 'leave-request.submitted');
      expect(submittedIndex).toBeGreaterThanOrEqual(0);
      expect(events.findIndex(event => event.type === 'holiday.completeness.warned')).toBeGreaterThan(submittedIndex);
      expect(events.filter(event => event.id === result.submittedEventId)).toHaveLength(1);
    });
  });

  it('reads only the canonical own submission references for the original human actor', async () => {
    const userId = await createAppUser(base.tenantId, ctx.personId!, 'employee');
    const employeeCtx: SessionContext = { ...ctx, userId, roles: ['employee'],
      grants: [{ role: 'employee', companyId: null }] };
    const result = await withTenant(employeeCtx, tx => requestLeave(employeeCtx,
      { ...args, reason: 'Private reference-reader sentinel' }, tx, reviewed));
    const evidence = await withTenant(employeeCtx, tx => readOwnLeaveSubmissionReferenceTx(
      tx, employeeCtx, result.leaveRequestId, result.submittedEventId!));
    expect(evidence).toEqual({
      request: { id: result.leaveRequestId, tenantId: base.tenantId, employmentId: args.employmentId,
        personId: ctx.personId, companyId: base.companyId },
      event: { id: result.submittedEventId, tenantId: base.tenantId, aggregateType: 'leave-request',
        aggregateId: result.leaveRequestId, eventType: 'leave-request.submitted', actorType: 'user',
        actorId: employeeCtx.userId, subjectEmploymentId: args.employmentId },
    });
    expect(JSON.stringify(evidence)).not.toContain('Private reference-reader sentinel');
    // A different real login for the SAME person has no receipt from this original actor. Even its
    // HR role and own-person row visibility must not substitute for that submitted-event binding.
    expect(await withTenant(ctx, tx => readOwnLeaveSubmissionReferenceTx(
      tx, ctx, result.leaveRequestId, result.submittedEventId!))).toBeNull();
    expect(await withTenant(employeeCtx, tx => readOwnLeaveSubmissionReferenceTx(
      tx, employeeCtx, result.leaveRequestId, result.leaveRequestId))).toBeNull();
  });

  it('keeps the request and returned event inside the enclosing rollback boundary', async () => {
    let requestId = '', submittedEventId = '';
    const rollback = new Error('fictional enclosing command refused');
    await expect(withTenant(ctx, async tx => {
      const result = await requestLeave(ctx, args, tx, reviewed);
      requestId = result.leaveRequestId;
      submittedEventId = result.submittedEventId!;
      expect(submittedEventId).toEqual(expect.any(String));
      expect(await tx.select({ id: domainEvent.id }).from(domainEvent)
        .where(eq(domainEvent.id, submittedEventId)).orderBy(domainEvent.id))
        .toEqual([{ id: submittedEventId }]);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(requestId).not.toBe(''); expect(submittedEventId).not.toBe('');
    expect(await owner.db.select({ id: leaveRequest.id }).from(leaveRequest)
      .where(eq(leaveRequest.id, requestId)).orderBy(leaveRequest.id)).toEqual([]);
    expect(await owner.db.select({ id: domainEvent.id }).from(domainEvent)
      .where(eq(domainEvent.id, submittedEventId)).orderBy(domainEvent.id)).toEqual([]);
  });

  it('retains the ordinary request result without a submitted-event reference', async () => {
    const result = await requestLeave(ctx, { ...args, reason: '  Exact reason\n', employeeRemark: '  Ordinary remark\n' });
    expect(result).not.toHaveProperty('submittedEventId');
    expect(result.children).toHaveLength(1);
    expect(await owner.db.select({ reason: leaveRequest.reason, remark: leaveRequest.employeeRemark })
      .from(leaveRequest).where(eq(leaveRequest.id, result.leaveRequestId)).orderBy(leaveRequest.id))
      .toEqual([{ reason: '  Exact reason\n', remark: 'Ordinary remark' }]);
  });

  it('rolls back generated approval steps and late holiday-warning events with the enclosing command', async () => {
    await setLeaveApprovalPolicy(adminCtx(base), { companyId: base.companyId, levels: ['hr_admin', 'payroll'] });
    await setAttendancePolicy(adminCtx(base), { companyId: base.companyId,
      workStart: '09:00', workEnd: '18:00', breakMinutes: 60, lateAfter: '09:15', halfDayBefore: '13:00',
      workingDays: [1, 2, 3, 4, 5, 6, 7] });
    await owner.db.update(leaveType).set({ counting: 'working_days' }).where(eq(leaveType.id, base.annualLeaveTypeId));
    let requestId = '';
    const rollback = new Error('fictional final receipt could not be recorded');
    await expect(withTenant(ctx, async tx => {
      const preview = await previewLeaveDeduction(ctx,
        { ...args, includeAvailableBalance: true, includeHolidayWarnings: true }, tx);
      expect(preview.holidayWarnings).toHaveLength(1);
      const result = await requestLeave(ctx, args, tx, { ...reviewed, days: preview.days,
        availableBalance: preview.availableBalance!, holidayWarnings: preview.holidayWarnings! });
      requestId = result.leaveRequestId;
      // Assert the real late effects exist before throwing. An empty fixture or early service
      // refusal cannot accidentally supply rollback evidence for work it never performed.
      expect(await tx.select({ id: leaveApprovalStep.id }).from(leaveApprovalStep)
        .where(eq(leaveApprovalStep.leaveRequestId, requestId))).toHaveLength(2);
      const events = await tx.select({ id: domainEvent.id, type: domainEvent.eventType }).from(domainEvent)
        .where(eq(domainEvent.aggregateId, requestId)).orderBy(domainEvent.sequence);
      expect(events.filter(event => event.type === 'leave-request.submitted'))
        .toEqual([{ id: result.submittedEventId, type: 'leave-request.submitted' }]);
      expect(events.filter(event => event.type === 'holiday.completeness.warned')).toHaveLength(1);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(requestId).not.toBe('');
    expect(await owner.db.select({ id: leaveRequest.id }).from(leaveRequest)
      .where(eq(leaveRequest.id, requestId))).toEqual([]);
    expect(await owner.db.select({ id: leaveApprovalStep.id }).from(leaveApprovalStep)
      .where(eq(leaveApprovalStep.leaveRequestId, requestId))).toEqual([]);
    expect(await owner.db.select({ id: domainEvent.id }).from(domainEvent)
      .where(eq(domainEvent.aggregateId, requestId))).toEqual([]);
  });

  it('records unchanged human text when canonical remark normalization is already satisfied', async () => {
    const text = { reason: '  Exact human reason\n', employeeRemark: 'Exact human\nremark' };
    await withTenant(ctx, async tx => {
      const result = await requestLeave(ctx, { ...args, ...text }, tx, reviewed);
      expect(await tx.select({ reason: leaveRequest.reason, employeeRemark: leaveRequest.employeeRemark })
        .from(leaveRequest).where(eq(leaveRequest.id, result.leaveRequestId)).orderBy(leaveRequest.id))
        .toEqual([text]);
    });
  });

  it.each(['  My exact human text', 'My exact human text\n', '', '   '])(
    'refuses canonical normalization of reviewed remarks before any write: %j', async employeeRemark => {
      await withTenant(ctx, async tx => {
        const before = await counts(tx);
        await expect(requestLeave(ctx, { ...args, employeeRemark }, tx, reviewed))
          .rejects.toMatchObject({ name: 'LeaveReviewedEffectError', reason: 'unsupported' });
        expect(await counts(tx)).toEqual(before);
      });
    },
  );

  it.each([{ days: 0.5 }, { availableBalance: 9 }, { companyId: '00000000-0000-4000-8000-000000000099' }])(
    'refuses a changed effect before any write in the still-open transaction: %j', async change => {
      await withTenant(ctx, async tx => {
        const before = await counts(tx);
        await expect(requestLeave(ctx, args, tx, { ...reviewed, ...change }))
          .rejects.toMatchObject({ name: 'LeaveReviewedEffectError', reason: 'changed' });
        // Catch inside the same transaction: rollback alone could conceal a too-late guard.
        expect(await counts(tx)).toEqual(before);
      });
    },
  );

  it('requires an enclosing command transaction', async () => {
    await expect(requestLeave(ctx, args, undefined, reviewed)).rejects.toThrow(LeaveReviewedEffectError);
  });

  it('refuses a stale review after a canonical HR negative adjustment changes its available balance', async () => {
    const atReview = await previewLeaveDeduction(ctx, { ...args, includeAvailableBalance: true });
    expect(atReview.days).toBe(1); expect(atReview.availableBalance).toBe(10);
    const adjustment = await applyLeaveAdjustmentBatch(adminCtx(base), {
      leaveTypeIds: [base.annualLeaveTypeId], days: -1, effectiveOn: reviewed.date,
      reason: 'Fictional source correction after review', targetMode: 'individual',
      employmentIds: [args.employmentId],
    });
    expect(adjustment).toMatchObject({ targeted: 1, written: 1, skipped: 0 });
    expect(await owner.db.select({ type: domainEvent.eventType }).from(domainEvent)
      .where(eq(domainEvent.aggregateId, adjustment.batchId))).toEqual([{ type: 'leave.adjustment.applied' }]);
    await withTenant(ctx, async tx => {
      const fresh = await previewLeaveDeduction(ctx, { ...args, includeAvailableBalance: true }, tx);
      expect(fresh.days).toBe(atReview.days);
      expect(fresh.balanceAvailable).toBe(9); expect(fresh.availableBalance).toBe(9);
      const before = await counts(tx);
      await expect(requestLeave(ctx, args, tx, { ...reviewed,
        days: atReview.days, availableBalance: atReview.availableBalance! }))
        .rejects.toMatchObject({ name: 'LeaveReviewedEffectError', reason: 'changed' });
      // Refusal must precede any new request or event in this still-open transaction.
      expect(await counts(tx)).toEqual(before);
    });
  });

  it('refuses a stale review after an ordinary borrower request reserves the Annual source balance', async () => {
    const [borrower] = await owner.db.insert(leaveType).values({ tenantId: base.tenantId,
      code: 'REVIEW_BORROW', name: 'Fictional Borrowed Leave', paid: true, counting: 'calendar_days',
      balanceSourceTypeId: base.annualLeaveTypeId }).returning({ id: leaveType.id });
    const atReview = await previewLeaveDeduction(ctx, { ...args, includeAvailableBalance: true });
    expect(atReview.days).toBe(1); expect(atReview.availableBalance).toBe(10);
    // The full form's canonical path writes a pending borrower, not a fake ledger adjustment.
    const reservation = await requestLeave(ctx, { ...args, leaveTypeId: borrower.id });
    expect(await owner.db.select({ status: leaveRequest.status }).from(leaveRequest)
      .where(eq(leaveRequest.id, reservation.leaveRequestId)).orderBy(leaveRequest.id))
      .toEqual([{ status: 'pending' }]);
    await withTenant(ctx, async tx => {
      const fresh = await previewLeaveDeduction(ctx, { ...args, includeAvailableBalance: true }, tx);
      expect(fresh.days).toBe(atReview.days);
      expect(fresh.balanceAvailable).toBe(atReview.balanceAvailable);
      expect(fresh.balanceAvailable).toBe(10);
      expect(fresh.availableBalance).toBe(9);
      const before = await counts(tx);
      await expect(requestLeave(ctx, args, tx, { ...reviewed,
        days: atReview.days, availableBalance: atReview.availableBalance! }))
        .rejects.toMatchObject({ name: 'LeaveReviewedEffectError', reason: 'changed' });
      expect(await counts(tx)).toEqual(before);
    });
  });

  it('refuses a stale deduction after the attendance owner changes Full working dates to Half', async () => {
    const policy = { companyId: base.companyId, workStart: '09:00', workEnd: '18:00',
      breakMinutes: 60, lateAfter: '09:15', halfDayBefore: '13:00' };
    const weekdays = [1, 2, 3, 4, 5, 6, 7];
    await setAttendancePolicy(adminCtx(base), { ...policy, workingDays: weekdays });
    await owner.db.update(leaveType).set({ counting: 'working_days' }).where(eq(leaveType.id, base.annualLeaveTypeId));
    const atReview = await previewLeaveDeduction(ctx,
      { ...args, includeAvailableBalance: true, includeHolidayWarnings: true });
    expect(atReview.days).toBe(1);
    expect(atReview.holidayWarnings).toHaveLength(1);
    // Both policy writes use the public Attendance owner. This is a sequential source change,
    // not proof that concurrent policy writers are fenced by the future confirm command.
    await setAttendancePolicy(adminCtx(base), { ...policy, workingDays: [], halfWorkingDays: weekdays });
    await withTenant(ctx, async tx => {
      const fresh = await previewLeaveDeduction(ctx,
        { ...args, includeAvailableBalance: true, includeHolidayWarnings: true }, tx);
      expect(fresh.days).toBe(0.5);
      expect(fresh.availableBalance).toBe(atReview.availableBalance);
      expect(fresh.holidayWarnings).toEqual(atReview.holidayWarnings);
      const before = await counts(tx);
      await expect(requestLeave(ctx, args, tx, { ...reviewed, days: atReview.days,
        availableBalance: atReview.availableBalance!, holidayWarnings: atReview.holidayWarnings! }))
        .rejects.toMatchObject({ name: 'LeaveReviewedEffectError', reason: 'changed' });
      expect(await counts(tx)).toEqual(before);
    });
  });

  it('binds guarded subject, tenant and event actor before the first database await', async () => {
    await withTenant(ctx, async tx => {
      const supplied: SessionContext = { ...ctx, roles: ctx.roles?.slice(),
        grants: ctx.grants?.map(grant => ({ ...grant })) };
      const pending = requestLeave(supplied, args, tx, reviewed);
      // The real subject query is pending. Mutate the retained input, including nested carriers;
      // the request must still use its original binding rather than changing subject or event actor.
      supplied.tenantId = '00000000-0000-4000-8000-000000000098';
      supplied.userId = '00000000-0000-4000-8000-000000000099';
      supplied.personId = null;
      supplied.roles?.splice(0, supplied.roles.length, 'employee');
      if (supplied.grants?.[0]) supplied.grants[0].role = 'employee';
      const result = await pending;
      expect(await tx.select({ tenantId: leaveRequest.tenantId, employmentId: leaveRequest.employmentId })
        .from(leaveRequest).where(eq(leaveRequest.id, result.leaveRequestId)).orderBy(leaveRequest.id))
        .toEqual([{ tenantId: ctx.tenantId, employmentId: args.employmentId }]);
      const events = await tx.select({ tenantId: domainEvent.tenantId, actorType: domainEvent.actorType,
        actorId: domainEvent.actorId, eventType: domainEvent.eventType, subject: domainEvent.subjectEmploymentId })
        .from(domainEvent).where(eq(domainEvent.aggregateId, result.leaveRequestId)).orderBy(domainEvent.id);
      expect(events.filter(event => event.eventType === 'leave-request.submitted'))
        .toEqual([{ tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId,
          eventType: 'leave-request.submitted', subject: args.employmentId }]);
    });
  });

  it('refuses a changed warning even when the actual deduction and pending-aware balance are unchanged', async () => {
    await setAttendancePolicy(adminCtx(base), { companyId: base.companyId,
      workStart: '09:00', workEnd: '18:00', breakMinutes: 60, lateAfter: '09:15', halfDayBefore: '13:00',
      workingDays: [1, 2, 3, 4, 5, 6, 7] });
    await owner.db.update(leaveType).set({ counting: 'working_days' }).where(eq(leaveType.id, base.annualLeaveTypeId));
    const beforeReview = await previewLeaveDeduction(ctx,
      { ...args, includeAvailableBalance: true, includeHolidayWarnings: true });
    expect(beforeReview.holidayWarnings).toHaveLength(1);
    // Add a gazette entry on another date: completeness changes without changing this day's weight.
    const year = reviewed.date.slice(0, 4);
    const holidayDate = `${year}-${reviewed.date.slice(5, 7) === '01' ? '07' : '01'}-01`;
    await owner.db.insert(holiday).values({ tenantId: base.tenantId, country: 'MY', state: null,
      holidayDate, name: 'Fictional reviewed-warning fixture' });
    await withTenant(ctx, async tx => {
      const fresh = await previewLeaveDeduction(ctx,
        { ...args, includeAvailableBalance: true, includeHolidayWarnings: true }, tx);
      expect(fresh.days).toBe(beforeReview.days);
      expect(fresh.availableBalance).toBe(beforeReview.availableBalance);
      expect(fresh.holidayWarnings).not.toEqual(beforeReview.holidayWarnings);
      const before = await counts(tx);
      await expect(requestLeave(ctx, args, tx, { ...reviewed,
        holidayWarnings: beforeReview.holidayWarnings! }))
        .rejects.toMatchObject({ name: 'LeaveReviewedEffectError', reason: 'changed' });
      expect(await counts(tx)).toEqual(before);
    });
  });

  it('refuses an HR own-request that would require an advance-notice bypass', async () => {
    await owner.db.update(leaveType).set({ minAdvanceDays: 30 }).where(eq(leaveType.id, base.annualLeaveTypeId));
    await withTenant(ctx, async tx => {
      const before = await counts(tx);
      await expect(requestLeave(ctx, args, tx, reviewed))
        .rejects.toMatchObject({ name: 'LeaveReviewedEffectError', reason: 'unsupported' });
      expect(await counts(tx)).toEqual(before);
    });
  });

  it('does not turn HR visibility/on-behalf authority into confirmed own-leave authority', async () => {
    const other = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Fictional Other Reviewed Applicant', primaryEmail: 'reviewed-other@acme.test' },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: reviewed.date,
    });
    await withTenant(ctx, async tx => {
      expect(await tx.select({ id: employment.id }).from(employment).where(eq(employment.id, other.employmentId)))
        .toHaveLength(1);
      const before = await counts(tx);
      await expect(requestLeave(ctx, { ...args, employmentId: other.employmentId }, tx,
        { ...reviewed, employmentId: other.employmentId })).rejects.toThrow(LeaveReviewedEffectError);
      expect(await counts(tx)).toEqual(before);
    });
  });

  it('refuses a target date beyond tenure while the final-day login still sees its own employment', async () => {
    await owner.db.update(employment).set({ terminatedOn: reviewed.date }).where(eq(employment.id, args.employmentId));
    const nextDate = todayInKualaLumpur(new Date(Date.now() + 86_400_000));
    await withTenant(ctx, async tx => {
      // Current source remains readable on the last working day. The target-date lifecycle check,
      // rather than an empty RLS read, must refuse the later absence.
      expect(await tx.select({ id: employment.id }).from(employment).where(eq(employment.id, args.employmentId)))
        .toHaveLength(1);
      const before = await counts(tx);
      await expect(requestLeave(ctx, { ...args, startDate: nextDate, endDate: nextDate }, tx,
        { ...reviewed, date: nextDate })).rejects.toMatchObject({ name: 'LeaveReviewedEffectError', reason: 'changed' });
      expect(await counts(tx)).toEqual(before);
    });
  });
});
