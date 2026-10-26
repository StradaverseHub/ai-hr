/** Letters use the existing employee identity, purpose access, document folder and DomainEvent owners. */
import {createHash,randomBytes} from 'node:crypto';
import {and,asc,desc,eq,gt,gte,inArray,isNull,lte,or,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {company,appUser,roleEnum,letterCapabilityGrant,letterAsset,letterPolicyVersion,letterMergeFieldVersion,letterTemplate,letterTemplateVersion,letterTemplateField,employment,person,assignment,position,department,compensation,letterGenerationBatch,letterRecord,letterRevision,letterCounter,letterJob,letterApprovalDecision,letterArtifact} from '../db/schema';
import {assertModuleGate} from './module-gate';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {lockPayrollHistoryReadTx} from './payroll-history-lock';
import {isModuleEnabled} from './entitlements';
import {validateLetterFields,validateLetterDocument,usedLetterFields,renderLetterDocument,LetterModelError,type LetterField,type LetterValue} from '../lib/letter-model';
import {LETTER_CAPABILITIES,validateLetterPolicy,LetterWorkflowError,letterReference,letterStageDecision,type LetterCapability,type LetterStageDecision} from '../lib/letter-workflow';
import {renderLetterPdf} from '../lib/letter-pdf';
import {isCalendarDate} from '../lib/calendar-date';
import {todayInKualaLumpur} from '../lib/hr-date';
import {compensationEffectiveOn} from './comp';
import {assertWorkforceEmploymentTx} from './workforce-access';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value:string){if(!UUID.test(value))throw new LetterWorkflowError('invalid','identity');return value;}
function text(value:string,max:number){const result=value.trim();if(!result||result.length>max)throw new LetterWorkflowError('invalid','text');return result;}
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
async function contextTx(ctx:SessionContext,tx:Tx,write:boolean){
 if(!ctx.userId)throw new LetterWorkflowError('permission');
 await lockPayrollHistoryReadTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);
 const [principal]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() as ok`);if(!principal?.ok)throw new LetterWorkflowError('permission');
 if(write)await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'letters:'+ctx.tenantId},0))`);
}
function letters<T>(ctx:SessionContext,write:boolean,work:(tx:Tx)=>Promise<T>):Promise<T>{
 assertModuleGate(ctx,'employees');return withTenant(ctx,async tx=>{await contextTx(ctx,tx,write);return work(tx);});
}
async function permission(tx:Tx,co:string,cap:LetterCapability){
 uuid(co);const [row]=await tx.execute<{allowed:boolean}>(sql`select app.letter_permission(${co}::uuid,${cap}) as allowed`);if(!row?.allowed)throw new LetterWorkflowError('permission');
}
async function event(tx:Tx,ctx:SessionContext,id:string,type:string,payload:Record<string,unknown>){
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'letter',aggregateId:id,eventType:'letter.'+type,actor:actorOf(ctx),payload});
}
async function lockCompany(tx:Tx,co:string){const [row]=await tx.select({id:company.id}).from(company).where(and(eq(company.id,uuid(co)),isNull(company.archivedAt))).for('share');if(!row)throw new LetterWorkflowError('permission');}
export function letterCompanyAccess(ctx:SessionContext){return letters(ctx,false,async tx=>{
 const rows=await tx.select({id:company.id,name:company.legalName,code:company.companyLabel,currency:company.currency,read:sql<boolean>`app.letter_permission(${company.id},'read')`,template:sql<boolean>`app.letter_permission(${company.id},'template')`,generate:sql<boolean>`app.letter_permission(${company.id},'generate')`,approve:sql<boolean>`app.letter_permission(${company.id},'approve')`,issue:sql<boolean>`app.letter_permission(${company.id},'issue')`,report:sql<boolean>`app.letter_permission(${company.id},'report')`,settings:sql<boolean>`app.letter_permission(${company.id},'settings')`}).from(company).where(isNull(company.archivedAt)).orderBy(asc(company.legalName),asc(company.id));
 return rows.filter(row=>LETTER_CAPABILITIES.some(cap=>row[cap]));
});}
export function saveLetterPermission(ctx:SessionContext,input:{companyId:string;capability:LetterCapability;role:string;allowed:boolean}){return letters(ctx,true,async tx=>{
 await permission(tx,input.companyId,'settings');await lockCompany(tx,input.companyId);
 if(!LETTER_CAPABILITIES.includes(input.capability)||!(roleEnum.enumValues as readonly string[]).includes(input.role)||typeof input.allowed!=='boolean')throw new LetterWorkflowError('invalid','permission');
 const [before]=await tx.select().from(letterCapabilityGrant).where(and(eq(letterCapabilityGrant.companyId,input.companyId),eq(letterCapabilityGrant.capability,input.capability),eq(letterCapabilityGrant.role,input.role)));
 const [saved]=await tx.insert(letterCapabilityGrant).values({tenantId:ctx.tenantId,companyId:input.companyId,capability:input.capability,role:input.role,allowed:input.allowed}).onConflictDoUpdate({target:[letterCapabilityGrant.tenantId,letterCapabilityGrant.companyId,letterCapabilityGrant.capability,letterCapabilityGrant.role],set:{allowed:input.allowed}}).returning({id:letterCapabilityGrant.id});
 await event(tx,ctx,saved.id,'permission.changed',{companyId:input.companyId,capability:input.capability,role:input.role,before:before?.allowed??null,allowed:input.allowed});return saved;
});}
export function addLetterAsset(ctx:SessionContext,input:{companyId:string;kind:'letterhead'|'signature';name:string;content:Buffer}){return letters(ctx,true,async tx=>{
 await permission(tx,input.companyId,input.kind==='signature'?'approve':'settings');await lockCompany(tx,input.companyId);
 if(!['letterhead','signature'].includes(input.kind)||input.content.length<24||input.content.length>2097152||input.content.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new LetterWorkflowError('invalid','png');
 const width=input.content.readUInt32BE(16),height=input.content.readUInt32BE(20);if(width<1||height<1||width>2048||height>2048)throw new LetterWorkflowError('invalid','imageSize');
 const [saved]=await tx.insert(letterAsset).values({tenantId:ctx.tenantId,companyId:input.companyId,ownerUserId:ctx.userId!,kind:input.kind,name:text(input.name,200),mimeType:'image/png',content:input.content,contentHash:hash(input.content)}).returning({id:letterAsset.id});
 await event(tx,ctx,saved.id,'asset.created',{companyId:input.companyId,kind:input.kind,contentHash:hash(input.content)});return saved;
});}
export function letterAssetChoices(ctx:SessionContext,co:string){return letters(ctx,false,async tx=>{await permission(tx,co,'settings');return tx.execute<{id:string;name:string;owner_user_id:string;kind:string}>(sql`select * from app.letter_asset_choices(${co}::uuid)`);});}
export function saveLetterPolicy(ctx:SessionContext,input:{companyId:string;category:string;enabled:boolean;policy:unknown}){return letters(ctx,true,async tx=>{
 await permission(tx,input.companyId,'settings');await lockCompany(tx,input.companyId);const policy=validateLetterPolicy(input.policy),category=text(input.category,100);
 if(typeof input.enabled!=='boolean')throw new LetterWorkflowError('invalid','enabled');
 if((policy.portalNotifications||policy.emailNotifications)&&!isModuleEnabled(ctx,'notifications',input.companyId))throw new LetterWorkflowError('configuration','notifications');
 const users=[...new Set(policy.stages.flatMap(stage=>stage.userIds).concat(policy.escalationUserId?[policy.escalationUserId]:[]))];
 for(const userId of users){const [row]=await tx.execute<{ok:boolean}>(sql`select app.letter_permission_for_user(${userId}::uuid,${input.companyId}::uuid,'approve') as ok`);if(!row?.ok)throw new LetterWorkflowError('configuration','approver');}
 for(const [id,kind,owner] of [[policy.letterheadAssetId,'letterhead',null],[policy.signatureAssetId,'signature',policy.signatoryUserId]] as const){if(!id)continue;const [row]=await tx.execute<{ok:boolean}>(sql`select app.letter_asset_reference(${input.companyId}::uuid,${id}::uuid,${kind},${owner}::uuid) as ok`);if(!row?.ok)throw new LetterWorkflowError('configuration','asset');}
 const [latest]=await tx.select({ordinal:letterPolicyVersion.ordinal}).from(letterPolicyVersion).where(and(eq(letterPolicyVersion.companyId,input.companyId),eq(letterPolicyVersion.category,category))).orderBy(desc(letterPolicyVersion.ordinal)).limit(1);
 const [saved]=await tx.insert(letterPolicyVersion).values({tenantId:ctx.tenantId,companyId:input.companyId,category,ordinal:(latest?.ordinal??0)+1,enabled:input.enabled,policy,createdBy:ctx.userId!}).returning({id:letterPolicyVersion.id,ordinal:letterPolicyVersion.ordinal});
 await event(tx,ctx,saved.id,'policy.versioned',{companyId:input.companyId,category,ordinal:saved.ordinal,enabled:input.enabled});return saved;
});}
export function saveLetterField(ctx:SessionContext,input:{companyId:string;definition:unknown;active:boolean}){return letters(ctx,true,async tx=>{
 await permission(tx,input.companyId,'template');await lockCompany(tx,input.companyId);const definition=validateLetterFields([input.definition])[0];if(typeof input.active!=='boolean')throw new LetterWorkflowError('invalid','active');
 if(definition.sensitive){const [financial]=await tx.execute<{allowed:boolean}>(sql`select app.can_admin_payroll_for(${input.companyId}::uuid) as allowed`);if(!financial?.allowed)throw new LetterWorkflowError('permission');}
 const versions=await tx.select({id:letterMergeFieldVersion.id,ordinal:letterMergeFieldVersion.ordinal}).from(letterMergeFieldVersion).where(and(eq(letterMergeFieldVersion.companyId,input.companyId),eq(letterMergeFieldVersion.key,definition.key))).orderBy(desc(letterMergeFieldVersion.ordinal));
 if(!input.active&&versions.length){const [used]=await tx.select({id:letterTemplate.id}).from(letterTemplateField).innerJoin(letterTemplateVersion,eq(letterTemplateVersion.id,letterTemplateField.templateVersionId)).innerJoin(letterTemplate,eq(letterTemplate.id,letterTemplateVersion.templateId)).where(and(inArray(letterTemplateField.fieldVersionId,versions.map(version=>version.id)),eq(letterTemplate.deactivated,false))).limit(1);if(used)throw new LetterWorkflowError('conflict','fieldInUse');}
 const [saved]=await tx.insert(letterMergeFieldVersion).values({tenantId:ctx.tenantId,companyId:input.companyId,key:definition.key,ordinal:(versions[0]?.ordinal??0)+1,active:input.active,definition,createdBy:ctx.userId!}).returning({id:letterMergeFieldVersion.id,ordinal:letterMergeFieldVersion.ordinal});
 await event(tx,ctx,saved.id,'field.versioned',{companyId:input.companyId,key:definition.key,ordinal:saved.ordinal,active:input.active});return saved;
});}
export function listLetterFields(ctx:SessionContext,input:{companyId:string;after?:string;limit?:number}){return letters(ctx,false,async tx=>{
 await permission(tx,input.companyId,'read');const limit=Math.min(100,Math.max(1,input.limit??50));
 const rows=await tx.selectDistinctOn([letterMergeFieldVersion.key]).from(letterMergeFieldVersion).where(and(eq(letterMergeFieldVersion.companyId,input.companyId),input.after?gt(letterMergeFieldVersion.key,input.after.slice(0,80)):undefined)).orderBy(asc(letterMergeFieldVersion.key),desc(letterMergeFieldVersion.ordinal)).limit(limit+1);
 const [financial]=await tx.execute<{allowed:boolean}>(sql`select app.can_admin_payroll_for(${input.companyId}::uuid) as allowed`);
 return {items:rows.slice(0,limit).filter(row=>!row.definition.sensitive||financial?.allowed),nextCursor:rows.length>limit?rows[limit-1].key:null};
});}
async function templateFields(tx:Tx,ids:string[],co:string):Promise<{id:string;definition:LetterField}[]>{
 if(ids.length>200||ids.some(id=>!UUID.test(id)))throw new LetterWorkflowError('invalid','fields');const unique=[...new Set(ids)];
 const rows=unique.length?await tx.select({id:letterMergeFieldVersion.id,definition:letterMergeFieldVersion.definition}).from(letterMergeFieldVersion).where(and(inArray(letterMergeFieldVersion.id,unique),eq(letterMergeFieldVersion.companyId,co),eq(letterMergeFieldVersion.active,true))):[];
 if(rows.length!==unique.length)throw new LetterWorkflowError('configuration','field');validateLetterFields(rows.map(row=>row.definition));return rows;
}
export function saveLetterTemplate(ctx:SessionContext,input:{companyId:string;templateId?:string;expectedRevision?:number;code:string;name:string;category:string;effectiveFrom:string;document:unknown;fieldVersionIds:string[]}){return letters(ctx,true,async tx=>{
 await permission(tx,input.companyId,'template');await lockCompany(tx,input.companyId);if(!isCalendarDate(input.effectiveFrom))throw new LetterWorkflowError('invalid','effectiveFrom');
 const fields=await templateFields(tx,input.fieldVersionIds,input.companyId),document=validateLetterDocument(input.document,fields.map(row=>row.definition)),used=new Set(usedLetterFields(document));
 let root:typeof letterTemplate.$inferSelect;
 if(input.templateId){const [found]=await tx.select().from(letterTemplate).where(and(eq(letterTemplate.id,uuid(input.templateId)),eq(letterTemplate.companyId,input.companyId))).for('update');if(!found||found.revision!==input.expectedRevision)throw new LetterWorkflowError('stale');root=found;}
 else{[root]=await tx.insert(letterTemplate).values({tenantId:ctx.tenantId,companyId:input.companyId,code:text(input.code,80),createdBy:ctx.userId!}).returning();}
 const [latest]=await tx.select({ordinal:letterTemplateVersion.ordinal}).from(letterTemplateVersion).where(eq(letterTemplateVersion.templateId,root.id)).orderBy(desc(letterTemplateVersion.ordinal)).limit(1);
 const [version]=await tx.insert(letterTemplateVersion).values({tenantId:ctx.tenantId,companyId:input.companyId,templateId:root.id,ordinal:(latest?.ordinal??0)+1,name:text(input.name,200),category:text(input.category,100),document,effectiveFrom:input.effectiveFrom,createdBy:ctx.userId!}).returning();
 const bindings=fields.filter(field=>used.has(field.definition.key));if(bindings.length)await tx.insert(letterTemplateField).values(bindings.map(field=>({tenantId:ctx.tenantId,templateVersionId:version.id,fieldVersionId:field.id})));
 await tx.update(letterTemplate).set({revision:root.revision+1}).where(eq(letterTemplate.id,root.id));
 await event(tx,ctx,root.id,'template.versioned',{companyId:input.companyId,versionId:version.id,ordinal:version.ordinal});return {templateId:root.id,versionId:version.id,revision:root.revision+1};
});}
export function decideLetterTemplate(ctx:SessionContext,input:{versionId:string;expectedStatus:'draft'|'submitted';action:'submit'|'approve'|'reject';reason?:string}){return letters(ctx,true,async tx=>{
 if(!['submit','approve','reject'].includes(input.action))throw new LetterWorkflowError('invalid','action');
 const [version]=await tx.select().from(letterTemplateVersion).where(eq(letterTemplateVersion.id,uuid(input.versionId))).for('update');if(!version)throw new LetterWorkflowError('permission');await permission(tx,version.companyId,'template');
 if(version.status!==input.expectedStatus)throw new LetterWorkflowError('stale');
 const bindings=await tx.select({definition:letterMergeFieldVersion.definition}).from(letterTemplateField).innerJoin(letterMergeFieldVersion,eq(letterMergeFieldVersion.id,letterTemplateField.fieldVersionId)).where(eq(letterTemplateField.templateVersionId,version.id));validateLetterDocument(version.document,bindings.map(row=>row.definition));
 if(input.action!=='submit'&&version.createdBy===ctx.userId)throw new LetterWorkflowError('selfApproval');
 if(input.action==='reject'&&!input.reason?.trim())throw new LetterWorkflowError('reasonRequired');
 const status=input.action==='submit'?'submitted':input.action==='approve'?'approved':'rejected';
 if(input.action==='submit'&&version.status!=='draft'||input.action!=='submit'&&version.status!=='submitted')throw new LetterWorkflowError('state');
 const [saved]=await tx.update(letterTemplateVersion).set({status}).where(eq(letterTemplateVersion.id,version.id)).returning();
 await event(tx,ctx,version.templateId,'template.'+status,{versionId:version.id,reason:input.reason?.trim().slice(0,2000)??null});return saved;
});}
export function setLetterTemplateActive(ctx:SessionContext,input:{templateId:string;expectedRevision:number;active:boolean}){return letters(ctx,true,async tx=>{
 if(typeof input.active!=='boolean')throw new LetterWorkflowError('invalid','active');
 const [root]=await tx.select().from(letterTemplate).where(eq(letterTemplate.id,uuid(input.templateId))).for('update');if(!root)throw new LetterWorkflowError('permission');await permission(tx,root.companyId,'template');if(root.revision!==input.expectedRevision)throw new LetterWorkflowError('stale');
 const [saved]=await tx.update(letterTemplate).set({deactivated:!input.active,revision:root.revision+1}).where(eq(letterTemplate.id,root.id)).returning();await event(tx,ctx,root.id,input.active?'template.activated':'template.deactivated',{revision:saved.revision});return saved;
});}

const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
function calendarDays(day:string,amount:number){const value=new Date(day+'T00:00:00Z');value.setUTCDate(value.getUTCDate()+amount);return value.toISOString().slice(0,10);}
async function generationTemplate(tx:Tx,co:string,id:string,requireActive=true){
 const [version]=await tx.select().from(letterTemplateVersion).innerJoin(letterTemplate,eq(letterTemplate.id,letterTemplateVersion.templateId)).where(and(eq(letterTemplateVersion.id,uuid(id)),eq(letterTemplateVersion.companyId,co),eq(letterTemplateVersion.status,'approved'),requireActive?lte(letterTemplateVersion.effectiveFrom,todayInKualaLumpur()):undefined,requireActive?eq(letterTemplate.deactivated,false):undefined)).limit(1);
 if(!version)throw new LetterWorkflowError('configuration','activeTemplate');
 const fields=await tx.select({id:letterMergeFieldVersion.id,definition:letterMergeFieldVersion.definition}).from(letterTemplateField).innerJoin(letterMergeFieldVersion,eq(letterMergeFieldVersion.id,letterTemplateField.fieldVersionId)).where(eq(letterTemplateField.templateVersionId,id)).orderBy(asc(letterMergeFieldVersion.key));
 validateLetterDocument(version.letter_template_version.document,fields.map(row=>row.definition));return {version:version.letter_template_version,fields,active:!version.letter_template.deactivated&&version.letter_template_version.effectiveFrom<=todayInKualaLumpur()};
}
/** Source dates and compensation selection use the canonical owners. No reader fabricates missing data. */
async function letterSources(tx:Tx,ctx:SessionContext,co:string,employmentId:string,fields:LetterField[],custom:Record<string,LetterValue|null>,referenceDate:string){
 await assertWorkforceEmploymentTx(tx,ctx,uuid(employmentId),'view');
 const [employee]=await tx.select().from(employment).where(and(eq(employment.id,employmentId),eq(employment.companyId,co))).for('share');if(!employee)throw new LetterWorkflowError('permission');
 const [employeePerson]=await tx.select().from(person).where(eq(person.id,employee.personId)).for('share');
 const [entity]=await tx.select().from(company).where(eq(company.id,co)).for('share');if(!employeePerson||!entity)throw new LetterWorkflowError('permission');
 const records=await tx.select().from(assignment).where(and(eq(assignment.employmentId,employmentId),lte(assignment.validFrom,referenceDate),or(isNull(assignment.validTo),gt(assignment.validTo,referenceDate)))).limit(2).for('share');
 if(records.length>1)throw new LetterWorkflowError('configuration','ambiguousAssignment');const current=records[0];
 const [job]=current?.positionId?await tx.select().from(position).where(eq(position.id,current.positionId)).for('share'):[];
 const [team]=current?.departmentId?await tx.select().from(department).where(eq(department.id,current.departmentId)).for('share'):[];
 let salary:typeof compensation.$inferSelect|undefined;
 if(fields.some(field=>field.sensitive)){const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.can_admin_payroll_for(${co}::uuid) as ok`);if(!allowed?.ok)throw new LetterWorkflowError('permission');}
 if(fields.some(field=>field.source==='compensation.basicSalary')){
  const rows=await tx.select().from(compensation).where(and(eq(compensation.employmentId,employmentId),compensationEffectiveOn(referenceDate))).orderBy(desc(compensation.validFrom),asc(compensation.id)).limit(2).for('share');if(rows.length>1)throw new LetterWorkflowError('configuration','ambiguousSalary');salary=rows[0];
 }
 const facts:Record<string,LetterValue|null>={};
 const string=(value:string|null|undefined):LetterValue|null=>value?.trim()?{kind:'text',value}:null;
 const address=[entity.addressLine1,entity.addressLine2,entity.addressLine3,entity.postcode,entity.city,entity.state].filter(value=>value?.trim());
 const source:Record<string,LetterValue|null>={
  'employee.name':string(employeePerson.fullName),'employee.code':string(employee.employeeCode),'employment.hiredOn':employee.hiredOn?{kind:'date',value:employee.hiredOn}:null,
  'employment.jobTitle':string(job?.label?.trim()||job?.description?.trim()||job?.title),'employment.department':string(team?.label?.trim()||team?.description?.trim()||team?.name),
  'company.name':string(entity.legalName),'company.registration':string(entity.registrationNo),'company.address':address.length?string([...address,entity.addressCountry].filter(Boolean).join(', ')):null,
  'compensation.basicSalary':salary?{kind:'currency',value:salary.basicSalary,currency:salary.currency}:null,
 };
 for(const key of Object.keys(custom)){const field=fields.find(field=>field.key===key);if(!field||!field.source.startsWith('custom.'))throw new LetterWorkflowError('invalid','editableField');}
 for(const field of fields)facts[field.key]=field.source.startsWith('custom.')?custom[field.key]??null:source[field.source]??null;
 return {values:facts,employeeName:employeePerson.fullName,employeeCode:employee.employeeCode,referenceDate};
}
async function snapshotLetter(tx:Tx,ctx:SessionContext,co:string,employmentId:string,template:Awaited<ReturnType<typeof generationTemplate>>,policyVersionId:string,custom:Record<string,LetterValue|null>,referenceDate:string){
 const sources=await letterSources(tx,ctx,co,employmentId,template.fields.map(row=>row.definition),custom,referenceDate);
 const rendered=renderLetterDocument(template.version.document,template.fields.map(row=>row.definition),sources.values,{allowSensitive:true});
 const sourceHash=hash(canonical({employmentId,companyId:co,templateVersionId:template.version.id,policyVersionId,referenceDate,values:sources.values,fields:template.fields}));
 return {...sources,document:rendered.document,sourceHash,contentHash:hash(canonical({document:rendered.document,sourceHash}))};
}
async function assertLetterChain(tx:Tx,co:string,policy:ReturnType<typeof validateLetterPolicy>,creator:string){
 for(const stage of policy.stages){
  let eligible=false;
  for(const userId of stage.userIds.filter(id=>id!==creator)){
   const [row]=await tx.execute<{ok:boolean}>(sql`select app.letter_permission_for_user(${userId}::uuid,${co}::uuid,'approve') AND app.letter_permission_for_user(${userId}::uuid,${co}::uuid,'read') as ok`);if(row?.ok)eligible=true;
  }
  if(!eligible)throw new LetterWorkflowError('configuration','approver');
 }
}
async function nextReference(tx:Tx,ctx:SessionContext,format:string,co:string){
 const year=todayInKualaLumpur().slice(0,4);await tx.insert(letterCounter).values({tenantId:ctx.tenantId,year,nextValue:BigInt(1)}).onConflictDoNothing();
 const [counter]=await tx.select().from(letterCounter).where(and(eq(letterCounter.tenantId,ctx.tenantId),eq(letterCounter.year,year))).for('update');if(!counter)throw new LetterWorkflowError('configuration','counter');
 await tx.update(letterCounter).set({nextValue:counter.nextValue+BigInt(1)}).where(and(eq(letterCounter.tenantId,ctx.tenantId),eq(letterCounter.year,year)));
 const [entity]=await tx.select({code:company.companyLabel}).from(company).where(eq(company.id,co));return letterReference(format,{year,companyCode:entity?.code??'',sequence:String(counter.nextValue)});
}
async function newLetterRevision(tx:Tx,ctx:SessionContext,record:typeof letterRecord.$inferSelect,snapshot:Awaited<ReturnType<typeof snapshotLetter>>,custom:Record<string,LetterValue|null>){
 const [last]=await tx.select({ordinal:letterRevision.ordinal}).from(letterRevision).where(eq(letterRevision.letterId,record.id)).orderBy(desc(letterRevision.ordinal)).limit(1);
 const [revision]=await tx.insert(letterRevision).values({tenantId:ctx.tenantId,letterId:record.id,ordinal:(last?.ordinal??0)+1,document:snapshot.document,values:snapshot.values,editableValues:custom,sourceHash:snapshot.sourceHash,contentHash:snapshot.contentHash,createdBy:ctx.userId!}).returning();
 await tx.update(letterRecord).set({currentRevisionId:revision.id,state:'draft',stageIndex:0,lockVersion:record.lockVersion+1}).where(eq(letterRecord.id,record.id));
 await event(tx,ctx,record.id,'revision.created',{revisionId:revision.id,contentHash:revision.contentHash,sourceHash:revision.sourceHash});return revision;
}
export function createLetterDraftBatch(ctx:SessionContext,input:{companyId:string;templateVersionId:string;employmentIds:string[];customValues?:Record<string,Record<string,LetterValue|null>>;operationKey:string}){return letters(ctx,true,async tx=>{
 await permission(tx,input.companyId,'generate');await permission(tx,input.companyId,'read');await lockCompany(tx,input.companyId);uuid(input.operationKey);
 const ids=[...new Set(input.employmentIds.map(uuid))].sort();if(!ids.length||ids.length>500)throw new LetterWorkflowError('invalid','employeeSelection');
 const selection={employmentIds:ids,customValues:input.customValues??{},sourceAsOfDate:todayInKualaLumpur()},inputHash=hash(canonical({employmentIds:ids,customValues:selection.customValues,companyId:input.companyId,templateVersionId:input.templateVersionId}));
 if(Object.keys(selection.customValues).some(id=>!ids.includes(id))||Buffer.byteLength(canonical(selection.customValues),'utf8')>2097152)throw new LetterWorkflowError('invalid','employeeSelection');
 const [existing]=await tx.select().from(letterGenerationBatch).where(and(eq(letterGenerationBatch.createdBy,ctx.userId!),eq(letterGenerationBatch.operationKey,input.operationKey)));if(existing){if(existing.inputHash!==inputHash)throw new LetterWorkflowError('conflict','operationKey');return {batchId:existing.id,alreadyCreated:true};}
 const template=await generationTemplate(tx,input.companyId,input.templateVersionId);
 const [configured]=await tx.select().from(letterPolicyVersion).where(and(eq(letterPolicyVersion.companyId,input.companyId),eq(letterPolicyVersion.category,template.version.category))).orderBy(desc(letterPolicyVersion.ordinal)).limit(1);
 if(!configured?.enabled)throw new LetterWorkflowError('configuration','policy');const policy=validateLetterPolicy(configured.policy);
 await assertLetterChain(tx,input.companyId,policy,ctx.userId!);
 // Validate every selected identity before creating any draft; unknown and foreign identities are identical refusals.
 for(const id of ids){await assertWorkforceEmploymentTx(tx,ctx,id,'view');const [row]=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.id,id),eq(employment.companyId,input.companyId))).for('share');if(!row)throw new LetterWorkflowError('permission');}
 const confidential=template.fields.some(field=>field.definition.sensitive);if(confidential){const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.can_admin_payroll_for(${input.companyId}::uuid) as ok`);if(!allowed?.ok)throw new LetterWorkflowError('permission');}
 const [batch]=await tx.insert(letterGenerationBatch).values({tenantId:ctx.tenantId,companyId:input.companyId,templateVersionId:input.templateVersionId,policyVersionId:configured.id,selection,inputHash,createdBy:ctx.userId!,operationKey:input.operationKey}).returning();
 for(const employmentId of ids){
  const custom=selection.customValues[employmentId]??{},reference=await nextReference(tx,ctx,policy.referenceFormat,input.companyId);
  const [record]=await tx.insert(letterRecord).values({tenantId:ctx.tenantId,companyId:input.companyId,employmentId,batchId:batch.id,reference,createdBy:ctx.userId!,confidential,retainUntil:calendarDays(selection.sourceAsOfDate,policy.retentionDays)}).returning();
  try{const snapshot=await snapshotLetter(tx,ctx,input.companyId,employmentId,template,configured.id,custom,selection.sourceAsOfDate);await newLetterRevision(tx,ctx,record,snapshot,custom);}
  catch(error){if(!(error instanceof LetterModelError)||!['missingField','invalid'].includes(error.code))throw error;await event(tx,ctx,record.id,'draft.validation-failed',{field:error.path,code:error.code});}
 }
 await event(tx,ctx,batch.id,'batch.created',{companyId:input.companyId,templateVersionId:input.templateVersionId,count:ids.length});return {batchId:batch.id,alreadyCreated:false};
});}
export function refreshLetterDraft(ctx:SessionContext,input:{letterId:string;expectedLockVersion:number;customValues?:Record<string,LetterValue|null>}){return letters(ctx,true,async tx=>{
 const [record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(input.letterId))).for('update');if(!record)throw new LetterWorkflowError('permission');await permission(tx,record.companyId,'generate');if(record.lockVersion!==input.expectedLockVersion)throw new LetterWorkflowError('stale');if(!['draft','returned','rejected'].includes(record.state))throw new LetterWorkflowError('state');
 const [batch]=await tx.select().from(letterGenerationBatch).where(eq(letterGenerationBatch.id,record.batchId));const template=await generationTemplate(tx,record.companyId,batch.templateVersionId);
 const [current]=record.currentRevisionId?await tx.select().from(letterRevision).where(eq(letterRevision.id,record.currentRevisionId)):[];
 const custom={...(current?.editableValues??batch.selection.customValues[record.employmentId]??{})};
 for(const [key,value]of Object.entries(input.customValues??{})){const field=template.fields.find(field=>field.definition.key===key)?.definition;if(!field||!field.source.startsWith('custom.')||current&&!field.editable)throw new LetterWorkflowError('invalid','editableField');custom[key]=value;}
 const snapshot=await snapshotLetter(tx,ctx,record.companyId,record.employmentId,template,batch.policyVersionId,custom,batch.selection.sourceAsOfDate);return newLetterRevision(tx,ctx,record,snapshot,custom);
});}
export function getLetterGenerationBatch(ctx:SessionContext,id:string){return letters(ctx,false,async tx=>{
 const [batch]=await tx.select().from(letterGenerationBatch).where(eq(letterGenerationBatch.id,uuid(id)));if(!batch)return null;await permission(tx,batch.companyId,'read');
 const template=await generationTemplate(tx,batch.companyId,batch.templateVersionId,false),records=await tx.select().from(letterRecord).where(eq(letterRecord.batchId,id)).orderBy(asc(letterRecord.reference));
 const rows=[];
 for(const record of records){const [revision]=record.currentRevisionId?await tx.select().from(letterRevision).where(eq(letterRevision.id,record.currentRevisionId)):[];let issue:{code:string;field?:string}|null=null,sourceChanged=false;
  if(['draft','returned','rejected'].includes(record.state))try{const fresh=await snapshotLetter(tx,ctx,batch.companyId,record.employmentId,template,batch.policyVersionId,revision?.editableValues??batch.selection.customValues[record.employmentId]??{},batch.selection.sourceAsOfDate);sourceChanged=revision?.sourceHash!==fresh.sourceHash;}catch(error){if(!(error instanceof LetterModelError)&&!(error instanceof LetterWorkflowError))throw error;issue={code:error.code,...(error instanceof LetterModelError?{field:error.path}:{})};}
  rows.push({record,revision:revision??null,issue,sourceChanged,ready:record.state==='draft'&&Boolean(revision)&&!issue&&!sourceChanged&&template.active});
 }
 return {batch,rows,templateActive:template.active,ready:rows.filter(row=>row.ready).length,needsCorrection:rows.filter(row=>['draft','returned','rejected'].includes(row.record.state)&&!row.ready).length};
});}
async function queueLetterStage(tx:Tx,ctx:SessionContext,record:typeof letterRecord.$inferSelect,policy:ReturnType<typeof validateLetterPolicy>,revisionId:string,stageIndex:number){
 if(!policy.portalNotifications&&!policy.emailNotifications)return;
 for(const userId of policy.stages[stageIndex].userIds.filter(userId=>userId!==record.createdBy)){
  const key=`${record.id}:${revisionId}:stage:${stageIndex}:${userId}`;
  await tx.insert(letterJob).values({tenantId:ctx.tenantId,companyId:record.companyId,letterId:record.id,kind:'notification',recipientUserId:userId,dedupeKey:key,payload:{revisionId,stageIndex,portal:policy.portalNotifications,email:policy.emailNotifications},dueAt:sql`now()`}).onConflictDoNothing();
  await tx.insert(letterJob).values({tenantId:ctx.tenantId,companyId:record.companyId,letterId:record.id,kind:'approvalReminder',recipientUserId:userId,dedupeKey:key+':reminder',payload:{revisionId,stageIndex},dueAt:sql`now()+${policy.reminderHours}*interval '1 hour'`}).onConflictDoNothing();
 }
 if(policy.escalationUserId)await tx.insert(letterJob).values({tenantId:ctx.tenantId,companyId:record.companyId,letterId:record.id,kind:'escalation',recipientUserId:policy.escalationUserId,dedupeKey:`${record.id}:${revisionId}:${stageIndex}:escalation`,payload:{revisionId,stageIndex},dueAt:sql`now()+${policy.approvalDueHours}*interval '1 hour'`}).onConflictDoNothing();
}
export function submitLetterBatch(ctx:SessionContext,id:string){return letters(ctx,true,async tx=>{
 const [batch]=await tx.select().from(letterGenerationBatch).where(eq(letterGenerationBatch.id,uuid(id)));if(!batch)throw new LetterWorkflowError('permission');await permission(tx,batch.companyId,'generate');
 const template=await generationTemplate(tx,batch.companyId,batch.templateVersionId),[configuration]=await tx.select().from(letterPolicyVersion).where(eq(letterPolicyVersion.id,batch.policyVersionId)),policy=validateLetterPolicy(configuration.policy);
 const rows=await tx.select().from(letterRecord).where(eq(letterRecord.batchId,id)).orderBy(asc(letterRecord.id)).for('update');if(!rows.length)throw new LetterWorkflowError('state');
 const selected=rows.filter(row=>row.state!=='withdrawn');if(!selected.length||selected.some(row=>['returned','rejected'].includes(row.state)))throw new LetterWorkflowError('state');const drafts=selected.filter(row=>row.state==='draft');
 for(const row of drafts){await assertLetterChain(tx,batch.companyId,policy,row.createdBy);if(!row.currentRevisionId)throw new LetterWorkflowError('configuration','missingFields');const [revision]=await tx.select().from(letterRevision).where(eq(letterRevision.id,row.currentRevisionId));const fresh=await snapshotLetter(tx,ctx,batch.companyId,row.employmentId,template,batch.policyVersionId,revision.editableValues,batch.selection.sourceAsOfDate);if(fresh.sourceHash!==revision.sourceHash)throw new LetterWorkflowError('stale','sourceChanged');}
 for(const row of drafts){await tx.update(letterRecord).set({state:'submitted',stageIndex:0,lockVersion:row.lockVersion+1}).where(eq(letterRecord.id,row.id));await queueLetterStage(tx,ctx,row,policy,row.currentRevisionId!,0);await event(tx,ctx,row.id,'submitted',{revisionId:row.currentRevisionId});}
 return {batchId:id,submitted:drafts.length,alreadySubmitted:drafts.length===0};
});}
export function withdrawLetterDraft(ctx:SessionContext,input:{letterId:string;expectedLockVersion:number;reason:string}){return letters(ctx,true,async tx=>{
 const [record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(input.letterId))).for('update');if(!record)throw new LetterWorkflowError('permission');await permission(tx,record.companyId,'generate');if(record.lockVersion!==input.expectedLockVersion)throw new LetterWorkflowError('stale');if(['issued','void','withdrawn'].includes(record.state))throw new LetterWorkflowError('state');const reason=text(input.reason,2000);
 await tx.update(letterRecord).set({state:'withdrawn',lockVersion:record.lockVersion+1}).where(eq(letterRecord.id,record.id));await event(tx,ctx,record.id,'withdrawn',{reason,revisionId:record.currentRevisionId});return {letterId:record.id};
});}

