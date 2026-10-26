/** Letters use the existing employee identity, purpose access, document folder and DomainEvent owners. */
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {and,asc,desc,eq,gt,gte,inArray,isNull,lte,or,sql,ilike,getTableColumns,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {company,appUser,roleEnum,letterCapabilityGrant,letterAutomationRuleVersion,letterAsset,letterPolicyVersion,letterMergeFieldVersion,letterTemplate,letterTemplateVersion,letterTemplateField,employment,person,assignment,position,department,compensation,letterGenerationBatch,letterRecord,letterRevision,letterCounter,letterJob,letterApprovalDecision,letterArtifact,employeeDocument,letterRecipientEvent,letterAccessToken} from '../db/schema';
import {assertModuleGate} from './module-gate';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {lockPayrollHistoryReadTx} from './payroll-history-lock';
import {isModuleEnabled} from './entitlements';
import {validateLetterFields,validateLetterDocument,usedLetterFields,renderLetterDocument,parseLetterValue,LetterModelError,type LetterField,type LetterValue,type LetterDocument} from '../lib/letter-model';
import {letterDocumentFromEditor} from '../lib/letter-editor';
import {LETTER_CAPABILITIES,validateLetterPolicy,validateLetterTemplatePresentation,LetterWorkflowError,letterReference,letterStageDecision,assertLetterAcknowledgement,type LetterCapability,type LetterStageDecision} from '../lib/letter-workflow';
import {assertLetterNotificationConnection} from './letter-notifications';
import {readLetterAutomationSourcesTx,readRegisteredLetterAutomationSourceTx} from './letter-automation-sources';
import {resolveEntitlementsTx} from './entitlements';
import {letterStageEnteredAt} from './letter-stage-clock';
import {renderLetterPdf} from '../lib/letter-pdf';
import {PDFDocument} from 'pdf-lib';
import {readNotificationEmailTransport,type NotificationEmailTransport} from './notification-email-delivery';
import {letterVerificationUrl,letterVerificationWords} from '../lib/letter-verification';
import {isCalendarDate} from '../lib/calendar-date';
import {todayInKualaLumpur} from '../lib/hr-date';
import {compensationEffectiveOn} from './comp';
import {assertWorkforceCompanyTx,assertWorkforceEmploymentTx} from './workforce-access';
import {listWorkforcePickPageTx,readWorkforcePickRowsTx} from './read';
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
async function anyPermission(tx:Tx,co:string,caps:LetterCapability[]){
 uuid(co);const [row]=await tx.execute<{allowed:boolean}>(sql`select (${sql.join(caps.map(cap=>sql`app.letter_permission(${co}::uuid,${cap})`),sql` OR `)}) as allowed`);if(!row?.allowed)throw new LetterWorkflowError('permission');
}
async function event(tx:Tx,ctx:SessionContext,id:string,type:string,payload:Record<string,unknown>){
 const eventId=randomUUID();await appendEvent(tx,{id:eventId,tenantId:ctx.tenantId,aggregateType:'letter',aggregateId:id,eventType:'letter.'+type,actor:actorOf(ctx),payload});return eventId;
}
async function lockCompany(tx:Tx,co:string){const [row]=await tx.select({id:company.id}).from(company).where(and(eq(company.id,uuid(co)),isNull(company.archivedAt))).for('share');if(!row)throw new LetterWorkflowError('permission');}
export function letterCompanyAccess(ctx:SessionContext){return letters(ctx,false,async tx=>{
 const rows=await tx.select({id:company.id,name:company.legalName,code:company.companyLabel,currency:company.currency,read:sql<boolean>`app.letter_permission(${company.id},'read')`,template:sql<boolean>`app.letter_permission(${company.id},'template')`,generate:sql<boolean>`app.letter_permission(${company.id},'generate')`,approve:sql<boolean>`app.letter_permission(${company.id},'approve')`,issue:sql<boolean>`app.letter_permission(${company.id},'issue')`,report:sql<boolean>`app.letter_permission(${company.id},'report')`,settings:sql<boolean>`app.letter_permission(${company.id},'settings')`}).from(company).where(isNull(company.archivedAt)).orderBy(asc(company.legalName),asc(company.id));
 return rows.filter(row=>LETTER_CAPABILITIES.some(cap=>row[cap]));
});}
/** Pickers expose safe metadata and an explicit cursor; signature bytes never enter template forms. */
export function listLetterTemplateHeads(ctx:SessionContext,input:{companyId:string;search?:string;cursor?:string;limit?:number}){return letters(ctx,false,async tx=>{
 await anyPermission(tx,input.companyId,['read','template','settings']);const limit=letterListLimit(input.limit);if(input.cursor)uuid(input.cursor);const search=input.search?.trim();if(search&&search.length>200)throw new LetterWorkflowError('invalid','search');const needle=search?'%'+search.replace(/[\\%_]/g,'\\$&')+'%':undefined;
 const rows=await tx.select({id:letterAsset.id,name:letterAsset.name}).from(letterAsset).where(and(eq(letterAsset.companyId,input.companyId),eq(letterAsset.kind,'letterhead'),input.cursor?gt(letterAsset.id,input.cursor):undefined,needle?ilike(letterAsset.name,needle):undefined)).orderBy(asc(letterAsset.id)).limit(limit+1);return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null};
});}
export function listLetterEmployeeChoices(ctx:SessionContext,input:{companyId:string;search?:string;cursor?:string;limit?:number;departmentId?:string;departmentSearch?:string;branch?:string;hiredFrom?:string;hiredTo?:string}){return letters(ctx,false,async tx=>{
 await anyPermission(tx,input.companyId,['template','generate']);if(input.cursor)uuid(input.cursor);const limit=letterListLimit(input.limit);if((input.search?.length??0)>200)throw new LetterWorkflowError('invalid','search');
 if(input.departmentId)uuid(input.departmentId);if((input.departmentSearch?.length??0)>200||(input.branch?.length??0)>200||input.hiredFrom&&!isCalendarDate(input.hiredFrom)||input.hiredTo&&!isCalendarDate(input.hiredTo)||input.hiredFrom&&input.hiredTo&&input.hiredFrom>input.hiredTo)throw new LetterWorkflowError('invalid','filters');
 return listWorkforcePickPageTx(ctx,tx,{companyIds:[input.companyId],q:input.search,after:input.cursor,limit,departmentId:input.departmentId,departmentSearch:input.departmentSearch,branch:input.branch,hiredFrom:input.hiredFrom,hiredTo:input.hiredTo});
});}
export function listLetterSignatories(ctx:SessionContext,input:{companyId:string;search?:string;cursor?:string;limit?:number}){return letters(ctx,false,async tx=>{
 await anyPermission(tx,input.companyId,['read','template','settings']);const limit=letterListLimit(input.limit);if(input.cursor)uuid(input.cursor);const search=input.search?.trim();if(search&&search.length>200)throw new LetterWorkflowError('invalid','search');const needle=search?'%'+search.replace(/[\\%_]/g,'\\$&')+'%':null;
 const rows=await tx.execute<{id:string;name:string}>(sql`select * from app.letter_signatory_choices(${input.companyId}::uuid,${input.cursor??null}::uuid,${needle},${limit+1})`);return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null};
});}
export function saveLetterPermission(ctx:SessionContext,input:{companyId:string;capability:LetterCapability;role:string;allowed:boolean;expectedAllowed?:boolean|null}){return letters(ctx,true,async tx=>{
 await permission(tx,input.companyId,'settings');await lockCompany(tx,input.companyId);
 if(!LETTER_CAPABILITIES.includes(input.capability)||!(roleEnum.enumValues as readonly string[]).includes(input.role)||typeof input.allowed!=='boolean')throw new LetterWorkflowError('invalid','permission');
 const [before]=await tx.select().from(letterCapabilityGrant).where(and(eq(letterCapabilityGrant.companyId,input.companyId),eq(letterCapabilityGrant.capability,input.capability),eq(letterCapabilityGrant.role,input.role)));
 if(input.expectedAllowed!==undefined&&input.expectedAllowed!==(before?.allowed??null))throw new LetterWorkflowError('stale','permission');
 const [saved]=await tx.insert(letterCapabilityGrant).values({tenantId:ctx.tenantId,companyId:input.companyId,capability:input.capability,role:input.role,allowed:input.allowed}).onConflictDoUpdate({target:[letterCapabilityGrant.tenantId,letterCapabilityGrant.companyId,letterCapabilityGrant.capability,letterCapabilityGrant.role],set:{allowed:input.allowed}}).returning({id:letterCapabilityGrant.id});
 await event(tx,ctx,saved.id,'permission.changed',{companyId:input.companyId,capability:input.capability,role:input.role,before:before?.allowed??null,allowed:input.allowed});return saved;
});}
export function addLetterAsset(ctx:SessionContext,input:{companyId:string;kind:'letterhead'|'signature';name:string;content:Buffer}){return letters(ctx,true,async tx=>{
 await permission(tx,input.companyId,input.kind==='signature'?'approve':'settings');await lockCompany(tx,input.companyId);
 if(!['letterhead','signature'].includes(input.kind)||input.content.length<24||input.content.length>2097152||input.content.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new LetterWorkflowError('invalid','png');
 const width=input.content.readUInt32BE(16),height=input.content.readUInt32BE(20);if(width<1||height<1||width>2048||height>2048)throw new LetterWorkflowError('invalid','imageSize');
 try{const pdf=await PDFDocument.create();const image=await pdf.embedPng(input.content);if(image.width!==width||image.height!==height)throw new Error('dimensions');}catch{throw new LetterWorkflowError('invalid','png');}
 const [saved]=await tx.insert(letterAsset).values({tenantId:ctx.tenantId,companyId:input.companyId,ownerUserId:ctx.userId!,kind:input.kind,name:text(input.name,200),mimeType:'image/png',content:input.content,contentHash:hash(input.content)}).returning({id:letterAsset.id});
 await event(tx,ctx,saved.id,'asset.created',{companyId:input.companyId,kind:input.kind,contentHash:hash(input.content)});return saved;
});}
export function letterAssetChoices(ctx:SessionContext,co:string){return letters(ctx,false,async tx=>{await permission(tx,co,'settings');return tx.execute<{id:string;name:string;owner_user_id:string;kind:string}>(sql`select * from app.letter_asset_choices(${co}::uuid)`);});}
/** Asset pickers expose names and ownership only. Signature pixels remain an owner-only reader. */
export function listLetterSettingAssets(ctx:SessionContext,input:{companyId:string;kind:'letterhead'|'signature';ownerUserId?:string;cursor?:string;search?:string;limit?:number}){return letters(ctx,false,async tx=>{
 if(!['letterhead','signature'].includes(input.kind))throw new LetterWorkflowError('invalid','asset');uuid(input.companyId);if(input.ownerUserId)uuid(input.ownerUserId);if(input.cursor)uuid(input.cursor);const limit=letterListLimit(input.limit),search=input.search?.trim();if(search&&search.length>200)throw new LetterWorkflowError('invalid','search');
 if(input.kind==='signature'&&input.ownerUserId===ctx.userId)await anyPermission(tx,input.companyId,['settings','approve']);else await permission(tx,input.companyId,'settings');
 const needle=search?'%'+search.replace(/[\\%_]/g,'\\$&')+'%':null;
 const rows=await tx.execute<{id:string;name:string;ownerUserId:string;kind:'letterhead'|'signature';createdAt:Date}>(sql`select id,name,owner_user_id as "ownerUserId",kind,created_at as "createdAt" from app.letter_setting_asset_page(${input.companyId}::uuid,${input.kind},${input.ownerUserId??null}::uuid,${input.cursor??null}::uuid,${needle},${limit+1})`);
 return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null};
});}
export function readLetterAsset(ctx:SessionContext,id:string){return letters(ctx,true,async tx=>{
 const [asset]=await tx.select().from(letterAsset).where(eq(letterAsset.id,uuid(id)));if(!asset)throw new LetterWorkflowError('permission');
 if(asset.kind==='signature'){if(asset.ownerUserId!==ctx.userId)throw new LetterWorkflowError('permission');await permission(tx,asset.companyId,'approve');}else await anyPermission(tx,asset.companyId,['read','template','settings']);
 if(hash(asset.content)!==asset.contentHash)throw new LetterWorkflowError('configuration','assetHash');await event(tx,ctx,asset.id,'asset.viewed',{companyId:asset.companyId,kind:asset.kind,contentHash:asset.contentHash});return {content:asset.content,mimeType:asset.mimeType};
});}
export function saveLetterPolicy(ctx:SessionContext,input:{companyId:string;category:string;enabled:boolean;policy:unknown;expectedOrdinal?:number},options:{transport?:NotificationEmailTransport}={}){return letters(ctx,true,async tx=>{
 await permission(tx,input.companyId,'settings');await lockCompany(tx,input.companyId);const policy=validateLetterPolicy(input.policy),category=text(input.category,100);
 if(typeof input.enabled!=='boolean')throw new LetterWorkflowError('invalid','enabled');
 if(input.enabled)try{letterVerificationUrl('A'.repeat(43),'en');}catch{throw new LetterWorkflowError('configuration','publicOrigin');}
 if(input.enabled){const [entity]=await tx.select({code:company.companyLabel}).from(company).where(eq(company.id,input.companyId));try{if(letterReference(policy.referenceFormat,{year:'2000',companyCode:entity?.code??'',sequence:'999999999999999999'}).length>200)throw new Error('referenceLength');}catch{throw new LetterWorkflowError('configuration','companyCode');}}
 if((policy.portalNotifications||policy.emailNotifications)&&!isModuleEnabled(ctx,'notifications',input.companyId))throw new LetterWorkflowError('configuration','notifications');
 if(policy.emailNotifications){const status=await readNotificationEmailTransport(options.transport);if(status?.ready!==true||status.letters!==true)throw new LetterWorkflowError('configuration','emailTransport');}
 const users=[...new Set(policy.stages.flatMap(stage=>stage.userIds).concat(policy.escalationUserId?[policy.escalationUserId]:[]))];
 for(const userId of users){const [row]=await tx.execute<{ok:boolean}>(sql`select app.letter_permission_for_user(${userId}::uuid,${input.companyId}::uuid,'read') AND app.letter_permission_for_user(${userId}::uuid,${input.companyId}::uuid,'approve') as ok`);if(!row?.ok)throw new LetterWorkflowError('configuration','approver');}
 for(const [id,kind,owner] of [[policy.letterheadAssetId,'letterhead',null],[policy.signatureAssetId,'signature',policy.signatoryUserId]] as const){if(!id)continue;const [row]=await tx.execute<{ok:boolean}>(sql`select app.letter_asset_reference(${input.companyId}::uuid,${id}::uuid,${kind},${owner}::uuid) as ok`);if(!row?.ok)throw new LetterWorkflowError('configuration','asset');}
 const [latest]=await tx.select({ordinal:letterPolicyVersion.ordinal}).from(letterPolicyVersion).where(and(eq(letterPolicyVersion.companyId,input.companyId),eq(letterPolicyVersion.category,category))).orderBy(desc(letterPolicyVersion.ordinal)).limit(1);
 if(input.expectedOrdinal!==undefined&&(!Number.isInteger(input.expectedOrdinal)||input.expectedOrdinal<0||input.expectedOrdinal!==(latest?.ordinal??0)))throw new LetterWorkflowError('stale','policyVersion');
 const [saved]=await tx.insert(letterPolicyVersion).values({tenantId:ctx.tenantId,companyId:input.companyId,category,ordinal:(latest?.ordinal??0)+1,enabled:input.enabled,policy,createdBy:ctx.userId!}).returning({id:letterPolicyVersion.id,ordinal:letterPolicyVersion.ordinal});
 await event(tx,ctx,saved.id,'policy.versioned',{companyId:input.companyId,category,ordinal:saved.ordinal,enabled:input.enabled});return saved;
});}
/** Settings read the latest immutable policy for each category; issued workflows keep their own version. */
export function listLetterPolicies(ctx:SessionContext,input:{companyId:string;cursor?:string;limit?:number}){return letters(ctx,false,async tx=>{
 await permission(tx,input.companyId,'settings');const limit=letterListLimit(input.limit);if(input.cursor)text(input.cursor,100);
 const rows=await tx.select().from(letterPolicyVersion).where(and(eq(letterPolicyVersion.companyId,input.companyId),input.cursor?gt(letterPolicyVersion.category,input.cursor):undefined,sql`${letterPolicyVersion.id}=(select v.id from letter_policy_version v where v.company_id=${input.companyId}::uuid and v.tenant_id=app.current_tenant_id() and v.category=${letterPolicyVersion.category} order by v.ordinal desc limit 1)`)).orderBy(asc(letterPolicyVersion.category)).limit(limit+1);
 return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].category:null};
});}
export function getLetterPolicy(ctx:SessionContext,input:{companyId:string;category:string}){return letters(ctx,false,async tx=>{
 await permission(tx,input.companyId,'settings');const [row]=await tx.select().from(letterPolicyVersion).where(and(eq(letterPolicyVersion.companyId,input.companyId),eq(letterPolicyVersion.category,text(input.category,100)))).orderBy(desc(letterPolicyVersion.ordinal)).limit(1);if(!row)return null;const policy=validateLetterPolicy(row.policy),people=await tx.execute<{id:string;name:string}>(sql`select * from app.letter_policy_people(${row.id}::uuid)`),[appearance]=await tx.execute<{letterhead_name:string|null;signature_name:string|null}>(sql`select * from app.letter_policy_appearance(${row.id}::uuid)`);return {...row,policy,people:Array.from(people,row=>({id:row.id,name:row.name})),appearance:appearance??{letterhead_name:null,signature_name:null}};
});}
export function readLetterSettingsReadiness(ctx:SessionContext,companyId:string,options:{transport?:NotificationEmailTransport}={}){return letters(ctx,false,async tx=>{
 await permission(tx,companyId,'settings');let publicOrigin=true;try{letterVerificationUrl('A'.repeat(43),'en');}catch{publicOrigin=false;}
 const notifications=isModuleEnabled(ctx,'notifications',companyId),status=notifications?await readNotificationEmailTransport(options.transport):null;
 return {publicOrigin,notifications,email:notifications&&status?.ready===true&&status.letters===true};
});}
export function readLetterPermissions(ctx:SessionContext,companyId:string){return letters(ctx,false,async tx=>{
 await permission(tx,companyId,'settings');return tx.select({role:letterCapabilityGrant.role,capability:letterCapabilityGrant.capability,allowed:letterCapabilityGrant.allowed}).from(letterCapabilityGrant).where(eq(letterCapabilityGrant.companyId,companyId)).orderBy(asc(letterCapabilityGrant.role),asc(letterCapabilityGrant.capability));
});}
export function saveLetterField(ctx:SessionContext,input:{companyId:string;definition:unknown;active:boolean;expectedOrdinal?:number}){return letters(ctx,true,async tx=>{
 await permission(tx,input.companyId,'template');await lockCompany(tx,input.companyId);const definition=validateLetterFields([input.definition])[0];if(typeof input.active!=='boolean')throw new LetterWorkflowError('invalid','active');
 if(definition.sensitive){const [financial]=await tx.execute<{allowed:boolean}>(sql`select app.can_admin_payroll_for(${input.companyId}::uuid) as allowed`);if(!financial?.allowed)throw new LetterWorkflowError('permission');}
 const versions=await tx.select({id:letterMergeFieldVersion.id,ordinal:letterMergeFieldVersion.ordinal}).from(letterMergeFieldVersion).where(and(eq(letterMergeFieldVersion.companyId,input.companyId),eq(letterMergeFieldVersion.key,definition.key))).orderBy(desc(letterMergeFieldVersion.ordinal));
 if((input.expectedOrdinal??0)!==(versions[0]?.ordinal??0))throw new LetterWorkflowError('stale','fieldVersion');
 if(!input.active&&versions.length){const [used]=await tx.execute<{used:boolean}>(sql`select app.letter_field_in_use(${input.companyId}::uuid,${definition.key}) as used`);if(used?.used)throw new LetterWorkflowError('conflict','fieldInUse');}
 const [saved]=await tx.insert(letterMergeFieldVersion).values({tenantId:ctx.tenantId,companyId:input.companyId,key:definition.key,ordinal:(versions[0]?.ordinal??0)+1,active:input.active,definition,createdBy:ctx.userId!}).returning({id:letterMergeFieldVersion.id,ordinal:letterMergeFieldVersion.ordinal});
 await event(tx,ctx,saved.id,'field.versioned',{companyId:input.companyId,key:definition.key,ordinal:saved.ordinal,active:input.active});return saved;
});}
export function listLetterFields(ctx:SessionContext,input:{companyId:string;after?:string;limit?:number;search?:string;group?:string}){return letters(ctx,false,async tx=>{
 await anyPermission(tx,input.companyId,['read','template']);const limit=letterListLimit(input.limit??50);
 if(input.group&&!['employee','employment','company','compensation','custom'].includes(input.group))throw new LetterWorkflowError('invalid','group');const search=input.search?.trim();if(search&&search.length>200)throw new LetterWorkflowError('invalid','search');const needle=search?'%'+search.replace(/[\\%_]/g,'\\$&')+'%':undefined;
 const rows=await tx.select().from(letterMergeFieldVersion).where(and(eq(letterMergeFieldVersion.companyId,input.companyId),sql`${letterMergeFieldVersion.id}=app.letter_field_latest_version(${input.companyId}::uuid,${letterMergeFieldVersion.key})`,input.after?gt(letterMergeFieldVersion.key,input.after.slice(0,80)):undefined,needle?or(ilike(letterMergeFieldVersion.key,needle),sql`${letterMergeFieldVersion.definition}->>'label' ilike ${needle}`):undefined,input.group?sql`${letterMergeFieldVersion.definition}->>'source' like ${input.group+'.%'}`:undefined)).orderBy(asc(letterMergeFieldVersion.key)).limit(limit+1);
 const [financial]=await tx.execute<{allowed:boolean}>(sql`select app.can_admin_payroll_for(${input.companyId}::uuid) as allowed`);
 return {items:rows.slice(0,limit).filter(row=>!row.definition.sensitive||financial?.allowed),nextCursor:rows.length>limit?rows[limit-1].key:null};
});}
async function templateFields(tx:Tx,ids:string[],co:string):Promise<{id:string;definition:LetterField}[]>{
 if(ids.length>200||ids.some(id=>!UUID.test(id)))throw new LetterWorkflowError('invalid','fields');const unique=[...new Set(ids)];
 const rows=unique.length?await tx.select({id:letterMergeFieldVersion.id,definition:letterMergeFieldVersion.definition}).from(letterMergeFieldVersion).where(and(inArray(letterMergeFieldVersion.id,unique),eq(letterMergeFieldVersion.companyId,co),eq(letterMergeFieldVersion.active,true),sql`${letterMergeFieldVersion.id}=app.letter_field_latest_version(${co}::uuid,${letterMergeFieldVersion.key})`)):[];
 if(rows.length!==unique.length)throw new LetterWorkflowError('configuration','field');validateLetterFields(rows.map(row=>row.definition));
 if(rows.some(row=>row.definition.sensitive)){const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.can_admin_payroll_for(${co}::uuid) as ok`);if(!allowed?.ok)throw new LetterWorkflowError('permission');}return rows;
}
type LetterTemplateContent={document:unknown;editor?:never;language?:never}|{editor:unknown;language:LetterDocument['language'];document?:never};
export function saveLetterTemplate(ctx:SessionContext,input:{companyId:string;templateId?:string;expectedRevision?:number;code:string;name:string;category:string;effectiveFrom:string;fieldVersionIds:string[];presentation?:unknown;submit?:boolean}&LetterTemplateContent){return letters(ctx,true,async tx=>{
 await permission(tx,input.companyId,'template');await lockCompany(tx,input.companyId);if(!isCalendarDate(input.effectiveFrom))throw new LetterWorkflowError('invalid','effectiveFrom');
 if(('editor' in input&&'document' in input)||(input.submit!==undefined&&typeof input.submit!=='boolean'))throw new LetterWorkflowError('invalid','document');
 const presentation=input.presentation===undefined?null:validateLetterTemplatePresentation(input.presentation);
 if(presentation){
  const [signer]=await tx.execute<{ok:boolean}>(sql`select app.letter_permission_for_user(${presentation.signatoryUserId}::uuid,${input.companyId}::uuid,'read') and app.letter_permission_for_user(${presentation.signatoryUserId}::uuid,${input.companyId}::uuid,'approve') as ok`);if(!signer?.ok)throw new LetterWorkflowError('configuration','signatory');
  if(presentation.letterheadAssetId){const [head]=await tx.select({id:letterAsset.id}).from(letterAsset).where(and(eq(letterAsset.id,presentation.letterheadAssetId),eq(letterAsset.companyId,input.companyId),eq(letterAsset.kind,'letterhead')));if(!head)throw new LetterWorkflowError('configuration','letterhead');}
 }
 const fields=await templateFields(tx,input.fieldVersionIds,input.companyId),definitions=fields.map(row=>row.definition);
 // Resolve editor tokens against fresh scoped mappings inside the same transaction as the version write.
 const document=input.editor!==undefined?letterDocumentFromEditor(input.editor,definitions,input.language!):validateLetterDocument(input.document,definitions),used=new Set(usedLetterFields(document));
 let root:typeof letterTemplate.$inferSelect;
 if(input.templateId){const [found]=await tx.select().from(letterTemplate).where(and(eq(letterTemplate.id,uuid(input.templateId)),eq(letterTemplate.companyId,input.companyId))).for('update');if(!found||found.revision!==input.expectedRevision)throw new LetterWorkflowError('stale');root=found;}
 else{[root]=await tx.insert(letterTemplate).values({tenantId:ctx.tenantId,companyId:input.companyId,code:text(input.code,80),createdBy:ctx.userId!}).returning();}
 const [latest]=await tx.select({ordinal:letterTemplateVersion.ordinal}).from(letterTemplateVersion).where(eq(letterTemplateVersion.templateId,root.id)).orderBy(desc(letterTemplateVersion.ordinal)).limit(1);
 const [version]=await tx.insert(letterTemplateVersion).values({tenantId:ctx.tenantId,companyId:input.companyId,templateId:root.id,ordinal:(latest?.ordinal??0)+1,name:text(input.name,200),category:text(input.category,100),document,presentation,effectiveFrom:input.effectiveFrom,createdBy:ctx.userId!}).returning();
 const bindings=fields.filter(field=>used.has(field.definition.key));if(bindings.length)await tx.insert(letterTemplateField).values(bindings.map(field=>({tenantId:ctx.tenantId,templateVersionId:version.id,fieldVersionId:field.id})));
 await tx.update(letterTemplate).set({revision:root.revision+1}).where(eq(letterTemplate.id,root.id));
 await event(tx,ctx,root.id,'template.versioned',{companyId:input.companyId,versionId:version.id,ordinal:version.ordinal});
 if(input.submit){await tx.update(letterTemplateVersion).set({status:'submitted'}).where(eq(letterTemplateVersion.id,version.id));await event(tx,ctx,root.id,'template.submitted',{versionId:version.id});}
 return {templateId:root.id,versionId:version.id,revision:root.revision+1};
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
async function generationTemplate(tx:Tx,co:string,id:string,requireActive=true,requireLatest=false){
 const [version]=await tx.select().from(letterTemplateVersion).innerJoin(letterTemplate,eq(letterTemplate.id,letterTemplateVersion.templateId)).where(and(eq(letterTemplateVersion.id,uuid(id)),eq(letterTemplateVersion.companyId,co),eq(letterTemplateVersion.status,'approved'),requireActive?lte(letterTemplateVersion.effectiveFrom,todayInKualaLumpur()):undefined,requireActive?eq(letterTemplate.deactivated,false):undefined,requireLatest?sql`not exists(select 1 from letter_template_version n where n.template_id=${letterTemplateVersion.templateId} and n.status='approved' and n.effective_from<=${todayInKualaLumpur()}::date and n.ordinal>${letterTemplateVersion.ordinal})`:undefined)).limit(1);
 if(!version)throw new LetterWorkflowError('configuration','activeTemplate');
 const fields=await tx.select({id:letterMergeFieldVersion.id,definition:letterMergeFieldVersion.definition}).from(letterTemplateField).innerJoin(letterMergeFieldVersion,eq(letterMergeFieldVersion.id,letterTemplateField.fieldVersionId)).where(eq(letterTemplateField.templateVersionId,id)).orderBy(asc(letterMergeFieldVersion.key));
 validateLetterDocument(version.letter_template_version.document,fields.map(row=>row.definition));return {version:version.letter_template_version,fields,active:!version.letter_template.deactivated&&version.letter_template_version.effectiveFrom<=todayInKualaLumpur()};
}
export const LETTER_AUTOMATION_TRIGGERS=['probation_due','confirmation_applied','promotion_applied'] as const;
export type LetterAutomationTrigger=typeof LETTER_AUTOMATION_TRIGGERS[number];
/** Rules delegate draft creation only. Each immutable save records its accountable owner
 * and receives a database-stamped event watermark, so enabling never requests replay. */
export function saveLetterAutomationRule(ctx:SessionContext,input:{companyId:string;templateId:string;trigger:LetterAutomationTrigger;expectedOrdinal:number;enabled:boolean;startOn?:string;customValues?:Record<string,LetterValue|null>}){return letters(ctx,true,async tx=>{
 await permission(tx,input.companyId,'read');await permission(tx,input.companyId,'settings');await lockCompany(tx,input.companyId);uuid(input.templateId);
 if(!LETTER_AUTOMATION_TRIGGERS.includes(input.trigger)||typeof input.enabled!=='boolean'||!Number.isInteger(input.expectedOrdinal)||input.expectedOrdinal<0)throw new LetterWorkflowError('invalid','automation');
 // The shared Letters lock serializes service edits; the insert binding locks and rechecks the root.
 // A Settings author need not also receive permission to edit template wording.
 const [root]=await tx.select().from(letterTemplate).where(and(eq(letterTemplate.id,input.templateId),eq(letterTemplate.companyId,input.companyId)));if(!root)throw new LetterWorkflowError('permission');
 const [previous]=await tx.select().from(letterAutomationRuleVersion).where(and(eq(letterAutomationRuleVersion.companyId,input.companyId),eq(letterAutomationRuleVersion.templateId,input.templateId),eq(letterAutomationRuleVersion.trigger,input.trigger),sql`${letterAutomationRuleVersion.id}=app.letter_automation_latest_version(${input.companyId}::uuid,${input.templateId}::uuid,${input.trigger})`)).limit(1);
 if((previous?.ordinal??0)!==input.expectedOrdinal)throw new LetterWorkflowError('stale','automation');
 const startOn=input.startOn??(input.enabled?todayInKualaLumpur():previous?.startOn??todayInKualaLumpur());if(!isCalendarDate(startOn)||input.enabled&&startOn<todayInKualaLumpur())throw new LetterWorkflowError('invalid','startOn');
 if(input.enabled){await permission(tx,input.companyId,'generate');await assertWorkforceCompanyTx(tx,ctx,input.companyId,'view');}
 if(!input.enabled){
  if(!previous)throw new LetterWorkflowError('state','automation');
  const [saved]=await tx.insert(letterAutomationRuleVersion).values({tenantId:ctx.tenantId,companyId:input.companyId,templateId:input.templateId,trigger:input.trigger,ordinal:input.expectedOrdinal+1,enabled:false,startOn,customValues:previous.customValues,confidential:previous.confidential,createdBy:ctx.userId!}).returning();
  await event(tx,ctx,saved.id,'automation.versioned',{companyId:input.companyId,templateId:input.templateId,trigger:input.trigger,ordinal:saved.ordinal,enabled:false,startOn,afterSequence:saved.afterSequence});return saved;
 }
 const [version]=await tx.select({id:letterTemplateVersion.id}).from(letterTemplateVersion).where(and(eq(letterTemplateVersion.templateId,input.templateId),eq(letterTemplateVersion.status,'approved'),input.enabled?lte(letterTemplateVersion.effectiveFrom,todayInKualaLumpur()):undefined)).orderBy(desc(letterTemplateVersion.ordinal)).limit(1);if(!version)throw new LetterWorkflowError('configuration','activeTemplate');
 const template=await generationTemplate(tx,input.companyId,version.id,input.enabled,input.enabled),fields=template.fields.map(field=>field.definition),supplied=input.customValues??previous?.customValues??{};
 if(!supplied||typeof supplied!=='object'||Array.isArray(supplied)||Object.keys(supplied).length>200)throw new LetterWorkflowError('invalid','customValues');
 const customValues:Record<string,LetterValue|null>={};for(const [key,value]of Object.entries(supplied)){const field=fields.find(field=>field.key===key&&field.source.startsWith('custom.'));if(!field)throw new LetterWorkflowError('invalid','customValues');const parsed=value===null?null:parseLetterValue(value,key);if(parsed&&parsed.kind!==field.kind)throw new LetterWorkflowError('invalid','customValues');customValues[key]=parsed;}
 if(Buffer.byteLength(canonical(customValues),'utf8')>262144)throw new LetterWorkflowError('invalid','customValues');
 const confidential=fields.some(field=>field.sensitive);if(confidential){const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.can_admin_payroll_for(${input.companyId}::uuid) as ok`);if(!allowed?.ok)throw new LetterWorkflowError('permission');}
 if(input.enabled){const [configured]=await tx.select().from(letterPolicyVersion).where(and(eq(letterPolicyVersion.companyId,input.companyId),eq(letterPolicyVersion.category,template.version.category))).orderBy(desc(letterPolicyVersion.ordinal)).limit(1);if(!configured?.enabled)throw new LetterWorkflowError('configuration','policy');const policy=validateLetterPolicy(configured.policy);if(template.version.presentation&&template.version.presentation.signatoryUserId!==policy.signatoryUserId)throw new LetterWorkflowError('configuration','templateSignatory');await assertLetterChain(tx,input.companyId,policy,ctx.userId!,confidential);}
 const [saved]=await tx.insert(letterAutomationRuleVersion).values({tenantId:ctx.tenantId,companyId:input.companyId,templateId:input.templateId,trigger:input.trigger,ordinal:input.expectedOrdinal+1,enabled:input.enabled,startOn,customValues,confidential,createdBy:ctx.userId!}).returning();
 await event(tx,ctx,saved.id,'automation.versioned',{companyId:input.companyId,templateId:input.templateId,trigger:input.trigger,ordinal:saved.ordinal,enabled:input.enabled,startOn,afterSequence:saved.afterSequence});return saved;
});}
export function listLetterAutomationRules(ctx:SessionContext,input:{companyId:string;cursor?:string;limit?:number;history?:boolean}){return letters(ctx,false,async tx=>{
 await permission(tx,input.companyId,'read');await permission(tx,input.companyId,'settings');const limit=letterListLimit(input.limit);if(input.cursor)uuid(input.cursor);if(input.history!==undefined&&typeof input.history!=='boolean')throw new LetterWorkflowError('invalid','history');
 const rows=await tx.select().from(letterAutomationRuleVersion).where(and(eq(letterAutomationRuleVersion.companyId,input.companyId),input.cursor?gt(letterAutomationRuleVersion.id,input.cursor):undefined,input.history?undefined:sql`${letterAutomationRuleVersion.id}=app.letter_automation_latest_version(${input.companyId}::uuid,${letterAutomationRuleVersion.templateId},${letterAutomationRuleVersion.trigger})`)).orderBy(asc(letterAutomationRuleVersion.id)).limit(limit+1);
 return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null};
});}
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
async function assertLetterChain(tx:Tx,co:string,policy:ReturnType<typeof validateLetterPolicy>,creator:string,confidential=false,maintenance=false){
 for(const stage of policy.stages){
  let eligible=false;
  for(const userId of stage.userIds.filter(id=>id!==creator)){
   const [row]=await tx.execute<{ok:boolean}>(maintenance?sql`select app.letter_approver_eligible_at(app.current_tenant_id(),${userId}::uuid,${co}::uuid,${confidential}) as ok`:sql`select app.letter_approver_eligible(${userId}::uuid,${co}::uuid,${confidential}) as ok`);if(row?.ok)eligible=true;
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
async function newLetterRevision(tx:Tx,ctx:SessionContext,record:typeof letterRecord.$inferSelect,snapshot:Awaited<ReturnType<typeof snapshotLetter>>,custom:Record<string,LetterValue|null>,authorId=ctx.userId){
 const [last]=await tx.select({ordinal:letterRevision.ordinal}).from(letterRevision).where(eq(letterRevision.letterId,record.id)).orderBy(desc(letterRevision.ordinal)).limit(1);
 const [revision]=await tx.insert(letterRevision).values({tenantId:ctx.tenantId,letterId:record.id,ordinal:(last?.ordinal??0)+1,document:snapshot.document,values:snapshot.values,editableValues:custom,sourceHash:snapshot.sourceHash,contentHash:snapshot.contentHash,createdBy:authorId!}).returning();
 await tx.update(letterRecord).set({currentRevisionId:revision.id,state:'draft',stageIndex:0,lockVersion:record.lockVersion+1}).where(eq(letterRecord.id,record.id));
 await event(tx,ctx,record.id,'revision.created',{revisionId:revision.id,contentHash:revision.contentHash,sourceHash:revision.sourceHash});return revision;
}
/** The automatic path consumes one immutable, maintenance-registered intent. It
 * reuses the manual snapshot/reference/revision owners and never adopts a human session. */
export async function createAutomaticLetterDraftTx(tx:Tx,ctx:SessionContext,jobId:string){
 if(ctx.userId)throw new LetterWorkflowError('permission');uuid(jobId);await assertLetterNotificationConnection(tx);
 await lockPayrollHistoryReadTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'letters:'+ctx.tenantId},0))`);
 const [locked]=await tx.select().from(letterJob).where(and(eq(letterJob.id,jobId),eq(letterJob.tenantId,ctx.tenantId),eq(letterJob.kind,'eventDraft'))).for('update');if(!locked)throw new LetterWorkflowError('permission');
 const registered=await readRegisteredLetterAutomationSourceTx(tx,ctx,jobId);if(!registered)throw new LetterWorkflowError('permission');const {job,rule,intent}=registered;
 const [existing]=await tx.select({id:letterGenerationBatch.id}).from(letterGenerationBatch).where(and(eq(letterGenerationBatch.tenantId,ctx.tenantId),eq(letterGenerationBatch.operationKey,jobId),eq(letterGenerationBatch.createdBy,rule.createdBy)));if(existing)return {batchId:existing.id,alreadyCreated:true,cancelled:false};
 if(!['queued','failed'].includes(job.status)||job.dueAt.getTime()>Date.now()||job.leaseUntil&&job.leaseUntil.getTime()>Date.now())return {batchId:null,alreadyCreated:false,cancelled:false};
 const current=await readLetterAutomationSourcesTx(tx,ctx,rule.id,{employmentId:intent.employmentId,limit:1});
 if(!registered.current||!current.rule||!current.rows.some(source=>source.sourceFingerprint===intent.sourceFingerprint&&source.sourceKey===intent.sourceKey)){await tx.update(letterJob).set({status:'cancelled',lastError:'sourceChanged',leaseToken:null,leaseUntil:null}).where(eq(letterJob.id,jobId));return {batchId:null,alreadyCreated:false,cancelled:true};}
 const entitlements=await resolveEntitlementsTx(tx,ctx.tenantId),maintenance={...ctx,entitlements};assertModuleGate(maintenance,'employees');
 const [version]=await tx.select({id:letterTemplateVersion.id}).from(letterTemplateVersion).where(and(eq(letterTemplateVersion.tenantId,ctx.tenantId),eq(letterTemplateVersion.templateId,rule.templateId),eq(letterTemplateVersion.status,'approved'),lte(letterTemplateVersion.effectiveFrom,todayInKualaLumpur()))).orderBy(desc(letterTemplateVersion.ordinal)).limit(1);if(!version)throw new LetterWorkflowError('configuration','activeTemplate');
 const template=await generationTemplate(tx,rule.companyId,version.id,true,true),confidential=template.fields.some(field=>field.definition.sensitive);
 const [authority]=await tx.execute<{ok:boolean}>(sql`select app.letter_automation_owner_eligible_at(${ctx.tenantId}::uuid,${rule.createdBy}::uuid,${rule.companyId}::uuid,${confidential}) as ok`);if(!authority?.ok)throw new LetterWorkflowError('permission');
 const [configured]=await tx.select().from(letterPolicyVersion).where(and(eq(letterPolicyVersion.tenantId,ctx.tenantId),eq(letterPolicyVersion.companyId,rule.companyId),eq(letterPolicyVersion.category,template.version.category))).orderBy(desc(letterPolicyVersion.ordinal)).limit(1);if(!configured?.enabled)throw new LetterWorkflowError('configuration','policy');const policy=validateLetterPolicy(configured.policy);
 if(template.version.presentation&&template.version.presentation.signatoryUserId!==policy.signatoryUserId)throw new LetterWorkflowError('configuration','templateSignatory');await assertLetterChain(tx,rule.companyId,policy,rule.createdBy,confidential,true);
 await tx.update(letterJob).set({leaseToken:randomUUID(),leaseUntil:sql`now()+interval '2 minutes'`}).where(eq(letterJob.id,jobId));
 const selection={employmentIds:[intent.employmentId],customValues:{[intent.employmentId]:rule.customValues},sourceAsOfDate:intent.sourceAsOfDate};
 const [batch]=await tx.insert(letterGenerationBatch).values({id:intent.batchId,tenantId:ctx.tenantId,companyId:rule.companyId,templateVersionId:version.id,policyVersionId:configured.id,selection,inputHash:hash(canonical({ruleVersionId:rule.id,sourceFingerprint:intent.sourceFingerprint,templateVersionId:version.id,policyVersionId:configured.id,selection})),createdBy:rule.createdBy,operationKey:jobId,sourceEventId:job.sourceEventId}).returning();
 const reference=await nextReference(tx,maintenance,policy.referenceFormat,rule.companyId),[record]=await tx.insert(letterRecord).values({tenantId:ctx.tenantId,companyId:rule.companyId,employmentId:intent.employmentId,batchId:batch.id,reference,createdBy:rule.createdBy,confidential,retainUntil:calendarDays(intent.sourceAsOfDate,policy.retentionDays)}).returning();
 try{const snapshot=await snapshotLetter(tx,maintenance,rule.companyId,intent.employmentId,template,configured.id,rule.customValues,intent.sourceAsOfDate);await newLetterRevision(tx,maintenance,record,snapshot,rule.customValues,rule.createdBy);}catch(error){if(!(error instanceof LetterModelError)||!['missingField','invalid'].includes(error.code))throw error;await event(tx,ctx,record.id,'draft.validation-failed',{field:error.path,code:error.code});}
 await event(tx,ctx,record.id,'automation.source-bound',{ruleVersionId:rule.id,jobId,sourceEventId:job.sourceEventId,sourceFingerprint:intent.sourceFingerprint,responsibleUserId:rule.createdBy});
 await event(tx,ctx,batch.id,'automation.drafted',{companyId:rule.companyId,ruleVersionId:rule.id,jobId,letterId:record.id,sourceEventId:job.sourceEventId,sourceFingerprint:intent.sourceFingerprint,responsibleUserId:rule.createdBy});
 await tx.update(letterJob).set({status:'completed',attempts:job.attempts+1,lastError:null,leaseToken:null,leaseUntil:null}).where(eq(letterJob.id,jobId));return {batchId:batch.id,alreadyCreated:false,cancelled:false};
}
export function createLetterDraftBatch(ctx:SessionContext,input:{companyId:string;templateVersionId:string;employmentIds:string[];customValues?:Record<string,Record<string,LetterValue|null>>;operationKey:string;reissueOf?:string}){return letters(ctx,true,async tx=>{
 await permission(tx,input.companyId,'generate');await permission(tx,input.companyId,'read');await lockCompany(tx,input.companyId);uuid(input.operationKey);
 const ids=[...new Set(input.employmentIds.map(uuid))].sort();if(!ids.length||ids.length>500)throw new LetterWorkflowError('invalid','employeeSelection');
 if(input.reissueOf){await permission(tx,input.companyId,'issue');const [original]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(input.reissueOf))).for('share');if(!original||original.companyId!==input.companyId||ids.length!==1||original.employmentId!==ids[0])throw new LetterWorkflowError('permission');if(!['issued','void'].includes(original.state))throw new LetterWorkflowError('state');}
 const selection={employmentIds:ids,customValues:input.customValues??{},sourceAsOfDate:todayInKualaLumpur()},inputHash=hash(canonical({employmentIds:ids,customValues:selection.customValues,companyId:input.companyId,templateVersionId:input.templateVersionId,reissueOf:input.reissueOf??null}));
 if(Object.keys(selection.customValues).some(id=>!ids.includes(id))||Buffer.byteLength(canonical(selection.customValues),'utf8')>2097152)throw new LetterWorkflowError('invalid','employeeSelection');
 const [existing]=await tx.select().from(letterGenerationBatch).where(and(eq(letterGenerationBatch.createdBy,ctx.userId!),eq(letterGenerationBatch.operationKey,input.operationKey)));if(existing){if(existing.inputHash!==inputHash)throw new LetterWorkflowError('conflict','operationKey');return {batchId:existing.id,alreadyCreated:true};}
 const template=await generationTemplate(tx,input.companyId,input.templateVersionId,true,true);
 const [configured]=await tx.select().from(letterPolicyVersion).where(and(eq(letterPolicyVersion.companyId,input.companyId),eq(letterPolicyVersion.category,template.version.category))).orderBy(desc(letterPolicyVersion.ordinal)).limit(1);
 if(!configured?.enabled)throw new LetterWorkflowError('configuration','policy');const policy=validateLetterPolicy(configured.policy);
 if(template.version.presentation&&template.version.presentation.signatoryUserId!==policy.signatoryUserId)throw new LetterWorkflowError('configuration','templateSignatory');
 await assertLetterChain(tx,input.companyId,policy,ctx.userId!,template.fields.some(field=>field.definition.sensitive));
 // Validate every selected identity before creating any draft; unknown and foreign identities are identical refusals.
 for(const id of ids){await assertWorkforceEmploymentTx(tx,ctx,id,'view');const [row]=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.id,id),eq(employment.companyId,input.companyId))).for('share');if(!row)throw new LetterWorkflowError('permission');}
 const confidential=template.fields.some(field=>field.definition.sensitive);if(confidential){const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.can_admin_payroll_for(${input.companyId}::uuid) as ok`);if(!allowed?.ok)throw new LetterWorkflowError('permission');}
 const [batch]=await tx.insert(letterGenerationBatch).values({tenantId:ctx.tenantId,companyId:input.companyId,templateVersionId:input.templateVersionId,policyVersionId:configured.id,selection,inputHash,createdBy:ctx.userId!,operationKey:input.operationKey}).returning();
 for(const employmentId of ids){
  const custom=selection.customValues[employmentId]??{},reference=await nextReference(tx,ctx,policy.referenceFormat,input.companyId);
  const [record]=await tx.insert(letterRecord).values({tenantId:ctx.tenantId,companyId:input.companyId,employmentId,batchId:batch.id,reference,createdBy:ctx.userId!,confidential,retainUntil:calendarDays(selection.sourceAsOfDate,policy.retentionDays),originalLetterId:input.reissueOf??null}).returning();
  if(input.reissueOf)await event(tx,ctx,record.id,'reissue.drafted',{originalLetterId:input.reissueOf,batchId:batch.id});
  try{const snapshot=await snapshotLetter(tx,ctx,input.companyId,employmentId,template,configured.id,custom,selection.sourceAsOfDate);await newLetterRevision(tx,ctx,record,snapshot,custom);}
  catch(error){if(!(error instanceof LetterModelError)||!['missingField','invalid'].includes(error.code))throw error;await event(tx,ctx,record.id,'draft.validation-failed',{field:error.path,code:error.code});}
 }
 await event(tx,ctx,batch.id,'batch.created',{companyId:input.companyId,templateVersionId:input.templateVersionId,count:ids.length});return {batchId:batch.id,alreadyCreated:false};
});}
export function refreshLetterDraft(ctx:SessionContext,input:{letterId:string;expectedLockVersion:number;customValues?:Record<string,LetterValue|null>}){return letters(ctx,true,async tx=>{
 const [record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(input.letterId))).for('update');if(!record)throw new LetterWorkflowError('permission');await permission(tx,record.companyId,'generate');if(record.lockVersion!==input.expectedLockVersion)throw new LetterWorkflowError('stale');if(!['draft','returned','rejected'].includes(record.state))throw new LetterWorkflowError('state');
 const [batch]=await tx.select().from(letterGenerationBatch).where(eq(letterGenerationBatch.id,record.batchId));if(!batch)throw new LetterWorkflowError('permission');const template=await generationTemplate(tx,record.companyId,batch.templateVersionId);
 const [current]=record.currentRevisionId?await tx.select().from(letterRevision).where(eq(letterRevision.id,record.currentRevisionId)):[];
 const custom={...(current?.editableValues??batch.selection.customValues[record.employmentId]??{})};
 for(const [key,value]of Object.entries(input.customValues??{})){const field=template.fields.find(field=>field.definition.key===key)?.definition;if(!field||!field.source.startsWith('custom.')||current&&!field.editable)throw new LetterWorkflowError('invalid','editableField');custom[key]=value;}
 const snapshot=await snapshotLetter(tx,ctx,record.companyId,record.employmentId,template,batch.policyVersionId,custom,batch.selection.sourceAsOfDate);return newLetterRevision(tx,ctx,record,snapshot,custom);
});}
function assertLetterBatchCohort(batch:typeof letterGenerationBatch.$inferSelect,records:(typeof letterRecord.$inferSelect)[]){
 const ids=batch.selection.employmentIds;
 if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!UUID.test(id)))throw new LetterWorkflowError('configuration','batchSelection');
 const expected=new Set(ids.map(id=>id.toLowerCase())),actual=new Set(records.map(row=>row.employmentId));
 if(!ids.length||expected.size!==ids.length||actual.size!==records.length||records.length!==ids.length||records.some(row=>!expected.has(row.employmentId)))throw new LetterWorkflowError('permission');
}
/** A displayed page never narrows the cohort checked for readiness or submission. */
export function getLetterGenerationBatch(ctx:SessionContext,id:string,input:{cursor?:string;limit?:number}={}){return letters(ctx,false,async tx=>{
 const [batch]=await tx.select().from(letterGenerationBatch).where(eq(letterGenerationBatch.id,uuid(id)));if(!batch){const [participant]=await tx.select({id:letterRecord.id}).from(letterRecord).where(eq(letterRecord.batchId,id)).limit(1);if(participant)throw new LetterWorkflowError('permission');return null;}await permission(tx,batch.companyId,'read');const limit=letterListLimit(input.limit);if(input.cursor)uuid(input.cursor);
 const template=await generationTemplate(tx,batch.companyId,batch.templateVersionId,false),records=await tx.select().from(letterRecord).where(eq(letterRecord.batchId,id)).orderBy(asc(letterRecord.reference),asc(letterRecord.id));assertLetterBatchCohort(batch,records);
 const cursor=input.cursor?records.findIndex(row=>row.id===input.cursor):-1;if(input.cursor&&cursor<0)throw new LetterWorkflowError('invalid','cursor');const start=cursor+1,end=start+limit;
 const rows=[];let ready=0,needsCorrection=0;const states:Record<string,number>={};
 for(const [index,record]of records.entries()){
  const [revision]=record.currentRevisionId?await tx.select().from(letterRevision).where(eq(letterRevision.id,record.currentRevisionId)):[];let issue:{code:string;field?:string}|null=null,sourceChanged=false;
  if(['draft','returned','rejected'].includes(record.state))try{const fresh=await snapshotLetter(tx,ctx,batch.companyId,record.employmentId,template,batch.policyVersionId,revision?.editableValues??batch.selection.customValues[record.employmentId]??{},batch.selection.sourceAsOfDate);sourceChanged=revision?.sourceHash!==fresh.sourceHash;}catch(error){if(!(error instanceof LetterModelError)&&!(error instanceof LetterWorkflowError))throw error;issue={code:error.code,...(error instanceof LetterModelError?{field:error.path}:{})};}
  const eligible=record.state==='draft'&&Boolean(revision)&&!issue&&!sourceChanged&&template.active;states[record.state]=(states[record.state]??0)+1;if(eligible)ready++;if(['draft','returned','rejected'].includes(record.state)&&!eligible)needsCorrection++;
  if(index>=start&&index<end)rows.push({record,revision:revision??null,issue,sourceChanged,ready:eligible});
 }
 const identities=await readWorkforcePickRowsTx(ctx,tx,rows.map(row=>row.record.employmentId)),people=new Map(identities.map(row=>[row.employmentId,{name:row.name,code:row.employeeCode}]));
 const correctionIds=rows.filter(row=>row.record.state==='returned'||row.record.state==='rejected').map(row=>row.record.id),decisions=correctionIds.length?await tx.selectDistinctOn([letterApprovalDecision.letterId],{letterId:letterApprovalDecision.letterId,reason:letterApprovalDecision.comment}).from(letterApprovalDecision).innerJoin(letterRecord,and(eq(letterRecord.id,letterApprovalDecision.letterId),eq(letterRecord.currentRevisionId,letterApprovalDecision.revisionId))).where(and(eq(letterRecord.batchId,batch.id),inArray(letterApprovalDecision.letterId,correctionIds),inArray(letterApprovalDecision.action,['return','reject']))).orderBy(asc(letterApprovalDecision.letterId),desc(letterApprovalDecision.createdAt),desc(letterApprovalDecision.id)):[],reasons=new Map(decisions.map(decision=>[decision.letterId,decision.reason]));
 return {batch,rows:rows.map(row=>({...row,employee:people.get(row.record.employmentId)??null,correctionReason:reasons.get(row.record.id)??null})),templateActive:template.active,ready,needsCorrection,total:records.length,selected:records.length-(states.withdrawn??0),states,nextCursor:end<records.length?records[end-1].id:null};
});}
export function listLetterGenerationBatches(ctx:SessionContext,input:{companyId:string;cursor?:string;limit?:number}){return letters(ctx,false,async tx=>{
 await permission(tx,input.companyId,'read');await permission(tx,input.companyId,'generate');const limit=letterListLimit(input.limit);if(input.cursor)uuid(input.cursor);
 const visible=and(eq(letterGenerationBatch.companyId,input.companyId),eq(letterGenerationBatch.createdBy,ctx.userId!),sql`(select count(*) from letter_record r where r.batch_id=${letterGenerationBatch.id})=case when jsonb_typeof(${letterGenerationBatch.selection}->'employmentIds')='array' then jsonb_array_length(${letterGenerationBatch.selection}->'employmentIds') else -1 end`);
 const [cursor]=input.cursor?await tx.select({id:letterGenerationBatch.id}).from(letterGenerationBatch).where(and(visible,eq(letterGenerationBatch.id,input.cursor))).limit(1):[];if(input.cursor&&!cursor)throw new LetterWorkflowError('invalid','cursor');
 const rows=await tx.select({id:letterGenerationBatch.id,createdAt:letterGenerationBatch.createdAt,templateVersionId:letterTemplateVersion.id,title:letterTemplateVersion.name,category:letterTemplateVersion.category,
  total:sql<number>`(select count(*)::integer from letter_record r where r.batch_id=${letterGenerationBatch.id} and r.state<>'withdrawn')`,
  drafts:sql<number>`(select count(*)::integer from letter_record r where r.batch_id=${letterGenerationBatch.id} and r.state in ('draft','returned','rejected'))`
 }).from(letterGenerationBatch).innerJoin(letterTemplateVersion,eq(letterTemplateVersion.id,letterGenerationBatch.templateVersionId)).where(and(visible,cursor?sql`(${letterGenerationBatch.createdAt},${letterGenerationBatch.id})<(select batch_cursor.created_at,batch_cursor.id from letter_generation_batch batch_cursor where batch_cursor.id=${input.cursor}::uuid)`:undefined)).orderBy(desc(letterGenerationBatch.createdAt),desc(letterGenerationBatch.id)).limit(limit+1);
 return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null};
});}

