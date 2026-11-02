import {isCalendarDate} from './calendar-date';
import {addDaysIso} from './roster-month';
import {addCalendarMonths} from './hr-date';

export class ContractManagementError extends Error{
  constructor(readonly code:'invalid'|'forbidden'|'conflict',message:string){super(message);this.name='ContractManagementError';}
}
const refuse=(message:string):never=>{throw new ContractManagementError('invalid',message);};
export type ContractKind='maternity_cover'|'project'|'post_retirement';
export type ContractState='upcoming'|'decision_pending'|'in_approval'|'e_acceptance'|'records_pending'|'renewed'|'ending'|'handed_off'|'cancelled';
export type ContractSettings={
  version:number;firstAlertDays:number;reminderDays:number;decisionDueDays:number;escalationDays:number;
  signatureReminderDays:number;signatureEscalationDays:number;minimumTermMonths:number;
  expiryNeverAutoEnds:true;endApprovalEnabled:boolean;
};
export const DEFAULT_CONTRACT_SETTINGS:ContractSettings={version:1,firstAlertDays:60,reminderDays:45,decisionDueDays:40,escalationDays:35,signatureReminderDays:2,signatureEscalationDays:3,minimumTermMonths:3,expiryNeverAutoEnds:true,endApprovalEnabled:false};
export type ContractTerm={id:string;employmentId:string;companyId:string;kind:ContractKind;version:number;startOn:string;endOn:string;salaryCents:string;allowanceCents:string;sourceRevision:string};
export type ContractDecision={
  revision:number;kind:'renew'|'end';months:number|null;startOn:string|null;endOn:string;
  salaryCents:string;allowanceCents:string;reason:string;submittedBy:string;submittedAt:string;
  confirmedBy:string|null;confirmedAt:string|null;submittedPersonId?:string;confirmedPersonId?:string|null;approvalSnapshot?:ContractApprovalStep[];
};
export type ContractApprovalStep={
  id:string;name:string;stage:number;holderIds:string[];holderPersonIds?:Record<string,string>;quorum:'any'|'all';when:'always'|'pay_changed';
  state:'pending'|'approved'|'rejected'|'skipped';actions:{actorId:string;actorPersonId?:string;action:'approve'|'reject';comment:string;at:string}[];
};
export type ContractDecisionDraft={kind:'renew'|'end';months:number|null;basicSalary:string;fixedAllowance:string;reason:string;savedBy:string;savedAt:string;sourceRevision:string};
export type ContractCase={
  id:string;number:string;term:ContractTerm;revision:number;state:ContractState;settings:ContractSettings;
  decision:ContractDecision|null;requiresResubmission?:boolean;decisionDraft?:ContractDecisionDraft|null;decisionHistory:ContractDecision[];approvals:ContractApprovalStep[];
  document:{id:string;hash:string;templateId:string;templateVersion:number;decisionRevision:number;issuedAt:string|null;acceptedAt:string|null;declinedAt:string|null;declineReason:string|null}|null;
  effects:{personnel:string|null;payroll:string|null;verificationTask:string|null;offboarding:string|null;manualHandoff:string|null};
  sourceRetirementApprovalId:string|null;healthCompletedAt:string|null;retirementApproved?:boolean;
};
function day(value:string):void{if(!isCalendarDate(value))refuse('Enter a valid contract date.');}
export function contractCents(value:string):bigint{
  if(!/^(0|[1-9]\d{0,11})$/.test(value))refuse('Enter a non-negative amount with no more than two decimal places.');return BigInt(value);
}
export function parseContractAmount(value:string):string{
  if(!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value))refuse('Enter a valid RM amount with no more than two decimal places.');
  const [whole,fraction='']=value.split('.');return (BigInt(whole)*BigInt(100)+BigInt(fraction.padEnd(2,'0'))).toString();
}
export function contractPayChanged(term:ContractTerm,decision:ContractDecision):boolean{return contractCents(term.salaryCents)!==contractCents(decision.salaryCents)||contractCents(term.allowanceCents)!==contractCents(decision.allowanceCents);}
export function contractRenewalDates(endOn:string,months:number,minimum=3):{startOn:string;endOn:string}{
  day(endOn);if(!Number.isSafeInteger(months)||months<minimum||months>120)refuse('The renewal must meet the minimum contract term.');
  const startOn=addDaysIso(endOn,1);return{startOn,endOn:addDaysIso(addCalendarMonths(startOn,months),-1)};
}
export function validateContractSettings(settings:ContractSettings):void{
  if(!Number.isSafeInteger(settings.version)||settings.version<1||settings.expiryNeverAutoEnds!==true)refuse('Choose a valid contract configuration.');
  for(const n of [settings.firstAlertDays,settings.reminderDays,settings.decisionDueDays,settings.escalationDays,settings.signatureReminderDays,settings.signatureEscalationDays,settings.minimumTermMonths])if(!Number.isSafeInteger(n)||n<1||n>366)refuse('Contract timings must be positive whole numbers.');
  if(!(settings.firstAlertDays>=settings.reminderDays&&settings.reminderDays>=settings.decisionDueDays&&settings.decisionDueDays>=settings.escalationDays)||settings.minimumTermMonths<3)refuse('Check the expiry timing order and minimum renewal term.');
}
export function newContractCase(input:{id:string;number:string;term:ContractTerm;settings:ContractSettings;today:string;retirementApprovalId?:string;healthCompletedAt?:string}):ContractCase{
  validateContractSettings(input.settings);day(input.today);day(input.term.startOn);day(input.term.endOn);
  if(input.term.startOn>input.term.endOn||!input.term.sourceRevision||!Number.isSafeInteger(input.term.version)||input.term.version<1||!['maternity_cover','project','post_retirement'].includes(input.term.kind)||!/^CT-\d{4}-\d{4,}$/.test(input.number))refuse('Verify the source contract term before intake.');
  contractCents(input.term.salaryCents);contractCents(input.term.allowanceCents);
  if(input.retirementApprovalId&&input.term.kind!=='post_retirement')refuse('Only a first post-retirement contract can use retirement approval.');
  return{id:input.id,number:input.number,term:structuredClone(input.term),revision:1,state:input.today>=addDaysIso(input.term.endOn,-input.settings.firstAlertDays)?'decision_pending':'upcoming',settings:structuredClone(input.settings),decision:null,decisionHistory:[],approvals:[],document:null,effects:{personnel:null,payroll:null,verificationTask:null,offboarding:null,manualHandoff:null},sourceRetirementApprovalId:input.retirementApprovalId??null,healthCompletedAt:input.healthCompletedAt??null};
}
export function proposeContractDecision(record:ContractCase,input:{kind:'renew'|'end';months:number|null;salaryCents:string;allowanceCents:string;reason:string;actorId:string;at:string}):ContractCase{
  if(!['upcoming','decision_pending'].includes(record.state))throw new ContractManagementError('conflict','Return the current approval before changing the decision.');
  if(!input.reason.trim()||!input.actorId||!Number.isFinite(Date.parse(input.at)))refuse('A reason and verified decision-maker are required.');
  contractCents(input.salaryCents);contractCents(input.allowanceCents);
  const dates=input.kind==='renew'?contractRenewalDates(record.term.endOn,input.months??0,record.settings.minimumTermMonths):{startOn:null,endOn:record.term.endOn};
  const decision:ContractDecision={revision:(record.decision?.revision??0)+1,kind:input.kind,months:input.kind==='renew'?input.months:null,...dates,salaryCents:input.salaryCents,allowanceCents:input.allowanceCents,reason:input.reason.trim(),submittedBy:input.actorId,submittedAt:input.at,confirmedBy:null,confirmedAt:null};
  return{...record,revision:record.revision+1,state:'decision_pending',requiresResubmission:false,decision,decisionHistory:record.decision?[...record.decisionHistory,{...record.decision,approvalSnapshot:structuredClone(record.approvals)}]:record.decisionHistory,approvals:[],document:null};
}
export function confirmContractDecision(record:ContractCase,input:{actorId:string;at:string;steps:ContractApprovalStep[]}):ContractCase{
  const decision=record.decision;if(!decision||record.state!=='decision_pending'||record.requiresResubmission)throw new ContractManagementError('conflict','There is no submitted decision to confirm.');
  if(!input.actorId||decision.kind==='renew'&&input.actorId===decision.submittedBy)throw new ContractManagementError('forbidden','A separate People BP must confirm the submitted decision.');
  const payChanged=contractPayChanged(record.term,decision),ids=new Set<string>();
  const steps=input.steps.map(s=>{
    if(!s.id||ids.has(s.id)||!s.name||!Number.isSafeInteger(s.stage)||s.stage<0||!['any','all'].includes(s.quorum)||!['always','pay_changed'].includes(s.when))refuse('Choose a valid published approval route.');ids.add(s.id);
    const skipped=s.when==='pay_changed'&&!payChanged;
    if(!skipped&&(!s.holderIds.length||new Set(s.holderIds).size!==s.holderIds.length||s.holderIds.includes(decision.submittedBy)))refuse('Resolve every required independent approver before submission.');
    return{...structuredClone(s),state:skipped?'skipped' as const:'pending' as const,actions:[]};
  });
  if(decision.kind==='renew'&&!steps.some(s=>s.state==='pending'))refuse('A renewal needs its published approval route.');
  return{...record,revision:record.revision+1,decision:{...decision,confirmedBy:input.actorId,confirmedAt:input.at},approvals:steps,state:decision.kind==='end'&&!record.settings.endApprovalEnabled?'ending':'in_approval'};
}
export function actOnContractApproval(record:ContractCase,input:{stepId:string;actorId:string;action:'approve'|'reject';comment:string;at:string;decisionRevision:number}):ContractCase{
  if(record.state!=='in_approval'||!record.decision||record.decision.revision!==input.decisionRevision)throw new ContractManagementError('conflict','The contract decision changed. Review the current terms.');
  const pending=record.approvals.filter(s=>s.state==='pending'),stage=Math.min(...pending.map(s=>s.stage));
  const step=pending.find(s=>s.id===input.stepId&&s.stage===stage);
  if(!step||!step.holderIds.includes(input.actorId)||record.decision.submittedBy===input.actorId)throw new ContractManagementError('forbidden','Only the currently assigned independent approver can act.');
  if(step.actions.some(a=>a.actorId===input.actorId))throw new ContractManagementError('conflict','Your decision is already recorded.');
  if(input.action==='reject'&&!input.comment.trim())refuse('A rejection comment is required.');
  const actions=[...step.actions,{actorId:input.actorId,action:input.action,comment:input.comment.trim(),at:input.at}];
  const state=input.action==='reject'?'rejected' as const:step.quorum==='any'||step.holderIds.every(id=>actions.some(a=>a.actorId===id&&a.action==='approve'))?'approved' as const:'pending' as const;
  const approvals=record.approvals.map(s=>s.id===step.id?{...s,state,actions}:s);
  return{...record,revision:record.revision+1,approvals,requiresResubmission:input.action==='reject'||record.requiresResubmission,state:input.action==='reject'?'decision_pending':record.state,decision:input.action==='reject'?{...record.decision,confirmedBy:null,confirmedAt:null}:record.decision};
}
export function contractApprovalsComplete(record:ContractCase):boolean{return !!record.decision?.confirmedAt&&(record.approvals.length>0||!!record.sourceRetirementApprovalId&&!!record.healthCompletedAt)&&record.approvals.every(s=>s.state==='approved'||s.state==='skipped');}
export function issueContractDocument(record:ContractCase,document:NonNullable<ContractCase['document']>):ContractCase{
  if(record.state!=='in_approval'||!contractApprovalsComplete(record)||!record.decision||document.decisionRevision!==record.decision.revision||!document.issuedAt||document.acceptedAt||document.declinedAt||!/^[a-f0-9]{64}$/.test(document.hash)||!Number.isSafeInteger(document.templateVersion)||document.templateVersion<1)throw new ContractManagementError('conflict','Complete approvals and generate the current contract before issuing it.');
  if(record.document?.issuedAt)throw new ContractManagementError('conflict','An issued contract is immutable.');
  return{...record,revision:record.revision+1,state:'e_acceptance',document:structuredClone(document)};
}
/** Caller verifies current employee identity, signature/consent and exact document hash before this. */
export function acceptContractDocument(record:ContractCase,input:{hash:string;decisionRevision:number;action:'accept'|'decline';reason:string;at:string}):ContractCase{
  if(record.state!=='e_acceptance'||!record.document||record.document.hash!==input.hash||record.document.decisionRevision!==input.decisionRevision)throw new ContractManagementError('conflict','This is not the current contract awaiting acceptance.');
  if(input.action==='decline'&&!input.reason.trim())refuse('Explain why the renewal was declined.');
  return{...record,revision:record.revision+1,state:input.action==='accept'?'records_pending':'ending',document:{...record.document,acceptedAt:input.action==='accept'?input.at:null,declinedAt:input.action==='decline'?input.at:null,declineReason:input.action==='decline'?input.reason.trim():null}};
}
export function finishContractRenewal(record:ContractCase):ContractCase{
  if(record.state!=='records_pending'||!record.document?.acceptedAt||!record.effects.personnel||!record.effects.verificationTask||record.decision&&contractPayChanged(record.term,record.decision)&&!record.effects.payroll)throw new ContractManagementError('conflict','Required record updates are still pending.');
  return{...record,revision:record.revision+1,state:'renewed'};
}
export function contractDisplayState(record:ContractCase,today:string):ContractState|'expired_unsigned'{day(today);return record.term.endOn<today&&['upcoming','decision_pending','in_approval','e_acceptance'].includes(record.state)?'expired_unsigned':record.state;}
export function contractAlertDue(record:ContractCase,today:string,activationOn:string):'first'|'reminder'|'decision_overdue'|'expired_unsigned'|null{
  day(today);day(activationOn);if(today<activationOn)return null;
  if(contractDisplayState(record,today)==='expired_unsigned')return'expired_unsigned';
  if(!['upcoming','decision_pending'].includes(record.state)||record.decision?.confirmedAt)return null;
  if(today===addDaysIso(record.term.endOn,-record.settings.firstAlertDays))return'first';
  if(today===addDaysIso(record.term.endOn,-record.settings.reminderDays))return'reminder';
  return today>addDaysIso(record.term.endOn,-record.settings.decisionDueDays)?'decision_overdue':null;
}

