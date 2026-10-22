import {attendancePolicyTraceBinding} from '../packs/attendance/policy-trace-binding';
import {attendancePolicyCashReplay} from '../packs/attendance/policy-cash-replay';
import {attendancePolicyDurationReplay} from '../packs/attendance/policy-duration-replay';
import {attendancePolicyPricingProposal} from '../packs/attendance/policy-pricing-proposal';
import type {CanonicalOvertimeSnapshot} from '../packs/attendance/overtime-patterns';
import {attendancePolicyCoverageProposal} from '../packs/attendance/policy-coverage';
import {materializeAttendancePolicyProposalParts as materialize,recordedAttendancePolicyProposalPartsMatch as matches} from '../packs/attendance/policy-proposal-parts';
import {describe,expect,it} from 'vitest';
import {attendancePolicyPlanInput} from '../packs/attendance/policy-plan-input';
import {attendancePolicyApprovalInput,type PolicyApprovalSourceRow,type PolicySubmissionSourceRow,type PolicyFinalReceiptSourceRow} from '../packs/attendance/policy-approval-input';
import type {AttendancePolicyExecutionContext} from '../core/attendance';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {attendancePolicySchedulePlacement} from '../core/attendance-policy-schedule';
import {attendancePolicyExecutionProposal as propose,attendancePolicyDurationExecutionProposal,attendancePolicySystemEligibleMinutes} from '../packs/attendance/policy-execution-proposal';
import {attendancePolicyDurationFormulaProjection} from '../packs/attendance/policy-formula-source';
import type {PolicyWorkInput} from '../packs/attendance/policy-work-input';
import type {PolicyFormulaInput} from '../packs/attendance/policy-formula-input';
import {prepareOvertimeStarter} from '../lib/overtime-pattern-starters';

