import type {AutomationMailTarget} from './automation-email-ipc';
import {validateAutomationEmailContent} from './automation-email-content-policy';
import {renderV9DocumentPdf} from './lifecycle-v9-pdf';
import {notificationEmailLink} from './notification-email-model';
import {managedEmailAttachment,type ManagedEmailAttachment} from './managed-email-attachment';
import {MANAGED_EMAIL_ATTACHMENT_MAX_BYTES,MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT} from './managed-email-policy';
import {EMAIL_HTML_MAX_BYTES,resolveDocumentLinks,sanitiseEmailHtml} from './email-body/render';
import {v9EmailContent,v9ImageCid} from './lifecycle-v9-email-content';

export type AutomationStoredFile = {id:string;filename:string;mime_type:string;bytes:string;content_hash:string;kind?:string};
/** Only the private sender supplies capability-scoped bytes. No local paths or remote URLs are accepted. */
export async function offboardingAutomationEmailContent(target:AutomationMailTarget,origin:string,load:{files:()=>Promise<AutomationStoredFile[]>;assets:()=>Promise<AutomationStoredFile[]>}):Promise<{text:string;html?:string;attachments:ManagedEmailAttachment[]}> {
  const body=target.payload.mail.body.split('{{case.link}}').join(notificationEmailLink(origin,target.payload.linkPath));
  const content=target.payload.content;
  if(!content)return {text:body,attachments:[]};
  if(target.module!=='off')throw new Error('This module does not support rich workflow email.');
  validateAutomationEmailContent(content);
  const attachments:ManagedEmailAttachment[]=[];
  const append=(attachment:ManagedEmailAttachment)=>{
    if(attachments.length+1>MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT||attachments.reduce((total,file)=>total+file.bytes.byteLength,attachment.bytes.byteLength)>MANAGED_EMAIL_ATTACHMENT_MAX_BYTES)throw new Error('The workflow email exceeds the attachment limit.');
    attachments.push(attachment);
  };
  for(const documentId of content.pdfDocumentIds){
    const document=content.documents.find(document=>document.id===documentId)!;
    const {bytes}=await renderV9DocumentPdf(document,content.number,document.templateType==='Attachment');
    append(managedEmailAttachment.parse({filename:document.name.replace(/[^\p{L}\p{N} ._()-]/gu,'_').slice(0,180)+'.pdf',contentType:'application/pdf',bytes}));
  }
  const files=content.files??[],storedFiles=files.length?await load.files():[];
  if(files.length!==storedFiles.length)throw new Error('A workflow email case file is unavailable.');
  for(const reference of files){
    const file=storedFiles.find(file=>file.id===reference.id&&file.filename===reference.name&&file.content_hash===reference.contentHash);
    if(!file)throw new Error('A workflow email case file changed.');
    append(managedEmailAttachment.parse({filename:file.filename,contentType:file.mime_type,bytes:Buffer.from(file.bytes,'base64')}));
  }
  const assets=content.assets??[],storedAssets=assets.length?await load.assets():[];
  if(assets.length!==storedAssets.length)throw new Error('A workflow email asset is unavailable.');
  for(const reference of assets){
    const asset=storedAssets.find(asset=>asset.id===reference.id&&asset.kind===reference.kind&&asset.filename===reference.name&&asset.mime_type===reference.mimeType&&asset.content_hash===reference.contentHash);
    if(!asset)throw new Error('A workflow email asset changed.');
    const bytes=Buffer.from(asset.bytes,'base64');
    if(bytes.byteLength!==reference.size)throw new Error('A workflow email asset changed.');
    append(managedEmailAttachment.parse({filename:asset.filename,contentType:asset.mime_type,bytes,...(reference.kind==='image'?{cid:v9ImageCid(reference.id)}:{})}));
  }
  if(attachments.length>MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT||attachments.reduce((total,file)=>total+file.bytes.byteLength,0)>MANAGED_EMAIL_ATTACHMENT_MAX_BYTES)throw new Error('The workflow email exceeds the attachment limit.');
  const links=new Map<string,string>(),lines:string[]=[];
  for(const id of content.linkDocumentIds){
    const document=content.documents.find(document=>document.id===id)!;
    const url=notificationEmailLink(origin,`/lifecycle/resignations/${encodeURIComponent(target.subjectId)}?document=${encodeURIComponent(id)}`);
    links.set(document.templateId,url);lines.push(`${document.name}: ${url}`);
  }
  const text=body+(lines.length?'\n\n'+lines.join('\n'):'');
  if(content.html!==undefined){
    const html=sanitiseEmailHtml(resolveDocumentLinks(content.html,text,links).html);
    if(new TextEncoder().encode(html).length>EMAIL_HTML_MAX_BYTES)throw new Error('The workflow email exceeds the content limit.');
    return {text,html,attachments};
  }
  return {...v9EmailContent(text,assets.filter(asset=>asset.kind==='image')),attachments};
}
