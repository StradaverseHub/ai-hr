/** Auth-owned transport only. No database, private record, session or relay selection dependency. */
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { EmailSettingsError } from '../identity/email-model';
import { xlsxEmailAttachment, type XlsxEmailAttachment } from '../email-attachment';
import {prepareSmtpRelay} from './smtp-credentials';
import type {EmailRelay} from '../identity/email-relay';
import { managedEmailAttachment, managedEmailSenderProfiles, managedEmailSenderNames, MANAGED_EMAIL_ATTACHMENT_MAX_BYTES, MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT, type ManagedEmailAttachment } from '../managed-email-attachment';

export type Relay=EmailRelay;
type TextMail={to:string;subject:string;text:string;html?:string};
export type Mail=TextMail&(
  | {attachment?:undefined;messageId?:string;attachments?:never;cc?:never;senderProfile?:never}
  | {attachment:XlsxEmailAttachment;messageId:string;attachments?:never;cc?:never;senderProfile?:never}
  | {attachment?:never;attachments:ManagedEmailAttachment[];cc?:string[];senderProfile?:typeof managedEmailSenderProfiles[number];messageId:string}
);
export type MailTransport=(relay:Relay,message:Mail)=>Promise<void>;

// The delivery owner constructs this deterministically from its durable occurrence. Validate safe
// header syntax here; the transport never invents or replaces a provided delivery identity.
const messageId=z.string().max(320).regex(/^<[A-Za-z0-9][A-Za-z0-9._-]{0,119}@[A-Za-z0-9.-]{1,253}>$/)
  .refine(value=>value.slice(value.indexOf('@')+1,-1).split('.').every(label=>
    label.length<=63&&/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)));
const canonicalAddress=z.email().max(320).regex(/^[\x21-\x7e]+$/);
const message=z.object({to:z.string(),subject:z.string(),text:z.string(),html:z.string().max(1000000).optional(),
  messageId:messageId.optional(),attachment:xlsxEmailAttachment.optional(),
  attachments:z.array(managedEmailAttachment).max(MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT).optional(),
  cc:z.array(canonicalAddress).max(1004).optional(),senderProfile:z.enum(managedEmailSenderProfiles).optional(),
}).strict().superRefine((mail,ctx)=>{
  if(mail.attachment&&(!mail.messageId||!z.email().max(320).regex(/^[\x21-\x7e]+$/).safeParse(mail.to).success))
    ctx.addIssue({code:'custom',message:'Attachment requires a delivery identity and one canonical recipient.'});
  if(mail.attachments!==undefined){
    const addresses=[mail.to,...mail.cc??[]], unique=new Set(addresses.map(address=>address.toLowerCase()));
    if(mail.attachment||!mail.messageId||!canonicalAddress.safeParse(mail.to).success||unique.size!==addresses.length||mail.attachments.reduce((sum,attachment)=>sum+attachment.bytes.byteLength,0)>MANAGED_EMAIL_ATTACHMENT_MAX_BYTES)
      ctx.addIssue({code:'custom',message:'Managed delivery requires an identity, unique canonical recipients and bounded attachments.'});
  }else if(mail.cc!==undefined||mail.senderProfile!==undefined)ctx.addIssue({code:'custom',message:'CC and sender profiles require managed delivery.'});
});

export const sendSmtp:MailTransport=async(relay,input)=>{
  const parsed=message.safeParse(input);
  if(!parsed.success)throw new EmailSettingsError('invalid');
  const mail=parsed.data,delivery=await prepareSmtpRelay(relay),c=delivery.config;
  const recipients=[mail.to,...mail.cc??[]];
  const attachments=mail.attachments??(mail.attachment?[mail.attachment]:[]);
  const transport=nodemailer.createTransport({host:c.host,port:c.port,secure:c.security==='tls',
    ...(c.security==='starttls'?{requireTLS:true}:{}),
    auth:c.auth?(c.authentication==='microsoft365'?{type:'OAuth2' as const,user:c.user,accessToken:delivery.accessToken}:{user:c.user,pass:delivery.password}):undefined,
    tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},connectionTimeout:10_000,greetingTimeout:8_000,socketTimeout:15_000,
    disableFileAccess:true,disableUrlAccess:true});
  try{
    const result=await transport.sendMail({from:{name:mail.senderProfile?managedEmailSenderNames[mail.senderProfile]:c.fromName,address:c.from},to:mail.to,...(mail.cc?.length?{cc:mail.cc}:{}),
      replyTo:c.replyTo||undefined,envelope:{from:c.from,to:recipients},subject:mail.subject,text:mail.text,...(mail.html?{html:mail.html}:{}),
      ...(mail.messageId?{messageId:mail.messageId}:{}),
      ...(attachments.length?{attachments:attachments.map(attachment=>({filename:attachment.filename,
        content:Buffer.isBuffer(attachment.bytes)?attachment.bytes:Buffer.from(attachment.bytes),
        contentType:attachment.contentType,...('cid' in attachment && typeof attachment.cid==='string'?{cid:attachment.cid,contentDisposition:'inline' as const}:{})}))}:{}),
      disableFileAccess:true,disableUrlAccess:true});
    if(mail.attachments!==undefined){
      const accepted=new Set((result.accepted as unknown[]).map(value=>typeof value==='string'?value.toLowerCase():value&&typeof value==='object'&&'address' in value?String(value.address).toLowerCase():''));
      if(accepted.size!==recipients.length||recipients.some(address=>!accepted.has(address.toLowerCase())))throw new EmailSettingsError('uncertain');
    }else if(result.accepted.length!==1)throw new EmailSettingsError('uncertain');
  }finally{transport.close();}
};