const signingCaptions={en:'Approved through authenticated internal approval',ms:'Diluluskan melalui kelulusan dalaman yang disahkan',zh:'经身份验证的内部审批已批准',ta:'அங்கீகரிக்கப்பட்ட உள் ஒப்புதல் மூலம் ஒப்புதல் அளிக்கப்பட்டது',th:'อนุมัติผ่านการอนุมัติภายในที่ยืนยันตัวตนแล้ว',vi:'Được phê duyệt qua quy trình nội bộ đã xác thực'} as const;
/** A decision, sealed bytes and state transition commit together. Any rendering/storage failure rolls all back. */
export function decideLetter(ctx:SessionContext,input:{letterId:string;expectedRevisionId:string;expectedLockVersion:number;decision:LetterStageDecision}){return letters(ctx,true,async tx=>{
 if(!input.decision||!['approve','reject','return'].includes(input.decision.action)||typeof input.decision.comment!=='string'||typeof input.decision.confirmSignature!=='boolean')throw new LetterWorkflowError('invalid','decision');
 const [record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(input.letterId))).for('update');if(!record)throw new LetterWorkflowError('permission');await permission(tx,record.companyId,'read');await permission(tx,record.companyId,'approve');
 if(!record.currentRevisionId)throw new LetterWorkflowError('state');uuid(input.expectedRevisionId);
 const [batch]=await tx.select().from(letterGenerationBatch).where(eq(letterGenerationBatch.id,record.batchId)),[configuration]=await tx.select().from(letterPolicyVersion).where(eq(letterPolicyVersion.id,batch.policyVersionId)),policy=validateLetterPolicy(configuration.policy);
 const [delegation]=await tx.select().from(letterApprovalDecision).where(and(eq(letterApprovalDecision.revisionId,record.currentRevisionId),eq(letterApprovalDecision.stageIndex,record.stageIndex),eq(letterApprovalDecision.action,'delegate'))).orderBy(desc(letterApprovalDecision.createdAt),desc(letterApprovalDecision.id)).limit(1);
 const next=letterStageDecision({...record,revisionId:record.currentRevisionId},policy,{actorId:ctx.userId!,expectedRevisionId:input.expectedRevisionId,expectedLockVersion:input.expectedLockVersion,decision:input.decision,delegatedUserId:delegation?.delegatedTo});
 const [revision]=await tx.select().from(letterRevision).where(eq(letterRevision.id,record.currentRevisionId));
 const [decision]=await tx.insert(letterApprovalDecision).values({tenantId:ctx.tenantId,letterId:record.id,revisionId:revision.id,stageIndex:record.stageIndex,actorId:ctx.userId!,action:input.decision.action,comment:input.decision.comment.trim(),contentHash:revision.contentHash}).returning();
 let artifactId:string|null=null;
 if(next.final){
  const [signer]=await tx.select({name:person.fullName}).from(appUser).innerJoin(person,eq(person.id,appUser.personId)).where(eq(appUser.id,ctx.userId!));if(!signer)throw new LetterWorkflowError('configuration','signatory');
  const [template]=await tx.select().from(letterTemplateVersion).where(eq(letterTemplateVersion.id,batch.templateVersionId));
  async function asset(id:string|null,kind:'signature'|'letterhead'){
   if(!id)return undefined;const [row]=await tx.select().from(letterAsset).where(and(eq(letterAsset.id,id),eq(letterAsset.companyId,record.companyId),eq(letterAsset.kind,kind)));if(!row||kind==='signature'&&row.ownerUserId!==ctx.userId!||hash(row.content)!==row.contentHash)throw new LetterWorkflowError('configuration','asset');return row.content;
  }
  const stamp=await asset(policy.signatureAssetId,'signature'),letterhead=await asset(policy.letterheadAssetId,'letterhead');
  if(policy.signingMode==='stamp'&&!stamp)throw new LetterWorkflowError('configuration','signatureAsset');
  const language=revision.document.language,timestamp=new Intl.DateTimeFormat(language,{dateStyle:'long',timeStyle:'long',timeZone:'Asia/Kuala_Lumpur'}).format(decision.createdAt);
  const rendered=await renderLetterPdf({document:revision.document,reference:record.reference,title:template.name,signature:{name:signer.name,caption:signingCaptions[language],timestamp,stamp},letterhead});
  const bytes=Buffer.from(rendered.bytes);if(bytes.length>10*1024*1024)throw new LetterWorkflowError('configuration','artifactSize');
  const [artifact]=await tx.insert(letterArtifact).values({tenantId:ctx.tenantId,letterId:record.id,revisionId:revision.id,content:bytes,contentHash:hash(bytes),signatoryUserId:ctx.userId!,signingMode:policy.signingMode,authenticityTokenHash:hash(randomBytes(32)),createdAt:decision.createdAt}).returning({id:letterArtifact.id});artifactId=artifact.id;
 }
 await tx.update(letterRecord).set({state:next.state,stageIndex:next.stageIndex,lockVersion:record.lockVersion+1}).where(eq(letterRecord.id,record.id));
 if(next.state==='submitted')await queueLetterStage(tx,ctx,record,policy,revision.id,next.stageIndex);
 await event(tx,ctx,record.id,'approval.'+input.decision.action,{revisionId:revision.id,stageIndex:record.stageIndex,decisionId:decision.id,artifactId,contentHash:revision.contentHash});return {letterId:record.id,state:next.state,lockVersion:record.lockVersion+1,artifactId};
});}

