/** Public, serializable resignation journey contract. IDs remain the existing resignation request UUIDs. */
import type {Block,Document} from './lifecycle-v9-model';
export type ResignationStage='decision'|'retention'|'offer'|'accepted'|'leaving'|'retained'|'withdrawn';
export type ResignationOffer={position:string;jobGrade:string;basicSalary:string;effectiveDate:string;justification:string};
export type ResignationPerson={id:string;name:string};
export type ResignationComment={id:string;by:ResignationPerson;at:string;text:string};
export type ResignationPriorCase={id:string;number:string;stage:ResignationStage;submittedOn:string;closedOn:string|null;offer:ResignationOffer|null};
export type ResignationAttachment={id:string;name:string;mimeType:string;size:number};
export type ResignationLetterStepView={id:string;order:number;action:'Review'|'Approve'|'Sign';people:ResignationPerson[];owner:boolean;status:'pending'|'waiting'|'done';signedBy:string|null;signedAt:string|null};
export type ResignationLetterView={id:string;kind:'retention'|'acceptance';name:string;revision:number;templateVersion:number;document:Document|null;opened:boolean;generatedOn:string;state:string;private:boolean;blocks:Block[];editableBlocks:Block[]|null;mergeValues:Record<string,string>;routing:ResignationLetterStepView[];sentBack:{by:string;reason:string;at:string;recall:boolean}|null;changes:{field:string;before:string;after:string}[];capabilities:{open:boolean;review:boolean;approve:boolean;sign:boolean;sendBack:boolean;recall:boolean;edit:boolean;correct:boolean;resend:boolean;withdrawOffer:boolean};downloadUrl:string|null};
export type ResignationTaskKind='decision'|'fyi'|'review'|'approve'|'sign'|'update'|'upload';
export type ResignationTaskView={id:string;caseId:string;caseNumber:string;revision:number;employeeName:string;employeeCode:string;title:string;kind:ResignationTaskKind;documentId:string|null;dueOn:string|null;overdue:boolean;team:boolean;tagged:boolean;status:'todo'|'progress';onIt:ResignationPerson|null;canComment:boolean;actionable:boolean;uploadLabel:string|null};
export type ResignationCaseView={id:string;number:string;revision:number;employmentId:string;employeeName:string;employeeCode:string;companyId:string;companyName:string;businessGroup:string;department:string;position:string;jobGrade:string;currentBasicSalary:string|null;stage:ResignationStage;submittedOn:string;lastWorkingDay:string;reason:string;noticeLabel:string;earliestLastDay:string;offer:ResignationOffer|null;offerReplyBy:string|null;offerRemindOn:string|null;offerBlock:string|null;offboardingCaseId:string|null;replacementNeeded:boolean|null;deciders:ResignationPerson[];keptInLoop:ResignationPerson[];decisionDueOn:string|null;comments:ResignationComment[];priorCases:ResignationPriorCase[];attachments:ResignationAttachment[];letters:ResignationLetterView[];emails:{id:string;name:string;subject:string;body:string;editable:boolean}[];tasks:ResignationTaskView[];blocked:string[];capabilities:{withdraw:boolean;accept:boolean;offer:boolean;comment:boolean;retry:boolean};};
export type ResignationEmployeeView={today:string;earliestLastDay:string;noticeLabel:string;canSubmit:boolean;cases:ResignationCaseView[]};
export type ResignationInbox={items:ResignationTaskView[];cases:ResignationCaseView[];total:number;actionableTotal:number;fyiTotal:number};
export type ResignationJourneyCommand=
 | {type:'withdraw'}
 | {type:'accept';lastWorkingDay:string;replacementNeeded:boolean}
 | {type:'offer';offer:ResignationOffer}
 | {type:'comment';text:string}
 | {type:'openLetter';documentId:string;documentRevision:number}
 | {type:'letterAction';documentId:string;documentRevision:number;action:'review'|'approve'|'sign';signature?:string;consent?:boolean;blocks?:Block[]}
 | {type:'sendBack';documentId:string;documentRevision:number;reason:string}
 | {type:'recall';documentId:string;documentRevision:number}
 | {type:'updateLetter';documentId:string;documentRevision:number;blocks?:Block[];lastWorkingDay?:string;reason?:string}
 | {type:'resendLetter';documentId:string;documentRevision:number}
 | {type:'withdrawOffer';documentId:string;documentRevision:number;reason:string}
 | {type:'declineOffer';documentId:string;documentRevision:number}
 | {type:'approvalTask';taskId:string;action:'approve'|'review';comment?:string}
 | {type:'updateEmail';emailTemplateId:string;subject:string;body:string}
 | {type:'taskProgress';taskId:string;status:'todo'|'progress'}
 | {type:'retry';runId?:string};
export type ResignationCommandInput={caseId:string;revision:number;command:ResignationJourneyCommand};
export type ResignationSubmitInput={employmentId:string;lastWorkingDay:string;reason?:string;documents?:{name:string;mimeType:string;content:Uint8Array}[]};
export class ResignationJourneyError extends Error{constructor(readonly code:'forbidden'|'invalid'|'conflict'|'not_found',message:string){super(message);this.name='ResignationJourneyError';}}

export type ResignationUploadInput={caseId:string;revision:number;taskId:string;name:string;mimeType:string;content:Uint8Array};
