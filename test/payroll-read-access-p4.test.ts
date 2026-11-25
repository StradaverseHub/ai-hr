/**
 * ADR 0181 payroll read addendum, step P4 (migration 7490): the payroll history barrier's committed part stored, inert
 * behind the 7460 switch.
 *
 * History writers (real paths, fictional people): a processed and closed ordinary run; a history confirm that imports
 * three new records and adopts the processed payslip of one employee (6693 native_replaced); a correction that
 * supersedes an imported snapshot; a staged history job held in flight; its release; a revert. After every write the
 * maintained set equals a from-scratch recompute (verify is clean) and equals what the legacy barrier hides, and every
 * reader (the administrator, the employee's own payslip readers, the History list) sees the same rows switched and
 * legacy, including while the stage is in flight.
 *
 * Scale (test/helpers/payroll-read-access.ts, 70 companies, 1,000 employments): the same rows and plan shape in each
 * mode, no per-row barrier chain when switched, a clean every-user comparison, and switched reads no slower.
 */
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload,previewPayrollHistoryRevert,revertPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {requestPayrollHistoryConfirm,payrollHistoryJobHandler} from '../core/payroll-history-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {hireEmployee} from '../core/org';
import {createBatch,generatePayslips,closeBatch} from '../core/payroll';
import {myOwnPayslips,myReleasedPayslipRuns} from '../core/read';
import {listProcessedPayslipsAcross} from '../core/payroll-view';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {historyRecordKey} from '../lib/payroll-history-revisions';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {actors,allSlips,asApp,buildPayrollReadFixture,calls,median,must,planShape,setStepMode,type Actor} from './helpers/payroll-read-access';

const STEP='p4_history_filter';
afterAll(async()=>{try{await setStepMode(STEP,'legacy');await owner.client`delete from payroll_read_access_tenant`;}finally{await closeAll();}});

const year=2026,earlier=`${year}-03`,processed=`${year}-02`,CODES=['0007','0008','0009'];
const tick=()=>runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});
async function drain(jobId:string){
 for(let i=0;i<5000;i++){
  const [row]=await owner.client<{state:string;notified:boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${jobId}::uuid`;
  if(['completed','failed','cancelled'].includes(row.state)&&row.notified)return row.state;
  if(!await tick())await new Promise(resolve=>setTimeout(resolve,25));
 }
 throw new Error('history job did not finish');
}
const lines=(employee:string,period:string,amount:string)=>[[employee,period,'ME','BASIC','000AC',amount],[employee,period,'ME','EEEPF','000AC','0.00'],
 [employee,period,'ME','EESOCSO','000AC','0.00'],[employee,period,'ME','EEEIS','000AC','0.00'],[employee,period,'ME','PCB','000AC','0.00']];
const csv=(rows:string[][])=>Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows]));

type History={b:Base;ctx:SessionContext;self:SessionContext;employments:Record<string,string>;ordinary:string};
async function historyTenant():Promise<History>{
 await resetDb();
 const b=await seedBase();await setModule(b.tenantId,'payroll','active');const ctx=await entitledCtx(b);
 await owner.db.update(schema.company).set({companyLabel:'000AC'}).where(eq(schema.company.id,b.companyId));
 await seedPayrollCycleCatalog(ctx,b.companyId);
 await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'BASIC',name:'Basic salary',kind:'allowance',displayCategory:'basic',pcbRemunerationType:'normal',pcbExemptionCode:'PCB_TAXABLE'});
 const employments:Record<string,string>={};let selfPerson='';
 for(const [i,code] of CODES.entries()){
  const hired=await hireEmployee(ctx,{person:{fullName:`Fictional read employee ${code}`,primaryEmail:`read-${code}-${randomUUID().slice(0,6)}@fixture.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:code,hiredOn:`${year-1}-01-01`});
  employments[code]=hired.employmentId;if(code==='0007')selfPerson=hired.personId;
  await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:4000+i*100,effectiveFrom:`${year-1}-01-01`});
  await setStatutoryProfileMY(ctx,{personId:hired.personId,icNumber:`85020202555${i}`,taxCategory:1,numChildren:0});
 }
 const run=await createBatch(ctx,{companyId:b.companyId,payPeriod:processed});
 await generatePayslips(ctx,{batchId:run.batchId});await closeBatch(ctx,{batchId:run.batchId});
 const selfUser=await createAppUser(b.tenantId,selfPerson,'employee');
 return{b,ctx,self:{tenantId:b.tenantId,userId:selfUser,personId:selfPerson,roles:['employee'],grants:[{role:'employee',companyId:null}],entitlements:ctx.entitlements},employments,ordinary:run.batchId};
}

