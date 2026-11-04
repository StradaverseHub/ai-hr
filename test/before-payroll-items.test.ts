/** AI v2 Phase 2, P2-3 — the "Before payroll" checklist service, every item kind, over its owners' own row shapes.
 *
 * Each native owner is replaced by a stub that returns fictional rows in that owner's own shape (the DB-backed proof
 * that the real owners return only the person's own rows is test/before-payroll-checklist.test.ts). Pinned here, with every
 * expected value written out by hand from the fixture:
 *  - every item kind, its state, day, due date and one action (the missed clock-out loop's Confirm card where it exists);
 *  - the cut-off and the period window are the payroll owner's (cutOffWindowFor's answer for the cut-off day
 *    app.own_payroll_cut_off_day returns for the person's own employment); with no answer, the calendar month and no date;
 *  - no pay figure: amounts, limits, balances, minutes and day counts the owners return never reach the result;
 *  - an owner that fails is "could not check", never done; a module not in use is "off";
 *  - the Ask read's disclosure: every returned field declared, no id or link with an id, health-indicative names withheld.
 * No database. */
import {beforeEach,describe,expect,it,vi} from 'vitest';

const fx=vi.hoisted(()=>({cutOffRow:true as boolean,cutOffDay:20 as number|null,modules:{} as Record<string,boolean>,fail:new Set<string>(),calls:[] as unknown[][],
 own:true as boolean,gaps:null as null|unknown[],tp3Answer:null as null|'yes'|'no',
 // AI Centre navigation speed: holds the person's own employment read until released, to see what runs meanwhile.
 subjectGate:null as null|Promise<void>,subjectFails:false as boolean}));
const failing=(name:string)=>{if(fx.fail.has(name))throw new Error('Fictional owner failure: '+name);};

// The only direct query is app.own_payroll_cut_off_day (migration 0967): one row for the person's own employment, or none.
vi.mock('../db/client',()=>({withTenant:async(_ctx:unknown,fn:(tx:unknown)=>unknown)=>fn({execute:async()=>{fx.calls.push(['ownCutOff']);return fx.cutOffRow?[{cut_off_day:fx.cutOffDay}]:[];}})}));
// Phase 2 hardening: the person's own answer to "Did you work for another employer earlier this year?" (core/pre-salary/tp3-answer.ts).
vi.mock('../core/pre-salary/tp3-answer',()=>({myTp3PreviousEmployerAnswer:async(_ctx:unknown,year:number)=>{fx.calls.push(['tp3Answer',year]);return fx.tp3Answer;}}));
vi.mock('../core/entitlements',()=>{
 class EntitlementsResolutionFailedError extends Error{}
 return {EntitlementsResolutionFailedError,isModuleEnabled:(_ctx:unknown,code:string)=>fx.modules[code]??true};
});
vi.mock('../core/employee-home',()=>{
 class HomeAccessError extends Error{constructor(readonly code:string){super('no own subject');}}
 return {HomeAccessError,requireOwnHomeSubject:async()=>{fx.calls.push(['requireOwnHomeSubject']);if(fx.subjectGate)await fx.subjectGate;
  if(fx.subjectFails)throw new Error('Fictional employment read failure');if(!fx.own)throw new HomeAccessError('employmentUnavailable');
  return {employmentId:'emp-own',currentCompanyId:'co-1',companyProof:{companyId:'co-1'}};}};
});
vi.mock('../packs/payroll/service',()=>({
 listMyTp1Declarations:async(_ctx:unknown,p:{assessmentYear?:number})=>{fx.calls.push(['listMyTp1Declarations',p]);return [
  {id:'tp1-draft',assessmentYear:2026,status:'draft',tp1Amount:2500.5,approvedAt:null,submittedAt:null},{id:'tp1-sent',assessmentYear:2026,status:'submitted',tp1Amount:1111.11,approvedAt:null,submittedAt:new Date()},
  {id:'tp1-approved',assessmentYear:2026,status:'submitted',tp1Amount:7777.77,approvedAt:new Date(),submittedAt:new Date()},{id:'tp1-last-year',assessmentYear:2025,status:'draft',tp1Amount:3,approvedAt:null,submittedAt:null}];},
 // The payroll owner's answer for the company's cut-off day; the service must use it as given.
 cutOffWindowFor:(type:string,policy:unknown,company:{cutOffDay:number|null},period:string)=>{fx.calls.push(['cutOffWindowFor',type,policy,company,period]);
  return company.cutOffDay===20?(period==='2026-11'?{start:'2026-10-20',end:'2026-11-19'}:{start:'2026-11-20',end:'2026-12-19'}):{start:`${period}-01`,end:period==='2026-11'?'2026-11-30':'2026-12-31'};},
 myTp3Employments:async()=>[{employmentId:'emp-own',company:'Fictional Ceria Sdn Bhd',employeeCode:'E-1',joinDate:'2026-03-02',hiredOn:'2026-03-02',terminatedOn:null,resignationDate:null,lastWorkingDate:null,blacklistedAt:null}],
 myTp3History:async()=>({records:[{assessmentYear:2025}],drafts:[{assessmentYear:2026,submittedAt:null}]}),
}));
const row=(over:Record<string,unknown>)=>({attendanceId:'att',status:'present',context:null,checkInAt:'09:00:00',checkOutAt:'18:00:00',dayType:'workday',workedMinutes:480,scheduledMinutes:480,
 lateMinutes:0,earlyOutMinutes:0,shiftStart:'09:00:00',shiftEnd:'18:00:00',isRosterRest:false,otMinutes:150,...over});
