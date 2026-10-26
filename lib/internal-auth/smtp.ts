/** Auth-owned transport only. No database, private record, session or relay selection dependency. */
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { EmailSettingsError } from '../identity/email-model';
import { xlsxEmailAttachment, type XlsxEmailAttachment } from '../email-attachment';
import {prepareSmtpRelay} from './smtp-credentials';
import type {EmailRelay} from '../identity/email-relay';

export type Relay=EmailRelay;
type TextMail={to:string;subject:string;text:string};
export type Mail=TextMail&(
  | {attachment?:undefined;messageId?:string}
  | {attachment:XlsxEmailAttachment;messageId:string}
);
export type MailTransport=(relay:Relay,message:Mail)=>Promise<void>;

// The delivery owner constructs this deterministically from its durable occurrence. Validate safe
// header syntax here; the transport never invents or replaces a provided delivery identity.
const messageId=z.string().max(320).regex(/^<[A-Za-z0-9][A-Za-z0-9._-]{0,119}@[A-Za-z0-9.-]{1,253}>$/)
  .refine(value=>value.slice(value.indexOf('@')+1,-1).split('.').every(label=>
    label.length<=63&&/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)));
const message=z.object({to:z.string(),subject:z.string(),text:z.string(),
  messageId:messageId.optional(),attachment:xlsxEmailAttachment.optional(),
}).strict().superRefine((mail,ctx)=>{
  if(mail.attachment&&(!mail.messageId||!z.email().max(320).regex(/^[\x21-\x7e]+$/).safeParse(mail.to).success))
    ctx.addIssue({code:'custom',message:'Attachment requires a delivery identity and one canonical recipient.'});
});

export const sendSmtp:MailTransport=async(relay,input)=>{
  const parsed=message.safeParse(input);
  if(!parsed.success)throw new EmailSettingsError('invalid');
  const mail=parsed.data,delivery=await prepareSmtpRelay(relay),c=delivery.config;
  const transport=nodemailer.createTransport({host:c.host,port:c.port,secure:c.security==='tls',
    ...(c.security==='starttls'?{requireTLS:true}:{}),
    auth:c.auth?(c.authentication==='microsoft365'?{type:'OAuth2' as const,user:c.user,accessToken:delivery.accessToken}:{user:c.user,pass:delivery.password}):undefined,
    tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},connectionTimeout:10_000,greetingTimeout:8_000,socketTimeout:15_000,
    disableFileAccess:true,disableUrlAccess:true});
  try{
    const result=await transport.sendMail({from:{name:c.fromName,address:c.from},to:mail.to,
      replyTo:c.replyTo||undefined,envelope:{from:c.from,to:[mail.to]},subject:mail.subject,text:mail.text,
      ...(mail.messageId?{messageId:mail.messageId}:{}),
      ...(mail.attachment?{attachments:[{filename:mail.attachment.filename,
        content:Buffer.isBuffer(mail.attachment.bytes)?mail.attachment.bytes:Buffer.from(mail.attachment.bytes),
        contentType:mail.attachment.contentType}]}:{}),
      disableFileAccess:true,disableUrlAccess:true});
    if(result.accepted.length!==1)throw new EmailSettingsError('uncertain');
  }finally{transport.close();}
};
