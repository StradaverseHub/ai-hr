/** Authored UNRUN. Source seam only; shared custody/browser/security journey is still required. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {createArticle,updateDocument} from '../core/knowledge-base';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {prepareKnowledgeArticleSourceTx,confirmKnowledgeArticleSourceTx,reconcileKnowledgeArticleSourceTx} from '../core/assistant-actions/knowledge-article-source';
import {KNOWLEDGE_ARTICLE_ACTION,KnowledgeArticleHumanContent,KnowledgeArticleConfirmation} from '../lib/assistant-actions/knowledge-article-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base,ctx:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');ctx=adminCtx(base);await grantAssistant(ctx,{appUserId:base.adminUserId});});
const human=()=>({action:KNOWLEDGE_ARTICLE_ACTION,contractVersion:1 as const,title:'  Fictional human article  ',body:'PRIVATE human-authored training example',category:'Human Training',audience:'employee' as const});
const prepare=(value:unknown=human(),actor=ctx)=>withTenant(actor,tx=>prepareKnowledgeArticleSourceTx(tx,actor,value));
const confirm=(review:Awaited<ReturnType<typeof prepare>>,actor=ctx)=>withTenant(actor,tx=>confirmKnowledgeArticleSourceTx(tx,actor,review.content,{action:KNOWLEDGE_ARTICLE_ACTION,contractVersion:1,reviewedDigest:review.reviewedDigest}));
async function state(){return {documents:await owner.db.select().from(schema.kbDocument).where(eq(schema.kbDocument.tenantId,base.tenantId)).orderBy(schema.kbDocument.id),events:await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,base.tenantId),eq(schema.domainEvent.eventType,'kb.document.created'))).orderBy(schema.domainEvent.id)};}
describe('human-authored Knowledge Base creation source',()=>{
 it('accepts bounded human article fields only and never actor/functions/model policy or uploaded bytes',()=>{
  expect(KnowledgeArticleHumanContent.safeParse(human()).success).toBe(true);
  for(const extra of [{actor:{roles:['hr_admin']}},{service:'knowledge-base'},{attachment:Buffer.from('private')},{policy:'invented'},{confirm:true},{reviewedDigest:'a'.repeat(64)}])expect(KnowledgeArticleHumanContent.safeParse({...human(),...extra}).success).toBe(false);
  expect(KnowledgeArticleHumanContent.safeParse({...human(),body:'界'.repeat(10000)}).success).toBe(false);
  expect(KnowledgeArticleConfirmation.safeParse({action:KNOWLEDGE_ARTICLE_ACTION,contractVersion:1,reviewedDigest:'a'.repeat(64),body:'posted replacement'}).success).toBe(false);
 });
 it('reviews canonical normalized human content without publishing, then returns the exact native creation event',async()=>{
  const before=await state(),review=await prepare();expect(review.content).toMatchObject({title:'Fictional human article',category:'human-training',body:human().body,audience:'employee'});expect(review.consequence).toBe('publish_to_selected_audience');expect(await state()).toEqual(before);
  const receipt=await confirm(review),after=await state();expect(after.documents).toHaveLength(before.documents.length+1);expect(after.events).toHaveLength(before.events.length+1);
  const event=after.events.find(row=>row.id===receipt.createdEventId)!;expect(event).toMatchObject({aggregateId:receipt.articleId,actorId:ctx.userId,eventType:'kb.document.created',subjectEmploymentId:null});
  expect(after.documents.find(row=>row.id===receipt.articleId)).toMatchObject({title:review.content.title,body:review.content.body,category:review.content.category,audience:review.content.audience,createdByUserId:ctx.userId});expect(JSON.stringify(receipt)).not.toContain('PRIVATE');
 });
 it('preserves ordinary API return and the existing native creation event shape',async()=>{
  const result=await createArticle(ctx,{title:'Ordinary human guide',body:'Ordinary body',audience:'manager'});expect(Object.keys(result)).toEqual(['id']);const [event]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,result.id),eq(schema.domainEvent.eventType,'kb.document.created')));expect(event.payload).toEqual({kind:'article',title:'Ordinary human guide',category:'general',audience:'manager'});
 });
 // Knowledge Base is a CORE module (packs/catalog.ts isCore): always enabled, and tenant_module refuses any
 // row for it (0313 tenant_module_core_guard), so there is no tenant-level disable to exercise here.
 it('refuses current non-author permission, forged role carriers and Assistant revocation before publication; KB cannot be disabled',async()=>{
  const person=await hireEmployee(ctx,{person:{fullName:'Fictional reader',primaryEmail:randomUUID()+'@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()}),userId=await createAppUser(base.tenantId,person.personId,'employee');await grantAssistant(ctx,{appUserId:userId});const employee={...ctx,userId,personId:person.personId,roles:['employee'],grants:[{role:'employee' as const,companyId:null}]};const before=await state();await expect(prepare(human(),employee)).rejects.toThrow();await expect(prepare(human(),{...employee,roles:['hr_admin']})).rejects.toThrow();const review=await prepare();await revokeAssistant(ctx,{appUserId:ctx.userId!});await expect(confirm(review)).rejects.toThrow();await grantAssistant(ctx,{appUserId:ctx.userId!});await expect(setModule(base.tenantId,'knowledge_base','disabled')).rejects.toThrow();expect(await state()).toEqual(before);
 });
 it('refuses changed human content or foreign tenant and rolls back document and event on enclosing completion failure',async()=>{
  const review=await prepare(),before=await state();await expect(withTenant(ctx,tx=>confirmKnowledgeArticleSourceTx(tx,ctx,{...review.content,audience:'all'},{action:KNOWLEDGE_ARTICLE_ACTION,contractVersion:1,reviewedDigest:review.reviewedDigest}))).rejects.toThrow();await expect(confirm(review,{...ctx,tenantId:randomUUID()})).rejects.toThrow();
  await expect(withTenant(ctx,async tx=>{await confirmKnowledgeArticleSourceTx(tx,ctx,review.content,{action:KNOWLEDGE_ARTICLE_ACTION,contractVersion:1,reviewedDigest:review.reviewedDigest});throw Error('fictional custody failure');})).rejects.toThrow('fictional custody failure');expect(await state()).toEqual(before);await confirm(review);expect((await state()).documents).toHaveLength(before.documents.length+1);
 });
 it('reconciles native references without republishing or pretending later edits are original reviewed content',async()=>{
  const receipt=await confirm(await prepare());await updateDocument(ctx,{id:receipt.articleId,title:'Later human edit',body:'Later human-authored body',audience:'hr_admin'});const before=await state(),reference={articleId:receipt.articleId,createdEventId:receipt.createdEventId};expect(await withTenant(ctx,tx=>reconcileKnowledgeArticleSourceTx(tx,ctx,reference))).toMatchObject({...receipt,currentAudience:'hr_admin',proof:'recorded_creation_current_record'});expect(await state()).toEqual(before);
  for(const changed of [{...reference,articleId:randomUUID()},{...reference,createdEventId:randomUUID()},{...reference,body:'posted receipt content'}])await expect(withTenant(ctx,tx=>reconcileKnowledgeArticleSourceTx(tx,ctx,changed))).rejects.toThrow();
 });
 it('captures actual human text before awaits and never retargets a retained draft object',async()=>{
  const input=human(),expected=input.body;const review=await withTenant(ctx,async tx=>{const pending=prepareKnowledgeArticleSourceTx(tx,ctx,input);input.body='Retargeted after awaiting';return pending;});expect(review.content.body).toBe(expected);await confirm(review);const created=(await state()).documents.find(row=>row.title===review.content.title);expect(created?.body).toBe(expected);
 });
});
