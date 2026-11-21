/**
 * Shared fixture for the replacement-leave sweep jobs (core/toil-sweep-worker.ts): a populated tenant built the same
 * way in every arm, and a snapshot of everything the two sweeps write with ids replaced by stable names.
 *
 * Four companies: Acme (calendar), Beta (ANNIVERSARY leave cycle), Gamma (calendar), Delta (calendar, one employee).
 * Each employee carries: a rest-day credit already past its expiry (convert-to-pay or lapse, some partly taken), a
 * public-holiday credit not yet due (carry-forward true for half), a later credit not yet due that the year-end
 * close forfeits, and, for some, a self-declared off-day credit already due, a fully used credit and an active credit
 * whose remainder is zero. A third of the employees earn at or below the First Schedule ceiling (exact statutory
 * convert-to-pay), the rest above it (ORP basis).
 */
import {randomUUID} from 'node:crypto';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {adminCtx, owner, type Base} from './harness';

export const TODAY = '2026-10-15';
export const AS_OF = '2026-12-31';
export const EMPLOYEES = 14;
const HIRED = ['2019-03-04', '2021-07-15', '2023-01-02', '2024-05-20', '2025-02-10', '2018-11-30', '2022-09-01'];
const pad = (n: number) => String(n).padStart(2, '0');

export type SweepFixture = {companies: Record<'acme' | 'beta' | 'gamma' | 'delta', string>; people: {employmentId: string; name: string; companyId: string; i: number}[]; replacementTypeId: string | null};

