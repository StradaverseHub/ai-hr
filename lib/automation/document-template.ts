/** Shared document definitions use the existing block/field editor and per-version signing routing. */
import {z} from 'zod';
import {v9ConfigSchema} from '../lifecycle-v9-validation';
import {AUTOMATION_MODULES} from './catalogue';
import {documentRoutingSchema} from '../document-signing-routing-schema';
import {contractLetterRoutingProblems} from '../contract-letter-flow';
import {documentRoutingProblems,documentRoutingSignatureProblems,type DocumentRoutingReferences} from '../document-signing-routing';

const version=v9ConfigSchema.shape.templates.element.shape.versions.element;
export const automationDocumentTemplateSchema=z.object({
 id:z.uuid(),module:z.enum(AUTOMATION_MODULES),name:z.string().trim().min(1).max(200),description:z.string().max(2000),
 blocks:version.shape.blocks,fields:version.shape.fields,routing:documentRoutingSchema,
 rules:z.object({businessGroup:z.array(z.string().min(1).max(200)).max(200).optional(),company:z.array(z.uuid()).max(200).optional(),department:z.array(z.string().min(1).max(200)).max(200).optional(),jobTitle:z.array(z.string().min(1).max(200)).max(200).optional(),decision:z.array(z.enum(['Renew','End','Convert to permanent'])).max(3).optional()}).strict(),
}).strict();
export type AutomationDocumentTemplate=z.infer<typeof automationDocumentTemplateSchema>;
export function automationDocumentTemplateProblems(template:AutomationDocumentTemplate,refs:DocumentRoutingReferences):string[]{
 const problems=template.module==='contract_staff'?contractLetterRoutingProblems(template.routing,refs):documentRoutingProblems(template.routing,refs);
 if(new Set(template.blocks.map(b=>b.id)).size!==template.blocks.length)problems.push('Each content block needs its own identity.');
 if(new Set(template.fields.map(f=>f.id)).size!==template.fields.length)problems.push('Each field needs its own identity.');
 if(!template.blocks.some(b=>['heading','text','table','field','fields'].includes(b.type)))problems.push('Add the letter content before publishing.');
 for(const block of template.blocks)if(block.type==='field'&&!template.fields.some(f=>f.id===block.fieldId))problems.push('Choose an existing field for each field block.');
 return problems;
}
export function automationDocumentTemplateWarnings(template:AutomationDocumentTemplate):string[]{
 return documentRoutingSignatureProblems(template.routing,template.blocks);
}
export function automationDocumentMatches(template:AutomationDocumentTemplate,read:(field:string)=>string|null):boolean{
 return Object.entries(template.rules).every(([field,values])=>!values?.length||values.includes(read(field)??''));
}
