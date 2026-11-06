/** A concurrent real writer can disprove batching the processing audit's existing RC reads. */
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {and,eq,sql,type SQL} from 'drizzle-orm';
import * as schema from '../db/schema';
import {payrollAuditCapture} from '../db/payroll-audit-schema';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {withPayrollTenant} from '../core/module-gate';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch,generatePayslips} from '../core/payroll';
import {checkInTx} from '../core/attendance';
import {saveClaimDraft} from '../core/claims';
import {runInputsTx} from '../core/payroll-audit/inputs';
import {lockPayComponentCatalogReadTx} from '../core/pay-component-catalog-lock';
import {lockNativePayrollBatchPeriodTx} from '../core/payroll-period-lock';
import {lockPayrollOvertimeBatchContextTx} from '../core/payroll-overtime-pattern';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);

it('observes an in-window real Claims draft commit between audit reads while native processing barriers remain held',async()=>{
 await resetDb();
 const b=await seedBase(),root=adminCtx(b);
 const worker=await hireEmployee(root,{person:{fullName:'Fictional payroll/claim audit subject',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employeeCode:'0007',employmentType:'full_time',hiredOn:'2020-01-01'});
 await setCompensation(root,{employmentId:worker.employmentId,basicSalary:3000,effectiveFrom:'2020-01-01'});
 await setStatutoryProfileMY(root,{personId:worker.personId,icNumber:'900101015551',taxCategory:1,numChildren:0});
 const {batchId}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-01'});
 await generatePayslips(root,{batchId});
 const [type]=await owner.db.insert(schema.claimType).values({tenantId:b.tenantId,code:'AUDIT_RC',name:'Fictional audit RC type',requiresReceipt:false}).returning({id:schema.claimType.id});
 const actor:SessionContext={...root,userId:await createAppUser(b.tenantId,worker.personId,'employee'),personId:worker.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const month={start:'2026-01-01',end:'2026-01-31'},windows={attendance:month,overtime:month,leave:month,claim:month};
 let pending:Promise<{id:string}>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const receipt=await withPayrollTenant(root,async tx=>{
   await lockPayComponentCatalogReadTx(tx,root);
   expect(await lockNativePayrollBatchPeriodTx(tx,root,batchId)).toMatchObject({companyId:b.companyId,payPeriod:'2026-01'});
   await lockPayrollOvertimeBatchContextTx(tx,root,batchId);
   const [batch]=await tx.execute(sql`select id from public.payroll_batch where id=${batchId}::uuid for update`);
   expect(batch.id).toBe(batchId);
   const [isolation]=await tx.execute(sql`select current_setting('transaction_isolation') as isolation,pg_backend_pid() as pid`);expect(isolation.isolation).toBe('read committed');
   const barriers=async()=>Array.from(await tx.execute(sql`select classid::text,objid::text,objsubid,mode from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted order by classid,objid,objsubid,mode`));
   const beforeLocks=await barriers();expect(beforeLocks.filter(l=>l.mode==='ExclusiveLock').length).toBeGreaterThanOrEqual(2);
   const args={batchId,payPeriod:'2026-01',windows};
   const before=await runInputsTx(tx,args);expect(before.employments).toBe(1);expect(before.components.claims.rows).toBe(0);
   pending=saveClaimDraft(actor,{employmentId:worker.employmentId,claimTypeId:type.id,amount:12.34,incurredOn:'2026-01-15',description:'Fictional concurrent audit witness'});
   const outcome=await Promise.race([pending,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),10000);})]);
   if(timer)clearTimeout(timer);
   expect(outcome,'ordinary Claims draft committed while processing held its locks').not.toBeNull();
   const after=await runInputsTx(tx,args);expect(after.components.claims.rows).toBe(1);expect(after.components.claims.hash).not.toBe(before.components.claims.hash);
   const {claims:oldClaim,...oldRest}=before.components;const {claims:newClaim,...newRest}=after.components;
   expect(newRest).toEqual(oldRest);expect(after.results).toEqual(before.results);
   expect(await barriers()).toEqual(beforeLocks);
   return {kind:'NATIVE_PROCESSING_READ_COMMITTED_CLAIM_INTERLEAVE',releaseEligible:false,mode:isolation.isolation,heldLocks:beforeLocks.map(l=>l.mode),claimBefore:oldClaim.rows,claimAfter:newClaim.rows,claimDigestChanged:true,otherDigestsUnchanged:true};
  });
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-audit-processing-rc.json'),JSON.stringify(receipt,null,2));
 }finally{if(timer)clearTimeout(timer);await pending?.catch(()=>undefined);}
},60000);

