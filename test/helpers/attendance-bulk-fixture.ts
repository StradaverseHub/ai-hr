/**
 * A populated, fully deterministic attendance fixture for the clocking-import and Recompute Attendance job
 * equivalence suites (draft 9940): many employees over three weeks on rotating day / early / night (cross-
 * midnight) shifts with Sunday rest days, a public holiday, Clock-screen and offline (mobile_offline) clockings,
 * a legacy day row with no punches, an approved attendance correction, a terminated employee, a PROCESSED pay run
 * (needs-recalculation marks) and a CLOSED one (refused days), cards / codes / IC references, and files with
 * duplicates, unreadable, unmatched and future lines.
 *
 * Building it twice gives two tenants that differ only in generated ids, so the synchronous path runs on one and
 * the background job on the other, and `attendanceSnapshot` compares their end states with every id replaced by a
 * stable label (employee code, date, time) and every timestamp by a marker.
 */
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema';
import type { SessionContext } from '../../db/client';
import { adminCtx, owner, type Base } from '../harness';
import { hireEmployee } from '../../core/org';
import { createShift } from '../../core/roster';
import { setCompensation } from '../../core/comp';
import { createBatch, generatePayslips } from '../../core/payroll';
import { checkIn, checkInTx, checkOut, checkOutTx } from '../../core/attendance';
import { createClockingMapping, type ClockingMappingInput } from '../../core/attendance-clocking-import';

export const FIXTURE_FROM = '2026-09-07'; // a Monday
export const FIXTURE_DAYS = 21;
export const FIXTURE_HOLIDAY = '2026-09-16';
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const fixtureDate = (i: number) => addDays(FIXTURE_FROM, i);
const hm = (minutes: number) => `${String(Math.floor(((minutes % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((minutes % 60) + 60) % 60).padStart(2, '0')}`;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export const CODED_MAPPING: ClockingMappingInput = {
  name: 'Fixture coded CSV', description: '', deviceName: 'Fixture', fileType: 'csv', layout: 'delimited', delimiter: ',',
  hasHeader: false, encoding: 'utf-8', active: true,
  fields: { cardId: { column: 1 }, day: { column: 2 }, month: { column: 3 }, year: { column: 4 }, hours: { column: 5 }, minute: { column: 6 }, inOutCode: { column: 7 } },
  inOutCodes: [{ code: 'IN', direction: 'in' }, { code: 'OUT', direction: 'out' }],
  sampleLines: ['C000,07,09,2026,08,55,IN'], sampleFileName: 'fixture.csv',
};
const codedLine = (ref: string, date: string, time: string, code: 'IN' | 'OUT') => {
  const [y, m, d] = date.split('-');
  return [ref, d, m, y, time.slice(0, 2), time.slice(3, 5), code].join(',');
};

export type AttendanceFixture = {
  ctx: SessionContext;
  employees: Map<string, string>; // code -> employment id
  shifts: Record<'DAY' | 'EARLY' | 'NIGHT', string>;
  codedMappingId: string;
  /** Weeks 1-2, uncoded (built-in template: staff,time). */
  uncodedFile: string;
  /** Week 3 plus the last two days of week 2 again, with IN/OUT codes (CODED_MAPPING). */
  codedFile: string;
  processedBatchId: string;
};

/** An accepted offline clocking, as the canonical offline writer leaves it: a capture holding the effective
 *  instant (received an hour later) and its mobile_offline punch. */
