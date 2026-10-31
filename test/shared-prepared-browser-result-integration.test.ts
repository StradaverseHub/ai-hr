/** Actual shared protocol boundary across the composed Payroll, Organisation and Personnel reviews. */
import {describe,expect,it} from 'vitest';
import {PayrollReopenModuleActionBrowserPacket,PositionArchiveBrowserPacket,DepartmentArchiveBrowserPacket,ProfileRequestRejectionModuleActionBrowserPacket,ScheduleGroupMaintenanceModuleActionBrowserPacket,parseGenericModuleActionBrowserResult,type GenericModuleAction,type GenericModuleActionBrowserPacket} from '../lib/assistant-actions/module-action-http';
const subject='87000000-0000-4000-8000-000000000001',company='87000000-0000-4000-8000-000000000002',actionId='87000000-0000-4000-8000-000000000003',other='87000000-0000-4000-8000-000000000004';
const createdAt='2026-10-30T00:00:00.000Z',expiresAt='2026-10-30T00:10:00.000Z';
type Fixture={name:string;action:GenericModuleAction;schema:{parse(value:unknown):GenericModuleActionBrowserPacket&{action:GenericModuleAction}};input:Record<string,unknown>;detail:Record<string,unknown>;consequence?:string};
const fixtures:Fixture[]=[
 {name:'Payroll reopening',action:'payroll.reopen',schema:PayrollReopenModuleActionBrowserPacket,
  input:{action:'payroll.reopen',contractVersion:1,batchId:subject,reason:'Correct the reviewed run.',confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true},
  detail:{batchId:subject,companyId:company,companyName:'Fictional Company',payPeriodId:other,payPeriod:'2026-09',runType:'regular',runSeq:1,cycleName:null,beforeStatus:'closed',afterStatus:'processed',beforePeriodStatus:'closed',afterPeriodStatus:'open',parentWillReopen:true,warnings:{paymentDisbursed:true,statutoryFiled:false,statutoryFiledCount:0,statutoryReportCount:2},paymentWarningMeaning:'recorded_payment_summary_export_not_verified_bank_settlement',consequence:'enable_later_payroll_edits_no_recalculation_payment_reversal_or_statutory_withdrawal'}},
 {name:'Organisation position',action:'org.position.archive',schema:PositionArchiveBrowserPacket,
  input:{action:'org.position.archive',contractVersion:1,positionId:subject,expectedArchived:false,archived:true},
  detail:{positionId:subject,companyId:company,companyName:'Fictional Company',title:'Fictional Position',archived:false,afterArchived:true},consequence:'catalogue_archive_state_only_no_assignment_or_access_change'},
 {name:'Organisation department',action:'org.department.archive',schema:DepartmentArchiveBrowserPacket,
  input:{action:'org.department.archive',contractVersion:1,departmentId:subject,expectedArchived:false,archived:true},
  detail:{departmentId:subject,companyId:company,companyName:'Fictional Company',name:'Fictional Department',archived:false,afterArchived:true},consequence:'catalogue_archive_state_only_no_assignment_or_access_change'},
 {name:'Personnel rejection',action:'employees.profile_request.reject',schema:ProfileRequestRejectionModuleActionBrowserPacket,
  input:{action:'employees.profile_request.reject',contractVersion:1,employmentId:subject,subjectId:other,reason:'Please correct the details.'},
  detail:{employmentId:subject,subjectId:other,employeeName:'Fictional Dana',employeeCode:'FIC-1',companyName:'Fictional Company',requestedAt:'2026-10-29T00:00:00.000Z',fieldIds:['profile.personal_details.preferredname'],before:{status:'pending',reason:null},after:{status:'rejected',reason:'Please correct the details.'}},consequence:'request_rejected_reason_shared_with_employee_no_profile_fields_applied'},
 {name:'Attendance Schedule Group',action:'attendance.schedule_group.maintain',schema:ScheduleGroupMaintenanceModuleActionBrowserPacket,
  input:{action:'attendance.schedule_group.maintain',contractVersion:1,employmentId:subject,subjectId:subject,expectedGroupId:other,attendanceRuleId:null},
  detail:{employmentId:subject,subjectId:subject,employeeName:'Fictional Dana',employeeCode:'FIC-1',companyName:'Fictional Company',before:{id:other,name:'Fictional Group'},after:null,onDate:'2026-10-30'},consequence:'current_schedule_group_changed_native_shift_compatibility_checked'},
];
const packet=(f:Fixture)=>f.schema.parse({action:f.action,operation:'prepare',input:f.input});
const prepared=(f:Fixture)=>({kind:'prepared',review:{action:f.action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64),createdAt,expiresAt,content:structuredClone(f.input),review:structuredClone(f.detail),...(f.consequence?{consequence:f.consequence}:{})}});
describe.each(fixtures)('$name through the actual shared prepared-result parser',f=>{
 it('accepts its exact prepare and same-ID reopen, without inventing another kind of subject',()=>{
  const value=prepared(f);expect(parseGenericModuleActionBrowserResult(packet(f),value)).toEqual(value);
  const reopen=f.schema.parse({action:f.action,operation:'reopen',actionId});expect(parseGenericModuleActionBrowserResult(reopen,value)).toEqual(value);
  expect(()=>parseGenericModuleActionBrowserResult(f.schema.parse({action:f.action,operation:'reopen',actionId:other}),value)).toThrow();
 });
 it('refuses every other composed review kind',()=>{for(const foreign of fixtures.filter(row=>row.action!==f.action))expect(()=>parseGenericModuleActionBrowserResult(packet(f),prepared(foreign))).toThrow();});
 it('refuses equal, reversed and malformed review chronology',()=>{
  for(const expiry of [createdAt,'2026-10-29T23:59:59.000Z','not-a-date']){const value=prepared(f);value.review.expiresAt=expiry;expect(()=>parseGenericModuleActionBrowserResult(packet(f),value)).toThrow();}
 });
 it('refuses unknown fields at the envelope, human content and exact reviewed consequence',()=>{
  const value=prepared(f);for(const forged of [{...value,executor:'model'},{...value,review:{...value.review,content:{...value.review.content,force:true}}},{...value,review:{...value.review,review:{...value.review.review,privateRouting:subject}}}])expect(()=>parseGenericModuleActionBrowserResult(packet(f),forged)).toThrow();
 });
});
it('binds Payroll to the true reviewed batch, including a coherent foreign substitution against the original nomination',()=>{
 const f=fixtures[0],differentReview=prepared(f);differentReview.review.review.batchId=other;
 expect(()=>parseGenericModuleActionBrowserResult(packet(f),differentReview)).toThrow();
 const coherentForeign=prepared(f);coherentForeign.review.content.batchId=other;coherentForeign.review.review.batchId=other;
 expect(()=>parseGenericModuleActionBrowserResult(packet(f),coherentForeign)).toThrow();
 // A genuinely selected second batch is valid; rejecting every Payroll shape cannot satisfy this witness.
 const selected={...f,input:{...f.input,batchId:other},detail:{...f.detail,batchId:other}};
 expect(parseGenericModuleActionBrowserResult(packet(selected),prepared(selected)).kind).toBe('prepared');
});
