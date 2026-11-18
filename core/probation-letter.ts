import {pgErrorChain} from '../lib/db-error';
import {validateProbationLetterFields,probationLetterDocument} from '../lib/probation-letter-document';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {assertModuleEnabled} from './entitlements';
import {v9ConfigSchema} from '../lib/lifecycle-v9-validation';
import {type Block,type Field,type Document} from '../lib/lifecycle-v9-model';
import {validateSigningRoute,signingComplete,pendingSigningSteps,signingSendBack,type SigningDocument,type SigningRoute,type SigningGuardrails} from '../lib/document-signing-model';
import {ProbationError} from '../lib/probation-model';
import type {ProbationTemplate} from '../lib/probation-workflow';
import {PROBATION_LETTER_KEYS} from '../lib/probation-letter-template';
import {createSigningDocumentTx,readSigningDocumentTx,recordDocumentSigningActionTx,reviseSigningDocumentTx,refreshCanonicalProbationSigningRouteTx,resendSigningDocumentTx,signingContentVisibleTx,canEditSigningContent,signingDocumentOwner,documentRoutingProblems,documentRoutingSignatureProblems,resolveDocumentRouting,type DocumentRouting,type DocumentRoutingWho} from '../packs/document-signing/service';
import type {LetterBuilderCatalog} from '../lib/probation-letter-matching';
import {resolveNativeDocumentRouting,type NativeDocumentRoutingFacts} from '../lib/document-signing-native-routing';
import type {Routing as NativeRouting,Group as NativeGroup} from '../lib/onboarding-model';
import {routedStepChooser,type RoutedAssignmentFacts} from '../lib/routed-step-assignment';
import {documentRoutingSchema,nativeDocumentRoutingSchema} from '../lib/document-signing-routing-schema';
import {automationReferencesTx} from './automation-builder';
import {routedStepPeople,type Routing} from '../lib/automation/routing';
const id=z.uuid(),json=(value:unknown)=>JSON.stringify(value);
const base=v9ConfigSchema.shape.templates.element;
const route=z.object({version:z.number().int().positive(),steps:z.array(z.object({id:z.string().min(1).max(120),role:z.enum(['lm','hod','pbp','employee']),kind:z.enum(['sign','acknowledge','approve']),stage:z.number().int().min(0).max(30),holderId:z.null(),holderPersonId:z.undefined().optional(),representedId:z.undefined().optional(),required:z.boolean()}).strict()).min(2).max(30)}).strict();
const letterRules=base.shape.rules.pick({businessGroup:true,company:true,department:true,grade:true,employmentType:true,title:true}).extend({businessUnit:z.array(z.string().min(1).max(200)).max(200).optional(),outcome:z.array(z.enum(['confirm','extend','not_confirm'])).max(3).optional(),extensionNumber:z.array(z.string().regex(/^[0-2]$/)).max(3).optional()}).strict();
const templateSchema=base.omit({module:true}).extend({gradeAtStartCodes:z.record(z.uuid(),z.string().min(1).max(100)).optional(),organisationMigration:z.object({sourceVersionId:z.uuid().nullable(),sourceVersion:z.number().int().nonnegative(),reviewed:z.literal(true),mappings:z.array(z.object({sourceField:z.enum(['businessGroup','businessUnit','company','department','grade']),sourceValue:z.string().min(1).max(200),targetField:z.enum(['businessGroup','company','department','grade']),targetValues:z.array(z.string().min(1).max(200)).min(1).max(200)}).strict()).max(1000)}).strict().optional(),routingRegistry:z.enum(['shared','on-off-boarding']).optional(),routingMigration:z.object({sourceVersionId:z.uuid(),sourceVersion:z.number().int().positive(),reviewed:z.literal(true)}).strict().optional(),organisationMapping:z.enum(['legacy-v1','personnel-v2']).optional(),rules:letterRules,module:z.literal('probation'),outcome:z.enum(['confirm','extend','not_confirm']),unfinished:z.boolean(),blocks:base.shape.versions.element.shape.blocks,fields:base.shape.versions.element.shape.fields,route,routing:nativeDocumentRoutingSchema.optional()}).strict();
export type ProbationLetterDefinition={id:string;companyId:string;key:string;version:number;state:'draft'|'published'|'retired';retirementReason?:string|null;data:ProbationTemplate};
export type ProbationLetterPreview={merge:Record<string,string>;blocks:Block[];fields:Field[];route:SigningRoute;guardrails:SigningGuardrails;companyId:string;employmentId:string;templateId:string;templateVersion:number;templateName?:string;outcomeRevision:number;sourceDigest:string};
/** Who holds each step of a letter's route (5765, L3/L4): name and job title of the holder, the routing or group it was routed to. */
export type ProbationLetterSigner={holderId:string|null;name:string|null;title:string|null;label:string|null;role:string;representedName:string|null};
export type ProbationLetterView={signers?:Record<string,ProbationLetterSigner>;routed:boolean;contentVisible:boolean;owner:{stepId:string|null;userId:string|null}|null;canEditContent:boolean;editableFieldOwner?:'employee'|'hr';unresolved:{stepId:string;meantFor:string;reason:string}[];id:string;caseId:string;outcomeId:string;outcomeRevision:number|null;storageRevision:number;state:string;createdAt:string;name:string;templateId:string;templateVersion:number;blocks:Block[];fields:Field[];merge:Record<string,string>;signing:{id:string;document:SigningDocument}|null;route:SigningRoute|null;runtimeEnabled:boolean;sourceMoved:boolean;canPrepare:boolean;canRelease:boolean;document:Document};
function companyGate(ctx:SessionContext,companyId:string){if(ctx.entitlementsExempt===undefined)assertModuleEnabled(ctx,'lifecycle',companyId);}
function validateTemplate(raw:unknown,publish:boolean):ProbationTemplate{
 const value=templateSchema.parse(raw) as ProbationTemplate;
 // Explicit Publish is the review action; no separate wording-approved checkbox is required.
 value.unfinished=false;
 if(value.routingRegistry!=='on-off-boarding'&&!documentRoutingSchema.optional().safeParse((value as ProbationTemplate&{routing?:DocumentRouting}).routing).success)throw new ProbationError('invalid','Choose a valid Shared routing identity.');
 if(value.type!=='Letter'||value.retired)throw new ProbationError('invalid','Choose an active outcome letter template.');
 if(new Set(value.blocks.map(b=>b.id)).size!==value.blocks.length||new Set(value.fields.map(f=>f.id)).size!==value.fields.length)throw new ProbationError('invalid','Document blocks and fields need unique identities.');
 const fieldIds=new Set(value.fields.map(f=>f.id)),keys=new Set<string>([...PROBATION_LETTER_KEYS,...fieldIds]);
 for(const field of value.fields){if(field.owner==='employee'&&value.routingRegistry!=='on-off-boarding'||field.owner==='pmLocked'&&(!field.pmKey||!PROBATION_LETTER_KEYS.includes(field.pmKey as typeof PROBATION_LETTER_KEYS[number]))||field.owner!=='pmLocked'&&(field.pmKey!==null||PROBATION_LETTER_KEYS.includes(field.id as typeof PROBATION_LETTER_KEYS[number]))||field.when&&!fieldIds.has(field.when.field))throw new ProbationError('invalid','Use declared HR fields or the registered read-only Personnel fields.');}
 for(const block of value.blocks){if(block.type==='field'&&(!block.fieldId||!fieldIds.has(block.fieldId)))throw new ProbationError('invalid','Choose an existing field for each document field block.');for(const text of[block.text,block.rows??'',block.label??'']){if(/\{\{|\}\}/.test(text))throw new ProbationError('invalid','Letter merge fields use single braces.');for(const match of text.matchAll(/\{([^{}]+)\}/g))if(!/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)?$/.test(match[1])||!keys.has(match[1]))throw new ProbationError('invalid','Use a registered letter merge field.');}}
 validateSigningRoute(value.route,{requiredRoles:['employee']});
 const employee=value.route.steps.find(s=>s.role==='employee'&&s.required);
 if(!employee||employee.kind!=='acknowledge'||!value.route.steps.some(s=>s.required&&s.role!=='employee')||value.route.steps.some(s=>s.role!=='employee'&&s.stage>=employee.stage))throw new ProbationError('invalid','Required HR signing must finish before employee acknowledgement.');
 // A routed version (non-empty signing and review routing) links its signature blocks to its Sign steps instead
 // (checked against current routings, groups and people in the saving transaction: probationLetterRoutingProblemsTx).
 const configuredRouting=(value as ProbationTemplate&{routing?:DocumentRouting}).routing??[];
 if(publish&&value.fields.some(field=>field.owner==='employee'&&field.required)){
  const firstSignature=Math.min(...configuredRouting.filter(step=>step.action==='sign'||step.action==='acknowledge').map(step=>step.order));
  if(!configuredRouting.some(step=>step.who.kind==='employee'&&step.action==='review'&&step.required!==false&&step.order<firstSignature))throw new ProbationError('invalid','Add a required Employee Review step before the first signature so employee fields can be completed while the document is editable.');
 }
 const routed=!!(value as ProbationTemplate&{routing?:DocumentRouting}).routing?.length;
 if(publish&&(!value.blocks.some(b=>b.type==='text'&&b.text.trim())||!routed&&(!value.blocks.some(b=>b.type==='signature'&&b.role==='hr')||!value.blocks.some(b=>b.type==='signature'&&b.role==='employee'))))throw new ProbationError('invalid','Complete the letter wording and required signature blocks before publishing.');
 return value;
}
export function probationLetterTemplates(ctx:SessionContext,companyId:string){return withScopedLifecycleTenant(ctx,async tx=>{companyGate(ctx,id.parse(companyId));return tx.execute<ProbationLetterDefinition>(sql`select id,company_id as "companyId",definition_key as key,version,state,case when app.probation_config_admin(company_id) then retirement_reason end as "retirementReason",data from probation_builder_definition where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid and kind='template' and not exists(select 1 from probation_builder_definition deleted where deleted.tenant_id=probation_builder_definition.tenant_id and deleted.company_id=probation_builder_definition.company_id and deleted.kind='template' and deleted.definition_key=probation_builder_definition.definition_key and deleted.data->'deleted'='true'::jsonb) order by definition_key,version desc`);});}
export function saveProbationLetterTemplate(ctx:SessionContext,input:{companyId:string;template:unknown;publish:boolean;expectedVersion:number}){return withScopedLifecycleTenant(ctx,async tx=>{
 companyGate(ctx,id.parse(input.companyId));const template=validateTemplate(input.template,input.publish);z.number().int().nonnegative().parse(input.expectedVersion);
 const problems=await probationLetterRoutingProblemsTx(tx,template,input.companyId);if(problems.length)throw new ProbationError('invalid',problems[0]);
 const[row]=await tx.execute<{id:string}>(sql`select app.probation_definition_save(${input.companyId}::uuid,${template.id},'template',${json(template)}::jsonb,${input.publish},${input.expectedVersion}) as id`);return row.id;
});}
/** Routing problems of a template version, in the caller's transaction. Empty for a version without routing (today's behaviour). */
export async function probationLetterRoutingProblemsTx(tx:Tx,template:ProbationTemplate&{routing?:DocumentRouting},companyId?:string):Promise<string[]>{
 const routing=template.routing??[];if(!routing.length)return[];
 const people=[...new Set(routing.flatMap(step=>step.who.kind==='people'?step.who.userIds:[]))];
 const refs=template.routingRegistry==='on-off-boarding'&&companyId?await probationNativeRoutingReferencesTx(tx,companyId,people):await automationReferencesTx(tx,people);
 return[...documentRoutingProblems(routing,refs),...documentRoutingSignatureProblems(routing,template.blocks)];
}
export async function probationNativeRoutingReferencesTx(tx:Tx,companyId:string,people:readonly string[]=[]){
 const[row]=await tx.execute<{data:{routings:NativeRouting[];groups:NativeGroup[]}}>(sql`select app.probation_native_document_routing_references(${id.parse(companyId)}::uuid) as data`);
 const persons=people.length?await tx.execute<{id:string}>(sql`select u.id from app_user u join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.tenant_id=app.current_tenant_id() and u.id=any(array[${sql.join(people.map(value=>sql`${id.parse(value)}::uuid`),sql`, `)}]::uuid[]) and u.archived_at is null and not app.login_blocked(u.id) and app.access_workforce_person(p.id,'workforce.view')`):[];
 return {...row.data,routingExists:(value:string)=>row.data.routings.some(routing=>routing.id===value),groupExists:(value:string)=>row.data.groups.some(group=>group.id===value),personExists:(value:string)=>persons.some(person=>person.id===value)};
}
export function probationNativeDocumentRoutingChoices(ctx:SessionContext,companyId:string){return withScopedLifecycleTenant(ctx,async tx=>{companyGate(ctx,id.parse(companyId));const refs=await probationNativeRoutingReferencesTx(tx,companyId);return{routings:refs.routings.map(routing=>({id:routing.id,name:routing.name})),groups:refs.groups.map(group=>({id:group.id,name:group.name}))};});}
export function probationLetterBuilderCatalog(ctx:SessionContext,companyId:string):Promise<LetterBuilderCatalog>{return withScopedLifecycleTenant(ctx,async tx=>{
 companyGate(ctx,id.parse(companyId));const[access]=await tx.execute<{ok:boolean}>(sql`select app.probation_config_admin(${companyId}::uuid) as ok`);if(!access?.ok)throw new ProbationError('forbidden','Probation template administration is required.');
 const[row]=await tx.execute<{data:LetterBuilderCatalog}>(sql`select jsonb_build_object('companyId',c.id,'parentCompanyId',coalesce(c.parent_company_id,c.id),'targets',jsonb_build_object(
 'company',jsonb_build_array(jsonb_build_object('id',c.id,'code',coalesce(nullif(c.company_label,''),c.legal_name),'name',c.legal_name,'archived',c.archived_at is not null)),
 'businessGroup',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'code',u.code,'name',u.name,'archived',u.archived_at is not null) order by u.code,u.id) from business_unit u where u.tenant_id=c.tenant_id and u.company_id=c.id),'[]'::jsonb),
 'department',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'code',d.name,'name',coalesce(d.label,d.name),'archived',d.archived_at is not null) order by d.name,d.id) from department d where d.tenant_id=c.tenant_id and d.company_id=c.id),'[]'::jsonb),
 'grade',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'code',g.code,'name',g.name,'archived',g.archived_at is not null) order by g.rank,g.code,g.id) from job_grade g where g.tenant_id=c.tenant_id and (g.scope_company_ids is null or c.id=any(g.scope_company_ids))),'[]'::jsonb)),
 'positions',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'code',p.title,'name',coalesce(p.label,p.title),'archived',p.archived_at is not null) order by p.title,p.id) from position p where p.tenant_id=c.tenant_id and (p.company_id=c.id or p.is_global)),'[]'::jsonb)) as data from company c where c.id=${companyId}::uuid and c.tenant_id=app.current_tenant_id()`);return row.data;
});}
export type ProbationLetterChoices={templates:{id:string;familyId:string;version:number;name:string;score:number}[];suggestedTemplateId:string|null;tie:boolean};
export function probationLetterTemplateChoices(ctx:SessionContext,outcomeId:string){return withScopedLifecycleTenant(ctx,async tx=>{const[row]=await tx.execute<{data:ProbationLetterChoices}>(sql`select app.probation_letter_template_choices(${id.parse(outcomeId)}::uuid) as data`);return row.data;});}
async function previewTx(tx:Tx,ctx:SessionContext,input:{outcomeId:string;templateId:string;edits:Record<string,string>;revision:number}){
 id.parse(input.outcomeId);id.parse(input.templateId);z.number().int().positive().parse(input.revision);z.record(z.string().max(120),z.string().max(10000)).refine(v=>Object.keys(v).length<=200).parse(input.edits);
 const[row]=await tx.execute<{data:ProbationLetterPreview}>(sql`select app.probation_letter_preview(${input.outcomeId}::uuid,${input.templateId}::uuid,${json(input.edits)}::jsonb,${input.revision}) as data`);if(!row?.data)throw new ProbationError('forbidden','The current letter source is unavailable.');companyGate(ctx,row.data.companyId);return row.data;
}
export function previewProbationLetter(ctx:SessionContext,input:Parameters<typeof previewTx>[2]){return withScopedLifecycleTenant(ctx,tx=>previewTx(tx,ctx,input));}
export {probationLetterDocument} from '../lib/probation-letter-document';