// Pending work follows the frozen revision and current stage. Completed delivery history stays intact.
async function cancelLetterStageJobs(tx:Tx,letterId:string,revisionId:string,stageIndex:number){
 await tx.update(letterJob).set({status:'cancelled',leaseToken:null,leaseUntil:null}).where(and(eq(letterJob.letterId,letterId),inArray(letterJob.status,['queued','failed']),inArray(letterJob.kind,['notification','approvalReminder','escalation']),sql`${letterJob.payload}->>'revisionId'=${revisionId}`,sql`${letterJob.payload}->>'stageIndex'=${String(stageIndex)}`));
}
async function queueLetterStage(tx:Tx,ctx:SessionContext,record:typeof letterRecord.$inferSelect,policy:ReturnType<typeof validateLetterPolicy>,revisionId:string,stageIndex:number,sourceEventId:string,delegation?:{userId:string;decisionId:string}){
 if(!policy.portalNotifications&&!policy.emailNotifications)return;
 const enteredAt=sql`(select ${letterStageEnteredAt(sql`stage_record.stage_index`,sql`stage_record.submitted_at`,sql`stage_record.current_revision_id`)} from letter_record stage_record where stage_record.id=${record.id}::uuid)`;
 const audience=delegation?[delegation.userId]:policy.stages[stageIndex].userIds;
 for(const userId of audience.filter(userId=>userId!==record.createdBy)){
  const [eligible]=await tx.execute<{ok:boolean}>(sql`select app.letter_approver_eligible(${userId}::uuid,${record.companyId}::uuid,${record.confidential}) as ok`);if(!eligible?.ok)continue;
  const key=`${record.id}:${revisionId}:stage:${stageIndex}:${userId}${delegation?':delegation:'+delegation.decisionId:''}`;
  const payload={revisionId,stageIndex,portal:policy.portalNotifications,email:policy.emailNotifications};
  await tx.insert(letterJob).values({tenantId:ctx.tenantId,companyId:record.companyId,letterId:record.id,sourceEventId,kind:'notification',recipientUserId:userId,dedupeKey:key,payload,dueAt:sql`now()`}).onConflictDoNothing();
  await tx.insert(letterJob).values({tenantId:ctx.tenantId,companyId:record.companyId,letterId:record.id,sourceEventId,kind:'approvalReminder',recipientUserId:userId,dedupeKey:key+':reminder',payload,dueAt:sql`${enteredAt}+${policy.reminderHours}*interval '1 hour'`}).onConflictDoNothing();
 }
 if(policy.escalationUserId){
  const [eligible]=await tx.execute<{ok:boolean}>(sql`select app.letter_approver_eligible(${policy.escalationUserId}::uuid,${record.companyId}::uuid,${record.confidential}) as ok`);
  if(eligible?.ok)await tx.insert(letterJob).values({tenantId:ctx.tenantId,companyId:record.companyId,letterId:record.id,sourceEventId,kind:'escalation',recipientUserId:policy.escalationUserId,dedupeKey:`${record.id}:${revisionId}:${stageIndex}:escalation${delegation?':delegation:'+delegation.decisionId:''}`,payload:{revisionId,stageIndex,portal:policy.portalNotifications,email:policy.emailNotifications},dueAt:sql`${enteredAt}+${policy.approvalDueHours}*interval '1 hour'`}).onConflictDoNothing();
 }
}
async function queueLetterCreator(tx:Tx,ctx:SessionContext,record:typeof letterRecord.$inferSelect,policy:ReturnType<typeof validateLetterPolicy>,revisionId:string,decisionId:string,outcome:'returned'|'rejected'|'approved',sourceEventId:string){
 if(!policy.portalNotifications&&!policy.emailNotifications)return;
 const [eligible]=await tx.execute<{ok:boolean}>(sql`select app.letter_creator_eligible(${record.createdBy}::uuid,${record.companyId}::uuid,${record.confidential}) as ok`);if(!eligible?.ok)return;
 await tx.insert(letterJob).values({tenantId:ctx.tenantId,companyId:record.companyId,letterId:record.id,sourceEventId,recipientUserId:record.createdBy,kind:'notification',dedupeKey:`${record.id}:${revisionId}:creator:${decisionId}`,payload:{purpose:'creatorDecision',outcome,revisionId,decisionId,portal:policy.portalNotifications,email:policy.emailNotifications},dueAt:sql`now()`}).onConflictDoNothing();
}
export function submitLetterBatch(ctx:SessionContext,id:string){return letters(ctx,true,async tx=>{
 const [batch]=await tx.select().from(letterGenerationBatch).where(eq(letterGenerationBatch.id,uuid(id)));if(!batch)throw new LetterWorkflowError('permission');await permission(tx,batch.companyId,'generate');
 const template=await generationTemplate(tx,batch.companyId,batch.templateVersionId),[configuration]=await tx.select().from(letterPolicyVersion).where(eq(letterPolicyVersion.id,batch.policyVersionId)),policy=validateLetterPolicy(configuration.policy);
 const rows=await tx.select().from(letterRecord).where(eq(letterRecord.batchId,id)).orderBy(asc(letterRecord.id)).for('update');if(!rows.length)throw new LetterWorkflowError('state');assertLetterBatchCohort(batch,rows);
 const selected=rows.filter(row=>row.state!=='withdrawn');if(!selected.length||selected.some(row=>['returned','rejected'].includes(row.state)))throw new LetterWorkflowError('state');const drafts=selected.filter(row=>row.state==='draft');
 for(const row of drafts){await assertLetterChain(tx,batch.companyId,policy,row.createdBy,row.confidential);if(!row.currentRevisionId)throw new LetterWorkflowError('configuration','missingFields');const [revision]=await tx.select().from(letterRevision).where(eq(letterRevision.id,row.currentRevisionId));const fresh=await snapshotLetter(tx,ctx,batch.companyId,row.employmentId,template,batch.policyVersionId,revision.editableValues,batch.selection.sourceAsOfDate);if(fresh.sourceHash!==revision.sourceHash)throw new LetterWorkflowError('stale','sourceChanged');}
 for(const row of drafts){await tx.update(letterRecord).set({state:'submitted',stageIndex:0,lockVersion:row.lockVersion+1}).where(eq(letterRecord.id,row.id));const sourceEventId=await event(tx,ctx,row.id,'submitted',{revisionId:row.currentRevisionId});await queueLetterStage(tx,ctx,row,policy,row.currentRevisionId!,0,sourceEventId);}
 return {batchId:id,submitted:drafts.length,alreadySubmitted:drafts.length===0};
});}
export function withdrawLetterDraft(ctx:SessionContext,input:{letterId:string;expectedLockVersion:number;reason:string}){return letters(ctx,true,async tx=>{
 const [record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(input.letterId))).for('update');if(!record)throw new LetterWorkflowError('permission');await permission(tx,record.companyId,'generate');if(record.lockVersion!==input.expectedLockVersion)throw new LetterWorkflowError('stale');if(['issued','void','withdrawn'].includes(record.state))throw new LetterWorkflowError('state');const reason=text(input.reason,2000);
 if(record.currentRevisionId)await cancelLetterStageJobs(tx,record.id,record.currentRevisionId,record.stageIndex);
 await tx.update(letterRecord).set({state:'withdrawn',lockVersion:record.lockVersion+1}).where(eq(letterRecord.id,record.id));await event(tx,ctx,record.id,'withdrawn',{reason,revisionId:record.currentRevisionId});return {letterId:record.id};
});}

