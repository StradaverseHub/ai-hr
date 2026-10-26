import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {and,asc,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {saveLetterField,saveLetterTemplate,decideLetterTemplate,setLetterTemplateActive,saveLetterPolicy,saveLetterPermission,addLetterAsset,letterAssetChoices,listLetterFields,letterCompanyAccess} from '../core/letters';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {LetterPolicy} from '../lib/letter-workflow';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,author:SessionContext,approver:SessionContext;
const field={key:'employeeName',label:'Employee name',description:'Canonical employee name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false} as const;
const document={version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'Dear '},{type:'field',key:'employeeName'}]}]};
async function draft(){const definition=await saveLetterField(author,{companyId:b.companyId,definition:field,active:true});return saveLetterTemplate(author,{companyId:b.companyId,code:'CONFIRMATION',name:'Fictional confirmation',category:'confirmation',effectiveFrom:todayInKualaLumpur(),document,fieldVersionIds:[definition.id]});}
function policy():LetterPolicy{return {version:1,stages:[{key:'signatory',label:'Authorised Signatory',userIds:[approver.userId!],allowDelegation:false}],signatoryUserId:approver.userId!,signingMode:'authenticated',signatureAssetId:null,letterheadAssetId:null,referenceFormat:'HR/{YYYY}/{SEQ:6}',retentionDays:365,sensitiveLinkMinutes:15,acknowledgement:'acknowledge',approvalDueHours:48,acknowledgementDueDays:7,reminderHours:24,escalationUserId:null,portalNotifications:false,emailNotifications:false};}
beforeEach(async()=>{
 await resetDb();b=await seedBase();author=await entitledCtx(b);
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional letter approver',primaryEmail:'letter-approver@fixture.test'}).returning();
 const userId=await createAppUser(b.tenantId,person.id,'hr_admin');approver={...author,userId,personId:person.id};
});afterAll(closeAll);
describe('versioned Letters configuration and template owner',()=>{
 it('requires a separate template approver and preserves the exact approved version when editing',async()=>{
  const first=await draft();expect((await owner.db.select().from(s.letterTemplateVersion))[0].status).toBe('draft');
  await decideLetterTemplate(author,{versionId:first.versionId,expectedStatus:'draft',action:'submit'});await expect(decideLetterTemplate(author,{versionId:first.versionId,expectedStatus:'submitted',action:'approve'})).rejects.toMatchObject({code:'selfApproval'});
  const approved=await decideLetterTemplate(approver,{versionId:first.versionId,expectedStatus:'submitted',action:'approve'});expect(approved).toMatchObject({status:'approved',approvedBy:approver.userId,document});
  const [binding]=await owner.db.select().from(s.letterTemplateField).where(eq(s.letterTemplateField.templateVersionId,first.versionId));
  const second=await saveLetterTemplate(author,{companyId:b.companyId,templateId:first.templateId,expectedRevision:first.revision,code:'CONFIRMATION',name:'Revised confirmation',category:'confirmation',effectiveFrom:todayInKualaLumpur(),document:{...document,blocks:[{type:'paragraph',content:[{type:'text',text:'Revised wording'}]}]},fieldVersionIds:[binding.fieldVersionId]});
  expect(second.versionId).not.toBe(first.versionId);const versions=await owner.db.select().from(s.letterTemplateVersion).orderBy(asc(s.letterTemplateVersion.ordinal));expect(versions.map(version=>version.status)).toEqual(['approved','draft']);expect(versions[0]).toEqual(approved);
  await expect(withTenant(author,tx=>tx.update(s.letterTemplateVersion).set({name:'Replaced wording'}).where(eq(s.letterTemplateVersion.id,first.versionId)))).rejects.toMatchObject({cause:{message:expect.stringMatching(/immutable/)}});
  expect((await owner.db.select().from(s.letterTemplateVersion).where(eq(s.letterTemplateVersion.id,first.versionId)))[0]).toEqual(approved);
 });
 it('rejects unknown merge fields before creating a template and prevents deactivating a referenced field',async()=>{
  await expect(saveLetterTemplate(author,{companyId:b.companyId,code:'INVALID',name:'Invalid',category:'confirmation',effectiveFrom:todayInKualaLumpur(),document,fieldVersionIds:[]})).rejects.toMatchObject({code:'unknownField'});expect(await owner.db.select().from(s.letterTemplate)).toHaveLength(0);
  const saved=await draft();await expect(saveLetterField(author,{companyId:b.companyId,definition:field,active:false})).rejects.toMatchObject({code:'conflict'});
  await setLetterTemplateActive(author,{templateId:saved.templateId,expectedRevision:saved.revision,active:false});await saveLetterField(author,{companyId:b.companyId,definition:field,active:false});
  expect((await listLetterFields(author,{companyId:b.companyId})).items).toMatchObject([{active:false,ordinal:2}]);expect(await owner.db.select().from(s.letterTemplateVersion)).toHaveLength(1);
 });
 it('versions policy without altering the old chain and rejects inactive or unauthorised approvers',async()=>{
  const saved=await saveLetterPolicy(author,{companyId:b.companyId,category:'confirmation',enabled:true,policy:policy()});
  const next=await saveLetterPolicy(author,{companyId:b.companyId,category:'confirmation',enabled:true,policy:{...policy(),retentionDays:730}});expect(next.ordinal).toBe(2);expect((await owner.db.select().from(s.letterPolicyVersion).where(eq(s.letterPolicyVersion.id,saved.id)))[0].policy.retentionDays).toBe(365);
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