export async function renderProbationLetterPdf(document:Document,signing:SigningDocument|null,reference:string):Promise<Buffer>{
 const {v9PdfDocument}=await import('../lib/lifecycle-v9-pdf'),{renderLetterPdf}=await import('../lib/letter-pdf');
 const resolved=v9PdfDocument(document,true),current=signing?.actions.filter(a=>a.action==='signed'&&a.contentHash===signing.contentHash&&a.contentRevision===signing.contentRevision)??[];
 if(signing)resolved.blocks.push({type:'heading',level:2,content:[{type:'text',text:'Authenticated signature history'}]},{type:'table',rows:[['Role','Verified signer','Time'],...current.map(a=>[a.role,a.actorName,a.at])].map(row=>row.map(text=>[{type:'text' as const,text}]))});
 const output=await renderLetterPdf({document:resolved,title:document.name,reference,signature:{name:'',caption:signing?'Authenticated signatures are recorded in this document.':'Unsigned preparation copy',timestamp:''}});
 const drawn=current.filter(a=>a.signature?.method==='drawn');if(!drawn.length)return Buffer.from(output.bytes);
 const {PDFDocument,StandardFonts}=await import('pdf-lib'),pdf=await PDFDocument.load(output.bytes),font=await pdf.embedFont(StandardFonts.Helvetica);
 for(const action of drawn){const page=pdf.addPage([595,842]),stamp=await pdf.embedPng(Buffer.from(action.signature!.value.split(',')[1],'base64')),scale=Math.min(420/stamp.width,160/stamp.height);page.drawText(action.role+' · '+action.at,{x:48,y:780,size:10,font});page.drawImage(stamp,{x:48,y:580,width:stamp.width*scale,height:stamp.height*scale});}
 return Buffer.from(await pdf.save());
}
export async function prepareProbationLetterTx(tx:Tx,ctx:SessionContext,input:Parameters<typeof previewTx>[2]){
 const preview=await previewTx(tx,ctx,input);
 if(preview.blocks.some(block=>block.type==='letterhead')&&['company.name','company.regNo','company.address'].some(key=>!preview.merge[key]?.trim()))throw new ProbationError('invalid','An authorized Organisation administrator must complete the company letterhead before this letter can be prepared.');
 validateProbationLetterFields(preview.fields,preview.merge,{preparing:true});
 const[row]=await tx.execute<{data:ProbationLetterPreview&{partId:string;contentHash:string;contentRevision:number;routing?:DocumentRouting;templateKey?:string;caseOwnerId?:string|null;fallbackGroupId?:string|null}}>(sql`select app.probation_prepare_letter(${input.outcomeId}::uuid,${input.templateId}::uuid,${json(input.edits)}::jsonb,${input.revision},${preview.sourceDigest}) as data`);
 // A routed template version (migration 5752): resolve its routing for this employee, freeze it on the letter, and create
 // the signing document with the routing's owner, send-back, edit-lock and visibility rules. Unrouted: exactly as before.
 const routed=row.data.routing?.length?await freezeLetterRoutingTx(tx,row.data.partId,row.data.routing):null;
 // The signing document starts on the current resolution of the frozen route (a general Probation delegation already
 // moves a step to the delegate on behalf of its holder, 5755), which is what the signing store checks it against.
 const[current]=routed?await tx.execute<{route:SigningRoute|null}>(sql`select app.probation_resolved_route(${row.data.partId}::uuid) as route`):[];
 const created=routed
  ?await createSigningDocumentTx(tx,ctx,{companyId:row.data.companyId,employmentId:row.data.employmentId,subjectId:row.data.partId,subjectType:'probation',contentHash:row.data.contentHash,route:current?.route??routed.route,guardrails:{requiredRoles:[]},routing:{templateId:row.data.templateKey??preview.templateId,templateVersion:row.data.templateVersion??preview.templateVersion,caseOwnerId:routed.caseOwnerId,fallbackGroupId:routed.fallbackGroupId}})
  :await createSigningDocumentTx(tx,ctx,{companyId:row.data.companyId,employmentId:row.data.employmentId,subjectId:row.data.partId,subjectType:'probation',contentHash:row.data.contentHash,route:row.data.route,guardrails:row.data.guardrails});
 await tx.execute(sql`select app.probation_letter_transition(${row.data.partId}::uuid)`);
 await emitLetterEventTx(tx,ctx,{caseId:null,partId:row.data.partId,name:preview.templateName??null,document:created.document});
 return{partId:row.data.partId,outcomeRevision:row.data.outcomeRevision,documentId:created.id};
}
type LetterRoutingContext={employeeUserId:string|null;directSuperiorUserId:string|null;caseOwnerId:string|null;fallbackGroupId:string|null;facts:{businessGroup:string|null;businessGroupCompany:string|null;company:string|null;department:string|null;jobTitle:string|null};routings:Routing[];groups:{id:string;members:string[]}[];recent:Record<string,number>;nativeRoutings?:NativeRouting[];nativeFacts?:NativeDocumentRoutingFacts};
/** Plain description of who a step was meant for, recorded when the fallback group takes it (no personal data). */
function describeWho(who:DocumentRoutingWho,routings:Routing[]):string{
 if(who.kind==='employee')return 'The employee';if(who.kind==='directSuperior')return 'Their Direct Superior';
 if(who.kind==='routing')return `The routing “${routings.find(r=>r.id===who.routingId)?.name??'removed routing'}”`;
 if(who.kind==='group')return `The assignment group ${who.groupId}`;return 'The named people';
}
/** The V9 assignment owner's chooser over this case's groups and named people (5755). */
export async function routedStepChooserTx(tx:Tx,caseId:string,groupIds:readonly string[],people:readonly string[],native=false){
 const groups=`{${[...new Set(groupIds)].map(id=>'"'+id.replace(/["\\]/g,'')+'"').join(',')}}`,persons=`{${[...new Set(people)].join(',')}}`;
 const[row]=native?await tx.execute<{data:RoutedAssignmentFacts}>(sql`select app.probation_native_assignment_facts(${caseId}::uuid,${groups}::text[],${persons}::uuid[]) as data`):await tx.execute<{data:RoutedAssignmentFacts}>(sql`select app.probation_assignment_facts(${caseId}::uuid,${groups}::text[],${persons}::uuid[]) as data`);
 return routedStepChooser(row.data);
}
/**
 * Resolves a routed letter's routing on the database's facts for this employee and freezes it (5752). One person per
 * step, chosen by the V9 assignment owner's rule (lib/routed-step-assignment.ts, facts from 5755): nobody on leave
 * today or at the group's open-task limit, then the lowest open load; `roundRobin` breaks ties by least recent
 * assignment, `any` by member order. Nobody found → the fallback group (the case's settings, else GBS People Ops)
 * takes the step, chosen the same way, and the step records who it was meant for and why.
 */