const signingCaptions={en:'Approved through authenticated internal approval',ms:'Diluluskan melalui kelulusan dalaman yang disahkan',zh:'经身份验证的内部审批已批准',ta:'அங்கீகரிக்கப்பட்ட உள் ஒப்புதல் மூலம் ஒப்புதல் அளிக்கப்பட்டது',th:'อนุมัติผ่านการอนุมัติภายในที่ยืนยันตัวตนแล้ว',vi:'Được phê duyệt qua quy trình nội bộ đã xác thực'} as const;
/** A decision, sealed bytes and state transition commit together. Any rendering/storage failure rolls all back. */
type LetterDecisionInput={letterId:string;expectedRevisionId:string;expectedLockVersion:number;decision:LetterStageDecision};
export function decideLetter(ctx:SessionContext,input:LetterDecisionInput){return letters(ctx,true,tx=>decideLetterTx(ctx,tx,input));}
async function decideLetterTx(ctx:SessionContext,tx:Tx,input:LetterDecisionInput){
 if(!input.decision||!['approve','reject','return'].includes(input.decision.action)||typeof input.decision.comment!=='string'||typeof input.decision.confirmSignature!=='boolean')throw new LetterWorkflowError('invalid','decision');
 const [record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(input.letterId))).for('update');if(!record)throw new LetterWorkflowError('permission');await permission(tx,record.companyId,'read');await permission(tx,record.companyId,'approve');
 if(!record.currentRevisionId)throw new LetterWorkflowError('state');uuid(input.expectedRevisionId);
 const batch=await staffBatchTx(tx,record.id),[configuration]=await tx.select().from(letterPolicyVersion).where(eq(letterPolicyVersion.id,batch.policyVersionId)),policy=validateLetterPolicy(configuration.policy);
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
  const stamp=await asset(policy.signatureAssetId,'signature'),letterhead=await asset(template.presentation?template.presentation.letterheadAssetId:policy.letterheadAssetId,'letterhead');
  if(policy.signingMode==='stamp'&&!stamp)throw new LetterWorkflowError('configuration','signatureAsset');
  const language=revision.document.language,timestamp=new Intl.DateTimeFormat(language,{dateStyle:'long',timeStyle:'long',timeZone:'Asia/Kuala_Lumpur'}).format(decision.createdAt);
  const verificationToken=randomBytes(32).toString('base64url'),verificationUrl=letterVerificationUrl(verificationToken,language);
  const rendered=await renderLetterPdf({document:revision.document,reference:record.reference,title:template.name,signature:{name:signer.name,caption:signingCaptions[language],timestamp,stamp},letterhead,verification:{url:verificationUrl,caption:letterVerificationWords[language].caption}});
  const bytes=Buffer.from(rendered.bytes);if(bytes.length>10*1024*1024)throw new LetterWorkflowError('configuration','artifactSize');
  const [artifact]=await tx.insert(letterArtifact).values({tenantId:ctx.tenantId,letterId:record.id,revisionId:revision.id,content:bytes,contentHash:hash(bytes),signatoryUserId:ctx.userId!,signingMode:policy.signingMode,authenticityTokenHash:hash(verificationToken),createdAt:decision.createdAt}).returning({id:letterArtifact.id});artifactId=artifact.id;
 }
 await cancelLetterStageJobs(tx,record.id,revision.id,record.stageIndex);
 await tx.update(letterRecord).set({state:next.state,stageIndex:next.stageIndex,lockVersion:record.lockVersion+1}).where(eq(letterRecord.id,record.id));
 const sourceEventId=await event(tx,ctx,record.id,'approval.'+input.decision.action,{revisionId:revision.id,stageIndex:record.stageIndex,decisionId:decision.id,artifactId,contentHash:revision.contentHash});
 if(next.state==='submitted')await queueLetterStage(tx,ctx,record,policy,revision.id,next.stageIndex,sourceEventId);
 if(next.state==='returned'||next.state==='rejected'||next.state==='approved')await queueLetterCreator(tx,ctx,record,policy,revision.id,decision.id,next.state,sourceEventId);
