import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { hireEmployee, setReportingLine, editDelegation } from '../core/org';
import { checkIn, checkOut, requestAttendanceCorrection, decideAttendanceCorrection, addAttendanceCorrectionAttachment, getAttendanceCorrectionAttachment, listAttendanceCorrections } from '../core/attendance';
import { saveAttendanceWorkflow, setAttendanceWorkflowEnabled, reassignAttendanceWorkflowStageToHr, decideAttendanceWorkflowStageTx, previewAttendanceWorkflow, snapshotAttendanceWorkflowTx } from '../core/attendance-workflow';
import { attendanceApplicationDetail } from '../core/attendance-application-history';
import { createBatch, generatePayslips, closeBatch, unlockClosedBatch } from '../packs/payroll/service';
import { setCompensation } from '../core/comp';
import { attendanceClockData } from '../core/attendance-clock-data';
import { AttendancePayrollClosedError } from '../core/attendance-punch-change';
import { todayInKualaLumpur } from '../lib/hr-date';
import { CATEGORY_EMPLOYMENT_COLUMN, EMPLOYMENT_PROFILE_CATEGORIES } from '../core/profile-options';
import type { AttendanceWorkflowInput } from '../lib/attendance-workflow';
import { adminCtx, entitledCtx, setSetting, createAppUser, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// A recent Wednesday, derived from the KL business date rather than a hardcoded future fixture.
const previous = addDays(todayInKualaLumpur(), -7);
const date = addDays(previous, 3 - new Date(`${previous}T00:00:00Z`).getUTCDay());
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
async function hire(name: string, departmentId = b.deptB) {
  return hireEmployee(adminCtx(b), { person: { fullName: name, primaryEmail: `${randomUUID()}@hierarchy.test` }, companyId: b.companyId, departmentId, employmentType: 'full_time', hiredOn: '2020-01-01' });
}
async function login(personId: string, role: 'manager' | 'employee' | 'hr_admin' = 'manager'): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, personId, role);
  return { ...adminCtx(b), userId, personId, roles: [role], grants: [{ role, companyId: b.companyId }] };
}
async function fixture() {
  const a = adminCtx(b), d = await hire('D', b.deptA), first = await hire('A'), second = await hire('Arjun'), third = await hire('Daniel');
  for (const [subordinate, manager] of [[d, first], [first, second], [second, third]]) {
    await setReportingLine(a, { subordinateEmploymentId: subordinate.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: '2020-01-01' });
  }
  const actors = await Promise.all([first, second, third].map(e => login(e.personId))), self = await login(d.personId, 'employee');
  await checkIn(a, { employmentId: d.employmentId, date, time: '08:00', manual: true });
  await checkOut(a, { employmentId: d.employmentId, date, time: '17:00', manual: true });
  return { a, d, first, second, third, actors, self };
}
function input(overrides: Partial<AttendanceWorkflowInput> = {}): AttendanceWorkflowInput {
  return { companyId: b.companyId, code: 'HIERARCHY', name: 'Three accountable approvals', applicationType: 'irregularity', routingVersion: 2, priority: 100, criteria: { departmentIds: [b.deptA] }, active: true,
    stages: Array.from({ length: 3 }, (_, i) => ({ name: `Caller name ${i}`, level: { kind: 'direct_manager', employmentId: null, alternates: [] } })), ...overrides };
}
async function enable(a: SessionContext, value = input()) {
  const saved = await saveAttendanceWorkflow(a, value);
  await setAttendanceWorkflowEnabled(a, b.companyId, value.applicationType, true);
  return saved;
}
async function submit(actor: SessionContext, employmentId: string, ot = false, on = date) {
  return (await requestAttendanceCorrection(actor, { employmentId, date: on, ...(ot ? { requestedOtMinutes: 60, requestKind: 'self_overtime' as const } : { checkIn: '09:00', checkOut: '18:00' }), reason: 'Hierarchy verification' })).correctionId;
}
const readCorrection = async (id: string) => (await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id, id)))[0];
const readDay = async (employmentId: string, on = date) => (await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, on))))[0];
const readDecisions = async () => owner.db.select().from(schema.attendanceWorkflowDecision).orderBy(asc(schema.attendanceWorkflowDecision.stageIndex), asc(schema.attendanceWorkflowDecision.id));
async function approveFirstTwo(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  for (const i of [0, 1]) expect(await decideAttendanceCorrection(f.actors[i], { correctionId: id, decision: 'approved', expectedStageIndex: i })).toMatchObject({ status: 'pending' });
}
async function rawFinal(tx: Tx, actor: SessionContext, id: string, employmentId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actor.tenantId + ':' + employmentId},0))`);
  await tx.execute(sql`select id from attendance_correction where id=${id}::uuid for update`);
  await decideAttendanceWorkflowStageTx(tx, actor, { correctionId: id, employmentId, decision: 'approved', expectedStageIndex: 2 });
}
async function refused(tx: Tx, command: (attempt:Tx) => Promise<unknown>) {
  // Use the driver's nested scope as well as SQL SAVEPOINT: manual rollback alone leaves
  // postgres.js's outer uncaughtError latch set and falsely rejects a later normal commit.
  let failed=false;
  try {await tx.transaction(attempt=>command(attempt));}catch {failed=true;}
  expect(failed).toBe(true);
}

describe('797ba70b: explicit hierarchy routing and frozen accountable actors', () => {
  it.each([false, true])('routes D → A → Arjun → Daniel and applies only the final decision (Self OT=%s)', async ot => {
    const f = await fixture();
    await enable(f.a, input({ applicationType: ot ? 'self_overtime' : 'irregularity' }));
    const id = await submit(f.self, f.d.employmentId, ot), before = await readDay(f.d.employmentId);
    const detail = await attendanceApplicationDetail(f.a, [b.companyId], id);
    expect(detail?.workflow).toMatchObject({ routingVersion: 2, currentStage: 0 });
    expect(detail?.workflow?.stages.map(s => s.name)).toEqual(['Level 1', 'Level 2', 'Level 3']);
    expect(detail?.workflow?.stages.map(s => s.approvers[0])).toEqual([f.first, f.second, f.third].map((e, i) => expect.objectContaining({ employmentId: e.employmentId, personId: e.personId, userId: f.actors[i].userId, hierarchyDepth: i + 1 })));
    await expect(decideAttendanceCorrection(f.actors[2], { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow();
    await approveFirstTwo(f, id);
    expect(await readDay(f.d.employmentId)).toEqual(before);
    expect((await listAttendanceCorrections(f.actors[2], { status: 'pending' })).map(r => r.id)).toContain(id);
    expect(await decideAttendanceCorrection(f.actors[2], { correctionId: id, decision: 'approved', expectedStageIndex: 2 })).toMatchObject({ status: 'approved' });
    const trail = await readDecisions();
    expect(trail.map(d => d.actualUserId)).toEqual(f.actors.map(a => a.userId));
    expect(trail.map(d => d.actualPersonId)).toEqual([f.first, f.second, f.third].map(e => e.personId));
    expect(trail.map(d => d.actualEmploymentId)).toEqual([f.first, f.second, f.third].map(e => e.employmentId));
    expect(trail.every(d => d.actingMode === 'assigned')).toBe(true);
    expect((await readCorrection(id)).decidedByEmploymentId).toBe(f.third.employmentId);
    const after = await readDay(f.d.employmentId);
    expect(ot ? after.otMinutes : after.checkInAt).toBe(ot ? (await readCorrection(id)).approvedOtMinutes : '09:00:00');
    const effects = await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, id), eq(schema.domainEvent.eventType, 'attendance-correction.effect.recorded')));
    expect(effects).toHaveLength(1); expect(effects[0].actorId).toBe(f.actors[2].userId);
    await expect(decideAttendanceCorrection(f.actors[2], { correctionId: id, decision: 'approved', expectedStageIndex: 2 })).rejects.toThrow(/already approved/);
  });
  it('freezes configuration and superior identity, retaining request visibility after a reporting change without expanding Personnel', async () => {
    const f = await fixture(), template = await enable(f.a), id = await submit(f.self, f.d.employmentId);
    const supportingBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await addAttendanceCorrectionAttachment(f.self, { correctionId: id, fileName: 'frozen-superior-evidence.png', mimeType: 'image/png', content: supportingBytes });
    const replacement = await hire('Replacement manager'), replacementActor = await login(replacement.personId);
    await setReportingLine(f.a, { subordinateEmploymentId: f.d.employmentId, managerEmploymentId: replacement.employmentId, lineType: 'administrative', validFrom: '2020-01-01' });
    await saveAttendanceWorkflow(f.a, input({ name: 'New configuration', active: false, stages: [{ name: 'New', level: { kind: 'hr_admin', employmentId: null, alternates: [] } }] }), template.lineageId);
    await expect(decideAttendanceCorrection(replacementActor, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow();
    expect(await withTenant(f.actors[0], tx => tx.select().from(schema.employment).where(eq(schema.employment.id, f.d.employmentId)))).toHaveLength(0);
    const supportingFile = await getAttendanceCorrectionAttachment(f.actors[0], id);
    expect(supportingFile?.fileName).toBe('frozen-superior-evidence.png');
    expect(Buffer.from(supportingFile!.content).equals(supportingBytes)).toBe(true);
    await expect(addAttendanceCorrectionAttachment(f.actors[0], { correctionId: id, fileName: 'unassigned-write.png', mimeType: 'image/png', content: supportingBytes })).rejects.toThrow();
    expect((await listAttendanceCorrections(f.actors[0], { status: 'pending' })).find(r => r.id === id)?.hasAttachment).toBe(true);
    await decideAttendanceCorrection(f.actors[0], { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
    expect((await attendanceApplicationDetail(f.a, [b.companyId], id))?.workflow?.templateVersion).toBe(1);
    // Final calculation access is a separate live boundary; it requires scoped HR handoff after a move.
    await decideAttendanceCorrection(f.actors[1], { correctionId: id, decision: 'approved', expectedStageIndex: 1 });
    await expect(decideAttendanceCorrection(f.actors[2], { correctionId: id, decision: 'approved', expectedStageIndex: 2 })).rejects.toThrow(/calculation access.*scoped HR/);
    expect(await readDecisions()).toHaveLength(2);
    await reassignAttendanceWorkflowStageToHr(f.a, { correctionId: id, expectedStageIndex: 2, reason: 'Reporting change removed live calculation scope' });
    await decideAttendanceCorrection(f.a, { correctionId: id, decision: 'approved', expectedStageIndex: 2 });
    const final = await attendanceApplicationDetail(f.a, [b.companyId], id);
    expect(final?.workflow?.stages[2].approvers[0].employmentId).toBe(f.third.employmentId);
    expect(final?.workflow?.effectiveStages[2].approvers[0].kind).toBe('hr_admin');
    expect(final?.workflow?.reassignments[0]).toMatchObject({ actualUserId: f.a.userId, reason: 'Reporting change removed live calculation scope' });
    expect((await readDecisions())[2]).toMatchObject({ assignedKind: 'hr_admin', actualUserId: f.a.userId, actingMode: 'assigned' });
  });
  it('refuses missing/inactive/unlinked/cyclic/self and ambiguous-login paths, retaining only explicit HR alternatives', async () => {
    const f = await fixture();
    const assertUnresolved = () => expect(saveAttendanceWorkflow(f.a, input())).rejects.toMatchObject({ code: 'unresolved' });
    await owner.db.update(schema.employment).set({ terminatedOn: addDays(todayInKualaLumpur(), -1) }).where(eq(schema.employment.id, f.second.employmentId));
    await assertUnresolved();
    await owner.db.update(schema.employment).set({ terminatedOn: null }).where(eq(schema.employment.id, f.second.employmentId));
    await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, f.actors[1].userId!));
    await assertUnresolved();
    await owner.db.update(schema.appUser).set({ archivedAt: null }).where(eq(schema.appUser.id, f.actors[1].userId!));
    const extra = await createAppUser(b.tenantId, f.second.personId, 'manager'); await assertUnresolved();
    await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, extra));
    await owner.db.insert(schema.reportingLine).values({ tenantId: b.tenantId, subordinateEmploymentId: f.third.employmentId, managerEmploymentId: f.d.employmentId, lineType: 'administrative', validFrom: '2020-01-01' });
    await assertUnresolved();
    const fallback = input(); fallback.stages.forEach(s => { s.level.alternates = [{ kind: 'hr_admin', employmentId: null }]; });
    await enable(f.a, fallback);
    const id = await submit(f.self, f.d.employmentId);
    expect((await attendanceApplicationDetail(f.a, [b.companyId], id))?.workflow?.stages.every(s => s.approvers.length === 1 && s.approvers[0].kind === 'hr_admin')).toBe(true);
    await expect(decideAttendanceCorrection(f.self, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow();
    await decideAttendanceCorrection(f.a, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
    await expect(decideAttendanceCorrection(f.a, { correctionId: id, decision: 'approved', expectedStageIndex: 1 })).rejects.toThrow(/different authorized person/);
  });
  it('retains version-1 flat routing for existing configuration and submitted snapshots', async () => {
    const f = await fixture(), value = input({ routingVersion: 1 });
    value.stages = value.stages.slice(0, 2); value.stages[1].level.kind = 'hr_admin';
    const saved = await enable(f.a, value), id = await submit(f.self, f.d.employmentId);
    await saveAttendanceWorkflow(f.a, input(), saved.lineageId);
    const flow = (await attendanceApplicationDetail(f.a, [b.companyId], id))?.workflow;
    expect(flow?.routingVersion).toBe(1); expect(flow?.stages[0].name).toBe('Caller name 0');
    await decideAttendanceCorrection(f.actors[0], { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
    await decideAttendanceCorrection(f.a, { correctionId: id, decision: 'approved', expectedStageIndex: 1 });
    expect((await readCorrection(id)).status).toBe('approved');
  });
});

describe('797ba70b: untrusted request hints and current-transaction final-effect proof', () => {
  it('denies invented hints, another user, a different subject/date and unproved legacy requests', async () => {
    const f = await fixture(); await enable(f.a); const id = await submit(f.self, f.d.employmentId);
    for (const actor of [f.self, f.actors[2], f.a]) {
      await withTenant(actor, async tx => {
        for (const hint of [id, randomUUID(), 'not-a-uuid']) {
          await tx.execute(sql`select set_config('app.attendance_workflow_effect',${hint},true)`);
          const [proof] = await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.d.employmentId}::uuid,${date}::date) as ok`) as unknown as { ok: boolean }[];
          expect(proof.ok).toBe(false);
        }
      });
    }
    await approveFirstTwo(f, id);
    await checkIn(f.a, { employmentId: f.d.employmentId, date: addDays(date, -1), time: '08:00', manual: true });
    const otherDay = await readDay(f.d.employmentId, addDays(date, -1));
    await expect(withTenant(f.actors[2], async tx => {
      await rawFinal(tx, f.actors[2], id, f.d.employmentId);
      await tx.execute(sql`select app.attendance_workflow_begin_effect(${id}::uuid)`);
      const [proof] = await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.d.employmentId}::uuid,${date}::date) as own,app.attendance_workflow_effect_scope(${f.d.employmentId}::uuid,${addDays(date,-1)}::date) as other_date,app.attendance_workflow_effect_scope(${f.first.employmentId}::uuid,${date}::date) as other_person`) as unknown as { own: boolean; other_date: boolean; other_person: boolean }[];
      expect(proof).toEqual({ own: true, other_date: false, other_person: false });
      expect(await tx.update(schema.attendance).set({ remarks: 'forged other day' }).where(eq(schema.attendance.id, otherDay.id)).returning()).toEqual([]);
      await refused(tx, attempt => attempt.execute(sql`select app.attendance_workflow_begin_effect(${randomUUID()}::uuid)`));
      // It is not enough to reuse the valid hint under another authenticated identity.
      await tx.execute(sql`select set_config('app.user_id',${f.actors[0].userId!},true)`);
      const [switched] = await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.d.employmentId}::uuid,${date}::date) as ok`) as unknown as { ok: boolean }[];
      expect(switched.ok).toBe(false);
      throw new Error('Rollback diagnostic final decision');
    })).rejects.toThrow('Rollback diagnostic');
    expect(await readDecisions()).toHaveLength(2); expect(await readDay(f.d.employmentId, addDays(date,-1))).toEqual(otherDay);
  });
  it('denies a final decision committed in an earlier transaction and refuses replay', async () => {
    const f = await fixture(); await enable(f.a); const id = await submit(f.self, f.d.employmentId); await approveFirstTwo(f,id);
    await withTenant(f.actors[2], tx => rawFinal(tx, f.actors[2], id, f.d.employmentId));
    expect((await readCorrection(id)).status).toBe('pending'); // Deliberately incomplete raw client transaction.
    await expect(withTenant(f.actors[2], tx => tx.execute(sql`select app.attendance_workflow_begin_effect(${id}::uuid)`))).rejects.toThrow();
    await withTenant(f.actors[2], async tx => {
      await tx.execute(sql`select set_config('app.attendance_workflow_effect',${id},true)`);
      const [proof] = await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.d.employmentId}::uuid,${date}::date) as ok`) as unknown as { ok: boolean }[];
      expect(proof.ok).toBe(false);
    });
    expect((await readDay(f.d.employmentId)).checkInAt).toBe('08:00:00');
  });
  it('retains only the fresh finalized day capability for downstream OT writes, never a replayed approved hint',async()=>{
    const f=await fixture();await enable(f.a);const id=await submit(f.self,f.d.employmentId);await approveFirstTwo(f,id);
    const day=await readDay(f.d.employmentId);
    await withTenant(f.actors[2],async tx=>{
      await tx.execute(sql`savepoint downstream_overtime_effect`);
      await rawFinal(tx,f.actors[2],id,f.d.employmentId);
      await tx.execute(sql`select app.attendance_workflow_begin_effect(${id}::uuid)`);
      await tx.update(schema.attendancePunch).set({voidedAt:new Date(),voidedBy:f.actors[2].userId!,voidReason:'Verified request-bound clock correction'}).where(eq(schema.attendancePunch.attendanceId,day.id));
      // Canonical corrections use admin punches under the verified final-effect capability.
      await tx.insert(schema.attendancePunch).values([
        {tenantId:b.tenantId,attendanceId:day.id,employmentId:f.d.employmentId,attendanceDate:date,punchAt:'09:00:00',direction:'in',method:'admin'},
        {tenantId:b.tenantId,attendanceId:day.id,employmentId:f.d.employmentId,attendanceDate:date,punchAt:'18:00:00',direction:'out',method:'admin'},
      ]);
      await tx.update(schema.attendance).set({checkInAt:'09:00:00',checkOutAt:'18:00:00',workedMinutes:540}).where(eq(schema.attendance.id,day.id));
      await tx.update(schema.attendanceCorrection).set({status:'approved',decidedAt:sql`now()`,decidedByEmploymentId:f.third.employmentId}).where(eq(schema.attendanceCorrection.id,id));
      const [scope]=await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.d.employmentId}::uuid,${date}::date) as own,app.attendance_workflow_effect_scope(${f.d.employmentId}::uuid,${addDays(date,-1)}::date) as other_date`) as unknown as {own:boolean;other_date:boolean}[];
      expect(scope).toEqual({own:true,other_date:false});
      expect(await tx.update(schema.attendance).set({remarks:'Canonical post-approval overtime stage'}).where(eq(schema.attendance.id,day.id)).returning()).toHaveLength(1);
      await tx.execute(sql`release savepoint downstream_overtime_effect`);
      const [released]=await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.d.employmentId}::uuid,${date}::date) as ok`) as unknown as {ok:boolean}[];
      expect(released.ok).toBe(false);
    });
    await withTenant(f.actors[2],async tx=>{
      await tx.execute(sql`select set_config('app.attendance_workflow_effect',${id},true)`);
      const [replayed]=await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.d.employmentId}::uuid,${date}::date) as ok`) as unknown as {ok:boolean}[];
      expect(replayed.ok).toBe(false);
      expect(await tx.update(schema.attendance).set({remarks:'Replayed finalized hint'}).where(eq(schema.attendance.id,day.id)).returning()).toEqual([]);
    });
    expect((await readDay(f.d.employmentId)).remarks).toBe('Canonical post-approval overtime stage');
  });
  it('keeps processed Payroll money/history intact, marks only the canonical covered subject, and refuses a closed run', async () => {
    const f = await fixture(); await enable(f.a); const id = await submit(f.self,f.d.employmentId); await approveFirstTwo(f,id);
    await setCompensation(f.a,{employmentId:f.d.employmentId,basicSalary:4000,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
    const {batchId}=await createBatch(f.a,{companyId:b.companyId,payPeriod:date.slice(0,7),scope:{employmentIds:[f.d.employmentId]}}); await generatePayslips(f.a,{batchId});
    const slips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId)); expect(slips).toHaveLength(1);
    await setCompensation(f.a,{employmentId:f.first.employmentId,basicSalary:3500,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
    const other=await createBatch(f.a,{companyId:b.companyId,payPeriod:addDays(date,-45).slice(0,7),scope:{employmentIds:[f.first.employmentId]}}); await generatePayslips(f.a,{batchId:other.batchId});
    const otherBefore=(await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,other.batchId)))[0];
    await expect(withTenant(f.actors[2],async tx=>{
      await rawFinal(tx,f.actors[2],id,f.d.employmentId); await tx.execute(sql`select app.attendance_workflow_begin_effect(${id}::uuid)`);
      const [notMember]=await tx.execute(sql`select app.mark_attendance_payroll_recalc(${f.d.employmentId}::uuid,${other.batchId}::uuid) as ok`) as unknown as {ok:boolean}[]; expect(notMember.ok).toBe(false);
      await refused(tx,attempt=>attempt.execute(sql`select app.mark_attendance_payroll_recalc(${f.first.employmentId}::uuid,${other.batchId}::uuid)`));
      expect(await tx.update(schema.payrollBatch).set({status:'closed'}).where(eq(schema.payrollBatch.id,batchId)).returning()).toEqual([]);
      throw new Error('Rollback Payroll capability diagnostic');
    })).rejects.toThrow('Rollback Payroll capability');
    expect((await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,other.batchId)))[0]).toEqual(otherBefore);

    expect(await withTenant(f.actors[2],tx=>tx.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId)))).toHaveLength(0);
    await closeBatch(f.a,{batchId});
    const closed=(await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId)))[0];
    await expect(decideAttendanceCorrection(f.actors[2],{correctionId:id,decision:'approved',expectedStageIndex:2})).rejects.toBeInstanceOf(AttendancePayrollClosedError);
    expect(await readDecisions()).toHaveLength(2); expect((await readCorrection(id)).status).toBe('pending');
    expect((await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId)))[0]).toEqual(closed);
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId))).toEqual(slips);
    await setSetting(b.tenantId,'payroll.unlock_enabled',true);await unlockClosedBatch(await entitledCtx(b),{batchId,reason:'Reopen the fixture run for verified Attendance correction'});
    await decideAttendanceCorrection(f.actors[2],{correctionId:id,decision:'approved',expectedStageIndex:2});
    const batch=(await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId)))[0];
    expect(batch.needsRecalcAt).not.toBeNull(); expect(batch.recalcEmploymentIds).toContain(f.d.employmentId);
    expect(batch.status).toBe('processed');
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId))).toEqual(slips);
  });
});