const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const date='2026-10-23',next='2026-10-24';
function fixture(){
 const policy:AttendanceGroupPolicy={version:1,clock:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:0,earlyGraceMinutes:0,skipLatenessIfIncomplete:true},
  overtime:{enabled:true,beforeShift:true,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:true,offsetLateness:false,approval:'auto',autoMethod:'actual',rounding:{mode:'up',step:30},
   days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:id(4)}])) as AttendanceGroupPolicy['overtime']['days']}};
 const placement=attendancePolicySchedulePlacement({start:'09:00',end:'18:00',crossesMidnight:false,dailyCutoffMinutes:null,durationOnly:false,flexiDuration:false,dayType:'workday',
  breakMinutes:0,breakPeriods:null,flexibleBreakMinutes:null,otWindows:null,includeGraceInLateness:false,includeGraceInEarlyOut:false},policy);
 const context:Extract<AttendancePolicyExecutionContext,{state:'policy'}>={state:'policy',employmentId:id(6),date,companyId:id(1),timeZone:'Asia/Kuala_Lumpur',
  selected:{id:id(3),companyId:id(1),ruleId:id(2),ordinal:1,effectiveFrom:date,policy,
   activation:{epoch:1,actorUserId:id(5),recordedAt:'2026-10-22T00:00:00.000Z',reason:'Fictional prepared source composition'}},resolvedClock:policy.clock,
  schedule:{source:'default-shift',shiftId:null,ruleId:id(2),start:'09:00',end:'18:00',crossesMidnight:false,dailyCutoffMinutes:null,durationOnly:false,flexiDuration:false,normalMinutes:540,breakMinutes:0,breakPeriods:null,flexibleBreakMinutes:null},placement,
  calendar:[date,next].map(date=>({state:'known',date,companyId:id(1),dayClass:'normal',moneyDay:'workday',references:['fictional-calendar:'+date]}))};
 const work:Extract<PolicyWorkInput,{state:'known'}>={state:'known',authority:'sourceOnly',periodMinutes:4320,workedIntervals:[{from:1320,to:1500}],
  eligibleActualIntervals:[{from:1420,to:1460}],unpaidIntervals:[],lateOffsetIntervals:[],lateMinutes:0,earlyOutMinutes:0};
 // The arithmetic source only reads the actual selected definition's count direction. It never
 // executes this starting definition or claims it is activated/payment-ready.
 const definition=prepareOvertimeStarter('ot15','day','earliest');
 const formulas:Extract<PolicyFormulaInput,{state:'known'}>={state:'known',authority:'sourceOnly',references:[date,next].map(date=>({state:'known',date,
  dayClass:'normal',moneyDay:'workday',versionId:id(4),definition,definitionDigest:'a'.repeat(64),activeState:{id:id(7),sequence:1,effectiveFrom:'2026-10-22'},earningReferences:[]}))};
 return {context,work,formulas};
}
/** Pure receipt fixtures only; actual DB transition ownership is covered separately. */
function approvedPlans(f:ReturnType<typeof fixture>,windows:{from:number;to:number}[]){
 const rows:PolicyApprovalSourceRow[]=[],contracts:PolicySubmissionSourceRow[]=[],receipts:PolicyFinalReceiptSourceRow[]=[];
 const label=(minute:number)=>String(Math.floor(minute%1440/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0')+':00';
 for(const [index,window]of windows.entries()){
  const correctionId=id(100+index),requestId=id(200+index),minutes=window.to-window.from,start=label(window.from),end=label(window.to);
  const plan={version:1,basis:'startDateEarlierEndNextDay',sourceDate:f.context.date,startLabel:start,endLabel:end,
   from:window.from,to:window.to,requestedMinutes:minutes};
  rows.push({id:correctionId,tenantId:id(8),employmentId:f.context.employmentId,attendanceDate:f.context.date,
   createdAt:new Date('2026-10-22T01:00:00.000Z'),status:'approved',requestedOtMinutes:minutes,approvedOtMinutes:minutes,
   otApprovalMethod:'smaller_of',decidedByEmploymentId:id(9),decidedAt:new Date('2026-10-22T02:00:00.000Z'),
   appliedAt:null,cancelledAt:null,plannedStartTime:start,plannedEndTime:end,proposedCheckIn:null,proposedCheckOut:null,clockChanges:null});
  contracts.push({correctionId,tenantId:id(8),employmentId:f.context.employmentId,attendanceDate:f.context.date,
   companyId:f.context.companyId,kind:'epoch',visibleEpoch:1,plannedWindow:plan,manualApprovalMethod:'smaller_of',policyBinding:attendancePolicyTraceBinding(f.context),recordedAt:new Date('2026-10-22T01:00:00.000Z')});
  receipts.push({correctionId,tenantId:id(8),employmentId:f.context.employmentId,attendanceDate:f.context.date,
   companyId:f.context.companyId,workflowRequestId:requestId,actorUserId:id(9),authority:'finalWorkflowDecisionOnly',submissionEpoch:1,
   requestEvidence:{requestedMinutes:minutes,approvedMinutes:minutes,method:'smaller_of',plannedStartLabel:start,plannedEndLabel:end,checkIn:null,checkOut:null,clockChanges:null},
   workflowEvidence:{submittedManualMethod:'smaller_of',submittedPolicy:attendancePolicyTraceBinding(f.context),requestId,routingVersion:2,stageCount:1,completion:{request_id:requestId,tenant_id:id(8),actual_user_id:id(9),stage_index:0,decision:'approved',resulting_status:'approved'},participants:[],submittedPlan:plan},
   rawEvidence:null,recordedAt:new Date('2026-10-22T02:00:00.000Z')});
 }
 return attendancePolicyApprovalInput(f.context.selected,rows,contracts,receipts);
}
describe('canonical source composition into the shared policy duration proposal',()=>{
 it('uses one pre-finalization eligibility count for Manual comparisons without applying group rounding or caps twice',()=>{
  const f=fixture();f.context.selected.policy.overtime.approval='manual';
  expect(attendancePolicySystemEligibleMinutes(f.context,f.work)).toEqual({state:'known',authority:'policyActualComparisonOnly',minutes:40});
  f.context.selected.policy.overtime.days.normal.maximumMinutes=10;
  expect(attendancePolicySystemEligibleMinutes(f.context,f.work)).toMatchObject({state:'known',minutes:40});
  f.context.selected.policy.overtime.offsetLateness=true;
  if(f.work.state!=='known')throw Error('Expected known source');f.work.lateOffsetIntervals=[{from:500,to:510}];
  expect(attendancePolicySystemEligibleMinutes(f.context,f.work)).toMatchObject({state:'known',minutes:30});
  f.work.unpaidIntervals=[{from:1420,to:1430}];
  expect(attendancePolicySystemEligibleMinutes(f.context,f.work)).toMatchObject({state:'known',minutes:20});
  f.context.selected.policy.overtime.enabled=false;
  expect(attendancePolicySystemEligibleMinutes(f.context,f.work)).toMatchObject({state:'known',minutes:0});
  expect(attendancePolicySystemEligibleMinutes(f.context,undefined)).toMatchObject({state:'unavailable',reason:'workUnavailable'});
 });
 it('uses the selected formula direction and rounds once across two dates without minting extra clock coverage',()=>{
  const f=fixture(),before=structuredClone(f),result=propose(f.context,f.work,f.formulas);
  expect(result).toMatchObject({state:'proposed',authority:'proposalOnly',policyRevisionId:id(3),duration:{status:'calculated',payableMinutes:60,
   classes:[{eligibleMinutes:40,payableMinutes:60,unplacedPayableMinutes:20}],parts:[{date,allocatedPayableMinutes:20,allocations:[{from:1420,to:1440}]},{date:next,allocatedPayableMinutes:20,allocations:[{from:1440,to:1460}]}]},
   formulaParts:[{date,versionId:id(4)},{date:next,versionId:id(4)}]});
  expect(Object.hasOwn(result,'transferable')).toBe(false);expect(f).toEqual(before);
 });
 it('uses the same once-rounded duration for TOIL without cash earning references',()=>{
  const f=fixture(),durationFormula=attendancePolicyDurationFormulaProjection(f.formulas);
  const result=attendancePolicyDurationExecutionProposal(f.context,f.work,durationFormula);
  expect(result).toEqual(propose(f.context,f.work,f.formulas));
  expect(result).toMatchObject({state:'proposed',authority:'proposalOnly',duration:{status:'calculated',payableMinutes:60,
   classes:[{eligibleMinutes:40,payableMinutes:60,unplacedPayableMinutes:20}]}});
  expect(Object.hasOwn(result,'transferable')).toBe(false);
  f.context.selected.policy.overtime.approval='manual';
  expect(attendancePolicyDurationExecutionProposal(f.context,f.work,durationFormula))
   .toMatchObject({state:'unavailable',reason:'approvalReceiptRequired'});
 });
 it('uses the central latest count choice across the complete class instead of a per-date cap',()=>{
  const f=fixture();f.context.selected.policy.overtime.days.normal.maximumMinutes=10;
  for(const ref of f.formulas.references)if(ref.state==='known')ref.definition.durationAllocation='latest';
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'proposed',duration:{payableMinutes:10,
   parts:[{allocatedPayableMinutes:0,allocations:[]},{allocatedPayableMinutes:10,allocations:[{from:1450,to:1460}]}]}});
 });
 it('never upgrades an existing approval audit or scalar plan into the missing final-effect receipt',()=>{
  const f=fixture();f.context.selected.policy.overtime.approval='manual';
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'unavailable',reason:'approvalReceiptRequired'});
  f.context.selected.policy.overtime.approval='auto';
  for(const method of ['preApproved','intersect'] as const){f.context.selected.policy.overtime.autoMethod=method;
   expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'unavailable',reason:'plannedProofRequired'});}
 });
 it('refuses missing activation, incomplete work and a mismatched configured formula',()=>{
  const f=fixture();f.context.selected.activation.epoch=0;
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'unavailable',reason:'activationUnavailable'});
  f.context.selected.activation.epoch=1;
  expect(propose(f.context,undefined,f.formulas)).toMatchObject({state:'unavailable',reason:'workUnavailable'});
  const ref=f.formulas.references[0];if(ref.state!=='known')throw Error('Expected prepared reference');ref.versionId=id(9);
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'unavailable',reason:'formulaBindingMismatch'});
 });
 it('requires every used date reference and the entire calendar instead of silently accepting a partial overnight result',()=>{
  const f=fixture();f.formulas.references.pop();
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'unavailable',reason:'formulaUnavailable'});
  f.context.calendar[1]={state:'unknown',date:next,reason:'holidayDesignationUnavailable'};
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'proposed',duration:{status:'unavailable',date:next,reason:'holidayDesignationUnavailable'},formulaParts:[]});
 });
 it('does not require an unused calendar/formula date, and never defaults a missing used class direction',()=>{
  const f=fixture();f.context.selected.policy.overtime.splitAtMidnight=false;
  f.formulas.references[1]={date:next,state:'unavailable',reason:'formulaInactive'};
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'proposed',duration:{status:'calculated',payableMinutes:60},formulaParts:[{date}]});
  f.formulas.references[0]={date,state:'unavailable',reason:'formulaInactive'};
  expect(propose(f.context,f.work,f.formulas)).toMatchObject({state:'proposed',duration:{status:'unavailable',reason:'formulaAllocationUnavailable'},formulaParts:[]});
 });
});


