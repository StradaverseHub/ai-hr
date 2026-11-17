/** The private sender renders frozen rich source; the installation alone supplies absolute case links. */
import {z} from 'zod';
import {automationCatalogue} from './automation/catalogues';
import type {AutomationModule} from './automation/catalogue';
import {createEmailBodyDocSchema,type EmailBodyDoc} from './email-body/doc';
import {renderEmailBody,resolveDocumentLinks,sanitiseEmailHtml} from './email-body/render';
import {notificationEmailLink} from './notification-email-model';
import {v9ImageCid} from './lifecycle-v9-email-content';
import type {AutomationEmailAsset} from './automation-email-assets';
export type AutomationRichEmailBody={doc:EmailBodyDoc;values:Record<string,string>;sourceTemplate?:{id:string;revision:number};sourceProof?:{payload:string;signature:string}};
/** Native queued legal metadata; historical snapshots are compared privately and never interpolated into mail. */
export type AutomationEmailLinkedDocument={id:string;templateId:string;name:string;contentRevision?:number;contentHash?:string;snapshot?:Record<string,unknown>};
type RichInput={module:AutomationModule;origin:string;linkPath:string;body:string;richBody?:AutomationRichEmailBody|null;assets?:readonly AutomationEmailAsset[];documents?:readonly AutomationEmailLinkedDocument[];test?:boolean};
export function automationEmailContent(input:RichInput):{text:string;html?:string}{
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
