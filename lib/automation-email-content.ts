/** The private sender renders frozen rich source; the installation alone supplies absolute case links. */
import {z} from 'zod';
import type {AutomationMailTarget} from './automation-email-ipc';
import type {AutomationStoredFile} from './offboarding-automation-email-content';
export type {AutomationStoredFile} from './offboarding-automation-email-content';
import {automationCatalogue} from './automation/catalogues';
import type {AutomationModule} from './automation/catalogue';
import {createEmailBodyDocSchema,type EmailBodyDoc} from './email-body/doc';
import {renderEmailBody} from './email-body/render';
import {notificationEmailLink} from './notification-email-model';
export type AutomationRichEmailBody={doc:EmailBodyDoc;values:Record<string,string>};
type RichInput={module:AutomationModule;origin:string;linkPath:string;body:string;richBody?:AutomationRichEmailBody|null};
type StoredLoad={files:()=>Promise<AutomationStoredFile[]>;assets:()=>Promise<AutomationStoredFile[]>};
export function automationEmailContent(input:RichInput):{text:string;html?:string};
export function automationEmailContent(target:AutomationMailTarget,origin:string,load:StoredLoad):Promise<Awaited<ReturnType<typeof import('./offboarding-automation-email-content').offboardingAutomationEmailContent>>>;
export function automationEmailContent(input:RichInput|AutomationMailTarget,origin?:string,load?:StoredLoad){
 if(!('origin' in input)){
  if(origin===undefined||!load)throw new Error('An installation and private file loader are required.');
  return import('./offboarding-automation-email-content').then(module=>module.offboardingAutomationEmailContent(input,origin,load));
 }

 const link=notificationEmailLink(input.origin,input.linkPath);
 if(!input.richBody)return {text:input.body.split('{{case.link}}').join(link)};
 const catalogue=automationCatalogue(input.module);
 if(!catalogue)throw new Error('This module has no shared email fields.');
 const doc=createEmailBodyDocSchema({fieldAllowed:key=>catalogue.mergeFields.some(field=>field.key===key),imageIds:[],documentIds:[]}).parse(input.richBody.doc);
 const values=z.record(z.string().max(100),z.string().max(20000)).refine(value=>Object.keys(value).length<=200).parse(input.richBody.values);
 const rendered=renderEmailBody(doc,{values:{...values,'case.link':link}});
 return {text:rendered.text,html:rendered.html};
}
