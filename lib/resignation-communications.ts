/** Case-message contracts. Source snapshots stay server-side; public previews contain no private document objects. */
import type {EmailTemplate,Document} from './lifecycle-v9-model';
import type {AutomationEmailContent} from './automation-email-ipc';
export type ResignationCommunicationSource={caseId:string;caseRevision:number;caseNumber:string;runId:string;stepId:string;workflowId:string;workflowRevision:number;workflowName:string;runStatus:string;previewAvailable?:boolean;editable:boolean;canOpenWorkflow:boolean;template:EmailTemplate;values:Record<string,string>;override:{subject:string;body:string}|null;to:{id:string;name:string}[];cc:{id:string;name:string}[];documents:Document[];files:{id:string;slot:string;name:string;contentHash:string}[];recipientProblem:string|null};
export type ResignationCommunication={runId:string;stepId:string;workflowName:string;workflowRevision:number;runStatus:string;emailTemplateId:string;emailName:string;subject:string;body:string;to:string[];cc:string[];attachments:string[];holds:string[];editable:boolean;workflowUrl:string|null;draft:{subject:string;body:string};test:{requestId:string;status:string}|null};
export type ResignationCommunications={caseId:string;revision:number;items:ResignationCommunication[]};
export type ResignationMessageTestInput={caseId:string;revision:number;runId:string;stepId:string;requestId:string;offboardingCaseId?:string};
export type ResignationMessageTestResult={requestId:string;status:'queued';replayed:boolean};
export type ResignationPreparedMessage={subject:string;body:string;content:AutomationEmailContent;holds:string[]};
