/** Native equivalence at group scale. Synthetic read fixtures do not assert payroll arithmetic. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {employeeListContains,listEmployees,leaveRequestDateBreakdown,leaveRequestDateBreakdowns} from '../core/read';
import {pendingManagerReviewsFor,pendingManagerReviewsForEmployments} from '../core/employment-review';
import {recordPayrollAccess,recordPayrollAccessBatch,type PayrollAccessEntry} from '../core/payroll-audit/access-log';
import {verifyTenantChain} from '../core/audit-chain';
import {listPayrollCycles,listPayrollCyclesAcross} from '../core/payroll-cycle';
import {pgSqlState} from '../lib/db-error';
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

async function traced<T>(read:()=>Promise<T>){
 const options=database.client.options as {debug?:unknown},before=options.debug;
 const trace={statements:0,transactions:0,maxOpen:0};let open=0;
 options.debug=(_connection:number,text:string)=>{
  const statement=text.trim().toLowerCase();trace.statements++;
  if(statement.startsWith('begin')){trace.transactions++;open++;trace.maxOpen=Math.max(trace.maxOpen,open);}
  else if(statement==='commit'||statement==='rollback')open--;
 };
 try{return {value:await read(),trace};}finally{options.debug=before;}
}
function evidence(name:string,value:unknown){if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,name),JSON.stringify(value,null,2));}

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
 await owner.db.update(s.employment).set({personId:members[0].personId}).where(eq(s.employment.id,members[1].employmentId));
 await owner.db.insert(s.reportingLine).values(reviews.map(row=>({tenantId:b.tenantId,subordinateEmploymentId:row.employmentId,managerEmploymentId:row.managerEmploymentId!,lineType:'administrative' as const,validFrom:'2020-01-01'})));
 await owner.db.insert(s.employmentReview).values(reviews);
 const native=database.withTenant;
 const carriers:{readOnly:string;mode:string}[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(who:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(who,async tx=>{
  const value=await read(tx);
  const [mode]=await tx.execute<{readOnly:string;mode:string}>(sql`select current_setting('transaction_read_only') as "readOnly",app.access_lock_mode_held(${who.tenantId}::uuid) as mode`);
  carriers.push(mode);return value;
 },options));
 const legacyDates=await traced(async()=>{
  const result=new Map<string,Awaited<ReturnType<typeof leaveRequestDateBreakdown>>>();
  for(const row of requests)result.set(row.id,await leaveRequestDateBreakdown(ctx,row.id));return result;
 });
 const wanted=legacyDates.value;
 expect(spy).toHaveBeenCalledTimes(200);spy.mockClear();carriers.length=0;
 const batchDates=await traced(()=>leaveRequestDateBreakdowns(ctx,requests.map(r=>r.id)));
 expect(batchDates.value).toEqual(wanted);
 expect(spy).toHaveBeenCalledTimes(1);expect(carriers).toEqual([{readOnly:'on',mode:'S'}]);
 expect(legacyDates.trace.transactions).toBe(200);expect(batchDates.trace.transactions).toBe(1);
 expect(batchDates.trace.statements).toBeLessThan(legacyDates.trace.statements/10);
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
 // person_id is NOT NULL/FK-protected, so a physical dangling person is not a valid fixture. Hide the
 // actual person through the native privacy policy while retaining the referenced employment.
 await owner.db.update(s.person).set({voidedAt:new Date()}).where(eq(s.person.id,members[999].personId));
 expect(await native(ctx,tx=>tx.select({id:s.person.id}).from(s.person).where(eq(s.person.id,members[999].personId)))).toEqual([]);
 expect((await listEmployees(ctx)).some(row=>row.employmentId===members[999].employmentId)).toBe(false);
 expect(await employeeListContains(ctx,members[999].employmentId)).toBe(false);
 evidence('approval-query-batch3.json',{kind:'NATIVE_APPROVAL_QUERY_BATCH',releaseEligible:false,companies:70,employments:1000,requests:200,
  legacyDateTrace:legacyDates.trace,batchDateTrace:batchDates.trace,orderedRowsAndNativeRolesEquivalent:true,perManagerCap:200,managerQueueRows:210,hiddenPersonRefused:true});
},180000); // 200 legacy read transactions plus every role/scope are intentional equivalence evidence at group scale.

it('commits identical company audit entries and native hash links together, and rolls back every chunk on SQL refusal',async()=>{
 const {b,companies,ctx}=await groupFixture();
 await setSetting(b.tenantId,'audit.hash_chain_enabled',true);
 const entries:PayrollAccessEntry[]=companies.map(companyId=>({surface:'audit_view',action:'view',companyId,payPeriod:'2026-01'}));
 const native=database.withTenant,spy=vi.spyOn(database,'withTenant').mockImplementation(native);
 const legacyTrace=await traced(async()=>{for(const entry of entries)await recordPayrollAccess(ctx,entry);});
 expect(spy).toHaveBeenCalledTimes(70);spy.mockClear();
 const batchTrace=await traced(()=>recordPayrollAccessBatch(ctx,entries));const recorded=batchTrace.value;expect(spy).toHaveBeenCalledTimes(1);
 expect(legacyTrace.trace.transactions).toBe(70);expect(batchTrace.trace.transactions).toBe(1);
 expect(batchTrace.trace.statements).toBeLessThan(legacyTrace.trace.statements/4);
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
 // A normal shared reader can overlap the audited view; it must never need exclusive Access.
 await owner.db.transaction(async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+b.tenantId},0))`);
  await expect(recordPayrollAccessBatch(ctx,entries.slice(0,2))).resolves.toHaveLength(2);
 });
 const overlap=await traced(()=>Promise.all([recordPayrollAccessBatch(ctx,entries),recordPayrollAccess(ctx,entries[0])]));
 expect(overlap.trace.transactions).toBe(2);expect(overlap.trace.maxOpen).toBe(2);
 expect(await auditRows()).toHaveLength(213);expect((await verifyTenantChain(ctx)).valid).toBe(true);
 evidence('payroll-audit-batch3.json',{kind:'NATIVE_PAYROLL_ACCESS_BATCH',releaseEligible:false,companies:70,employments:1000,
  legacyTrace:legacyTrace.trace,batchTrace:batchTrace.trace,overlap:overlap.trace,eventsEquivalent:true,hashChainValid:true,sqlFailureRollsBackAllChunks:true});
 const auditorId=await createAppUser(b.tenantId,null,'employee');await grantAuditReader(ctx,{companyId:b.companyId,appUserId:auditorId});
 const auditor:SessionContext={...ctx,userId:auditorId,roles:['employee'],grants:[{role:'employee',companyId:null}],personId:null};
 // The auditor must never gain SELECT over its unsubjected domain-event row just to log access.
 let returningError:unknown;
 try{await database.withTenant(auditor,async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+b.tenantId},0))`);
  await tx.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'payroll-access',aggregateId:b.companyId,eventType:'payroll-data.accessed',actorType:'user',actorId:auditorId,payload:entries[0]}).returning({id:s.domainEvent.id});
 });}catch(error){returningError=error;}
 expect(pgSqlState(returningError)).toBe('42501');
 const single=await recordPayrollAccess(auditor,entries[0]),batch=await recordPayrollAccessBatch(auditor,[entries[0]]);
 expect(single.recorded).toBe(true);expect(batch[0].recorded).toBe(true);
 const ids=[single,...batch].flatMap(record=>record.recorded?[record.eventId]:[]);
 expect(await database.withTenant(auditor,tx=>tx.select({id:s.domainEvent.id}).from(s.domainEvent).where(sql`${s.domainEvent.id}=any(${'{'+ids.join(',')+'}'}::uuid[])`))).toEqual([]);
 expect((await auditRows()).filter(row=>ids.includes(row.id))).toHaveLength(2);
},180000); // Includes a 1,000-employment group,70-company chain equivalence and real rollback across two INSERT chunks.


it('rechecks selected membership after a committed privacy change while Access is being edited',async()=>{
 const {b,ctx,members}=await groupFixture();let pending:Promise<boolean>|undefined;
 try{
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`);
   const [holder]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);
   pending=employeeListContains(ctx,members[0].employmentId,[b.companyId]);void pending.catch(()=>undefined);
   let blocked=false;const deadline=performance.now()+3000;
   while(!blocked&&performance.now()<deadline){
    const [waiting]=await owner.db.execute<{blocked:boolean}>(sql`select exists(select 1 from pg_locks l where l.locktype='advisory' and not l.granted and ${holder.pid}::integer=any(pg_blocking_pids(l.pid))) as blocked`);
    blocked=waiting.blocked;if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(blocked,'the selected reader must wait for the actual exclusive editor').toBe(true);
   await tx.update(s.person).set({voidedAt:new Date()}).where(eq(s.person.id,members[0].personId));
  });
  expect(await pending).toBe(false);
  expect((await listEmployees(ctx,[b.companyId])).some(row=>row.employmentId===members[0].employmentId)).toBe(false);
 }finally{await pending?.catch(()=>undefined);}
},60000); // Group fixture plus a real observed advisory-lock wait; the ordinary wait budget stays unchanged.


it('reads the same ordered active and archived cycle catalogues once for the supplied company set',async()=>{
 const {b,ctx,companies,members}=await groupFixture();
 await owner.db.insert(s.payrollCycle).values(companies.flatMap(companyId=>[2,0,1].map(i=>({tenantId:b.tenantId,companyId,
  name:'Fictional cycle '+i,code:'QC'+i,runType:i===1?'bonus' as const:'regular' as const,sortOrder:i*10,
  archivedAt:i===2?new Date('2026-01-01T00:00:00Z'):null,remarks:i===1?'Same fixed bonus purpose':null}))));
 const ordered=[...companies].reverse();
 const legacy=async(who:SessionContext,ids:readonly string[],activeOnly:boolean)=>{const map=new Map<string,Awaited<ReturnType<typeof listPayrollCycles>>>();for(const id of ids)map.set(id,await listPayrollCycles(who,id,{activeOnly}));return map;};
 const before=await traced(()=>legacy(ctx,ordered,true));
 const after=await traced(()=>listPayrollCyclesAcross(ctx,ordered,{activeOnly:true}));
 expect(after.value).toEqual(before.value);expect([...after.value.keys()]).toEqual(ordered);expect(before.trace.transactions).toBe(70);expect(after.trace.transactions).toBe(1);
 expect(after.trace.statements).toBeLessThan(before.trace.statements/10);
 expect(after.value.get(b.companyId)?.map(row=>row.name)).toEqual(['Fictional cycle 0','Fictional cycle 1']);
 for(const role of s.roleEnum.enumValues)for(const companyId of role==='super_admin'?[null]:[null,b.companyId]){
  const who=await roleContext(b,members[0].personId,role,companyId);
  for(const activeOnly of [false,true]){
   const expected=await legacy(who,companies,activeOnly);
   expect(await listPayrollCyclesAcross(who,companies,{activeOnly})).toEqual(expected);
  }
 }
 expect(await listPayrollCyclesAcross(ctx,[])).toEqual(new Map());
 expect(await listPayrollCyclesAcross(ctx,[b.companyId,b.companyId])).toEqual(new Map([[b.companyId,await listPayrollCycles(ctx,b.companyId)]]));
 expect((await listPayrollCyclesAcross(ctx,[b.companyId.toUpperCase()])).get(b.companyId.toUpperCase())).toEqual(await listPayrollCycles(ctx,b.companyId.toUpperCase()));
 const foreign=adminCtx(await seedBase());expect(await listPayrollCyclesAcross(foreign,companies)).toEqual(new Map(companies.map(id=>[id,[]])));
 // A resumed draft's already-narrowed one-company input must never hydrate a broader catalogue.
 expect([...(await listPayrollCyclesAcross(ctx,[companies[4]],{activeOnly:true})).keys()]).toEqual([companies[4]]);
 evidence('payroll-cycle-batch3.json',{kind:'NATIVE_PAYROLL_CYCLE_CATALOGUE_BATCH',releaseEligible:false,companies:70,employments:1000,
  before:before.trace,after:after.trace,activeArchivedAndNativeRoleRowsEquivalent:true,companyOrderRetained:true,resumeScopeRetained:true});
},180000); // Group-scale old per-company oracle across every native role and active/archive modes.
