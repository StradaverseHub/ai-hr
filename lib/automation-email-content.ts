/** The private sender renders frozen rich source; the installation alone supplies absolute case links. */
import {z} from 'zod';
import {automationCatalogue} from './automation/catalogues';
import type {AutomationModule} from './automation/catalogue';
import {createEmailBodyDocSchema,type EmailBodyDoc} from './email-body/doc';
import {renderEmailBody} from './email-body/render';
import {notificationEmailLink} from './notification-email-model';
export type AutomationRichEmailBody={doc:EmailBodyDoc;values:Record<string,string>};
export function automationEmailContent(input:{module:AutomationModule;origin:string;linkPath:string;body:string;richBody?:AutomationRichEmailBody|null}):{text:string;html?:string}{
 const link=notificationEmailLink(input.origin,input.linkPath);
 if(!input.richBody)return {text:input.body.split('{{case.link}}').join(link)};
 const catalogue=automationCatalogue(input.module);
 if(!catalogue)throw new Error('This module has no shared email fields.');
 const doc=createEmailBodyDocSchema({fieldAllowed:key=>catalogue.mergeFields.some(field=>field.key===key),imageIds:[],documentIds:[]}).parse(input.richBody.doc);
 const values=z.record(z.string().max(100),z.string().max(20000)).refine(value=>Object.keys(value).length<=200).parse(input.richBody.values);
 const rendered=renderEmailBody(doc,{values:{...values,'case.link':link}});
 return {text:rendered.text,html:rendered.html};
}
