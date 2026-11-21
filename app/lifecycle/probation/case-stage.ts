import type {ProbationCaseView,ProbationPartView} from '@/packs/probation/service';
import {pendingSigningSteps,type SigningStep} from '@/lib/document-signing-model';
/**
 * Where a Probation case stands, for the case view's header, stepper and tabs (lane L, L1; prototype CaseView). Pure:
 * every fact comes from the server-authorized case view, and "today" is the HR calendar day the server passes in.
 */
export type ProbationStepState='done'|'current'|'waiting'|'overdue'|'returned';
export type ProbationCaseTab='p1'|'p2'|'p3'|'outcome'|'files'|'history';
const DONE=new Set(['locked','recorded','completed_offline']);
export const probationPartDone=(part:ProbationPartView)=>DONE.has(part.state);
const CLOSED=new Set(['confirmed','not_confirmed','withdrawn']);
export const probationCaseClosed=(view:ProbationCaseView)=>CLOSED.has(view.record.state)||view.startStatus==='did_not_join';
/** The part shown for each type: its latest cycle that is not cancelled. */
export function probationPartsByType(view:ProbationCaseView):ProbationPartView[]{
 const shown:ProbationPartView[]=[];
 for(const type of [1,2,3] as const){
  // A type whose every cycle was cancelled (a plan without that part) has no tab; its address still opens it.
  const latest=view.parts.filter(part=>part.type===type&&part.state!=='cancelled').reduce<ProbationPartView|null>((best,part)=>!best||part.cycle>best.cycle?part:best,null);
  if(latest)shown.push(latest);
 }
 return shown;
}
/** The part the case is on: the first open review part in cycle and part order; null when every part is settled. */
export function probationCurrentPart(view:ProbationCaseView):ProbationPartView|null{
 if(probationCaseClosed(view))return null;
 return view.parts.find(part=>part.state!=='cancelled'&&!probationPartDone(part))??null;
}
/** Calendar-day difference b − a for yyyy-mm-dd strings, without a timezone. */
export function probationDayDiff(a:string,b:string):number{const day=(v:string)=>Date.UTC(+v.slice(0,4),+v.slice(5,7)-1,+v.slice(8,10));return Math.round((day(b)-day(a))/86400000);}
export function probationPartState(view:ProbationCaseView,part:ProbationPartView,today:string):ProbationStepState{
 if(probationPartDone(part))return 'done';
 const current=probationCurrentPart(view);
 if(current?.id!==part.id){
  // A part of an earlier type is done when the case has moved past it (a later cycle took over).
  if(current&&(part.cycle<current.cycle||part.cycle===current.cycle&&part.type<current.type))return 'done';
  return probationCaseClosed(view)&&part.state!=='not_issued'?'done':'waiting';
 }
 if(part.state==='returned')return 'returned';
 return part.state!=='not_issued'&&part.dueOn<today?'overdue':'current';
}
export function probationOutcomeState(view:ProbationCaseView):ProbationStepState{
 if(probationCaseClosed(view))return 'done';
 return probationCurrentPart(view)||view.startStatus==='waiting_for_start'?'waiting':'current';
}
const signedStep=(part:ProbationPartView,step:SigningStep)=>{
 const doc=part.signing?.document;if(!doc)return false;
 return doc.actions.some(a=>(a.stepId===step.id||a.coveredStepIds?.includes(step.id))&&a.contentRevision===doc.contentRevision&&a.contentHash===doc.contentHash&&['signed','declined','reviewed','approved'].includes(a.action));
};
export type ProbationRouteStep={id:string;kind:'self'|'lmKpis'|'lmAssess'|'ack'|'approveSign'|'approve'|'review'|'sign';role:string;holderId:string|null;label:string|null;core:boolean;state:ProbationStepState};
/** The part's live route as the second stepper row: the employee's self-assessment (Parts 2 and 3), then the route steps. */
export function probationRouteSteps(part:ProbationPartView):ProbationRouteStep[]{
 const pending=part.signing?pendingSigningSteps({...part.signing.document,route:part.route}).map(step=>step.id):[];
 const open=!probationPartDone(part)&&part.state!=='not_issued'&&part.state!=='cancelled';
 const selfDone=!!part.staffSubmittedAt||probationPartDone(part);
 const managerTurn=open&&!part.signing&&(part.type===1||selfDone||['staff_submitted','returned'].includes(part.state));
 const steps:ProbationRouteStep[]=part.type===1?[]:[{id:'self',kind:'self',role:'employee',holderId:null,label:null,core:true,state:selfDone?'done':open&&!part.managerSubmittedAt?'current':'waiting'}];
 for(const step of part.route.steps){
  if(step.coveredByStepId)continue;
  const kind:ProbationRouteStep['kind']=step.role==='lm'?(part.type===1?'lmKpis':'lmAssess'):step.role==='employee'&&step.kind==='acknowledge'?'ack':step.kind==='review'?'review':step.kind==='approve'?(step.signature===false?'approve':'approveSign'):'sign';
  const done=probationPartDone(part)||signedStep(part,step);
  const state:ProbationStepState=done?'done':part.state==='returned'&&step.role==='lm'?'returned':pending.includes(step.id)&&open||step.role==='lm'&&managerTurn?'current':'waiting';
  steps.push({id:step.id,kind,role:step.role,holderId:step.holderId,label:step.label??null,core:step.role==='lm'||step.role==='employee',state});
 }
 return steps;
}
/** Who the case waits on now, for the header ("Waiting on: Line Manager · name · assessment"). */
export type ProbationWaiting={role:string;holderId:string|null;label:string|null;what:'kpis'|'self'|'assessment'|'returned'|'acknowledge'|'approve'|'review'|'sign'|'opens';date?:string}|null;
export function probationWaitingOn(view:ProbationCaseView):ProbationWaiting{
 const part=probationCurrentPart(view);if(!part||view.startStatus==='waiting_for_start')return null;
 return probationPartWaiting(view,part);
}
/** Who one part waits on (the part tab's bottom note); null once the part is settled or the case closed. */
export function probationPartWaiting(view:ProbationCaseView,part:ProbationPartView):ProbationWaiting{
 if(view.startStatus==='waiting_for_start'||probationCaseClosed(view)||probationPartDone(part)||part.state==='cancelled')return null;
 if(part.state==='not_issued')return{role:'',holderId:null,label:null,what:'opens',date:part.issueOn};
 const holders=view.record.facts.holders;
 const step=probationRouteSteps(part).find(s=>s.state==='current'||s.state==='returned'||s.state==='overdue');
 if(!step){
  if(part.type!==1&&!part.staffSubmittedAt)return{role:'employee',holderId:holders.employee,label:null,what:'self'};
  return null;
 }
 const what:NonNullable<ProbationWaiting>['what']=step.kind==='self'?'self':step.kind==='lmKpis'?'kpis':step.kind==='lmAssess'?(step.state==='returned'?'returned':'assessment'):step.kind==='ack'?'acknowledge':step.kind==='review'?'review':step.kind==='sign'?'sign':'approve';
 return{role:step.role,holderId:step.kind==='self'?holders.employee:step.holderId,label:step.label,what};
}
/** The tab a case opens on: the current part, else Outcome & letters once an outcome or letter exists, else Part 1. */
export function probationDefaultTab(view:ProbationCaseView):ProbationCaseTab{
 const part=probationCurrentPart(view);
 if(part)return ('p'+part.type) as ProbationCaseTab;
 if(view.outcomes.length||view.letterTasks.length||probationCaseClosed(view))return 'outcome';
 return 'p1';
}
