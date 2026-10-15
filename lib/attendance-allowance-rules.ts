/** Client-safe policy vocabulary and deterministic fixed-amount engine. No database or executable formula. */
import { addDaysIso, datesBetween, isMonthParam, monthRange, weekRangeOf } from './roster-month';
import { ALLOWANCE_METHODS_V2, ALLOWANCE_EMPLOYEE_FIELDS, ALLOWANCE_METRICS, ALLOWANCE_OPERATORS, ALLOWANCE_DAY_KINDS, type AllowancePeriodMethod, type AllowancePolicyType, type AllowanceEmployeeField, type AllowanceMetric, type AllowanceOperator, type AllowanceDayKind } from './attendance-allowance-vocabulary';
export * from './attendance-allowance-vocabulary';
import { validateAllowanceExpression, evaluateAllowanceExpression, type AllowanceExpression, type AllowanceExpressionTrace } from './attendance-allowance-expression';
import type { RecordedAllowanceAttendanceFacts } from '../packs/attendance/service';
export type AllowanceAttendanceCriterion = { field: AllowanceMetric; operator: AllowanceOperator; value: string; upper?: string; unit: 'minutes' | 'hours' | 'days' };
export type AllowanceEmployeeCriterion = { field: AllowanceEmployeeField; operator: 'in' | 'notIn'; values: string[] };
export type AllowanceRulesV2 = {
  v: 2;
  employee: { mode: 'all' | 'selected' | 'criteria'; employmentIds: string[]; logic: 'and' | 'or'; criteria: AllowanceEmployeeCriterion[] };
  attendance: { dayKinds: AllowanceDayKind[]; shiftIds: string[]; logic: 'and' | 'or'; criteria: AllowanceAttendanceCriterion[] };
};
export type AllowanceRulesV3 = Omit<AllowanceRulesV2,'v'|'attendance'> & { v:3; attendance:AllowanceRulesV2['attendance'] & {expression:AllowanceExpression} };
export type AllowanceRules = AllowanceRulesV2 | AllowanceRulesV3;
export const emptyAllowanceRules = (): AllowanceRulesV2 => ({ v: 2, employee: { mode: 'all', employmentIds: [], logic: 'and', criteria: [] }, attendance: { dayKinds: [], shiftIds: [], logic: 'and', criteria: [] } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bag = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Incomplete allowance conditions');
  return v as Record<string, unknown>;
};
const list = (v: unknown, max = 100): unknown[] => {
  if (!Array.isArray(v) || v.length > max) throw new Error('Invalid or excessive allowance conditions');
  return v;
};
const ids = (v: unknown) => [...new Set(list(v, 2000).map(x => { if (typeof x !== 'string' || !UUID.test(x)) throw new Error('Invalid selection'); return x; }))];
const logic = (v: unknown): 'and' | 'or' => { if (v !== 'and' && v !== 'or') throw new Error('Choose AND or OR'); return v; };
/** Strict cents: never Number(value).toFixed(), exponent parsing, floating multiplication or silent rounding. */
export function allowanceCents(value: string | number): bigint {
  const text = String(value).trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) throw new Error('Amount must be non-negative with at most two decimal places');
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt('999999999999')) throw new Error('Allowance amount is too large');
  return cents;
}
export function allowanceMoney(cents: bigint): string {
  if (cents < BigInt(0) || cents > BigInt('999999999999')) throw new Error('Allowance total is outside the supported amount range');
  return `${cents / BigInt(100)}.${String(cents % BigInt(100)).padStart(2, '0')}`;
}
/** Hundredths of minutes/days; hours convert exactly to minute-hundredths. */
function threshold(value: unknown, unit: AllowanceAttendanceCriterion['unit']): bigint {
  if (typeof value !== 'string' || !/^\d{1,8}(?:\.\d{1,2})?$/.test(value)) throw new Error('Threshold must have at most two decimal places');
  const [whole, fraction = ''] = value.split('.');
  const fixed = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));
  return unit === 'hours' ? fixed * BigInt(60) : fixed;
}
function validateAllowanceRulesV2(raw: unknown): AllowanceRulesV2 {
  const r = bag(raw), e = bag(r.employee), a = bag(r.attendance);
  if (r.v !== 2 || !['all', 'selected', 'criteria'].includes(String(e.mode))) throw new Error('Unknown allowance rules version or employee selection');
  const employmentIds = e.mode === 'selected' ? ids(e.employmentIds) : [];
  const employeeCriteria = e.mode === 'criteria' ? list(e.criteria, 30).map(rawCriterion => {
    const c = bag(rawCriterion);
    if (!ALLOWANCE_EMPLOYEE_FIELDS.includes(c.field as AllowanceEmployeeField) || !['in', 'notIn'].includes(String(c.operator))) throw new Error('Unsupported employee condition');
    const values = [...new Set(list(c.values, 2000).map(x => {
      if (typeof x !== 'string' || !x.trim() || x.length > 150) throw new Error('Choose employee condition values');
      return x.trim();
    }))];
    if (!values.length) throw new Error('Employee condition requires values');
    if (String(c.field).endsWith('Id') && values.some(x => !UUID.test(x))) throw new Error('Invalid employee condition reference');
    if (c.field === 'status' && values.some(x => !['active', 'terminated'].includes(x))) throw new Error('Unknown employee status');
    if (c.field === 'employmentType' && values.some(x => !['full_time', 'part_time', 'contract', 'intern'].includes(x))) throw new Error('Unknown employment type');
    return { field: c.field as AllowanceEmployeeField, operator: c.operator as 'in' | 'notIn', values };
  }) : [];
  if (e.mode === 'selected' && !employmentIds.length) throw new Error('Select at least one employee');
  if (e.mode === 'criteria' && !employeeCriteria.length) throw new Error('Add at least one employee condition');
  const dayKinds = [...new Set(list(a.dayKinds, 5).map(x => {
    if (!ALLOWANCE_DAY_KINDS.includes(x as AllowanceDayKind)) throw new Error('Unknown attendance day type');
    return x as AllowanceDayKind;
  }))];
  const attendanceCriteria = list(a.criteria, 30).map(rawCriterion => {
    const c = bag(rawCriterion);
    if (!ALLOWANCE_METRICS.includes(c.field as AllowanceMetric) || !ALLOWANCE_OPERATORS.includes(c.operator as AllowanceOperator)) throw new Error('Unsupported attendance condition');
    const time = String(c.field).endsWith('Minutes');
    if (time ? !['hours', 'minutes'].includes(String(c.unit)) : c.unit !== 'days') throw new Error('Condition unit does not match its field');
    const low = threshold(c.value, c.unit as AllowanceAttendanceCriterion['unit']);
    if (c.operator === 'between' && (threshold(c.upper, c.unit as AllowanceAttendanceCriterion['unit']) < low)) throw new Error('Between requires an upper threshold at or above the lower threshold');
    return { field: c.field as AllowanceMetric, operator: c.operator as AllowanceOperator, value: c.value as string, ...(c.operator === 'between' ? { upper: c.upper as string } : {}), unit: c.unit as AllowanceAttendanceCriterion['unit'] };
  });
  return { v: 2, employee: { mode: e.mode as AllowanceRules['employee']['mode'], employmentIds, logic: logic(e.logic), criteria: employeeCriteria }, attendance: { dayKinds, shiftIds: ids(a.shiftIds), logic: logic(a.logic), criteria: attendanceCriteria } };
}
export function validateAllowanceRules(raw:unknown):AllowanceRules {
  const r=bag(raw);
  if(r.v!==3)return validateAllowanceRulesV2(raw);
  const a=bag(r.attendance);
  if(!Array.isArray(a.criteria)||a.criteria.length||a.logic!=='and')throw new Error('Version 3 attendance conditions must use their expression tree.');
  const base=validateAllowanceRulesV2({...r,v:2,attendance:{...a,criteria:[],logic:'and'}});
  return {...base,v:3,attendance:{...base.attendance,expression:validateAllowanceExpression(a.expression)}};
}
export const emptyAllowanceRulesV3=():AllowanceRulesV3=>{const base=emptyAllowanceRules();return {...base,v:3,attendance:{...base.attendance,expression:{id:'root',type:'group',logic:'and',children:[]}}};};
/** Conversion is explicit and produces a new policy definition; old snapshots keep their version. */
export function upgradeAllowanceRules(rules:AllowanceRulesV2):AllowanceRulesV3 {
 return {...rules,v:3,attendance:{...rules.attendance,criteria:[],logic:'and',expression:{id:'root',type:'group',logic:rules.attendance.logic,children:rules.attendance.criteria.map((c,i)=>({...c,id:'criterion-'+i,type:'criterion'}))}}};
}