vi.mock('../packs/attendance/service',async()=>({
 classifyDay:(await import('../packs/attendance/exceptions')).classifyDay,
 attendanceForEmploymentRange:async(...args:unknown[])=>{fx.calls.push(['attendanceForEmploymentRange',...args.slice(1)]);failing('attendance');return [
  row({date:'2026-11-02',attendanceId:null,status:null,checkInAt:null,checkOutAt:null}),// absent, but a correction is already pending for it
  row({date:'2026-11-03',checkOutAt:null}),// missed clock-out; the loop has a card for it
  row({date:'2026-11-04',checkInAt:null}),// missed clock-in
  row({date:'2026-11-05',attendanceId:null,status:null,checkInAt:null,checkOutAt:null}),// absent, no leave
  row({date:'2026-11-06',status:'late',checkInAt:'09:40:00',lateMinutes:40}),// late
  row({date:'2026-11-07',attendanceId:null,status:null,checkInAt:null,checkOutAt:null,context:'rest_day',isRosterRest:true,dayType:'rest_day'}),// rest day: nothing
  row({date:'2026-11-09',checkOutAt:null}),// missed clock-out, no loop card
 ];},
 myAttendanceCorrections:async()=>[{id:'corr-1',attendanceDate:'2026-11-02',requestKind:'absent',status:'pending'},{id:'corr-ot',attendanceDate:'2026-11-08',requestKind:'self_overtime',status:'pending'},
  {id:'corr-old',attendanceDate:'2026-09-30',requestKind:'incomplete_entry',status:'pending'}],
 myOvertimePlans:async()=>[{id:'ot-1',attendanceDate:'2026-11-08',status:'pending',requestedOtMinutes:180,approvedOtMinutes:null},{id:'ot-late',attendanceDate:'2026-12-02',status:'pending',requestedOtMinutes:60}],
 otMonthToDateMinutes:async()=>({recordedMinutes:6000,plannedMinutes:300,totalMinutes:6300,capMinutes:6240}),
}));
vi.mock('../core/loops/cards',()=>({readLoopCards:async()=>[{kind:'clockOut',caseId:'case-1',date:'2026-11-03',checkIn:'09:00',proposedCheckOut:'18:00',href:'/attendance/my-records/2026-11-03?checkOut=18%3A00'},
 {kind:'passport',caseId:'case-2',expiresOn:'2027-01-01',href:'/me?tab=profile'}]}));
