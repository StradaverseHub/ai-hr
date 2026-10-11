/** Used only by the root-installed service. Never import this transport into a web action. */
import nodemailer from 'nodemailer';
import type { EmailConfig } from '../../lib/identity/email-model';
import type { WorkflowMailTarget,WorkflowMail } from './notifications';
import { workflowEmailMessage } from './notification-message';
export async function sendWorkflowSmtp(config:EmailConfig,password:string|undefined,target:WorkflowMailTarget,mail:WorkflowMail) {
 const c=config;
 const transport=nodemailer.createTransport({host:c.host,port:c.port,secure:true,
  auth:c.auth?{user:c.user,pass:password!}:undefined,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},
  connectionTimeout:10_000,greetingTimeout:8_000,socketTimeout:15_000,disableFileAccess:true,disableUrlAccess:true});
 try{
  const result=await transport.sendMail({from:{name:c.fromName,address:c.from},to:target.email,replyTo:c.replyTo||undefined,
   envelope:{from:c.from,to:[target.email]},messageId:mail.messageId,...workflowEmailMessage(mail),disableFileAccess:true,disableUrlAccess:true});
  if(result.accepted.length!==1)throw new Error('Relay acceptance not confirmed');
 }finally{transport.close();}
}