export type AllowancePeriod = { from: string; to: string; key: string };
export function allowancePeriods(method: AllowancePeriodMethod, month: string): AllowancePeriod[] {
  if (!isMonthParam(month)) throw new Error('Invalid allowance month');
  const { from, to } = monthRange(month);
  if (method === 'monthly') return [{ from, to, key: month }];
  if (method === 'daily') return datesBetween(from, to).map(date => ({ from: date, to: date, key: date }));
  if (method !== 'weekly') throw new Error('Unknown allowance calculation method');
  const periods: AllowancePeriod[] = [];
  // Each Sunday in the owning month identifies exactly one Monday–Sunday period, including the prior month.
  for (let sunday = weekRangeOf(from).to; sunday <= to; sunday = addDaysIso(sunday, 7)) {
    const week = weekRangeOf(sunday);
    periods.push({ ...week, key: `${week.from}/${week.to}` });
  }
  return periods;
}
export type AllowanceEmployeeFacts = Record<AllowanceEmployeeField, string | null>;
export function allowanceEmployeeMatches(rule: AllowanceRules['employee'], employmentId: string, facts: AllowanceEmployeeFacts): boolean {
  if (rule.mode === 'all') return true;
  if (rule.mode === 'selected') return rule.employmentIds.includes(employmentId);
  const tests = rule.criteria.map(c => {
    const actual = facts[c.field];
    // Missing data is never a positive match, including NOT IN; it must be corrected on Personnel first.
    return actual != null && (c.operator === 'in' ? c.values.includes(actual) : !c.values.includes(actual));
  });
  return rule.logic === 'and' ? tests.every(Boolean) : tests.some(Boolean);
}
export type AllowanceDay = {
  date: string; attendanceId: string | null; kind: AllowanceDayKind; shiftId: string | null;
  workingMinutes: number | null; actualMinutes: number | null; overtimeMinutes: number | null;
  lateMinutes: number | null; earlyOutMinutes: number | null;
  absentDays: number; attendanceDays: number; eligibleWorkingDays: number;
  complete: boolean;
  v3Facts?: {shortMinutes:number|null;incomplete:boolean;fixedClockApplicable:boolean|null;attendanceEvidence?:RecordedAllowanceAttendanceFacts;absenceKnown?:boolean;leave:{typeId:string;paid:boolean|null;days:number;requestIds:string[]}[]|null;leaveTypesPresent:string[];leaveUnknownTypeIds?:string[];source:string};
  factSources?: { measurements: 'recorded-attendance' | 'canonical-scheduled-absence'; recordedDayType: string | null; dayAndShift: 'canonical-schedule-at-calculation'; canonicalKind: AllowanceDayKind };
};
export type AllowanceMetricTrace = { field: AllowanceMetric; actual: number | null; pass: boolean; operator: AllowanceOperator; value: string; upper?: string; unit: AllowanceAttendanceCriterion['unit'] };
export type AllowancePeriodEvaluation = AllowancePeriod & { qualified: boolean; amount: string; eligibleDates: string[]; attendanceIds: string[]; metrics: Record<AllowanceMetric, number | null>; criteria: AllowanceMetricTrace[]; reasons: string[]; sourceDays: AllowanceDay[]; expression?:AllowanceExpressionTrace; ruleVersion?:3; employeeSelection?: { asOf:string|null; facts:AllowanceEmployeeFacts|null; pass:boolean; factSources:Record<AllowanceEmployeeField,string> } };
export function evaluateAllowancePeriods(p: { method: AllowancePeriodMethod; month: string; amount: string; effectiveFrom: string; today: string; rules: AllowanceRules; days: AllowanceDay[] }): AllowancePeriodEvaluation[] {
  const amount = allowanceCents(p.amount);
  return allowancePeriods(p.method, p.month).map(period => {
    if(p.rules.v===3)return evaluateAllowancePeriodV3(p as typeof p & {rules:AllowanceRulesV3},period,amount);
    const days = p.days.filter(d => d.date >= period.from && d.date <= period.to && d.date >= p.effectiveFrom && d.date <= p.today && (d.attendanceId!=null||d.absentDays>0) && (!p.rules.attendance.dayKinds.length || p.rules.attendance.dayKinds.includes(d.kind)) && (!p.rules.attendance.shiftIds.length || (d.shiftId != null && p.rules.attendance.shiftIds.includes(d.shiftId))));
    const metrics = Object.fromEntries(ALLOWANCE_METRICS.map(field => {
      const vals = days.map(d => d[field]);
      return [field, vals.some(x => x == null) ? null : vals.reduce<number>((sum, x) => sum + (x ?? 0), 0)];
    })) as Record<AllowanceMetric, number | null>;
    const criteria = p.rules.attendance.criteria.map(c => {
      const actual = metrics[c.field];
      const fixed = actual == null ? null : BigInt(Math.round(actual * 100));
      const low = threshold(c.value, c.unit), high = c.operator === 'between' ? threshold(c.upper, c.unit) : low;
      const pass = fixed != null && (c.operator === 'eq' ? fixed === low : c.operator === 'ne' ? fixed !== low : c.operator === 'gt' ? fixed > low : c.operator === 'gte' ? fixed >= low : c.operator === 'lt' ? fixed < low : c.operator === 'lte' ? fixed <= low : fixed >= low && fixed <= high);
      return { ...c, actual, pass };
    });
    const reasons: string[] = [];
    if (period.to > p.today) reasons.push('unfinishedPeriod');
    if (period.from < p.effectiveFrom) reasons.push('beforeEffective'); // fixed amount is never prorated for a partial period
    if (!days.length) reasons.push('noApplicableDays');
    if (days.some(d => !d.complete)) reasons.push('incompleteAttendance');
    if (!(p.rules.attendance.logic === 'and' ? criteria.every(c => c.pass) : criteria.length === 0 || criteria.some(c => c.pass))) reasons.push('criteriaFailed');
    const qualified = reasons.length === 0;
    return { ...period, qualified, amount: allowanceMoney(qualified ? amount : BigInt(0)), eligibleDates: days.map(d => d.date), attendanceIds: days.flatMap(d => d.attendanceId ? [d.attendanceId] : []), metrics, criteria, reasons, sourceDays:days };
  });
}