vi.mock('../core/read',()=>({
 leaveRequestsFor:async()=>{failing('leave');return [
  {id:'lv-pending',leaveTypeId:'lt-annual',leaveType:'Annual Leave',startDate:'2026-11-12',endDate:'2026-11-13',days:'2',status:'pending',hasDocument:false},
  {id:'lv-unpaid',leaveTypeId:'lt-unpaid',leaveType:'Unpaid Leave',startDate:'2026-11-04',endDate:'2026-11-04',days:'1',status:'approved',hasDocument:false},
  {id:'lv-mc',leaveTypeId:'lt-mc',leaveType:'Medical Leave',startDate:'2026-10-27',endDate:'2026-10-28',days:'2',status:'approved',hasDocument:false},
  {id:'lv-mc-ok',leaveTypeId:'lt-mc',leaveType:'Medical Leave',startDate:'2026-10-21',endDate:'2026-10-21',days:'1',status:'approved',hasDocument:false},
  {id:'lv-rejected',leaveTypeId:'lt-annual',leaveType:'Annual Leave',startDate:'2026-11-16',endDate:'2026-11-16',days:'1',status:'rejected',hasDocument:false},
  {id:'lv-later',leaveTypeId:'lt-annual',leaveType:'Annual Leave',startDate:'2026-12-15',endDate:'2026-12-15',days:'1',status:'pending',hasDocument:false}];},
 listEligibleLeaveTypesFor:async()=>[{id:'lt-annual',paid:true,requiresDocument:false,mandatoryAfterDays:null},{id:'lt-unpaid',paid:false,requiresDocument:false,mandatoryAfterDays:null},
  {id:'lt-mc',paid:true,requiresDocument:true,mandatoryAfterDays:1}],
}));
vi.mock('../packs/claims/service',()=>({
 listClaimsForEmployment:async()=>{failing('claims');const claim=(id:string,claimTypeId:string,typeName:string,status:string,incurredOn:string,attachments:unknown[]=[])=>
  ({id,claimTypeId,claimItemId:null,typeCode:'X',typeName,itemName:null,amount:1234.56,quantityKm:null,incurredOn,description:'Fictional typed words',taxable:false,status,createdAt:'2026-11-01',decidedAt:null,paidAt:null,employeeCode:'E-1',personId:'p',attachments});
  return [claim('cl-near','ct-travel','Travel','draft','2026-10-01'),claim('cl-receipt','ct-parking','Parking','draft','2026-11-08'),
   claim('cl-draft','ct-meal','Meal','draft','2026-11-09'),claim('cl-has','ct-parking','Parking','draft','2026-11-09',[{id:'f',fileName:'r.pdf',sizeBytes:10}]),
   claim('cl-pending','ct-meal','Meal','pending','2026-11-03'),claim('cl-old','ct-meal','Meal','draft','2026-09-01'),claim('cl-paid','ct-meal','Meal','paid','2026-10-03')];},
 getEmployeeClaimTypes:async()=>[{id:'ct-travel',requiresReceipt:false,maxReceiptAgeDays:45,balance:{annualLimit:9876.54}},{id:'ct-parking',requiresReceipt:true,maxReceiptAgeDays:45,balance:{annualLimit:9876.54}},
  {id:'ct-meal',requiresReceipt:false,maxReceiptAgeDays:45,balance:{annualLimit:9876.54}}],
}));
vi.mock('../packs/leave/service',()=>({listReplacementLeaveRequests:async()=>[{id:'toil-1',unit:'day',totalDays:1,totalHours:8,status:'pending',submittedOn:'2026-11-02',decidedAt:null,reason:'Fictional reason',
 dates:[{workedDate:'2026-11-01',days:1,fromTime:'09:00',toTime:'17:00',hours:8}]},{id:'toil-2',status:'approved',submittedOn:'2026-10-02',dates:[]}]}));
vi.mock('../core/readiness-actions',()=>({myReadinessActions:async()=>fx.gaps??[
 {gap:'no_bank_account',type:'submit_correction',audience:'employee',tab:'bankStatutory',requestId:null,approver:'admin'},
 {gap:'no_tax_number',type:'submit_correction',audience:'employee',tab:'bankStatutory',requestId:null,approver:'admin'},
 {gap:'no_epf_number',type:'submit_correction',audience:'employee',tab:'bankStatutory',requestId:null,approver:'admin'},
 {gap:'no_socso_number',type:'review_submission',audience:'hr',tab:'bankStatutory',requestId:'req-1',approver:'admin'},
 {gap:'no_identity',type:'review_submission',audience:'hr',tab:'bankStatutory',requestId:'req-1',approver:'admin'}]}));
vi.mock('../core/letters',()=>({listMyLetters:async()=>({nextCursor:null,rows:[
 {id:'letter-1',reference:'L-1',state:'issued',issuedAt:new Date('2026-11-02T03:00:00Z'),voidedAt:null,employmentId:'emp-own',companyId:'co-1',acknowledgement:'acknowledge',viewed:true,confirmed:null},
 {id:'letter-2',state:'issued',issuedAt:new Date('2026-10-02T03:00:00Z'),voidedAt:null,acknowledgement:'none',confirmed:null},
 {id:'letter-3',state:'issued',issuedAt:new Date('2026-10-05T03:00:00Z'),voidedAt:null,acknowledgement:'signature',confirmed:'signed'}]})}));
vi.mock('../core/profile',()=>({myProfile:async()=>({person:{fullName:'Aina Fictional'},statutory:{bankName:'Maybank',bankAccountNo:'514012345678',taxCategory:'KA2',numChildren:3}})}));
// The Family register's own eligible count decides; this stub answers as the owner would for the rows it is given.
vi.mock('../core/dependents',()=>({listDependents:async()=>[{id:'dep-1',relationship:'child',dateOfBirth:'2015-01-01'},{id:'dep-2',relationship:'child',dateOfBirth:'2018-01-01'}],
 eligibleChildReliefCount:(rows:unknown[])=>{fx.calls.push(['eligibleChildReliefCount',rows.length]);return rows.length;}}));
