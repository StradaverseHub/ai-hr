/** Letters use the existing employee identity, purpose access, document folder and DomainEvent owners. */
import {createHash} from 'node:crypto';
import {and,asc,desc,eq,gt,inArray,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {company,appUser,letterCapabilityGrant,letterAsset,letterPolicyVersion,letterMergeFieldVersion,letterTemplate,letterTemplateVersion,letterTemplateField} from '../db/schema';
import {assertModuleGate} from './module-gate';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {lockPayrollHistoryReadTx} from './payroll-history-lock';
import {isModuleEnabled} from './entitlements';
import {validateLetterFields,validateLetterDocument,usedLetterFields,type LetterField} from '../lib/letter-model';
import {LETTER_CAPABILITIES,validateLetterPolicy,LetterWorkflowError,type LetterCapability} from '../lib/letter-workflow';
import {isCalendarDate} from '../lib/calendar-date';
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
 if(!LETTER_CAPABILITIES.includes(input.capability)||!['hr_admin','super_admin','manager','employee','payroll_partner','perfcomp_partner','operator'].includes(input.role)||typeof input.allowed!=='boolean')throw new LetterWorkflowError('invalid','permission');
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