describe('complete non-payable proposal materialization',()=>{
 const source=()=>{const f=fixture();return {source:{employmentId:f.context.employmentId,date:f.context.date},policy:f.context.selected,
  context:f.context,work:f.work,formulas:f.formulas,proposal:propose(f.context,f.work,f.formulas)};};
 it('keeps all dated parts below their parent and leaves rounded remainder on parent evidence',()=>{
  const f=source(),before=structuredClone(f),parts=materialize(f);
  expect(parts).toMatchObject([{sequence:0,calendarDate:date,versionId:id(4),rawMinutes:20,allocatedPayableMinutes:20,sourceIntervals:[{from:1420,to:1440}],durationEvidence:{authority:'proposalOnly'}},
   {sequence:1,calendarDate:next,versionId:id(4),rawMinutes:20,allocatedPayableMinutes:20,sourceIntervals:[{from:1440,to:1460}]}]);
  expect(parts?.reduce((n,row)=>n+row.allocatedPayableMinutes,0)).toBe(40);
  expect(f.proposal).toMatchObject({duration:{payableMinutes:60,classes:[{unplacedPayableMinutes:20}]}});
  expect(f).toEqual(before);parts![0].sourceIntervals[0].from=0;expect(f).toEqual(before);
  expect(Object.hasOwn(parts![0],'calculationId')).toBe(false);expect(Object.hasOwn(parts![0],'transferable')).toBe(false);
 });
 it('rejects omitted or substituted date, formula and count data by recomputing the complete proposal',()=>{
  for(const field of ['omission','formula','count'] as const){
   const f=source();if(f.proposal.state!=='proposed'||f.proposal.duration.status!=='calculated')throw Error('Expected prepared proposal');
   if(field==='omission')f.proposal.duration.parts.pop();
   if(field==='formula')f.proposal.formulaParts[0].versionId=id(9);
   if(field==='count')f.proposal.duration.parts[0].allocatedPayableMinutes=21;
   expect(materialize(f)).toBeNull();
  }
 });
 it('refuses source identity substitution and never materializes partial or unavailable proposals',()=>{
  const f=source();expect(materialize({...f,source:{...f.source,employmentId:id(9)}})).toBeNull();
  expect(materialize({...f,source:{...f.source,date:next}})).toBeNull();
  f.context.calendar[1]={state:'unknown',date:next,reason:'holidayDesignationUnavailable'};f.proposal=propose(f.context,f.work,f.formulas);
  expect(materialize(f)).toEqual([]);expect(materialize({source:f.source})).toEqual([]);
 });
});


