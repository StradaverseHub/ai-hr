/** AI v2 Phase 2, P2-4 — the HR capacity ledger's arithmetic (core/capacity/ledger-math.ts) and baseline resolution
 * (core/capacity/baseline-rules.ts), on fictional figures.
 *
 * Every expected value is worked out by hand in the comments beside it, never re-derived from the helpers under test:
 * hours freed = items x the company's own minutes per item - review time, where each item's review time is the gap from
 * preparation to confirmation, capped at 15 minutes and at the item's own manual minutes. */
import {describe,expect,it} from 'vitest';
import {REVIEW_CAP_MINUTES,chartMonths,computeLedger,hoursOf,periodStartDate,reviewMinutes,type LedgerInput,type WorkFact} from '../core/capacity/ledger-math';
import {parseMinutes,resolveBaselineItems} from '../core/capacity/baseline-rules';

const A='00000000-0000-4000-8000-0000000000a1',B='00000000-0000-4000-8000-0000000000b2',OTHER='00000000-0000-4000-8000-0000000000f9';
const fact=(companyId:string,item:WorkFact['item'],date:string,gaps:number[]|null,count=gaps?.length??0,changed=0):WorkFact=>({companyId,item,date,count,changed,gaps});
const MONTHS=['2026-06','2026-07','2026-08','2026-09','2026-10','2026-11'];
const base=(over:Partial<LedgerInput>={}):LedgerInput=>({periodFrom:'2026-10-05',months:MONTHS,companyIds:[A,B],
 baselines:[{companyId:A,items:{loop_missed_clock_outs:{minutes:3,basis:'event_log'},loop_payroll_inputs:{minutes:240,basis:'entered'},questions_answered:{minutes:3,basis:'entered'}}}],
 work:[
  // 4 clock-outs: reviews min(1,15,3)=1, min(2,15,3)=2, min(30,15,3)=3, min(600,15,3)=3 -> 9; manual 4x3=12; freed 3.
  fact(A,'loop_missed_clock_outs','2026-11-02',[1,2,30,600],4,1),
  // 2 payroll input runs: reviews min(10,15,240)=10, min(2000,15,240)=15 -> 25; manual 480; freed 455.
  fact(A,'loop_payroll_inputs','2026-10-20',[10,2000]),
  // 10 questions, no review step: manual 30, freed 30.
  fact(A,'questions_answered','2026-11-01',null,10),
  // Company B has no baseline: 5 done, no time.
  fact(B,'loop_missed_clock_outs','2026-11-01',[5,5,5,5,5]),
  // Before the period (September): in the chart, not in the totals. 2 clock-outs, reviews 3+3=6, manual 6, freed 0;
  // 1 payroll run gap 60 -> review 15, manual 240, freed 225.
  fact(A,'loop_missed_clock_outs','2026-09-15',[100,100]),
  fact(A,'loop_payroll_inputs','2026-09-20',[60]),
 ],
 payrollErrors:[{companyId:A,date:'2026-10-10',count:2},{companyId:B,date:'2026-11-01',count:1},{companyId:A,date:'2026-09-01',count:7}],
 outcomesVisible:true,...over});

describe('review time',()=>{
 it('is the gap from preparation to confirmation, capped at 15 minutes and at the item\'s own manual time',()=>{
  expect(REVIEW_CAP_MINUTES).toBe(15);
  expect(reviewMinutes(4,240)).toBe(4);
  expect(reviewMinutes(90,240)).toBe(15);
  expect(reviewMinutes(90,8)).toBe(8);
  expect(reviewMinutes(0.5,1)).toBe(0.5);
  expect(reviewMinutes(-3,10)).toBe(0);
  // An unreadable gap counts the full allowance, never zero.
  expect(reviewMinutes(Number.NaN,10)).toBe(10);
 });
});

describe('hours freed',()=>{
 it('adds each company\'s items x its own minutes, minus review time, over the period only',()=>{
  const ledger=computeLedger(base());
  // 3 + 455 + 30 = 488 minutes = 8.13 hours.
  expect(ledger.freedMinutes).toBe(488);
  expect(hoursOf(ledger.freedMinutes!)).toBe(8.1);
  const rows=Object.fromEntries(ledger.rows.map(row=>[row.item,row]));
  expect(rows.loop_payroll_inputs).toEqual({item:'loop_payroll_inputs',done:2,manualMinutes:480,reviewMinutes:25,freedMinutes:455,withoutBaseline:0});
  // A's 4 plus B's 5 clock-outs are done; only A's free time.
  expect(rows.loop_missed_clock_outs).toEqual({item:'loop_missed_clock_outs',done:9,manualMinutes:12,reviewMinutes:9,freedMinutes:3,withoutBaseline:5});
  expect(rows.questions_answered).toEqual({item:'questions_answered',done:10,manualMinutes:30,reviewMinutes:0,freedMinutes:30,withoutBaseline:0});
  // Most time freed first.
  expect(ledger.rows.map(row=>row.item)).toEqual(['loop_payroll_inputs','questions_answered','loop_missed_clock_outs']);
  // Loop actions: 4 + 2 + 5 in the period, 1 changed by a person.
  expect(ledger.loopActions).toEqual({done:11,changed:1});
  expect(ledger.questions).toBe(10);
  // Errors in the period, in scope: 2 (A, October) + 1 (B, November); September's 7 are before the period.
  expect(ledger.payrollErrors).toBe(3);
  expect(ledger.companiesWithoutBaseline).toEqual([B]);
 });

 it('subtracts review time: the same work confirmed at once frees more',()=>{
  const slow=computeLedger(base()).freedMinutes!;
  const instant=computeLedger(base({work:base().work.map(row=>row.gaps?{...row,gaps:row.gaps.map(()=>0)}:row)})).freedMinutes!;
  // At once: 12 + 480 + 30 = 522; with review: 522 - 9 - 25 = 488.
  expect(instant).toBe(522);
  expect(instant-slow).toBe(34);
 });

 it('draws each month from the same arithmetic, the period\'s months and the earlier ones',()=>{
  const ledger=computeLedger(base());
  expect(ledger.months).toEqual([
   {month:'2026-06',freedMinutes:0},{month:'2026-07',freedMinutes:0},{month:'2026-08',freedMinutes:0},
   // September: clock-outs 0 + payroll 225.
   {month:'2026-09',freedMinutes:225},
   // October: payroll 455. November: clock-outs 3 + questions 30.
   {month:'2026-10',freedMinutes:455},{month:'2026-11',freedMinutes:33}]);
 });

 it('ignores work of a company outside the filter',()=>{
  const ledger=computeLedger(base({companyIds:[A],work:[...base().work,fact(OTHER,'loop_payroll_inputs','2026-11-01',[0])],
   baselines:[...base().baselines,{companyId:OTHER,items:{loop_payroll_inputs:{minutes:999,basis:'entered'}}}]}));
  expect(ledger.freedMinutes).toBe(488);
  expect(ledger.loopActions.done).toBe(6);
  expect(ledger.payrollErrors).toBe(2);
  expect(ledger.companiesWithoutBaseline).toEqual([]);
 });

 it('rejects a work fact whose gaps do not match its count',()=>{
  expect(()=>computeLedger(base({work:[fact(A,'loop_missed_clock_outs','2026-11-02',[1],3)]}))).toThrow(RangeError);
 });
});

