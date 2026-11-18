import {z} from 'zod';
import {MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT,MANAGED_EMAIL_ATTACHMENT_MAX_BYTES} from '../managed-email-policy';
import {PROBATION_AUTOMATION_CATALOGUE} from './catalogues/probation';
import {automationMergeTokens, type AutomationEmailTemplate} from './email';
import {createEmailBodyDocSchema, type EmailBodyDoc, type EmailInline, type EmailParagraph} from '../email-body/doc';
import {docToLegacyText} from '../email-body/legacy';
import {renderEmailBody} from '../email-body/render';
import type {EmailAsset} from '../lifecycle-v9-model';

/** The existing canonical template/version remains the identity and audit owner. */
export type ProbationEmailDefinition = {
  version: 1; outcomeLetter?:boolean;bodyDoc: EmailBodyDoc;
  links: string[]; attachments: string[];
  files: EmailAsset[]; images: EmailAsset[];
  slots: {id: string; label: string; required: boolean}[];
};
export type ProbationEmailConversion = {state: 'ready'; definition: ProbationEmailDefinition} | {state: 'legacy'; fields: string[]};
export const probationEmailFields = PROBATION_AUTOMATION_CATALOGUE.mergeFields.map(field => ({key: field.key, label: field.label}));
export const probationEmailFieldGroups = [...new Set(PROBATION_AUTOMATION_CATALOGUE.mergeFields.map(field => field.group))].map(label => ({label, fields: PROBATION_AUTOMATION_CATALOGUE.mergeFields.filter(field => field.group === label)}));
const allowed = new Set(probationEmailFields.map(field => field.key));
const token = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** All or nothing: unknown fields retain the exact old renderer, including the subject. */
export function convertProbationEmail(template: Pick<AutomationEmailTemplate, 'subject'|'body'>&{id?:string}): ProbationEmailConversion {
  const fields = automationMergeTokens(template.subject+'\n'+template.body).filter(key => !allowed.has(key));
  if (fields.length) return {state:'legacy',fields};
  const content: EmailParagraph[] = template.body.replace(/\r\n?/g,'\n').split('\n\n').map(part => {
    const inline: EmailInline[]=[];
    part.split('\n').forEach((line,index) => {
      if(index)inline.push({type:'hardBreak'});
      let last=0;
      for(const match of line.matchAll(token)) {
        if(match.index!>last)inline.push({type:'text',text:line.slice(last,match.index)});
        inline.push({type:'field',attrs:{key:match[1]}});last=match.index!+match[0].length;
      }
      if(last<line.length)inline.push({type:'text',text:line.slice(last)});
    });
    return inline.length?{type:'paragraph',content:inline}:{type:'paragraph'};
  });
  return {state:'ready',definition:{version:1,...(template.id==='a0700000-0000-4000-8000-000000002004'?{outcomeLetter:true}:{}),bodyDoc:{type:'doc',content},links:[],attachments:[],files:[],images:[],slots:[]}};
}

const asset = z.strictObject({id:z.uuid(),kind:z.enum(['file','image']),name:z.string().min(1).max(180),mimeType:z.string().max(100),size:z.number().int().positive().max(10485760),contentHash:z.string().regex(/^[a-f0-9]{64}$/),at:z.iso.datetime(),by:z.string().max(300),alt:z.string().max(300).optional()});
export function parseProbationEmailDefinition(input: unknown, documents: Iterable<string> = []): ProbationEmailDefinition {
  const data=z.strictObject({version:z.literal(1),outcomeLetter:z.boolean().optional(),bodyDoc:z.unknown(),links:z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(100),attachments:z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(100),files:z.array(asset).max(20),images:z.array(asset).max(3),slots:z.array(z.strictObject({id:z.uuid(),label:z.string().trim().min(1).max(500),required:z.boolean()})).max(50)}).parse(input);
  const documentIds=new Set(documents);
  if([...data.links,...data.attachments].some(id=>!documentIds.has(id)))throw new Error('Choose a Probation document available to this template.');
  if(data.images.some(image=>image.kind!=='image'||!image.alt?.trim())||data.files.some(file=>file.kind!=='file'))throw new Error('Email images need alt text and valid uploaded receipts.');
  const shared=[...data.files,...data.images];
  if(shared.length>MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT||shared.reduce((total,file)=>total+file.size,0)>MANAGED_EMAIL_ATTACHMENT_MAX_BYTES)throw new Error('Shared email files exceed the limit of 20 files and 20 MB.');
  const ids=[...data.files,...data.images].map(file=>file.id);
  if(new Set(ids).size!==ids.length)throw new Error('An uploaded file can be included only once.');
  const bodyDoc=createEmailBodyDocSchema({fieldAllowed:key=>allowed.has(key),imageIds:data.images.map(image=>image.id),documentIds:data.links}).parse(data.bodyDoc);
  return {...data,bodyDoc};
}
/** Keep the old text meaningful for history/search without changing its double-brace grammar. */
export function probationEmailLegacyBody(doc: EmailBodyDoc): string {
  let prefix='__AIHR_PROBATION_FIELD_';while(JSON.stringify(doc).includes(prefix))prefix+='X';
  const tokens:string[]=[];
  const visit=(value:unknown):unknown=>{
    if(Array.isArray(value))return value.map(visit);
    if(!value||typeof value!=='object')return value;
    const node=value as Record<string,unknown>;
    if(node.type==='field'){
      const marker=prefix+tokens.length+'__';tokens.push(String((node.attrs as {key:string}).key));
      return {type:'text',text:marker,...(node.marks?{marks:node.marks}:{})};
    }
    return Object.fromEntries(Object.entries(node).map(([key,child])=>[key,visit(child)]));
  };
  let text=docToLegacyText(visit(doc) as EmailBodyDoc);
  tokens.forEach((key,index)=>{text=text.split(prefix+index+'__').join('{{'+key+'}}');});return text;
}
export function renderProbationEmail(definition: ProbationEmailDefinition, values: Record<string,string>) {
  const result=renderEmailBody(definition.bodyDoc,{values,images:definition.images.map(image=>({id:image.id,alt:image.alt,cid:`v9-image.${image.id}@aihr`})),documentLink:id=>definition.links.includes(id)?{name:'Probation document'}:null});
  if(result.missing.length)throw new Error('Missing email fields: '+result.missing.join(', '));
  return result;
}
