/** Used only by the root-installed service. Never import this transport into a web action. */
import nodemailer from 'nodemailer';
import type { EmailConfig } from '../../lib/identity/email-model';
import type { WorkflowMailTarget,WorkflowMail } from './notifications';
import type {MasterDeliveryTarget,MasterPreparedAttachment} from './reports';
import { workflowEmailMessage } from './notification-message';
import {employeeMasterMailMessage} from './report-message';
type ManagedMessage={subject:string;text:string;html?:string;messageId:string;attachment?:MasterPreparedAttachment};
async function sendManagedSmtp(config:EmailConfig,password:string|undefined,email:string,mail:ManagedMessage) {
 const c=config;
 if(c.authentication==='microsoft365')throw new Error('Microsoft 365 application credentials require internal authentication.');
 const transport=nodemailer.createTransport({host:c.host,port:c.port,secure:c.security==='tls',...(c.security==='starttls'?{requireTLS:true}:{}),
  auth:c.auth?{user:c.user,pass:password!}:undefined,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},
  connectionTimeout:10_000,greetingTimeout:8_000,socketTimeout:15_000,disableFileAccess:true,disableUrlAccess:true});
 try{
  const result=await transport.sendMail({from:{name:c.fromName,address:c.from},to:email,replyTo:c.replyTo||undefined,
   envelope:{from:c.from,to:[email]},messageId:mail.messageId,subject:mail.subject,text:mail.text,...mail.html?{html:mail.html}:{},
   ...(mail.attachment?{attachments:[{filename:mail.attachment.filename,content:Buffer.from(mail.attachment.bytes),contentType:mail.attachment.contentType}]}:{}),
   disableFileAccess:true,disableUrlAccess:true});
  if(result.accepted.length!==1)throw new Error('Relay acceptance not confirmed');
 }finally{transport.close();}
}
export async function sendWorkflowSmtp(config:EmailConfig,password:string|undefined,target:WorkflowMailTarget,mail:WorkflowMail) {
 return sendManagedSmtp(config,password,target.email,{messageId:mail.messageId,...workflowEmailMessage(mail)});
}
export async function sendEmployeeMasterSmtp(config:EmailConfig,password:string|undefined,target:MasterDeliveryTarget,attachment:MasterPreparedAttachment,messageId:string) {
 return sendManagedSmtp(config,password,target.email,{messageId,...employeeMasterMailMessage(target.locale),attachment});
}