const attendanceFrom='2026-01-01',attendanceTo='2026-01-31',otFrom='2026-01-10',otTo='2026-01-25';
const paidMembership=(batchId:string)=>sql`select p.employment_id from public.payslip p where p.batch_id=${batchId}::uuid`;
const attendanceRows=(members:SQL)=>sql`select a.* from public.attendance a where a.employment_id in (${members}) and a.attendance_date between ${attendanceFrom}::date and ${attendanceTo}::date`;
const overtimeRows=(members:SQL)=>sql`select a.id,a.employment_id,a.attendance_date,a.ot_minutes,a.ot_flat_minutes,a.ot00_minutes,a.ot10_minutes,a.ot15_minutes,a.ot20_minutes,a.ot30_minutes
 from public.attendance a where a.employment_id in (${members}) and a.attendance_date between ${otFrom}::date and ${otTo}::date and coalesce(a.ot_minutes,0)>0`;
const groupRows=(query:SQL)=>sql`select x.employment_id as e,count(*)::int as n,
 app.payroll_audit_hash(jsonb_agg(to_jsonb(x) order by x.id)::text) as h from (${query}) x group by x.employment_id`;
const memberCount=(members:SQL)=>sql`select count(distinct employment_id)::int as n from (${members}) m`;
const combined=(batchId:string)=>sql`with members as materialized (${paidMembership(batchId)})
 select 0 as kind,null::uuid as e,n,null::text as h from (${memberCount(sql`select employment_id from members`)}) c
 union all select 1 as kind,e,n,h from (${groupRows(attendanceRows(sql`select employment_id from members`))}) a
 union all select 2 as kind,e,n,h from (${groupRows(overtimeRows(sql`select employment_id from members`))}) o
 order by kind,e`;
