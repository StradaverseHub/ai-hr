/** Private delivery uses each module's frozen native metadata and capability-scoped file reader. */
import {z} from 'zod';
import {automationCatalogue} from './automation/catalogues';
import type {AutomationModule} from './automation/catalogue';
import {createEmailBodyDocSchema,type EmailBodyDoc} from './email-body/doc';
import {EMAIL_HTML_MAX_BYTES,renderEmailBody,resolveDocumentLinks,sanitiseEmailHtml} from './email-body/render';
import {notificationEmailLink} from './notification-email-model';
import {v9EmailContent,v9ImageCid} from './lifecycle-v9-email-content';
import type {AutomationEmailAsset} from './automation-email-assets';
import type {AutomationMailTarget} from './automation-email-ipc';
import {validateAutomationEmailContent} from './automation-email-content-policy';
import {renderV9DocumentPdf} from './lifecycle-v9-pdf';
import {managedEmailAttachment,type ManagedEmailAttachment} from './managed-email-attachment';
import {MANAGED_EMAIL_ATTACHMENT_MAX_BYTES,MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT} from './managed-email-policy';
export type AutomationRichEmailBody={doc:EmailBodyDoc;values:Record<string,string>;sourceTemplate?:{id:string;revision:number};sourceProof?:{payload:string;signature:string}};
/** Native queued legal metadata; historical snapshots are compared privately and never interpolated into mail. */
export type AutomationEmailLinkedDocument={id:string;templateId:string;name:string;contentRevision?:number;contentHash?:string;snapshot?:Record<string,unknown>};
type RichInput={module:AutomationModule;origin:string;linkPath:string;body:string;richBody?:AutomationRichEmailBody|null;assets?:readonly AutomationEmailAsset[];documents?:readonly AutomationEmailLinkedDocument[];test?:boolean};
function sharedEmailBody(input:RichInput):{text:string;html?:string}{
 const link=notificationEmailLink(input.origin,input.linkPath);
 if(!input.richBody){
  const documents=input.documents??[],lines=documents.map(document=>`${document.name}: ${notificationEmailLink(input.origin,`/lifecycle/contracts/letters/${document.id}`)}`);
  return {text:input.body.split('{{case.link}}').join(link)+(lines.length?'\n\n'+lines.join('\n'):'')};
 }
 const catalogue=automationCatalogue(input.module);
 if(!catalogue)throw new Error('This module has no shared email fields.');
 const assets=input.assets??[],documents=input.documents??[];
 const testIds=input.test?[...new Set([...JSON.stringify(input.richBody.doc).matchAll(/"documentId":"([0-9a-f-]{36})"/g)].map(match=>match[1]))]:[];
 const doc=createEmailBodyDocSchema({fieldAllowed:key=>catalogue.mergeFields.some(field=>field.key===key),imageIds:assets.filter(asset=>asset.kind==='image').map(asset=>asset.id),documentIds:input.test?testIds:documents.map(document=>document.templateId)}).parse(input.richBody.doc);
 const values=z.record(z.string().max(100),z.string().max(20000)).refine(value=>Object.keys(value).length<=200).parse(input.richBody.values);
 const rendered=renderEmailBody(doc,{values:{...values,'case.link':link},images:assets.filter(asset=>asset.kind==='image').map(asset=>({id:asset.id,alt:asset.alt||asset.name,cid:v9ImageCid(asset.id)})),
 documentLink:id=>documents.find(document=>document.templateId===id)??(input.test&&testIds.includes(id)?{name:'Document preview'}:null)});
 const links=new Map(documents.map(document=>[document.templateId,notificationEmailLink(input.origin,`/lifecycle/contracts/letters/${document.id}`)]));
 for(const id of testIds)links.set(id,notificationEmailLink(input.origin,'/automation/templates'));
 const resolved=resolveDocumentLinks(rendered.html,rendered.text,links).html;
 const footer=documents.length?renderEmailBody({type:'doc',content:documents.map(document=>({type:'paragraph',content:[{type:'text',text:document.name,marks:[{type:'link',attrs:{kind:'web',href:links.get(document.templateId)!}}]}]}))},{values:{}}).html:'';
 const html=sanitiseEmailHtml(resolved+footer);
 const lines=documents.map(document=>`${document.name}: ${links.get(document.templateId)}`);
 return {text:rendered.text+(lines.length?'\n\n'+lines.join('\n'):'')+(input.test?'\n\nTemplate test only. Per-person documents and files are not generated or sent.':''),html};
}

export type AutomationStoredFile = {id:string;filename:string;mime_type:string;bytes:string;content_hash:string;kind?:string};
/** Only the private sender supplies capability-scoped bytes. No local paths or remote URLs are accepted. */
async function resignationEmailBody(target:AutomationMailTarget,origin:string,load:ResignationEmailFiles):Promise<{text:string;html?:string;attachments:ManagedEmailAttachment[]}> {
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

type ResignationEmailFiles={files:()=>Promise<AutomationStoredFile[]>;assets:()=>Promise<AutomationStoredFile[]>};
export function automationEmailContent(input:RichInput):{text:string;html?:string};
export function automationEmailContent(target:AutomationMailTarget,origin:string,load:ResignationEmailFiles):Promise<{text:string;html?:string;attachments:ManagedEmailAttachment[]}>;
export function automationEmailContent(input:RichInput|AutomationMailTarget,origin?:string,load?:ResignationEmailFiles):{text:string;html?:string}|Promise<{text:string;html?:string;attachments:ManagedEmailAttachment[]}>{
 if('payload' in input){
  if(!origin||!load)throw new Error('Native workflow email requires its private file reader.');
  return resignationEmailBody(input,origin,load);
 }
 return sharedEmailBody(input);
}