export async function sweepFixture(b: Base, opts: {replacementType?: boolean} = {}): Promise<SweepFixture> {
  const ctx = adminCtx(b);
  const company = async (legalName: string, leaveCycle: 'calendar' | 'anniversary') => {
    const [c] = await owner.db.insert(schema.company).values({tenantId: b.tenantId, legalName, leaveCycle}).returning({id: schema.company.id});
    const [d] = await owner.db.insert(schema.department).values({tenantId: b.tenantId, companyId: c.id, name: `${legalName} Ops`}).returning({id: schema.department.id});
    return {id: c.id, dept: d.id};
  };
  const beta = await company('Beta Anniversary Sdn Bhd', 'anniversary');
  const gamma = await company('Gamma Sdn Bhd', 'calendar');
  const delta = await company('Delta Sdn Bhd', 'calendar');
  const companies = {acme: b.companyId, beta: beta.id, gamma: gamma.id, delta: delta.id};
  const deptOf = new Map([[b.companyId, b.deptA], [beta.id, beta.dept], [gamma.id, gamma.dept], [delta.id, delta.dept]]);
  let replacementTypeId: string | null = null;
  if (opts.replacementType !== false) {
    // The customer shape (5ff7daff): coded RL, classified by role.
    const [t] = await owner.db.insert(schema.leaveType).values({tenantId: b.tenantId, code: 'RL', name: 'Replacement Leave', role: 'replacement', paid: true, counting: 'working_days'})
      .returning({id: schema.leaveType.id});
    replacementTypeId = t.id;
  }
  const people: SweepFixture['people'] = [];
  for (let i = 0; i < EMPLOYEES; i++) {
    const companyId = i === EMPLOYEES - 1 ? delta.id : [b.companyId, beta.id, gamma.id][i % 3];
    const name = `Sweep ${pad(i)}`;
    const hiredOn = HIRED[i % HIRED.length];
    const {employmentId} = await hireEmployee(ctx, {person: {fullName: name, primaryEmail: `sw_${randomUUID().slice(0, 8)}@t.local`},
      companyId, departmentId: deptOf.get(companyId)!, employmentType: 'full_time', hiredOn});
    await setCompensation(ctx, {employmentId, basicSalary: i % 3 === 0 ? 3000 : 5200 + i * 10, monthlyAllowance: i % 4 === 0 ? 250 : 0, effectiveFrom: hiredOn});
    people.push({employmentId, name, companyId, i});
  }
  const accrual = async (p: SweepFixture['people'][number], a: {workedDate: string; dayType: 'rest_day' | 'holiday' | null; workedDayKind?: 'rest_day' | 'holiday' | 'off_day' | null;
    otMinutes: number; credited: number; taken?: number; expiresOn: string; status?: 'active' | 'taken'; carry?: boolean; action: 'convert_to_pay' | 'lapse'}) => {
    let ledgerEntryId: string | null = null;
    if (replacementTypeId) {
      const [l] = await owner.db.insert(schema.leaveLedger).values({tenantId: b.tenantId, employmentId: p.employmentId, leaveTypeId: replacementTypeId, entryType: 'in_lieu_accrual',
        days: a.credited.toFixed(2), effectiveOn: a.workedDate}).returning({id: schema.leaveLedger.id});
      ledgerEntryId = l.id;
    }
    await owner.db.insert(schema.toilAccrual).values({tenantId: b.tenantId, employmentId: p.employmentId, workedDate: a.workedDate, dayType: a.dayType, workedDayKind: a.workedDayKind ?? a.dayType,
      otMinutes: a.otMinutes, daysCredited: a.credited.toFixed(2), daysTaken: (a.taken ?? 0).toFixed(2), accrualBasis: 'hours_worked', requestedOn: a.workedDate,
      expiresOn: a.expiresOn, status: a.status ?? 'active', carryForwardAtYearEnd: a.carry ?? false, expiryAction: a.action, ledgerEntryId});
  };
  for (const p of people) {
    const firstSchedule = p.i % 3 === 0;
    // Past its expiry on TODAY: settled by the expiry sweep.
    await accrual(p, {workedDate: `2026-03-${pad(p.i + 1)}`, dayType: 'rest_day', otMinutes: 480, credited: 1, taken: p.i % 5 === 1 ? 0.5 : 0, expiresOn: `2026-06-${pad(p.i + 1)}`,
      action: firstSchedule || p.i % 2 === 0 ? 'convert_to_pay' : 'lapse'});
    // Not yet due on TODAY: carried forward or forfeited by the year-end close.
    await accrual(p, {workedDate: `2026-08-${pad(p.i + 1)}`, dayType: 'holiday', otMinutes: 300 + p.i * 10, credited: 2, taken: p.i % 4 === 2 ? 1 : 0, expiresOn: `2026-12-${pad(p.i + 10)}`,
      carry: p.i % 2 === 0, action: firstSchedule ? 'convert_to_pay' : 'lapse'});
    await accrual(p, {workedDate: `2026-09-${pad(p.i + 1)}`, dayType: 'rest_day', otMinutes: 240 + p.i, credited: 0.5, expiresOn: '2027-02-01', action: firstSchedule || p.i % 3 === 1 ? 'convert_to_pay' : 'lapse'});
    // A self-declared credit (no recorded day type), due on TODAY.
    if (p.i % 4 === 3) await accrual(p, {workedDate: `2026-05-${pad(p.i + 1)}`, dayType: null, workedDayKind: 'off_day', otMinutes: 0, credited: 0.5, expiresOn: '2026-09-30', action: 'convert_to_pay'});
    // A fully used credit: never touched.
    if (p.i % 5 === 0) await accrual(p, {workedDate: `2026-02-${pad(p.i + 1)}`, dayType: 'rest_day', otMinutes: 480, credited: 1, taken: 1, expiresOn: '2026-05-01', status: 'taken', action: 'lapse'});
    // Active but nothing left: selected and locked, never debited (the executor's defensive skip).
    if (p.i === 4) await accrual(p, {workedDate: '2026-04-20', dayType: 'holiday', otMinutes: 480, credited: 1, taken: 1, expiresOn: '2026-07-20', action: 'lapse'});
  }
  return {companies, people, replacementTypeId};
}

