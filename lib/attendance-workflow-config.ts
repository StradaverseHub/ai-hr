/** Configuration dispatch only. Each older routing version retains its exact parser. */
import {validateAnyAttendanceWorkflow as validateLegacy,type AnyAttendanceWorkflowInput as LegacyInput} from './attendance-workflow-v3';
import {validateAttendanceV4Workflow,type AttendanceV4WorkflowInput} from './attendance-workflow-v4';
export type AnyAttendanceWorkflowInput=LegacyInput|AttendanceV4WorkflowInput;
export function validateAnyAttendanceWorkflow(raw:unknown):AnyAttendanceWorkflowInput {
 return raw&&typeof raw==='object'&&'routingVersion' in raw&&raw.routingVersion===4?validateAttendanceV4Workflow(raw):validateLegacy(raw);
}
/** Read an already-authorized persisted version; database identity/history columns are not posted configuration. */
export function attendanceWorkflowConfiguration(row:{companyId:string;applicationType:unknown;routingVersion:number;code:string;name:string;description:string|null;priority:number;criteria:unknown;stages:unknown;active:boolean;cc?:unknown}) {
 return validateAnyAttendanceWorkflow({companyId:row.companyId,applicationType:row.applicationType,routingVersion:row.routingVersion,code:row.code,name:row.name,description:row.description??'',priority:row.priority,criteria:row.criteria,stages:row.stages,active:row.active,...(row.routingVersion===4?{cc:row.cc}:{} )});
}