/** What each reader sees, and the barrier's own answer for every payslip of the tenant. */
async function readers(h:History){
 return{
  admin:await withTenant(h.ctx,async tx=>(await tx.execute<{id:string}>(sql`select id::text from payslip order by id`)).map(r=>r.id)),
  history:await listProcessedPayslipsAcross(h.ctx,{companyIds:[h.b.companyId]}),
  own:await myOwnPayslips(h.self,[h.employments['0007']]),
  runs:await myReleasedPayslipRuns(h.self),
 };
}
async function stored(h:History){
 const rows=await owner.client<{id:string;reason:string}[]>`select payslip_id::text as id,reason from payroll_history_ineffective_payslip where tenant_id=${h.b.tenantId} order by 1`;
 // The barrier reads the session's tenant, so it is asked inside a transaction that sets it.
 const legacy=await owner.client.begin(async tx=>{
  await tx`select set_config('app.tenant_id',${h.b.tenantId},true)`;
  const [row]=await tx<{ids:string[]|null}[]>`select array_agg(p.id::text order by p.id) as ids from payslip p where p.tenant_id=${h.b.tenantId} and p.id not in (
   select x from app.payroll_history_effective_ids((select array_agg(id) from payslip where tenant_id=${h.b.tenantId})) x where x is not null)`;
  return row.ids??[];
 });
 return{rows,legacy:legacy as string[]};
}
async function expectConsistent(h:History,label:string){
 const s=await stored(h);
 // With no stage in flight, the stored set is exactly what the barrier hides.
 expect(s.rows.map(r=>r.id),`${label}: stored = barrier`).toEqual(s.legacy);
 const [v]=await owner.client<{r:{missing:number;extra:number}}[]>`select app.payroll_history_ineffective_verify(${h.b.tenantId}::uuid) as r`;
 expect(v.r,`${label}: verify`).toMatchObject({missing:0,extra:0});
 return s;
}
async function bothModes(h:History,label:string){
 await setStepMode(STEP,'legacy');const legacy=await readers(h);
 await setStepMode(STEP,'precomputed');const switched=await readers(h);
 await setStepMode(STEP,'legacy');
 expect(switched,`${label}: readers`).toEqual(legacy);
 return legacy;
}