type GroupRow={kind:number;e:string;n:number;h:string};
function fold(input:GroupRow[]){
 const hash=createHash('sha256');let rows=0;
 for(const row of input){rows+=Number(row.n);hash.update(`${row.e}:${Number(row.n)}:${row.h}\n`);}
 return {rows,hash:hash.digest('hex')};
}
const exactRows=async(tx:Tx,q:SQL)=>Array.from(await tx.execute(q)) as unknown as GroupRow[];
const groupReads=async(tx:Tx,batchId:string,group:boolean)=>{
 const membership=paidMembership(batchId);
 const count=memberCount(membership),attendance=groupRows(attendanceRows(membership)),overtime=groupRows(overtimeRows(membership));
 if(group){
  const all=await exactRows(tx,combined(batchId));
  return{employments:Number(all[0].n),attendance:fold(all.filter(r=>r.kind===1)),overtime:fold(all.filter(r=>r.kind===2)),digestRows:all.length};
 }
 const [n]=await exactRows(tx,count),a=await exactRows(tx,sql`${attendance} order by e`),o=await exactRows(tx,sql`${overtime} order by e`);
 return{employments:Number(n.n),attendance:fold(a),overtime:fold(o),digestRows:1+a.length+o.length};
};
async function loadAuditFixture(members:number){
 await resetDb();const b=await seedBase(),root=adminCtx(b);
 const worker=await hireEmployee(root,{person:{fullName:'Fictional payroll Attendance audit subject',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employeeCode:'0007',employmentType:'full_time',hiredOn:'2020-01-01'});
 await setCompensation(root,{employmentId:worker.employmentId,basicSalary:3000,effectiveFrom:'2020-01-01'});
 await setStatutoryProfileMY(root,{personId:worker.personId,icNumber:'900101015551',taxCategory:1,numChildren:0});
 const {batchId}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-01'});await generatePayslips(root,{batchId});
 const actor:SessionContext={...root,userId:await createAppUser(b.tenantId,worker.personId,'employee'),personId:worker.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const others=Array.from({length:members-1},(_,i)=>({id:randomUUID(),employmentId:randomUUID(),name:`Fictional attendance audit ${i}`}));
 const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
 for(let i=0;i<others.length;i+=100){
  const chunk=others.slice(i,i+100);
  await owner.db.insert(schema.person).values(chunk.map(v=>({id:v.id,tenantId:b.tenantId,fullName:v.name,primaryEmail:v.id+'@example.invalid'})));
  await owner.db.insert(schema.employment).values(chunk.map(v=>({id:v.employmentId,tenantId:b.tenantId,personId:v.id,companyId:b.companyId,hiredOn:'2020-01-01'})));
  // Isolated cardinality fixtures, never claim that cloning calculates money or clock results.
  await owner.db.insert(schema.payslip).values(chunk.map(v=>({...slip,id:randomUUID(),employmentId:v.employmentId})));
 }
 const employmentIds=[worker.employmentId,...others.map(v=>v.employmentId)];
 for(let i=0;i<employmentIds.length;i+=100){
  const chunk=employmentIds.slice(i,i+100);
  await owner.db.insert(schema.attendance).values(chunk.flatMap(employmentId=>[
   {tenantId:b.tenantId,employmentId,attendanceDate:'2026-01-01',status:'present' as const,otMinutes:30},
   {tenantId:b.tenantId,employmentId,attendanceDate:'2026-01-15',status:'present' as const,otMinutes:60},
   {tenantId:b.tenantId,employmentId,attendanceDate:'2026-01-25',status:'present' as const,otMinutes:15},
   {tenantId:b.tenantId,employmentId,attendanceDate:'2026-01-31',status:'present' as const,otMinutes:null},
   {tenantId:b.tenantId,employmentId,attendanceDate:'2020-01-01',status:'present' as const,otMinutes:30},
  ]));
 }
 for(const name of ['attendance','payslip','employment','person','role_assignment','reporting_line'])await owner.client.unsafe('analyze public.'+name);
 return{root,actor,worker,batchId,b};
}
async function processingTx<T>(ctx:SessionContext,batchId:string,fn:(tx:Tx)=>Promise<T>){
 return withPayrollTenant(ctx,async tx=>{
  await lockPayComponentCatalogReadTx(tx,ctx);await lockNativePayrollBatchPeriodTx(tx,ctx,batchId);await lockPayrollOvertimeBatchContextTx(tx,ctx,batchId);
  const [batch]=await tx.execute(sql`select id from public.payroll_batch where id=${batchId}::uuid for update`);expect(batch.id).toBe(batchId);
  await tx.execute(sql`set local timezone='UTC'`);
  return fn(tx);
 });
}

it.each([1,1001])('compares exact original/candidate/warm/restored count and Attendance digests for %i native members',async members=>{
 const {root,actor,batchId}=await loadAuditFixture(members),foreign=adminCtx(await seedBase());
 const windows={attendance:{start:attendanceFrom,end:attendanceTo},overtime:{start:otFrom,end:otTo},leave:{start:attendanceFrom,end:attendanceTo},claim:{start:attendanceFrom,end:attendanceTo}};
 const phases=await processingTx(root,batchId,async tx=>{
  const oracle=await runInputsTx(tx,{batchId,payPeriod:'2026-01',windows});
  expect(oracle.employments).toBe(members);
  expect(oracle.components.attendance.rows).toBe(4*members);
  expect(oracle.components.overtime.rows).toBe(2*members);
  const result=[];
  for(const [phase,group]of [['original',false],['candidate',true],['candidate-warm',true],['restored-original',false]] as const){
   let elapsedMs=0,digestRows=0;
   for(let i=0;i<5;i++){
    const start=performance.now(),v=await groupReads(tx,batchId,group);elapsedMs+=performance.now()-start;digestRows=v.digestRows;
    expect(v).toEqual({employments:oracle.employments,attendance:oracle.components.attendance,overtime:oracle.components.overtime,digestRows:1+2*members});
   }
   const plans=group?[combined(batchId)]:[memberCount(paidMembership(batchId)),sql`${groupRows(attendanceRows(paidMembership(batchId)))} order by e`,sql`${groupRows(overtimeRows(paidMembership(batchId)))} order by e`];
   result.push({phase,elapsedMs,digestRows,appStatementsPerRead:plans.length,plans:await Promise.all(plans.map(q=>tx.execute(sql`explain(analyze,buffers,settings,format json) ${q}`)))});
  }
  return result;
 });
 for(const [ctx,count]of [[actor,1],[foreign,0]] as const)await withTenant(ctx,async tx=>{
  await tx.execute(sql`set local timezone='UTC'`);
  const orig=await groupReads(tx,batchId,false);expect(orig.employments).toBe(count);expect(await groupReads(tx,batchId,true)).toEqual(orig);
 });
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-audit-attendance-cte-'+members+'.json'),JSON.stringify({kind:'NATIVE_PROCESSING_ATTENDANCE_MEMBERSHIP_CTE',releaseEligible:false,members,phases,bodyRowsPerEmployment:4,compactDigestRowsOnly:true},null,2));
},600000);

it('pins the actual clock writer until processing releases its native Access barrier',async()=>{
 const {root,worker,batchId}=await loadAuditFixture(1);
 let writer:Promise<unknown>|undefined,completed=false;
 try{
  await processingTx(root,batchId,async tx=>{
   const [holder]=await tx.execute(sql`select pg_backend_pid() as pid`);
   const baseline=await groupReads(tx,batchId,false);
   // Use the existing administrator route; employee web receipts require a separate photo fixture.
   writer=checkInTx(root,{employmentId:worker.employmentId,date:'2026-01-12',time:'09:00'}).finally(()=>{completed=true;});
   // Attach a handler immediately, while preserving the actual error for the later await.
   void writer.catch(()=>undefined);
   const until=performance.now()+7000;let blocked=false;
   while(!blocked&&!completed&&performance.now()<until){
    const [row]=await owner.db.execute(sql`select exists(select 1 from pg_locks l where l.locktype='advisory' and not l.granted and ${holder.pid}::integer=any(pg_blocking_pids(l.pid))) as blocked`);
    blocked=row.blocked===true;
    if(!blocked&&!completed)await new Promise(resolve=>setTimeout(resolve,15));
   }
   expect(blocked,'actual clock writer must be waiting on a held native advisory barrier').toBe(true);
   expect(await groupReads(tx,batchId,true)).toEqual(baseline);expect(completed).toBe(false);
  });
  await writer;
  await processingTx(root,batchId,async tx=>{
   const fresh=await groupReads(tx,batchId,false);expect(fresh.attendance.rows).toBe(5);
   expect(await groupReads(tx,batchId,true)).toEqual(fresh);
  });
 }finally{await writer?.catch(()=>undefined);}
},60000);

it('captures exact nonempty Attendance and OT evidence from the real Payroll processing owner',async()=>{
 const {root,worker,b}=await loadAuditFixture(1);
 await owner.db.insert(schema.attendance).values([
  {tenantId:b.tenantId,employmentId:worker.employmentId,attendanceDate:'2026-02-10',status:'present',otMinutes:30},
  {tenantId:b.tenantId,employmentId:worker.employmentId,attendanceDate:'2026-02-12',status:'present'},
 ]);
 const {batchId}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-02'});await generatePayslips(root,{batchId});
 const [capture]=await owner.db.select().from(payrollAuditCapture).where(and(eq(payrollAuditCapture.tenantId,b.tenantId),eq(payrollAuditCapture.sourceKey,'inputs:'+batchId)));
 const month={start:'2026-02-01',end:'2026-02-28'},windows={attendance:month,overtime:month,leave:month,claim:month};
 const original=await withTenant(root,tx=>runInputsTx(tx,{batchId,payPeriod:'2026-02',windows}));
 expect(original.components.attendance.rows).toBe(2);expect(original.components.overtime.rows).toBe(1);
 expect(capture).toMatchObject({kind:'inputs_snapshot',writer:'user',writerId:root.userId,content:{...original,basis:'processed',trigger:'processed',processedBy:root.userId}});
},60000);

it('preserves the Claims audit digest when payroll membership and expense dates overlap', async () => {
 const {root, worker, batchId, b} = await loadAuditFixture(1);
 const [type] = await owner.db.insert(schema.claimType).values({
  tenantId: b.tenantId, code: 'AUDIT_LOOKUP', name: 'Fictional audit claim',
 }).returning({id: schema.claimType.id});
 const claim = {tenantId: b.tenantId, employmentId: worker.employmentId, claimTypeId: type.id, amount: '12.34'};
 await owner.db.insert(schema.claimRequest).values([
  {...claim, incurredOn: '2026-01-10', payrollBatchId: batchId},
  {...claim, incurredOn: '2025-12-10', payrollBatchId: batchId},
  {...claim, incurredOn: '2026-01-15'},
  {...claim, incurredOn: '2025-12-15'},
 ]);

 const month = {start: '2026-01-01', end: '2026-01-31'};
 const windows = {attendance: month, overtime: month, leave: month, claim: month};
 await withTenant(root, async tx => {
  await tx.execute(sql`set local timezone = 'UTC'`);
  const [expected] = await tx.execute<{e: string; n: number; h: string}>(groupRows(sql`
   select c.* from public.claim_request c
   where c.payroll_batch_id = ${batchId}::uuid
    or (c.employment_id in (${paidMembership(batchId)})
     and c.incurred_on between ${month.start}::date and ${month.end}::date)
  `));
  expect(expected).toMatchObject({e: worker.employmentId, n: 3});
  const inputs = await runInputsTx(tx, {batchId, payPeriod: '2026-01', windows});
  expect(inputs.components.claims).toEqual({
   rows: 3,
   hash: createHash('sha256').update(`${expected.e}:${expected.n}:${expected.h}\n`).digest('hex'),
  });
 });
}, 60000);

const auditProfileFile = 'test/payroll-audit-processing-rc.test.ts';
const focusedTests: unknown = JSON.parse(process.env.AIHR_FOCUSED_TESTS ?? '[]');
const auditProfileRequested = process.env.GITHUB_ACTIONS === 'true'
 && Array.isArray(focusedTests) && focusedTests.length === 1 && focusedTests[0] === auditProfileFile;

it.skipIf(!auditProfileRequested)('profiles the Claims audit hash against one million retained claims', async () => {
 const {root, worker, batchId, b} = await loadAuditFixture(1);
 const evidenceDir = process.env.AIHR_FOCUSED_EVIDENCE_DIR;
 if (!evidenceDir) throw Error('Focused evidence directory is required');
 const [type] = await owner.db.insert(schema.claimType).values({
  tenantId: b.tenantId, code: 'AUDIT_RETAINED', name: 'Fictional retained claim',
 }).returning({id: schema.claimType.id});

 await owner.db.transaction(async tx => {
  // Synthetic retained history only. The paid subject and the three selected rows
  // below keep the ordinary fixture owners and checks.
  await tx.execute(sql`set local session_replication_role = replica`);
  await tx.execute(sql`with people as (
   insert into public.person (tenant_id,full_name,primary_email)
   select ${b.tenantId},'Retained claimant '||n,'payroll-retained-'||n||'@example.test' from generate_series(1,1000) n returning id
  ), subjects as (
   insert into public.employment (tenant_id,company_id,person_id,hired_on)
   select ${b.tenantId},${b.companyId},id,date '2020-01-01' from people returning id
  )
  insert into public.claim_request (tenant_id,employment_id,claim_type_id,amount,incurred_on)
  select ${b.tenantId},id,${type.id},1,date '2024-01-01'+(n%730)
  from subjects cross join generate_series(1,1000) n`);
 });
 const claim = {tenantId:b.tenantId, employmentId:worker.employmentId, claimTypeId:type.id, amount:'12.34'};
 await owner.db.insert(schema.claimRequest).values([
  {...claim, incurredOn:'2025-12-15', payrollBatchId:batchId},
  {...claim, incurredOn:'2026-01-15', payrollBatchId:batchId},
  {...claim, incurredOn:'2026-01-16'},
  {...claim, incurredOn:'2025-12-16'},
 ]);
 await owner.db.execute(sql`analyze public.claim_request`);
 const [retained] = await owner.db.execute<{n:number}>(sql`
  select count(*)::int as n from public.claim_request where tenant_id=${b.tenantId}::uuid`);
 expect(retained.n).toBe(1000004);

 const month = {start:'2026-01-01',end:'2026-01-31'};
 const windows = {attendance:month,overtime:month,leave:month,claim:month};
 const membership = paidMembership(batchId);
 const linked = sql`select c.* from public.claim_request c where c.payroll_batch_id=${batchId}::uuid`;
 const unlinked = sql`c.payroll_batch_id is distinct from ${batchId}::uuid
  and c.incurred_on between ${month.start}::date and ${month.end}::date`;
 const baseline = groupRows(sql`${linked} union all select c.* from public.claim_request c
  where ${unlinked} and c.employment_id in (${membership})`);
 const byMember = groupRows(sql`${linked} union all select matched.*
  from (select distinct employment_id from (${membership}) paid) member
  cross join lateral (
   select c.* from public.claim_request c where ${unlinked} and c.employment_id=member.employment_id offset 0
  ) matched`);
 const phases = await processingTx(root,batchId,async tx => {
  const [identity] = await tx.execute<{role:string}>(sql`select current_user as role`);
  expect(identity.role).toBe('ai_hr_app');
  const oracle = await runInputsTx(tx,{batchId,payPeriod:'2026-01',windows});
  const expected = await tx.execute<{e:string;n:number;h:string}>(baseline);
  expect(expected).toHaveLength(1);
  expect(expected[0]).toMatchObject({e:worker.employmentId,n:3});
  expect(oracle.components.claims).toEqual({
   rows:3,
   hash:createHash('sha256').update(`${expected[0].e}:${expected[0].n}:${expected[0].h}\n`).digest('hex'),
  });
  const results = [];
  for (const [phase,query] of [['baseline',baseline],['by-member',byMember],['baseline-restored',baseline]] as const) {
   expect(Array.from(await tx.execute(query))).toEqual(Array.from(expected));
   const plans = [];
   for (let attempt=0; attempt<3; attempt++) {
    const [plan] = await tx.execute(sql`explain (analyze,buffers,format json) ${query}`);
    plans.push(plan['QUERY PLAN']);
   }
   results.push({phase,plans});
  }
  return results;
 });
 writeFileSync(join(evidenceDir,'payroll-audit-claims-retained.json'), JSON.stringify({
  kind:'PAYROLL_AUDIT_CLAIM_LOOKUP_COMPONENT_ONLY',releaseEligible:false,
  retained:retained.n,members:1,selected:3,phases,
  limitations:'Synthetic retained history, one paid member, app-role read under native processing barriers. No concurrency or release claims.',
 },null,2));
}, 600000);
