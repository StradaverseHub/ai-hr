/** Ordered decision approvals on the shared signing primitives; an approval is not a signature on a letter. */
import type {ContractApprovalLayer} from './contract-automation';
import {SigningError,pendingSigningSteps,recordSigningAction,signingComplete,type SigningDocument} from './document-signing-model';

export type ContractApprovalAssignment={
 layer:ContractApprovalLayer;groupId:string|null;candidateUserIds:string[];candidatePersonIds:Record<string,string>;
 /** Only Round robin freezes a chosen member. An Any-member group is checked against current membership. */
 selectedUserId:string|null;fallbackUsed:boolean;missingReason:string|null;
};
export type ContractApprovalRequest={
 id:string;caseId:string;decisionRevision:number;subjectPersonId:string;assignments:ContractApprovalAssignment[];
 document:SigningDocument;status:'pending'|'approved'|'rejected'|'cancelled';cancelReason?:string;
};
export function newContractApprovalRequest(input:{id:string;caseId:string;tenantId:string;companyId:string;decisionRevision:number;subjectPersonId:string;fingerprint:string;assignments:ContractApprovalAssignment[]}):ContractApprovalRequest{
 if(!input.id||!input.subjectPersonId||!Number.isInteger(input.decisionRevision)||input.decisionRevision<1||!/^[a-f0-9]{64}$/.test(input.fingerprint)||input.assignments.length<1||input.assignments.length>30||new Set(input.assignments.map(a=>a.layer.id)).size!==input.assignments.length)throw new SigningError('invalid','Choose valid, distinct approval layers and a verified decision.');
 for(const assignment of input.assignments){
  if(assignment.selectedUserId&&(!assignment.candidateUserIds.includes(assignment.selectedUserId)||!assignment.candidatePersonIds[assignment.selectedUserId]||assignment.candidatePersonIds[assignment.selectedUserId]===input.subjectPersonId))throw new SigningError('invalid','The selected approver must be an eligible, verified person other than the employee.');
 }
 return {id:input.id,caseId:input.caseId,decisionRevision:input.decisionRevision,subjectPersonId:input.subjectPersonId,assignments:structuredClone(input.assignments),status:'pending',document:{
  tenantId:input.tenantId,companyId:input.companyId,subjectId:input.id,subjectType:'contract-approval',contentRevision:1,contentHash:input.fingerprint,actions:[],
  route:{version:1,steps:input.assignments.map((assignment,index)=>({id:assignment.layer.id,role:'approval:'+assignment.layer.id,kind:'approve',signature:false,stage:index+1,required:true,
   holderId:assignment.layer.pick==='roundRobin'?assignment.selectedUserId:assignment.groupId===null&&assignment.candidateUserIds.length===1?assignment.candidateUserIds[0]:null,
   ...(assignment.selectedUserId&&assignment.candidatePersonIds[assignment.selectedUserId]?{holderPersonId:assignment.candidatePersonIds[assignment.selectedUserId]}:{}),label:assignment.layer.name,
  }))},
 }};
}
export function pendingContractApproval(request:ContractApprovalRequest):ContractApprovalAssignment|null{
 if(request.status!=='pending')return null;
 const step=pendingSigningSteps(request.document)[0];
 return step?request.assignments.find(assignment=>assignment.layer.id===step.id)??null:null;
}
export function contractApprovalCanAct(request:ContractApprovalRequest,input:{userId:string;personId:string;activeUserIds:readonly string[];currentGroupMembers:readonly string[]}):boolean{
 const assignment=pendingContractApproval(request);
 if(!assignment||!input.personId||input.personId===request.subjectPersonId||!input.activeUserIds.includes(input.userId))return false;
 if(assignment.layer.pick==='any'&&assignment.groupId)return input.currentGroupMembers.includes(input.userId);
 const pending=pendingSigningSteps(request.document)[0];
 return (assignment.layer.pick!=='roundRobin'||pending.holderId===input.userId)&&assignment.candidateUserIds.includes(input.userId)&&assignment.candidatePersonIds[input.userId]===input.personId;
}
export function actOnContractApproval(request:ContractApprovalRequest,input:{id:string;layerId:string;userId:string;personId:string;name:string;action:'approve'|'reject';reason:string;at:string;activeUserIds:readonly string[];currentGroupMembers:readonly string[]}):ContractApprovalRequest{
 const existing=request.document.actions.find(action=>action.id===input.id);
 if(existing){
  if(existing.actorId===input.userId&&existing.actorPersonId===input.personId&&existing.stepId===input.layerId&&existing.action===(input.action==='approve'?'approved':'returned')&&existing.comment===input.reason.trim())return request;
  throw new SigningError('conflict','This approval action reference was already used.');
 }
 if(!contractApprovalCanAct(request,input))throw new SigningError('forbidden','Only the current eligible approver can act.');
 const step=pendingSigningSteps(request.document)[0];
 if(step.id!==input.layerId)throw new SigningError('conflict','The approval has moved to another layer. Reload before acting.');
 if(input.action==='reject'&&!input.reason.trim())throw new SigningError('invalid','Enter the rejection reason.');
 const claimed={...request.document,route:{...request.document.route,steps:request.document.route.steps.map(row=>row.id===step.id?{...row,holderId:input.userId,holderPersonId:input.personId}:row)}};
 const document=recordSigningAction(claimed,{requiredRoles:[]},{id:input.id,stepId:step.id,actorId:input.userId,actorPersonId:input.personId,actorName:input.name,revision:claimed.contentRevision,hash:claimed.contentHash,action:input.action==='approve'?'approved':'returned',comment:input.reason,at:input.at});
 return {...request,document,status:input.action==='reject'?'rejected':signingComplete(document,{requiredRoles:[]})?'approved':'pending'};
}
export function cancelContractApproval(request:ContractApprovalRequest,reason:string):ContractApprovalRequest{
 if(request.status!=='pending')return request;
 if(!reason.trim())throw new SigningError('invalid','Record why the approval was stopped.');
 return {...request,status:'cancelled',cancelReason:reason.trim()};
}