describe('baseline missing and figures not shown',()=>{
 it('has no hours at all without a baseline, while the counts still show',()=>{
  const ledger=computeLedger(base({baselines:[]}));
  expect(ledger.freedMinutes).toBeNull();
  expect(ledger.companiesWithoutBaseline).toEqual([A,B]);
  expect(ledger.loopActions.done).toBe(11);
  expect(ledger.rows.every(row=>row.freedMinutes===0&&row.withoutBaseline===row.done)).toBe(true);
 });
 it('marks question counts and payroll errors as not shown rather than zero',()=>{
  const ledger=computeLedger(base({outcomesVisible:false,payrollErrors:null,work:base().work.filter(row=>row.item!=='questions_answered')}));
  expect(ledger.questions).toBeNull();
  expect(ledger.payrollErrors).toBeNull();
 });
});

describe('periods and chart months, in Malaysia calendar days',()=>{
 it('starts each period on the right day',()=>{
  expect(periodStartDate('last30','2026-11-03')).toBe('2026-10-05');
  expect(periodStartDate('quarter','2026-11-03')).toBe('2026-10-01');
  expect(periodStartDate('quarter','2026-03-31')).toBe('2026-01-01');
  expect(periodStartDate('year','2026-11-03')).toBe('2026-01-01');
  expect(periodStartDate('last30','2026-03-01')).toBe('2026-01-31');
 });
 it('shows at least six months, and this year\'s months for "This year"',()=>{
  expect(chartMonths('last30','2026-11-03')).toEqual(MONTHS);
  expect(chartMonths('quarter','2026-11-03')).toEqual(MONTHS);
  expect(chartMonths('year','2026-11-03')).toEqual(['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10','2026-11']);
  expect(chartMonths('year','2026-02-10')).toEqual(['2025-09','2025-10','2025-11','2025-12','2026-01','2026-02']);
 });
});

describe('baseline minutes per item',()=>{
 it('measures from the event log where it can, and takes the administrator\'s minutes elsewhere',()=>{
  const items=resolveBaselineItems({minCompleted:10,minutesPerStaffAction:2,
   entered:{loop_missed_clock_outs:9,loop_missing_employee_data:8,loop_probation_ending:20,questions_answered:null},
   evidence:{attendance_correction:{cases:20,completed:15,staffActions:30},profile_change:{cases:6,completed:5,staffActions:12}}});
  // Attendance corrections: 30 actions / 20 cases x 2 minutes = 3 minutes (measured; the entered 9 is not used).
  expect(items.loop_missed_clock_outs).toEqual({minutes:3,basis:'event_log',process:'attendance_correction',cases:20,completed:15,staffActions:30});
  // Profile changes: 5 completed is below 10, so the entered 8 minutes.
  expect(items.loop_missing_employee_data).toEqual({minutes:8,basis:'entered'});
  expect(items.loop_probation_ending).toEqual({minutes:20,basis:'entered'});
  // Blank means not in the baseline, never a default figure.
  expect(items.questions_answered).toBeUndefined();
  expect(items.loop_payroll_inputs).toBeUndefined();
 });
 it('needs the minutes per staff action to turn a measure into time',()=>{
  const items=resolveBaselineItems({minCompleted:10,minutesPerStaffAction:null,entered:{},
   evidence:{attendance_correction:{cases:20,completed:15,staffActions:30}}});
  expect(items).toEqual({});
 });
 it('reads minutes strictly: a number up to the limit with one decimal, or nothing',()=>{
  expect(parseMinutes('12',1440)).toBe(12);
  expect(parseMinutes(' 2.5 ',240)).toBe(2.5);
  expect(parseMinutes('0',240)).toBe(0);
  for(const bad of ['','-1','2.55','1e3','abc','241'])expect(parseMinutes(bad,240)).toBeNull();
  expect(parseMinutes(12 as unknown,240)).toBeNull();
 });
});