async function offlineClock(ctx: SessionContext, employmentId: string, date: string, time: string, direction: 'in' | 'out') {
  const id = randomUUID(), at = new Date(`${date}T${time}+08:00`);
  await owner.client`insert into attendance_clock_capture(id,tenant_id,employment_id,attendance_date,direction,request_id,server_recorded_at,command_digest,effective_at)
    values(${id}::uuid,${ctx.tenantId}::uuid,${employmentId}::uuid,${date}::date,${direction},${randomUUID()}::uuid,${new Date(at.getTime() + 3_600_000).toISOString()}::timestamptz,
     ${createHash('sha256').update(`fixture:${employmentId}:${date}:${time}`).digest('hex')},${at.toISOString()}::timestamptz)`;
  await (direction === 'in' ? checkInTx : checkOutTx)(ctx, { employmentId, date, time, clockCaptureId: id, preciseOrder: true, method: 'mobile_offline', deviceGateExempt: true });
}

/** Build the fixture in the tenant `b` just seeded. Deterministic: no randomness reaches what is compared. */
export async function buildAttendanceFixture(b: Base, opts: { employees?: number } = {}): Promise<AttendanceFixture> {
  const ctx = adminCtx(b);
  const count = Math.max(8, opts.employees ?? 24);
  const shifts = {
    DAY: (await createShift(ctx, { name: 'Fixture day', code: 'FXDAY', startTime: '09:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] })).id,
    EARLY: (await createShift(ctx, { name: 'Fixture early', code: 'FXEARLY', startTime: '07:00', endTime: '16:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] })).id,
    NIGHT: (await createShift(ctx, { name: 'Fixture night', code: 'FXNIGHT', startTime: '22:00', endTime: '06:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] })).id,
  };
  const rotation: ('DAY' | 'EARLY' | 'NIGHT')[] = ['DAY', 'EARLY', 'NIGHT'];
  await owner.db.insert(schema.holiday).values({ tenantId: b.tenantId, country: 'MY', holidayDate: FIXTURE_HOLIDAY, name: 'Fixture holiday' });

  const employees = new Map<string, string>();
  const refOf = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const code = `E${String(i).padStart(3, '0')}`;
    const hired = await hireEmployee(ctx, {
      person: { fullName: `Fixture ${code}`, primaryEmail: `fixture_${code.toLowerCase()}_${randomUUID()}@fixture.invalid` },
      companyId: b.companyId, departmentId: i % 2 ? b.deptA : b.deptB, employmentType: 'full_time', hiredOn: '2020-01-01', employeeCode: code,
    });
    employees.set(code, hired.employmentId);
    if (i % 3 === 0) {
      await owner.db.update(schema.employment).set({ cardId: `C${String(i).padStart(3, '0')}` }).where(eq(schema.employment.id, hired.employmentId));
      refOf.set(code, `C${String(i).padStart(3, '0')}`);
    } else if (i % 3 === 2) {
      const [e] = await owner.db.select({ personId: schema.employment.personId }).from(schema.employment).where(eq(schema.employment.id, hired.employmentId));
      const ic = `900101${String(1000000 + i).slice(1)}`;
      await owner.db.insert(schema.employeeStatutoryMy).values({ tenantId: b.tenantId, personId: e.personId, icNumber: ic });
      refOf.set(code, `${ic.slice(0, 6)}-${ic.slice(6, 8)}-${ic.slice(8)}`);
    } else refOf.set(code, code);
    // Rotation: the shift moves on every week; Sunday is a rostered rest day for every second employee.
    const roster = Array.from({ length: FIXTURE_DAYS + 1 }, (_, d) => {
      const date = fixtureDate(d);
      const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
      return sunday && i % 2 === 0
        ? { tenantId: b.tenantId, employmentId: hired.employmentId, shiftDate: date, isRestDay: true }
        : { tenantId: b.tenantId, employmentId: hired.employmentId, shiftDate: date, shiftId: shifts[rotation[(i + Math.floor(d / 7)) % 3]], isRestDay: false };
    });
    await owner.db.insert(schema.rosterAssignment).values(roster);
  }
  // A terminated employee: clockings before the end are matched, after it "not employed on the date".
  const leaver = await hireEmployee(ctx, {
    person: { fullName: 'Fixture leaver', primaryEmail: `fixture_leaver_${randomUUID()}@fixture.invalid` },
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2020-01-01', employeeCode: 'T900',
  });
  await owner.db.update(schema.employment).set({ terminatedOn: '2026-09-15' }).where(eq(schema.employment.id, leaver.employmentId));
  employees.set('T900', leaver.employmentId);

  // Pay runs: August CLOSED (its days are refused), September PROCESSED (its changed days raise the mark).
  // Everyone is paid (a run refuses employees it cannot pay), so every employee's days are owned by both runs.
  for (const id of employees.values()) await setCompensation(ctx, { employmentId: id, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2020-01-01' });
  const august = await createBatch(ctx, { companyId: b.companyId, payPeriod: '2026-08' });
  await generatePayslips(ctx, { batchId: august.batchId });
  await owner.db.update(schema.payrollBatch).set({ status: 'closed' }).where(eq(schema.payrollBatch.id, august.batchId));
  const september = await createBatch(ctx, { companyId: b.companyId, payPeriod: '2026-09' });
  await generatePayslips(ctx, { batchId: september.batchId });

  // What is already on the books before any file: Clock-screen clockings, offline clockings, a legacy day row
  // with no punch children, and a day corrected through an approved request.
  await checkIn(ctx, { employmentId: employees.get('E004')!, date: fixtureDate(1), time: '08:52:00' });
  await checkOut(ctx, { employmentId: employees.get('E004')!, date: fixtureDate(1), time: '12:01:00' });
  await offlineClock(ctx, employees.get('E005')!, fixtureDate(2), '06:58:00', 'in');
  await offlineClock(ctx, employees.get('E005')!, fixtureDate(2), '16:03:00', 'out');
  await owner.db.insert(schema.attendance).values({ tenantId: b.tenantId, employmentId: employees.get('E007')!, attendanceDate: fixtureDate(4), checkInAt: '21:58:00', checkOutAt: null, status: 'present', checkInMethod: 'web' });
  await owner.db.insert(schema.attendance).values({ tenantId: b.tenantId, employmentId: employees.get('E006')!, attendanceDate: fixtureDate(3), checkInAt: '09:00:00', checkOutAt: '18:00:00', status: 'present', dayType: 'workday' });
  await owner.db.insert(schema.attendanceCorrection).values({ tenantId: b.tenantId, employmentId: employees.get('E006')!, attendanceDate: fixtureDate(3),
    proposedCheckIn: '09:00:00', proposedCheckOut: '18:00:00', reason: 'Fixture correction', status: 'approved', decidedAt: new Date('2026-09-10T10:00:00Z') });

  const codedMappingId = await createClockingMapping(ctx, CODED_MAPPING);

  // The files. Times move with the employee and the day so lateness, early-out, overtime and open days all occur.
  const uncoded: string[] = ['staff,time'];
  const coded: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = `E${String(i).padStart(3, '0')}`;
    for (let d = 0; d < FIXTURE_DAYS; d++) {
      const date = fixtureDate(d);
      const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
      if (sunday && i % 2 === 0 && !(i % 7 === 0 && d === 6)) continue; // rest day (one employee works it)
      if (date === FIXTURE_HOLIDAY && i % 4 !== 0) continue; // most stay home on the holiday
      if ((i * 3 + d) % 11 === 0) continue; // an absence
      const shift = rotation[(i + Math.floor(d / 7)) % 3];
      const start = { DAY: '09:00', EARLY: '07:00', NIGHT: '22:00' }[shift], end = { DAY: '18:00', EARLY: '16:00', NIGHT: '06:00' }[shift];
      const inAt = hm(toMin(start) + ((i * 7 + d * 3) % 41) - 15);
      const outMin = toMin(end) + ((i * 5 + d * 11) % 151) - 30;
      const outDate = shift === 'NIGHT' ? fixtureDate(d + 1) : date;
      const punches: [string, string, 'IN' | 'OUT'][] = [[date, inAt, 'IN']];
      if (i % 5 === 1 && shift !== 'NIGHT') punches.push([date, hm(toMin(start) + 210), 'OUT'], [date, hm(toMin(start) + 270), 'IN']);
      if ((i + d) % 17 !== 0) punches.push([outDate, hm(outMin), 'OUT']); // otherwise the day stays open
      const ref = refOf.get(code)!;
      for (const [day, time, dir] of punches) {
        if (d < 14) uncoded.push(`${ref},${day} ${time}`);
        if (d >= 12 && !(d < 14 && dir === 'IN' && i % 2)) coded.push(codedLine(ref, day, time, dir)); // overlap: duplicates
      }
    }
  }
  uncoded.push(uncoded[2], 'ZZZ999,2026-09-08 09:00', 'E002,2026-09-31 08:00', 'E002,2026-12-01 08:00', 'E003,2026-08-20 08:00', 'E003,2026-08-20 17:00',
    'T900,2026-09-14 09:01', 'T900,2026-09-14 18:02', 'T900,2026-09-21 09:00', 'E004,' + fixtureDate(1) + ' 13:00', 'E005,' + fixtureDate(2) + ' 16:30',
    'E006,' + fixtureDate(3) + ' 09:05', 'E007,' + fixtureDate(4) + ' 21:58', 'E007,' + fixtureDate(5) + ' 06:04');
  coded.push(codedLine('ZZZ998', fixtureDate(15), '09:00', 'IN'), 'C000,32,09,2026,08,00,IN');
  return { ctx, employees, shifts, codedMappingId, uncodedFile: uncoded.join('\n'), codedFile: coded.join('\n'), processedBatchId: september.batchId };
}

/** Tables an attendance write can touch, compared whole (the fixture rows are identical in both tenants). */
const TABLES = [
  'attendance', 'attendance_punch', 'attendance_correction', 'clocking_import_run', 'clocking_import_line', 'payroll_batch',
  'toil_accrual', 'leave_ledger', 'attendance_overtime_source', 'attendance_overtime_calculation', 'attendance_attention_review', 'domain_event',
] as const;
/** Columns that are identity, ordering or chain bookkeeping rather than an outcome. */
const DROP = new Set(['id', 'tenant_id', 'chain_seq', 'prev_hash', 'hash', 'sequence', 'import_pending_attempt_id', 'workos_org_id']);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** A recompute run event lists its days in (date, employment id) order; ids differ between the two tenants, so
 *  the two lists are compared in (date, employee code) order (the job's own order is asserted by the suite). */
function dayListsByCode(row: unknown): unknown {
  const r = row as { event_type?: string; payload?: { rows?: { date: string; employeeCode: string | null }[]; flags?: { date: string; employeeCode: string | null }[] } };
  if (r?.event_type !== 'attendance-recompute.run' || !r.payload) return row;
  const byCode = (a: { date: string; employeeCode: string | null }, b: { date: string; employeeCode: string | null }) => a.date.localeCompare(b.date) || String(a.employeeCode).localeCompare(String(b.employeeCode));
  return { ...r, payload: { ...r.payload, rows: [...(r.payload.rows ?? [])].sort(byCode), flags: [...(r.payload.flags ?? [])].sort(byCode) } };
}

/** Every row of TABLES in the tenant as sorted, normalized JSON strings: ids → labels, timestamps → 'TS'. */
export async function attendanceSnapshot(tenantId: string): Promise<Record<string, string[]>> {
  const labels = new Map<string, string>();
  const put = (id: string | null, label: string) => { if (id) labels.set(String(id).toLowerCase(), label); };
  put(tenantId, 'TENANT');
  for (const r of await owner.client<{ id: string; code: string; person_id: string; company_id: string }[]>`select id,employee_code as code,person_id,company_id from employment where tenant_id=${tenantId}::uuid`) {
    put(r.id, `E:${r.code}`); put(r.person_id, `PERSON:${r.code}`); put(r.company_id, 'COMPANY');
  }
  for (const r of await owner.client<{ id: string; name: string }[]>`select id,name from department where tenant_id=${tenantId}::uuid`) put(r.id, `DEPT:${r.name}`);
  for (const r of await owner.client<{ id: string; code: string }[]>`select id,code from shift where tenant_id=${tenantId}::uuid`) put(r.id, `SHIFT:${r.code}`);
  for (const r of await owner.client<{ id: string }[]>`select id from app_user where tenant_id=${tenantId}::uuid`) put(r.id, 'USER');
  for (const r of await owner.client<{ id: string; period: string }[]>`select id,pay_period as period from payroll_batch where tenant_id=${tenantId}::uuid`) put(r.id, `BATCH:${r.period}`);
  for (const r of await owner.client<{ id: string; label: string }[]>`select a.id,e.employee_code||':'||a.attendance_date as label from attendance a join employment e on e.id=a.employment_id where a.tenant_id=${tenantId}::uuid`) put(r.id, `DAY:${r.label}`);
  for (const r of await owner.client<{ id: string; label: string }[]>`select p.id,e.employee_code||':'||p.attendance_date||':'||p.punch_at||':'||p.direction||':'||p.method as label from attendance_punch p join employment e on e.id=p.employment_id where p.tenant_id=${tenantId}::uuid`) put(r.id, `PUNCH:${r.label}`);
  for (const r of await owner.client<{ id: string; label: string }[]>`select c.id,e.employee_code||':'||c.attendance_date as label from attendance_correction c join employment e on e.id=c.employment_id where c.tenant_id=${tenantId}::uuid`) put(r.id, `CORRECTION:${r.label}`);
  for (const r of await owner.client<{ id: string; n: number; file: string }[]>`select id,file_name as file,(row_number() over (order by created_at,id))::int as n from clocking_import_run where tenant_id=${tenantId}::uuid`) put(r.id, `RUN:${r.n}:${r.file}`);
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (TIMESTAMP.test(value)) return 'TS';
      if (/^[0-9a-f]{64}$/.test(value)) return 'HASH'; // content hashes over ids (the fixture's payroll audit)
      return value.replace(UUID, (m) => labels.get(m.toLowerCase()) ?? 'UUID');
    }
    if (Array.isArray(value)) {
      const items = value.map(normalize);
      // A set of employments (pay-run marks) is ordered by id, and ids differ between the two tenants.
      return items.length && items.every((x) => typeof x === 'string' && x.startsWith('E:')) ? [...(items as string[])].sort() : items;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) if (!DROP.has(k)) out[k] = normalize((value as Record<string, unknown>)[k]);
      return out;
    }
    return value;
  };
  const out: Record<string, string[]> = {};
  for (const table of TABLES) {
    const rows = await owner.client.unsafe<{ r: unknown }[]>(
      table === 'domain_event'
        ? `select to_jsonb(t) as r from ${table} t where tenant_id=$1::uuid and aggregate_type<>'bulk-job'`
        : `select to_jsonb(t) as r from ${table} t where tenant_id=$1::uuid`,
      [tenantId],
    );
    out[table] = rows.map((row) => JSON.stringify(normalize(dayListsByCode(row.r)))).sort();
  }
  return out;
}

/** A job outcome or result with its ids replaced by the same labels (run ids by position). */
export function normalizeIds(value: unknown, labels: Record<string, string>): unknown {
  const sortSets = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const items = v.map(sortSets);
      return items.length && items.every((x) => typeof x === 'string' && x.startsWith('E:')) ? [...(items as string[])].sort() : items;
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sortSets(x)]));
    return v;
  };
  return sortSets(JSON.parse(JSON.stringify(value).replace(UUID, (m) => labels[m.toLowerCase()] ?? 'UUID')));
}
