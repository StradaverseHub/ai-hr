/** Deterministic allow-list presentation of canonical method results. This pure formatter grants no authority.
 * Runtime views are issued only by the closed current-caller owner; models never supply this input.
 */
import {isAgentModuleCode,type AgentModuleCode} from './module-agents';
import type {JobFact,JobCard,JobPresentation,JobFactField} from './module-jobs';
type Row=Record<string,unknown>;
const object=(value:unknown):Row=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Canonical job data unavailable.');return value as Row;};
const list=(value:unknown):unknown[]=>{if(!Array.isArray(value))throw Error('Canonical job data unavailable.');return value;};
const scalar=(value:unknown):string|number|boolean|null=>{
 if(value==null)return null;if(typeof value==='string'&&value.length<=500)return value;
 if(typeof value==='number'&&Number.isFinite(value))return value;if(typeof value==='boolean')return value;throw Error('Canonical job field unavailable.');
};
const value=(row:Row,key:string,field:JobFactField,format:JobFact['format']='text'):JobFact=>({field,value:format==='date'&&row[key] instanceof Date?
 Number.isFinite((row[key] as Date).getTime())?(row[key] as Date).toISOString():null:scalar(row[key]),format});
const title=(row:Row,key:string,index:number):JobCard['title']=>typeof row[key]==='string'&&String(row[key]).length<=250?
 {kind:'text',value:String(row[key])}:{kind:'record',number:index+1};
