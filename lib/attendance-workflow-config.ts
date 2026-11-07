/** Configuration dispatch only. Each older routing version retains its exact parser. */
import {validateAnyAttendanceWorkflow as validateLegacy,type AnyAttendanceWorkflowInput as LegacyInput} from './attendance-workflow-v3';
import {AttendanceWorkflowError} from './attendance-workflow';
import {validateAttendanceV4Workflow,type AttendanceV4WorkflowInput} from './attendance-workflow-v4';
export type AnyAttendanceWorkflowInput=(LegacyInput|AttendanceV4WorkflowInput)&{companyIds?:string[];expectedVersion?:number};
export function validateAnyAttendanceWorkflow(raw:unknown):AnyAttendanceWorkflowInput {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new AttendanceWorkflowError('invalid','Enter a workflow configuration.');
 const {companyIds,expectedVersion,...config}=raw as Record<string,unknown>;
 const parsed=config.routingVersion===4?validateAttendanceV4Workflow(config):validateLegacy(config);
 const companies=companyIds===undefined?[parsed.companyId]:companyIds;
 if(!Array.isArray(companies)||!companies.length||companies.length>100||companies.some(id=>typeof id!=='string'||!/^[-0-9a-f]{36}$/i.test(id))||new Set(companies).size!==companies.length||!companies.includes(parsed.companyId))throw new AttendanceWorkflowError('invalid','Select one or more permitted companies.');
 if(expectedVersion!==undefined&&(!Number.isInteger(expectedVersion)||Number(expectedVersion)<1))throw new AttendanceWorkflowError('stale','Reload the workflow before saving.');
 return {...parsed,companyIds:[...companies].sort(),...(expectedVersion!==undefined?{expectedVersion:expectedVersion as number}:{})};
}
/** Read an already-authorized persisted version; database identity/history columns are not posted configuration. */
export function attendanceWorkflowConfiguration(row:{companyId:string;applicationType:unknown;routingVersion:number;code:string;name:string;description:string|null;priority:number;criteria:unknown;stages:unknown;active:boolean;cc?:unknown;companyIds?:string[];version?:number}) {
 return validateAnyAttendanceWorkflow({companyId:row.companyId,...(row.companyIds?{companyIds:row.companyIds}:{}),...(row.version?{expectedVersion:row.version}:{}),applicationType:row.applicationType,routingVersion:row.routingVersion,code:row.code,name:row.name,description:row.description??'',priority:row.priority,criteria:row.criteria,stages:row.stages,active:row.active,...(row.routingVersion===4?{cc:row.cc}:{} )});
}

export function attendanceWorkflowSelectedEmployees(stages:AnyAttendanceWorkflowInput['stages']){
 return [...new Set(stages.flatMap(stage=>'sources' in stage?stage.sources:'source' in stage?[stage.source]:[]).flatMap(source=>source.kind==='specific_employee'?source.employmentIds:[]))];
}
