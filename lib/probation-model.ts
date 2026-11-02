import {isCalendarDate} from './calendar-date';
import {addDaysIso} from './roster-month';
import {addCalendarMonths} from './hr-date';
import type {SigningRoute} from './document-signing-model';

export class ProbationError extends Error {
  constructor(readonly code:'invalid'|'forbidden'|'conflict',message:string){super(message);this.name='ProbationError';}
}
const reject=(message:string):never=>{throw new ProbationError('invalid',message);};
export const PROBATION_CRITERIA=[
  {id:'kpi',weight:30},{id:'knowledge',weight:20},{id:'customer',weight:7},{id:'action',weight:7},
  {id:'standards',weight:8},{id:'positivity',weight:7},{id:'talent',weight:7},{id:'respect',weight:7},{id:'transparency',weight:7},
] as const;
export type CriterionId=typeof PROBATION_CRITERIA[number]['id'];
export type Rating={rating:number|null;evidence:string};
export type Assessment=Record<string,Rating>;
export type ProbationPartType=1|2|3;
export type ProbationOutcome='confirm'|'extend'|'not_confirm'|'other';
export type MidpointStatus='satisfactory'|'development'|'at_risk';
export type ProbationRole='employee'|'lm'|'hod'|'pbp'|'gbs';
export type ProbationConfig={
  version:number;eligibleGrades:string[];gradeHEnabled:boolean;gradeHFormPublished:boolean;
  defaultMonths:number;kpiGate:'block'|'warn'|'off';kpiDueWorkingDays:number;kpiReminderWorkingDay:number;
  issueLeadDays:number;firstReminderDays:number;dailyReminderDays:number;lowBand:number;maxExtensions:number;
  extensionMonths:number[];lmWaitsForEmployee:boolean;plans:{months:number;midpointMonths:number|null}[];
};
export const DEFAULT_PROBATION_CONFIG:ProbationConfig={
  version:1,eligibleGrades:Array.from({length:12},(_,i)=>String(i+12)),gradeHEnabled:false,gradeHFormPublished:false,
  defaultMonths:6,kpiGate:'block',kpiDueWorkingDays:5,kpiReminderWorkingDay:3,issueLeadDays:30,
  firstReminderDays:14,dailyReminderDays:7,lowBand:2,maxExtensions:2,extensionMonths:[3,6],lmWaitsForEmployee:true,
  plans:[{months:6,midpointMonths:3},{months:3,midpointMonths:null}],
};
export function blankProbationAssessment():Assessment{return Object.fromEntries(PROBATION_CRITERIA.map(c=>[c.id,{rating:null,evidence:''}])) as Assessment;}
export function validateProbationConfig(config:ProbationConfig):void{
  if(!Number.isSafeInteger(config.version)||config.version<1||!config.eligibleGrades.length||config.eligibleGrades.some(grade=>!/^(1[2-9]|2[0-3])$/.test(grade))||new Set(config.eligibleGrades).size!==config.eligibleGrades.length)reject('Choose a valid configuration version and eligible grades.');
  for(const n of [config.defaultMonths,config.kpiDueWorkingDays,config.kpiReminderWorkingDay,config.issueLeadDays,config.firstReminderDays,config.dailyReminderDays])if(!Number.isSafeInteger(n)||n<1||n>366)reject('Review timings must be positive whole numbers.');
  if(!['block','warn','off'].includes(config.kpiGate)||!Number.isSafeInteger(config.lowBand)||config.lowBand<1||config.lowBand>5||config.maxExtensions!==2||config.extensionMonths.length!==2||!config.extensionMonths.includes(3)||!config.extensionMonths.includes(6))reject('Check the KPI gate, result threshold and extension limits.');
  if(config.gradeHEnabled&&!config.gradeHFormPublished)reject('Publish approved Grade H form content before enabling Grade H.');
  const lengths=new Set<number>();
  for(const p of config.plans){if(lengths.has(p.months)||!Number.isSafeInteger(p.months)||p.months<1||p.months>36||p.midpointMonths!==null&&(!Number.isSafeInteger(p.midpointMonths)||p.midpointMonths<1||p.midpointMonths>=p.months))reject('Choose unique review plans with valid review points.');lengths.add(p.months);}
}
/** Integer hundredths avoid floating point/rounding drift; weights are integer percentages. */
export function probationScore(assessment:Assessment):{sectionA:number;sectionB:number;hundredths:number;band:number}|null{
  let sectionA=0,sectionB=0;
  for(const [index,c]of PROBATION_CRITERIA.entries()){
    const rating=assessment[c.id]?.rating;
    if(rating===null||rating===undefined)return null;
    if(!Number.isInteger(rating)||rating<1||rating>5)reject('Every criterion must have a whole rating from 1 to 5.');
    if(index<2)sectionA+=rating*c.weight;else sectionB+=rating*c.weight;
  }
  const hundredths=sectionA+sectionB;
  return{sectionA,sectionB,hundredths,band:hundredths>=451?5:hundredths>=351?4:hundredths>=251?3:hundredths>=151?2:1};
}
export function probationSuggestion(part:2|3,band:number):ProbationOutcome|MidpointStatus{
  if(!Number.isInteger(band)||band<1||band>5)reject('A complete Line Manager score is required.');
  return part===2?(band>=3?'satisfactory':band===2?'development':'at_risk'):(band>=3?'confirm':band===2?'extend':'not_confirm');
}
export function assessmentIssues(assessment:Assessment,requireKpiEvidence=false):string[]{
  const issues:string[]=[];
  for(const c of PROBATION_CRITERIA){const item=assessment[c.id];if(!item||item.rating===null)issues.push(c.id+':unrated');
    else if(!Number.isInteger(item.rating)||item.rating<1||item.rating>5)issues.push(c.id+':invalid_rating');
    else if((item.rating<=2||c.id==='kpi'&&requireKpiEvidence)&&!item.evidence.trim())issues.push(c.id+':evidence_required');}
  return issues;
}
export type ProbationKpi={id:string;accountability:string;measure:string;target:string;targetDate:string};
export type ProbationPart={
  id:string;type:ProbationPartType;cycle:number;revision:number;state:'not_issued'|'issued'|'staff_submitted'|'lm_submitted'|'pending_ack'|'pending_approval'|'returned'|'recorded'|'locked'|'cancelled'|'completed_offline';
  dueOn:string;issueOn:string;reviewOn:string;conductedBy:string|null;
  kpis:ProbationKpi[];support:{coaching:string;access:string;checkins:string;other:string};
  employee:Assessment;manager:Assessment;employeeComments:string;strengths:string;development:string;managerComments:string;
  outcome:ProbationOutcome|null;midpointStatus:MidpointStatus|null;justification:string;extensionMonths:number|null;
  staffSubmittedAt:string|null;managerSubmittedAt:string|null;acknowledgedAt:string|null;
  kpiException:string|null;employeeWaitException:string|null;offlinePdfId:string|null;
};
export type ProbationCase={
  id:string;employmentId:string;companyId:string;sourceKey:string;startOn:string;originalEndOn:string;endOn:string;gradeAtStart:string;
  revision:number;config:ProbationConfig;planMonths:number;planFlag:boolean;extensionCount:number;kpiAcknowledged:boolean;
  state:'kpi_setting'|'in_review'|'pending_approval'|'outcome_pending'|'confirmed'|'extended'|'not_confirmed'|'withdrawn';
  parts:ProbationPart[];pendingOutcome:ProbationOutcome|null;
};
function validDay(day:string):void{if(!isCalendarDate(day))reject('Enter a valid calendar date.');}
export function addProbationMonths(day:string,months:number):string{
  validDay(day);if(!Number.isSafeInteger(months)||Math.abs(months)>1200)reject('Enter a valid month offset.');
  return addCalendarMonths(day,months);
}
/** Calendar is supplied by the canonical employee working-calendar owner, never guessed here. */
export function advanceProbationWorkingDays(day:string,count:number,isWorking:(day:string)=>boolean):string{
  validDay(day);if(!Number.isSafeInteger(count)||count<0||count>366)reject('Enter a valid working-day offset.');
  let current=day,remaining=count;
  for(let scanned=0;remaining>0&&scanned<3660;scanned++){current=addDaysIso(current,1);if(isWorking(current))remaining--;}
  if(remaining)reject('The employee working calendar could not resolve this date.');return current;
}
export function probationDueDay(day:string,isWorking:(day:string)=>boolean):string{
  validDay(day);let current=day;for(let i=0;i<366;i++){if(isWorking(current))return current;current=addDaysIso(current,-1);}return reject('The employee working calendar could not resolve this date.');
}
export function newProbationPart(id:string,type:ProbationPartType,cycle:number,dueOn:string,lead:number):ProbationPart{
  validDay(dueOn);
  return{id,type,cycle,revision:1,state:'not_issued',dueOn,issueOn:addDaysIso(dueOn,-lead),reviewOn:'',conductedBy:null,kpis:[],support:{coaching:'',access:'',checkins:'',other:''},employee:blankProbationAssessment(),manager:blankProbationAssessment(),employeeComments:'',strengths:'',development:'',managerComments:'',outcome:null,midpointStatus:null,justification:'',extensionMonths:null,staffSubmittedAt:null,managerSubmittedAt:null,acknowledgedAt:null,kpiException:null,employeeWaitException:null,offlinePdfId:null};
}
export function createProbationCase(input:{id:string;employmentId:string;companyId:string;sourceKey:string;startOn:string;endOn:string|null;months:number|null;grade:string;explicitNoProbation:boolean;unknownLength?:boolean;config:ProbationConfig;nextId:()=>string;isWorking:(day:string)=>boolean}):ProbationCase|null{
  validateProbationConfig(input.config);validDay(input.startOn);
  if(input.explicitNoProbation||!input.config.eligibleGrades.includes(input.grade)&&!(input.grade==='H'&&input.config.gradeHEnabled))return null;
  const months=input.months??(input.grade==='H'?3:input.config.defaultMonths);
  if(!Number.isSafeInteger(months)||months<1||months>120)reject('Confirm the employee probation period.');
  const end=input.endOn??addDaysIso(addProbationMonths(input.startOn,months),-1);validDay(end);if(end<input.startOn)reject('The probation end cannot precede the start date.');
  const plan=input.unknownLength?undefined:input.config.plans.find(p=>p.months===months);
  const kpiDue=advanceProbationWorkingDays(input.startOn,input.config.kpiDueWorkingDays,input.isWorking);
  const p1=newProbationPart(input.nextId(),1,0,kpiDue,0);p1.issueOn=advanceProbationWorkingDays(input.startOn,1,input.isWorking);
  const parts=[p1];
  if(plan?.midpointMonths){const midpoint=addProbationMonths(input.startOn,plan.midpointMonths);if(midpoint<end)parts.push(newProbationPart(input.nextId(),2,0,probationDueDay(midpoint,input.isWorking),input.config.issueLeadDays));}
  parts.push(newProbationPart(input.nextId(),3,0,probationDueDay(end,input.isWorking),input.config.issueLeadDays));
  return{id:input.id,employmentId:input.employmentId,companyId:input.companyId,sourceKey:input.sourceKey,startOn:input.startOn,originalEndOn:end,endOn:end,gradeAtStart:input.grade,revision:1,config:structuredClone(input.config),planMonths:months,planFlag:input.months===null||!plan,extensionCount:0,kpiAcknowledged:false,state:'kpi_setting',parts,pendingOutcome:null};
}
export function probationRoute(type:ProbationPartType,holders:Record<ProbationRole,string|null>):SigningRoute{
  const steps=[{id:'lm',role:'lm',kind:'sign' as const,stage:0,holderId:holders.lm,required:true},{id:'employee',role:'employee',kind:'acknowledge' as const,stage:1,holderId:holders.employee,required:true}];
  return{version:1,steps:type===3?[...steps,{id:'hod',role:'hod',kind:'approve',stage:2,holderId:holders.hod,required:true},{id:'pbp',role:'pbp',kind:'approve',stage:3,holderId:holders.pbp,required:true}]:steps};
}
export function managerSubmissionIssues(part:ProbationPart,record:ProbationCase):string[]{
  if(part.type===1){const issues:string[]=[];if(part.kpis.length<1||part.kpis.length>5)issues.push('kpis:one_to_five');
    for(const k of part.kpis)for(const f of ['accountability','measure','target','targetDate']as const)if(!k[f]?.trim()||f==='targetDate'&&!isCalendarDate(k[f]))issues.push(k.id+':'+f);
    for(const [key,value]of Object.entries(part.support))if(!value.trim())issues.push('support:'+key);return issues;}
  const issues=assessmentIssues(part.manager,!record.kpiAcknowledged&&record.config.kpiGate==='warn');
  if(!isCalendarDate(part.reviewOn))issues.push('review_date');if(!part.conductedBy)issues.push('conducted_by');
  if(record.config.lmWaitsForEmployee&&!part.staffSubmittedAt&&!part.employeeWaitException)issues.push('employee_submission');
  if(part.type===2){if(!part.strengths.trim())issues.push('strengths');if(!part.development.trim())issues.push('development');if(!part.managerComments.trim())issues.push('manager_comments');if(!part.midpointStatus)issues.push('midpoint_status');}
  else{if(!part.outcome)issues.push('outcome');if(!part.justification.trim())issues.push('justification');if(part.outcome==='extend'&&(!record.config.extensionMonths.includes(part.extensionMonths??0)||record.extensionCount>=record.config.maxExtensions))issues.push('extension');}
  const score=probationScore(part.manager),choice=part.type===2?part.midpointStatus:part.outcome;
  if(score&&choice&&choice!==probationSuggestion(part.type,score.band)&&!part.justification.trim())issues.push('override_justification');
  return [...new Set(issues)];
}
const EMPLOYEE_FIELDS=new Set(['employee','employeeComments']);
const MANAGER_FIELDS=new Set(['kpis','support','manager','reviewOn','conductedBy','strengths','development','managerComments','outcome','midpointStatus','justification','extensionMonths']);
/** An unlock changes revision/state; it does not grant PBP/GBS edit authority over another actor. */
export function editProbationPart(record:ProbationCase,partId:string,role:ProbationRole,patch:Partial<ProbationPart>):ProbationCase{
  const part=record.parts.find(p=>p.id===partId);if(!part)throw new ProbationError('invalid','Review not found.');
  if(['recorded','locked','completed_offline','cancelled'].includes(part.state)||record.state==='withdrawn')throw new ProbationError('conflict','This review is locked. Request a reasoned unlock.');
  const allowed=role==='employee'?EMPLOYEE_FIELDS:role==='lm'?MANAGER_FIELDS:new Set<string>();
  if(Object.keys(patch).some(k=>!allowed.has(k)))throw new ProbationError('forbidden','Only the field owner may edit these fields.');
  if(role==='employee'&&(part.staffSubmittedAt||part.managerSubmittedAt)&&Object.hasOwn(patch,'employee')||role==='employee'&&part.acknowledgedAt||role==='lm'&&part.managerSubmittedAt)throw new ProbationError('conflict','Your submitted step cannot be edited.');
  if(role==='lm'&&part.type===1&&record.kpiAcknowledged)throw new ProbationError('conflict','Acknowledged KPIs are locked.');
  return{...record,revision:record.revision+1,parts:record.parts.map(p=>p.id===partId?{...p,...structuredClone(patch),revision:p.revision+1}:p)};
}
/** No retroactive reminder sends: the activation day is the earliest admissible occurrence. */
export function probationReminderDue(part:ProbationPart,config:ProbationConfig,today:string,activationOn:string,role:'employee'|'lm'):boolean{
  validDay(today);validDay(activationOn);
  if(today<activationOn||today>part.dueOn||['not_issued','recorded','locked','completed_offline','cancelled'].includes(part.state))return false;
  if(role==='employee'?!!part.staffSubmittedAt:!!part.managerSubmittedAt)return false;
  const first=addDaysIso(part.dueOn,-config.firstReminderDays),daily=addDaysIso(part.dueOn,-config.dailyReminderDays);
  return today===first||today>=daily;
}