return {letterId:record.id,state:next.state,lockVersion:record.lockVersion+1,artifactId};
}

export function delegateLetterApproval(ctx:SessionContext,input:{letterId:string;expectedRevisionId:string;expectedLockVersion:number;delegateUserId:string;reason:string}){return letters(ctx,true,async tx=>{
 const [record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(input.letterId))).for('update');if(!record)throw new LetterWorkflowError('permission');await permission(tx,record.companyId,'approve');await permission(tx,record.companyId,'read');
 if(record.state!=='submitted'||!record.currentRevisionId)throw new LetterWorkflowError('state');if(record.currentRevisionId!==input.expectedRevisionId||record.lockVersion!==input.expectedLockVersion)throw new LetterWorkflowError('stale');
 const reason=text(input.reason,2000),delegate=uuid(input.delegateUserId);if(delegate===record.createdBy||delegate===ctx.userId)throw new LetterWorkflowError('permission');
 const [eligible]=await tx.execute<{ok:boolean}>(sql`select app.letter_approver_eligible(${delegate}::uuid,${record.companyId}::uuid,${record.confidential}) as ok`);if(!eligible?.ok)throw new LetterWorkflowError('permission');
 const [revision]=await tx.select().from(letterRevision).where(eq(letterRevision.id,record.currentRevisionId));
 // The database checks the current stage, previous delegation and personally acting final signatory.
 const [decision]=await tx.insert(letterApprovalDecision).values({tenantId:ctx.tenantId,letterId:record.id,revisionId:revision.id,stageIndex:record.stageIndex,actorId:ctx.userId!,action:'delegate',comment:reason,delegatedTo:delegate,contentHash:revision.contentHash}).returning();
 await tx.update(letterRecord).set({lockVersion:record.lockVersion+1}).where(eq(letterRecord.id,record.id));
 const batch=await staffBatchTx(tx,record.id),[configuration]=await tx.select().from(letterPolicyVersion).where(eq(letterPolicyVersion.id,batch.policyVersionId)),policy=validateLetterPolicy(configuration.policy);
 await cancelLetterStageJobs(tx,record.id,revision.id,record.stageIndex);
 const sourceEventId=await event(tx,ctx,record.id,'approval.delegated',{revisionId:revision.id,stageIndex:record.stageIndex,decisionId:decision.id,delegateUserId:delegate,reason});
 await queueLetterStage(tx,ctx,record,policy,revision.id,record.stageIndex,sourceEventId,{userId:delegate,decisionId:decision.id});
return {letterId:record.id,lockVersion:record.lockVersion+1};
});}