vi.mock('../packs/performance/service',()=>({myReviews:async()=>[{reviewId:'rv-ready',cycleName:'Fictional 2026 H1',status:'submitted',released:true,overallRating:4,finalScore:'88.50',periodEnd:'2026-06-30'},
 {reviewId:'rv-unreleased',status:'submitted',released:false,periodEnd:'2026-06-30'},{reviewId:'rv-done',status:'acknowledged',released:true,periodEnd:'2025-12-31'}]}));
vi.mock('../packs/lifecycle/service',()=>({onboardingMyAcknowledgements:async()=>[{id:'case-ob',revision:'1',name:'Aina Fictional',employeeId:'E-1',joinDate:'2026-03-02',number:'ON-1',available:true,submittedAt:null},
 {id:'case-done',joinDate:'2026-03-02',available:true,submittedAt:'2026-03-05T01:00:00.000Z'},{id:'case-later',joinDate:'2026-03-02',available:false,submittedAt:null}]}));
vi.mock('../core/notice',()=>({pendingNoticeAcknowledgementTasks:async()=>[{noticeId:'notice-1',employmentId:'emp-own',title:'Fictional notice',contentVersion:3,sourceUpdatedAt:new Date('2026-11-04T01:00:00Z')}]}));
vi.mock('../core/approvals-inbox',()=>({listPendingTasks:async(...args:unknown[])=>{fx.calls.push(['listPendingTasks',...args.slice(1)]);failing('approvals');return [
 {id:'t-leave',kind:'leave',subjectName:'Siti Fictional',createdAt:'2026-11-05T01:00:00.000Z',linkPath:'/approvals?section=leave&focus=t-leave'},
 {id:'t-cancel',kind:'leaveCancellation',subjectName:'Wei Fictional',createdAt:'2026-11-05T01:00:00.000Z',linkPath:'/approvals?section=leave-cancellation&focus=t-cancel'},
 {id:'t-att',kind:'attendance',subjectName:'Siti Fictional',createdAt:'2026-11-06T01:00:00.000Z',linkPath:'/approvals?section=attendance&focus=t-att'},
 {id:'t-claim',kind:'claim',subjectName:'Wei Fictional',createdAt:'2026-11-06T01:00:00.000Z',linkPath:'/approvals?section=claims&focus=t-claim'},
 {id:'t-toil',kind:'replacementLeave',subjectName:'Siti Fictional',createdAt:'2026-11-07T01:00:00.000Z',linkPath:'/approvals?section=replacement&focus=t-toil'},
 {id:'t-profile',kind:'profile',subjectName:'Wei Fictional',createdAt:'2026-11-07T01:00:00.000Z',linkPath:'/admin/personnel/profile-changes'}];}}));

import {readMyPayrollReadiness} from '../core/pre-salary/person-items';
import {NOT_COVERED,askMyPayrollReadiness} from '../core/pre-salary/ask';
import {ALL_PAYROLL_ITEM_KINDS,type PayrollItem} from '../lib/pre-salary/items';
import {DisclosureLedger,discloseToolOutput} from '../core/harness/disclosure';
import type {SessionContext} from '../db/client';

const CTX={tenantId:'00000000-0000-4000-8000-000000000001',userId:'00000000-0000-4000-8000-000000000002',personId:'00000000-0000-4000-8000-000000000003',roles:['employee']} as SessionContext;
const TODAY='2026-11-10';
const read=()=>readMyPayrollReadiness(CTX,{today:TODAY,locale:'en'});
const brief=(rows:readonly PayrollItem[])=>rows.map(row=>[row.kind,row.state,row.date,row.due,row.action.kind==='confirm'?'confirm:'+row.action.caseId:row.action.kind==='answer'?'answer:'+row.action.href:row.action.href]);
beforeEach(()=>{fx.cutOffRow=true;fx.cutOffDay=20;fx.modules={};fx.fail=new Set();fx.calls=[];fx.own=true;fx.gaps=null;fx.tp3Answer=null;fx.subjectGate=null;fx.subjectFails=false;});