async function freezeLetterRoutingTx(tx:Tx,partId:string,routing:DocumentRouting){
 const[definition]=await tx.execute<{registry:string|null}>(sql`select t.data->>'routingRegistry' as registry from probation_part p join probation_builder_definition t on t.id=(p.data->>'letterTemplateId')::uuid and t.tenant_id=p.tenant_id where p.id=${partId}::uuid and p.tenant_id=app.current_tenant_id()`);
 const[context]=definition?.registry==='on-off-boarding'?await tx.execute<{data:LetterRoutingContext}>(sql`select app.probation_letter_native_routing_context(${partId}::uuid) as data`):await tx.execute<{data:LetterRoutingContext}>(sql`select app.probation_letter_routing_context(${partId}::uuid) as data`);
 const c=context.data,groups=new Map(c.groups.map(g=>[g.id,g.members])),routings=new Map(c.routings.map(r=>[r.id,r]));
 const[part]=await tx.execute<{caseId:string}>(sql`select case_id as "caseId" from probation_part where id=${partId}::uuid and tenant_id=app.current_tenant_id()`);
 // I8: people named on the matching row of a routing are eligible facts too, not only people named on the step.
 const people=routedStepPeople(routing,id=>routings.get(id)??null,{businessGroup:[c.facts.businessGroup,c.facts.businessGroupCompany].filter((value):value is string=>!!value),company:c.facts.company,department:c.facts.department,jobTitle:c.facts.jobTitle});
 const chooser=await routedStepChooserTx(tx,part.caseId,[...groups.keys()],people,!!c.nativeRoutings);
 const fallbackMembers=c.fallbackGroupId?groups.get(c.fallbackGroupId)??[]:[];
 const nativeGroups=c.groups.map(group=>({...group,name:group.id,limit:0}));
 const resolved=resolveDocumentRouting(routing,{...(c.nativeRoutings&&c.nativeFacts?{nativeRouting:(value:string)=>{const native=c.nativeRoutings!.find(routing=>routing.id===value);return native?resolveNativeDocumentRouting(native,c.nativeFacts!,nativeGroups,userId=>chooser.available(userId)):{userIds:[],groupId:null,reason:'The On/Off Boarding routing no longer exists.'};}}:{}),employeeUserId:c.employeeUserId,directSuperiorUserId:c.directSuperiorUserId,facts:{businessGroup:[c.facts.businessGroup,c.facts.businessGroupCompany].filter((v):v is string=>!!v),company:c.facts.company,department:c.facts.department,jobTitle:c.facts.jobTitle},
  routing:id=>routings.get(id)??null,groupMembers:id=>groups.get(id)??null,choose:chooser.choose,choiceProblem:chooser.problem,fallback:c.fallbackGroupId?{groupId:c.fallbackGroupId,members:fallbackMembers}:null,describe:who=>describeWho(who,c.routings)});
 await tx.execute(sql`select app.probation_letter_freeze_route(${partId}::uuid,${json(resolved.route)}::jsonb,${json(resolved.unresolved)}::jsonb)`);
 return{route:resolved.route,caseOwnerId:c.caseOwnerId,fallbackGroupId:c.fallbackGroupId};
}
/**
 * Letter events for shared workflows (W3): sent back, a step needs someone, or signed and waiting for release. The
 * occurrence is the number of recorded actions, so each change raises the event once.
 */
