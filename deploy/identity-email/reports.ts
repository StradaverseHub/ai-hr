/** Private report delivery orchestration. Preparation and identity come from server owners, never IPC. */
import {z} from 'zod';
import {masterDeliveryRequest,MASTER_EMAIL_ATTACHMENT_MAX_BYTES,type MasterDeliveryOutcome,type MasterDeliveryReason} from '../../lib/employee-master-delivery-model';
import type {MasterRenderContext} from './render-context';
import {notificationSmtpFailure} from '../../lib/notification-email-model';
export type MasterDeliveryTarget=MasterRenderContext&{subject:string;email:string};
export type MasterPreparedAttachment={bytes:Uint8Array;filename:string;contentType:string;rowCount:number;scopeIds:string[]};
export class MasterDeliveryPreparationError extends Error {constructor(public readonly reason:'notEligible'|'generationFailed'|'attachmentTooLarge'){super('Report preparation was refused.');}}
export interface MasterDeliveryDependencies {
 ready():Promise<boolean>;
 target(id:string,token:string):Promise<MasterDeliveryTarget|null>;
 verifyRecipient(target:MasterDeliveryTarget):Promise<'verified'|'changed'|'unavailable'>;
 prepare(id:string,token:string,target:MasterDeliveryTarget):Promise<MasterPreparedAttachment>;
 /** Canonical field/company/RLS authorization runs after generation, before the final provider check. */
 authorize(id:string,token:string,target:MasterDeliveryTarget):Promise<boolean>;
 /** Rechecks the exact durable target, consent/schedule/report versions and both principals at send time. */
 start(id:string,token:string,target:MasterDeliveryTarget):Promise<boolean>;
 finish(id:string,token:string,outcome:MasterDeliveryOutcome,reason:MasterDeliveryReason|null,metadata?:{rowCount:number;scopeIds:string[]}):Promise<boolean>;
 send(target:MasterDeliveryTarget,attachment:MasterPreparedAttachment,messageId:string):Promise<void>;
 origin:string;
}
export function createMasterReportDeliveryService(d:MasterDeliveryDependencies) {
 const domain=()=>{const url=new URL(d.origin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Invalid managed report origin.');return url.hostname;};
 return async(input:unknown)=>{
  const parsed=masterDeliveryRequest.parse(input);const host=domain();
  if(parsed.op==='status')return {version:1 as const,ready:await d.ready()};
  const {occurrenceId:id,leaseToken:token}=parsed;
  if(!await d.ready())return {outcome:'unavailable' as const};
  const finish=async(outcome:MasterDeliveryOutcome,reason:MasterDeliveryReason|null,metadata?:{rowCount:number;scopeIds:string[]})=>{if(!await d.finish(id,token,outcome,reason,metadata))throw new Error('Report delivery outcome could not be recorded.');return {outcome};};
  const target=await d.target(id,token);if(!target)return finish('skipped','notEligible');
  if(!z.email().max(320).regex(/^[\x21-\x7e]+$/).safeParse(target.email).success)return finish('skipped','notEligible');
  const first=await d.verifyRecipient(target);if(first==='unavailable')return {outcome:'unavailable' as const};if(first!=='verified')return finish('skipped','recipientChanged');
  let attachment:MasterPreparedAttachment;
  try{attachment=await d.prepare(id,token,target);}catch(error){return error instanceof MasterDeliveryPreparationError&&error.reason==='notEligible'?finish('skipped','notEligible'):finish('failed',error instanceof MasterDeliveryPreparationError&&error.reason==='attachmentTooLarge'?'attachmentTooLarge':'generationFailed');}
  if(attachment.bytes.byteLength>MASTER_EMAIL_ATTACHMENT_MAX_BYTES)return finish('failed','attachmentTooLarge');
  if(!attachment.bytes.byteLength||attachment.contentType!=='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'||!/^[-a-zA-Z0-9_.]{1,150}\.xlsx$/.test(attachment.filename)||!Number.isSafeInteger(attachment.rowCount)||attachment.rowCount<0||attachment.rowCount>50000||attachment.scopeIds.length>100||attachment.scopeIds.some(id=>!z.uuid().safeParse(id).success)||JSON.stringify([...attachment.scopeIds].sort())!==JSON.stringify([...target.companyIds].sort()))return finish('failed','generationFailed');
  if(!await d.authorize(id,token,target))return finish('skipped','notEligible');
  // Recipient verification can change during workbook generation. Check immediately before claiming SMTP.
  const fresh=await d.verifyRecipient(target);if(fresh==='unavailable')return {outcome:'unavailable' as const};if(fresh!=='verified')return finish('skipped','recipientChanged');
  if(!await d.start(id,token,target))return {outcome:'busy' as const};
  let outcome:MasterDeliveryOutcome='sent',reason:MasterDeliveryReason|null=null;
  try{await d.send(target,attachment,`<employee-master-${id}@${host}>`);}catch(error){const failure=notificationSmtpFailure(error);outcome=failure.outcome==='uncertain'?'uncertain':'failed';reason=outcome==='uncertain'?'uncertain':failure.error==='smtpRejected'?'smtpRejected':'smtpUnavailable';}
  // A lost finish acknowledgement leaves started durable, so the reclaim path can only mark uncertain.
  return finish(outcome,reason,{rowCount:attachment.rowCount,scopeIds:attachment.scopeIds});
 };
}
