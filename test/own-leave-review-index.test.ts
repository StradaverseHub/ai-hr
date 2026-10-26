/** Authored UNRUN. Actual owned custody/index queries and canonical preparation; no provider calls.
 * Raw terminal metadata fixtures test discovery bounds only, never canonical leave completion proof.
 */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {listOwnLeaveReviewsTx,prepareOwnLeaveReviewTx,reopenOwnLeaveReviewTx} from '../core/assistant-actions/own-leave-store';
import {createOwnLeaveBrowserHandler,OwnLeaveReviewIndexResult} from '../lib/assistant-actions/own-leave-http';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-review-index-master-secret');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});
async function subject(b=base,role:'employee'|'hr_admin'='employee'){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'PRIVATE INDEX PERSON',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 const ctx:SessionContext={...adminCtx(b),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]};
 return{...hired,ctx,companyId:b.companyId};
}
type Subject=Awaited<ReturnType<typeof subject>>;
async function terminal(who:Subject,createdAt:Date,id:string=randomUUID(),state:'discarded'|'expired'|'refused'='discarded'){
 const expiresAt=new Date(createdAt.getTime()+600000);
 await owner.db.execute(sql`insert into app.assistant_own_leave_review(id,tenant_id,user_id,person_id,employment_id,company_id,intent_digest,reviewed_digest,state,created_at,expires_at)
  values(${id}::uuid,${who.ctx.tenantId}::uuid,${who.ctx.userId}::uuid,${who.personId}::uuid,${who.employmentId}::uuid,${who.companyId}::uuid,NULL,NULL,${state},${createdAt},${expiresAt})`);
 return{actionId:id,state,createdAt:createdAt.toISOString(),expiresAt:expiresAt.toISOString()};
}
const list=(who:Subject)=>withTenant(who.ctx,tx=>listOwnLeaveReviewsTx(tx,who.ctx));
async function prepared(who:Subject){
 await grantAssistant(adminCtx(base),{appUserId:who.ctx.userId!});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:who.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));
 const nomination={action:'leave.apply',contractVersion:1,employmentId:who.employmentId,leaveTypeId:base.annualLeaveTypeId,date:next.toISOString().slice(0,10),durationType:'full_day'};
 const result=await withTenant(who.ctx,tx=>prepareOwnLeaveReviewTx(tx,who.ctx,nomination,{employmentId:who.employmentId,leaveTypeId:base.annualLeaveTypeId},{reason:'PRIVATE INDEX REASON',employeeRemark:'PRIVATE INDEX REMARK'},'en'));
 expect(result.kind).toBe('prepared');if(result.kind!=='prepared')throw Error('Missing canonical review fixture');return result.review;
}
describe('own authenticated metadata discovery',()=>{
 it('discovers the actual prepared action after lost response without text, hashes, subjects or source IDs',async()=>{
  const who=await subject(),review=await prepared(who),result=await list(who);
  expect(result.kind).toBe('review_index');expect(result.reviews).toHaveLength(1);
  expect(result.reviews[0]).toEqual({actionId:review.actionId,state:'awaiting_confirmation',createdAt:review.createdAt,expiresAt:review.expiresAt});
  expect(Object.keys(result.reviews[0]).sort()).toEqual(['actionId','createdAt','expiresAt','state']);
  const serialized=JSON.stringify(result);for(const secret of ['PRIVATE INDEX',who.personId,who.employmentId,who.companyId,base.tenantId,who.ctx.userId!,base.annualLeaveTypeId,review.reviewedDigest])expect(serialized).not.toContain(secret);
  expect(await owner.db.select().from(schema.leaveRequest)).toHaveLength(0);expect(await owner.db.select().from(schema.aiModelRun)).toHaveLength(0);
 });
 it('permits revoked Assistant grant metadata discovery while explicit reopen remains denied',async()=>{
  const who=await subject(),review=await prepared(who);await revokeAssistant(adminCtx(base),{appUserId:who.ctx.userId!});
  expect((await list(who)).reviews.map(row=>row.actionId)).toEqual([review.actionId]);
  await expect(withTenant(who.ctx,tx=>reopenOwnLeaveReviewTx(tx,who.ctx,review.actionId))).rejects.toThrow();
  expect(await owner.db.select().from(schema.leaveRequest)).toHaveLength(0);
 });
 it('never broadens to another login, person or tenant, including a group admin sharing the same person',async()=>{
  const a=await subject(),b=await subject(),foreignBase=await seedBase(),foreign=await subject(foreignBase);
  const own=await terminal(a,new Date(Date.now()-5000));await terminal(b,new Date(Date.now()-4000));await terminal(foreign,new Date(Date.now()-3000));
  expect((await list(a)).reviews).toEqual([own]);expect((await list(b)).reviews).toHaveLength(1);expect((await list(foreign)).reviews).toHaveLength(1);
  const adminId=await createAppUser(base.tenantId,a.personId,'hr_admin');
  const samePersonAdmin={...a,ctx:{...a.ctx,userId:adminId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]}};
  expect((await list(samePersonAdmin)).reviews).toEqual([]);
 });
 it('refuses blocked or mismatched calling principal and hides reviews after current person relinking',async()=>{
  const a=await subject(),b=await subject();await terminal(a,new Date(Date.now()-5000));
  await expect(withTenant({...a.ctx,personId:b.personId},tx=>listOwnLeaveReviewsTx(tx,{...a.ctx,personId:b.personId}))).rejects.toThrow();
  await owner.db.update(schema.appUser).set({personId:b.personId}).where(eq(schema.appUser.id,a.ctx.userId!));
  await expect(list(a)).rejects.toThrow();
  expect((await list({...a,ctx:{...a.ctx,personId:b.personId}})).reviews).toEqual([]);
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,a.ctx.userId!));
  await expect(list({...a,ctx:{...a.ctx,personId:b.personId}})).rejects.toThrow();
 });
 it('returns at most25 newest rows with stable action-ID ties and excludes metadata outside30day visibility',async()=>{
  const who=await subject(),stamp=new Date(Math.floor(Date.now()/1000)*1000-3600000),expected=[];
  for(let i=1;i<=30;i++){const id='11111111-1111-4111-8111-'+String(i).padStart(12,'0');expected.push(await terminal(who,stamp,id,i%2?'expired':'discarded'));}
  await terminal(who,new Date(Date.now()-31*86400000));
  const result=await list(who);expect(result.reviews).toEqual(expected.sort((a,b)=>b.actionId.localeCompare(a.actionId)).slice(0,25));
  expect(await list(who)).toEqual(result);
 });
 it('exposes only its fixed SQL projection and refuses ordinary app-role table scans',async()=>{
  const who=await subject();await terminal(who,new Date(Date.now()-5000));
  const raw=await withTenant(who.ctx,tx=>tx.execute(sql`select * from app.assistant_own_leave_reviews_index()`));
  expect(Object.keys(raw[0]).sort()).toEqual(['action_id','created_at','expires_at','state']);
  await expect(withTenant(who.ctx,tx=>tx.execute(sql`select * from app.assistant_own_leave_review`))).rejects.toThrow();
 });
});
const request=(body:unknown)=>new Request('https://fixture.test/api/assistant/own-leave',{method:'POST',headers:{origin:'https://fixture.test',host:'fixture.test','content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify(body)});
describe('fixed metadata-list browser graph',()=>{
 function handler(){const owners={authenticate:vi.fn(async()=>({actual:'cookie'})),list:vi.fn(async()=>({kind:'review_index',reviews:[]})),prepare:vi.fn(),reopen:vi.fn(),confirm:vi.fn(),discard:vi.fn()};return{owners,run:createOwnLeaveBrowserHandler(owners)};}
 it('authenticates explicit list with no selector and dispatches no content/effect owner',async()=>{
  const f=handler(),response=await f.run(request({operation:'list'}));expect(response.status).toBe(200);expect(await response.json()).toEqual({kind:'review_index',reviews:[]});
  expect(f.owners.list).toHaveBeenCalledWith({actual:'cookie'});for(const owner of [f.owners.prepare,f.owners.reopen,f.owners.confirm,f.owners.discard])expect(owner).not.toHaveBeenCalled();
 });
 it.each(['tenantId','userId','personId','employmentId','limit','cursor','confirmation'])('refuses posted %s before authentication',async field=>{
  const f=handler();expect((await f.run(request({operation:'list',[field]:'posted'}))).status).toBe(400);expect(f.owners.authenticate).not.toHaveBeenCalled();
 });
 it('refuses accidental private list fields at the actual HTTP result boundary',async()=>{
  const f=handler();f.owners.list.mockResolvedValueOnce({kind:'review_index',reviews:[{actionId:randomUUID(),state:'expired',createdAt:'2026-01-01T00:00:00.000Z',expiresAt:'2026-01-01T00:10:00.000Z',reason:'PRIVATE INDEX LEAK'}]} as never);
  const response=await f.run(request({operation:'list'}));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'unavailable'});
 });
 it('strictly refuses accidental text/hash/subject/source fields, duplicate actions and oversized lists',()=>{
  const row={actionId:randomUUID(),state:'expired',createdAt:'2026-01-01T00:00:00.000Z',expiresAt:'2026-01-01T00:10:00.000Z'};
  expect(OwnLeaveReviewIndexResult.safeParse({kind:'review_index',reviews:[row]}).success).toBe(true);
  for(const key of ['reason','reviewedDigest','employmentId','companyId','leaveRequestId','submissionEventId'])expect(OwnLeaveReviewIndexResult.safeParse({kind:'review_index',reviews:[{...row,[key]:'private'}]}).success).toBe(false);
  expect(OwnLeaveReviewIndexResult.safeParse({kind:'review_index',reviews:[row,row]}).success).toBe(false);
  expect(OwnLeaveReviewIndexResult.safeParse({kind:'review_index',reviews:Array.from({length:26},()=>({...row,actionId:randomUUID()}))}).success).toBe(false);
 });
});