async function emitLetterEventTx(tx:Tx,ctx:SessionContext,input:{caseId?:string|null;partId:string;name:string|null;document:SigningDocument}){
 const[part]=await tx.execute<{caseId:string;outcomeId:string|null;revision:number|null;outcome:string|null}>(sql`select p.case_id as "caseId",o.id as "outcomeId",o.revision,o.outcome from probation_part p left join probation_outcome o on o.letter_part_id=p.id and o.tenant_id=p.tenant_id where p.id=${input.partId}::uuid and p.tenant_id=${ctx.tenantId}::uuid`);
 if(!part)return;
 const sendBack=signingSendBack(input.document),pending=pendingSigningSteps(input.document);
 const trigger=sendBack?'letterSentBack':pending.length?'letterActionNeeded':'letterReleasePending';
 const{probationPendingStep,emitProbationEventsSafelyTx}=await import('./probation-automation');
 const step=probationPendingStep(pending);
 await emitProbationEventsSafelyTx(tx,ctx,part.caseId,[{trigger,occurrence:`${input.partId}:${input.document.actions.length}`,pending:step.users,
  facts:{partId:input.partId,outcome:part.outcomeId&&part.outcome?{id:part.outcomeId,revision:part.revision??0,outcome:part.outcome}:null,letter:{name:input.name,signingStep:pending[0]?.kind??null,sentBackBy:sendBack?.actorName??null,sentBackReason:sendBack?.comment??null},pendingStep:step.label}}]);
}
export function prepareProbationLetter(ctx:SessionContext,input:Parameters<typeof previewTx>[2]){return withScopedLifecycleTenant(ctx,tx=>prepareProbationLetterTx(tx,ctx,input));}

