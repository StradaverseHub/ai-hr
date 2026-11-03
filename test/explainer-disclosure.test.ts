/** ADR-0170 step 4 — explainer output and the step 1 open questions under harness disclosure. Fictional
 * owner-shaped outputs; no database. Pay figures leave only as bands; module-work rows stay open but their
 * pay figures are banded; record ids become handles; operator free text never appears. */
import {describe,expect,it} from 'vitest';
import {DisclosureLedger,discloseToolOutput} from '../core/harness/disclosure';

const ID='44444444-4444-4444-8444-444444444444';
describe('explainer disclosure',()=>{
 it('bands every statutory figure and rate, keeps the rule kind, version and provenance',()=>{
  const ledger=new DisclosureLedger('me');
  const item={key:'epf',name:'EPF',ruleKind:'schedule',totalBase:5000,additionalBase:0,employeeReported:550,employeeTakeHome:550,employerBorne:0,employer:650,
   effectiveEmployeeRatePercent:11,effectiveEmployerRatePercent:13,workingNotRecorded:false,setBy:'computed',systemEmployee:null,systemEmployer:null};
  const {value,applied}=discloseToolOutput('explain_payslip_statutory','statutory_explanation',{ok:true,period:'2026-08',availablePeriods:['2026-08'],
   payslips:[{company:'Fictional Ceria',payPeriod:'2026-08',runType:'regular',ruleVersion:'my-2026.1',basesNotRecorded:false,basesCoverWholeMonth:false,items:[item],
    totals:{employeeReported:550,employeeTakeHome:550,employerBorne:0,employer:650}}],provenance:{owner:'core/statutory-explain.ts#explainStatutory',ruleVersionSource:'x',page:'/me/payslip',note:'y'}},ledger);
  expect(applied.undeclared).toEqual([]);expect(applied.removed).toEqual([]);
  const text=JSON.stringify(value);
  expect(text).not.toMatch(/:(5000|550|650|11|13)[,}]/);
  expect(text).toContain('"ruleVersion":"my-2026.1"');expect(text).toContain('"ruleKind":"schedule"');expect(text).toContain('core/statutory-explain.ts#explainStatutory');
  expect([...ledger.figures.values()].map(row=>row.value)).toEqual([5000,0,550,550,0,650,11,13,550,550,0,650]);
 });
 it('bands pay figures inside module work rows and keeps the other modules\' rows',()=>{
  const ledger=new DisclosureLedger('me');
  const payroll=discloseToolOutput('my_module_work','module_work',{module:'payroll',
   data:{rows:[{id:ID,payPeriod:'2026-08',runType:'regular',runSeq:1,company:'Fictional Ceria',currency:'MYR',gross:5234.5,deductions:812.25,net:4422.25}],truncated:false,totalRows:1},
   specialistWork:{findings:['released_pay_stored_only']},humanActions:[]},ledger);
  expect(payroll.applied.undeclared).toEqual([]);
  expect(payroll.applied.banded).toEqual(['data.rows[0].gross','data.rows[0].deductions','data.rows[0].net']);
  const text=JSON.stringify(payroll.value);for(const figure of ['5234.5','812.25','4422.25'])expect(text).not.toContain(figure);
  expect(text).toContain('"payPeriod":"2026-08"');expect(text).toContain('"runSeq":1');expect(text).not.toContain(ID);
  const typed=discloseToolOutput('my_module_work','module_work',{module:'typed_pay_components',data:[{payslipId:ID,payPeriod:'2026-08',currency:'MYR',lines:[{code:'BASIC',name:'Basic',amount:5000}]}]},ledger);
  expect(typed.applied.banded).toEqual(['data[0].lines[0].amount']);expect(JSON.stringify(typed.value)).toContain('"code":"BASIC"');
  const attendance=discloseToolOutput('my_module_work','module_work',{module:'attendance',data:[{employmentId:ID,company:'Fictional Ceria',date:'2026-07-01',status:'late',workedMinutes:490,otMinutes:30}]},ledger);
  expect(attendance.applied.banded).toEqual([]);expect(attendance.applied.undeclared).toEqual([]);expect(JSON.stringify(attendance.value)).toContain('"workedMinutes":490');
 });
 it('declares the entitlement explainer\'s fields, removing only typed free text',()=>{
  const ledger=new DisclosureLedger('me');
  const {value,applied}=discloseToolOutput('explain_leave_entitlement','entitlement_explanation',{ok:true,leaveType:'Annual Leave',asOf:'2026-11-01',employments:[{company:'Fictional Ceria',leaveType:'Annual Leave',
   cycleStart:'2026-01-01',entitlementStatus:'generated',entitlementTemplateName:'Fictional Standard',eligibility:null,displayEntitlementDays:14,currentYearEntitlement:11.67,currentYearEntitlementRounded:11.5,
   broughtForward:2,adjustments:0,totalEntitlement:13.5,takenThisCycle:3,pendingApproval:1,forfeitedThisCycle:0,carryForwardExpiryDate:'2026-06-30',totalAvailable:9.5,notShown:[],
   eligibleDays:14,monthlyAccruedToDate:11.67,carriedForward:2,carryForwardRemaining:0,configAdjustments:0,systemAdjustments:0,balance:10.5,
   transactions:{rows:[{effectiveOn:'2026-01-31',entryType:'accrual',days:1.17,sourceRequestId:ID,reason:'typed by HR'}],truncated:false,totalRows:1},
   proration:{annualEntitlementDays:14,prorated:false,eligibleCalendarDays:null,daysInLeaveYear:null,unroundedEntitlementDays:14,displayEntitlementDays:14,roundingApplied:false}}],
   provenance:{owner:'core/read.ts#leaveEntitlementBreakdown',ruleVersionSource:'x',page:'/leave',note:'y'}},ledger);
  expect(applied.undeclared).toEqual([]);expect(applied.removed).toEqual(['employments[0].transactions.rows[0].reason']);
  expect(JSON.stringify(value)).not.toMatch(/11\.67|:14[,}]|typed by HR/);expect(JSON.stringify(value)).not.toContain(ID);expect(JSON.stringify(value)).toContain('Fictional Standard');
 });
 it('names what a partly hidden breakdown does not show (spec v23 notShown), and drops a stray withheld flag as undeclared',()=>{
  const ledger=new DisclosureLedger('me');
  const {value,applied}=discloseToolOutput('explain_leave_entitlement','entitlement_explanation',{ok:true,leaveType:'Medical Leave',asOf:'2026-11-01',employments:[{company:'Fictional Ceria',leaveType:'Medical Leave',
   cycleStart:'2026-01-01',entitlementStatus:'generated',entitlementTemplateName:'Fictional Standard',eligibility:null,displayEntitlementDays:14,currentYearEntitlement:11.67,currentYearEntitlementRounded:11.5,
   broughtForward:null,adjustments:0,totalEntitlement:13.5,takenThisCycle:3,pendingApproval:1,forfeitedThisCycle:null,carryForwardExpiryDate:null,totalAvailable:9.5,
   notShown:['broughtForward','forfeitedThisCycle','carryForwardExpiryDate','eligibleDays','monthlyAccruedToDate','carriedForward','carryForwardRemaining','configAdjustments','systemAdjustments','balance','transactions'],
   withheld:true,proration:{annualEntitlementDays:14,prorated:false,eligibleCalendarDays:null,daysInLeaveYear:null,unroundedEntitlementDays:14,displayEntitlementDays:14,roundingApplied:false}}],
   provenance:{owner:'core/read.ts#leaveEntitlementBreakdown',ruleVersionSource:'x',page:'/leave',note:'y'}},ledger);
  // notShown is declared in full: the names reach the model; a figure that is present is still a band.
  const row=(value as {employments:Record<string,unknown>[]}).employments[0];
  expect(row.notShown).toEqual(['broughtForward','forfeitedThisCycle','carryForwardExpiryDate','eligibleDays','monthlyAccruedToDate','carriedForward','carryForwardRemaining','configAdjustments','systemAdjustments','balance','transactions']);
  expect(String(row.totalAvailable)).toMatch(/^\{\{F\d+\}\} \(between 5 and 10\)$/);
  expect(applied.undeclared).toEqual(['employments[0].withheld']);expect(row).not.toHaveProperty('withheld');
 });
 it('keeps the attendance working sentences and declares every attendance field',()=>{
  const {value,applied}=discloseToolOutput('explain_attendance_day','attendance_day_explanation',{ok:true,date:'2026-07-01',company:'Fictional Ceria',status:'present',flag:'late',
   recorded:{lateMinutes:20,earlyOutMinutes:0,workedMinutes:490,overtimeMinutes:30},explained:true,
   schedule:{source:'Assigned shift',dayType:'Working day',shiftStart:'09:00',shiftEnd:'18:00',scheduledMinutes:480,breakMinutes:60,ruleApplied:false,crossesMidnight:false},
   punch:{checkIn:'09:20',checkOut:'18:30',workedMinutes:490},lateness:{minutes:20,steps:['Scheduled start is 09:00.','Clocked in at 09:20.']},earlyOut:{minutes:0,steps:[]},overtime:{minutes:30,steps:[]},
   provenance:{owner:'core/attendance-explain.ts#explainAttendanceDay',ruleVersionSource:'x',page:'/attendance/my-records',note:'y'}},new DisclosureLedger('me'));
  expect(applied.undeclared).toEqual([]);expect(applied.removed).toEqual([]);expect(JSON.stringify(value)).toContain('Clocked in at 09:20.');
 });
});