describe('the person\'s own items, every kind',()=>{
 it('lists each pending thing with its state, day, due date and one action, the most urgent first',async()=>{
  const result=(await read())!;
  expect(result.period).toEqual({payPeriod:'2026-11',start:'2026-10-20',cutOff:'2026-11-19',source:'company'});
  const C='2026-11-19';
  expect(brief(result.items)).toEqual([
   // To do: the soonest due first (a draft claim whose receipt window closes on 15 November), then by day.
   ['claim_deadline','todo','2026-10-01','2026-11-15','/claims?draft=cl-near'],
   ['onboarding_acknowledge','todo','2026-03-02',C,'/lifecycle/acknowledgement?case=case-ob'],
   ['review_acknowledge','todo','2026-06-30',C,'/me/performance'],
   ['leave_certificate_missing','todo','2026-10-27',C,'/leave'],
   ['letter_acknowledge','todo','2026-11-02',C,'/me/letters/letter-1'],
   ['missed_clock_out','todo','2026-11-03',C,'confirm:case-1'],
   ['missed_clock_in','todo','2026-11-04',C,'/attendance/requests?section=incomplete&fix=2026-11-04'],
   ['notice_acknowledge','todo','2026-11-04',C,'/notices/notice-1?employmentId=emp-own'],
   ['absent_no_leave','todo','2026-11-05',C,'/attendance/requests?section=absent&fix=2026-11-05'],
   ['claim_receipt_missing','todo','2026-11-08',C,'/claims?draft=cl-receipt'],
   // The same day: attendance before claims (the checklist's own group order).
   ['missed_clock_out','todo','2026-11-09',C,'/attendance/requests?section=incomplete&fix=2026-11-09'],
   ['claim_draft','todo','2026-11-09',C,'/claims?draft=cl-draft'],
   ['claim_draft','todo','2026-11-09',C,'/claims?draft=cl-has'],
   ['bank_missing','todo',null,C,'/me?tab=bankStatutory#section-request-bankStatutory'],
   ['tax_number_missing','todo',null,C,'/me?tab=bankStatutory#section-request-bankStatutory'],
   ['epf_number_missing','todo',null,C,'/me?tab=bankStatutory#section-request-bankStatutory'],
   ['tp1_draft','todo',null,C,'/me/tax-relief'],
   // Check: worth a look, may need nothing. The TP3 item asks its one-tap question until the person answers it.
   ['tp3_new_joiner','check','2026-03-02',C,'answer:/me/tp3'],
   ['leave_unpaid','check','2026-11-04',C,'/leave'],
   ['late_or_early','check','2026-11-06',C,'/attendance/requests?section=short&fix=2026-11-06'],
   ['overtime_over_cap','check',null,C,'/attendance/plan-ot'],
   // Three children declared for tax relief; the Family register counts two eligible.
   ['dependants_mismatch','check',null,C,'/me?tab=family'],
   // Waiting: the person acted; someone else decides.
   ['toil_pending','waiting','2026-11-01',C,'/leave/credit'],
   ['attendance_request_pending','waiting','2026-11-02',C,'/attendance/request-status'],
   ['claim_pending','waiting','2026-11-03',C,'/claims'],
   ['overtime_pending','waiting','2026-11-08',C,'/attendance/plan-ot'],
   ['leave_pending','waiting','2026-11-12',C,'/leave'],
   ['details_request_pending','waiting',null,C,'/me?tab=bankStatutory#section-request-bankStatutory'],
   ['tp1_pending','waiting',null,C,'/me/tax-relief'],
  ]);
  // TP1 is read for this year only.
  expect(fx.calls).toContainEqual(['listMyTp1Declarations',{assessmentYear:2026}]);
  // The leave and claim type names are the person's own; leave keeps its last day.
  expect(result.items.find(row=>row.kind==='leave_pending')).toMatchObject({label:'Annual Leave',date:'2026-11-12',endDate:'2026-11-13'});
  expect(result.items.find(row=>row.kind==='claim_receipt_missing')).toMatchObject({label:'Parking'});
  // The one-tap action is the loop's own card, with the facts it shows.
  expect(result.items.find(row=>row.kind==='missed_clock_out'&&row.action.kind==='confirm')!.action).toEqual({kind:'confirm',card:'clockOut',caseId:'case-1',date:'2026-11-03',
   checkIn:'09:00',proposedCheckOut:'18:00',href:'/attendance/my-records/2026-11-03?checkOut=18%3A00'});
  // The attendance window is the payroll period up to yesterday.
  expect(fx.calls).toContainEqual(['attendanceForEmploymentRange','emp-own','2026-10-20','2026-11-09']);
 });

 it('lists the decisions waiting on the person as an approver, one per request, and none of the other queues',async()=>{
  const result=(await read())!;
  expect(result.approvals.map(row=>[row.kind,row.label,row.due,row.action.kind==='open'?row.action.href:null])).toEqual([
   ['approve_leave','Siti Fictional','2026-11-19','/approvals?section=leave&focus=t-leave'],
   ['approve_leave_cancellation','Wei Fictional','2026-11-19','/approvals?section=leave-cancellation&focus=t-cancel'],
   ['approve_attendance','Siti Fictional','2026-11-19','/approvals?section=attendance&focus=t-att'],
   ['approve_claim','Wei Fictional','2026-11-19','/approvals?section=claims&focus=t-claim'],
   ['approve_toil','Siti Fictional','2026-11-19','/approvals?section=replacement&focus=t-toil']]);
  // Approvals only, never notice acknowledgements, and the approvals owner's own company filter.
  expect(fx.calls.find(call=>call[0]==='listPendingTasks')).toEqual(['listPendingTasks',undefined,{attendance:true,claims:true,performance:false,rewards:false},{noticeAcknowledgements:false}]);
 });

 it('asks a joiner once whether they worked for another employer earlier this year: No removes the TP3 item, Yes keeps it with its link',async()=>{
  const tp3=async()=>(await read())!.items.filter(row=>row.kind==='tp3_new_joiner');
  // Not answered yet: the item is the question, about the person's own employment and this assessment year.
  expect((await tp3()).map(row=>row.action)).toEqual([{kind:'answer',card:'tp3PreviousEmployer',employmentId:'emp-own',year:2026,href:'/me/tp3'}]);
  expect(fx.calls).toContainEqual(['tp3Answer',2026]);
  // No: a fresh graduate is not a TP3 case, so nothing is left to do about it.
  fx.tp3Answer='no';
  expect(await tp3()).toEqual([]);
  // Yes: the TP3 item stays, opening the TP3 form.
  fx.tp3Answer='yes';
  expect((await tp3()).map(row=>[row.state,row.action])).toEqual([['check',{kind:'open',href:'/me/tp3'}]]);
  // The Ask read gives the question's page as Today, where it is answered, and no Confirm card.
  fx.tp3Answer=null;
  const ask=await askMyPayrollReadiness(CTX,{companyId:'00000000-0000-4000-8000-0000000000c1',locale:'en'});
  expect(ask.ok&&(ask as unknown as {items:{kind:string;page:string;confirmCard:boolean}[]}).items.filter(row=>row.kind==='tp3_new_joiner')).toEqual([{kind:'tp3_new_joiner',page:'/',confirmCard:false,
   group:'details',state:'check',date:'2026-03-02',due:'2026-11-19'}]);
 });

 it('covers every declared kind, with all five details gaps when none was sent yet',async()=>{
  const first=(await read())!;
  fx.gaps=['no_bank_account','no_tax_number','no_epf_number','no_socso_number','no_identity'].map(gap=>({gap,type:'submit_correction',audience:'employee',tab:'bankStatutory',requestId:null,approver:'admin'}));
  const second=(await read())!;
  expect(second.items.filter(row=>row.group==='details').map(row=>row.kind)).toEqual(['bank_missing','tax_number_missing','epf_number_missing','socso_number_missing','identity_missing','tp1_draft',
   'tp3_new_joiner','dependants_mismatch','tp1_pending']);
  const seen=new Set([...first.items,...first.approvals,...second.items].map(row=>row.kind));
  expect(ALL_PAYROLL_ITEM_KINDS.filter(kind=>!seen.has(kind))).toEqual([]);
 });

 it('marks each group done or not for the month',async()=>{
  expect((await read())!.groups.map(row=>[row.group,row.status])).toEqual([['attendance','todo'],['overtime','waiting'],['leave','todo'],['claims','todo'],['toil','waiting'],
   ['details','todo'],['acknowledge','todo'],['approvals','todo']]);
 });
});