/** Source authority and health-check provenance are verified by the native intake owner before calling. */
export function admitApprovedRetirement(record:ContractCase,input:{approvalId:string;actorId:string;approvedAt:string;healthCompletedAt:string}):ContractCase{
 if(record.term.kind!=='post_retirement'||record.term.version!==1||record.sourceRetirementApprovalId!==input.approvalId||!input.actorId||!Number.isFinite(Date.parse(input.approvedAt))||!Number.isFinite(Date.parse(input.healthCompletedAt))||record.decision||!['upcoming','decision_pending'].includes(record.state))throw new ContractManagementError('forbidden','Verify the first approved retirement contract and completed health check.');
 return {...record,revision:record.revision+1,state:'in_approval',healthCompletedAt:input.healthCompletedAt,decision:{revision:1,kind:'renew',months:null,startOn:record.term.startOn,endOn:record.term.endOn,salaryCents:record.term.salaryCents,allowanceCents:record.term.allowanceCents,reason:'Approved first post-retirement contract',submittedBy:input.actorId,submittedAt:input.approvedAt,confirmedBy:input.actorId,confirmedAt:input.approvedAt},approvals:[]};
}
export function attachContractDraft(record:ContractCase,document:NonNullable<ContractCase['document']>):ContractCase{
 if(record.state!=='in_approval'||!record.decision?.confirmedAt||document.decisionRevision!==record.decision.revision||document.issuedAt||document.acceptedAt||document.declinedAt||record.document?.issuedAt||!/^[a-f0-9]{64}$/.test(document.hash))throw new ContractManagementError('conflict','Only the current approved decision may generate a draft contract.');
 return {...record,revision:record.revision+1,document:structuredClone(document)};
}