export function issueLetter(ctx:SessionContext,input:{letterId:string;expectedRevisionId:string;expectedLockVersion:number}){return letters(ctx,true,async tx=>{
 const [record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(input.letterId))).for('update');if(!record)throw new LetterWorkflowError('permission');await permission(tx,record.companyId,'issue');await permission(tx,record.companyId,'read');
 if(record.currentRevisionId!==input.expectedRevisionId)throw new LetterWorkflowError('stale');
 const [artifact]=await tx.select().from(letterArtifact).where(and(eq(letterArtifact.letterId,record.id),eq(letterArtifact.revisionId,input.expectedRevisionId)));if(!artifact)throw new LetterWorkflowError('state');
 if(record.state==='issued')return {letterId:record.id,artifactId:artifact.id,alreadyIssued:true};
 if(record.lockVersion!==input.expectedLockVersion)throw new LetterWorkflowError('stale');if(record.state!=='approved')throw new LetterWorkflowError('state');
 if(hash(artifact.content)!==artifact.contentHash)throw new LetterWorkflowError('configuration','artifactHash');
 const batch=await staffBatchTx(tx,record.id),[template]=await tx.select().from(letterTemplateVersion).where(eq(letterTemplateVersion.id,batch.templateVersionId)),[configuration]=await tx.select().from(letterPolicyVersion).where(eq(letterPolicyVersion.id,batch.policyVersionId)),policy=validateLetterPolicy(configuration.policy);
 const documentId=randomUUID();
 // A single immutable artifact owns the bytes. The employee folder stores a protected identity link.
 await tx.insert(employeeDocument).values({id:documentId,tenantId:ctx.tenantId,employmentId:record.employmentId,letterArtifactId:artifact.id,title:template.name,category:template.category,description:record.reference,content:Buffer.alloc(0),fileName:record.reference.replace(/[^A-Za-z0-9._-]/g,'_')+'.pdf',mimeType:'application/pdf',sizeBytes:artifact.content.length,uploadedByUserId:ctx.userId!,updatedByUserId:ctx.userId!});
 await tx.update(letterRecord).set({state:'issued',lockVersion:record.lockVersion+1}).where(eq(letterRecord.id,record.id));
 const [subject]=await tx.select({personId:employment.personId}).from(employment).where(eq(employment.id,record.employmentId));const recipients=await tx.select({id:appUser.id}).from(appUser).where(and(eq(appUser.personId,subject.personId),isNull(appUser.archivedAt),sql`not app.login_blocked(${appUser.id})`));
 const sourceEventId=await event(tx,ctx,record.id,'issued',{revisionId:record.currentRevisionId,artifactId:artifact.id,artifactHash:artifact.contentHash,documentId,recipientCount:recipients.length});
 for(const recipient of recipients){
  const key=`${record.id}:${artifact.id}:issued:${recipient.id}`;
  if(policy.portalNotifications||policy.emailNotifications)await tx.insert(letterJob).values({tenantId:ctx.tenantId,companyId:record.companyId,letterId:record.id,sourceEventId,recipientUserId:recipient.id,kind:'notification',dedupeKey:key,payload:{artifactId:artifact.id,portal:policy.portalNotifications,email:policy.emailNotifications},dueAt:sql`now()`}).onConflictDoNothing();
  if((policy.portalNotifications||policy.emailNotifications)&&policy.acknowledgement!=='none')await tx.insert(letterJob).values({tenantId:ctx.tenantId,companyId:record.companyId,letterId:record.id,sourceEventId,recipientUserId:recipient.id,kind:'acknowledgementReminder',dedupeKey:key+':acknowledgement',payload:{artifactId:artifact.id,portal:policy.portalNotifications,email:policy.emailNotifications},dueAt:sql`now()+${policy.acknowledgementDueDays}*interval '1 day'`}).onConflictDoNothing();
 }
 return {letterId:record.id,artifactId:artifact.id,alreadyIssued:false};
});}
export function voidLetter(ctx:SessionContext,input:{letterId:string;expectedLockVersion:number;reason:string}){return letters(ctx,true,async tx=>{
 const [record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(input.letterId))).for('update');if(!record)throw new LetterWorkflowError('permission');await permission(tx,record.companyId,'issue');const reason=text(input.reason,2000);if(record.lockVersion!==input.expectedLockVersion)throw new LetterWorkflowError('stale');if(record.state!=='issued')throw new LetterWorkflowError('state');
 await tx.update(letterJob).set({status:'cancelled',leaseToken:null,leaseUntil:null,lastError:null}).where(and(eq(letterJob.letterId,record.id),inArray(letterJob.status,['queued','failed'])));
 await tx.update(letterRecord).set({state:'void',lockVersion:record.lockVersion+1}).where(eq(letterRecord.id,record.id));await event(tx,ctx,record.id,'voided',{revisionId:record.currentRevisionId,reason});return {letterId:record.id,state:'void' as const};
});}