describe('stored payroll history barrier (7490)',()=>{
 it('installs inert: P4 legacy, the barrier policy unchanged, the set readable only within the tenant',async()=>{
  expect(await owner.client`select mode from payroll_read_access_control where step=${STEP}`).toEqual([{mode:'legacy'}]);
  const [qual]=await owner.client<{q:string}[]>`select pg_get_expr(polqual,polrelid) as q from pg_policy where polrelid='public.payslip'::regclass and polname='payroll_history_effective_only'`;
  expect(qual.q).toBe('(app.payroll_history_effective(id) OR app.payroll_history_self_issued(id))');
  const tables=await owner.client<{name:string;app:boolean;forced:boolean}[]>`select relname as name,has_table_privilege('ai_hr_app',oid,'SELECT') as app,relforcerowsecurity as forced
   from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname like 'payroll\\_history\\_ineffective\\_%' order by 1`;
  expect(tables).toEqual(['payroll_history_ineffective_commit','payroll_history_ineffective_payslip','payroll_history_ineffective_state'].map(name=>({name,app:false,forced:true})));
  const triggers=await owner.client<{t:string}[]>`select tgrelid::regclass::text||'.'||tgname as t from pg_trigger where not tgisinternal and tgname like 'payroll\\_history\\_ineffective\\_%' order by 1`;
  expect(triggers.map(r=>r.t)).toEqual([
   'app.payroll_history_native_capture.payroll_history_ineffective_delete','app.payroll_history_native_capture.payroll_history_ineffective_insert','app.payroll_history_native_capture.payroll_history_ineffective_update',
   'payroll_batch.payroll_history_ineffective_batch_moved',
   'payroll_history_import_record.payroll_history_ineffective_delete','payroll_history_import_record.payroll_history_ineffective_insert','payroll_history_import_record.payroll_history_ineffective_update',
   'payroll_history_import_revision.payroll_history_ineffective_delete','payroll_history_import_revision.payroll_history_ineffective_insert','payroll_history_import_revision.payroll_history_ineffective_update',
   'payroll_history_import_snapshot.payroll_history_ineffective_delete','payroll_history_import_snapshot.payroll_history_ineffective_insert','payroll_history_import_snapshot.payroll_history_ineffective_update',
   'payroll_history_ineffective_commit.payroll_history_ineffective_commit',
   'payslip.payroll_history_ineffective_inserted','payslip.payroll_history_ineffective_moved',
  ]);
 });

 it('a transaction with maintenance notes pending reads the legacy barrier until its commit recomputes',async()=>{
  const [tenant]=await owner.client<{id:string}[]>`select id::text from tenant order by id limit 1`;
  const states=await owner.client.begin(async tx=>{
   await tx`select set_config('app.tenant_id',${tenant.id},true)`;
   const [before]=await tx<{s:unknown}[]>`select app.payroll_history_store_state() as s`;
   await tx`select app.payroll_history_ineffective_note(${tenant.id+'|p|'+'00000000-0000-0000-0000-000000000000'})`;
   const [during]=await tx<{s:unknown}[]>`select app.payroll_history_store_state() as s`;
   const [rows]=await tx<{n:number}[]>`select count(*)::int as n from payroll_history_ineffective_commit where txid=txid_current()`;
   return{before:before.s,during:during.s,rows:rows.n};
  });
  expect(states.before).not.toBeNull();expect(states.during).toBeNull();expect(states.rows).toBe(1);
  // The deferred recompute ran at commit and removed the transaction's row.
  expect(await owner.client`select 1 from payroll_history_ineffective_commit`).toHaveLength(0);
 });

 it('keeps the stored set equal to the barrier through confirm, adoption, correction, a staged job, its release and a revert',async()=>{
  const h=await historyTenant();
  expect((await expectConsistent(h,'processed')).rows).toEqual([]);
  await bothModes(h,'processed');
  // Confirm: three new March records, and February's processed payslip of 0007 adopted and replaced.
  const first=await previewPayrollHistoryUpload(h.ctx,{name:'history.csv',content:csv([...CODES.flatMap((code,i)=>lines(code,earlier,(5000+i).toFixed(2))),...lines('0007',processed,'6100.00')]),operationKey:randomUUID()});
  expect(first.plan.counts).toEqual({created:3,replaced:1,unchanged:0,invalid:0});
  const replace=first.plan.rows.find(r=>r.operation==='replace')!;
  await confirmPayrollHistoryUpload(h.ctx,{attemptId:first.attemptId,previewHash:first.plan.previewHash,confirmReplacement:true,selectedRecordKeys:[historyRecordKey(replace)],acknowledgeWarnings:true});
  const [native]=await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId,h.ordinary),eq(schema.payslip.employmentId,h.employments['0007'])));
  const adopted=await expectConsistent(h,'adopted');
  // The adopted payslip is hidden (as a replaced native payslip, or as a superseded snapshot when the adoption's
  // snapshot is that payslip itself).
  expect(adopted.rows.map(r=>r.id)).toContain(native.id);
  const afterAdoption=await bothModes(h,'adopted');
  expect(afterAdoption.admin).not.toContain(native.id);
  // Correction: 0008's March record replaced, so its first imported snapshot is superseded.
  const correction=await previewPayrollHistoryUpload(h.ctx,{name:'correction.csv',content:csv(lines('0008',earlier,'5300.00')),operationKey:randomUUID()});
  expect(correction.plan.counts).toMatchObject({replaced:1});
  await confirmPayrollHistoryUpload(h.ctx,{attemptId:correction.attemptId,previewHash:correction.plan.previewHash,confirmReplacement:true,
   selectedRecordKeys:correction.plan.rows.filter(r=>r.operation==='replace').map(historyRecordKey),acknowledgeWarnings:true});
  const corrected=await expectConsistent(h,'corrected');
  expect(corrected.rows.filter(r=>r.reason==='superseded_snapshot').length).toBeGreaterThanOrEqual(1);
  await bothModes(h,'corrected');
  // A staged job held in flight: its rows are touched, every reader still matches the legacy barrier.
  process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS='1';
  let stagedAttempt='';
  try{
   const staged=await previewPayrollHistoryUpload(h.ctx,{name:'staged.csv',content:csv([...lines('0009',earlier,'5400.00'),...lines('0007',earlier,'5500.00')]),operationKey:randomUUID()});
   const request=await requestPayrollHistoryConfirm(h.ctx,{attemptId:staged.attemptId,previewHash:staged.plan.previewHash,confirmReplacement:true,
    selectedRecordKeys:staged.plan.rows.filter(r=>r.operation==='replace').map(historyRecordKey),acknowledgeWarnings:true});
   if(!('jobId' in request))throw new Error('expected a job');
   stagedAttempt=staged.attemptId;
   for(let i=0;i<2000;i++){
    const [row]=await owner.client<{n:number;state:string}[]>`select (select count(*)::int from app.payroll_history_staged_row r where r.stage_id=${request.jobId}::uuid and r.relation='payroll_history_import_revision') as n,(select state from bulk_job where id=${request.jobId}::uuid) as state`;
    if(row.n>=1||!['running','queued','preparing'].includes(row.state))break;
    await tick();
   }
   expect((await owner.client<{state:string}[]>`select state from bulk_job where id=${request.jobId}::uuid`)[0].state).toBe('running');
   // The touched set covers every staged payslip and the payslips of the staged records.
   const touched=must(await asApp(h.ctx,'1',async tx=>Object.entries((await tx.execute<{s:Record<string,string>}>(sql`select app.payroll_history_store_state() as s`))[0].s).filter(([,v])=>v==='t').map(([k])=>k)));
   const stagedSlips=(await owner.client<{id:string}[]>`select r.row_id::text as id from app.payroll_history_staged_row r where r.stage_id=${request.jobId}::uuid and r.relation in ('payslip','payroll_history_import_snapshot')`).map(r=>r.id);
   expect(stagedSlips.length).toBeGreaterThan(0);
   for(const id of stagedSlips)expect(touched).toContain(id);
   await bothModes(h,'staged in flight');
   expect(await drain(request.jobId)).toBe('completed');
  }finally{delete process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;}
  await expectConsistent(h,'released');
  await bothModes(h,'released');
  // Revert the staged attempt: the March records it replaced return to their earlier snapshots.
  const revert=await previewPayrollHistoryRevert(h.ctx,stagedAttempt);
  await revertPayrollHistoryUpload(h.ctx,stagedAttempt,revert.previewHash);
  await expectConsistent(h,'reverted');
  await bothModes(h,'reverted');
  // The every-user comparison of the piece agrees too.
  const [c]=await owner.client<{r:Record<string,unknown>}[]>`select app.payroll_read_access_compare(${STEP},${h.b.tenantId}::uuid) as r`;
  expect(c.r).toMatchObject({valuesDiffer:0,raisesDiffer:0,trusted:true});
 },900_000);

 it('at 70 companies and 1,000 employments: same rows and plans, no per-row barrier chain, clean comparison, no slower',async()=>{
  const f=await buildPayrollReadFixture();
  // The fixture is written with triggers off (replica role); rebuilding is what the migration does for an existing tenant.
  await owner.client`select app.payroll_history_ineffective_rebuild(${f.b.tenantId}::uuid)`;
  const who=actors(f);
  const read=(ctx:SessionContext)=>withTenant(ctx,async tx=>(await tx.execute<{id:string}>(sql`select id::text from payslip order by id`)).map(r=>r.id));
  const SHAPE=sql`select p.id from payslip p join payroll_batch pb on pb.id=p.batch_id join employment e on e.id=p.employment_id join person pe on pe.id=e.person_id
   where pb.pay_period='2026-11' order by pb.pay_period desc,pb.run_seq,pe.full_name`;
  const legacy={} as Record<Actor,{rows:string[];plan:unknown}>;
  for(const [name,ctx] of Object.entries(who) as [Actor,()=>SessionContext][])legacy[name]={rows:await read(ctx()),plan:await planShape(ctx(),SHAPE)};
  expect(legacy.group.rows).toHaveLength(allSlips);
  await setStepMode(STEP,'precomputed');
  for(const [name,ctx] of Object.entries(who) as [Actor,()=>SessionContext][])expect({rows:await read(ctx()),plan:await planShape(ctx(),SHAPE)},name).toEqual(legacy[name]);
  const chain=async()=>must(await asApp(who.group(),'1',async tx=>{const before=await calls(tx,['payroll_history_effective']);await tx.execute(sql`select count(*) from payslip`);return(await calls(tx,['payroll_history_effective']))-before;}));
  expect(await chain()).toBe(0);
  const time=async(mode:'legacy'|'precomputed')=>{await setStepMode(STEP,mode);const out:number[]=[];
   for(let i=0;i<5;i++){const t=performance.now();must(await asApp(who.group(),'1',async tx=>{await tx.execute(SHAPE);await tx.execute(sql`select count(*) from payslip`);}));out.push(performance.now()-t);}
   return median(out);};
  await time('legacy');
  const before=await time('legacy'),after=await time('precomputed');
  await setStepMode(STEP,'legacy');
  expect(await chain()).toBeGreaterThanOrEqual(allSlips);
  console.info('PAYROLL_READ_P4_TIMING',JSON.stringify({legacyMs:Math.round(before),precomputedMs:Math.round(after)}));
  expect(after).toBeLessThanOrEqual(before*1.1+20);
  const [c]=await owner.client<{r:Record<string,unknown>}[]>`select app.payroll_read_access_compare(${STEP},${f.b.tenantId}::uuid) as r`;
  expect(c.r).toMatchObject({valuesDiffer:0,raisesDiffer:0,trusted:true});
 },1_800_000);

 it('7490: the commit-time lookup of a record\'s snapshots uses payroll_history_import_snapshot_record_idx at scale',async()=>{
  const f=await buildPayrollReadFixture();
  // The function's lookup, as installed (a rewrite of it must keep using an indexed predicate, or fail here).
  const [fn]=await owner.client<{src:string}[]>`select prosrc as src from pg_proc where oid='app.payroll_history_ineffective_record_payslips(uuid,uuid[])'::regprocedure`;
  expect(fn.src).toContain('FROM public.payroll_history_import_snapshot s WHERE s.tenant_id=p_tenant AND s.record_id=ANY(p_records)');
  // About 4,000 snapshot rows over 1,000 records (one per payslip of the 70-company fixture), analysed, then the same
  // statement explained for three records; all inside a transaction that is rolled back.
  class Done{constructor(readonly plan:string){}}
  let plan='';
  try{
   await owner.client.begin(async tx=>{
    await tx`set local session_replication_role = replica`;
    await tx`insert into payroll_history_import_snapshot(id,tenant_id,record_id,value_hash,"values")
     select p.id,p.tenant_id,md5(p.employment_id::text)::uuid,repeat('0',64),'{}'::jsonb from payslip p where p.tenant_id=${f.b.tenantId}::uuid`;
    await tx`analyze payroll_history_import_snapshot`;
    const records=(await tx<{r:string}[]>`select distinct record_id::text as r from payroll_history_import_snapshot where tenant_id=${f.b.tenantId}::uuid order by 1 limit 3`).map(x=>x.r);
    const rows=await tx.unsafe(`explain (analyze, costs off, format text) select s.id from public.payroll_history_import_snapshot s where s.tenant_id=$1 and s.record_id=any($2::uuid[])`,[f.b.tenantId,records] as never[]);
    throw new Done(rows.map(r=>(r as Record<string,string>)['QUERY PLAN']).join('\n'));
   });
  }catch(error){if(error instanceof Done)plan=error.plan;else throw error;}
  console.info('PAYROLL_READ_P4_SNAPSHOT_LOOKUP_PLAN\n'+plan);
  expect(plan).toContain('payroll_history_import_snapshot_record_idx');
  expect(plan).not.toMatch(/Seq Scan on payroll_history_import_snapshot/);
 },600_000);

});
