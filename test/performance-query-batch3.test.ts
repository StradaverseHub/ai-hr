/** Native equivalence at group scale. Synthetic read fixtures do not assert payroll arithmetic. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {employeeListContains,listEmployees,leaveRequestDateBreakdown,leaveRequestDateBreakdowns} from '../core/read';
import {pendingManagerReviewsFor,pendingManagerReviewsForEmployments} from '../core/employment-review';
import {recordPayrollAccess,recordPayrollAccessBatch,type PayrollAccessEntry} from '../core/payroll-audit/access-log';
import {verifyTenantChain} from '../core/audit-chain';
import {grantAuditReader} from '../core/payroll-audit/settings';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setSetting,type Base} from './harness';

beforeAll(migrateTestDb);
afterEach(()=>vi.restoreAllMocks());
afterAll(closeAll);

async function groupFixture(){
 await resetDb();const b=await seedBase();
 const rest=await owner.db.insert(s.company).values(Array.from({length:69},(_,i)=>({tenantId:b.tenantId,legalName:'Fictional query group '+i}))).returning({id:s.company.id});
 const companies=[b.companyId,...rest.map(c=>c.id)];
 const members=Array.from({length:1000},(_,i)=>({personId:randomUUID(),employmentId:randomUUID(),companyId:companies[i%70]}));
 await owner.db.insert(s.person).values(members.map((r,i)=>({id:r.personId,tenantId:b.tenantId,fullName:'Fictional query subject '+String(i).padStart(4,'0'),primaryEmail:r.personId+'@fixture.invalid'})));
 await owner.db.insert(s.employment).values(members.map((r,i)=>({id:r.employmentId,tenantId:b.tenantId,personId:r.personId,companyId:r.companyId,employeeCode:'Q-'+i,hiredOn:'2020-01-01'})));
 return {b,companies,members,ctx:adminCtx(b)};
}
async function roleContext(b:Base,personId:string,role:(typeof s.roleEnum.enumValues)[number],companyId:string|null){
 const userId=await createAppUser(b.tenantId,personId,'employee');
 await owner.db.update(s.roleAssignment).set({role,companyId}).where(eq(s.roleAssignment.appUserId,userId));
 return {...adminCtx(b),userId,personId,roles:[role],grants:[{role,companyId}]} satisfies SessionContext;
}
const result=async<T>(read:()=>Promise<T>)=>{try{return {value:await read()};}catch(error){return {error:String(error)};}};

it('matches complete legacy membership, date breakdowns and per-manager queues with one native transaction per concern',async()=>{
 const {b,companies,members,ctx}=await groupFixture();
 const requests=Array.from({length:200},(_,i)=>({id:randomUUID(),tenantId:b.tenantId,employmentId:members[i].employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:'2026-01-12',endDate:'2026-01-13',days:'2'}));
 await owner.db.insert(s.leaveRequest).values(requests);
 // One ordinary request has no date packet; an unknown/foreign identity must not become a per-date control.
 await owner.db.insert(s.leaveRequestDate).values(requests.slice(1).flatMap((r,i)=>[
  {tenantId:b.tenantId,leaveRequestId:r.id,subjectEmploymentId:r.employmentId,leaveDate:'2026-01-12',days:'1',status:'approved' as const,decidedByEmploymentId:members[0].employmentId,decidedAt:new Date('2026-01-10T00:00:00Z')},
  {tenantId:b.tenantId,leaveRequestId:r.id,subjectEmploymentId:r.employmentId,leaveDate:'2026-01-13',days:'1',status:'pending' as const},
 ]));
 const reviews=Array.from({length:215},(_,i)=>({id:randomUUID(),tenantId:b.tenantId,employmentId:members[300+i].employmentId,personId:members[300+i].personId,
  reviewType:'contract' as const,endDate:'2026-02-28',dueDate:'2026-01-28',managerEmploymentId:members[i<205?0:1].employmentId,createdAt:new Date(Date.UTC(2026,0,1,0,0,i))}));
 await owner.db.insert(s.employmentReview).values(reviews);
 const native=database.withTenant;
 const carriers:{readOnly:string;mode:string}[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(who:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(who,async tx=>{
  const value=await read(tx);
  const [mode]=await tx.execute<{readOnly:string;mode:string}>(sql`select current_setting('transaction_read_only') as "readOnly",app.access_lock_mode_held(${who.tenantId}::uuid) as mode`);
  carriers.push(mode);return value;
 },options));
 const wanted=new Map<string,Awaited<ReturnType<typeof leaveRequestDateBreakdown>>>();
 for(const row of requests)wanted.set(row.id,await leaveRequestDateBreakdown(ctx,row.id));
 expect(spy).toHaveBeenCalledTimes(200);spy.mockClear();carriers.length=0;
 expect(await leaveRequestDateBreakdowns(ctx,requests.map(r=>r.id))).toEqual(wanted);
 expect(spy).toHaveBeenCalledTimes(1);expect(carriers).toEqual([{readOnly:'on',mode:'S'}]);
 expect(wanted.get(requests[0].id)).toEqual([]);expect(wanted.get(requests[1].id)).toHaveLength(2);
 expect((await leaveRequestDateBreakdowns(ctx,[requests[1].id.toUpperCase()])).get(requests[1].id.toUpperCase())).toEqual(wanted.get(requests[1].id));
 const managers=[members[1].employmentId,members[0].employmentId];
 spy.mockClear();
 const oldManagers=(await Promise.all(managers.map(id=>pendingManagerReviewsFor(ctx,id)))).flat();
 expect(spy).toHaveBeenCalledTimes(2);
 expect(oldManagers).toHaveLength(210);spy.mockClear();carriers.length=0;
 expect(await pendingManagerReviewsForEmployments(ctx,[...managers,managers[0]])).toEqual(oldManagers);
 expect(spy).toHaveBeenCalledTimes(1);expect(carriers).toEqual([{readOnly:'on',mode:'S'}]);
 // Every native role, both company and group scope; real assignments back every supplied context.
 for(const role of s.roleEnum.enumValues)for(const companyId of role==='super_admin'?[null]:[null,b.companyId]){
  const who=await roleContext(b,members[0].personId,role,companyId);
  for(const scope of [undefined,[],[b.companyId],[companies[1]]]){
   const legacy=await listEmployees(who,scope);
   for(const id of [members[0].employmentId,members[1].employmentId,members[70].employmentId,randomUUID()])
    expect(await employeeListContains(who,id,scope),`${role}:${companyId}:${scope}:${id}`).toBe(legacy.some(row=>row.employmentId===id));
  }
  const ids=[requests[0].id,requests[1].id,requests[70].id,randomUUID()];
  const expected=new Map(await Promise.all(ids.map(async id=>[id,await leaveRequestDateBreakdown(who,id)] as const)));
  expect(await leaveRequestDateBreakdowns(who,ids)).toEqual(expected);
  expect(await pendingManagerReviewsForEmployments(who,managers)).toEqual((await Promise.all(managers.map(id=>pendingManagerReviewsFor(who,id)))).flat());
 }
 const foreign=adminCtx(await seedBase());
 expect(await employeeListContains(foreign,members[0].employmentId,[b.companyId])).toBe(false);
 expect(await leaveRequestDateBreakdowns(foreign,requests.slice(0,3).map(r=>r.id))).toEqual(new Map(requests.slice(0,3).map(r=>[r.id,[]])));
 expect(await pendingManagerReviewsForEmployments(foreign,managers)).toEqual([]);
 for(const id of ['', 'not-a-uuid','A'+members[0].employmentId.slice(1),members[0].employmentId.replaceAll('-','')])
  expect(await employeeListContains(ctx,id)).toBe(false);
 expect(await leaveRequestDateBreakdowns(ctx,[])).toEqual(new Map());
 expect(await pendingManagerReviewsForEmployments(ctx,[])).toEqual([]);
 // Retained historical rows and absent-person rows keep the old list membership, without a new active-only rule.
 await owner.db.update(s.employment).set({terminatedOn:'2025-12-31'}).where(eq(s.employment.id,members[0].employmentId));
 expect(await employeeListContains(ctx,members[0].employmentId)).toBe((await listEmployees(ctx)).some(r=>r.employmentId===members[0].employmentId));
},180000); // 200 legacy read transactions plus every role/scope are intentional equivalence evidence at group scale.

it('commits identical company audit entries and native hash links together, and rolls back every chunk on SQL refusal',async()=>{
 const {b,companies,ctx}=await groupFixture();
 await setSetting(b.tenantId,'audit.hash_chain_enabled',true);
 const entries:PayrollAccessEntry[]=companies.map(companyId=>({surface:'audit_view',action:'view',companyId,payPeriod:'2026-01'}));
 const native=database.withTenant,spy=vi.spyOn(database,'withTenant').mockImplementation(native);
 for(const entry of entries)await recordPayrollAccess(ctx,entry);
 expect(spy).toHaveBeenCalledTimes(70);spy.mockClear();
 const recorded=await recordPayrollAccessBatch(ctx,entries);expect(spy).toHaveBeenCalledTimes(1);
 const auditRows=()=>owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,b.tenantId),eq(s.domainEvent.eventType,'payroll-data.accessed'))).orderBy(s.domainEvent.sequence);
 const rows=await auditRows();expect(rows).toHaveLength(140);
 const projection=(row:typeof rows[number])=>({tenantId:row.tenantId,actorType:row.actorType,actorId:row.actorId,aggregateType:row.aggregateType,aggregateId:row.aggregateId,subjectEmploymentId:row.subjectEmploymentId,payload:row.payload});
 expect(rows.slice(70).map(projection)).toEqual(rows.slice(0,70).map(projection));
 expect(recorded.map(record=>record.recorded?record.eventId:null)).toEqual(rows.slice(70).map(row=>row.id));
 expect(rows.map(row=>row.payload)).toEqual([...entries,...entries]);
 const verified=await verifyTenantChain(ctx);expect(verified.valid).toBe(true);expect(verified.checked).toBeGreaterThanOrEqual(140);
 // Deliberately reject a later INSERT chunk through a real database trigger in this disposable fixture.
 await owner.db.execute(sql`create function public.batch3_refuse_access_fixture() returns trigger language plpgsql as $$begin
  if new.event_type='payroll-data.accessed' and new.payload->>'detail'='fixture-refusal' then raise exception 'Fictional audit refusal';end if;return new;end$$`);
 await owner.db.execute(sql`create trigger batch3_refuse_access_fixture before insert on public.domain_event for each row execute function public.batch3_refuse_access_fixture()`);
 try{
  const attempts=Array.from({length:201},(_,i)=>({...entries[i%70],...(i===200?{detail:'fixture-refusal'}:{})}));
  await expect(recordPayrollAccessBatch(ctx,attempts)).rejects.toThrow();
 }finally{
  await owner.db.execute(sql`drop trigger if exists batch3_refuse_access_fixture on public.domain_event;drop function if exists public.batch3_refuse_access_fixture()`);
 }
 expect(await auditRows()).toEqual(rows);
 expect(await verifyTenantChain(ctx)).toEqual(verified);
 await expect(recordPayrollAccessBatch(ctx,[entries[0],{...entries[1],detail:'private salary RM 5000'}])).rejects.toThrow();
 expect(await auditRows()).toEqual(rows);
 const noLogin={...ctx,userId:undefined};expect(await recordPayrollAccessBatch(noLogin,entries.slice(0,2))).toEqual([{recorded:false,reason:'no_login'},{recorded:false,reason:'no_login'}]);
 const suspended={...ctx,entitlements:{...ctx.entitlements!,tenantStatus:'suspended' as const}};
 expect(await recordPayrollAccessBatch(suspended,entries.slice(0,1))).toEqual([{recorded:false,reason:'read_only_tenant'}]);
 await expect(recordPayrollAccessBatch({tenantId:b.tenantId,agent:{principalId:randomUUID(),enablements:[]}},entries)).rejects.toThrow('signed-in person');
 expect(await recordPayrollAccessBatch(ctx,[])).toEqual([]);
 const auditorId=await createAppUser(b.tenantId,null,'employee');await grantAuditReader(ctx,{companyId:b.companyId,appUserId:auditorId});
 const auditor:SessionContext={...ctx,userId:auditorId,roles:['employee'],grants:[{role:'employee',companyId:null}],personId:null};
 const old=await result(()=>recordPayrollAccess(auditor,entries[0])),batch=await result(()=>recordPayrollAccessBatch(auditor,[entries[0]]));
 if('error'in old)expect(batch).toEqual(old);else expect('value'in batch&&batch.value[0].recorded).toBe(true);
},180000); // Includes a 1,000-employment group,70-company chain equivalence and real rollback across two INSERT chunks.
