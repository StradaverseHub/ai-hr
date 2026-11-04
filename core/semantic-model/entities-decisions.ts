/** AI v2 W2 (slice 3, batch 2a) — the assigned approver's decisions on claims and attendance requests, prepared in chat
 * for one Confirm (mirroring approvals.leave.decide).
 *
 * Two entities and two governed actions over the existing assigned-decision custody (ADR-0151 wave 1b):
 *  - approvals.claim.decide: approve or reject one pending expense claim the caller is assigned to decide;
 *  - approvals.attendance.decide: approve or reject one pending attendance correction or overtime request.
 * The request is someone else's (audience assigned_approver): its employee's name, date and times leave as placeholders,
 * and a claim amount as a band; free text and handles never leave. The decision and any rejection reason are the
 * approver's own words; the native services decide authority, levels, limits and effects. The chat preparer is
 * core/proposals/assigned-decide.ts. The declarations mirror their agent action registry entries
 * (test/semantic-model-drift.test.ts). */
import type {DisclosureClass,FieldType,SemanticAction,SemanticEntity,SemanticField} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'|'screen'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const decision=f('decision','enum','minimum','The approver\'s own decision.',{values:['approved','rejected']});
const note=f('note','text','never','The approver\'s own reason for a rejection, in their words.');

export const DECISION_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'claim_approval_item',label:'Claim waiting for your decision',
  meaning:'One pending expense claim by someone else that the caller is assigned to approve or reject. The claims service decides; payment is separate.',
  module:'approvals',sensitivity:'pay',audience:'assigned_approver',rls:'assigned_request',
  owners:['core/assistant-actions/assigned-decision-sources.ts#readAssignedClaimChoicesTx','core/assistant-actions/assigned-decision-sources.ts#withAssignedClaimSubjectTx'],
  ruleVersion:null,relations:[],page:'/approvals',
  fields:[f('subjectId','id','never','Handle of the claim.'),f('employmentId','id','never','Handle of the claimant\'s employment.'),
   f('employeeName','name','minimum','Who claimed.'),f('employeeCode','code','never','The claimant\'s employee code.'),
   f('claimTypeName','label','full','Claim type name.',{screen:'sensitive_label'}),f('itemName','label','full','Claim item name.',{screen:'sensitive_label'}),
   f('incurredOn','date','minimum','Date incurred.'),f('amount','number','bands','Amount as stored by the claims service.'),
   f('description','text','never','Free text the claimant typed.'),decision,note]},
 {id:'attendance_approval_item',label:'Attendance request waiting for your decision',
  meaning:'One pending attendance correction or overtime request by someone else that the caller is assigned to approve or reject at their workflow level.',
  module:'approvals',sensitivity:'ordinary',audience:'assigned_approver',rls:'assigned_request',
  owners:['core/assistant-actions/assigned-decision-sources.ts#readAssignedAttendanceChoicesTx','core/assistant-actions/assigned-decision-sources.ts#withAssignedAttendanceSubjectTx'],
  ruleVersion:null,relations:[],page:'/approvals',
  fields:[f('subjectId','id','never','Handle of the request.'),f('employmentId','id','never','Handle of the requester\'s employment.'),
   f('employeeName','name','minimum','Who asked.'),f('employeeCode','code','never','The requester\'s employee code.'),
   f('date','date','minimum','Attendance day.'),f('overtime','boolean','full','Whether it is an overtime request rather than a clock correction.'),
   f('proposedCheckIn','time','minimum','Clock-in asked for.'),f('proposedCheckOut','time','minimum','Clock-out asked for.'),
   f('plannedStartTime','time','minimum','Overtime start.'),f('plannedEndTime','time','minimum','Overtime end.'),
   f('requestedOtMinutes','integer','minimum','Overtime minutes, as the attendance service counted the window.'),
   f('reason','text','never','Free text the requester typed.'),decision,note]},
] satisfies SemanticEntity[]);

const aiControls={check:'ai_controls_unpaused',owner:'core/ai-governance.ts#assertAiActionUnpausedTx',ruleVersion:null} as const;
export const DECISION_ACTIONS:readonly SemanticAction[]=freeze([
 {id:'approvals.claim.decide',entity:'claim_approval_item',effect:'decide',module:'approvals',purpose:'Approve or reject an expense claim waiting for your decision.',
  audience:'assigned_approver',actor:'assigned_approver',service:'packs/claims/service.ts#decideClaimTx',
  guard:'core/assistant-actions/assigned-decision-sources.ts#withAssignedClaimSubjectTx',
  preparer:'core/assistant-actions/assigned-decision-sources.ts#prepareAssignedClaimSourceTx',
  checks:[aiControls,{check:'assigned_approver_current',owner:'core/approvals.ts#assertCanDecide',ruleVersion:null},
   {check:'not_own_request',owner:'core/assistant-actions/assigned-decision-sources.ts#withAssignedClaimSubjectTx',ruleVersion:null},
   {check:'request_still_pending',owner:'core/assistant-actions/assigned-decision-sources.ts#prepareAssignedClaimSourceTx',ruleVersion:null}],
  reviewRoute:'/assistant/approvals',humanInputs:['employmentId','subjectId','decision','note'],
  nominable:[],proposal:'core/proposals/assigned-decide.ts#prepareChatAssignedDecisionProposal'},
 {id:'approvals.attendance.decide',entity:'attendance_approval_item',effect:'decide',module:'approvals',purpose:'Approve or reject an attendance correction or overtime request waiting for your decision.',
  audience:'assigned_approver',actor:'assigned_approver',service:'packs/attendance/service.ts#decideAttendanceCorrection',
  guard:'core/assistant-actions/assigned-decision-sources.ts#withAssignedAttendanceSubjectTx',
  preparer:'core/assistant-actions/assigned-decision-sources.ts#prepareAssignedAttendanceSourceTx',
  checks:[aiControls,{check:'assigned_approver_current',owner:'packs/attendance/service.ts#assertCanDecideAttendanceApplicationTx',ruleVersion:null},
   {check:'not_own_request',owner:'core/assistant-actions/assigned-decision-sources.ts#withAssignedAttendanceSubjectTx',ruleVersion:null},
   {check:'request_still_pending',owner:'core/assistant-actions/assigned-decision-sources.ts#prepareAssignedAttendanceSourceTx',ruleVersion:null}],
  reviewRoute:'/assistant/approvals',humanInputs:['employmentId','subjectId','decision','note'],
  nominable:[],proposal:'core/proposals/assigned-decide.ts#prepareChatAssignedDecisionProposal'},
] satisfies SemanticAction[]);
