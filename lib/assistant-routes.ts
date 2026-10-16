/** Closed, reviewed workflow links. A model supplies a key, never a navigation URL or query string. */
import {assistantConversationId,type AssistantHandoff} from './assistant-conversation-model';
export const ASSISTANT_ROUTES:Record<AssistantHandoff,{href:string;module:string|null;admin:boolean}>={
 personnelCreate:{href:'/admin/personnel/new',module:'employees',admin:true},personnelImport:{href:'/admin/personnel/import',module:'employees',admin:true},
 ownProfile:{href:'/me',module:null,admin:false},ownAttendance:{href:'/attendance',module:'attendance',admin:false},ownLeave:{href:'/leave',module:'leave',admin:false},
 ownPayslips:{href:'/me?tab=payroll',module:'payroll',admin:false},payrollProcess:{href:'/payroll/process',module:'payroll',admin:true},payrollTransactions:{href:'/payroll/transaction-view',module:'payroll',admin:true},
 payrollExceptions:{href:'/control-tower/exceptions',module:'payroll',admin:true},statutorySetup:{href:'/admin/personnel',module:'employees',admin:true},eaStatement:{href:'/me?tab=documents',module:'payroll',admin:false},feedback:{href:'/feedback',module:null,admin:false},attendanceAllowance:{href:'/admin/attendance-allowance',module:'attendance',admin:true},
};
export function assistantWorkflowHref(route:AssistantHandoff):string{return ASSISTANT_ROUTES[route].href;}

export function assistantFeedbackHref(id:string){return '/feedback?assistantDraft='+encodeURIComponent(assistantConversationId.parse(id));}