export function delegateLetterApproval(ctx:SessionContext,input:{letterId:string;expectedRevisionId:string;expectedLockVersion:number;delegateUserId:string;reason:string}){return letters(ctx,true,async tx=>{
 const [record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(input.letterId))).for('update');if(!record)throw new LetterWorkflowError('permission');await permission(tx,record.companyId,'approve');await permission(tx,record.companyId,'read');
 if(record.state!=='submitted'||!record.currentRevisionId)throw new LetterWorkflowError('state');if(record.currentRevisionId!==input.expectedRevisionId||record.lockVersion!==input.expectedLockVersion)throw new LetterWorkflowError('stale');
 const reason=text(input.reason,2000),delegate=uuid(input.delegateUserId);if(delegate===record.createdBy||delegate===ctx.userId)throw new LetterWorkflowError('permission');
 const [eligible]=await tx.execute<{ok:boolean}>(sql`select app.letter_permission_for_user(${delegate}::uuid,${record.companyId}::uuid,'read') AND app.letter_permission_for_user(${delegate}::uuid,${record.companyId}::uuid,'approve') as ok`);if(!eligible?.ok)throw new LetterWorkflowError('permission');
 const [revision]=await tx.select().from(letterRevision).where(eq(letterRevision.id,record.currentRevisionId));
 // The database checks the current stage, previous delegation and personally acting final signatory.
 const [decision]=await tx.insert(letterApprovalDecision).values({tenantId:ctx.tenantId,letterId:record.id,revisionId:revision.id,stageIndex:record.stageIndex,actorId:ctx.userId!,action:'delegate',comment:reason,delegatedTo:delegate,contentHash:revision.contentHash}).returning();
 await tx.update(letterRecord).set({lockVersion:record.lockVersion+1}).where(eq(letterRecord.id,record.id));
 await event(tx,ctx,record.id,'approval.delegated',{revisionId:revision.id,stageIndex:record.stageIndex,decisionId:decision.id,delegateUserId:delegate,reason});return {letterId:record.id,lockVersion:record.lockVersion+1};
});}