function evaluateAllowancePeriodV3(p:{effectiveFrom:string;today:string;rules:AllowanceRulesV3;days:AllowanceDay[]},period:AllowancePeriod,amount:bigint):AllowancePeriodEvaluation {
 const byDate=new Map<string,AllowanceDay>();
 for(const day of p.days){if(byDate.has(day.date))throw new Error('Duplicate canonical allowance date');byDate.set(day.date,day);}
 const days=[...byDate.values()].filter(d=>d.date>=period.from&&d.date<=period.to&&d.date>=p.effectiveFrom&&d.date<=p.today&&(d.attendanceId!=null||d.absentDays>0||((d.v3Facts?.leaveTypesPresent.length??0)>0)||((d.v3Facts?.leaveUnknownTypeIds?.length??0)>0))&&(!p.rules.attendance.dayKinds.length||p.rules.attendance.dayKinds.includes(d.kind))&&(!p.rules.attendance.shiftIds.length||d.shiftId!=null&&p.rules.attendance.shiftIds.includes(d.shiftId))).sort((a,b)=>a.date.localeCompare(b.date));
 const expression=evaluateAllowanceExpression(p.rules.attendance.expression,days);
 const reasons:string[]=[];
 if(period.to>p.today)reasons.push('unfinishedPeriod');
 if(period.from<p.effectiveFrom)reasons.push('beforeEffective');
 if(!days.length)reasons.push('noApplicableDays');
 if(expression.state!=='true')reasons.push(expression.state==='unknown'?'unknownMeasurements':'criteriaFailed');
 const qualified=!reasons.length;
 const metrics=Object.fromEntries(ALLOWANCE_METRICS.map(field=>{const values=days.map(d=>d[field]);return [field,values.some(v=>v==null)?null:values.reduce<number>((a,v)=>a+(v??0),0)];})) as Record<AllowanceMetric,number|null>;
 return {...period,qualified,amount:allowanceMoney(qualified?amount:BigInt(0)),eligibleDates:days.map(d=>d.date),attendanceIds:days.flatMap(d=>d.attendanceId?[d.attendanceId]:[]),metrics,criteria:[],reasons,sourceDays:days,expression,ruleVersion:3};
}
