/** Source-owned phrasing for an already authorized canonical fact. No model prose, arithmetic,
 * inferred units or authority. The renderer must assert the original current-caller view first. */
import type {JobCard,JobFact} from './module-jobs';
import type {AgentModuleCode} from './module-agents';
export function assistantFactSentenceKey(module:AgentModuleCode,card:JobCard,fact:JobFact,toolName?:string):string{
 const field=String(fact.field);
 if(module==='assistant'&&field==='backgroundAgentsTotal')return 'backgroundAgentsTotal';
 if(module==='assistant'&&field==='backgroundAgentSwitchesOn')return 'backgroundAgentSwitchesOn';
 if(module==='assistant'&&field==='backgroundAgentEffectiveSwitchesOn')return 'backgroundAgentEffectiveSwitchesOn';
 if(field==='relationship'&&toolName==='my_reporting_line'){
  if(fact.value==='manager')return 'manager';if(fact.value==='report')return 'report';
 }
 if(module==='leave'&&['available','taken','pending'].includes(field))return 'leave_'+field;
 if(module==='payroll'&&fact.format==='money'&&['gross','deductions','net'].includes(field))return 'pay_'+field;
 if(field==='employeeCode')return 'employeeCode';
 if(field==='company')return card.title.kind==='text'&&card.title.value===fact.value?'company':'companyFor';
 if(field==='workStatus')return 'workStatus';
 if(field==='status')return module==='claims'?'claimStatus':module==='attendance'?'attendanceStatus':'status';
 if(field==='hiredOn')return 'hiredOn';
 if(field==='terminatedOn')return 'terminatedOn';
 if(field==='hours'&&fact.format==='number')return 'hours';
 if(field==='days'&&fact.format==='number')return 'days';
 if(field==='progressPercent'&&typeof fact.value==='number'&&fact.value>=0&&fact.value<=100)return 'progress';
 if(field==='from'&&fact.format==='date')return 'from';
 if(field==='to'&&fact.format==='date')return 'to';
 if(field==='paidAt'&&fact.format==='date')return 'paidAt';
 return 'recorded';
}