/** Explicit person ownership applies even when the caller is also a privileged administrator. */
async function ownLetterTx(tx:Tx,id:string){
 const [row]=await tx.select({record:letterRecord}).from(letterRecord).innerJoin(employment,and(eq(employment.id,letterRecord.employmentId),eq(employment.tenantId,letterRecord.tenantId))).where(and(eq(letterRecord.id,uuid(id)),inArray(letterRecord.state,['issued','void']),sql`app.is_self_person(${employment.personId})`));
 if(!row)throw new LetterWorkflowError('permission');return row.record;
}
async function currentLetterArtifact(tx:Tx,record:typeof letterRecord.$inferSelect){
 if(!record.currentRevisionId)throw new LetterWorkflowError('state');const [artifact]=await tx.select().from(letterArtifact).where(and(eq(letterArtifact.letterId,record.id),eq(letterArtifact.revisionId,record.currentRevisionId)));if(!artifact)throw new LetterWorkflowError('state');return artifact;
}
export function listMyLetters(ctx:SessionContext,input:{cursor?:string;limit?:number}={}){return letters(ctx,false,async tx=>{
 const limit=input.limit??25;if(!Number.isInteger(limit)||limit<1||limit>100)throw new LetterWorkflowError('invalid','limit');if(input.cursor)await ownLetterTx(tx,input.cursor);
 const rows=await tx.select({id:letterRecord.id,reference:letterRecord.reference,state:letterRecord.state,issuedAt:letterRecord.issuedAt,voidedAt:letterRecord.voidedAt,employmentId:letterRecord.employmentId,companyId:letterRecord.companyId,
 acknowledgement:sql<'none'|'acknowledge'|'signature'>`app.letter_recipient_mode(${letterRecord.id})`,
 viewed:sql<boolean>`exists(select 1 from letter_recipient_event event join letter_artifact artifact on artifact.id=event.artifact_id where artifact.letter_id=${letterRecord.id} and artifact.revision_id=${letterRecord.currentRevisionId} and event.actor_id=${ctx.userId}::uuid and event.kind='viewed')`,
 confirmed:sql<string|null>`(select event.kind from letter_recipient_event event join letter_artifact artifact on artifact.id=event.artifact_id where artifact.letter_id=${letterRecord.id} and artifact.revision_id=${letterRecord.currentRevisionId} and event.actor_id=${ctx.userId}::uuid and event.kind in ('acknowledged','signed') order by event.created_at limit 1)`
 }).from(letterRecord).innerJoin(employment,and(eq(employment.id,letterRecord.employmentId),eq(employment.tenantId,letterRecord.tenantId))).where(and(inArray(letterRecord.state,['issued','void']),sql`app.is_self_person(${employment.personId})`,input.cursor?sql`(${letterRecord.issuedAt},${letterRecord.id})<(select c.issued_at,c.id from letter_record c where c.id=${input.cursor}::uuid)`:undefined)).orderBy(desc(letterRecord.issuedAt),desc(letterRecord.id)).limit(limit+1);
 return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null};
});}
export function getMyLetter(ctx:SessionContext,id:string){return letters(ctx,false,async tx=>{
 const record=await ownLetterTx(tx,id),artifact=await currentLetterArtifact(tx,record);
 // Policy rows are staff configuration. Expose only the bound recipient mode through a narrow SQL helper.
 const [recipient]=await tx.execute<{mode:'none'|'acknowledge'|'signature'}>(sql`select app.letter_recipient_mode(${record.id}::uuid) as mode`);
 const events=await tx.select({kind:letterRecipientEvent.kind,at:letterRecipientEvent.createdAt,contentHash:letterRecipientEvent.contentHash}).from(letterRecipientEvent).where(and(eq(letterRecipientEvent.artifactId,artifact.id),eq(letterRecipientEvent.actorId,ctx.userId!))).orderBy(asc(letterRecipientEvent.createdAt));
 return {record,artifact:{id:artifact.id,contentHash:artifact.contentHash},acknowledgement:recipient?.mode??'none',events};
});}
export function createMyLetterAccess(ctx:SessionContext,id:string){return letters(ctx,true,async tx=>{
 const record=await ownLetterTx(tx,id);if(record.state!=='issued')throw new LetterWorkflowError('state');const artifact=await currentLetterArtifact(tx,record);
 const [settings]=await tx.execute<{minutes:number}>(sql`select app.letter_recipient_link_minutes(${record.id}::uuid) as minutes`);if(!settings?.minutes)throw new LetterWorkflowError('configuration','policy');
 const token=randomBytes(32).toString('base64url'),[access]=await tx.insert(letterAccessToken).values({tenantId:ctx.tenantId,artifactId:artifact.id,audienceUserId:ctx.userId!,tokenHash:hash(token),expiresAt:sql`now()+${settings.minutes}*interval '1 minute'`}).returning({expiresAt:letterAccessToken.expiresAt});
 return {token,expiresAt:access.expiresAt,artifactHash:artifact.contentHash};
});}
export function downloadMyLetter(ctx:SessionContext,input:{letterId:string;token:string}){return letters(ctx,true,async tx=>{
 if(!/^[A-Za-z0-9_-]{43}$/.test(input.token))throw new LetterWorkflowError('permission');const record=await ownLetterTx(tx,input.letterId);if(record.state!=='issued')throw new LetterWorkflowError('state');const artifact=await currentLetterArtifact(tx,record);
 const [access]=await tx.select({id:letterAccessToken.id}).from(letterAccessToken).where(and(eq(letterAccessToken.tokenHash,hash(input.token)),eq(letterAccessToken.artifactId,artifact.id),eq(letterAccessToken.audienceUserId,ctx.userId!),gt(letterAccessToken.expiresAt,sql`now()`)));if(!access)throw new LetterWorkflowError('permission');
 await tx.insert(letterRecipientEvent).values({tenantId:ctx.tenantId,letterId:record.id,artifactId:artifact.id,actorId:ctx.userId!,kind:'viewed',contentHash:artifact.contentHash,intent:''}).onConflictDoNothing();
 await event(tx,ctx,record.id,'downloaded',{artifactId:artifact.id,artifactHash:artifact.contentHash,audienceUserId:ctx.userId!});return {content:artifact.content,contentHash:artifact.contentHash,fileName:record.reference.replace(/[^A-Za-z0-9._-]/g,'_')+'.pdf'};
});}
export function acknowledgeMyLetter(ctx:SessionContext,input:{letterId:string;expectedArtifactHash:string;action:'acknowledge'|'signature';intent:string}){return letters(ctx,true,async tx=>{
 if(!['acknowledge','signature'].includes(input.action)||typeof input.intent!=='string'||input.intent.length>2000)throw new LetterWorkflowError('invalid','acknowledgement');
 const record=await ownLetterTx(tx,input.letterId),artifact=await currentLetterArtifact(tx,record),[configuration]=await tx.execute<{mode:'none'|'acknowledge'|'signature'}>(sql`select app.letter_recipient_mode(${record.id}::uuid) as mode`);if(!configuration)throw new LetterWorkflowError('configuration','policy');
 assertLetterAcknowledgement({state:record.state,mode:configuration.mode,action:input.action,artifactHash:artifact.contentHash,expectedArtifactHash:input.expectedArtifactHash});const intent=text(input.intent,2000),kind=input.action==='signature'?'signed':'acknowledged';
 const [existing]=await tx.select().from(letterRecipientEvent).where(and(eq(letterRecipientEvent.artifactId,artifact.id),eq(letterRecipientEvent.actorId,ctx.userId!),eq(letterRecipientEvent.kind,kind)));if(existing)return {at:existing.createdAt,alreadyRecorded:true};
 const [action]=await tx.insert(letterRecipientEvent).values({tenantId:ctx.tenantId,letterId:record.id,artifactId:artifact.id,actorId:ctx.userId!,kind,contentHash:artifact.contentHash,intent}).returning({at:letterRecipientEvent.createdAt});
 await event(tx,ctx,record.id,'recipient.'+kind,{artifactId:artifact.id,artifactHash:artifact.contentHash,actorId:ctx.userId!,intent});return {at:action.at,alreadyRecorded:false};
});}

