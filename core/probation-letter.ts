import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {assertModuleEnabled} from './entitlements';
import {v9ConfigSchema} from '../lib/lifecycle-v9-validation';
import {validateFieldValue,type Block,type Field,type Document,type Signature} from '../lib/lifecycle-v9-model';
import {validateSigningRoute,signingComplete,type SigningDocument,type SigningRoute,type SigningGuardrails} from '../lib/document-signing-model';
import {ProbationError} from '../lib/probation-model';
import type {ProbationTemplate} from '../lib/probation-workflow';
import {PROBATION_LETTER_KEYS} from '../lib/probation-letter-template';
import {createSigningDocumentTx,readSigningDocumentTx,recordDocumentSigningActionTx} from '../packs/document-signing/service';
const id=z.uuid(),json=(value:unknown)=>JSON.stringify(value);
const base=v9ConfigSchema.shape.templates.element;
const route=z.object({version:z.number().int().positive(),steps:z.array(z.object({id:z.string().min(1).max(120),role:z.enum(['lm','hod','pbp','employee']),kind:z.enum(['sign','acknowledge','approve']),stage:z.number().int().min(0).max(30),holderId:z.null(),holderPersonId:z.undefined().optional(),representedId:z.undefined().optional(),required:z.boolean()}).strict()).min(2).max(30)}).strict();
const templateSchema=base.omit({module:true}).extend({module:z.literal('probation'),outcome:z.enum(['confirm','extend','not_confirm']),unfinished:z.boolean(),blocks:base.shape.versions.element.shape.blocks,fields:base.shape.versions.element.shape.fields,route}).strict();
export type ProbationLetterDefinition={id:string;companyId:string;key:string;version:number;state:'draft'|'published'|'retired';data:ProbationTemplate};
export type ProbationLetterPreview={merge:Record<string,string>;blocks:Block[];fields:Field[];route:SigningRoute;guardrails:SigningGuardrails;companyId:string;employmentId:string;templateId:string;templateVersion:number;outcomeRevision:number;sourceDigest:string};
export type ProbationLetterView={id:string;caseId:string;outcomeId:string;outcomeRevision:number|null;storageRevision:number;state:string;createdAt:string;name:string;templateId:string;templateVersion:number;blocks:Block[];fields:Field[];merge:Record<string,string>;signing:{id:string;document:SigningDocument}|null;canPrepare:boolean;canRelease:boolean;document:Document};
function companyGate(ctx:SessionContext,companyId:string){if(ctx.entitlementsExempt===undefined)assertModuleEnabled(ctx,'lifecycle',companyId);}
function validateTemplate(raw:unknown,publish:boolean):ProbationTemplate{
 const value=templateSchema.parse(raw) as ProbationTemplate;
 if(value.type!=='Letter'||value.retired)throw new ProbationError('invalid','Choose an active outcome letter template.');
 if(new Set(value.blocks.map(b=>b.id)).size!==value.blocks.length||new Set(value.fields.map(f=>f.id)).size!==value.fields.length)throw new ProbationError('invalid','Document blocks and fields need unique identities.');
 const fieldIds=new Set(value.fields.map(f=>f.id)),keys=new Set<string>([...PROBATION_LETTER_KEYS,...fieldIds]);
 for(const field of value.fields){if(field.owner==='employee'||field.owner==='pmLocked'&&(!field.pmKey||!PROBATION_LETTER_KEYS.includes(field.pmKey as typeof PROBATION_LETTER_KEYS[number]))||field.owner==='hr'&&field.pmKey!==null||field.when&&!fieldIds.has(field.when.field))throw new ProbationError('invalid','Use declared HR fields or the registered read-only Personnel fields.');}
 for(const block of value.blocks){if(block.type==='field'&&(!block.fieldId||!fieldIds.has(block.fieldId)))throw new ProbationError('invalid','Choose an existing field for each document field block.');for(const text of[block.text,block.rows??'',block.label??'']){if(/\{\{|\}\}/.test(text))throw new ProbationError('invalid','Letter merge fields use single braces.');for(const match of text.matchAll(/\{([^{}]+)\}/g))if(!/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)?$/.test(match[1])||!keys.has(match[1]))throw new ProbationError('invalid','Use a registered letter merge field.');}}
 validateSigningRoute(value.route,{requiredRoles:['employee']});
 const employee=value.route.steps.find(s=>s.role==='employee'&&s.required);
 if(!employee||employee.kind!=='acknowledge'||!value.route.steps.some(s=>s.required&&s.role!=='employee')||value.route.steps.some(s=>s.role!=='employee'&&s.stage>=employee.stage))throw new ProbationError('invalid','Required HR signing must finish before employee acknowledgement.');
 if(publish&&(value.unfinished||!value.blocks.some(b=>b.type==='text'&&b.text.trim())||!value.blocks.some(b=>b.type==='signature'&&b.role==='hr')||!value.blocks.some(b=>b.type==='signature'&&b.role==='employee')))throw new ProbationError('invalid','Complete and review the letter wording and both signature blocks before publishing.');
 return value;
}
export function probationLetterTemplates(ctx:SessionContext,companyId:string){return withScopedLifecycleTenant(ctx,async tx=>{companyGate(ctx,id.parse(companyId));return tx.execute<ProbationLetterDefinition>(sql`select id,company_id as "companyId",definition_key as key,version,state,data from probation_builder_definition where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid and kind='template' order by definition_key,version desc`);});}
export function saveProbationLetterTemplate(ctx:SessionContext,input:{companyId:string;template:unknown;publish:boolean;expectedVersion:number}){return withScopedLifecycleTenant(ctx,async tx=>{
 companyGate(ctx,id.parse(input.companyId));const template=validateTemplate(input.template,input.publish);z.number().int().nonnegative().parse(input.expectedVersion);
 const[row]=await tx.execute<{id:string}>(sql`select app.probation_definition_save(${input.companyId}::uuid,${template.outcome},'template',${json(template)}::jsonb,${input.publish},${input.expectedVersion}) as id`);return row.id;
});}
async function previewTx(tx:Tx,ctx:SessionContext,input:{outcomeId:string;templateId:string;edits:Record<string,string>;revision:number}){
 id.parse(input.outcomeId);id.parse(input.templateId);z.number().int().positive().parse(input.revision);z.record(z.string().max(120),z.string().max(10000)).refine(v=>Object.keys(v).length<=200).parse(input.edits);
 const[row]=await tx.execute<{data:ProbationLetterPreview}>(sql`select app.probation_letter_preview(${input.outcomeId}::uuid,${input.templateId}::uuid,${json(input.edits)}::jsonb,${input.revision}) as data`);if(!row?.data)throw new ProbationError('forbidden','The current letter source is unavailable.');companyGate(ctx,row.data.companyId);return row.data;
}
export function previewProbationLetter(ctx:SessionContext,input:Parameters<typeof previewTx>[2]){return withScopedLifecycleTenant(ctx,tx=>previewTx(tx,ctx,input));}
export function probationLetterDocument(input:{id:string;name:string;templateId:string;templateVersion:number;blocks:Block[];fields:Field[];merge:Record<string,string>;createdAt:string;signing?:SigningDocument|null}):Document{
 const mergeValues=Object.fromEntries(Object.entries(input.merge).map(([key,value])=>[key,value==null?'':String(value)]));
 const current=input.signing?.actions.filter(a=>a.action==='signed'&&a.contentHash===input.signing!.contentHash&&a.contentRevision===input.signing!.contentRevision)??[];
 const signature=(actor:typeof current[number]|undefined):Signature|null=>actor?.signature?{by:{id:actor.actorId,name:actor.actorName},at:actor.at,...actor.signature}:null;
 const employee=current.find(a=>a.role==='employee'),hr=current.find(a=>a.role!=='employee');
 return{id:input.id,templateId:input.templateId,version:input.templateVersion,name:input.name,status:input.signing&&signingComplete(input.signing,{requiredRoles:input.signing.route.steps.filter(s=>s.required).map(s=>s.role)})?'signed':'draft',blocks:input.blocks,fields:input.fields,values:Object.fromEntries(input.fields.map(f=>[f.id,mergeValues[f.pmKey??f.id]??''])),edits:{},mergeValues,hrSignature:signature(hr),employeeSignature:signature(employee),createdAt:input.createdAt,sentAt:null,hrStep:'before',employeeAck:true,templateType:'Letter'};
}
async function renderLetter(document:Document,signing:SigningDocument|null,reference:string):Promise<Buffer>{
 const {v9PdfDocument}=await import('../lib/lifecycle-v9-pdf'),{renderLetterPdf}=await import('../lib/letter-pdf');
 const resolved=v9PdfDocument(document,true),current=signing?.actions.filter(a=>a.action==='signed'&&a.contentHash===signing.contentHash&&a.contentRevision===signing.contentRevision)??[];
 if(signing)resolved.blocks.push({type:'heading',level:2,content:[{type:'text',text:'Authenticated signature history'}]},{type:'table',rows:[['Role','Verified signer','Time'],...current.map(a=>[a.role,a.actorName,a.at])].map(row=>row.map(text=>[{type:'text' as const,text}]))});
 const output=await renderLetterPdf({document:resolved,title:document.name,reference,signature:{name:'',caption:signing?'Authenticated signatures are recorded in this document.':'Unsigned preparation copy',timestamp:''}});
 const drawn=current.filter(a=>a.signature?.method==='drawn');if(!drawn.length)return Buffer.from(output.bytes);
 const {PDFDocument,StandardFonts}=await import('pdf-lib'),pdf=await PDFDocument.load(output.bytes),font=await pdf.embedFont(StandardFonts.Helvetica);
 for(const action of drawn){const page=pdf.addPage([595,842]),stamp=await pdf.embedPng(Buffer.from(action.signature!.value.split(',')[1],'base64')),scale=Math.min(420/stamp.width,160/stamp.height);page.drawText(action.role+' · '+action.at,{x:48,y:780,size:10,font});page.drawImage(stamp,{x:48,y:580,width:stamp.width*scale,height:stamp.height*scale});}
 return Buffer.from(await pdf.save());
}
export function prepareProbationLetter(ctx:SessionContext,input:Parameters<typeof previewTx>[2]){return withScopedLifecycleTenant(ctx,async tx=>{
 const preview=await previewTx(tx,ctx,input);for(const field of preview.fields)validateFieldValue(field,preview.merge[field.pmKey??field.id]??'');
 const document=probationLetterDocument({id:randomUUID(),name:'Probation outcome letter',...preview,createdAt:new Date().toISOString()}),basePdf=await renderLetter(document,null,'Probation outcome preparation');
 const[row]=await tx.execute<{data:ProbationLetterPreview&{partId:string;contentHash:string;contentRevision:number}}>(sql`select app.probation_prepare_letter(${input.outcomeId}::uuid,${input.templateId}::uuid,${json(input.edits)}::jsonb,${basePdf},${input.revision},${preview.sourceDigest}) as data`);
 const created=await createSigningDocumentTx(tx,ctx,{companyId:row.data.companyId,employmentId:row.data.employmentId,subjectId:row.data.partId,subjectType:'probation',contentHash:row.data.contentHash,route:row.data.route,guardrails:row.data.guardrails});
 await tx.execute(sql`select app.probation_letter_transition(${row.data.partId}::uuid)`);return{partId:row.data.partId,outcomeRevision:row.data.outcomeRevision,documentId:created.id};
});}
async function readLetterTx(tx:Tx,ctx:SessionContext,caseId:string,partId:string):Promise<ProbationLetterView>{
 id.parse(caseId);id.parse(partId);
 const[row]=await tx.execute<{id:string;case_id:string;revision:number;created_at:string;company_id:string;data:{state:string;letterOutcomeId:string;letterTemplateId:string;letterTemplateVersion:number;letterBlocks:Block[];letterFields:Field[];letterMerge:Record<string,string>};outcome_revision:number|null;can_prepare:boolean;can_release:boolean}>(sql`select p.id,p.case_id,p.revision,p.created_at::text,c.company_id,p.data,(select revision from probation_outcome o where o.id=(p.data->>'letterOutcomeId')::uuid and o.tenant_id=p.tenant_id) as outcome_revision,app.probation_role(c.employment_id,'pbp') or app.probation_role(c.employment_id,'gbs') as can_prepare,app.probation_role(c.employment_id,'pbp') or app.probation_role(c.employment_id,'gbs') and p.data->'letterMerge'->>'outcome'='confirm' as can_release from probation_part p join probation_case c on c.id=p.case_id and c.tenant_id=p.tenant_id where p.id=${partId}::uuid and p.case_id=${caseId}::uuid and p.tenant_id=${ctx.tenantId}::uuid and p.data->>'documentKind'='letter'`);
 if(!row)throw new ProbationError('forbidden','This outcome letter is unavailable in your current scope.');companyGate(ctx,row.company_id);
 const[stored]=await tx.execute<{id:string}>(sql`select id from document_signing_document where subject_type='probation' and subject_id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid`);
 const signing=stored?{id:stored.id,document:await readSigningDocumentTx(tx,ctx,stored.id)}:null;
 const value={id:row.id,caseId:row.case_id,outcomeId:row.data.letterOutcomeId,outcomeRevision:row.outcome_revision,storageRevision:row.revision,state:row.data.state,createdAt:row.created_at,name:'Probation outcome letter',templateId:row.data.letterTemplateId,templateVersion:row.data.letterTemplateVersion,blocks:row.data.letterBlocks,fields:row.data.letterFields,merge:row.data.letterMerge,signing,canPrepare:row.can_prepare,canRelease:row.can_release};
 return{...value,document:probationLetterDocument({...value,signing:signing?.document})};
}
export function readProbationLetter(ctx:SessionContext,caseId:string,partId:string){return withScopedLifecycleTenant(ctx,tx=>readLetterTx(tx,ctx,caseId,partId));}
export function actOnProbationLetter(ctx:SessionContext,input:{caseId:string;partId:string;revision:number;stepId:string;action:'signed'|'returned';comment?:string;method?:'typed'|'drawn';value?:string;consent?:boolean;actionId?:string}){return withScopedLifecycleTenant(ctx,async tx=>{
 const view=await readLetterTx(tx,ctx,input.caseId,input.partId);if(view.storageRevision!==input.revision||!view.signing)throw new ProbationError('conflict','Read the current letter revision before acting.');
 const document=await recordDocumentSigningActionTx(tx,ctx,{id:view.signing.id,stepId:input.stepId,revision:view.signing.document.contentRevision,hash:view.signing.document.contentHash,action:input.action,comment:input.comment,method:input.method,value:input.value,consent:input.consent,actionId:input.actionId});await tx.execute(sql`select app.probation_letter_transition(${view.id}::uuid)`);return document;
});}
export function releaseProbationLetter(ctx:SessionContext,input:{caseId:string;partId:string;outcomeRevision:number;reason:string}){return withScopedLifecycleTenant(ctx,async tx=>{
 const view=await readLetterTx(tx,ctx,input.caseId,input.partId);if(!view.canRelease||!view.signing||view.outcomeRevision!==input.outcomeRevision)throw new ProbationError('conflict','An authorized current completed letter is required.');
 const rules={requiredRoles:view.signing.document.route.steps.filter(s=>s.required).map(s=>s.role)};if(!signingComplete(view.signing.document,rules))throw new ProbationError('invalid','Every required signer must finish before release.');
 const finalPdf=await renderLetter(view.document,view.signing.document,'Probation outcome · '+view.id);
 const[row]=await tx.execute<{id:string}>(sql`select app.probation_release_signed_letter(${view.outcomeId}::uuid,${view.id}::uuid,${input.outcomeRevision},${finalPdf},${input.reason}) as id`);return row.id;
});}
