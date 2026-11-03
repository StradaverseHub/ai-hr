/** AI v2 W5 — "Why is my pay different?", "Why is this deduction this amount?" and the claim and leave "Why?" owners,
 * on fictional payslip blobs shaped as the payroll kernel stamps them. No database.
 *
 * Every expected figure is written out by hand from the fixture (the payslip columns and stamps), never re-derived
 * through the module under test: a difference is the two stored figures subtracted on paper. The module may only
 * read what the run recorded, so each cause is asserted present exactly where its stamp is, and absent otherwise. */
import {describe,expect,it} from 'vitest';
import {comparePayPeriods,explainPayslipDeduction,payslipLineFigures,type PayComparison,type StoredPayslipRow} from '../core/pay-difference';
import {claimLimitExplanation} from '../core/claim-limit-explain';
import {leaveBalanceExplanation} from '../core/leave-balance-explain';
import type {ClaimBalanceRow} from '../core/claims';

type Stat=Record<string,unknown>;
const statutory=(over:Stat={}):Stat=>({version:'my-2026.1',epfEmployee:550,epfEmployer:650,socsoEmployee:24.75,socsoEmployer:86.65,socsoSkbbk:0,eisEmployee:9.9,eisEmployer:9.9,pcb:120,hrdf:0,zakat:0,zakatInTotal:true,
 bases:{epf:5000,epfAdditional:0,socsoEis:5000,pcb:5000,hrdf:5000},salaryBasis:{version:1,basicSalary:5000,effectiveFrom:'2024-01-01'},...over});
const row=(over:Partial<StoredPayslipRow>&{statutory?:Stat}={}):StoredPayslipRow=>({companyId:'co-a',company:'Fictional Ceria Sdn Bhd',payPeriod:'2026-09',runType:'regular',runSeq:1,
 basic:'5000.00',allowance:'0.00',overtime:'0.00',bonus:'0.00',gross:'5000.00',statutory:statutory(),otherDeductions:'0.00',totalDeductions:'704.65',net:'4295.35',daysWorked:'30.00',...over});

// September: a full month. October: one day of unpaid leave, and EPF, SOCSO, EIS and PCB on the lower wage.
const SEPTEMBER=row();
const OCTOBER=row({payPeriod:'2026-10',otherDeductions:'230.77',totalDeductions:'892.02',net:'4107.98',
 statutory:statutory({epfEmployee:528,epfEmployer:624,socsoEmployee:23.75,eisEmployee:9.5,pcb:100,unpaidLeave:{days:1,amount:230.77},
  bases:{epf:4769.23,epfAdditional:0,socsoEis:4769.23,pcb:4769.23,hrdf:4769.23}})});
const only=(result:ReturnType<typeof comparePayPeriods>):PayComparison=>{if(!result.ok)throw Error('Expected a comparison: '+result.reason);expect(result.comparisons).toHaveLength(1);return result.comparisons[0];};