const record=(index:number):JobCard['title']=>({kind:'record',number:index+1});
const gaps=new Set(['no_compensation','no_bank_account','no_identity','no_tax_number','no_epf_number','no_socso_number']);
export function presentCanonicalModuleData(module:AgentModuleCode,data:unknown):JobPresentation{
 if(!isAgentModuleCode(module))throw Error('Unsupported canonical module job.');
 let truncated=false;const cards:JobCard[]=[];
 const rows=(value:unknown)=>{const bound=object(value);if(typeof bound.truncated!=='boolean')throw Error('Canonical job scope unavailable.');
  truncated=truncated||bound.truncated;return list(bound.rows).map(object);};
 const push=(card:JobCard)=>{if(cards.length<25)cards.push(Object.freeze({...card,title:Object.freeze(card.title),facts:Object.freeze(card.facts.map(fact=>Object.freeze(fact)))}));else truncated=true;};
 let hasEmployment:boolean|undefined;
 switch(module){
  case 'employees':rows(data).forEach((row,index)=>push({title:title(row,'company',index),facts:[value(row,'employeeCode','employeeCode'),value(row,'company','company'),
   value(row,'hiredOn','hiredOn','date'),value(row,'terminatedOn','terminatedOn','date'),value(row,'status','workStatus','status')]}));break;
  case 'org':rows(data).forEach(row=>list(row.reportingLines).map(object).forEach((line,index)=>push({title:title(line,'name',index),facts:[value(row,'company','company'),value(line,'employeeCode','employeeCode'),value(line,'lineType','reportingKind','status')]})));break;
  case 'leave':rows(data).forEach(row=>list(row.balances).map(object).forEach((balance,index)=>push({title:title(balance,'leaveType',index),withheld:balance.withheld===true,
   facts:[value(row,'company','company'),value(balance,'available','available','number'),value(balance,'taken','taken','number'),value(balance,'pending','pending','number')].filter(fact=>fact.value!==null)})));break;
  case 'ess':case 'country-my':{const row=object(data);push({title:record(0),facts:[value(row,'employees','checkedRecords','number'),value(row,'ready','readyRecords','number')]});
   list(row.gaps).map(object).forEach(gap=>{if(typeof gap.id!=='string'||!gaps.has(gap.id)||!['payment','payroll','statutory_filing'].includes(String(gap.blocks)))throw Error('Unknown canonical readiness contract.');
    push({title:{kind:'gap',code:gap.id},facts:[value(gap,'count','gapCount','number'),value(gap,'blocks','blockingEffect','blocks')]});});break;}
  case 'approvals':rows(data).forEach((row,index)=>push({title:title(row,'leaveType',index),facts:[value(row,'company','company'),value(row,'status','status','status'),value(row,'startDate','from','date'),value(row,'endDate','to','date'),value(row,'days','days','number'),value(row,'hours','hours','number'),value(row,'durationType','durationType','status'),value(row,'hasRejectedDates','hasRejectedDates','boolean')]}));break;
  case 'knowledge_base':rows(data).forEach((row,index)=>push({title:title(row,'title',index),facts:[value(row,'category','category'),value(row,'updatedAt','date','date')]}));break;
  case 'payroll':rows(data).forEach((row,index)=>push({title:title(row,'payPeriod',index),facts:[value(row,'company','company'),value(row,'gross','gross','money'),
   value(row,'deductions','deductions','money'),value(row,'net','net','money'),value(row,'currency','currency'),value(row,'runType','runType','status'),value(row,'runSeq','runSequence','number')],
   ...(typeof row.id==='string'&&/^[a-f0-9-]{36}$/i.test(row.id)?{href:'/me/payslip/'+encodeURIComponent(row.id)}:{})}));break;
  case 'typed_pay_components':rows(data).forEach(row=>rows(row.lines).forEach((line,index)=>push({title:title(line,'name',index),facts:[value(row,'payPeriod','period'),value(line,'code','itemCode'),value(line,'amount','amount','money'),value(row,'currency','currency')]})));break;
  case 'multi_cycle_payroll':rows(data).forEach((row,index)=>push({title:title(row,'cycleName',index),facts:[value(row,'payPeriod','period'),value(row,'runType','runType','status'),value(row,'runSeq','runSequence','number')],
   ...(typeof row.payslipId==='string'&&/^[a-f0-9-]{36}$/i.test(row.payslipId)?{href:'/me/payslip/'+encodeURIComponent(row.payslipId)}:{})}));break;
  case 'attendance':rows(data).forEach((row,index)=>push({title:title(row,'date',index),facts:[value(row,'date','date','date'),value(row,'status','status','status'),value(row,'workedMinutes','workedMinutes','number'),value(row,'otMinutes','otMinutes','number')]}));break;
  case 'claims':{const row=object(data);if(typeof row.hasEmployment!=='boolean'||typeof row.truncated!=='boolean')throw Error('Canonical claim scope unavailable.');hasEmployment=row.hasEmployment;truncated=truncated||row.truncated;
   list(row.claims).map(object).forEach((claim,index)=>push({title:title(claim,'claimType',index),facts:[value(claim,'status','status','status'),value(claim,'incurredOn','incurredOn','date'),
    value(claim,'createdAt','createdAt','date'),value(claim,'decidedAt','decidedAt','date'),value(claim,'paidAt','paidAt','date')]}));break;}
  case 'performance':rows(data).forEach((row,index)=>push({title:title(row,'cycleName',index),facts:[value(row,'status','status','status'),value(row,'released','released','boolean'),value(row,'periodEnd','periodEnd','date')]}));break;
  case 'rewards':rows(data).forEach((row,index)=>push({title:title(row,'cycle',index),facts:[value(row,'company','company'),value(row,'unit','rewardUnit'),value(row,'kind','rewardKind','status'),value(row,'year','year','number'),value(row,'status','status','status'),value(row,'revision','revision','number')]}));break;
  case 'lifecycle':if(data!==null){const row=object(data),progress=object(row.progress);push({title:record(0),facts:[value(row,'status','status','status'),value(progress,'done','progressDone','number'),value(progress,'total','progressTotal','number'),value(progress,'percent','progressPercent','number')]});
   list(row.steps).map(object).filter(step=>step.applicable===true).forEach((step,index)=>push({title:title(step,'label',index),facts:[value(step,'done','completed','boolean')]}));}break;
  case 'toil':rows(data).forEach((row,index)=>{push({title:record(index),facts:[value(row,'active','activeCredit','number'),value(row,'taken','usedCredit','number'),value(row,'expired','expiredCredit','number'),value(row,'convertedToPay','payConvertedCredit','number'),value(row,'leaveUnit','creditUnit','status'),value(row,'soonestExpiry','expiry','date')]});
   rows(row.rows).forEach((credit,i)=>push({title:title(credit,'workedDate',i),facts:[value(credit,'workedDate','date','date'),value(credit,'expiresOn','expiry','date'),value(credit,'daysCredited','credited','number'),value(credit,'daysTaken','taken','number'),value(credit,'remaining','remaining','number'),value(credit,'status','status','status')]}));});break;
  case 'notifications':rows(data).forEach((row,index)=>push({title:record(index),facts:[value(row,'createdAt','notificationCreated','date'),value(row,'readAt','notificationReadAt','date')]}));break;
  case 'system_explorer':{const row=object(data);push({title:record(0),facts:[value(row,'withheldTables','withheldTables','number')]});rows(row.tables).forEach((table,index)=>push({title:title(table,'table',index),facts:[value(table,'module','module','module')]}));break;}
  case 'system_testing':rows(data).forEach((row,index)=>push({title:title(row,'caseNo',index),facts:[value(row,'caseNo','testCase'),value(row,'moduleCode','module','module'),value(row,'latestOutcome','lastOutcome','status'),value(row,'latestRunAt','lastRun','date'),value(row,'runCount','runCount','number')]}));break;
  case 'assistant':list(object(data).capabilities).map(object).forEach(row=>{if(!isAgentModuleCode(row.module))throw Error('Unknown canonical capability.');push({title:{kind:'module',module:row.module},facts:[]});});break;
  default:throw Error('Unsupported canonical module job.');
 }
 return Object.freeze({module,cards:Object.freeze(cards),truncated,...(hasEmployment===undefined?{}:{hasEmployment})});
}
