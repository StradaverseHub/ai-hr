import { describe,expect,it } from 'vitest';
import { allowanceCents,allowanceMoney,allowancePeriods,allowanceEmployeeMatches,emptyAllowanceRules,evaluateAllowancePeriods,validateAllowanceRules,type AllowanceDay } from '../lib/attendance-allowance-rules';
import { todayInKualaLumpur } from '../lib/hr-date';
import { monthDates } from '../lib/roster-month';
const year=Number(todayInKualaLumpur().slice(0,4))-1,month=`${year}-08`;
const day=(date:string,overrides:Partial<AllowanceDay>={}):AllowanceDay=>({date,attendanceId:date,kind:'full',shiftId:null,workingMinutes:600,actualMinutes:480,overtimeMinutes:120,lateMinutes:0,earlyOutMinutes:0,absentDays:0,attendanceDays:1,eligibleWorkingDays:1,complete:true,...overrides});
function evaluate(method:'monthly'|'weekly'|'daily',overrides:Partial<Parameters<typeof evaluateAllowancePeriods>[0]>={}){return evaluateAllowancePeriods({method,month,amount:'10.05',effectiveFrom:`${year}-01-01`,today:`${year}-12-31`,rules:emptyAllowanceRules(),days:monthDates(month).map(d=>day(d)),...overrides});}
describe('Attendance allowance fixed period engine',()=>{
  it('keeps decimal cents exact and rejects implicit rounding, exponents, negative and overflow amounts',()=>{
    expect(allowanceMoney(allowanceCents('0.10')+allowanceCents('0.20'))).toBe('0.30');
    for(const value of ['1.005','1e3','-1','NaN','10000000000'])expect(()=>allowanceCents(value)).toThrow();
    expect(()=>allowanceMoney(999999999999n+1n)).toThrow();
  });
  it('applies one fixed amount monthly, once for each Sunday-owned week, and once per daily period',()=>{
    expect(evaluate('monthly').filter(p=>p.qualified).map(p=>p.amount)).toEqual(['10.05']);
    const weekly=allowancePeriods('weekly',month);
    const from=weekly[0].from;
    const days=[...monthDates(month),...monthDates(`${year}-07`).filter(d=>d>=from)].map(d=>day(d));
    const results=evaluate('weekly',{days});
    expect(results).toHaveLength(weekly.length);expect(results.every(p=>p.qualified&&p.amount==='10.05')).toBe(true);
    expect(evaluate('daily').filter(p=>p.qualified)).toHaveLength(monthDates(month).length);
  });
  it('never pays a crossing week twice or loses its prior-month source dates',()=>{
    const found=Array.from({length:12},(_,i)=>`${year}-${String(i+1).padStart(2,'0')}`).map(m=>({m,weeks:allowancePeriods('weekly',m)})).find(x=>x.weeks.some(w=>w.from.slice(0,7)!==x.m));
    expect(found).toBeDefined();
    const crossing=found!.weeks.find(w=>w.from.slice(0,7)!==found!.m)!;
    expect(crossing.to.slice(0,7)).toBe(found!.m);
    expect(allowancePeriods('weekly',crossing.from.slice(0,7)).some(w=>w.key===crossing.key)).toBe(false);
    const result=evaluateAllowancePeriods({method:'weekly',month:found!.m,amount:'17.25',effectiveFrom:`${year-1}-01-01`,today:`${year+1}-01-01`,rules:emptyAllowanceRules(),days:[day(crossing.from)]}).find(p=>p.key===crossing.key)!;
    expect(result.eligibleDates).toContain(crossing.from);expect(result.amount).toBe('17.25');
  });
  it('evaluates AND, OR and inclusive between with exact hour-to-minute thresholds and unknown values failing',()=>{
    const rules=emptyAllowanceRules();rules.attendance.criteria=[{field:'actualMinutes',operator:'between',value:'7.99',upper:'8',unit:'hours'},{field:'lateMinutes',operator:'gt',value:'0',unit:'minutes'}];
    const first=monthDates(month)[0];
    expect(evaluate('daily',{rules,days:[day(first)]})[0].qualified).toBe(false);
    rules.attendance.logic='or';expect(evaluate('daily',{rules,days:[day(first)]})[0].qualified).toBe(true);
    expect(evaluate('daily',{rules,days:[day(first,{actualMinutes:null,lateMinutes:null})]})[0].qualified).toBe(false);
    expect(evaluate('daily',{rules,days:[day(first,{actualMinutes:479})]})[0].qualified).toBe(false);
  });
  it('separates day and shift applicability and refuses unfinished, incomplete and partially-effective periods',()=>{
    const rules=emptyAllowanceRules();rules.attendance.dayKinds=['half'];rules.attendance.shiftIds=['11111111-1111-4111-8111-111111111111'];
    const first=monthDates(month)[0],second=monthDates(month)[1];
    const days=[day(first,{kind:'half',shiftId:rules.attendance.shiftIds[0]}),day(second)];
    expect(evaluate('daily',{rules,days})[0].qualified).toBe(true);expect(evaluate('daily',{rules,days})[1].qualified).toBe(false);
    expect(evaluate('monthly',{effectiveFrom:second})[0].reasons).toContain('beforeEffective');
    expect(evaluate('monthly',{today:second})[0].reasons).toContain('unfinishedPeriod');
    expect(evaluate('daily',{days:[day(first,{complete:false})]})[0].reasons).toContain('incompleteAttendance');
    expect(evaluate('daily',{days:[day(first,{kind:'off',attendanceId:null,attendanceDays:0})]})[0].reasons).toContain('noApplicableDays');
  });
  it('employee conditions are an independent typed AND/OR expression; missing profile values never pass NOT IN',()=>{
    const rules=emptyAllowanceRules();rules.employee={mode:'criteria',employmentIds:[],logic:'and',criteria:[{field:'employmentType',operator:'in',values:['full_time']},{field:'departmentId',operator:'notIn',values:['11111111-1111-4111-8111-111111111111']}]};
    const facts={companyId:'x',departmentId:null,businessUnitId:null,positionId:null,gradeId:null,employmentType:'full_time',employmentCategory:null,status:'active'};
    expect(allowanceEmployeeMatches(rules.employee,'x',facts)).toBe(false);rules.employee.logic='or';expect(allowanceEmployeeMatches(rules.employee,'x',facts)).toBe(true);
    const invalid=emptyAllowanceRules();invalid.attendance.criteria=[{field:'actualMinutes',operator:'gte',value:'8',unit:'days'}];expect(()=>validateAllowanceRules(invalid)).toThrow();
    expect(()=>validateAllowanceRules({...rules,employee:{...rules.employee,mode:'selected',employmentIds:[]}})).toThrow();
    const inactive=emptyAllowanceRules();inactive.employee.criteria=[{field:'departmentId',operator:'in',values:[]}];expect(validateAllowanceRules(inactive).employee.criteria).toEqual([]);
  });
});
