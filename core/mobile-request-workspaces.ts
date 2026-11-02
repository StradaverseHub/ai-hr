import {createHash} from 'node:crypto';
import type {SessionContext} from '../db/client';
import {withMobileCommandReceipt,canonicalJson} from './mobile-command-receipt';
import {myEmployment} from './read';
import {isCurrentAssignedApproval} from './assigned-approval-focus';
import {listProfileChangeRequests,pendingProfileTaskMetadata,decideProfileChange,ProfileChangeReasonRequiredError,ProfileChangeFieldClosedError} from './profile';
import {listProfileAttachments,readProfileAttachment} from './profile-attachments';
import {getProfilePhotoProposal,getPersonPhoto} from './person-photo';
import {listResignationRequests,decideResignation,getResignationAttachmentById,ResignationError} from './offboarding';
import {pendingNoticeAcknowledgementTasks,employeeNoticeById,noticeAttachmentMetadata,getNoticeAttachment,acknowledgeNotice,NoticeError} from './notice';
import {EssProfileError} from '../lib/personnel-ess-model';
import {profileProposalReviewLines} from '../lib/profile-proposal-display';
import type {PersonnelLabelResolver} from '../lib/personnel-field-label';
import {isMobileBinaryType,hasMobileBinarySignature,MOBILE_ATTACHMENT_TYPES} from '../lib/mobile-api/binary-types';
import {RequestWorkspaceDecisionResult,type RequestWorkspaceKind,type RequestWorkspaceCommand,type RequestWorkspaceResult,type RequestWorkspace} from '../lib/mobile-api/v2/request-workspaces';
import {decisionRefusal,type TaskDocument} from './mobile-approvals';
const refused=(code:'not_assigned'|'stale_step'|'self_approval'|'reason_required')=>({outcome:'refused' as const,code});
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
function found(value:Omit<RequestWorkspace,'expected'>):RequestWorkspaceResult{return {outcome:'found',workspace:{...value,expected:{digest:digest(value)}} as RequestWorkspace};}
export async function readRequestWorkspace(ctx:SessionContext,kind:RequestWorkspaceKind,id:string,labels:PersonnelLabelResolver):Promise<RequestWorkspaceResult>{
 if(kind==='noticeAcknowledgement'){
  const [noticeId,employmentId,version]=id.split(':');
  const task=(await pendingNoticeAcknowledgementTasks(ctx)).find(r=>r.noticeId===noticeId&&r.employmentId===employmentId&&r.contentVersion===Number(version));
  if(!task)return refused('not_assigned');
  const n=await employeeNoticeById(ctx,employmentId,noticeId);if(!n||n.contentVersion!==Number(version)||n.acknowledgedAt)return refused('not_assigned');
  const docs=await noticeAttachmentMetadata(ctx,noticeId);
  return found({kind,id,subject:n.title,body:n.body,contentVersion:n.contentVersion,publishedBy:n.publishedBy,publishedAt:n.publishedAt?.toISOString()??null,startOn:n.startOn,endOn:n.showEndDate?n.endOn:null,documents:docs.map(d=>({ref:d.id,name:d.fileName}))} as Omit<Extract<RequestWorkspace,{kind:'noticeAcknowledgement'}>,'expected'>);
 }
 if(kind==='profile'){
  if(!(await pendingProfileTaskMetadata(ctx)).some(r=>r.id===id))return refused('not_assigned');
  const [r]=await listProfileChangeRequests(ctx,{requestId:id,status:'pending'});if(!r||r.personId===ctx.personId)return refused('not_assigned');
  const docs=(await listProfileAttachments(ctx,id)).map(d=>({ref:d.id,name:d.fileName}));
  const photo=r.proposed&&typeof r.proposed==='object'&&'kind' in r.proposed&&r.proposed.kind==='photo';
  if(photo){if(r.currentPhotoPresent)docs.unshift({ref:'photo-current',name:labels('essProfile.currentPhoto','Current photo')});docs.push({ref:'photo-proposed',name:labels('essProfile.proposedPhoto','Proposed photo')});}
  const lines=profileProposalReviewLines(r.proposed,r.review,labels,{mask:false}).filter(l=>l.fieldId!=='profile.personal_details.photo').map(l=>({key:l.key,label:l.label,record:l.recordLabel,before:l.currentValue,after:l.value}));
  return found({kind,id,subject:r.employee,code:r.employeeCode,lines,documents:docs} as Omit<Extract<RequestWorkspace,{kind:'profile'}>,'expected'>);
 }
 if(!await isCurrentAssignedApproval(ctx,{kind:'resignation',id},{attendance:false,claims:false}))return refused('not_assigned');
 const [r]=await listResignationRequests(ctx,{requestId:id,status:'pending'});if(!r||r.personId===ctx.personId)return refused('not_assigned');
 return found({kind,id,subject:r.employee,code:r.employeeCode,lastWorkingDay:r.lastWorkingDay,reason:r.reason,documents:r.documents.map(d=>({ref:d.id,name:d.fileName}))} as Omit<Extract<RequestWorkspace,{kind:'resignation'}>,'expected'>);
}
class Refused extends Error{constructor(readonly code:'not_assigned'|'stale_step'|'reason_required'){super(code);}}
export async function decideRequestWorkspace(ctx:SessionContext,kind:RequestWorkspaceKind,id:string,c:RequestWorkspaceCommand,labels:PersonnelLabelResolver){
 const me=await myEmployment(ctx);const actor=kind==='noticeAcknowledgement'?id.split(':')[1]:me?.employmentId;
 if(!actor)return {outcome:'refused' as const,code:'employment_required' as const};
 try{return await withMobileCommandReceipt(ctx,{kind:'request.decision',requestId:c.requestId,actorEmploymentId:actor,response:RequestWorkspaceDecisionResult,intent:{kind,id,action:c.action,reason:c.reason??null,expected:c.expected}},async tx=>{
  const fresh=await readRequestWorkspace(ctx,kind,id,labels);if(fresh.outcome!=='found')throw new Refused('not_assigned');
  if(fresh.workspace.expected.digest!==c.expected.digest)throw new Refused('stale_step');
  if(kind==='noticeAcknowledgement'){
   if(c.action!=='acknowledge')throw new Refused('stale_step');
   const [noticeId,employmentId,version]=id.split(':');await acknowledgeNotice(ctx,noticeId,employmentId,Number(version),{reportedChannel:'mobile'},tx);
   return {outcome:'accepted' as const,status:'acknowledged' as const};
  }
  if(c.action!=='approve'&&c.action!=='reject')throw new Refused('stale_step');
  if(kind==='profile'){
   if(c.action==='reject'&&!c.reason?.trim())throw new Refused('reason_required');
   await decideProfileChange(ctx,{requestId:id,decision:c.action==='approve'?'approved':'rejected',reason:c.reason,deciderEmploymentId:actor},tx);
   return {outcome:'accepted' as const,status:c.action==='approve'?'approved' as const:'rejected' as const};
  }
  if(fresh.workspace.kind!=='resignation')throw new Refused('not_assigned');
  const result=await decideResignation(ctx,{requestId:id,decision:c.action==='approve'?'accepted':'rejected',deciderEmploymentId:actor,expectedLastWorkingDay:fresh.workspace.lastWorkingDay},tx);
  return {outcome:'accepted' as const,status:result.status};
 });}catch(e){if(e instanceof Refused)return refused(e.code);if(e instanceof ProfileChangeReasonRequiredError)return refused('reason_required');if(e instanceof ProfileChangeFieldClosedError||e instanceof EssProfileError||e instanceof ResignationError||e instanceof NoticeError)return {outcome:'refused' as const,code:'decision_refused' as const};return decisionRefusal(e);}
}
/** Task-scoped byte projection: every open rechecks assignment and attachment membership. */
export async function requestWorkspaceDocument(ctx:SessionContext,kind:RequestWorkspaceKind,id:string,ref:string,labels:PersonnelLabelResolver):Promise<TaskDocument|{outcome:'refused';code:'not_assigned'|'no_document'|'unsupported_document'}>{
 const fresh=await readRequestWorkspace(ctx,kind,id,labels);if(fresh.outcome!=='found')return {outcome:'refused',code:'not_assigned'};
 if(!fresh.workspace.documents.some(d=>d.ref===ref))return {outcome:'refused',code:'no_document'};
 let file:{content:Buffer;mimeType:string;fileName?:string}|null=null;
 if(kind==='noticeAcknowledgement')file=await getNoticeAttachment(ctx,id.split(':')[0],ref);
 else if(kind==='resignation')file=await getResignationAttachmentById(ctx,ref);
 else if(ref==='photo-proposed')file=await getProfilePhotoProposal(ctx,id);
 else if(ref==='photo-current'){const [r]=await listProfileChangeRequests(ctx,{requestId:id,status:'pending'});if(r)file=await getPersonPhoto(ctx,r.personId);}
 else file=await readProfileAttachment(ctx,ref);
 if(!file)return {outcome:'refused',code:'no_document'};
 const bytes=new Uint8Array(file.content),type=file.mimeType.toLowerCase();
 if(!isMobileBinaryType(type,MOBILE_ATTACHMENT_TYPES)||!hasMobileBinarySignature(type,bytes))return {outcome:'refused',code:'unsupported_document'};
 return {outcome:'file',contentType:type,fileName:file.fileName??'profile-photo',bytes};
}
