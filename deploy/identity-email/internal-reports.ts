/** Internal report transport consumes canonical broker material, never Auth records or keys. */
import {renderEmailDesign} from '../../lib/email-design/render';
import {emailDesignEnvelope,type EmailDesignEnvelope} from '../../lib/email-design/model';
import {masterDeliveryRequest,type MasterDeliveryOutcome,type MasterDeliveryReason} from '../../lib/employee-master-delivery-model';
import {fingerprintReportBytes} from '../../lib/employee-master-artifact';
import {xlsxEmailAttachment,XLSX_EMAIL_ATTACHMENT_MAX_BYTES} from '../../lib/email-attachment';
import {notificationSmtpFailure} from '../../lib/notification-email-model';
import {reportBrokerResponse,type ReportBrokerRequest,type ReportBrokerResponse} from '../../lib/internal-auth/report-broker-model';
import {sendSmtp,type Relay} from '../../lib/internal-auth/smtp';
import {employeeMasterMailMessage} from './report-message';
import {MasterDeliveryPreparationError,type MasterDeliveryTarget,type MasterPreparedAttachment} from './reports';
export interface InternalReportDependencies {
 broker(input:ReportBrokerRequest):Promise<ReportBrokerResponse>;
 rendererReady():Promise<boolean>;
 prepare(id:string,token:string,target:MasterDeliveryTarget):Promise<MasterPreparedAttachment>;
 finish(id:string,token:string,outcome:MasterDeliveryOutcome,reason:MasterDeliveryReason|null,metadata?:{rowCount:number;scopeIds:string[]}):Promise<boolean>;
 send(relay:Relay,target:MasterDeliveryTarget,attachment:MasterPreparedAttachment,messageId:string,design?:EmailDesignEnvelope):Promise<void>;
 origin:string;
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export async function sendInternalEmployeeMasterSmtp(relay:Relay,target:MasterDeliveryTarget,attachment:MasterPreparedAttachment,messageId:string,rawDesign?:EmailDesignEnvelope){
 const payload=xlsxEmailAttachment.parse({bytes:attachment.bytes,filename:attachment.filename,contentType:attachment.contentType});
 const design=rawDesign?emailDesignEnvelope.parse(rawDesign):null;if(design&&(design.kind!=='employee_master_report'||design.locale!==target.locale))throw Error('Email design binding changed.');
 await sendSmtp(relay,{to:target.email,...renderEmailDesign(design?.document??null,'employee_master_report',target.locale,employeeMasterMailMessage(target.locale),design?.data),messageId,
  attachment:payload});
}
export function createInternalMasterReportDeliveryService(d:InternalReportDependencies){
 const origin=new URL(d.origin);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Invalid report origin.');
 return async(input:unknown)=>{
  const request=masterDeliveryRequest.parse(input);
  if(request.op==='status'){try{const reply=reportBrokerResponse.parse(await d.broker({phase:'status'}));return {version:1 as const,ready:'available' in reply&&reply.available&&await d.rendererReady()};}catch{return {version:1 as const,ready:false};}}
  const {occurrenceId:id,leaseToken:token}=request;
  const finish=async(outcome:MasterDeliveryOutcome,reason:MasterDeliveryReason|null,metadata?:{rowCount:number;scopeIds:string[]})=>{if(!await d.finish(id,token,outcome,reason,metadata))throw new Error('Report outcome acknowledgement unavailable.');return {outcome};};
  const refused=(reason:string)=>reason==='notEligible'?finish('skipped','notEligible'):reason==='generationFailed'?finish('failed','generationFailed'):reason==='attachmentTooLarge'?finish('failed','attachmentTooLarge'):Promise.resolve({outcome:reason==='busy'?'busy':'unavailable'});
  let inspected:ReportBrokerResponse;
  try{inspected=reportBrokerResponse.parse(await d.broker({phase:'inspect',occurrenceId:id,leaseToken:token}));}catch{return {outcome:'unavailable' as const};}
  if('available' in inspected)return {outcome:'unavailable' as const};
  if(!inspected.ok)return refused(inspected.reason);
  if(inspected.phase!=='inspect')return {outcome:'unavailable' as const};
  const target=inspected.target;let attachment:MasterPreparedAttachment;
  try{
   attachment=await d.prepare(id,token,target);
   if(attachment.bytes.byteLength>XLSX_EMAIL_ATTACHMENT_MAX_BYTES)throw new MasterDeliveryPreparationError('attachmentTooLarge');
   xlsxEmailAttachment.parse({bytes:attachment.bytes,filename:attachment.filename,contentType:attachment.contentType});
   if(!Number.isSafeInteger(attachment.rowCount)||attachment.rowCount<0||attachment.rowCount>50000||!same([...attachment.scopeIds].sort(),[...target.companyIds].sort()))throw new Error('Invalid prepared report.');
  }catch(error){return error instanceof MasterDeliveryPreparationError&&error.reason==='notEligible'?finish('skipped','notEligible'):finish('failed',error instanceof MasterDeliveryPreparationError&&error.reason==='attachmentTooLarge'?'attachmentTooLarge':'generationFailed');}
  const artifact=fingerprintReportBytes(attachment.bytes,attachment.contentType);
  let started:ReportBrokerResponse;
  try{started=reportBrokerResponse.parse(await d.broker({phase:'start',occurrenceId:id,leaseToken:token,inspectionProof:inspected.inspectionProof,expectedArtifact:artifact}));}
  // A timeout, malformed/partial response or lost EOF may follow commit. Never infer pending,
  // finish/retry, or send SMTP from this branch. Durable started expiry becomes uncertain.
  catch{return {outcome:'unknown' as const};}
  if('available' in started)return {outcome:'unknown' as const};
  if(!started.ok)return refused(started.reason);
  if(started.phase!=='start')return {outcome:'unknown' as const};
  const metadata={rowCount:attachment.rowCount,scopeIds:attachment.scopeIds};
  // Integrity failures are definite pre-SMTP generation failures, including after committed start.
  // Keep them OUTSIDE the SMTP uncertainty catch; broker-fetched manifest is authority.
  let intact=false;
  try{intact=same(started.target,target)&&same(started.artifact,artifact)&&same(fingerprintReportBytes(attachment.bytes,attachment.contentType),started.artifact);}catch{/* Invalid/detached bytes are a definite pre-SMTP failure. */}
  if(!intact)return finish('failed','generationFailed',metadata);
  let outcome:MasterDeliveryOutcome='sent',reason:MasterDeliveryReason|null=null;
  try{await d.send(started.relay,started.target,attachment,`<employee-master-${id}@${origin.hostname}>`,started.design);}
  catch(error){const failure=notificationSmtpFailure(error);outcome=failure.outcome==='uncertain'?'uncertain':'failed';reason=outcome==='uncertain'?'uncertain':failure.error==='smtpRejected'?'smtpRejected':'smtpUnavailable';}
  return finish(outcome,reason,metadata);
 };
}
