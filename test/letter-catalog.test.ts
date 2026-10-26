import {afterAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,asc,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {saveLetterField,saveLetterTemplate,decideLetterTemplate,setLetterTemplateActive,saveLetterPolicy,saveLetterPermission,addLetterAsset,letterAssetChoices,listLetterFields,letterCompanyAccess,listLetterTemplates,getLetterTemplate,listLetterTemplateVersions,previewLetterTemplate,letterFieldDependencies,letterPolicyHistory,getLetterField,letterFieldHistory,listLetterTemplateHeads,listLetterSignatories} from '../core/letters';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {LetterPolicy} from '../lib/letter-workflow';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,author:SessionContext,approver:SessionContext;
const field={key:'employeeName',label:'Employee name',description:'Canonical employee name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false} as const;
const document={version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'Dear '},{type:'field',key:'employeeName'}]}]};
async function draft(){const definition=await saveLetterField(author,{companyId:b.companyId,definition:field,active:true});return saveLetterTemplate(author,{companyId:b.companyId,code:'CONFIRMATION',name:'Fictional confirmation',category:'confirmation',effectiveFrom:todayInKualaLumpur(),document,fieldVersionIds:[definition.id]});}
function policy():LetterPolicy{return {version:1,stages:[{key:'signatory',label:'Authorised Signatory',userIds:[approver.userId!],allowDelegation:false}],signatoryUserId:approver.userId!,signingMode:'authenticated',signatureAssetId:null,letterheadAssetId:null,referenceFormat:'HR/{YYYY}/{SEQ:6}',retentionDays:365,sensitiveLinkMinutes:15,acknowledgement:'acknowledge',approvalDueHours:48,acknowledgementDueDays:7,reminderHours:24,escalationUserId:null,portalNotifications:false,emailNotifications:false};}
beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NEXT_PUBLIC_WORKOS_REDIRECT_URI','https://letters.fixture.test/callback');
 await resetDb();b=await seedBase();author=await entitledCtx(b);
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional letter approver',primaryEmail:'letter-approver@fixture.test'}).returning();
 const userId=await createAppUser(b.tenantId,person.id,'hr_admin');approver={...author,userId,personId:person.id};
});afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});
describe('versioned Letters configuration and template owner',()=>{
 it('previews a draft from canonical employee information without creating a letter or audit mutation',async()=>{
  const template=await draft(),hired=await hireEmployee(author,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur(),employeeCode:'PREVIEW-1',person:{fullName:'Fictional preview employee',primaryEmail:'preview@fixture.test'}}),before=await owner.db.select().from(s.domainEvent);
  const preview=await previewLetterTemplate(author,{templateVersionId:template.versionId,employmentId:hired.employmentId});expect(JSON.stringify(preview.document)).toContain('Fictional preview employee');expect(await owner.db.select().from(s.domainEvent)).toHaveLength(before.length);expect(await owner.db.select().from(s.letterRecord)).toHaveLength(0);expect(await owner.db.select().from(s.letterCounter)).toHaveLength(0);
 });
 it('does not expose or bind confidential fields through a template-only permission grant',async()=>{
  const publicVersion=await saveLetterField(author,{companyId:b.companyId,definition:{...field,key:'salary'},active:true});
  const sensitive=await saveLetterField(author,{companyId:b.companyId,expectedOrdinal:1,definition:{key:'salary',label:'Salary',description:'Canonical basic salary',kind:'currency',source:'compensation.basicSalary',required:true,editable:false,sensitive:true},active:true}),template=await saveLetterTemplate(author,{companyId:b.companyId,code:'CONFIDENTIAL',name:'Confidential template',category:'salary',effectiveFrom:todayInKualaLumpur(),document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'field',key:'salary'}]}]},fieldVersionIds:[sensitive.id]});
  const hired=await hireEmployee(author,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur(),employeeCode:'EDITOR-1',person:{fullName:'Fictional template editor',primaryEmail:'editor@fixture.test'}}),[employee]=await owner.db.select().from(s.employment).where(eq(s.employment.id,hired.employmentId)),userId=await createAppUser(b.tenantId,employee.personId,'employee'),editor={...await entitledCtx(b,['employee']),userId,personId:employee.personId};
  for(const capability of ['read','template'] as const)await saveLetterPermission(author,{companyId:b.companyId,role:'employee',capability,allowed:true});
  expect((await listLetterFields(editor,{companyId:b.companyId})).items).toEqual([]);expect((await withTenant(editor,tx=>tx.select().from(s.letterMergeFieldVersion))).map(row=>row.id)).toEqual([publicVersion.id]);expect(await getLetterField(editor,publicVersion.id)).toMatchObject({isLatest:false});expect(await getLetterField(editor,sensitive.id)).toBeNull();await expect(getLetterTemplate(editor,template.versionId)).rejects.toMatchObject({code:'permission'});
  await expect(saveLetterTemplate(editor,{companyId:b.companyId,code:'UNAUTHORISED',name:'Not permitted',category:'salary',effectiveFrom:todayInKualaLumpur(),document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'field',key:'salary'}]}]},fieldVersionIds:[sensitive.id]})).rejects.toMatchObject({code:'configuration'});expect(await owner.db.select().from(s.letterTemplate)).toHaveLength(1);
  const current=await saveLetterField(author,{companyId:b.companyId,expectedOrdinal:2,definition:{...field,key:'salary',source:'custom.text'},active:true});expect(await getLetterField(editor,current.id)).toMatchObject({isLatest:true,inUse:true});expect((await letterFieldDependencies(editor,{fieldVersionId:current.id})).rows).toEqual([]);
  await expect(saveLetterField(editor,{companyId:b.companyId,expectedOrdinal:3,definition:{...field,key:'salary',source:'custom.text'},active:false})).rejects.toMatchObject({code:'conflict'});
  await expect(withTenant(editor,tx=>tx.insert(s.letterMergeFieldVersion).values({tenantId:b.tenantId,companyId:b.companyId,key:'salary',ordinal:4,active:false,definition:{...field,key:'salary',source:'custom.text'},createdBy:editor.userId!}))).rejects.toMatchObject({cause:{code:'23514'}});
 });
 it('searches only the current mapping and rejects stale edits without changing history',async()=>{
  const first=await saveLetterField(author,{companyId:b.companyId,definition:field,active:true});const next=await saveLetterField(author,{companyId:b.companyId,expectedOrdinal:first.ordinal,definition:{...field,label:'Company display',source:'company.name'},active:true});expect((await listLetterFields(author,{companyId:b.companyId,search:'Employee name'})).items).toEqual([]);expect((await listLetterFields(author,{companyId:b.companyId,group:'employee'})).items).toEqual([]);expect((await listLetterFields(author,{companyId:b.companyId,group:'company'})).items.map(row=>row.id)).toEqual([next.id]);
  await expect(saveLetterField(author,{companyId:b.companyId,expectedOrdinal:first.ordinal,definition:field,active:true})).rejects.toMatchObject({code:'stale'});expect((await letterFieldHistory(author,{companyId:b.companyId,key:field.key,limit:1}))).toMatchObject({rows:[{ordinal:2}],nextCursor:2});expect((await letterFieldHistory(author,{companyId:b.companyId,key:field.key,cursor:2})).rows.map(row=>row.ordinal)).toEqual([1]);
 });
 it('enforces typed mappings and editability at the database boundary',async()=>{
  const invalid=[{...field,source:'SELECT salary FROM compensation'},{...field,editable:true},{...field,kind:'date'}];
  for(const [index,definition]of invalid.entries()){const key='invalidMapping'+index;await expect(withTenant(author,tx=>tx.insert(s.letterMergeFieldVersion).values({tenantId:b.tenantId,companyId:b.companyId,key,ordinal:1,active:true,definition:{...definition,key} as typeof field,createdBy:author.userId!}))).rejects.toMatchObject({cause:{code:'23514'}});}
  expect(await owner.db.select().from(s.letterMergeFieldVersion)).toHaveLength(0);
 });
 it('requires a configured public verification origin before enabling an issuance policy',async()=>{
  vi.stubEnv('NEXT_PUBLIC_WORKOS_REDIRECT_URI','');await expect(saveLetterPolicy(author,{companyId:b.companyId,category:'confirmation',enabled:true,policy:policy()})).rejects.toMatchObject({code:'configuration',detail:'publicOrigin'});expect(await owner.db.select().from(s.letterPolicyVersion)).toHaveLength(0);
 });

 it('binds presentation to eligible company signers and immutable letterhead assets',async()=>{
  const mapping=await saveLetterField(author,{companyId:b.companyId,definition:field,active:true}),content=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh2kAAAAASUVORK5CYII=','base64');
  const head=await addLetterAsset(author,{companyId:b.companyId,kind:'letterhead',name:'Fictional letterhead',content}),signature=await addLetterAsset(approver,{companyId:b.companyId,kind:'signature',name:'Private signature',content});
  expect((await listLetterTemplateHeads(author,{companyId:b.companyId})).rows).toEqual([{id:head.id,name:'Fictional letterhead'}]);
  const signers=await listLetterSignatories(author,{companyId:b.companyId,search:'Fictional letter approver',limit:1});expect(signers.rows).toEqual([{id:approver.userId!,name:'Fictional letter approver'}]);expect(signers.nextCursor).toBeNull();
  const input={companyId:b.companyId,code:'PRESENTATION',name:'Presented letter',category:'confirmation',effectiveFrom:todayInKualaLumpur(),document,fieldVersionIds:[mapping.id]},presentation={letterheadAssetId:head.id,signatoryUserId:approver.userId!};
  const saved=await saveLetterTemplate(author,{...input,presentation});expect(await getLetterTemplate(author,saved.versionId)).toMatchObject({version:{presentation}});
  await expect(saveLetterTemplate(author,{...input,code:'SIGNATURE',presentation:{...presentation,letterheadAssetId:signature.id}})).rejects.toMatchObject({code:'configuration',detail:'letterhead'});
  await expect(withTenant(author,tx=>tx.insert(s.letterTemplateVersion).values({tenantId:b.tenantId,companyId:b.companyId,templateId:saved.templateId,ordinal:2,name:input.name,category:input.category,document:document as (typeof s.letterTemplateVersion.$inferInsert)['document'],effectiveFrom:input.effectiveFrom,createdBy:author.userId!,presentation:{...presentation,letterheadAssetId:signature.id}})))).rejects.toMatchObject({cause:{code:'23514'}});
  await expect(withTenant(author,tx=>tx.update(s.letterTemplateVersion).set({presentation:{...presentation,letterheadAssetId:null}}).where(eq(s.letterTemplateVersion.id,saved.versionId)))).rejects.toMatchObject({cause:{message:expect.stringMatching(/immutable/)}});
  await saveLetterPermission(author,{companyId:b.companyId,role:'hr_admin',capability:'approve',allowed:false});
  expect((await listLetterSignatories(author,{companyId:b.companyId})).rows).toEqual([]);
  await expect(saveLetterTemplate(author,{...input,code:'INELIGIBLE',presentation})).rejects.toMatchObject({code:'configuration',detail:'signatory'});expect(await owner.db.select().from(s.letterTemplateVersion)).toHaveLength(1);
 });
 it('requires a separate template approver and preserves the exact approved version when editing',async()=>{
  const first=await draft();expect((await owner.db.select().from(s.letterTemplateVersion))[0].status).toBe('draft');
  await decideLetterTemplate(author,{versionId:first.versionId,expectedStatus:'draft',action:'submit'});await expect(decideLetterTemplate(author,{versionId:first.versionId,expectedStatus:'submitted',action:'approve'})).rejects.toMatchObject({code:'selfApproval'});
  const approved=await decideLetterTemplate(approver,{versionId:first.versionId,expectedStatus:'submitted',action:'approve'});expect(approved).toMatchObject({status:'approved',approvedBy:approver.userId,document});
  const [binding]=await owner.db.select().from(s.letterTemplateField).where(eq(s.letterTemplateField.templateVersionId,first.versionId));
  const second=await saveLetterTemplate(author,{companyId:b.companyId,templateId:first.templateId,expectedRevision:first.revision,code:'CONFIRMATION',name:'Revised confirmation',category:'confirmation',effectiveFrom:todayInKualaLumpur(),document:{...document,blocks:[{type:'paragraph',content:[{type:'text',text:'Revised wording'}]}]},fieldVersionIds:[binding.fieldVersionId]});
  expect(second.versionId).not.toBe(first.versionId);const versions=await owner.db.select().from(s.letterTemplateVersion).orderBy(asc(s.letterTemplateVersion.ordinal));expect(versions.map(version=>version.status)).toEqual(['approved','draft']);expect(versions[0]).toEqual(approved);
  expect((await listLetterTemplates(author,{companyId:b.companyId})).rows.map(row=>row.version.id)).toEqual([second.versionId]);expect((await listLetterTemplates(author,{companyId:b.companyId,mode:'active'})).rows.map(row=>row.version.id)).toEqual([first.versionId]);expect((await listLetterTemplateVersions(author,{templateId:first.templateId})).rows.map(row=>row.ordinal)).toEqual([2,1]);expect(await getLetterTemplate(author,first.versionId)).toMatchObject({version:{document},fields:[{id:binding.fieldVersionId}]});expect((await letterFieldDependencies(author,{fieldVersionId:binding.fieldVersionId})).rows.map(row=>row.versionId)).toEqual([first.versionId]);
  await expect(withTenant(author,tx=>tx.update(s.letterTemplateVersion).set({name:'Replaced wording'}).where(eq(s.letterTemplateVersion.id,first.versionId)))).rejects.toMatchObject({cause:{message:expect.stringMatching(/immutable/)}});
  expect((await owner.db.select().from(s.letterTemplateVersion).where(eq(s.letterTemplateVersion.id,first.versionId)))[0]).toEqual(approved);
 });

 it('converts editor content using fresh scoped mappings and persists only the canonical document',async()=>{
  const mapping=await saveLetterField(author,{companyId:b.companyId,definition:field,active:true});
  const editor={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Dear ',marks:[{type:'bold'}]},{type:'letterField',attrs:{key:field.key}}]}]};
  const input={companyId:b.companyId,code:'EDITOR',name:'Rich text letter',category:'confirmation',effectiveFrom:todayInKualaLumpur(),editor,language:'en' as const,fieldVersionIds:[mapping.id]};
  const saved=await saveLetterTemplate(author,input),[version]=await owner.db.select().from(s.letterTemplateVersion).where(eq(s.letterTemplateVersion.id,saved.versionId));
  expect(version.document).toEqual({version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'Dear ',marks:['bold']},{type:'field',key:field.key}]}]});
  expect(JSON.stringify(version.document)).not.toContain('letterField');
  await expect(saveLetterTemplate(author,{...input,code:'UNKNOWN',editor:{type:'doc',content:[{type:'paragraph',content:[{type:'letterField',attrs:{key:'unauthorised'}}]}]}})).rejects.toMatchObject({code:'unknownField'});
  await expect(saveLetterTemplate(author,{...input,code:'RAW',editor:{type:'doc',content:[{type:'html',text:'<script>bad()</script>'}]}})).rejects.toMatchObject({code:'invalid'});
  await saveLetterField(author,{companyId:b.companyId,expectedOrdinal:mapping.ordinal,definition:{...field,label:'Updated mapping'},active:true});
  await expect(saveLetterTemplate(author,{...input,code:'STALE'})).rejects.toMatchObject({code:'configuration'});
  expect(await owner.db.select().from(s.letterTemplateVersion)).toHaveLength(1);
 });
 it('rejects unknown merge fields before creating a template and prevents deactivating a referenced field',async()=>{
  await expect(saveLetterTemplate(author,{companyId:b.companyId,code:'INVALID',name:'Invalid',category:'confirmation',effectiveFrom:todayInKualaLumpur(),document,fieldVersionIds:[]})).rejects.toMatchObject({code:'unknownField'});expect(await owner.db.select().from(s.letterTemplate)).toHaveLength(0);
  const saved=await draft();await expect(saveLetterField(author,{companyId:b.companyId,definition:field,active:false,expectedOrdinal:1})).rejects.toMatchObject({code:'conflict'});
  await setLetterTemplateActive(author,{templateId:saved.templateId,expectedRevision:saved.revision,active:false});await saveLetterField(author,{companyId:b.companyId,definition:field,active:false,expectedOrdinal:1});
  expect((await listLetterFields(author,{companyId:b.companyId})).items).toMatchObject([{active:false,ordinal:2}]);expect(await owner.db.select().from(s.letterTemplateVersion)).toHaveLength(1);
 });
 it('versions policy without altering the old chain and rejects inactive or unauthorised approvers',async()=>{
  const saved=await saveLetterPolicy(author,{companyId:b.companyId,category:'confirmation',enabled:true,policy:policy()});
  const next=await saveLetterPolicy(author,{companyId:b.companyId,category:'confirmation',enabled:true,policy:{...policy(),retentionDays:730}});expect(next.ordinal).toBe(2);expect((await owner.db.select().from(s.letterPolicyVersion).where(eq(s.letterPolicyVersion.id,saved.id)))[0].policy.retentionDays).toBe(365);
  expect((await letterPolicyHistory(author,{companyId:b.companyId,category:'confirmation',limit:1}))).toMatchObject({rows:[{ordinal:2}],nextCursor:2});expect((await letterPolicyHistory(author,{companyId:b.companyId,category:'confirmation',cursor:2})).rows.map(row=>row.ordinal)).toEqual([1]);
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,approver.userId!));await expect(saveLetterPolicy(author,{companyId:b.companyId,category:'confirmation',enabled:true,policy:policy()})).rejects.toMatchObject({code:'configuration'});expect(await owner.db.select().from(s.letterPolicyVersion)).toHaveLength(2);
 });
 it('keeps signature bytes owner-only while settings may select their safe metadata',async()=>{
  const content=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh2kAAAAASUVORK5CYII=','base64');
  const image=await addLetterAsset(approver,{companyId:b.companyId,kind:'signature',name:'Own signature.png',content});
  expect(await withTenant(author,tx=>tx.select().from(s.letterAsset).where(eq(s.letterAsset.id,image.id)))).toEqual([]);expect(await letterAssetChoices(author,b.companyId)).toMatchObject([{id:image.id,owner_user_id:approver.userId}]);
  expect((await saveLetterPolicy(author,{companyId:b.companyId,category:'confirmation',enabled:true,policy:{...policy(),signingMode:'stamp',signatureAssetId:image.id}})).ordinal).toBe(1);
  await expect(saveLetterPolicy(author,{companyId:b.companyId,category:'bad',enabled:true,policy:{...policy(),signatoryUserId:author.userId,stages:[{key:'signatory',label:'Signer',userIds:[author.userId],allowDelegation:false}],signingMode:'stamp',signatureAssetId:image.id}})).rejects.toMatchObject({code:'configuration'});
 });
 it('rechecks current purpose permission and tenant scope on every write',async()=>{
  await saveLetterPermission(author,{companyId:b.companyId,capability:'template',role:'hr_admin',allowed:false});await expect(saveLetterField(author,{companyId:b.companyId,definition:field,active:true})).rejects.toMatchObject({code:'permission'});expect(await owner.db.select().from(s.letterMergeFieldVersion)).toHaveLength(0);
  const other=await seedBase();expect((await letterCompanyAccess(author)).some(co=>co.id===other.companyId)).toBe(false);await expect(saveLetterField(author,{companyId:other.companyId,definition:field,active:true})).rejects.toMatchObject({code:'permission'});
 });
 it('installs RLS and required application privileges for the new persistence owners',async()=>{
  const names=['letter_asset','letter_policy_version','letter_merge_field_version','letter_template','letter_template_version','letter_generation_batch','letter_record','letter_revision','letter_approval_decision','letter_artifact','letter_recipient_event','letter_access_token','letter_job'];
  for(const name of names){const [row]=await owner.db.execute<{rls:boolean;allowed:boolean}>(sql`select c.relrowsecurity as rls,has_table_privilege('ai_hr_app',c.oid,'SELECT') AND has_table_privilege('ai_hr_app',c.oid,'INSERT') as allowed from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=${name}`);expect(row,name).toEqual({rls:true,allowed:true});}
 });
});