describe('the pay difference reads each line as the payslip prints it and subtracts the stored figures',()=>{
 it('names the lines that moved, by the payroll service\'s own subtraction, and the unpaid leave the run recorded',()=>{
  const result=comparePayPeriods([OCTOBER,SEPTEMBER]);
  expect(result).toMatchObject({ok:true,period:'2026-10',previousPeriod:'2026-09',availablePeriods:['2026-10','2026-09']});
  const comparison=only(result);
  // 528 − 550, 23.75 − 24.75, 9.5 − 9.9, 100 − 120, 230.77 − 0 (worked by hand from the fixture).
  expect(comparison.lines.map(line=>[line.key,line.group,line.previous,line.current,line.change])).toEqual([
   ['epf','deductions',550,528,-22],['socso','deductions',24.75,23.75,-1],['eis','deductions',9.9,9.5,-0.4],['pcb','deductions',120,100,-20],['unpaidLeave','deductions',0,230.77,230.77]]);
  expect(comparison.totals).toEqual({gross:{current:5000,previous:5000,change:0},totalDeductions:{current:892.02,previous:704.65,change:187.37},net:{current:4107.98,previous:4295.35,change:-187.37}});
  expect(comparison.causes).toEqual([{kind:'unpaid_leave',current:1,previous:0}]);
  // The statutory working of each moved item: the schedule the run applied and the wage it charged it on.
  expect(comparison.statutory.map(item=>[item.key,item.ruleKind,item.setBy,item.basePrevious,item.baseCurrent,item.baseChange])).toEqual([
   ['epf','schedule','computed',5000,4769.23,-230.77],['socso','schedule','computed',5000,4769.23,-230.77],['eis','schedule','computed',5000,4769.23,-230.77],['pcb','mtd','computed',5000,4769.23,-230.77]]);
  expect(comparison.ruleVersion).toEqual({current:'my-2026.1',previous:'my-2026.1'});
 });
 it('adds a month\'s runs together, and records a salary change, an additional run and a new statutory ruleset',()=>{
  const octoberRegular=row({payPeriod:'2026-10',basic:'5500.00',gross:'5500.00',totalDeductions:'759.65',net:'4740.35',
   statutory:statutory({version:'my-2026.2',epfEmployee:605,salaryBasis:{version:1,basicSalary:5500,effectiveFrom:'2026-10-01'}})});
  const octoberBonus=row({payPeriod:'2026-10',runType:'additional',runSeq:2,basic:'0.00',bonus:'1000.00',gross:'1000.00',totalDeductions:'110.00',net:'890.00',
   statutory:statutory({epfEmployee:110,socsoEmployee:0,eisEmployee:0,pcb:0})});
  const comparison=only(comparePayPeriods([SEPTEMBER,octoberRegular,octoberBonus]));
  expect(comparison.payslips).toEqual({current:2,previous:1});
  // Basic 5,500 − 5,000; bonus 1,000 − 0; EPF (605 + 110) − 550 = 165; SOCSO and EIS from the regular run only.
  expect(Object.fromEntries(comparison.lines.map(line=>[line.key,line.change]))).toEqual({basic:500,bonus:1000,epf:165});
  expect(comparison.totals.gross).toEqual({current:6500,previous:5000,change:1500});
  expect(comparison.totals.net).toEqual({current:5630.35,previous:4295.35,change:1335});
  expect(comparison.causes).toEqual([
   {kind:'salary_change',current:5500,previous:5000,effectiveFrom:'2026-10-01'},{kind:'additional_run',current:1,previous:0},{kind:'statutory_rules',current:null,previous:null}]);
  expect(comparison.ruleVersion).toEqual({current:'my-2026.2',previous:'my-2026.1'});
 });
 it('reads overtime hours, days paid, named pay items and a figure set by hand only from their stamps',()=>{
  const october=row({payPeriod:'2026-10',overtime:'360.45',allowance:'300.00',gross:'5660.45',daysWorked:'29.00',totalDeductions:'704.65',net:'4955.80',
   statutory:statutory({otDetail:{total:360.45,lines:[{kind:'workday',qty:10,unit:'hours',rate:36.045,amount:360.45}]},
    componentLines:[{code:'A0040',name:'Meal Allowance',amount:300,buckets:[{bucket:'reimburse',amount:300}]}],
    epfEmployee:500,adjustment:{reason:'Typed by a fictional payroll officer',lines:{epfEmployee:{system:550,applied:500}}}})});
  const september=row({statutory:statutory({componentLines:[{code:'A0040',name:'Meal Allowance',amount:200,buckets:[{bucket:'reimburse',amount:200}]}]}),allowance:'200.00',gross:'5200.00',net:'4495.35'});
  const comparison=only(comparePayPeriods([september,october]));
  expect(comparison.payItems).toEqual([{name:'Meal Allowance',current:300,previous:200,change:100}]);
  expect(comparison.causes).toEqual([{kind:'overtime_hours',current:10,previous:null},{kind:'days_paid',current:29,previous:30},{kind:'set_by_hand',current:null,previous:null,items:['epf']}]);
  expect(comparison.statutory.find(item=>item.key==='epf')).toMatchObject({ruleKind:'manual',setBy:'statutoryAdjustment'});
  // The operator's typed reason never leaves the payslip.
  expect(JSON.stringify(comparison)).not.toContain('fictional payroll officer');
 });
 it('compares each company on its own and names a company that paid in only one month',()=>{
  const other=(period:string,net:string)=>row({companyId:'co-b',company:'Fictional Second Bhd',payPeriod:period,net});
  const third=row({companyId:'co-c',company:'Fictional Third Bhd',payPeriod:'2026-10'});
  const result=comparePayPeriods([OCTOBER,SEPTEMBER,other('2026-10','4300.00'),other('2026-09','4295.35'),third]);
  if(!result.ok)throw Error(result.reason);
  expect(result.comparisons.map(row=>[row.company,row.totals.net.change])).toEqual([['Fictional Ceria Sdn Bhd',-187.37],['Fictional Second Bhd',4.65]]);
  expect(result.onlyIn).toEqual({current:['Fictional Third Bhd'],previous:[]});
  // The payslip screen narrows to the company whose payslip is open.
  const narrowed=comparePayPeriods([OCTOBER,SEPTEMBER,other('2026-10','4300.00'),other('2026-09','4295.35')],{companyId:'co-b'});
  expect(narrowed.ok&&narrowed.comparisons.map(row=>row.company)).toEqual(['Fictional Second Bhd']);
 });
 it('compares against the month last paid, refuses the earliest month and a month not released',()=>{
  const august=row({payPeriod:'2026-08'});
  expect(comparePayPeriods([OCTOBER,august])).toMatchObject({ok:true,period:'2026-10',previousPeriod:'2026-08'});
  expect(comparePayPeriods([OCTOBER,august],{period:'2026-08'})).toEqual({ok:false,reason:'earliest',availablePeriods:['2026-10','2026-08']});
  expect(comparePayPeriods([OCTOBER,august],{period:'2026-09'})).toMatchObject({ok:false,reason:'no_period'});
  expect(comparePayPeriods([OCTOBER,august],{compareTo:'2026-10'})).toMatchObject({ok:false,reason:'same_period'});
  expect(comparePayPeriods([])).toEqual({ok:false,reason:'no_data',availablePeriods:[]});
 });
 it('prints each line exactly as the payslip does, including what the employer bore',()=>{
  // The employer bore the SOCSO share: the payslip prints what came off take-home (24.75 − 24.75).
  const borne=row({statutory:statutory({employerBorne:{socso:24.75}})});
  const figures=payslipLineFigures(SEPTEMBER);
  expect([figures.basic,figures.epf,figures.socso,figures.eis,figures.pcb,figures.gross,figures.totalDeductions,figures.net]).toEqual([5000,550,24.75,9.9,120,5000,704.65,4295.35]);
  expect(payslipLineFigures(OCTOBER).unpaidLeave).toBe(230.77);
  expect(payslipLineFigures(OCTOBER).otherDeductions).toBe(0);
  expect(payslipLineFigures(borne).socso).toBe(0);
 });
});