const SWEEP_EVENTS = ['toil.converted', 'toil.lapsed', 'replacement-leave-year.closed'];
export type SweepSnapshot = {accruals: unknown[]; ledger: unknown[]; payrollInputs: unknown[]; leaveTypes: unknown[]; events: {event_type: string; aggregate_id: string; payload: Record<string, unknown>}[]};
/** Everything the sweeps write, with ids replaced by employee, company and leave type names. Events keep their order. */
export async function sweepSnapshot(b: Base): Promise<{state: SweepSnapshot; map: (v: unknown) => unknown}> {
  const names = new Map<string, string>();
  for (const r of await owner.client<{id: string; name: string}[]>`select e.id,p.full_name as name from employment e join person p on p.id=e.person_id where e.tenant_id=${b.tenantId}::uuid`) names.set(r.id, r.name);
  for (const r of await owner.client<{id: string; name: string}[]>`select id,legal_name as name from company where tenant_id=${b.tenantId}::uuid`) names.set(r.id, 'company:' + r.name);
  for (const r of await owner.client<{id: string; code: string}[]>`select id,code from leave_type where tenant_id=${b.tenantId}::uuid`) names.set(r.id, 'type:' + r.code);
  for (const r of await owner.client<{id: string; d: string}[]>`select l.id,concat_ws('|',p.full_name,t.code,l.entry_type,l.days::text,l.effective_on::text) as d
    from leave_ledger l join employment e on e.id=l.employment_id join person p on p.id=e.person_id join leave_type t on t.id=l.leave_type_id where l.tenant_id=${b.tenantId}::uuid`) names.set(r.id, 'ledger:' + r.d);
  for (const r of await owner.client<{id: string; d: string}[]>`select a.id,concat_ws('|',p.full_name,a.worked_date::text) as d from toil_accrual a join employment e on e.id=a.employment_id join person p on p.id=e.person_id where a.tenant_id=${b.tenantId}::uuid`) names.set(r.id, 'accrual:' + r.d);
  names.set(b.tenantId, 'TENANT'); names.set(b.adminUserId, 'ADMIN');
  const map = (v: unknown): unknown => {
    if (typeof v === 'string') return names.get(v) ?? v;
    if (Array.isArray(v)) return v.map(map);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, map(x)]));
    return v;
  };
  const set = (rows: unknown[]) => (map(rows) as unknown[]).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  const accruals = await owner.client`select employment_id,worked_date::text,day_type,worked_day_kind,status,days_credited::text,days_taken::text,expires_on::text,expiry_action,
    carry_forward_at_year_end,ledger_entry_id,settled_ledger_entry_id from toil_accrual where tenant_id=${b.tenantId}::uuid`;
  const ledger = await owner.client`select employment_id,leave_type_id,entry_type,days::text,effective_on::text,reason,source_request_id from leave_ledger where tenant_id=${b.tenantId}::uuid`;
  const payrollInputs = await owner.client`select employment_id,overtime_amount::text,bonus_amount::text from payroll_input where tenant_id=${b.tenantId}::uuid`;
  const leaveTypes = await owner.client`select code,name,role,paid,counting,archived_at is null as live from leave_type where tenant_id=${b.tenantId}::uuid`;
  const events = await owner.client`select event_type,aggregate_type,aggregate_id,actor_type,actor_id,subject_employment_id,payload from domain_event
    where tenant_id=${b.tenantId}::uuid and event_type=any(${SWEEP_EVENTS}) order by occurred_at,sequence`;
  return {
    // Events as a multiset here: their order follows the employment and accrual ids, which differ between two
    // databases; `sweepEventOrder` checks the order within one database.
    state: {accruals: set([...accruals]), ledger: set([...ledger]), payrollInputs: set([...payrollInputs]), leaveTypes: set([...leaveTypes]),
      events: set([...events].map(e => ({...e}))) as SweepSnapshot['events']},
    map,
  };
}

/**
 * The order the sweeps appended their events in, against the order the synchronous sweeps append them: each run's
 * per-credit events in (employment id, accrual id) order, the expiry run's first, then the close's, then the close's
 * markers in company id order. `expiryAsOf` tells the two runs' credit events apart.
 */
export async function sweepEventOrder(b: Base, expiryAsOf: string) {
  const rows = await owner.client<{id: string; event_type: string; aggregate_id: string; subject: string | null; as_of: string | null}[]>`select id,event_type,aggregate_id,
    subject_employment_id as subject,payload->>'asOf' as as_of from domain_event where tenant_id=${b.tenantId}::uuid and event_type=any(${SWEEP_EVENTS}) order by occurred_at,sequence`;
  const phase = (r: typeof rows[number]) => r.event_type === 'replacement-leave-year.closed' ? 2 : r.as_of === expiryAsOf ? 0 : 1;
  const key = (r: typeof rows[number]) => `${phase(r)}|${r.subject ?? ''}|${r.aggregate_id}`;
  return {actual: rows.map(r => r.id), expected: [...rows].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0)).map(r => r.id)};
}
