/** The private sender renders frozen rich source; the installation alone supplies absolute case links. */
import {z} from 'zod';
import type {AutomationMailTarget} from './automation-email-ipc';
import type {AutomationStoredFile} from './offboarding-automation-email-content';
export type {AutomationStoredFile} from './offboarding-automation-email-content';
import {automationCatalogue} from './automation/catalogues';
import type {AutomationModule} from './automation/catalogue';
import {createEmailBodyDocSchema,type EmailBodyDoc} from './email-body/doc';
import {renderEmailBody,resolveDocumentLinks,sanitiseEmailHtml} from './email-body/render';
import {notificationEmailLink} from './notification-email-model';
import {v9ImageCid} from './lifecycle-v9-email-content';
import type {AutomationEmailAsset} from './automation-email-assets';
export type AutomationRichEmailBody={doc:EmailBodyDoc;values:Record<string,string>;sourceTemplate?:{id:string;revision:number};sourceProof?:{payload:string;signature:string}};
export type AutomationEmailLinkedDocument={id:string;templateId:string;name:string};
type RichInput={module:AutomationModule;origin:string;linkPath:string;body:string;richBody?:AutomationRichEmailBody|null;assets?:readonly AutomationEmailAsset[];documents?:readonly AutomationEmailLinkedDocument[];test?:boolean};
type StoredLoad={files:()=>Promise<AutomationStoredFile[]>;assets:()=>Promise<AutomationStoredFile[]>};
export function automationEmailContent(input:RichInput):{text:string;html?:string};
export function automationEmailContent(target:AutomationMailTarget,origin:string,load:StoredLoad):Promise<Awaited<ReturnType<typeof import('./offboarding-automation-email-content').offboardingAutomationEmailContent>>>;
export function automationEmailContent(input:RichInput|AutomationMailTarget,origin?:string,load?:StoredLoad){
 if(!('origin' in input)){
  if(origin===undefined||!load)throw new Error('An installation and private file loader are required.');
  return import('./offboarding-automation-email-content').then(module=>module.offboardingAutomationEmailContent(input,origin,load));
 }

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