describe('why a deduction is this amount',()=>{
 it('gives the statutory working the run recorded for one line, and the days for unpaid leave',()=>{
  const epf=explainPayslipDeduction(SEPTEMBER,'epf');
  // 550 ÷ 5,000 = 11%: a check figure off the two recorded numbers.
  expect(epf).toEqual({key:'epf',amount:550,days:null,statutory:{ruleKind:'schedule',setBy:'computed',employeeReported:550,employeeTakeHome:550,employerBorne:0,employer:650,
   totalBase:5000,effectiveEmployeeRatePercent:11,workingNotRecorded:false,additionalRun:false,ruleVersion:'my-2026.1'}});
  expect(explainPayslipDeduction(OCTOBER,'unpaidLeave')).toEqual({key:'unpaidLeave',amount:230.77,statutory:null,days:1});
  expect(explainPayslipDeduction(SEPTEMBER,'unpaidLeave')).toBeNull();
  // A payslip with no recorded wage says so; it is never filled in from gross pay.
  const legacy=explainPayslipDeduction(row({statutory:statutory({bases:undefined})}),'socso');
  expect(legacy?.statutory).toMatchObject({totalBase:null,workingNotRecorded:true,effectiveEmployeeRatePercent:null});
 });
});

const balance=(over:Partial<ClaimBalanceRow>={}):ClaimBalanceRow=>({claimTypeId:'ct-1',typeCode:'MED',typeName:'Medical',items:[],annualLimit:2000,usedThisYear:620,reservedThisYear:120,remainingThisYear:1380,
 monthlyLimit:null,usedThisMonth:120,remainingThisMonth:null,perClaimCap:500,lifetimeLimit:null,usedLifetime:0,claimsUsedThisYear:3,maxClaimsPerYear:null,
 blockLimit:null,usedThisBlock:0,remainingThisBlock:null,blockEndsOn:null,policyValidFrom:'2026-01-01',policyGradeScoped:true,...over});