describe('complete immutable proposal replay',()=>{
 function stored(){
  const f=fixture(),proposal=propose(f.context,f.work,f.formulas),source={id:id(8),attendanceId:id(12),tenantId:id(9),companyId:f.context.companyId,employmentId:f.context.employmentId,attendanceDate:date};
  const rows=materialize({source:{employmentId:source.employmentId,date},policy:f.context.selected,context:f.context,work:f.work,formulas:f.formulas,proposal});
  if(!rows)throw Error('Expected a complete source proposal');
  const header={id:id(10),sourceId:source.id,tenantId:source.tenantId,companyId:source.companyId,bindingKind:'attendanceGroupPolicy' as const,
   policyRevisionId:f.context.selected.id,policyPartCount:rows.length,inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64),referenceDigest:'c'.repeat(64)};
  const parts=rows.map(row=>({...row,calculationId:header.id,tenantId:source.tenantId,companyId:source.companyId,inputDigest:header.inputDigest}));
  const evidence={calculationId:header.id,tenantId:source.tenantId,companyId:source.companyId,
   inputs:{mode:'actual',assignmentId:null,patternVersionId:null,source:{tenantId:source.tenantId,employmentId:source.employmentId,
    attendanceId:source.attendanceId,date,inputDigest:header.inputDigest,approvalDigest:header.approvalDigest}},
   evidence:{attendanceGroupPolicy:f.context.selected,policyExecutionContext:f.context,policyWorkInput:f.work,policyFormulaInput:f.formulas,policyExecutionProposal:proposal,
    policyCoverage:attendancePolicyCoverageProposal({tenantId:source.tenantId,companyId:source.companyId,employmentId:source.employmentId,sourceId:source.id,calculationId:header.id,date:source.attendanceDate},proposal)}};
  // This arithmetic-only fixture has no captured-clock proof. Retain the canonical
  // explicit replay/pricing refusals, just as the immutable writer does for staging.
  const snapshot={input:evidence.inputs,resolvedLegacyRuleId:null,referenceDigest:header.referenceDigest,attendanceGroupPolicy:f.context.selected,
   policyExecutionContext:f.context,policyWorkInput:f.work,policyFormulaInput:f.formulas,policyExecutionProposal:proposal} as unknown as CanonicalOvertimeSnapshot;
  const completeEvidence={...evidence,evidence:{...evidence.evidence,
   policyDurationReplay:attendancePolicyDurationReplay(snapshot),policyCashReplay:attendancePolicyCashReplay(snapshot),policyPricingProposal:attendancePolicyPricingProposal(snapshot)}};
  expect(completeEvidence.evidence.policyDurationReplay.state).toBe('unavailable');
  expect(completeEvidence.evidence.policyPricingProposal.state).toBe('unavailable');
  return {source,header,parts,evidence:completeEvidence};
 }
 it('accepts the entire exact historical proposal without mutating it or granting transfer authority',()=>{
  const f=stored(),before=structuredClone(f);expect(matches(f.source,f.header,f.evidence,f.parts)).toBe(true);expect(f).toEqual(before);
  expect(Object.hasOwn(f.evidence,'transferable')).toBe(false);
 });
 it('rejects omission, reordering and every changed parent binding',()=>{
  const f=stored();expect(matches(f.source,f.header,f.evidence,f.parts.slice(0,1))).toBe(false);
  expect(matches(f.source,f.header,f.evidence,[...f.parts].reverse())).toBe(false);
  for(const field of ['sourceId','tenantId','companyId','policyRevisionId','inputDigest','approvalDigest','referenceDigest'] as const){
   expect(matches(f.source,{...f.header,[field]:id(11)},f.evidence,f.parts)).toBe(false);
  }
  expect(matches({...f.source,employmentId:id(11)},f.header,f.evidence,f.parts)).toBe(false);
 });
 it('refuses changed stored business fields instead of accepting a valid digest alone',()=>{
  for(const field of ['tenantId','companyId','calculationId','inputDigest','versionId','calendarDate','dayClass','rawMinutes','allocatedPayableMinutes','calendarReferences','sourceIntervals','durationEvidence'] as const){
   const f=stored(),row=f.parts[0];
   const changed={...row,[field]:typeof row[field]==='number'?999:Array.isArray(row[field])?[]:'substituted'};
   expect(matches(f.source,f.header,f.evidence,[changed,...f.parts.slice(1)] as typeof f.parts)).toBe(false);
  }
 });
 it('refuses absent or altered immutable physical coverage, including an unavailable rounded-count reason',()=>{
  const f=stored();expect(matches(f.source,f.header,{...f.evidence,evidence:{...f.evidence.evidence,policyCoverage:undefined}},f.parts)).toBe(false);
  expect(matches(f.source,f.header,{...f.evidence,evidence:{...f.evidence.evidence,policyCoverage:{state:'prepared',authority:'coverageProposalOnly',intervals:[]}}},f.parts)).toBe(false);
 });
 it('refuses inconsistent stored source evidence and malformed JSON as one unavailable parent',()=>{
  const f=stored();expect(matches(f.source,f.header,null,f.parts)).toBe(false);
  expect(matches(f.source,f.header,{...f.evidence,evidence:{...f.evidence.evidence,policyWorkInput:null}},f.parts)).toBe(false);
  expect(matches(f.source,f.header,{...f.evidence,evidence:{...f.evidence.evidence,policyExecutionProposal:{}}},f.parts)).toBe(false);
  expect(matches(f.source,f.header,{...f.evidence,inputs:{...f.evidence.inputs,source:{...f.evidence.inputs.source,attendanceId:id(11)}}},f.parts)).toBe(false);
  expect(matches(f.source,f.header,{...f.evidence,calculationId:id(11)},f.parts)).toBe(false);
 });
});