describe('the cut-off is the payroll owner\'s',()=>{
 it('for the person\'s own employment: the owner\'s window for the cut-off day the database returns for it',async()=>{
  await read();
  expect(fx.calls.filter(call=>call[0]==='ownCutOff')).toHaveLength(1);
  // Phase 2 hardening: the salary window, and each input type's own window from the company's per-type cut-off days (none
  // set here), all for the same pay period: the Pre-salary loop's own resolution (core/loops/payroll-inputs.ts).
  const company={cutOffDay:20,attendanceCutOffDay:null,overtimeCutOffDay:null,claimCutOffDay:null,unpaidLeaveCutOffDay:null,payDay:null};
  expect(fx.calls.filter(call=>call[0]==='cutOffWindowFor')).toEqual(['salary','attendance','overtime','claim','leave'].map(type=>['cutOffWindowFor',type,null,company,'2026-11']));
 });
 it('moves to the next period once this one\'s cut-off has passed',async()=>{
  const result=(await readMyPayrollReadiness(CTX,{today:'2026-11-25'}))!;
  expect(result.period).toEqual({payPeriod:'2026-12',start:'2026-11-20',cutOff:'2026-12-19',source:'company'});
 });
 it('with no cut-off day set: the owner\'s month end',async()=>{
  fx.cutOffDay=null;
  expect((await read())!.period).toEqual({payPeriod:'2026-11',start:'2026-11-01',cutOff:'2026-11-30',source:'month_end'});
 });
 it('with no answer (no own current employment): the calendar month and no date, and no window is computed',async()=>{
  fx.cutOffRow=false;
  const result=(await read())!;
  expect(result.period).toEqual({payPeriod:'2026-11',start:'2026-11-01',cutOff:null,source:'unavailable'});
  expect(fx.calls.some(call=>call[0]==='cutOffWindowFor')).toBe(false);
  // With no cut-off date, only a draft claim's own receipt deadline is a due date (the incurred day plus 45 days).
  expect(result.items.filter(row=>row.due!==null).map(row=>[row.kind,row.due])).toEqual([['claim_deadline','2026-11-15'],['claim_receipt_missing','2026-12-23'],
   ['claim_draft','2026-12-24'],['claim_draft','2026-12-24']]);
  expect(fx.calls).toContainEqual(['attendanceForEmploymentRange','emp-own','2026-11-01','2026-11-09']);
 });
});