export type LetterRegisterFilter={companyId?:string;employmentId?:string;category?:string;search?:string;issuedFrom?:string;issuedTo?:string;state?:'approved'|'issued'|'void';cursor?:string;limit?:number};
function letterListLimit(limit=25){if(!Number.isInteger(limit)||limit<1||limit>100)throw new LetterWorkflowError('invalid','limit');return limit;}
export function listLetterRegister(ctx:SessionContext,input:LetterRegisterFilter={}){return letters(ctx,false,async tx=>{
 const limit=letterListLimit(input.limit);for(const id of [input.companyId,input.employmentId,input.cursor])if(id)uuid(id);
 if(input.state&&!['approved','issued','void'].includes(input.state))throw new LetterWorkflowError('invalid','state');for(const day of [input.issuedFrom,input.issuedTo])if(day&&!isCalendarDate(day))throw new LetterWorkflowError('invalid','period');if(input.issuedFrom&&input.issuedTo&&input.issuedFrom>input.issuedTo)throw new LetterWorkflowError('invalid','period');
 const needle=input.search?.trim();if(needle&&needle.length>200)throw new LetterWorkflowError('invalid','search');const search=needle?'%'+needle.replace(/[\\%_]/g,'\\$&')+'%':undefined;
 const rows=await tx.select({id:letterRecord.id,reference:letterRecord.reference,state:letterRecord.state,issuedAt:letterRecord.issuedAt,approvedAt:letterRecord.approvedAt,signatoryName:sql<string|null>`app.letter_approval_actor_label(${letterRecord.id},(select artifact.signatory_user_id from letter_artifact artifact where artifact.letter_id=${letterRecord.id} and artifact.revision_id=${letterRecord.currentRevisionId}))`,voidedAt:letterRecord.voidedAt,companyId:letterRecord.companyId,companyName:company.legalName,employmentId:letterRecord.employmentId,employeeName:person.fullName,employeeCode:employment.employeeCode,title:letterTemplateVersion.name,category:letterTemplateVersion.category,templateVersion:letterTemplateVersion.ordinal,originalLetterId:letterRecord.originalLetterId,lockVersion:letterRecord.lockVersion,currentRevisionId:letterRecord.currentRevisionId}).from(letterRecord)
  .innerJoin(company,eq(company.id,letterRecord.companyId)).innerJoin(employment,eq(employment.id,letterRecord.employmentId)).innerJoin(person,eq(person.id,employment.personId)).innerJoin(sql`lateral app.letter_staff_batch_metadata(${letterRecord.id}) batch_metadata`,sql`true`).innerJoin(letterTemplateVersion,sql`${letterTemplateVersion.id}=batch_metadata.template_version_id`)
  .where(and(inArray(letterRecord.state,input.state?[input.state]:['issued','void']),sql`app.letter_permission(${letterRecord.companyId},'read')`,input.state==='approved'?sql`app.letter_permission(${letterRecord.companyId},'issue')`:undefined,input.companyId?eq(letterRecord.companyId,input.companyId):undefined,input.employmentId?eq(letterRecord.employmentId,input.employmentId):undefined,input.category?eq(letterTemplateVersion.category,text(input.category,100)):undefined,search?or(ilike(person.fullName,search),ilike(employment.employeeCode,search),ilike(letterRecord.reference,search)):undefined,input.issuedFrom?sql`(${letterRecord.issuedAt} at time zone 'Asia/Kuala_Lumpur')::date>=${input.issuedFrom}::date`:undefined,input.issuedTo?sql`(${letterRecord.issuedAt} at time zone 'Asia/Kuala_Lumpur')::date<=${input.issuedTo}::date`:undefined,input.cursor?sql`(coalesce(${letterRecord.issuedAt},${letterRecord.approvedAt}),${letterRecord.id})<(select coalesce(c.issued_at,c.approved_at),c.id from letter_record c where c.id=${input.cursor}::uuid)`:undefined)).orderBy(sql`coalesce(${letterRecord.issuedAt},${letterRecord.approvedAt}) desc`,desc(letterRecord.id)).limit(limit+1);
 return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null};
});}
export function listLetterApprovalQueue(ctx:SessionContext,input:{companyId?:string;limit?:number;cursor?:string}={}){return letters(ctx,false,async tx=>{
 const limit=letterListLimit(input.limit);if(input.companyId)uuid(input.companyId);if(input.cursor)uuid(input.cursor);
 const rows=await tx.select({record:letterRecord,title:letterTemplateVersion.name,category:letterTemplateVersion.category,employeeName:sql<string>`staff.employee_name`,employeeCode:sql<string|null>`staff.employee_code`,final:sql<boolean>`${letterRecord.stageIndex}=jsonb_array_length(${letterPolicyVersion.policy}->'stages')-1`,stageLabel:sql<string>`${letterPolicyVersion.policy}->'stages'->${letterRecord.stageIndex}->>'label'`,dueAt:sql<Date>`${letterStageEnteredAt(sql`${letterRecord.stageIndex}`,sql`${letterRecord.submittedAt}`,sql`${letterRecord.currentRevisionId}`)}+(${letterPolicyVersion.policy}->>'approvalDueHours')::integer*interval '1 hour'`}).from(letterRecord).innerJoin(sql`lateral app.letter_staff_identity(${letterRecord.id}) staff`,sql`true`).innerJoin(sql`lateral app.letter_staff_batch_metadata(${letterRecord.id}) batch_metadata`,sql`true`).innerJoin(letterTemplateVersion,sql`${letterTemplateVersion.id}=batch_metadata.template_version_id`).innerJoin(letterPolicyVersion,sql`${letterPolicyVersion.id}=batch_metadata.policy_version_id`)
 .where(and(eq(letterRecord.state,'submitted'),sql`${letterRecord.createdBy}<>${ctx.userId}::uuid`,sql`app.letter_permission(${letterRecord.companyId},'read') AND app.letter_permission(${letterRecord.companyId},'approve')`,input.companyId?eq(letterRecord.companyId,input.companyId):undefined,input.cursor?gt(letterRecord.id,input.cursor):undefined,
 sql`coalesce((select d.delegated_to=${ctx.userId}::uuid from letter_approval_decision d where d.revision_id=${letterRecord.currentRevisionId} and d.stage_index=${letterRecord.stageIndex} and d.action='delegate' order by d.created_at desc,d.id desc limit 1),(${letterPolicyVersion.policy}->'stages'->${letterRecord.stageIndex}->'userIds') ? ${ctx.userId})`)).orderBy(asc(letterRecord.id)).limit(limit+1);
 return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].record.id:null};
});}
async function staffBatchTx(tx:Tx,letterId:string){
 const [batch]=await tx.execute<{id:string;companyId:string;templateVersionId:string;policyVersionId:string;sourceAsOfDate:string}>(sql`select id,company_id as "companyId",template_version_id as "templateVersionId",policy_version_id as "policyVersionId",source_as_of_date as "sourceAsOfDate" from app.letter_staff_batch_metadata(${letterId}::uuid)`);if(!batch)throw new LetterWorkflowError('permission');return batch;
}
export function getStaffLetter(ctx:SessionContext,id:string,options:{decisionCursor?:string}={}){return letters(ctx,false,tx=>staffLetterTx(ctx,tx,id,options));}
async function staffLetterTx(ctx:SessionContext,tx:Tx,id:string,options:{decisionCursor?:string}={}){
 const [record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(id)));if(!record)return null;await permission(tx,record.companyId,'read');
 const [revision]=record.currentRevisionId?await tx.select().from(letterRevision).where(eq(letterRevision.id,record.currentRevisionId)):[],batch=await staffBatchTx(tx,record.id),[policy]=await tx.select().from(letterPolicyVersion).where(eq(letterPolicyVersion.id,batch.policyVersionId));
 if(options.decisionCursor)uuid(options.decisionCursor);
 const decisions=record.currentRevisionId?await tx.select({...getTableColumns(letterApprovalDecision),actorName:sql<string|null>`app.letter_approval_actor_label(${record.id}::uuid,${letterApprovalDecision.actorId})`}).from(letterApprovalDecision).where(and(eq(letterApprovalDecision.revisionId,record.currentRevisionId),options.decisionCursor?sql`(${letterApprovalDecision.createdAt},${letterApprovalDecision.id})>(select cursor.created_at,cursor.id from letter_approval_decision cursor where cursor.id=${options.decisionCursor}::uuid and cursor.revision_id=${record.currentRevisionId}::uuid)`:undefined)).orderBy(asc(letterApprovalDecision.createdAt),asc(letterApprovalDecision.id)).limit(101):[];
 const configuration=validateLetterPolicy(policy.policy),[authority]=await tx.execute<{ok:boolean}>(sql`select app.letter_permission(${record.companyId}::uuid,'approve') as ok`);
 const [delegation]=record.currentRevisionId?await tx.select().from(letterApprovalDecision).where(and(eq(letterApprovalDecision.revisionId,record.currentRevisionId),eq(letterApprovalDecision.stageIndex,record.stageIndex),eq(letterApprovalDecision.action,'delegate'))).orderBy(desc(letterApprovalDecision.createdAt),desc(letterApprovalDecision.id)).limit(1):[];
 let canAct=false;
 if(authority?.ok&&record.currentRevisionId){try{letterStageDecision({...record,revisionId:record.currentRevisionId},configuration,{actorId:ctx.userId!,expectedRevisionId:record.currentRevisionId,expectedLockVersion:record.lockVersion,decision:{action:'approve',comment:'',confirmSignature:true},delegatedUserId:delegation?.delegatedTo});canAct=true;}catch(error){if(!(error instanceof LetterWorkflowError))throw error;}}
 const final=record.stageIndex===configuration.stages.length-1,[employee]=await tx.execute<{employee_name:string;employee_code:string|null;company_name:string;title:string;category:string}>(sql`select * from app.letter_staff_identity(${record.id}::uuid)`);
 return {record,revision:revision??null,batch,policy:configuration,metadata:employee?{title:employee.title,category:employee.category,companyName:employee.company_name}:null,employee:employee?{name:employee.employee_name,code:employee.employee_code}:null,canAct,canDelegate:canAct&&!final&&configuration.stages[record.stageIndex].allowDelegation,final,decisions:decisions.slice(0,100),moreDecisions:decisions.length>100,nextDecisionCursor:decisions.length>100?decisions[99].id:null};
}
export function listLetterDelegates(ctx:SessionContext,input:{letterId:string;search?:string;cursor?:string;limit?:number}){return letters(ctx,false,async tx=>{
 const data=await staffLetterTx(ctx,tx,input.letterId);if(!data?.canDelegate)throw new LetterWorkflowError('permission');
 const limit=letterListLimit(input.limit);if(input.cursor)uuid(input.cursor);const search=input.search?.trim();if(search&&search.length>200)throw new LetterWorkflowError('invalid','search');const needle=search?'%'+search.replace(/[\\%_]/g,'\\$&')+'%':null;
 const rows=await tx.execute<{id:string;name:string}>(sql`select * from app.letter_delegate_choices(${input.letterId}::uuid,${input.cursor??null}::uuid,${needle},${limit+1})`);
 return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null};
});}
export function letterAudit(ctx:SessionContext,input:{letterId:string;cursor?:string;limit?:number}){return letters(ctx,false,async tx=>{
 const [record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(input.letterId)));if(!record)throw new LetterWorkflowError('permission');await permission(tx,record.companyId,'read');const limit=letterListLimit(input.limit);if(input.cursor)uuid(input.cursor);
 const rows=await tx.execute<{id:string;type:string;actorType:string;actorId:string|null;actorName:string|null;payload:Record<string,unknown>|null;at:Date}>(sql`select id,event_type as type,actor_type as "actorType",actor_id as "actorId",app.letter_audit_actor_label(${record.id}::uuid,actor_id) as "actorName",payload,occurred_at as at from app.letter_audit(${record.id}::uuid,${input.cursor??null}::uuid,${limit+1})`);
 return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null};
});}
export function downloadStaffLetter(ctx:SessionContext,id:string){return letters(ctx,true,async tx=>{
 const [record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(id)));if(!record)throw new LetterWorkflowError('permission');await permission(tx,record.companyId,'read');if(record.state==='approved')await permission(tx,record.companyId,'issue');else if(!['issued','void'].includes(record.state))throw new LetterWorkflowError('state');const artifact=await currentLetterArtifact(tx,record);if(hash(artifact.content)!==artifact.contentHash)throw new LetterWorkflowError('configuration','artifactHash');
 await event(tx,ctx,record.id,'downloaded',{artifactId:artifact.id,artifactHash:artifact.contentHash,state:record.state});return {content:artifact.content,fileName:record.reference.replace(/[^A-Za-z0-9._-]/g,'_')+'.pdf',contentHash:artifact.contentHash};
});}
export function bulkDecideLetters(ctx:SessionContext,input:{letters:{letterId:string;expectedRevisionId:string;expectedLockVersion:number}[];decision:LetterStageDecision}){return letters(ctx,true,async tx=>{
 if(!input.letters.length||input.letters.length>100||new Set(input.letters.map(row=>row.letterId)).size!==input.letters.length)throw new LetterWorkflowError('invalid','selection');
 const results=[];for(const row of [...input.letters].sort((a,b)=>a.letterId.localeCompare(b.letterId))){const result=await decideLetterTx(ctx,tx,{...row,decision:input.decision});results.push({letterId:row.letterId,state:result.state});}
 return {results,completed:results.length};
});}
export function setLetterRetention(ctx:SessionContext,input:{letterId:string;expectedLockVersion:number;legalHold:boolean;retainUntil:string;reason:string}){return letters(ctx,true,async tx=>{
 if(typeof input.legalHold!=='boolean'||!isCalendarDate(input.retainUntil))throw new LetterWorkflowError('invalid','retention');const reason=text(input.reason,2000),[record]=await tx.select().from(letterRecord).where(eq(letterRecord.id,uuid(input.letterId))).for('update');if(!record)throw new LetterWorkflowError('permission');await permission(tx,record.companyId,'settings');if(record.lockVersion!==input.expectedLockVersion)throw new LetterWorkflowError('stale');if(input.retainUntil<record.retainUntil)throw new LetterWorkflowError('invalid','retention');
 await tx.update(letterRecord).set({legalHold:input.legalHold,retainUntil:input.retainUntil,lockVersion:record.lockVersion+1}).where(eq(letterRecord.id,record.id));await event(tx,ctx,record.id,'retention.changed',{before:{legalHold:record.legalHold,retainUntil:record.retainUntil},after:{legalHold:input.legalHold,retainUntil:input.retainUntil},reason});return {letterId:record.id,lockVersion:record.lockVersion+1};
});}

export function listLetterTemplates(ctx:SessionContext,input:{companyId:string;mode?:'latest'|'active';search?:string;cursor?:string;limit?:number}){return letters(ctx,false,async tx=>{
 await anyPermission(tx,input.companyId,['read','template']);const limit=letterListLimit(input.limit);if(input.cursor)uuid(input.cursor);if(input.mode&&!['latest','active'].includes(input.mode))throw new LetterWorkflowError('invalid','mode');
 const active=input.mode==='active',search=input.search?.trim();if(search&&search.length>200)throw new LetterWorkflowError('invalid','search');const needle=search?'%'+search.replace(/[\\%_]/g,'\\$&')+'%':undefined;
 const rows=await tx.select({root:letterTemplate,version:{id:letterTemplateVersion.id,ordinal:letterTemplateVersion.ordinal,name:letterTemplateVersion.name,category:letterTemplateVersion.category,effectiveFrom:letterTemplateVersion.effectiveFrom,status:letterTemplateVersion.status,approvedAt:letterTemplateVersion.approvedAt}}).from(letterTemplate).innerJoin(letterTemplateVersion,eq(letterTemplateVersion.templateId,letterTemplate.id)).where(and(eq(letterTemplate.companyId,input.companyId),active?eq(letterTemplate.deactivated,false):undefined,input.cursor?gt(letterTemplate.id,input.cursor):undefined,needle?or(ilike(letterTemplate.code,needle),ilike(letterTemplateVersion.name,needle)):undefined,
 sql`${letterTemplateVersion.id}=(select v.id from letter_template_version v where v.template_id=${letterTemplate.id} ${active?sql`and v.status='approved' and v.effective_from<=${todayInKualaLumpur()}::date`:sql``} order by v.ordinal desc limit 1)`)).orderBy(asc(letterTemplate.id)).limit(limit+1);
 return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].root.id:null};
});}
export function getLetterTemplate(ctx:SessionContext,id:string,options:{forGeneration?:boolean}={}){return letters(ctx,false,async tx=>{
 const [row]=await tx.select({root:letterTemplate,version:letterTemplateVersion}).from(letterTemplateVersion).innerJoin(letterTemplate,eq(letterTemplate.id,letterTemplateVersion.templateId)).where(eq(letterTemplateVersion.id,uuid(id)));if(!row)return null;await anyPermission(tx,row.root.companyId,['read','template']);
 if(options.forGeneration){await permission(tx,row.root.companyId,'generate');await generationTemplate(tx,row.root.companyId,id,true,true);}
 const fields=await tx.select({id:letterMergeFieldVersion.id,definition:letterMergeFieldVersion.definition,active:letterMergeFieldVersion.active,ordinal:letterMergeFieldVersion.ordinal}).from(letterTemplateField).innerJoin(letterMergeFieldVersion,eq(letterMergeFieldVersion.id,letterTemplateField.fieldVersionId)).where(eq(letterTemplateField.templateVersionId,id)).orderBy(asc(letterMergeFieldVersion.key));
 if(usedLetterFields(row.version.document).some(key=>!fields.some(field=>field.definition.key===key)))throw new LetterWorkflowError('permission');
 const [appearance]=await tx.execute<{letterhead_name:string|null;signatory_name:string|null}>(sql`select * from app.letter_template_appearance(${row.version.id}::uuid)`);
 return {...row,fields,appearance:appearance??{letterhead_name:null,signatory_name:null}};
});}
export function listLetterTemplateVersions(ctx:SessionContext,input:{templateId:string;cursor?:number;limit?:number}){return letters(ctx,false,async tx=>{
 const [root]=await tx.select().from(letterTemplate).where(eq(letterTemplate.id,uuid(input.templateId)));if(!root)throw new LetterWorkflowError('permission');await anyPermission(tx,root.companyId,['read','template']);const limit=letterListLimit(input.limit);if(input.cursor!==undefined&&(!Number.isInteger(input.cursor)||input.cursor<1))throw new LetterWorkflowError('invalid','cursor');
 const rows=await tx.select({id:letterTemplateVersion.id,ordinal:letterTemplateVersion.ordinal,name:letterTemplateVersion.name,category:letterTemplateVersion.category,status:letterTemplateVersion.status,effectiveFrom:letterTemplateVersion.effectiveFrom,createdBy:letterTemplateVersion.createdBy,approvedBy:letterTemplateVersion.approvedBy,approvedAt:letterTemplateVersion.approvedAt,createdAt:letterTemplateVersion.createdAt}).from(letterTemplateVersion).where(and(eq(letterTemplateVersion.templateId,root.id),input.cursor?sql`${letterTemplateVersion.ordinal}<${input.cursor}`:undefined)).orderBy(desc(letterTemplateVersion.ordinal)).limit(limit+1);
 return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].ordinal:null};
});}
export function previewLetterTemplate(ctx:SessionContext,input:{templateVersionId:string;employmentId:string;customValues?:Record<string,LetterValue|null>}){return letters(ctx,false,async tx=>{
 const [version]=await tx.select().from(letterTemplateVersion).where(eq(letterTemplateVersion.id,uuid(input.templateVersionId)));if(!version)throw new LetterWorkflowError('permission');await anyPermission(tx,version.companyId,['template','generate']);
 const fields=await tx.select({definition:letterMergeFieldVersion.definition}).from(letterTemplateField).innerJoin(letterMergeFieldVersion,eq(letterMergeFieldVersion.id,letterTemplateField.fieldVersionId)).where(eq(letterTemplateField.templateVersionId,version.id));
 const definitions=fields.map(field=>field.definition);if(usedLetterFields(version.document).some(key=>!definitions.some(field=>field.key===key)))throw new LetterWorkflowError('permission');
 const source=await letterSources(tx,ctx,version.companyId,input.employmentId,definitions,input.customValues??{},todayInKualaLumpur());return renderLetterDocument(version.document,definitions,source.values,{allowSensitive:true});
});}
export function letterFieldDependencies(ctx:SessionContext,input:{fieldVersionId:string;cursor?:string;limit?:number}){return letters(ctx,false,async tx=>{
 const [field]=await tx.select().from(letterMergeFieldVersion).where(eq(letterMergeFieldVersion.id,uuid(input.fieldVersionId)));if(!field)throw new LetterWorkflowError('permission');await anyPermission(tx,field.companyId,['read','template']);if(input.cursor)uuid(input.cursor);const limit=letterListLimit(input.limit);
 const rows=await tx.select({versionId:letterTemplateVersion.id,templateId:letterTemplate.id,code:letterTemplate.code,name:letterTemplateVersion.name,ordinal:letterTemplateVersion.ordinal,fieldOrdinal:letterMergeFieldVersion.ordinal,status:letterTemplateVersion.status,deactivated:letterTemplate.deactivated}).from(letterTemplateField).innerJoin(letterMergeFieldVersion,eq(letterMergeFieldVersion.id,letterTemplateField.fieldVersionId)).innerJoin(letterTemplateVersion,eq(letterTemplateVersion.id,letterTemplateField.templateVersionId)).innerJoin(letterTemplate,eq(letterTemplate.id,letterTemplateVersion.templateId)).where(and(eq(letterMergeFieldVersion.companyId,field.companyId),eq(letterMergeFieldVersion.key,field.key),input.cursor?gt(letterTemplateVersion.id,input.cursor):undefined)).orderBy(asc(letterTemplateVersion.id)).limit(limit+1);
 return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].versionId:null};
});}
async function fieldAccessTx(tx:Tx,co:string){await anyPermission(tx,co,['read','template']);const [access]=await tx.execute<{canEdit:boolean;canUseSensitive:boolean}>(sql`select app.letter_permission(${co}::uuid,'template') as "canEdit",app.can_admin_payroll_for(${co}::uuid) as "canUseSensitive"`);return access;}
export function letterFieldAccess(ctx:SessionContext,co:string){return letters(ctx,false,tx=>fieldAccessTx(tx,co));}
export function getLetterField(ctx:SessionContext,id:string){return letters(ctx,false,async tx=>{
 const [field]=await tx.select().from(letterMergeFieldVersion).where(eq(letterMergeFieldVersion.id,uuid(id)));if(!field)return null;const access=await fieldAccessTx(tx,field.companyId);
 const [status]=await tx.execute<{isLatest:boolean;inUse:boolean}>(sql`select coalesce(${field.id}::uuid=app.letter_field_latest_version(${field.companyId}::uuid,${field.key}),false) as "isLatest",app.letter_field_in_use(${field.companyId}::uuid,${field.key}) as "inUse"`);return {field,access,...status};
});}
export function letterFieldHistory(ctx:SessionContext,input:{companyId:string;key:string;cursor?:number;limit?:number}){return letters(ctx,false,async tx=>{
 await anyPermission(tx,input.companyId,['read','template']);const limit=letterListLimit(input.limit);if(input.cursor!==undefined&&(!Number.isInteger(input.cursor)||input.cursor<1))throw new LetterWorkflowError('invalid','cursor');
 const rows=await tx.select().from(letterMergeFieldVersion).where(and(eq(letterMergeFieldVersion.companyId,input.companyId),eq(letterMergeFieldVersion.key,text(input.key,80)),input.cursor?sql`${letterMergeFieldVersion.ordinal}<${input.cursor}`:undefined)).orderBy(desc(letterMergeFieldVersion.ordinal)).limit(limit+1);return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].ordinal:null};
});}
export function letterPolicyHistory(ctx:SessionContext,input:{companyId:string;category:string;cursor?:number;limit?:number}){return letters(ctx,false,async tx=>{
 await permission(tx,input.companyId,'settings');const limit=letterListLimit(input.limit);if(input.cursor!==undefined&&(!Number.isInteger(input.cursor)||input.cursor<1))throw new LetterWorkflowError('invalid','cursor');
 const rows=await tx.select().from(letterPolicyVersion).where(and(eq(letterPolicyVersion.companyId,input.companyId),eq(letterPolicyVersion.category,text(input.category,100)),input.cursor?sql`${letterPolicyVersion.ordinal}<${input.cursor}`:undefined)).orderBy(desc(letterPolicyVersion.ordinal)).limit(limit+1);return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].ordinal:null};
});}