async function readLetterTx(tx:Tx,ctx:SessionContext,caseId:string,partId:string):Promise<ProbationLetterView>{
 id.parse(caseId);id.parse(partId);
 const[row]=await tx.execute<{id:string;case_id:string;revision:number;created_at:string;company_id:string;actor_is_employee:boolean;data:{state:string;letterOutcomeId:string;letterTemplateId:string;letterTemplateVersion:number;letterTemplateName?:string;letterBlocks:Block[];letterFields:Field[];letterMerge:Record<string,string>;letterRouting?:DocumentRouting;letterRoutingUnresolved?:{stepId:string;meantFor:string;reason:string}[]};outcome_revision:number|null;released:boolean;runtime_enabled:boolean;source_moved:boolean;can_prepare:boolean;can_release:boolean}>(sql`select p.id,p.case_id,p.revision,p.created_at::text,c.company_id,app.probation_role(c.employment_id,'employee') as actor_is_employee,p.data,(select revision from probation_outcome o where o.id=(p.data->>'letterOutcomeId')::uuid and o.tenant_id=p.tenant_id) as outcome_revision,exists(select 1 from probation_outcome o where o.letter_part_id=p.id and o.tenant_id=p.tenant_id and o.released_at is not null) as released,exists(select 1 from probation_activation activation where activation.tenant_id=c.tenant_id and activation.company_id=c.company_id and activation.enabled and activation.activation_on<=(now() at time zone 'Asia/Kuala_Lumpur')::date) and app.probation_owns_legacy(c.employment_id) as runtime_enabled,app.probation_case_source_moved(c.id) as source_moved,app.probation_role(c.employment_id,'pbp') or app.probation_role(c.employment_id,'gbs') as can_prepare,p.data->>'state' not in('locked','cancelled','release_requested') and exists(select 1 from probation_outcome current_outcome where current_outcome.id=(p.data->>'letterOutcomeId')::uuid and current_outcome.tenant_id=p.tenant_id and current_outcome.letter_part_id=p.id and current_outcome.released_at is null) and (app.probation_role(c.employment_id,'pbp') or app.probation_role(c.employment_id,'gbs') and p.data->'letterMerge'->>'outcome'='confirm') as can_release from probation_part p join probation_case c on c.id=p.case_id and c.tenant_id=p.tenant_id where p.id=${partId}::uuid and p.case_id=${caseId}::uuid and p.tenant_id=${ctx.tenantId}::uuid and p.data->>'documentKind'='letter'`);
 if(!row)throw new ProbationError('forbidden','This outcome letter is unavailable in your current scope.');companyGate(ctx,row.company_id);
 const[stored]=await tx.execute<{id:string}>(sql`select id from document_signing_document where subject_type='probation' and subject_id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid`);
 const signing=stored?{id:stored.id,document:await readSigningDocumentTx(tx,ctx,stored.id)}:null;
 let currentRoute=signing?.document.route??null;
 if(signing&&row.runtime_enabled&&!row.source_moved&&!['locked','cancelled','release_requested'].includes(row.data.state)){
  const[resolved]=await tx.execute<{route:SigningRoute}>(sql`select app.probation_resolved_route(${row.id}::uuid) as route`);currentRoute=resolved?.route??currentRoute;
 }
 // Routed letters (5752) are private until they reach you (handoff A2): everyone with access sees the routing and status;
 // the content only when the database says so (owner, your turn, you acted, or released).
 // 5755 (decision 7): whoever's turn it is on the current resolution (a Probation delegate acting on behalf of the frozen
 // holder) sees the content too; the database's part access has already admitted them.
 const routed=!!signing?.document.routing,contentVisible=!signing||await signingContentVisibleTx(tx,signing.id,row.released)||routed&&!!currentRoute&&!!ctx.userId&&pendingSigningSteps({...signing.document,route:currentRoute}).some(step=>step.holderId===ctx.userId);
 const hidden={letterBlocks:[] as Block[],letterFields:[] as Field[],letterMerge:{} as Record<string,string>};
 const shown=contentVisible?row.data:{...row.data,...hidden};
 const routing={routed,contentVisible,editableFieldOwner:row.actor_is_employee?'employee' as const:'hr' as const,owner:routed&&signing?signingDocumentOwner(signing.document):null,canEditContent:routed&&!!signing&&canEditSigningContent(signing.document,ctx.userId??null),unresolved:row.data.letterRoutingUnresolved??[]};
 // L3/L4 (5765): the person holding each step of the shown route, so unsigned signature blocks and "Required signers"
 // name them; a step nobody holds yet keeps its routing or role label. Bounded by the route (at most 50 rows).
 const signers=currentRoute?await letterSignersTx(tx,row.id,currentRoute):undefined;
 const value={...routing,...(signers?{signers}:{}),id:row.id,caseId:row.case_id,outcomeId:row.data.letterOutcomeId,outcomeRevision:row.outcome_revision,storageRevision:row.revision,state:row.data.state,createdAt:row.created_at,name:row.data.letterTemplateName??'Probation outcome letter',templateId:row.data.letterTemplateId,templateVersion:row.data.letterTemplateVersion,blocks:shown.letterBlocks,fields:shown.letterFields,merge:shown.letterMerge,signing,route:currentRoute,runtimeEnabled:row.runtime_enabled&&!row.source_moved,sourceMoved:row.source_moved,canPrepare:row.runtime_enabled&&!row.source_moved&&row.can_prepare,canRelease:row.runtime_enabled&&!row.source_moved&&row.can_release};
 return{...value,document:probationLetterDocument({...value,signing:signing?.document})};
}
async function letterSignersTx(tx:Tx,partId:string,route:SigningRoute):Promise<Record<string,ProbationLetterSigner>>{
 const rows=await tx.execute<{step_id:string;holder_id:string|null;name:string|null;title:string|null;label:string|null}>(sql`select step_id,holder_id,name,title,label from app.probation_letter_signers(${partId}::uuid)`);
 const byHolder=new Map(rows.filter(r=>r.holder_id).map(r=>[r.holder_id!,r]));
 return Object.fromEntries(route.steps.map(step=>{
  const own=rows.find(r=>r.step_id===step.id&&r.holder_id===step.holderId),any=rows.find(r=>r.step_id===step.id&&r.label);
  const holder=step.holderId?own??byHolder.get(step.holderId)??null:null;
  return[step.id,{holderId:step.holderId,name:holder?.name??null,title:holder?.title??null,label:step.label??own?.label??any?.label??null,role:step.role,
   representedName:step.representedId&&step.representedId!==step.holderId?byHolder.get(step.representedId)?.name??null:null}];
 }));
}
export function readProbationLetter(ctx:SessionContext,caseId:string,partId:string){return withScopedLifecycleTenant(ctx,tx=>readLetterTx(tx,ctx,caseId,partId));}
export function editProbationLetterContent(ctx:SessionContext,input:{caseId:string;partId:string;revision:number;edits:Record<string,string>;values:Record<string,string>;reason:string}){return withScopedLifecycleTenant(ctx,async tx=>{
 const view=await readLetterTx(tx,ctx,input.caseId,input.partId);if(!view.runtimeEnabled||!view.canEditContent||view.storageRevision!==input.revision||!view.signing)throw new ProbationError('conflict','Read the current editable letter before saving changes.');
 const[row]=await tx.execute<{data:{changed:boolean;documentId:string;contentHash:string}}>(sql`select app.probation_letter_edit_content(${id.parse(input.partId)}::uuid,${input.revision},${json(input.edits)}::jsonb,${json(input.values)}::jsonb,${input.reason}) as data`);
 if(row.data.changed)await reviseSigningDocumentTx(tx,ctx,{id:row.data.documentId,hash:row.data.contentHash,reason:input.reason});
 return{saved:true};
});}
export function actOnProbationLetter(ctx:SessionContext,input:{caseId:string;partId:string;revision:number;stepId:string;action:'signed'|'returned'|'reviewed'|'approved';comment?:string;method?:'typed'|'drawn';value?:string;consent?:boolean;actionId?:string}){return withScopedLifecycleTenant(ctx,async tx=>{
 const view=await readLetterTx(tx,ctx,input.caseId,input.partId);if(!view.runtimeEnabled||view.storageRevision!==input.revision||!view.signing)throw new ProbationError('conflict','Read the current letter revision before acting.');
 if(input.action==='signed')validateProbationLetterFields(view.fields,view.merge);
 const current=view.signing.document,changed=view.route?.steps.some(step=>{const previous=current.route.steps.find(value=>value.id===step.id);return previous&&(previous.holderId!==step.holderId||(previous.representedId??null)!==(step.representedId??null)||JSON.stringify(previous.coveredStepIds??[])!==JSON.stringify(step.coveredStepIds??[])||previous.coveredByStepId!==step.coveredByStepId);});
 const signerDocument=changed?await refreshCanonicalProbationSigningRouteTx(tx,view.signing.id):current;
 const document=await recordDocumentSigningActionTx(tx,ctx,{id:view.signing.id,stepId:input.stepId,revision:signerDocument.contentRevision,hash:signerDocument.contentHash,action:input.action,comment:input.comment,method:input.method,value:input.value,consent:input.consent,actionId:input.actionId});await tx.execute(sql`select app.probation_letter_transition(${view.id}::uuid)`);
 await emitLetterEventTx(tx,ctx,{caseId:view.caseId,partId:view.id,name:view.name,document});return document;
});}
/** The owner of a routed letter sends it round again unchanged after a send-back (5752); signing restarts at its first stage. */
export function resendProbationLetter(ctx:SessionContext,input:{caseId:string;partId:string;revision:number;comment?:string;actionId?:string}){return withScopedLifecycleTenant(ctx,async tx=>{
 const view=await readLetterTx(tx,ctx,input.caseId,input.partId);if(!view.runtimeEnabled||view.storageRevision!==input.revision||!view.signing||!view.routed)throw new ProbationError('conflict','Read the current letter revision before acting.');
 const document=await resendSigningDocumentTx(tx,ctx,{id:view.signing.id,actionId:input.actionId,comment:input.comment});await tx.execute(sql`select app.probation_letter_transition(${view.id}::uuid)`);
 await emitLetterEventTx(tx,ctx,{caseId:view.caseId,partId:view.id,name:view.name,document});return document;
});}
export function releaseProbationLetter(ctx:SessionContext,input:{caseId:string;partId:string;outcomeRevision:number;reason:string}){return withScopedLifecycleTenant(ctx,async tx=>{
 const view=await readLetterTx(tx,ctx,input.caseId,input.partId);if(!view.canRelease||!view.signing||view.outcomeRevision!==input.outcomeRevision)throw new ProbationError('conflict','An authorized current completed letter is required.');
 const rules={requiredRoles:view.signing.document.route.steps.filter(s=>s.required).map(s=>s.role)};if(!signingComplete(view.signing.document,rules))throw new ProbationError('invalid','Every required signer must finish before release.');
 const[row]=await tx.execute<{id:string}>(sql`select app.probation_release_signed_letter(${view.outcomeId}::uuid,${view.id}::uuid,${input.outcomeRevision},${input.reason}) as id`);return row.id;
});}

export function deleteProbationLetterTemplate(ctx:SessionContext,input:{companyId:string;key:string;expectedVersion:number;reason:string}){return withScopedLifecycleTenant(ctx,async tx=>{companyGate(ctx,id.parse(input.companyId));await tx.execute(sql`select app.probation_letter_template_delete(${input.companyId}::uuid,${input.key},${input.expectedVersion},${input.reason})`);return{deleted:true};}).catch((error:unknown)=>{const database=pgErrorChain(error).find(link=>['22023','40001','42501'].includes(link.code??''));if(database)throw new ProbationError(database.code==='40001'?'conflict':database.code==='42501'?'forbidden':'invalid',database.message??'The template deletion was refused.');throw error;});}
