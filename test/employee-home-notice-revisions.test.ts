import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createNotice,publishNotice,updateNotice,archiveNotice,getNotice,noticesForEmployment,markNoticeViewed,dismissNoticePopup,popupNoticeFor,noticeContentHistory,acknowledgeNotice,noticeAcknowledgementHistory,type NoticeInput} from '../core/notice';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const input=(more:Partial<NoticeInput>={}):NoticeInput=>({title:'Fictional retained notice',body:'Original factual content.',startOn:todayInKualaLumpur(),endOn:todayInKualaLumpur(),requiresAcknowledgement:true,...more});
async function employee(){
 const e=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional notice reader',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,e.personId,'employee');
 return {...e,ctx:{...adminCtx(b),userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} as SessionContext};
}
async function published(extra:Partial<NoticeInput>={}){
 const e=await employee(),n=await createNotice(adminCtx(b),input({...extra,targetMode:'individual',employmentIds:[e.employmentId]}));
 await publishNotice(adminCtx(b),n.id);return {e,id:n.id};
}
async function code(promise:Promise<unknown>){try{await promise;return null;}catch(error){let item=error as {code?:string;cause?:unknown};while(item){if(item.code)return item.code;item=item.cause as typeof item;}throw error;}}

describe('Retained Notice content and explicit recipient acknowledgement',()=>{
 it('retains original and changed content without revising for category/pin changes',async()=>{
  const n=await published();
  expect((await getNotice(adminCtx(b),n.id))?.contentVersion).toBe(1);
  let history=await noticeContentHistory(adminCtx(b),n.id);
  expect(history.map(r=>[r.ordinal,r.origin,r.authorUserId,r.body])).toEqual([[1,'publication',b.adminUserId,input().body]]);
  await updateNotice(adminCtx(b),n.id,input({pinned:true,category:'Benefits'}));
  expect((await getNotice(adminCtx(b),n.id))?.contentVersion).toBe(1);
  await updateNotice(adminCtx(b),n.id,input({body:'Revised factual content.',pinned:true,category:'Benefits'}));
  history=await noticeContentHistory(adminCtx(b),n.id);
  expect(history.map(r=>[r.ordinal,r.origin,r.body])).toEqual([[2,'edit','Revised factual content.'],[1,'publication',input().body]]);
  expect(await noticeContentHistory(n.e.ctx,n.id)).toEqual([]);
  expect(await code(withTenant(adminCtx(b),tx=>tx.update(s.noticeRevision).set({body:'Overwrite'}).where(eq(s.noticeRevision.id,history[0].id))))).toBe('42501');
  expect(await code(owner.db.update(s.noticeRevision).set({body:'Overwrite'}).where(eq(s.noticeRevision.id,history[0].id)))).toBe('23514');
 });
 it('opening and dismissing do not acknowledge; explicit retries retain one actual receipt and event',async()=>{
  const n=await published({popupEnabled:true,popupFrequency:'until_acknowledged'});
  await markNoticeViewed(n.e.ctx,n.id,n.e.employmentId);await dismissNoticePopup(n.e.ctx,n.id,n.e.employmentId);
  let rows=await noticesForEmployment(n.e.ctx,n.e.employmentId);expect(rows[0].firstViewedAt).not.toBeNull();expect(rows[0].acknowledgedAt).toBeNull();expect(popupNoticeFor(rows)?.id).toBe(n.id);
  const receipt=await acknowledgeNotice(n.e.ctx,n.id,n.e.employmentId,1,{reportedChannel:'web',reportedUserAgent:'Fictional browser'});
  expect(await acknowledgeNotice(n.e.ctx,n.id,n.e.employmentId,1)).toEqual(receipt);
  rows=await noticesForEmployment(n.e.ctx,n.e.employmentId);expect(new Date(rows[0].acknowledgedAt!).toISOString()).toBe(receipt.acknowledgedAt.toISOString());expect(popupNoticeFor(rows)).toBeNull();
  const evidence=await noticeAcknowledgementHistory(adminCtx(b),n.id);expect(evidence).toHaveLength(1);expect(evidence[0]).toMatchObject({id:receipt.id,actorUserId:n.e.ctx.userId,employmentId:n.e.employmentId,contentVersion:1});
  const events=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,n.id),eq(s.domainEvent.eventType,'notice.acknowledged')));
  expect(events).toHaveLength(1);expect(events[0]).toMatchObject({actorType:'user',actorId:n.e.ctx.userId,subjectEmploymentId:n.e.employmentId});
  expect(events[0].payload).toMatchObject({receiptId:receipt.id,contentVersion:1,companyId:null});
  expect((await withTenant(n.e.ctx,tx=>tx.select({id:s.domainEvent.id}).from(s.domainEvent).where(eq(s.domainEvent.id,events[0].id)))).map(e=>e.id)).toEqual([events[0].id]);
 });
 it('refuses an old page for new content and preserves separate receipts across later withdrawal',async()=>{
  const n=await published(),other=await employee();
  await updateNotice(adminCtx(b),n.id,input({body:'Changed before acknowledgement.'}));
  expect(await code(acknowledgeNotice(n.e.ctx,n.id,n.e.employmentId,1))).toBe('23514');
  const second=await acknowledgeNotice(n.e.ctx,n.id,n.e.employmentId,2);
  await updateNotice(adminCtx(b),n.id,input({body:'Third retained content.'}));
  expect((await noticesForEmployment(n.e.ctx,n.e.employmentId))[0].acknowledgedAt).toBeNull();
  const third=await acknowledgeNotice(n.e.ctx,n.id,n.e.employmentId,3);expect(third.id).not.toBe(second.id);
  await archiveNotice(adminCtx(b),n.id);
  expect(await noticesForEmployment(n.e.ctx,n.e.employmentId)).toEqual([]);
  expect(await acknowledgeNotice(n.e.ctx,n.id,n.e.employmentId,2)).toEqual(second);
  expect((await noticeAcknowledgementHistory(n.e.ctx,n.id)).map(r=>r.id)).toEqual([second.id,third.id]);
  expect(await noticeAcknowledgementHistory(other.ctx,n.id)).toEqual([]);
 });
 it('binds the actual current recipient and refuses forged direct receipt or acknowledgement event writes',async()=>{
  const n=await published(),other=await employee();
  expect(await code(acknowledgeNotice(other.ctx,n.id,n.e.employmentId,1))).toBe('42501');
  expect(await code(acknowledgeNotice(other.ctx,n.id,other.employmentId,1))).toBe('42501');
  expect(await code(withTenant(n.e.ctx,tx=>tx.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'notice',aggregateId:n.id,eventType:'notice.acknowledged',actorType:'user',actorId:n.e.ctx.userId!,subjectEmploymentId:n.e.employmentId,payload:{receiptId:randomUUID(),contentVersion:1}})))).toBe('42501');
  const [revision]=await noticeContentHistory(adminCtx(b),n.id),[recipient]=await owner.db.select().from(s.noticeRecipient).where(eq(s.noticeRecipient.noticeId,n.id));
  expect(await code(withTenant(n.e.ctx,tx=>tx.insert(s.noticeAcknowledgement).values({tenantId:b.tenantId,noticeId:n.id,revisionId:revision.id,contentVersion:1,recipientId:recipient.id,employmentId:n.e.employmentId,actorUserId:n.e.ctx.userId!,sourceEventId:randomUUID()})))).toBe('42501');
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,n.e.ctx.userId!));
  expect(await code(acknowledgeNotice(n.e.ctx,n.id,n.e.employmentId,1))).toBe('42501');
 });
 it('serializes two deliberate submissions into one immutable receipt',async()=>{
  const n=await published();
  const [a,c]=await Promise.all([acknowledgeNotice(n.e.ctx,n.id,n.e.employmentId,1),acknowledgeNotice(n.e.ctx,n.id,n.e.employmentId,1)]);
  expect(c).toEqual(a);
  expect(await code(owner.db.update(s.noticeAcknowledgement).set({actorUserId:b.adminUserId}).where(eq(s.noticeAcknowledgement.id,a.id)))).toBe('23514');
  expect((await noticeAcknowledgementHistory(n.e.ctx,n.id)).length).toBe(1);
 });
 it('keeps pin ordering and acknowledgement requirements independent',async()=>{
  const e=await employee(),ids:string[]=[];
  for(const pinned of [false,true]){const n=await createNotice(adminCtx(b),input({pinned,requiresAcknowledgement:false,targetMode:'individual',employmentIds:[e.employmentId]}));ids.push(n.id);await publishNotice(adminCtx(b),n.id);}
  expect((await noticesForEmployment(e.ctx,e.employmentId)).map(n=>n.id)).toEqual([ids[1],ids[0]]);
  expect(await code(acknowledgeNotice(e.ctx,ids[1],e.employmentId,1))).toBe('23514');
  await withTenant(adminCtx(b),tx=>tx.update(s.notice).set({contentVersion:999}).where(eq(s.notice.id,ids[1])));
  expect((await getNotice(adminCtx(b),ids[1]))?.contentVersion).toBe(1);
 });
});
