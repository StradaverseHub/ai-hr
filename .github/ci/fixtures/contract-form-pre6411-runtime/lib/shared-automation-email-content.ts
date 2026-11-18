/** Private native delivery adapter: receipt metadata is never a URL or filesystem capability. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {AutomationMailTarget} from './automation-email-ipc';
import {automationEmailAssetSchema} from './automation-email-assets';
import {automationEmailContent} from './automation-email-content';
import {managedEmailAttachment,MANAGED_EMAIL_ATTACHMENT_MAX_BYTES,MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT} from './managed-email-attachment';
import {v9ImageCid} from './lifecycle-v9-email-content';
const documentSchema=z.object({id:z.uuid(),templateId:z.uuid(),name:z.string().min(1).max(500),contentRevision:z.number().int().positive().optional(),contentHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),snapshot:z.record(z.string(),z.unknown()).optional()}).strict();
export async function sharedAutomationEmailContent(target:AutomationMailTarget,origin:string,load:{assets:()=>Promise<readonly Record<string,unknown>[]>;documents:()=>Promise<unknown>}){
 if(target.module==='off')throw new Error('Offboarding owns its email materialization.');
 const mail=target.payload.mail,assets=z.array(automationEmailAssetSchema).max(MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT).parse(mail.delivery.assets??[]),documents=z.array(documentSchema).max(20).parse(mail.delivery.documents??[]);
 if(new Set(assets.map(asset=>asset.id)).size!==assets.length||new Set(documents.map(document=>document.id)).size!==documents.length)throw new Error('Duplicate email references.');
 const stored=assets.length?await load.assets():[];
 if(stored.length!==assets.length)throw new Error('An attached file is unavailable.');
 const attachments=assets.map(reference=>{
  const file=stored.find(row=>row.id===reference.id);
  if(!file||file.filename!==reference.name||file.mime_type!==reference.mimeType||file.kind!==reference.kind||typeof file.bytes!=='string')throw new Error('The native file no longer matches its receipt.');
  const bytes=Buffer.from(file.bytes,'base64');
  if(bytes.length!==reference.size||createHash('sha256').update(bytes).digest('hex')!==reference.contentHash)throw new Error('The file contents changed.');
  return managedEmailAttachment.parse({filename:reference.name,contentType:reference.mimeType,bytes,...(reference.kind==='image'?{cid:v9ImageCid(reference.id)}:{})});
 });
 if(attachments.reduce((total,file)=>total+file.bytes.byteLength,0)>MANAGED_EMAIL_ATTACHMENT_MAX_BYTES)throw new Error('Email files exceed the delivery limit.');
 if(documents.length){
  const allowed=z.array(documentSchema).parse(await load.documents());
  if(allowed.length!==documents.length||documents.some(document=>!allowed.some(item=>isDeepStrictEqual(item,document))))throw new Error('A personal document is unavailable to the actual recipients.');
 }
 return {...automationEmailContent({module:target.module,origin,linkPath:target.payload.linkPath,body:mail.body,richBody:mail.richBody,assets,documents,test:target.payload.purpose==='templateTest'}),attachments};
}