describe('why a claim limit is what it is',()=>{
 it('copies the claims owner\'s limits, use and what is left, and the policy version, without computing',()=>{
  expect(claimLimitExplanation(balance())).toEqual({claimType:'Medical',unlimited:false,annual:{limit:2000,used:620,pending:120,remaining:1380},monthly:null,perClaimCap:500,
   lifetime:null,block:null,claimsPerYear:null,items:[],policy:{validFrom:'2026-01-01',gradeScoped:true}});
  // A remaining figure the owner did not compute is not invented from limit − used.
  expect(claimLimitExplanation(balance({remainingThisYear:null})).annual?.remaining).toBeNull();
  const none=claimLimitExplanation(balance({annualLimit:null,remainingThisYear:null,perClaimCap:null,policyValidFrom:null,policyGradeScoped:false}));
  expect(none).toMatchObject({unlimited:true,annual:null,policy:{validFrom:null,gradeScoped:false}});
  const items=claimLimitExplanation(balance({items:[{claimItemId:'i1',itemName:'Dental',annualLimit:1000,usedThisYear:300,remainingThisYear:700,monthlyLimit:null,usedThisMonth:0,remainingThisMonth:null,perClaimCap:null},
   {claimItemId:'i2',itemName:'Optical',annualLimit:null,usedThisYear:50,remainingThisYear:null,monthlyLimit:null,usedThisMonth:0,remainingThisMonth:null,perClaimCap:null}]}));
  expect(items.items).toEqual([{name:'Dental',annual:{limit:1000,used:300,remaining:700},monthly:null,perClaimCap:null}]);
 });
});

describe('why a leave balance is this figure',()=>{
 const breakdown=(view:Record<string,boolean>={})=>({leaveType:'Annual Leave',cycleStart:'2026-01-01',entitlementStatus:'generated',entitlementTemplateName:'Fictional Standard',eligibility:null,
  entitlement:{annualEntitlementDays:14,prorated:true,eligibleCalendarDays:245,daysInLeaveYear:365,unroundedEntitlementDays:9.4,displayEntitlementDays:9.5,roundingApplied:true},
  currentYearEntitlement:7.83,currentYearEntitlementRounded:8,broughtForward:2,adjustments:0.5,totalEntitlement:12,takenThisCycle:2.5,pendingApproval:1,forfeitedThisCycle:0,
  carryForwardExpiryDate:'2026-06-30',totalAvailable:8.5,eligibleDays:14,monthlyAccruedToDate:7.83,carriedForward:2,carryForwardRemaining:0,configAdjustments:0.5,systemAdjustments:0,balance:9.5,transactions:[],
  essView:{eligible:true,ytdEntitled:true,broughtForward:true,adjustment:true,total:true,taken:true,pendingApproval:true,forfeited:true,available:true,...view}}) as never;
 const card=(over:Record<string,unknown>={})=>({leaveType:'Annual Leave',cycleStart:'2026-01-01',cycleEnd:'2026-12-31',isCurrentCycle:true,canApplyFor:8.5,taken:2.5,entitlementStatus:'generated' as never,breakdown:breakdown(),...over});
 it('ends on the card\'s own figure, with the proration working, through the Mine projection',()=>{
  expect(leaveBalanceExplanation(card())).toEqual({leaveType:'Annual Leave',cycleStart:'2026-01-01',cycleEnd:'2026-12-31',isCurrentCycle:true,canApplyFor:8.5,
   entitlementTemplateName:'Fictional Standard',entitlementStatus:'generated',withheld:false,carryForwardExpiryDate:'2026-06-30',
   proration:{annualEntitlementDays:14,prorated:true,displayEntitlementDays:9.5,roundingApplied:true},
   figures:{entitlement:9.5,earnedSoFar:8,broughtForward:2,adjustments:0.5,totalEntitlement:12,taken:2.5,pending:1,forfeited:0,available:8.5}});
 });
 it('withholds what the company\'s Employee Leave View hides, and the proration with a hidden entitlement',()=>{
  const hidden=leaveBalanceExplanation(card({breakdown:breakdown({eligible:false,broughtForward:false})}));
  expect(hidden).toMatchObject({withheld:true,proration:null,figures:{entitlement:null,broughtForward:null,taken:2.5,available:8.5}});
  // A type with no breakdown (taken only) shows what was taken and nothing else.
  expect(leaveBalanceExplanation(card({breakdown:null,canApplyFor:null})).figures).toEqual({entitlement:null,earnedSoFar:null,broughtForward:null,adjustments:null,totalEntitlement:null,taken:2.5,pending:null,forfeited:null,available:null});
 });
});
