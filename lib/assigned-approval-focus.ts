import {buildApprovalAttentionHash,approvalRowDomId} from './approvals-focus';

export const ASSIGNED_APPROVAL_KINDS=['leave','leaveCancellation','attendance','claim','resignation','managerReview','hrReview','replacementLeave'] as const;
export type AssignedApprovalKind=typeof ASSIGNED_APPROVAL_KINDS[number];
export type AssignedApprovalFocus={kind:AssignedApprovalKind;id:string};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function parseAssignedApprovalFocus(kind:unknown,id:unknown):AssignedApprovalFocus|null{
 if(kind===undefined&&id===undefined)return null;
 if(typeof kind!=='string'||!ASSIGNED_APPROVAL_KINDS.some(value=>value===kind)||typeof id!=='string'||!uuid.test(id))throw Error('Invalid assigned approval focus.');
 return {kind:kind as AssignedApprovalKind,id};
}
export function assignedApprovalCategory(kind:AssignedApprovalKind){
 return {leave:'leave',leaveCancellation:'leaveCancellation',attendance:'all',claim:'claim',resignation:'resignations',managerReview:'managerReviews',hrReview:'hrReviews',replacementLeave:'replacementLeave'}[kind];
}
export function assignedApprovalHref(focus:AssignedApprovalFocus){
 const category=assignedApprovalCategory(focus.kind);
 const hash=focus.kind==='leave'||focus.kind==='leaveCancellation'?buildApprovalAttentionHash(focus.kind,focus.id):approvalRowDomId(focus.id);
 return '/approvals?'+new URLSearchParams({category,task:focus.kind,requestId:focus.id})+'#'+hash;
}
