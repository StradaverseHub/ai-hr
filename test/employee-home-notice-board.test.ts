import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {listPendingTasks,pendingApprovalsCount} from '../core/approvals-inbox';
import {ownHomeSubjectSelection} from '../core/employee-home';
import {readOwnNotice,readOwnNoticeBoard,readEmployeeHomeNotices} from '../core/employee-home-notices';
import {createNotice,publishNotice,archiveNotice,markNoticeViewed,dismissNoticePopup,acknowledgeNotice,updateNotice,employeeNoticeBoard,employeeNoticeById,type NoticeInput} from '../core/notice';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function employee(role:'employee'|'hr_admin'='employee'){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Board reader',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:hired.personId,roles:[role],entitlements:harnessSnapshot(b.tenantId)};
 return {...hired,ctx};
}
const input=(employmentIds:string[],extra:Partial<NoticeInput>={}):NoticeInput=>({title:'Fictional visible announcement',summary:'Bounded factual preview.',body:'Fictional untransported body.',startOn:todayInKualaLumpur(),endOn:todayInKualaLumpur(),targetMode:'individual',employmentIds,...extra});
async function publish(employmentIds:string[],extra:Partial<NoticeInput>={}){
 const n=await createNotice(adminCtx(b),input(employmentIds,extra));await publishNotice(adminCtx(b),n.id);return n.id;
}
describe('Selected own Notice board and bounded metadata',()=>{
 it('keeps required acknowledgements in canonical assigned work until the actual version is acknowledged',async()=>{
  const e=await employee(),other=await employee('hr_admin');
  const id=await publish([e.employmentId],{requiresAcknowledgement:true,notifyOnPublish:false,popupEnabled:true});
  const tasks=()=>listPendingTasks(e.ctx,undefined,{attendance:false,claims:false});
  let rows=await tasks();expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({id:`${id}:${e.employmentId}:1`,kind:'noticeAcknowledgement',subjectName:'Fictional visible announcement',linkPath:`/notices/${id}?employmentId=${e.employmentId}`});
  expect(rows[0]).not.toHaveProperty('dueDate');expect(JSON.stringify(rows)).not.toContain('untransported body');
  expect(await listPendingTasks(e.ctx,undefined,{attendance:false,claims:false},{noticeAcknowledgements:false})).toEqual([]);
  expect(await pendingApprovalsCount(e.ctx,undefined,{attendance:false,claims:false})).toBe(0);
  expect(await listPendingTasks(other.ctx,undefined,{attendance:false,claims:false})).toEqual([]);
  await markNoticeViewed(e.ctx,id,e.employmentId);await dismissNoticePopup(e.ctx,id,e.employmentId);expect(await tasks()).toHaveLength(1);
  await acknowledgeNotice(e.ctx,id,e.employmentId,1);expect(await tasks()).toEqual([]);
  await updateNotice(adminCtx(b),id,input([e.employmentId],{requiresAcknowledgement:true,body:'Changed required content.'}));
  rows=await tasks();expect(rows).toHaveLength(1);expect(rows[0].id).toBe(`${id}:${e.employmentId}:2`);
  await archiveNotice(adminCtx(b),id);expect(await tasks()).toEqual([]);
 });
 it('counts the complete matching set independently of a bounded page and orders pins before newer notices',async()=>{
  const e=await employee(),ids:string[]=[];
  for(let i=0;i<23;i++)ids.push(await publish([e.employmentId],{title:'Fictional page '+i,category:'Policy',pinned:i===0,requiresAcknowledgement:i%2===0}));
  await markNoticeViewed(e.ctx,ids[0],e.employmentId);await acknowledgeNotice(e.ctx,ids[0],e.employmentId,1);
  const first=await readOwnNoticeBoard(e.ctx,e.employmentId,{pageSize:5});
  expect(first).toMatchObject({total:23,unread:22,acknowledgementRequired:11,page:1,pageSize:5,pages:5});
  expect(first.items).toHaveLength(5);expect(first.items[0].id).toBe(ids[0]);
  const home=await readEmployeeHomeNotices(e.ctx,e.employmentId);
  expect(home).toMatchObject({version:1,employmentId:e.employmentId,total:23,unread:22,acknowledgementRequired:11});
  expect(home.items.map(row=>row.id)).toEqual(first.items.map(row=>row.id));
  expect(home.items[0].acknowledgedAt).toEqual(first.items[0].acknowledgedAt!.toISOString());
  expect(JSON.stringify(home)).not.toMatch(/untransported body|attachmentIds|contentVersion|popup/);
  // Card reads have no viewing or acknowledgement side effect.
  expect((await readOwnNoticeBoard(e.ctx,e.employmentId,{pageSize:5})).unread).toBe(22);
  const second=await readOwnNoticeBoard(e.ctx,e.employmentId,{pageSize:5,page:2});expect(second.total).toBe(23);
  expect(second.items.every(n=>!first.items.some(a=>a.id===n.id))).toBe(true);
  const last=await readOwnNoticeBoard(e.ctx,e.employmentId,{pageSize:5,page:999999});expect(last.page).toBe(5);expect(last.items).toHaveLength(3);
  expect((await readOwnNoticeBoard(e.ctx,e.employmentId,{pageSize:999})).items).toHaveLength(20);
  for(const row of first.items){expect(row).not.toHaveProperty('body');expect(row).not.toHaveProperty('attachmentIds');expect(row).not.toHaveProperty('popupDismissedAt');}
  expect(JSON.stringify(first)).not.toContain('untransported body');
 });
 it('searches visible title, summary and body as literal substrings with exact category and current live eligibility',async()=>{
  const e=await employee(),other=await employee();
  const id=await publish([e.employmentId],{title:'Fictional 100% literal',summary:'Summary keyword',body:'Private body needle',category:'Policy'});
  await publish([e.employmentId],{title:'Fictional 1000 literal',category:'Benefits'});
  await publish([other.employmentId],{title:'Foreign secret keyword',category:'Policy'});
  for(const query of ['100%','keyword','body needle'])expect((await readOwnNoticeBoard(e.ctx,e.employmentId,{query})).items.map(n=>n.id)).toEqual([id]);
  expect((await readOwnNoticeBoard(e.ctx,e.employmentId,{query:'%',category:'Benefits'})).total).toBe(0);
  expect((await readOwnNoticeBoard(e.ctx,e.employmentId,{query:'Foreign secret'})).total).toBe(0);
  expect((await readOwnNotice(e.ctx,e.employmentId,id))?.body).toBe('Private body needle');
  await archiveNotice(adminCtx(b),id);expect(await readOwnNotice(e.ctx,e.employmentId,id)).toBeNull();
  expect((await readOwnNoticeBoard(e.ctx,e.employmentId,{category:'Policy'})).total).toBe(0);
 });
 it('does not substitute HR reach, a forged person or a revoked login for own employment',async()=>{
  const own=await employee('hr_admin'),other=await employee(),id=await publish([other.employmentId]);
  await expect(readOwnNoticeBoard(own.ctx,other.employmentId)).rejects.toMatchObject({code:'employmentUnavailable'});
  await expect(readOwnNotice({...own.ctx,personId:other.personId},other.employmentId,id)).rejects.toMatchObject({code:'employmentUnavailable'});
  expect((await readOwnNoticeBoard(own.ctx,own.employmentId)).total).toBe(0);
  expect((await employeeNoticeBoard(own.ctx,other.employmentId)).total).toBe(0);
  expect(await employeeNoticeById(own.ctx,other.employmentId,id)).toBeNull();
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,own.ctx.userId!));
  await expect(readOwnNoticeBoard(own.ctx,own.employmentId)).rejects.toMatchObject({code:'employmentUnavailable'});
 });
 it('keeps separate own employments and their acknowledgements without choosing the first implicitly',async()=>{
  const own=await employee();
  const [company]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional second Notice employer'}).returning();
  const [department]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:company.id,name:'Fictional second Notice department'}).returning();
  const other=await hireEmployee(adminCtx(b),{person:{id:own.personId},companyId:company.id,departmentId:department.id,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  expect((await ownHomeSubjectSelection(own.ctx)).state).toBe('choose');
  const id=await publish([own.employmentId,other.employmentId],{requiresAcknowledgement:true});
  await acknowledgeNotice(own.ctx,id,own.employmentId,1);
  expect((await readOwnNoticeBoard(own.ctx,own.employmentId)).acknowledgementRequired).toBe(0);
  expect((await readOwnNoticeBoard(own.ctx,other.employmentId)).acknowledgementRequired).toBe(1);
  await updateNotice(adminCtx(b),id,input([own.employmentId,other.employmentId],{body:'Material second version.',requiresAcknowledgement:true}));
  expect((await readOwnNoticeBoard(own.ctx,own.employmentId)).acknowledgementRequired).toBe(1);
 });
});
