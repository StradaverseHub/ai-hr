/** Typed presentation for current canonical tool outcomes. Never consume model text as facts. */
import {presentCanonicalModuleData} from './module-job-presentation';
import {checkedModuleHumanHandoffs} from './module-human-handoffs';
import {isAgentModuleCode,type AgentModuleCode} from './module-agents';
import type {JobPresentation,JobCard,JobFact,JobFactField} from './module-jobs';
export const GROUNDED_TOOL_MODULES=Object.freeze({my_leave_balances:'leave',my_leave_requests:'approvals',leave_entitlement_explain:'leave',
 upcoming_holidays:'org',who_is_away:'leave',team_leave_summary:'leave',employee_profile:'employees',my_reporting_line:'org',
 my_payslip_summary:'payroll',my_pay_change:'payroll',my_claim_statuses:'claims',my_module_work:'assistant'} as const);
export type GroundedToolName=keyof typeof GROUNDED_TOOL_MODULES;
export function isGroundedToolName(value:string):value is GroundedToolName{return Object.prototype.hasOwnProperty.call(GROUNDED_TOOL_MODULES,value);}
const obj=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value as Record<string,unknown>;};
const arr=(value:unknown)=>{if(!Array.isArray(value))throw Error();return value.map(obj);};
const fact=(row:Record<string,unknown>,key:string,field:JobFactField,format:JobFact['format']='text'):JobFact=>{
 const value=row[key]??null;if(value!==null&&typeof value!=='string'&&typeof value!=='number'&&typeof value!=='boolean')throw Error();
 if(typeof value==='string'&&value.length>500||typeof value==='number'&&!Number.isFinite(value))throw Error();
 return {field,value,format};
};
export function presentGroundedToolOutcome(name:GroundedToolName,outcome:unknown):JobPresentation|null{
 const source=obj(outcome);if(source.ok!==true)return null;
 const bound=(rows:unknown[])=>({rows,truncated:source.truncated===true});
 switch(name){
  case 'my_module_work':{
   if(!isAgentModuleCode(source.module))return null;
   const presentation=presentCanonicalModuleData(source.module,source.data),handoffs=checkedModuleHumanHandoffs(source.module,source.humanActions),seen=new Set<string>();
   const cards:JobCard[]=[...presentation.cards];for(const handoff of handoffs){if(seen.has(handoff.route))continue;seen.add(handoff.route);cards.push(Object.freeze({title:Object.freeze({kind:'module' as const,module:handoff.module}),facts:Object.freeze([]),href:handoff.route,linkPurpose:'human_review' as const}));}
   return Object.freeze({...presentation,cards:Object.freeze(cards)});
  }
  case 'my_leave_balances':return presentCanonicalModuleData('leave',bound(arr(source.employments)));
  case 'my_leave_requests':return presentCanonicalModuleData('approvals',bound(arr(source.rows)));
  case 'my_payslip_summary':return presentCanonicalModuleData('payroll',bound(arr(source.rows)));
  case 'my_claim_statuses':return presentCanonicalModuleData('claims',{hasEmployment:true,claims:arr(source.claims),truncated:source.truncated===true});
  // These legacy outputs lack the source identity/currency context needed for a safe typed answer.
  // The normal canonical jobs remain available; no ambiguous number is re-labelled as verified.
  case 'my_pay_change':case 'team_leave_summary':return null;
 }
 const module:AgentModuleCode=GROUNDED_TOOL_MODULES[name];const cards:JobCard[]=[];let truncated=source.truncated===true;
 const push=(card:JobCard)=>{if(cards.length<25)cards.push(Object.freeze({...card,title:Object.freeze(card.title),facts:Object.freeze(card.facts.map(row=>Object.freeze(row)))}));else truncated=true;};
 const title=(row:Record<string,unknown>,key:string,index:number):JobCard['title']=>typeof row[key]==='string'&&String(row[key]).length<=250?{kind:'text',value:String(row[key])}:{kind:'record',number:index+1};
 switch(name){
  case 'employee_profile':{const row=obj(source.employee);push({title:title(row,'name',0),facts:[fact(row,'employeeCode','employeeCode'),fact(row,'company','company'),fact(row,'gradeName','grade'),
   fact(row,'holidayGroupName','holidayCalendar'),fact(row,'workState','workState'),fact(row,'hiredOn','hiredOn','date'),fact(row,'joinDate','joinDate','date'),fact(row,'terminatedOn','terminatedOn','date')]});break;}
  case 'my_reporting_line':for(const direction of ['managers','reports'])arr(source[direction]).forEach((row,index)=>push({title:title(row,'name',index),facts:[
   fact({...row,direction:direction==='managers'?'manager':'report'},'direction','relationship','status'),fact(row,'employeeCode','employeeCode'),fact(row,'lineType','reportingKind','status')]}));break;
  case 'upcoming_holidays':arr(source.holidays).forEach((_row,index)=>push({title:{kind:'record',number:index+1},facts:[fact(_row,'date','date','date')]}));break;
  case 'who_is_away':if(source.mode==='count'){push({title:{kind:'record',number:1},facts:[fact(source,'from','from','date'),fact(source,'to','to','date'),fact(source,'personCount','personCount','number'),fact(source,'approvedOnFromDate','approvedOnFromDate','number')]});break;}arr(source.rows).forEach(row=>arr(row.absences).forEach((absence,index)=>push({title:title(row,'personName',index),facts:[fact(row,'employeeCode','employeeCode'),fact(absence,'leaveType','leaveType'),
   fact(absence,'status','status','status'),fact(absence,'startDate','from','date'),fact(absence,'endDate','to','date'),fact(absence,'days','days','number'),fact(absence,'hours','hours','number')]})));break;
  case 'leave_entitlement_explain':arr(source.employments).forEach((row,index)=>{
   const fields:readonly [string,JobFactField][]=[['displayEntitlementDays','displayEntitlementDays'],['currentYearEntitlement','earnedEntitlement'],['broughtForward','broughtForward'],['adjustments','adjustments'],
    ['totalEntitlement','totalEntitlement'],['takenThisCycle','taken'],['pendingApproval','pending'],['forfeitedThisCycle','forfeited'],['totalAvailable','available']];
   push({title:title(row,'leaveType',index),withheld:row.withheld===true,facts:[fact(row,'company','company'),fact(source,'asOf','asOf','date'),fact(row,'cycleStart','cycleStart','date'),
    ...fields.filter(([key])=>row[key]!==null&&row[key]!==undefined).map(([key,label])=>fact(row,key,label,'number'))]});
  });break;
 }
 return Object.freeze({module,cards:Object.freeze(cards),truncated});
}
