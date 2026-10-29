/** Private workflow transport orchestration. Unit-testable without giving the web process SMTP secrets. */
import {emailDesignEnvelope,type EmailDesignEnvelope,type EmailKind,type EmailLocale} from '../../lib/email-design/model';
import { z } from 'zod';
import {deliverAttendanceCc,type AttendanceCcDeliveryPorts} from './attendance-cc';
import type {AttendanceCcMessage} from '../../lib/attendance-cc-mail';
import { notificationEmailRequest, notificationEmailCategory, notificationEmailLink, notificationSmtpFailure,
  type NotificationEmailCategory, type NotificationEmailLocale, type NotificationEmailOutcome, type NotificationEmailError } from '../../lib/notification-email-model';
import { emailConfigSchema, type EmailConfig } from '../../lib/identity/email-model';
import type { EmailState } from './service';
import { assessmentReminderMailSchema,type AssessmentReminderTask,type AssessmentReminderWords } from '../../lib/assessment-reminder-mail';
export type WorkflowMailTarget={user_id:string;subject:string;email:string;category:string;link_path:string|null;severity:string;locale:string};
export type WorkflowMail={category:NotificationEmailCategory;locale:NotificationEmailLocale;link:string;action:boolean;messageId:string;assessmentTasks?:AssessmentReminderTask[];assessmentWords?:AssessmentReminderWords|null;attendanceCc?:AttendanceCcMessage;design?:EmailDesignEnvelope};
export interface WorkflowEmailDependencies {
  ready():Promise<boolean>;
  design?(id:string,token:string,kind:EmailKind,locale:EmailLocale,cc?:boolean):Promise<unknown>;
  lettersReady?():Promise<boolean>;
  target(id:string,token:string):Promise<WorkflowMailTarget|null>;
  verifyRecipient(target:WorkflowMailTarget):Promise<'verified'|'changed'|'unavailable'>;
  assessmentTasks?(id:string,token:string):Promise<unknown>;
  start(id:string,token:string,target:WorkflowMailTarget):Promise<boolean>;
  finish(id:string,token:string,outcome:NotificationEmailOutcome,error:NotificationEmailError|null):Promise<boolean>;
  send(target:WorkflowMailTarget,mail:WorkflowMail):Promise<void>;
  origin:string;
  cc?:AttendanceCcDeliveryPorts;
}
/** Compare the secret reference as well as the public SMTP fields; a changed realm is not managed. */
export function activeWorkflowRelay(state:EmailState,realm:{smtpServer?:Record<string,string>}):{config:EmailConfig;vaultKey:string|null}|null {
  const active=state.active,s=realm.smtpServer;
  if(!active||!s||!emailConfigSchema.safeParse(active.config).success||active.config.authentication==='microsoft365')return null;
  const c=active.config;
  const expected={host:c.host,port:String(c.port),ssl:String(c.security==='tls'),starttls:String(c.security==='starttls'),auth:String(c.auth),authType:'basic',from:c.from,fromDisplayName:c.fromName,replyTo:c.replyTo,user:c.auth?c.user:''};
  if(Object.entries(expected).some(([k,v])=>s[k]!==v))return null;
  if(c.auth&&(!active.vaultKey||s.password!=='${vault.'+active.vaultKey+'}'))return null;
  return active;
}
export function createNotificationEmailService(d:WorkflowEmailDependencies) {
  return async(input:unknown)=>{
    const request=notificationEmailRequest.parse(input);
    if(request.op==='status') {
      // Validate the configured origin even before there is a queued job.
      notificationEmailLink(d.origin,'/');
      return {version:1 as const,ready:await d.ready(),assessmentReminders:!!d.assessmentTasks,assessmentReminderWords:!!d.assessmentTasks,attendanceCc:!!d.cc,letters:d.lettersReady?await d.lettersReady():false};
    }
    const {deliveryId:id,leaseToken:token}=request;
    if(request.op==='attendanceCcSend')return d.cc?deliverAttendanceCc(id,token,{...d,cc:d.cc}):{outcome:'unavailable' as const};
    if(!await d.ready())return {outcome:'unavailable'};
    const target=await d.target(id,token);
    if(target?.category==='letters'&&(!d.lettersReady||!await d.lettersReady()))return {outcome:'unavailable'};
    if(!target){await d.finish(id,token,'skipped','notEligible');return {outcome:'skipped'};}
    const category=notificationEmailCategory.safeParse(target.category),email=z.email().max(320).regex(/^[\x21-\x7e]+$/).safeParse(target.email);
    let link:string;
    try{link=notificationEmailLink(d.origin,target.link_path);}catch{await d.finish(id,token,'skipped','notEligible');return {outcome:'skipped'};}
    if(!category.success||!email.success){await d.finish(id,token,'skipped','notEligible');return {outcome:'skipped'};}
    const verified=await d.verifyRecipient(target);
    if(verified==='unavailable')return {outcome:'unavailable'}; // No SMTP started; lease can expire safely.
    if(verified!=='verified'){await d.finish(id,token,'skipped','recipientChanged');return {outcome:'skipped'};}
    let assessmentTasks:AssessmentReminderTask[]|undefined,assessmentWords:AssessmentReminderWords|null|undefined;
    if(d.assessmentTasks){
      const prepared=await d.assessmentTasks(id,token);
      if(prepared!==undefined){
        const parsed=assessmentReminderMailSchema.safeParse(prepared);
        if(!parsed.success||!parsed.data.tasks.length){await d.finish(id,token,'skipped','notEligible');return {outcome:'skipped'};}
        assessmentTasks=parsed.data.tasks;assessmentWords=parsed.data.words;
      }
    }
    const locale=(['en','ms','zh','vi','ta','th'] as const).find(l=>l===target.locale)??'en';
    const design=d.design?emailDesignEnvelope.parse(await d.design(id,token,assessmentTasks?'assessment_reminder':`workflow.${category.data}`,locale)):undefined;
    if(!await d.start(id,token,target))return {outcome:'busy'};
    let outcome:NotificationEmailOutcome='sent',error:NotificationEmailError|null=null;
    try {
      await d.send(target,{category:category.data,locale,link,...(design?{design}:{}),action:target.severity==='action',messageId:`<notification-${id}@${new URL(d.origin).hostname}>`,...(assessmentTasks?{assessmentTasks,assessmentWords}:{})});
    }catch(e){({outcome,error}=notificationSmtpFailure(e));}
    // A DB failure after SMTP is never rewritten as rejection. The durable started lease holds it
    // uncertain on expiry, so no caller retries an already accepted message blindly.
    if(!await d.finish(id,token,outcome,error))throw new Error('Workflow email result could not be recorded');
    return {outcome};
  };
}