export type LetterReportFilter={companyIds?:string[];companyId?:string;departmentId?:string;from:string;to:string;cursor?:string;limit?:number;exportAll?:boolean;expectedDataHash?:string};
export function letterReportDepartments(ctx:SessionContext,companyId?:string,companyIds?:string[]){return letters(ctx,false,async tx=>{
 if(companyIds!==undefined){if(!Array.isArray(companyIds))throw new LetterWorkflowError('invalid','scope');companyIds.forEach(uuid);if(companyId&&!companyIds.includes(companyId))throw new LetterWorkflowError('permission');}
 if(companyId){await permission(tx,companyId,'read');await permission(tx,companyId,'report');}
 return tx.select({id:department.id,companyId:department.companyId,name:sql<string>`coalesce(nullif(trim(${department.label}),''),nullif(trim(${department.description}),''),${department.name})`}).from(department).where(and(companyIds!==undefined?inArray(department.companyId,companyIds):undefined,companyId?eq(department.companyId,companyId):undefined,sql`app.letter_permission(${department.companyId},'read') and app.letter_permission(${department.companyId},'report')`)).orderBy(asc(department.name),asc(department.id));
});}
export type LetterReportRow={id:string;reference:string;state:string;company_id:string;company_name:string;employment_id:string;employee_name:string;employee_code:string|null;department_id:string|null;department_name:string|null;organisation_ambiguous:boolean;category:string;title:string;created_at:string;submitted_at:string|null;approved_at:string|null;issued_at:string|null;voided_at:string|null;stage_entered_at:string|null;approval_due_at:string|null;acknowledgement_due_at:string|null;viewed_at:string|null;acknowledged_at:string|null;pending_acknowledgement:boolean;approval_overdue:boolean;acknowledgement_overdue:boolean;approval_hours:number|null;issue_hours:number|null;acknowledgement_hours:number|null};
export type LetterReportSummary={total:number;issued:number;void:number;historicalIssued:number;pendingApproval:number;pendingAcknowledgement:number;approvalOverdue:number;acknowledgementOverdue:number;meanApprovalHours:number|null;meanIssueHours:number|null;meanAcknowledgementHours:number|null};
export type LetterReport={rows:LetterReportRow[];summary:LetterReportSummary;dataHash:string;generatedAt:string;generatedBy:string;timezone:'Asia/Kuala_Lumpur';period:{from:string;to:string};nextCursor:string|null};
/** One SQL statement owns the complete scoped cohort, aggregates, page and fingerprint. Reads emit nothing. */
export function readLetterReport(ctx:SessionContext,input:LetterReportFilter):Promise<LetterReport>{return letters(ctx,false,async tx=>{
 if(input.companyIds!==undefined){if(!Array.isArray(input.companyIds))throw new LetterWorkflowError('invalid','scope');input.companyIds.forEach(uuid);if(input.companyId&&!input.companyIds.includes(input.companyId))throw new LetterWorkflowError('permission');}
 if(!isCalendarDate(input.from)||!isCalendarDate(input.to)||input.from>input.to||(Date.parse(input.to)-Date.parse(input.from))/86400000>365)throw new LetterWorkflowError('invalid','period');
 for(const id of [input.companyId,input.departmentId,input.cursor])if(id)uuid(id);if(input.expectedDataHash&&!/^[0-9a-f]{64}$/.test(input.expectedDataHash))throw new LetterWorkflowError('invalid','reportHash');
 if(input.companyId){await permission(tx,input.companyId,'read');await permission(tx,input.companyId,'report');}
 else{const [scope]=await tx.execute<{ok:boolean}>(sql`select exists(select 1 from company c where c.tenant_id=app.current_tenant_id() and app.letter_permission(c.id,'read') and app.letter_permission(c.id,'report')) as ok`);if(!scope?.ok)throw new LetterWorkflowError('permission');}
 const limit=input.exportAll?50001:letterListLimit(input.limit),cursor=input.exportAll?null:input.cursor??null;
 const [result]=await tx.execute<{rows:LetterReportRow[];summary:LetterReportSummary;data_hash:string;generated_at:string}>(sql`
 with base as (
  select l.id,l.reference,l.state,l.company_id,c.legal_name as company_name,l.employment_id,p.full_name as employee_name,e.employee_code,
   org.department_id,coalesce(nullif(trim(d.label),''),nullif(trim(d.description),''),d.name) as department_name,org.ambiguous as organisation_ambiguous,v.category,v.name as title,
   l.created_at,l.submitted_at,l.approved_at,l.issued_at,l.voided_at,
   ${letterStageEnteredAt(sql`l.stage_index`,sql`l.submitted_at`,sql`l.current_revision_id`)} as stage_entered_at,
   (policy.policy->>'approvalDueHours')::integer as approval_due_hours,(policy.policy->>'acknowledgementDueDays')::integer as acknowledgement_due_days,
   policy.policy->>'acknowledgement' as acknowledgement_mode,recipient.viewed_at,recipient.acknowledged_at
  from letter_record l join company c on c.id=l.company_id and c.tenant_id=l.tenant_id
  join employment e on e.id=l.employment_id and e.tenant_id=l.tenant_id join person p on p.id=e.person_id and p.tenant_id=l.tenant_id
  join lateral app.letter_staff_batch_metadata(l.id) b on true join letter_template_version v on v.id=b.template_version_id and v.tenant_id=l.tenant_id
  join letter_policy_version policy on policy.id=b.policy_version_id and policy.tenant_id=l.tenant_id
  left join letter_artifact artifact on artifact.letter_id=l.id and artifact.revision_id=l.current_revision_id and artifact.tenant_id=l.tenant_id
  left join lateral (select min(action.created_at) filter(where action.kind='viewed') as viewed_at,
   min(action.created_at) filter(where action.kind=case when policy.policy->>'acknowledgement'='signature' then 'signed' when policy.policy->>'acknowledgement'='acknowledge' then 'acknowledged' else null end) as acknowledged_at
   from letter_recipient_event action where action.artifact_id=artifact.id and action.tenant_id=l.tenant_id) recipient on true
  left join lateral (select case when count(*)=1 then min(a.department_id::text)::uuid else null end as department_id,count(*)>1 as ambiguous
   from assignment a where a.employment_id=l.employment_id and a.tenant_id=l.tenant_id and a.valid_from<=b.source_as_of_date::date and (a.valid_to is null or a.valid_to>b.source_as_of_date::date)) org on true
  left join department d on d.id=org.department_id and d.tenant_id=l.tenant_id
  where app.letter_permission(l.company_id,'report') and app.letter_permission(l.company_id,'read')
   and ${input.companyIds===undefined?sql`true`:input.companyIds.length?sql`l.company_id in (${sql.join(input.companyIds.map(id=>sql`${id}::uuid`),sql`,`)})`:sql`false`}
   and (l.created_at at time zone 'Asia/Kuala_Lumpur')::date between ${input.from}::date and ${input.to}::date
   and (${input.companyId??null}::uuid is null or l.company_id=${input.companyId??null}::uuid)
   and (${input.departmentId??null}::uuid is null or org.department_id=${input.departmentId??null}::uuid)
 ), facts as (
  select base.*,case when state='submitted' then stage_entered_at+approval_due_hours*interval '1 hour' else null end as approval_due_at,
   case when state='issued' and acknowledgement_mode<>'none' then issued_at+acknowledgement_due_days*interval '1 day' else null end as acknowledgement_due_at,
   state='issued' and acknowledgement_mode<>'none' and acknowledged_at is null as pending_acknowledgement,
   coalesce(state='submitted' and stage_entered_at+approval_due_hours*interval '1 hour'<statement_timestamp(),false) as approval_overdue,
   coalesce(state='issued' and acknowledgement_mode<>'none' and acknowledged_at is null and issued_at+acknowledgement_due_days*interval '1 day'<statement_timestamp(),false) as acknowledgement_overdue,
   case when approved_at>=submitted_at then extract(epoch from approved_at-submitted_at)/3600 else null end as approval_hours,
   case when issued_at>=created_at then extract(epoch from issued_at-created_at)/3600 else null end as issue_hours,
   case when acknowledged_at>=issued_at then extract(epoch from acknowledged_at-issued_at)/3600 else null end as acknowledgement_hours
  from base
 ), summary as (
  select count(*) as total,count(*) filter(where state='issued') as issued,count(*) filter(where state='void') as void,
   count(*) filter(where issued_at is not null) as "historicalIssued",count(*) filter(where state='submitted') as "pendingApproval",
   count(*) filter(where pending_acknowledgement) as "pendingAcknowledgement",count(*) filter(where approval_overdue) as "approvalOverdue",count(*) filter(where acknowledgement_overdue) as "acknowledgementOverdue",
   avg(approval_hours) as "meanApprovalHours",avg(issue_hours) as "meanIssueHours",avg(acknowledgement_hours) as "meanAcknowledgementHours" from facts
 ), page as (select * from facts where (${cursor}::uuid is null or id>${cursor}::uuid) order by id limit ${limit+1})
 select coalesce((select jsonb_agg(to_jsonb(page) order by page.id) from page),'[]'::jsonb) as rows,(select to_jsonb(summary) from summary) as summary,
  encode(sha256(convert_to(coalesce((select string_agg(encode(sha256(convert_to(to_jsonb(facts)::text,'UTF8')),'hex'),'' order by facts.id) from facts),''),'UTF8')),'hex') as data_hash,
  to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as generated_at`);
 if(!result)throw new LetterWorkflowError('configuration','report');if(input.expectedDataHash&&input.expectedDataHash!==result.data_hash)throw new LetterWorkflowError('stale','reportChanged');
 if(input.exportAll&&result.summary.total>50000)throw new LetterWorkflowError('configuration','reportExportLimit');
 return {rows:result.rows.slice(0,input.exportAll?50000:limit),summary:result.summary,dataHash:result.data_hash,generatedAt:result.generated_at,generatedBy:ctx.userId!,timezone:'Asia/Kuala_Lumpur',period:{from:input.from,to:input.to},nextCursor:!input.exportAll&&result.rows.length>limit?result.rows[limit-1].id:null};
});}
