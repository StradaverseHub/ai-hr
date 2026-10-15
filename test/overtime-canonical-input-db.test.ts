import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {eq, sql} from 'drizzle-orm';
import {adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base} from './harness';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {withTenant} from '../db/client';
import {attendance, employment} from '../db/schema';
import {checkIn, checkOut, setAttendancePolicy, canonicalOvertimeInputTx} from '../packs/attendance/service';
import {todayInKualaLumpur} from '../lib/hr-date';

let base: Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {await resetDb(); base = await seedBase();});
async function employee() {
  const ctx = adminCtx(base);
  const hired = await hireEmployee(ctx, {person: {fullName: 'Recorded OT Worker'}, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2024-01-01'});
  await setCompensation(ctx, {employmentId: hired.employmentId, basicSalary: 3000, monthlyAllowance: 200, effectiveFrom: '2024-01-01'});
  await setAttendancePolicy(ctx, {companyId: base.companyId, workStart: '09:00', workEnd: '17:00', breakMinutes: 0, lateAfter: '09:00', halfDayBefore: '13:00', workingDays: [1, 2, 3, 4, 5, 6, 7]});
  return {ctx, employmentId: hired.employmentId};
}
const read = (p: Awaited<ReturnType<typeof employee>>, date: string) => withTenant(p.ctx, tx => canonicalOvertimeInputTx(tx, p.ctx, {employmentId: p.employmentId, date}));

describe('canonical formula inputs consume recorded owners instead of final legacy OT/current profiles', () => {
  it('keeps measured work, normal duration and final legacy overtime distinct', async () => {
    const p = await employee(), date = todayInKualaLumpur();
    await checkIn(p.ctx, {employmentId: p.employmentId, date, time: '09:00'});
    await checkOut(p.ctx, {employmentId: p.employmentId, date, time: '19:00'});
    const snapshot = await read(p, date);
    expect(snapshot.input.facts.actualWorkingMinutes).toMatchObject({state: 'known', value: '600'});
    expect(snapshot.input.facts.requiredWorkingMinutes).toMatchObject({state: 'known', value: '480'});
    expect(snapshot.input.layer).toBe('raw');
    if (snapshot.input.layer === 'raw') expect(snapshot.input.segments[0].rawMinutes).toMatchObject({state: 'known', value: '600'});
    expect(snapshot.input.facts).not.toHaveProperty('rawMinutes');
    expect(snapshot.input.facts).not.toHaveProperty('approvedMinutes');
    expect(snapshot.input.approval).toMatchObject({status: 'notRequired', minutes: {state: 'known', value: '600'}});
    expect(snapshot.input.sessionGranularity).toBe('recorded');
    expect(snapshot.input.facts.basicSalary).toMatchObject({state: 'known', value: '3000.00', provenance: {basis: 'effectiveDated'}});
    expect(snapshot.input.facts.calculationBase).toMatchObject({state: 'known', value: '3200.00'});
    const [row] = await owner.db.select().from(attendance).where(eq(attendance.employmentId, p.employmentId));
    expect(row.otMinutes).toBe(120);
  });
  it('retains first current-day Personnel context after profile changes and repeated clocking', async () => {
    const p = await employee(), date = todayInKualaLumpur();
    await owner.db.update(employment).set({orgBranch: 'Recorded Branch'}).where(eq(employment.id, p.employmentId));
    await checkIn(p.ctx, {employmentId: p.employmentId, date, time: '09:00'});
    await owner.db.update(employment).set({orgBranch: 'Changed Later'}).where(eq(employment.id, p.employmentId));
    await checkOut(p.ctx, {employmentId: p.employmentId, date, time: '19:00'});
    const snapshot = await read(p, date);
    expect(snapshot.input.facts.orgBranch).toMatchObject({state: 'known', value: 'Recorded Branch', provenance: {basis: 'recorded', asOf: date}});
  });
  it('does not backfill yesterday with a current mutable Personnel axis', async () => {
    const p = await employee(), date = todayInKualaLumpur(new Date(Date.now() - 86400000));
    await owner.db.update(employment).set({orgDivision: 'Current Division'}).where(eq(employment.id, p.employmentId));
    await checkIn(p.ctx, {employmentId: p.employmentId, date, time: '09:00'});
    await checkOut(p.ctx, {employmentId: p.employmentId, date, time: '19:00'});
    const snapshot = await read(p, date);
    expect(snapshot.input.facts.orgDivision).toEqual({state: 'unknown', reason: 'recordedPersonnelContextUnavailable'});
    expect(snapshot.input.facts.departmentId).toMatchObject({state: 'known', value: base.deptA, provenance: {basis: 'effectiveDated'}});
  });
  it('never represents an elapsed envelope with a gap as one proven physical work session', async () => {
    const p = await employee(), date = todayInKualaLumpur();
    for (const [time, direction] of [['09:00', 'in'], ['12:00', 'out'], ['13:00', 'in'], ['19:00', 'out']] as const) {
      await (direction === 'in' ? checkIn : checkOut)(p.ctx, {employmentId: p.employmentId, date, time});
    }
    const snapshot = await read(p, date);
    expect(snapshot.input.sessionGranularity).toBe('dayAggregate');
    expect(snapshot.input.layer).toBe('raw');
    if (snapshot.input.layer === 'raw') expect(snapshot.input.segments[0].clock.state).toBe('unknown');
  });
  it('does not make an immutable input digest depend on a final OT output it may replace', async () => {
    const p = await employee(), date = todayInKualaLumpur();
    await checkIn(p.ctx, {employmentId: p.employmentId, date, time: '09:00'});
    await checkOut(p.ctx, {employmentId: p.employmentId, date, time: '19:00'});
    const before = await read(p, date);
    await owner.db.update(attendance).set({otMinutes: 0, otFlatMinutes: 0, ot00Minutes: 0, ot10Minutes: 0, ot15Minutes: 0, ot20Minutes: 0, ot30Minutes: 0}).where(eq(attendance.employmentId, p.employmentId));
    expect((await read(p, date)).input.source.inputDigest).toBe(before.input.source.inputDigest);
  });
  it('treats a marker-only historical trace as unknown inputs without throwing or changing the raw digest', async () => {
    const p = await employee(), date = todayInKualaLumpur();
    await checkIn(p.ctx, {employmentId:p.employmentId,date,time:'09:00'});
    await checkOut(p.ctx, {employmentId:p.employmentId,date,time:'19:00'});
    await owner.db.update(attendance).set({calcTrace:null}).where(eq(attendance.employmentId,p.employmentId));
    const before = await read(p,date);
    const marker = {overtimePattern:{status:'refused',reason:'sourceUnavailable'}};
    await owner.db.update(attendance).set({calcTrace:sql`${JSON.stringify(marker)}::jsonb`}).where(eq(attendance.employmentId,p.employmentId));
    const after = await read(p,date);
    expect(after.input.facts.shiftId?.state).toBe('unknown');
    expect(after.input.facts.requiredWorkingMinutes?.state).toBe('unknown');
    expect(after.input.sessionGranularity).toBe('dayAggregate');
    expect(after.input.source.inputDigest).toBe(before.input.source.inputDigest);
  });
  it('reports legacy manual rate rows for deliberate review instead of silently repricing them', async () => {
    const p = await employee(), date = todayInKualaLumpur();
    await checkIn(p.ctx, {employmentId: p.employmentId, date, time: '09:00'});
    await checkOut(p.ctx, {employmentId: p.employmentId, date, time: '19:00'});
    const [row] = await owner.db.select().from(attendance).where(eq(attendance.employmentId, p.employmentId));
    if (!row.calcTrace?.overtime) throw new Error('Fixture must have a recorded OT trace');
    const trace = structuredClone(row.calcTrace);
    trace.overtime!.rows = [{key: 'recorded-manual', fromMinutes: 0, toMinutes: null, ratePattern: 'flat', rate: 1, bucket: 'flat', calculatedMinutes: 120, effectiveMinutes: 90, manual: true}];
    await owner.db.update(attendance).set({calcTrace: trace}).where(eq(attendance.id, row.id));
    const snapshot = await read(p, date);
    expect(snapshot.input.approval.status).toBe('unknown');
    expect(snapshot.input.approval.minutes).toEqual({state: 'unknown', reason: 'legacyManualOvertimeNeedsReview'});
  });
  it('does not use today company as a fallback for missing dated company proof', async () => {
    const p = await employee(), date = todayInKualaLumpur();
    await checkIn(p.ctx, {employmentId: p.employmentId, date, time: '09:00'});
    await checkOut(p.ctx, {employmentId: p.employmentId, date, time: '19:00'});
    const schema = await import('../db/schema');
    await owner.db.update(schema.assignment).set({companyId: null}).where(eq(schema.assignment.employmentId, p.employmentId));
    await expect(read(p, date)).rejects.toMatchObject({code: 'unavailable'});
  });
});
