import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createNotice,duplicateNotice,publishNotice,updateNotice,archiveNotice,getNotice,noticesForEmployment,markNoticeViewed,dismissNoticePopup,popupNoticeFor,noticeContentHistory,acknowledgeNotice,noticeAcknowledgementHistory,addNoticeAttachment,getNoticeAttachment,noticeAttachmentMetadata,type NoticeInput} from '../core/notice';
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
 it('resolves the recorded sender only through an authorized live Notice without widening identity reads',async()=>{
  const publisher=await employee(),recipient=await employee(),other=await employee();
  await owner.db.update(s.person).set({fullName:'Fictional recorded publisher'}).where(eq(s.person.id,publisher.personId));
  await owner.db.update(s.appUser).set({personId:publisher.personId}).where(eq(s.appUser.id,b.adminUserId));
  const n=await createNotice(adminCtx(b),input({targetMode:'individual',employmentIds:[recipient.employmentId]}));await publishNotice(adminCtx(b),n.id);
  expect((await noticesForEmployment(recipient.ctx,recipient.employmentId))[0].publishedBy).toBe('Fictional recorded publisher');
  const [hidden]=await withTenant(other.ctx,tx=>tx.execute(sql`select app.notice_sender_display_name(${n.id}::uuid) as name`));expect(hidden.name).toBeNull();
  await archiveNotice(adminCtx(b),n.id);const [archived]=await withTenant(recipient.ctx,tx=>tx.execute(sql`select app.notice_sender_display_name(${n.id}::uuid) as name`));expect(archived.name).toBeNull();
 });

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