describe('797ba70b: savepoint proof and canonical same-day plan dependencies', () => {
  it('completes the fixed pipeline inside an active outer savepoint and restores the real actor and hint', async () => {
    const f = await fixture(); await enable(f.a); const id = await submit(f.self,f.d.employmentId); await approveFirstTwo(f,id);
    await withTenant(f.actors[2],async tx=>{
      await tx.execute(sql`savepoint active_item`);
      expect(await decideAttendanceCorrection(f.actors[2],{correctionId:id,decision:'approved',expectedStageIndex:2},tx)).toMatchObject({status:'approved'});
      const [state]=await tx.execute(sql`select current_setting('app.user_id',true) as actor,coalesce(current_setting('app.attendance_workflow_effect',true),'') as hint`) as unknown as {actor:string;hint:string}[];
      expect(state).toEqual({actor:f.actors[2].userId,hint:''});
      await tx.execute(sql`release savepoint active_item`);
    });
    expect((await readCorrection(id)).status).toBe('approved');
    expect((await readDecisions())[2].actualUserId).toBe(f.actors[2].userId);
  });
  it('deliberately refuses proof after the writing savepoint is released, even before outer commit', async () => {
    const f = await fixture(); await enable(f.a); const id = await submit(f.self,f.d.employmentId); await approveFirstTwo(f,id);
    await expect(withTenant(f.actors[2],async tx=>{
      await tx.execute(sql`savepoint completed_item`); await rawFinal(tx,f.actors[2],id,f.d.employmentId);
      await tx.execute(sql`select app.attendance_workflow_begin_effect(${id}::uuid)`);
      await tx.execute(sql`release savepoint completed_item`);
      await tx.execute(sql`select set_config('app.attendance_workflow_effect',${id},true)`);
      const [proof]=await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.d.employmentId}::uuid,${date}::date) as ok`) as unknown as {ok:boolean}[];
      expect(proof.ok).toBe(false);
      await refused(tx,attempt=>attempt.execute(sql`select app.attendance_workflow_begin_effect(${id}::uuid)`));
      throw new Error('Rollback released-savepoint diagnostic');
    })).rejects.toThrow('Rollback released-savepoint');
    expect(await readDecisions()).toHaveLength(2);
  });
  it('lands an already-approved future OT plan through the canonical clock-correction owner, preserving its original approval', async () => {
    const f = await fixture(), future=addDays(todayInKualaLumpur(),8);
    const planId=await submit(f.self,f.d.employmentId,true,future);
    await decideAttendanceCorrection(f.a,{correctionId:planId,decision:'approved'});
    const original=await readCorrection(planId); expect(original.status).toBe('approved'); expect(original.appliedAt).toBeNull();
    vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date(`${addDays(future,1)}T12:00:00+08:00`));
    try {
      await enable(f.a);
      const id=await submit(f.self,f.d.employmentId,false,future); await approveFirstTwo(f,id);
      await decideAttendanceCorrection(f.actors[2],{correctionId:id,decision:'approved',expectedStageIndex:2});
      const plan=await readCorrection(planId), day=await readDay(f.d.employmentId,future);
      expect(plan.appliedAt).not.toBeNull(); expect(plan.approvedOtMinutes).not.toBeNull();
      expect(day.calcTrace?.overtime?.approvedMinutes).toBe(plan.approvedOtMinutes);
      expect(plan).toMatchObject({status:'approved',decidedAt:original.decidedAt,decidedByEmploymentId:original.decidedByEmploymentId,requestedOtMinutes:original.requestedOtMinutes,otApprovalMethod:original.otApprovalMethod,reason:original.reason});
      expect((await readDecisions()).map(d=>d.actualUserId)).toEqual(f.actors.map(a=>a.userId));
    } finally {vi.useRealTimers();}
  });
  it('refuses arbitrary plan stamps, status/input changes, pending plans, another date and another subject', async () => {
    const f = await fixture(); await enable(f.a); const id=await submit(f.self,f.d.employmentId); await approveFirstTwo(f,id);
    const makePlan=async (employmentId:string,on:string,status:'approved'|'pending'='approved')=>(await owner.db.insert(schema.attendanceCorrection).values({tenantId:b.tenantId,employmentId,attendanceDate:on,requestedOtMinutes:60,reason:'Historic approved plan',status,decidedAt:status==='approved'?new Date():null,otApprovalMethod:'requested'}).returning())[0];
    const own=await makePlan(f.d.employmentId,date),otherDate=await makePlan(f.d.employmentId,addDays(date,-1)),otherPerson=await makePlan(f.first.employmentId,date);
    const day=await readDay(f.d.employmentId);
    await expect(withTenant(f.actors[2],async tx=>{
      await rawFinal(tx,f.actors[2],id,f.d.employmentId); await tx.execute(sql`savepoint plan_effect`); await tx.execute(sql`select app.attendance_workflow_begin_effect(${id}::uuid)`);
      // Complete the exact request effect before adding another pending request for this day.
      // The one-pending-request constraint must remain active throughout this diagnostic.
      await tx.update(schema.attendancePunch).set({voidedAt:new Date(),voidedBy:f.actors[2].userId!,voidReason:'Verified request-bound clock correction'}).where(eq(schema.attendancePunch.attendanceId,day.id));
      // Canonical corrections use admin punches under the verified final-effect capability.
      await tx.insert(schema.attendancePunch).values([
        {tenantId:b.tenantId,attendanceId:day.id,employmentId:f.d.employmentId,attendanceDate:date,punchAt:'09:00:00',direction:'in',method:'admin'},
        {tenantId:b.tenantId,attendanceId:day.id,employmentId:f.d.employmentId,attendanceDate:date,punchAt:'18:00:00',direction:'out',method:'admin'},
      ]);
      await tx.update(schema.attendance).set({checkInAt:'09:00:00',checkOutAt:'18:00:00',workedMinutes:540}).where(eq(schema.attendance.id,day.id));
      await tx.update(schema.attendanceCorrection).set({status:'approved',decidedAt:sql`now()`,decidedByEmploymentId:f.third.employmentId}).where(eq(schema.attendanceCorrection.id,id));
      const [pending]=await tx.insert(schema.attendanceCorrection).values({tenantId:b.tenantId,employmentId:f.d.employmentId,attendanceDate:date,requestedOtMinutes:60,reason:'Independent pending plan',status:'pending',otApprovalMethod:'requested'}).returning();
      for(const plan of [pending,otherDate,otherPerson]) await refused(tx,attempt=>attempt.update(schema.attendanceCorrection).set({appliedAt:sql`now()`}).where(eq(schema.attendanceCorrection.id,plan.id)));
      await refused(tx,attempt=>attempt.update(schema.attendanceCorrection).set({reason:'Forged approved input',appliedAt:sql`now()`}).where(eq(schema.attendanceCorrection.id,own.id)));
      await refused(tx,attempt=>attempt.update(schema.attendanceCorrection).set({status:'pending',appliedAt:sql`now()`}).where(eq(schema.attendanceCorrection.id,own.id)));
      const current=await readDay(f.d.employmentId); expect(current.calcTrace?.overtime).toBeTruthy();
      await tx.update(schema.attendance).set({calcTrace:{...current.calcTrace!,overtime:{...current.calcTrace!.overtime!,approvedMinutes:60}}}).where(eq(schema.attendance.id,current.id));
      await tx.update(schema.attendanceCorrection).set({appliedAt:sql`now()`}).where(eq(schema.attendanceCorrection.id,own.id));
      await refused(tx,attempt=>attempt.update(schema.attendanceCorrection).set({approvedOtMinutes:61}).where(eq(schema.attendanceCorrection.id,own.id)));
      const [stamped]=await tx.update(schema.attendanceCorrection).set({approvedOtMinutes:60}).where(eq(schema.attendanceCorrection.id,own.id)).returning(); expect(stamped.approvedOtMinutes).toBe(60);
      const [stillPending]=await tx.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,pending.id));expect(stillPending.status).toBe('pending');expect(stillPending.appliedAt).toBeNull();
      throw new Error('Rollback plan-boundary diagnostic');
    })).rejects.toThrow('Rollback plan-boundary');
    expect((await readCorrection(own.id)).appliedAt).toBeNull(); expect((await readCorrection(id)).status).toBe('pending');
    expect(await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.reason,'Independent pending plan'))).toEqual([]);
  });
});


describe('797ba70b: Personnel-owned assignment criteria and request-bound delegation', () => {
  it('matches every requested field using any within a field and all across fields, with employee restrictions intersected', async () => {
    const f=await fixture();
    const units=await owner.db.insert(schema.businessUnit).values(['A','B'].map(code=>({tenantId:b.tenantId,companyId:b.companyId,code:`HIER_${code}`,name:`Hierarchy unit ${code}`}))).returning();
    const grades=await owner.db.insert(schema.jobGrade).values(['A','B'].map(code=>({tenantId:b.tenantId,code:`HIER_${code}`,name:`Hierarchy grade ${code}`}))).returning();
    const positions=await owner.db.insert(schema.position).values(['A','B'].map(code=>({tenantId:b.tenantId,companyId:b.companyId,label:`HIER_${code}`,title:`Hierarchy position ${code}`}))).returning();
    const criteria:AttendanceWorkflowInput['criteria']={departmentIds:[b.deptA,b.deptB],businessUnitIds:units.map(u=>u.id),gradeIds:grades.map(g=>g.id),positionIds:positions.map(p=>p.id),employmentTypes:['full_time','part_time'],employeeIds:[f.d.employmentId,f.first.employmentId]};
    const only:AttendanceWorkflowInput['criteria']={departmentIds:[b.deptA],businessUnitIds:[units.find(u=>u.code==='HIER_A')!.id],gradeIds:[grades.find(g=>g.code==='HIER_A')!.id],positionIds:[positions.find(p=>p.label==='HIER_A')!.id],employmentTypes:['full_time'],employeeIds:[f.d.employmentId]};
    for(const category of EMPLOYMENT_PROFILE_CATEGORIES){
      const column=CATEGORY_EMPLOYMENT_COLUMN[category]?.[0] as keyof typeof criteria;
      await owner.db.insert(schema.profileOption).values(['A','B'].map(value=>({tenantId:b.tenantId,category,value:`${category}-${value}`,label:`${category} ${value}`})));
      criteria[column]=[`${category}-A`,`${category}-B`]; only[column]=[`${category}-A`];
      for(const [e,key] of [[f.d,'A'],[f.first,'B']] as const) await owner.db.update(schema.employment).set({[column]:`${category}-${key}`}).where(eq(schema.employment.id,e.employmentId));
    }
    for(const [e,key] of [[f.d,'A'],[f.first,'B']] as const){
      await owner.db.update(schema.assignment).set({businessUnitId:units.find(u=>u.code===`HIER_${key}`)!.id,positionId:positions.find(p=>p.label===`HIER_${key}`)!.id,employmentType:key==='A'?'full_time':'part_time'}).where(eq(schema.assignment.employmentId,e.employmentId));
      await owner.db.update(schema.employment).set({gradeId:grades.find(g=>g.code===`HIER_${key}`)!.id}).where(eq(schema.employment.id,e.employmentId));
    }
    const value=input({criteria,stages:[{name:'HR',level:{kind:'hr_admin',employmentId:null,alternates:[]}}]});
    const saved=await saveAttendanceWorkflow(f.a,value);
    expect(new Set((await previewAttendanceWorkflow(f.a,value,saved.lineageId)).rows.map(r=>r.employmentId))).toEqual(new Set([f.d.employmentId,f.first.employmentId]));
    for(const [key,selected] of Object.entries(only)) expect((await previewAttendanceWorkflow(f.a,{...value,criteria:{...criteria,[key]:selected}},saved.lineageId)).rows.map(r=>r.employmentId)).toEqual([f.d.employmentId]);
    expect((await previewAttendanceWorkflow(f.a,{...value,criteria:{departmentIds:[b.deptA],employeeIds:[f.first.employmentId]}},saved.lineageId)).total).toBe(0);
    await expect(saveAttendanceWorkflow(f.a,{...value,code:'OVERLAP'})).rejects.toMatchObject({code:'overlap'});
    await expect(saveAttendanceWorkflow(f.a,{...value,code:'PRIORITY',priority:99})).resolves.toBeTruthy();
  });
  it('admits only the frozen superior’s valid Attendance delegation, logs the real delegate and refuses wrong org coverage', async () => {
    const f=await fixture(), stand=await hire('Level two delegate'), delegate=await login(stand.personId);
    const standReport=await hire('Delegate real downline',b.deptB);await setReportingLine(f.a,{subordinateEmploymentId:standReport.employmentId,managerEmploymentId:stand.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
    const cover=await setReportingLine(f.a,{subordinateEmploymentId:f.second.employmentId,managerEmploymentId:stand.employmentId,lineType:'delegate',validFrom:'2020-01-01',reason:'Temporary level two cover',scopes:[{module:'attendance',taskType:'attendance.correction'}],orgScope:{companyId:b.companyId,departmentId:b.deptB,businessUnitId:null}});
    await enable(f.a); const id=await submit(f.self,f.d.employmentId); await decideAttendanceCorrection(f.actors[0],{correctionId:id,decision:'approved',expectedStageIndex:0});
    await expect(decideAttendanceCorrection(delegate,{correctionId:id,decision:'approved',expectedStageIndex:1})).rejects.toThrow();
    await editDelegation(f.a,{reportingLineId:cover.reportingLineId,managerEmploymentId:stand.employmentId,validFrom:'2020-01-01',validTo:null,reason:'Correct scoped cover',scopes:[{module:'attendance',taskType:'attendance.correction'}],orgScope:{companyId:b.companyId,departmentId:b.deptA,businessUnitId:null}});
    expect((await listAttendanceCorrections(delegate,{status:'pending'})).map(r=>r.id)).toContain(id);
    await decideAttendanceCorrection(delegate,{correctionId:id,decision:'approved',expectedStageIndex:1});
    const decision=(await readDecisions()).find(d=>d.stageIndex===1)!;
    expect(decision).toMatchObject({assignedEmploymentId:f.second.employmentId,actualUserId:delegate.userId,actualPersonId:stand.personId,actualEmploymentId:null,actingMode:'delegate'});
    await decideAttendanceCorrection(f.actors[2],{correctionId:id,decision:'approved',expectedStageIndex:2});
    expect((await readCorrection(id)).status).toBe('approved');
  });
});


describe('797ba70b: actual final effects and immutable approved inputs', () => {
  it.each([false,true])('rejects an app-forged effect event with unchanged Attendance (lost live scope=%s)', async lostScope=>{
    const f=await fixture();await enable(f.a);const id=await submit(f.self,f.d.employmentId);await approveFirstTwo(f,id);
    if(lostScope){const replacement=await hire('Unrelated new superior');await login(replacement.personId);await setReportingLine(f.a,{subordinateEmploymentId:f.d.employmentId,managerEmploymentId:replacement.employmentId,lineType:'administrative',validFrom:'2020-01-01'});}
    const before=await readDay(f.d.employmentId);
    await expect(withTenant(f.actors[2],async tx=>{
      await rawFinal(tx,f.actors[2],id,f.d.employmentId);await tx.execute(sql`select app.attendance_workflow_begin_effect(${id}::uuid)`);
      await tx.insert(schema.domainEvent).values({tenantId:b.tenantId,aggregateType:'attendance-correction',aggregateId:id,eventType:'attendance-correction.effect.recorded',actorType:'user',actorId:f.actors[2].userId,subjectEmploymentId:f.d.employmentId,payload:{forged:true}});
      await refused(tx,attempt=>attempt.update(schema.attendanceCorrection).set({status:'approved',decidedAt:sql`now()`,decidedByEmploymentId:f.third.employmentId}).where(eq(schema.attendanceCorrection.id,id)));
      if(!lostScope){
        // A meaningless active day write does not establish that the requested punches were applied.
        await tx.update(schema.attendance).set({remarks:'Forged noop marker'}).where(eq(schema.attendance.id,before.id));
        await refused(tx,attempt=>attempt.update(schema.attendanceCorrection).set({status:'approved',decidedAt:sql`now()`,decidedByEmploymentId:f.third.employmentId}).where(eq(schema.attendanceCorrection.id,id)));
      }
      throw new Error('Rollback forged-event diagnostic');
    })).rejects.toThrow('Rollback forged-event');
    expect(await readDay(f.d.employmentId)).toEqual(before);expect((await readCorrection(id)).status).toBe('pending');expect(await readDecisions()).toHaveLength(2);
  });
  it.each([false,true])('accepts the canonical no-op correction, including unchanged punch IDs (clock entries=%s)',async entries=>{
    const f=await fixture();await enable(f.a);const before=await readDay(f.d.employmentId),clocks=await attendanceClockData(f.a,f.d.employmentId,date);
    let id:string;
    if(entries){
      const clockChanges={version:1 as const,baseline:clocks.baseline,entries:clocks.rows.filter(p=>!p.voidedAt).map(p=>({id:p.id,punchAt:p.punchAt,direction:p.direction}))};
      await expect(requestAttendanceCorrection(f.self,{employmentId:f.d.employmentId,date,reason:'Unchanged clock set',clockChanges})).rejects.toThrow('Only an authorised administrator may edit clock data');
      await expect(requestAttendanceCorrection(f.a,{employmentId:f.d.employmentId,date,reason:'Unchanged clock set',clockChanges})).rejects.toThrow('Change at least one clocking before saving');
      // Existing captured requests still need a valid final-effect proof when the requested set is
      // already equal. Seed that historical row as authorized HR, then freeze its real v2 workflow.
      id=await withTenant(f.a,async tx=>{const [row]=await tx.insert(schema.attendanceCorrection).values({tenantId:b.tenantId,employmentId:f.d.employmentId,attendanceDate:date,reason:'Existing reviewed no-op request',clockChanges}).returning({id:schema.attendanceCorrection.id});await snapshotAttendanceWorkflowTx(tx,f.a,row.id,f.d.employmentId,'irregularity');return row.id;});
    }else id=(await requestAttendanceCorrection(f.self,{employmentId:f.d.employmentId,date,reason:'Reviewed no-op is an explicit human decision',checkIn:'08:00',checkOut:'17:00'})).correctionId;
    await approveFirstTwo(f,id);await decideAttendanceCorrection(f.actors[2],{correctionId:id,decision:'approved',expectedStageIndex:2});
    expect((await readCorrection(id)).status).toBe('approved');expect(await readDay(f.d.employmentId)).toMatchObject({checkInAt:before.checkInAt,checkOutAt:before.checkOutAt,workedMinutes:before.workedMinutes,otMinutes:before.otMinutes});
    if(entries)expect((await attendanceClockData(f.a,f.d.employmentId,date)).rows.filter(p=>!p.voidedAt).map(p=>p.id)).toEqual(clocks.rows.filter(p=>!p.voidedAt).map(p=>p.id));
  });
  it('approves genuine future OT without an attendance placeholder, freezes agreed inputs and lands through the canonical owner later',async()=>{
    const f=await fixture(),future=addDays(todayInKualaLumpur(),8);await enable(f.a,input({applicationType:'self_overtime'}));const id=await submit(f.self,f.d.employmentId,true,future);
    await approveFirstTwo(f,id);expect(await decideAttendanceCorrection(f.actors[2],{correctionId:id,decision:'approved',expectedStageIndex:2})).toMatchObject({status:'approved',deferred:true});
    expect(await readDay(f.d.employmentId,future)).toBeUndefined();const original=await readCorrection(id);expect(original.appliedAt).toBeNull();
    await withTenant(f.self,async tx=>{
      await refused(tx,attempt=>attempt.update(schema.attendanceCorrection).set({requestedOtMinutes:original.requestedOtMinutes!+60}).where(eq(schema.attendanceCorrection.id,id)));
      await refused(tx,attempt=>attempt.update(schema.attendanceCorrection).set({otApprovalMethod:original.otApprovalMethod==='requested'?'system_calculated':'requested'}).where(eq(schema.attendanceCorrection.id,id)));
      await refused(tx,attempt=>attempt.update(schema.attendanceCorrection).set({status:'pending'}).where(eq(schema.attendanceCorrection.id,id)));
      await refused(tx,attempt=>attempt.update(schema.attendanceCorrection).set({approvedOtMinutes:999,appliedAt:sql`now()`}).where(eq(schema.attendanceCorrection.id,id)));
      await refused(tx,attempt=>attempt.update(schema.attendanceCorrection).set({decidedByEmploymentId:f.d.employmentId}).where(eq(schema.attendanceCorrection.id,id)));
    });
    expect(await readCorrection(id)).toEqual(original);
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(`${addDays(future,1)}T12:00:00+08:00`));
    try{
      await checkIn(f.a,{employmentId:f.d.employmentId,date:future,time:'08:00',manual:true});await checkOut(f.a,{employmentId:f.d.employmentId,date:future,time:'19:00',manual:true});
      const landed=await readCorrection(id),day=await readDay(f.d.employmentId,future);expect(landed.appliedAt).not.toBeNull();expect(day.calcTrace?.overtime?.approvedMinutes).toBe(landed.approvedOtMinutes);
      expect(landed).toMatchObject({status:'approved',requestedOtMinutes:original.requestedOtMinutes,otApprovalMethod:original.otApprovalMethod,decidedAt:original.decidedAt,decidedByEmploymentId:original.decidedByEmploymentId});
    }finally{vi.useRealTimers();}
  });
});


it('does not treat an administrator-amended future OT request as an effect-free deferral',async()=>{
  const f=await fixture(),future=addDays(todayInKualaLumpur(),8);await enable(f.a,input({applicationType:'self_overtime'}));const id=await submit(f.self,f.d.employmentId,true,future);
  await withTenant(f.a,tx=>tx.update(schema.attendanceCorrection).set({adminAmendment:{version:randomUUID(),checkIn:'09:00',checkOut:'18:00',reason:'Administrator adds effective clock inputs',actorId:f.a.userId!,recordedAt:new Date().toISOString()}}).where(eq(schema.attendanceCorrection.id,id)));
  await approveFirstTwo(f,id);
  await expect(withTenant(f.actors[2],async tx=>{
    await rawFinal(tx,f.actors[2],id,f.d.employmentId);await tx.execute(sql`select app.attendance_workflow_begin_effect(${id}::uuid)`);
    await refused(tx,attempt=>attempt.update(schema.attendanceCorrection).set({status:'approved',decidedAt:sql`now()`,decidedByEmploymentId:f.third.employmentId}).where(eq(schema.attendanceCorrection.id,id)));
    throw new Error('Rollback amended-deferral diagnostic');
  })).rejects.toThrow('Rollback amended-deferral');
  expect((await readCorrection(id)).status).toBe('pending');expect(await readDay(f.d.employmentId,future)).toBeUndefined();expect(await readDecisions()).toHaveLength(2);
});