describe('complete positioned-plan source and shared duration replay',()=>{
 it('unions overlapping approved windows before counting and retains every distinct workflow reference',()=>{
  const f=fixture();f.context.selected.policy.overtime.autoMethod='preApproved';
  const approvals=approvedPlans(f,[{from:1410,to:1470},{from:1425,to:1485}]);
  expect(attendancePolicyPlanInput(f.context,approvals,id(8))).toMatchObject({state:'known',intervals:[{from:1410,to:1485}],references:[{correctionId:id(100)},{correctionId:id(101)}]});
  const result=propose(f.context,f.work,f.formulas,approvals,id(8));
  expect(result).toMatchObject({state:'proposed',duration:{status:'calculated',intervalBasis:'approvedPlan',payableMinutes:75}});
 });
 it('binds redundant approval references even when omitting one would leave the same normalized minutes',()=>{
  const f=fixture();f.context.selected.policy.overtime.autoMethod='preApproved';
  const approvals=approvedPlans(f,[{from:1410,to:1470},{from:1420,to:1460}]);
  const proposal=propose(f.context,f.work,f.formulas,approvals,id(8));
  const input={source:{employmentId:f.context.employmentId,date:f.context.date,tenantId:id(8)},policy:f.context.selected,
   context:f.context,work:f.work,formulas:f.formulas,approvals,proposal};
  expect(materialize(input)).toHaveLength(2);
  const omitted=structuredClone(approvals);omitted.requests.pop();
  expect(materialize({...input,approvals:omitted})).toBeNull();
 });
 it('uses real intersection: equal actual and plan counts can have no shared physical minute',()=>{
  const f=fixture();f.context.selected.policy.overtime.autoMethod='intersect';
  const approvals=approvedPlans(f,[{from:1320,to:1360}]);
  expect(propose(f.context,f.work,f.formulas,approvals,id(8))).toMatchObject({state:'proposed',duration:{status:'calculated',payableMinutes:0,parts:[]}});
  const overlap=approvedPlans(f,[{from:1410,to:1470}]);
  expect(propose(f.context,f.work,f.formulas,overlap,id(8))).toMatchObject({state:'proposed',duration:{status:'calculated',payableMinutes:60,classes:[{eligibleMinutes:40,unplacedPayableMinutes:20}]}});
 });
 it('refuses the whole set for a different tenant or inconsistent submission and final epochs',()=>{
  const f=fixture();f.context.selected.policy.overtime.autoMethod='intersect';
  const approvals=approvedPlans(f,[{from:1410,to:1470}]);
  expect(propose(f.context,f.work,f.formulas,approvals,id(99))).toMatchObject({state:'unavailable',reason:'plannedProofRequired'});
  const contract=approvals.requests[0].submissionContract;if(contract.state!=='recorded')throw Error('Expected fixture receipt');
  contract.visibleEpoch=2;
  expect(attendancePolicyPlanInput(f.context,approvals,id(8))).toMatchObject({state:'unavailable',reason:'planIdentityMismatch'});
 });
 it('uses exact submitted policy identity across a later unrelated company epoch',()=>{
  const f=fixture();f.context.selected.policy.overtime.autoMethod='preApproved';
  const approvals=approvedPlans(f,[{from:1410,to:1470}]);
  const request=approvals.requests[0],submission=request.submissionContract,final=request.finalReceipt,plan=request.positionedPlan;
  if(submission.state!=='recorded'||final.state!=='recorded'||plan.state!=='recorded')throw Error('Expected source fixture');
  submission.visibleEpoch=2;final.submissionEpoch=2;plan.submissionEpoch=2;
  expect(attendancePolicyPlanInput(f.context,approvals,id(8))).toMatchObject({state:'known',intervals:[{from:1410,to:1470}]});
  const mutate=[
   (x:typeof approvals)=>{const r=x.requests[0];if(r.submissionContract.state==='recorded')r.submissionContract.policyBinding=null;},
   (x:typeof approvals)=>{const r=x.requests[0];if(r.submissionContract.state==='recorded'&&r.submissionContract.policyBinding){
    r.submissionContract.policyBinding.revisionId=id(99);if(r.finalReceipt.state==='recorded')r.finalReceipt.workflow.submittedPolicy=structuredClone(r.submissionContract.policyBinding);}},
   (x:typeof approvals)=>{const r=x.requests[0];if(r.finalReceipt.state==='recorded')r.finalReceipt.workflow.submittedPolicy=null;},
   (x:typeof approvals)=>{const r=x.requests[0];if(r.submissionContract.state==='recorded')r.submissionContract.visibleEpoch=0;},
  ];
  for(const change of mutate){const altered=structuredClone(approvals);change(altered);
   expect(attendancePolicyPlanInput(f.context,altered,id(8))).toMatchObject({state:'unavailable',reason:'policyBindingUnavailable'});}
 });
 it('replays all planned parts and rejects a missing or altered approval source',()=>{
  const f=fixture();f.context.selected.policy.overtime.autoMethod='intersect';
  const approvals=approvedPlans(f,[{from:1410,to:1470}]),proposal=propose(f.context,f.work,f.formulas,approvals,id(8));
  const input={source:{employmentId:f.context.employmentId,date:f.context.date,tenantId:id(8)},policy:f.context.selected,
   context:f.context,work:f.work,formulas:f.formulas,approvals,proposal};
  expect(materialize(input)).toHaveLength(2);
  expect(materialize({...input,approvals:undefined})).toBeNull();
  const changed=structuredClone(approvals),plan=changed.requests[0].positionedPlan;
  if(plan.state!=='recorded')throw Error('Expected positioned fixture');plan.intervals[0].to++;
  expect(materialize({...input,approvals:changed})).toBeNull();
 });
});