describe('no pay figure',()=>{
 it('copies no amount, limit, balance, salary, minutes or day count from any owner',async()=>{
  const text=JSON.stringify(await read());
  for(const figure of ['1234.56','9876.54','7777.77','2500.5','1111.11','514012345678','Maybank','88.50','6300','6240','6000','180','150','480','totalDays','totalHours','amount','balance','Rating','Fictional typed words','Fictional reason'])
   expect(text,figure).not.toContain(figure);
  const ask=JSON.stringify(await askMyPayrollReadiness(CTX,{companyId:'co-1',locale:'en'}));
  for(const figure of ['1234.56','9876.54','7777.77','6300','6240'])expect(ask,figure).not.toContain(figure);
 });
});

describe('honest states',()=>{
 it('an owner that fails is "could not check", never done, and the rest still shows',async()=>{
  fx.fail.add('leave');fx.fail.add('approvals');
  const result=(await read())!;
  expect(result.failed).toBe(true);
  expect(result.groups.find(row=>row.group==='leave')!.status).toBe('unknown');
  expect(result.groups.find(row=>row.group==='approvals')!.status).toBe('unknown');
  expect(result.items.some(row=>row.group==='leave')).toBe(false);
  expect(result.items.some(row=>row.kind==='missed_clock_in')).toBe(true);
 });
 it('a module not in use is off; no payroll at all means no checklist',async()=>{
  fx.modules={claims:false,toil:false};
  const result=(await read())!;
  expect(result.groups.filter(row=>row.status==='off').map(row=>row.group)).toEqual(['claims','toil']);
  expect(result.items.some(row=>row.group==='claims'||row.group==='toil')).toBe(false);
  fx.modules={payroll:false};
  expect(await read()).toBeNull();
 });
 it('someone with no own employment gets only the approvals waiting on them',async()=>{
  fx.own=false;
  const result=(await read())!;
  expect(result.items).toEqual([]);
  expect(result.period.source).toBe('unavailable');
  expect(result.approvals.map(row=>row.kind)).toEqual(['approve_leave','approve_leave_cancellation','approve_attendance','approve_claim','approve_toil']);
  expect(result.groups.filter(row=>row.status!=='off').map(row=>row.group)).toEqual(['approvals']);
 });
 it('an agent session or a session with no login reads nothing',async()=>{
  expect(await readMyPayrollReadiness({...CTX,agent:{principalId:'x'}} as never,{today:TODAY})).toBeNull();
  expect(await readMyPayrollReadiness({...CTX,userId:undefined} as never,{today:TODAY})).toBeNull();
 });
});

