import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { captureEmployeeClock } from '../core/attendance-clock';
import { ownClockToday } from '../core/attendance-clock-read';
import { commitClockingImport, getClockingImportRun } from '../core/attendance-clocking-import';
import { BUILTIN_MAPPING_ID } from '../lib/clocking-file';
import { setAttendancePhotoSetting } from '../core/clocking-location';
import { todayInKualaLumpur } from '../lib/hr-date';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { checkIn, checkOut, requestAttendanceCorrection, decideAttendanceCorrection, attendancePunchesForRange, attendancePunchesForDays } from '../core/attendance';
import { attendanceClockData } from '../core/attendance-clock-data';
import { ClockDataChangedError, AttendancePayrollClosedError, validateClockEntries } from '../core/attendance-punch-change';
import { createBatch, generatePayslips } from '../packs/payroll/service';
import { withTenant } from '../db/client';
import { setCompensation } from '../core/comp';
import { adminCtx, createAppUser, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
const date = '2026-07-15';
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
async function fixture() {
  const a = adminCtx(b);
  const e = await hireEmployee(a, { person: { fullName: 'Clock data worker', primaryEmail: 'clock-data@test.local' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
  await checkIn(a, { employmentId: e.employmentId, date, time: '08:00', manual: true });
  await checkOut(a, { employmentId: e.employmentId, date, time: '17:00', manual: true });
  return { a, ...e };
}
const day = async (employmentId: string) => (await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date))))[0];
async function save(a: ReturnType<typeof adminCtx>, employmentId: string, entries: {
  id?: string;
  punchAt: string;
  direction: 'in' | 'out';
}[]) {
  const data = await attendanceClockData(a, employmentId, date);
  const { correctionId } = await requestAttendanceCorrection(a, { employmentId, date, reason: 'Verified gate log', clockChanges: { version: 1, baseline: data.baseline, entries } });
  await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
  return correctionId;
}
describe('approved attendance clock-data corrections', () => {
  it('edits retain original evidence and all effective readers agree with the corrected day', async () => {
    const { a, employmentId } = await fixture();
    const before = await attendanceClockData(a, employmentId, date);
    await save(a, employmentId, before.rows.map(r => ({ id: r.id, punchAt: r.direction === 'in' ? '09:00' : '18:00', direction: r.direction })));
    const raw = await attendanceClockData(a, employmentId, date);
    expect(raw.rows).toHaveLength(4);
    expect(raw.rows.filter(r => r.voidedAt).map(r => r.punchAt)).toEqual(['08:00:00', '17:00:00']);
    expect(raw.rows.filter(r => !r.voidedAt).every(r => r.method === 'admin')).toBe(true);
    expect(raw.rows.filter(r => r.voidedAt).every(r => r.voidReason === 'Verified gate log')).toBe(true);
    const d = await day(employmentId);
    expect([d.checkInAt, d.checkOutAt, d.workedMinutes]).toEqual(['09:00:00', '18:00:00', 480]);
    expect((await attendancePunchesForRange(a, employmentId, date, date)).get(d.id)?.map(r => r.punchAt)).toEqual(['09:00:00', '18:00:00']);
    expect((await attendancePunchesForDays(a, [d.id])).get(d.id)?.map(r => r.punchAt)).toEqual(['09:00:00', '18:00:00']);
  });
  it('remove-all clears paid figures, preserves records, and restore recomputes the day', async () => {
    const { a, employmentId } = await fixture();
    const original = await attendanceClockData(a, employmentId, date);
    await save(a, employmentId, []);
    const cleared = await day(employmentId);
    expect([cleared.checkInAt, cleared.checkOutAt, cleared.workedMinutes, cleared.otMinutes, cleared.lateMinutes]).toEqual([null, null, null, null, null]);
    expect(cleared.status).toBe('absent');
    expect((await attendanceClockData(a, employmentId, date)).rows.every(r => !!r.voidedAt)).toBe(true);
    await expect(checkIn(a, { employmentId, date, time: '19:00', manual: true })).rejects.toThrow(/correction owns/);
    await save(a, employmentId, original.rows.map(r => ({ id: r.id, punchAt: r.punchAt, direction: r.direction })));
    expect((await attendanceClockData(a, employmentId, date)).rows).toHaveLength(2);
    expect((await day(employmentId)).workedMinutes).toBe(480);
  });
  it('legacy pair corrections also replace effective clockings without destroying originals', async () => {
    const { a, employmentId } = await fixture();
    const { correctionId } = await requestAttendanceCorrection(a, { employmentId, date, checkIn: '09:00', checkOut: '18:00', reason: 'Gate log' });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    const raw = await attendanceClockData(a, employmentId, date);
    expect(raw.rows.filter(r => !r.voidedAt).map(r => r.punchAt)).toEqual(['09:00:00', '18:00:00']);
    expect(raw.rows.filter(r => r.voidedAt)).toHaveLength(2);
  });
  it('rejects stale approval atomically when new clocking arrived after the request', async () => {
    const { a, employmentId } = await fixture();
    const raw = await attendanceClockData(a, employmentId, date);
    const { correctionId } = await requestAttendanceCorrection(a, { employmentId, date, reason: 'Proposed before a new clocking', clockChanges: { version: 1, baseline: raw.baseline, entries: [] } });
    await checkIn(a, { employmentId, date, time: '18:00', manual: true });
    await expect(decideAttendanceCorrection(a, { correctionId, decision: 'approved' })).rejects.toBeInstanceOf(ClockDataChangedError);
    expect((await attendanceClockData(a, employmentId, date)).rows.filter(r => r.voidedAt)).toHaveLength(0);
    expect((await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id, correctionId)))[0].status).toBe('pending');
  });
  it('refuses duplicate restores and unknown or foreign punch ids', async () => {
    const { a, employmentId } = await fixture();
    const raw = await attendanceClockData(a, employmentId, date);
    const e = raw.rows[0];
    expect(() => validateClockEntries([{ punchAt: e.punchAt, direction: e.direction }, { punchAt: e.punchAt.slice(0, 5), direction: e.direction }])).toThrow(/already in use/);
    await expect(save(a, employmentId, [{ id: '00000000-0000-0000-0000-000000000000', punchAt: '09:00', direction: 'in' }])).rejects.toThrow(/does not belong/);
  });
  it('keeps self-approval refused and records the pending request', async () => {
    const { a, employmentId, personId } = await fixture();
    const self = { ...a, personId };
    const raw = await attendanceClockData(self, employmentId, date);
    const { correctionId } = await requestAttendanceCorrection(self, { employmentId, date, reason: 'Own attendance', clockChanges: { version: 1, baseline: raw.baseline, entries: [] } });
    await expect(decideAttendanceCorrection(self, { correctionId, decision: 'approved' })).rejects.toThrow(/cannot decide your own/);
    expect((await attendanceClockData(a, employmentId, date)).rows.filter(r => r.voidedAt)).toHaveLength(0);
  });
  it('refuses changes to dates owned by a closed payroll', async () => {
    const { a, employmentId } = await fixture();
    await setCompensation(a, { employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2020-01-01' });
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId });
    await owner.db.update(schema.payrollBatch).set({ status: 'closed' }).where(eq(schema.payrollBatch.id, batchId));
    await expect(save(a, employmentId, [])).rejects.toBeInstanceOf(AttendancePayrollClosedError);
    expect((await attendanceClockData(a, employmentId, date)).rows.filter(r => r.voidedAt)).toHaveLength(0);
  });
  it('ordinary employees cannot read raw evidence or submit administrative punch sets', async () => {
    const { a, employmentId, personId } = await fixture();
    const raw = await attendanceClockData(a, employmentId, date);
    const userId = await createAppUser(b.tenantId, personId, 'employee');
    const employee = { ...a, userId, personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    await expect(attendanceClockData(employee, employmentId, date)).rejects.toThrow(/administrator/);
    await expect(withTenant(employee, tx => tx.execute(sql`select * from app.attendance_payroll_protection(${employmentId}::uuid)`))).rejects.toThrow();
    await expect(requestAttendanceCorrection(employee, { employmentId, date, reason: 'Not an admin', clockChanges: { version: 1, baseline: raw.baseline, entries: [] } })).rejects.toThrow(/administrator/);
    expect((await attendanceClockData(a, employmentId, date)).rows.filter(r => r.voidedAt)).toHaveLength(0);
  });
  it('an employee cannot forge an administrative punch to bypass capture requirements', async () => {
    const { a, employmentId, personId } = await fixture();
    const userId = await createAppUser(b.tenantId, personId, 'employee');
    const employee = { ...a, userId, personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    const d = await day(employmentId);
    await expect(withTenant(employee, tx => tx.insert(schema.attendancePunch).values({
      tenantId: b.tenantId, employmentId, attendanceId: d.id, attendanceDate: date,
      punchAt: '19:00:00', direction: 'in', method: 'admin',
    }))).rejects.toMatchObject({ cause: { message: 'Employee clocking requires a photo capture' } });
    expect((await attendanceClockData(a, employmentId, date)).rows).toHaveLength(2);
  });
  it('cross-tenant raw reads and punch updates see no rows under application RLS', async () => {
    const { a, employmentId } = await fixture();
    await save(a, employmentId, []);
    const other = adminCtx(await seedBase());
    await expect(attendanceClockData(other, employmentId, date)).rejects.toThrow(/administrator/);
    await expect(withTenant(other, tx => tx.execute(sql`select * from app.attendance_payroll_protection(${employmentId}::uuid)`))).rejects.toThrow();
    const rows = await withTenant(other, tx => tx.select().from(schema.attendancePunch).where(eq(schema.attendancePunch.employmentId, employmentId)));
    expect(rows).toHaveLength(0);
    const updated = await withTenant(other, tx => tx.update(schema.attendancePunch).set({ voidedAt: null, voidedBy: null, voidReason: null }).where(eq(schema.attendancePunch.employmentId, employmentId)).returning());
    expect(updated).toHaveLength(0);
    expect((await attendanceClockData(a, employmentId, date)).rows.every(r => !!r.voidedAt)).toBe(true);
  });
  it('flags processed payroll for reprocessing when approved clock data changes', async () => {
    const { a, employmentId } = await fixture();
    await setCompensation(a, { employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2020-01-01' });
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId });
    await save(a, employmentId, [{ punchAt: '09:30', direction: 'in' }, { punchAt: '17:00', direction: 'out' }]);
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(batch.needsRecalcAt).not.toBeNull();
  });
  it.each(['processed', 'closed'] as const)('protects %s payroll under a manager session without exposing payslips', async status => {
    const { a, employmentId } = await fixture();
    const manager = await hireEmployee(a, { person: { fullName: 'Clock correction manager', primaryEmail: 'clock-manager@test.local' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
    await setReportingLine(a, { subordinateEmploymentId: employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: '2020-01-01' });
    const userId = await createAppUser(b.tenantId, manager.personId, 'manager');
    const mgr = { ...a, userId, personId: manager.personId, roles: ['manager'], grants: [{ role: 'manager', companyId: b.companyId }] };
    await setCompensation(a, { employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2020-01-01' });
    await setCompensation(a, { employmentId: manager.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2020-01-01' });
    await owner.db.insert(schema.companyPayrollConfig).values({ tenantId: b.tenantId, companyId: b.companyId, attendanceCutOffDay: 10 }).onConflictDoUpdate({ target: schema.companyPayrollConfig.companyId, set: { attendanceCutOffDay: 10 } });
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId });
    const raw = await attendanceClockData(a, employmentId, date);
    const { correctionId } = await requestAttendanceCorrection(a, { employmentId, date, reason: 'Reviewed by manager', clockChanges: { version: 1, baseline: raw.baseline, entries: [{ punchAt: '09:00', direction: 'in' }, { punchAt: '18:00', direction: 'out' }] } });
    expect(await withTenant(mgr, tx => tx.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employmentId)))).toHaveLength(0);
    const facts = await withTenant(mgr, tx => tx.execute(sql`select * from app.attendance_payroll_protection(${employmentId}::uuid)`));
    expect(facts).toHaveLength(1);
    expect(Object.keys(facts[0]).sort()).toEqual(['attendance_cutoff_day', 'batch_id', 'pay_period', 'policy_config', 'status']);
    if (status === 'closed') {
      await owner.db.update(schema.payrollBatch).set({ status: 'closed' }).where(eq(schema.payrollBatch.id, batchId));
      await expect(decideAttendanceCorrection(mgr, { correctionId, decision: 'approved' })).rejects.toBeInstanceOf(AttendancePayrollClosedError);
      expect((await day(employmentId)).checkInAt).toBe('08:00:00');
    } else {
      await decideAttendanceCorrection(mgr, { correctionId, decision: 'approved' });
      const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
      expect(batch.needsRecalcAt).not.toBeNull();
      expect(batch.recalcEmploymentIds).toContain(employmentId);
    }
    expect(await withTenant(mgr, tx => tx.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employmentId)))).toHaveLength(0);
  });
  it('retains web photo/GPS evidence byte-for-byte while live clocking displays only the corrected punches', async () => {
    const { a, employmentId, personId } = await fixture();
    const userId = await createAppUser(b.tenantId, personId, 'employee');
    const employee = { ...a, userId, personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    await setAttendancePhotoSetting(a, { employmentId, setting: 'optional' });
    const receipt = await captureEmployeeClock(employee, { action: 'in', requestId: randomUUID(), lat: 3.139, lng: 101.6869, accuracy: 10, photo: await sharp({ create: { width: 80, height: 60, channels: 3, background: '#246' } }).jpeg().toBuffer(), mime: 'image/jpeg' });
    const [before] = await owner.db.select().from(schema.attendanceClockCapture).where(eq(schema.attendanceClockCapture.id, receipt.id));
    expect(before.photoBytes!.length).toBeGreaterThan(0);
    const today = todayInKualaLumpur(), raw = await attendanceClockData(a, employmentId, today);
    const { correctionId } = await requestAttendanceCorrection(a, { employmentId, date: today, reason: 'Verified current-day clockings', clockChanges: { version: 1, baseline: raw.baseline, entries: [{ punchAt: '08:00', direction: 'in' }, { punchAt: '12:00', direction: 'out' }, { punchAt: '13:00', direction: 'in' }, { punchAt: '17:00', direction: 'out' }] } });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    const [after] = await owner.db.select().from(schema.attendanceClockCapture).where(eq(schema.attendanceClockCapture.id, receipt.id));
    expect(after).toEqual(before);
    const live = await ownClockToday(employee);
    expect(live.captures).toHaveLength(0);
    expect(live.legacy).toHaveLength(4);
    expect(live.workedSeconds).toBe(8 * 3600);
    const retained = (await attendanceClockData(a, employmentId, today)).rows.find(r => r.captureId === receipt.id)!;
    expect(retained.voidedAt).not.toBeNull();
    expect(retained.photoAvailable).toBe(true);
    expect(retained.lat).toBe(3.139);
  });
  it('keeps import provenance after correction and refuses later imports into the corrected day', async () => {
    const a = adminCtx(b);
    const e = await hireEmployee(a, { person: { fullName: 'Imported worker', primaryEmail: 'imported-clock@test.local' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
    const [employee] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, e.employmentId));
    const text = `staff,time\n${employee.employeeCode},${date} 08:00\n${employee.employeeCode},${date} 17:00`;
    const imported = await commitClockingImport(a, { mappingId: BUILTIN_MAPPING_ID, text, fileName: 'original-clock.csv', fileBytes: Buffer.byteLength(text) });
    expect(imported.imported).toBe(2);
    const original = await attendanceClockData(a, e.employmentId, date);
    expect(original.rows).toHaveLength(2);
    expect(original.rows.every(r => r.importFile === 'original-clock.csv' && r.method === 'import')).toBe(true);
    await save(a, e.employmentId, []);
    const extra = `staff,time\n${employee.employeeCode},${date} 18:00`;
    const later = await commitClockingImport(a, { mappingId: BUILTIN_MAPPING_ID, text: extra, fileName: 'later.csv', fileBytes: Buffer.byteLength(extra) });
    expect(later.imported).toBe(0);
    const log = await getClockingImportRun(a, later.runId!);
    expect(log?.lines.some(line => line.result === 'day_corrected')).toBe(true);
    expect((await attendanceClockData(a, e.employmentId, date)).rows.map(r => [r.id, r.importRun, r.importFile])).toEqual(original.rows.map(r => [r.id, r.importRun, r.importFile]));
  });
  it('refuses an unchanged set without creating a request or taking ownership of the day', async () => {
    const { a, employmentId } = await fixture();
    const raw = await attendanceClockData(a, employmentId, date);
    await expect(save(a, employmentId, raw.rows.map(r => ({ id: r.id, punchAt: r.punchAt, direction: r.direction })))).rejects.toThrow(/Change at least one/);
    expect(await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.employmentId, employmentId))).toHaveLength(0);
  });

});