describe('Immutable Notice-owned attachments',()=>{
 it('duplicates the current selected files into a fresh draft without sharing mutable audience or file ownership',async()=>{
  const n=await published(),original=await addNoticeAttachment(adminCtx(b),n.id,1,{uploadKey:randomUUID(),fileName:'Fictional duplicate.txt',content:Buffer.from('Fictional immutable copy')});
  const copied=await duplicateNotice(adminCtx(b),n.id),draft=await getNotice(adminCtx(b),copied.id);
  expect(draft?.contentVersion).toBe(0);expect(draft?.publishedAt).toBeNull();expect(draft?.attachmentIds).toHaveLength(1);
  expect(draft!.attachmentIds[0]).not.toBe(original.id);
  expect((await getNoticeAttachment(adminCtx(b),copied.id,draft!.attachmentIds[0]))?.content.equals(Buffer.from('Fictional immutable copy'))).toBe(true);
  expect(await getNoticeAttachment(n.e.ctx,copied.id,draft!.attachmentIds[0])).toBeNull();expect(await noticeContentHistory(adminCtx(b),copied.id)).toEqual([]);
  await publishNotice(adminCtx(b),copied.id);
  expect((await getNoticeAttachment(n.e.ctx,copied.id,draft!.attachmentIds[0]))?.fileName).toBe('Fictional duplicate.txt');
  expect((await getNotice(adminCtx(b),n.id))?.attachmentIds).toEqual([original.id]);
 });

 it('allows staging a replacement when five files are already selected, then enforces five on save',async()=>{
  const n=await published();let version=1;const selected:string[]=[];
  for(let index=0;index<5;index++){const file=await addNoticeAttachment(adminCtx(b),n.id,version,{uploadKey:randomUUID(),fileName:'Fictional'+index+'.txt',content:Buffer.from('Fictional')});version=file.contentVersion;selected.push(file.id);}
  const replacement=await addNoticeAttachment(adminCtx(b),n.id,version,{uploadKey:randomUUID(),fileName:'Fictional replacement.txt',content:Buffer.from('Replacement')},{attach:false});
  expect(replacement.contentVersion).toBe(version);
  await expect(updateNotice(adminCtx(b),n.id,input({attachmentIds:[...selected,replacement.id],expectedContentVersion:version}))).rejects.toThrow(/five/);
  await updateNotice(adminCtx(b),n.id,input({attachmentIds:[...selected.slice(1),replacement.id],expectedContentVersion:version}));
  expect((await getNotice(adminCtx(b),n.id))?.contentVersion).toBe(version+1);
 });

 it('stages editor uploads without changing content or exposing bytes before the explicit save',async()=>{
  const n=await published(),file={uploadKey:randomUUID(),fileName:'Fictional staged.txt',content:Buffer.from('Fictional staged content')};
  const staged=await addNoticeAttachment(adminCtx(b),n.id,1,file,{attach:false});expect(staged.contentVersion).toBe(1);
  expect(await addNoticeAttachment(adminCtx(b),n.id,1,file,{attach:false})).toEqual(staged);
  expect((await getNotice(adminCtx(b),n.id))?.attachmentIds).toEqual([]);expect(await getNoticeAttachment(n.e.ctx,n.id,staged.id)).toBeNull();
  await updateNotice(adminCtx(b),n.id,input({body:'Explicitly saved revised content.',attachmentIds:[staged.id],expectedContentVersion:1}));
  expect((await getNotice(adminCtx(b),n.id))?.contentVersion).toBe(2);expect((await getNoticeAttachment(n.e.ctx,n.id,staged.id))?.content.equals(file.content)).toBe(true);
  await expect(addNoticeAttachment(adminCtx(b),n.id,1,file,{attach:false})).rejects.toThrow(/changed/);
 });

 it('attaches once per explicit upload intent, retains references in content and never returns bytes from metadata',async()=>{
  const n=await published(),upload={uploadKey:randomUUID(),fileName:'Fictional policy.txt',content:Buffer.from('Fictional reviewed attachment.')};
  const asset=await addNoticeAttachment(adminCtx(b),n.id,1,upload);expect(asset.contentVersion).toBe(2);
  expect(await addNoticeAttachment(adminCtx(b),n.id,1,upload)).toEqual(asset);
  const revisions=await noticeContentHistory(adminCtx(b),n.id);expect(revisions.map(r=>r.attachmentIds)).toEqual([[asset.id],[]]);
  const rows=await noticeAttachmentMetadata(n.e.ctx,n.id);expect(rows).toEqual([{id:asset.id,fileName:upload.fileName,mimeType:'text/plain',byteLength:upload.content.byteLength}]);
  expect((await getNoticeAttachment(n.e.ctx,n.id,asset.id))?.content.equals(upload.content)).toBe(true);
  expect(await code(owner.db.update(s.noticeAttachment).set({content:Buffer.from('Forged')}).where(eq(s.noticeAttachment.id,asset.id)))).toBe('23514');
  await expect(addNoticeAttachment(adminCtx(b),n.id,2,{...upload,content:Buffer.from('Different bytes')})).rejects.toThrow(/upload changed/);
 });
 it('rechecks actual audience, revocation and the current revision at byte download',async()=>{
  const n=await published(),other=await employee(),asset=await addNoticeAttachment(adminCtx(b),n.id,1,{uploadKey:randomUUID(),fileName:'Fictional policy.txt',content:Buffer.from('Fictional content')});
  expect(await getNoticeAttachment(other.ctx,n.id,asset.id)).toBeNull();expect(await noticeAttachmentMetadata(other.ctx,n.id)).toEqual([]);
  await updateNotice(adminCtx(b),n.id,input({attachmentIds:[]}));
  expect(await getNoticeAttachment(n.e.ctx,n.id,asset.id)).toBeNull();
  expect((await getNoticeAttachment(adminCtx(b),n.id,asset.id))?.id).toBe(asset.id);
  const history=await noticeContentHistory(adminCtx(b),n.id);expect(history.some(r=>r.attachmentIds.includes(asset.id))).toBe(true);
  expect(await code(owner.db.delete(s.noticeAttachment).where(eq(s.noticeAttachment.id,asset.id)))).toBe('23514');
 });
 it('refuses unsafe filenames, disguised types, foreign attachment references and stale uploads without side effects',async()=>{
  const n=await published(),file={uploadKey:randomUUID(),fileName:'../fictional.txt',content:Buffer.from('Fictional')};
  await expect(addNoticeAttachment(adminCtx(b),n.id,1,file)).rejects.toThrow(/safe name/);
  await expect(addNoticeAttachment(adminCtx(b),n.id,1,{...file,fileName:'fictional.pdf'})).rejects.toThrow(/contents or file type/);
  await expect(addNoticeAttachment(adminCtx(b),n.id,1,{...file,fileName:'fictional.html'})).rejects.toThrow(/contents or file type/);
  await expect(addNoticeAttachment(adminCtx(b),n.id,0,{...file,fileName:'fictional.txt'})).rejects.toThrow(/changed/);
  expect(await code(withTenant(adminCtx(b),tx=>tx.update(s.notice).set({attachmentIds:[randomUUID()]}).where(eq(s.notice.id,n.id))))).toBe('23514');
  expect(await owner.db.select({id:s.noticeAttachment.id}).from(s.noticeAttachment).where(eq(s.noticeAttachment.noticeId,n.id))).toEqual([]);
  expect((await getNotice(adminCtx(b),n.id))?.contentVersion).toBe(1);
 });
});