describe('AI Centre navigation speed: the approvals read runs while the employment and period are read',()=>{
 it('asks the approvals owner before the person\'s own employment is known, with the same call and the same result',async()=>{
  let release!:()=>void;fx.subjectGate=new Promise<void>(resolve=>{release=resolve;});
  const pending=read();
  await new Promise(resolve=>setTimeout(resolve,0));
  // The approvals owner is asked first and, while the employment read waits, the period (it needs the employment) is not.
  expect(fx.calls.map(call=>call[0])).toEqual(['listPendingTasks','requireOwnHomeSubject']);
  release();
  const result=(await pending)!;
  expect(fx.calls.filter(call=>call[0]==='listPendingTasks')).toEqual([['listPendingTasks',undefined,{attendance:true,claims:true,performance:false,rewards:false},{noticeAcknowledgements:false}]]);
  expect(fx.calls.filter(call=>call[0]==='ownCutOff')).toHaveLength(1);
  // Due by the salary cut-off the period read returned afterwards, as before.
  expect(result.approvals.map(row=>[row.kind,row.due])).toEqual([['approve_leave','2026-11-19'],['approve_leave_cancellation','2026-11-19'],
   ['approve_attendance','2026-11-19'],['approve_claim','2026-11-19'],['approve_toil','2026-11-19']]);
  expect(result.groups.find(row=>row.group==='approvals')).toEqual({group:'approvals',status:'todo'});
 });
 it('a failed approvals read is still "could not check" once the rest is known',async()=>{
  fx.fail.add('approvals');
  const result=(await read())!;
  expect(result.approvals).toEqual([]);
  expect(result.groups.find(row=>row.group==='approvals')).toEqual({group:'approvals',status:'unknown'});
  expect(result.failed).toBe(true);
 });
 it('an employment read that throws still throws, and the approvals read already started leaves nothing unhandled',async()=>{
  fx.subjectFails=true;fx.fail.add('approvals');
  await expect(read()).rejects.toThrow('Fictional employment read failure');
  expect(fx.calls.map(call=>call[0])).toEqual(['listPendingTasks','requireOwnHomeSubject']);
  // Give the settled approvals read time to finish: an unhandled rejection would fail this file.
  await new Promise(resolve=>setTimeout(resolve,0));
 });
});

describe('the Ask read my_payroll_readiness under harness disclosure',()=>{
 it('declares every field it returns, sends no id or link with an id, counts approvals without names and withholds health-indicative labels',async()=>{
  const outcome=await askMyPayrollReadiness(CTX,{companyId:'co-1',locale:'en'});
  expect(outcome.ok).toBe(true);
  const ledger=new DisclosureLedger('me');
  const {value,applied}=discloseToolOutput('my_payroll_readiness','payroll_readiness',outcome,ledger);
  expect(applied.undeclared).toEqual([]);expect(applied.removed).toEqual([]);
  const text=JSON.stringify(value);
  for(const id of ['cl-near','case-1','case-ob','letter-1','notice-1','rv-ready','tp1-draft','emp-own','t-leave','corr-1','toil-1','req-1','co-1'])expect(text,id).not.toContain(id);
  // Other people are never named: approvals leave as counts of each kind.
  expect(text).not.toMatch(/Siti|Wei/);
  expect((outcome as unknown as {approvals:unknown}).approvals).toEqual([{kind:'approve_leave',count:1,due:'2026-11-19',page:'/approvals'},{kind:'approve_leave_cancellation',count:1,due:'2026-11-19',page:'/approvals'},
   {kind:'approve_attendance',count:1,due:'2026-11-19',page:'/approvals'},{kind:'approve_claim',count:1,due:'2026-11-19',page:'/approvals'},{kind:'approve_toil',count:1,due:'2026-11-19',page:'/approvals'}]);
  // "Medical Leave" names a health matter: it leaves as a placeholder, restored for the person.
  expect(text).not.toContain('Medical Leave');expect(applied.withheld.some(path=>/^items\[\d+\]\.label$/.test(path))).toBe(true);
  // The page and the confirm card are said; the cut-off date is the payroll service's.
  expect(text).toContain('"page":"/attendance/requests"');expect(text).toContain('"page":"/me/letters"');expect(text).toContain('"page":"/notices"');expect(text).toContain('"confirmCard":true');expect(text).toContain('"cutOff":"2026-11-19"');
  expect(text).toContain('core/pre-salary/person-items.ts#readMyPayrollReadiness');
 });
 it('names exactly what it cannot check, the same list the screen shows',()=>{
  expect(NOT_COVERED).toEqual(['shift swaps','roster gaps','timesheet sign-off','overtime worked but not yet applied for','pay changes to acknowledge']);
 });
 it('says plainly when payroll is not in use',async()=>{
  fx.modules={payroll:false};
  expect(await askMyPayrollReadiness(CTX,{companyId:'co-1'})).toMatchObject({ok:false,refusal:'no_data'});
 });
});
