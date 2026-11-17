/** Same pure rich-body renderer and asset/link vocabulary as the live shared journey email executor. */
import {renderEmailBody,documentLinkToken} from './email-body/render';
import {v9ImageCid} from './lifecycle-v9-email-content';
import {validateAutomationEmailContent} from './automation-email-content-policy';
import type {ResignationCommunicationSource,ResignationPreparedMessage} from './resignation-communications';
const fill=(text:string,values:Record<string,string>)=>text.replace(/\{\{\s*([\w.]+)\s*\}\}|\{([\w.]+)\}/g,(_,a,b)=>values[a??b]||'—');
export function prepareResignationCommunication(source:ResignationCommunicationSource):ResignationPreparedMessage{
 const t=source.template,holds:string[]=[];
 if(!t.active)holds.push('This email template is inactive.');
 if(source.recipientProblem)holds.push(source.recipientProblem);
 const required=[...new Set([...t.attachments,...t.links])],documents=required.flatMap(id=>{const doc=source.documents.find(d=>d.templateId===id);if(!doc)holds.push('The attached letter must be signed and released before this message can be sent.');return doc?[doc]:[];});
 const slots=t.slots.flatMap(slot=>{const file=source.files.find(f=>f.slot===`${t.id}:${slot.id}`);if(!file&&slot.required)holds.push(`Upload ${slot.label} before this message can be sent.`);return file?[{id:file.id,storageId:file.id,name:file.name,contentHash:file.contentHash}]:[];});
 let body=fill(source.override?.body??t.body,source.values),html:string|undefined;
 if(t.bodyDoc&&!source.override){const rich=renderEmailBody(t.bodyDoc,{values:source.values,images:(t.images??[]).map(image=>({id:image.id,alt:image.alt||image.name,cid:v9ImageCid(image.id)})),documentLink:id=>{const doc=documents.find(d=>d.templateId===id);return doc&&t.links.includes(id)?{name:doc.name,placeholder:documentLinkToken(doc.id)}:null;}});body=rich.text;html=rich.html;}
 const content={number:source.caseNumber,emailTemplateId:t.id,documents,pdfDocumentIds:documents.filter(d=>t.attachments.includes(d.templateId)).map(d=>d.id),linkDocumentIds:documents.filter(d=>t.links.includes(d.templateId)).map(d=>d.id),...(html?{html}:{}),assets:[...(t.files??[]),...(t.images??[])],files:slots};
 validateAutomationEmailContent(content);
 return{subject:fill(source.override?.subject??t.subject,source.values),body,content,holds:[...new Set(holds)]};
}
