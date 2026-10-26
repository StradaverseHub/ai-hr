/** Letter lifecycle policy snapshots. These are user-configured workflow rules, not HR/legal policy. */
import {z} from 'zod';
export const LETTER_CAPABILITIES=['read','template','generate','approve','issue','report','settings'] as const;
export type LetterCapability=typeof LETTER_CAPABILITIES[number];
export const LETTER_STATES=['draft','submitted','returned','rejected','approved','issued','void','withdrawn'] as const;
export type LetterState=typeof LETTER_STATES[number];
export type LetterAcknowledgementMode='none'|'acknowledge'|'signature';
export type LetterPolicy={
 version:1;stages:{key:string;label:string;userIds:string[];allowDelegation:boolean}[];
 signatoryUserId:string;signingMode:'authenticated'|'stamp';signatureAssetId:string|null;letterheadAssetId:string|null;
 referenceFormat:string;retentionDays:number;sensitiveLinkMinutes:number;
 acknowledgement:LetterAcknowledgementMode;approvalDueHours:number;acknowledgementDueDays:number;
 reminderHours:number;escalationUserId:string|null;portalNotifications:boolean;emailNotifications:boolean;
};
export class LetterWorkflowError extends Error{
 constructor(public code:'invalid'|'stale'|'state'|'permission'|'selfApproval'|'signatureRequired'|'reasonRequired'|'configuration'|'conflict',public detail?:string){super(`letter:${code}${detail?':'+detail:''}`);this.name='LetterWorkflowError';}
}
const stage=z.object({key:z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),label:z.string().trim().min(1).max(100),userIds:z.array(z.uuid()).min(1).max(50),allowDelegation:z.boolean()}).strict();
const policySchema=z.object({
 version:z.literal(1),stages:z.array(stage).min(1).max(10),signatoryUserId:z.uuid(),signingMode:z.enum(['authenticated','stamp']),signatureAssetId:z.uuid().nullable(),letterheadAssetId:z.uuid().nullable(),
 referenceFormat:z.string().min(1).max(100),retentionDays:z.number().int().min(1).max(36500),sensitiveLinkMinutes:z.number().int().min(1).max(1440),
 acknowledgement:z.enum(['none','acknowledge','signature']),approvalDueHours:z.number().int().min(1).max(8760),acknowledgementDueDays:z.number().int().min(1).max(3650),
 reminderHours:z.number().int().min(1).max(8760),escalationUserId:z.uuid().nullable(),portalNotifications:z.boolean(),emailNotifications:z.boolean(),
}).strict();
export function validateLetterReferenceFormat(format:string){
 const tokens=format.match(/\{[^}]+\}/g)??[];
 if(!/^[A-Za-z0-9/_.{}:-]+$/.test(format)||tokens.filter(token=>/^\{SEQ:[4-8]\}$/.test(token)).length!==1||tokens.some(token=>!/^\{(?:YYYY|COMPANY|SEQ:[4-8])\}$/.test(token))||/[{}]/.test(format.replace(/\{(?:YYYY|COMPANY|SEQ:[4-8])\}/g,'')))throw new LetterWorkflowError('invalid','referenceFormat');
 return format;
}
export function letterReference(format:string,input:{year:string;companyCode:string;sequence:string}){
 validateLetterReferenceFormat(format);
 if(!/^\d{4}$/.test(input.year)||!/^\d{1,18}$/.test(input.sequence)||BigInt(input.sequence)<=BigInt(0)||!input.companyCode.trim()||input.companyCode.length>100)throw new LetterWorkflowError('invalid','reference');
 return format.replace(/\{YYYY\}/g,input.year).replace(/\{COMPANY\}/g,input.companyCode).replace(/\{SEQ:([4-8])\}/,(_token,width:string)=>input.sequence.padStart(Number(width),'0'));
}
export function validateLetterPolicy(input:unknown):LetterPolicy{
 const parsed=policySchema.safeParse(input);if(!parsed.success)throw new LetterWorkflowError('invalid','policy');const policy=parsed.data;
 validateLetterReferenceFormat(policy.referenceFormat);
 if(new Set(policy.stages.map(item=>item.key)).size!==policy.stages.length||policy.stages.some(item=>new Set(item.userIds).size!==item.userIds.length))throw new LetterWorkflowError('invalid','stages');
 const final=policy.stages.at(-1)!;
 if(final.userIds.length!==1||final.userIds[0]!==policy.signatoryUserId||final.allowDelegation)throw new LetterWorkflowError('configuration','signatoryStage');
 if(policy.signingMode==='stamp'&&!policy.signatureAssetId||policy.signingMode==='authenticated'&&policy.signatureAssetId)throw new LetterWorkflowError('configuration','signatureAsset');
 return policy;
}
export type LetterWorkflowHead={state:LetterState;revisionId:string;lockVersion:number;stageIndex:number;createdBy:string};
export type LetterStageDecision={action:'approve'|'return'|'reject';comment:string;confirmSignature:boolean};
/** Fresh authority is established by the transaction owner. This function adjudicates state/order. */
export function letterStageDecision(head:LetterWorkflowHead,policy:LetterPolicy,input:{actorId:string;expectedRevisionId:string;expectedLockVersion:number;decision:LetterStageDecision;delegatedUserId?:string|null}){
 if(head.revisionId!==input.expectedRevisionId||head.lockVersion!==input.expectedLockVersion)throw new LetterWorkflowError('stale');
 if(head.state!=='submitted')throw new LetterWorkflowError('state');
 if(head.createdBy===input.actorId)throw new LetterWorkflowError('selfApproval');
 const stage=policy.stages[head.stageIndex];if(!stage)throw new LetterWorkflowError('configuration','stage');
 const final=head.stageIndex===policy.stages.length-1;
 const users=input.delegatedUserId?[input.delegatedUserId]:stage.userIds;
 if(!users.includes(input.actorId)||final&&input.actorId!==policy.signatoryUserId)throw new LetterWorkflowError('permission');
 if(input.delegatedUserId&&!stage.allowDelegation)throw new LetterWorkflowError('permission');
 if(input.decision.comment.length>2000)throw new LetterWorkflowError('invalid','comment');
 if(input.decision.action!=='approve'&&!input.decision.comment.trim())throw new LetterWorkflowError('reasonRequired');
 if(input.decision.action==='return')return {state:'returned' as const,stageIndex:head.stageIndex,final:false};
 if(input.decision.action==='reject')return {state:'rejected' as const,stageIndex:head.stageIndex,final:false};
 if(final&&!input.decision.confirmSignature)throw new LetterWorkflowError('signatureRequired');
 return {state:final?'approved' as const:'submitted' as const,stageIndex:final?head.stageIndex:head.stageIndex+1,final};
}
export function assertLetterAcknowledgement(input:{state:LetterState;mode:LetterAcknowledgementMode;action:'acknowledge'|'signature';artifactHash:string;expectedArtifactHash:string}){
 if(input.state!=='issued')throw new LetterWorkflowError('state');
 if(!/^[0-9a-f]{64}$/.test(input.artifactHash)||input.expectedArtifactHash!==input.artifactHash)throw new LetterWorkflowError('stale');
 if(input.mode==='none'||input.mode!==input.action)throw new LetterWorkflowError('state');
}
