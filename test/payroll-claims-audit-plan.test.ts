/** Reversible native plan/index matrix; production source and installed schema owners stay unchanged. */
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import * as s from '../db/schema';
import type {SessionContext} from '../db/client';
import {withPayrollTenant} from '../core/module-gate';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch,generatePayslips} from '../core/payroll';
import {runInputsTx} from '../core/payroll-audit/inputs';
import {lockPayComponentCatalogReadTx} from '../core/pay-component-catalog-lock';
import {lockNativePayrollBatchPeriodTx} from '../core/payroll-period-lock';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
it.each(['sparse','dense'] as const)('compares claim-input plans without changing native digest/RLS (%s)',async shape=>{
 const root=adminCtx(b),target=await hireEmployee(root,{person:{fullName:'Fictional audit-plan target',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await setCompensation(root,{employmentId:target.employmentId,basicSalary:3000,effectiveFrom:'2020-01-01'});await setStatutoryProfileMY(root,{personId:target.personId,icNumber:'900101015551',taxCategory:1,numChildren:0});
 const {batchId}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-01'});await generatePayslips(root,{batchId});const {batchId:otherBatch}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-02'});
 const people=Array.from({length:1000},(_,index)=>({id:randomUUID(),employmentId:randomUUID(),name:'Fictional audit decoy '+index}));
 await owner.db.insert(s.person).values(people.map(p=>({id:p.id,tenantId:b.tenantId,fullName:p.name,primaryEmail:p.id+'@example.invalid'})));await owner.db.insert(s.employment).values(people.map(p=>({id:p.employmentId,tenantId:b.tenantId,personId:p.id,companyId:b.companyId,hiredOn:'2020-01-01'})));
 // Isolated RLS/read-plan fixture only: clone an actually generated native row for member cardinality.
 // No trigger/RLS disabling and no claim that these clones are numerical payroll calculations.
 const [slip]=await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batchId));
 for(let offset=0;offset<people.length;offset+=100)await owner.db.insert(s.payslip).values(people.slice(offset,offset+100).map(p=>({...slip,id:randomUUID(),employmentId:p.employmentId})));
 const [type]=await owner.db.insert(s.claimType).values({tenantId:b.tenantId,code:'AUDIT_PLAN',name:'Fictional audit input',requiresReceipt:false}).returning({id:s.claimType.id});
 const common={tenantId:b.tenantId,claimTypeId:type.id,amount:'1.23',description:'PRIVATE_FICTIONAL_AUDIT_INPUT'};
 const decoyCount=shape==='small'?0:20000;
 for(let offset=0;offset<decoyCount;offset+=500)await owner.db.insert(s.claimRequest).values(Array.from({length:500},(_,i)=>({...common,employmentId:people[(offset+i)%people.length].employmentId,incurredOn:shape==='dense'||(offset+i)%100===0?'2026-01-15':'2010-06-01',status:'draft' as const})));
 await owner.db.insert(s.claimRequest).values([
  {...common,employmentId:target.employmentId,incurredOn:'2026-01-01',status:'draft',fieldValues:{fixture:'boundary-start',number:12,empty:null}},
  {...common,employmentId:target.employmentId,incurredOn:'2026-01-31',status:'pending'},
  {...common,employmentId:target.employmentId,incurredOn:'2025-12-31',status:'paid',payrollBatchId:batchId,paidAt:new Date('2026-02-01T00:00:00Z')},
  {...common,employmentId:target.employmentId,incurredOn:'2026-01-15',status:'paid',payrollBatchId:batchId},
  {...common,employmentId:people[0].employmentId,incurredOn:'2025-12-31',status:'paid',payrollBatchId:batchId},
  {...common,employmentId:target.employmentId,incurredOn:'2026-01-15',status:'paid',payrollBatchId:otherBatch},
  {...common,employmentId:target.employmentId,incurredOn:'2026-02-01',status:'pending'},
 ]);
 for(const table of ['claim_request','payslip','person','employment','role_assignment','reporting_line'])await owner.client.unsafe('analyze public.'+table);
 const worker:SessionContext={...root,userId:await createAppUser(b.tenantId,target.personId,'employee'),personId:target.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]},foreign=adminCtx(await seedBase());
 const originalQuery=sql`select x.employment_id::text as e,count(*)::int as n,app.payroll_audit_hash(jsonb_agg(to_jsonb(x) order by x.id)::text) as h from (select c.* from public.claim_request c where c.payroll_batch_id=${batchId}::uuid or (c.employment_id in (select s.employment_id from public.payslip s where s.batch_id=${batchId}::uuid) and c.incurred_on between ${'2026-01-01'}::date and ${'2026-01-31'}::date)) x group by x.employment_id order by x.employment_id`;

 // UNION preserves every original c.* value. IS DISTINCT FROM retains NULL batch links while
 // excluding rows already included by the first arm; a plain <> would silently lose unpaid rows.
 const unionQuery=sql`select x.employment_id::text as e,count(*)::int as n,app.payroll_audit_hash(jsonb_agg(to_jsonb(x) order by x.id)::text) as h from (
 select c.* from public.claim_request c where c.payroll_batch_id=${batchId}::uuid
 union all select c.* from public.claim_request c where c.payroll_batch_id is distinct from ${batchId}::uuid
 and c.employment_id in(select s.employment_id from public.payslip s where s.batch_id=${batchId}::uuid)
 and c.incurred_on between ${'2026-01-01'}::date and ${'2026-01-31'}::date
 )x group by x.employment_id order by x.employment_id`;
 // Statement-local native array, not an application/session permission or result cache.
 const arrayQuery=sql`select x.employment_id::text as e,count(*)::int as n,app.payroll_audit_hash(jsonb_agg(to_jsonb(x) order by x.id)::text) as h from (
 select c.* from public.claim_request c where c.payroll_batch_id=${batchId}::uuid or
 (c.employment_id=any(array(select s.employment_id from public.payslip s where s.batch_id=${batchId}::uuid)::uuid[])
 and c.incurred_on between ${'2026-01-01'}::date and ${'2026-01-31'}::date)
 )x group by x.employment_id order by x.employment_id`;
 const indexCatalog=()=>owner.db.execute(sql`select indexname,indexdef from pg_indexes where schemaname='public' and tablename='claim_request' order by indexname`);
 const before=Array.from(await indexCatalog()),receipts:unknown[]=[],indexBuilds:unknown[]=[],created:string[]=[];
 const probe=async(phase:string,query:typeof originalQuery)=>{for(const [actor,ctx,expectedRows]of [['admin',root,shape==='dense'?20006:206],['ownEmployee',worker,5],['foreignTenant',foreign,0]]as const){await withPayrollTenant(ctx,async tx=>{
  await lockPayComponentCatalogReadTx(tx,ctx);await lockNativePayrollBatchPeriodTx(tx,ctx,batchId);await tx.execute(sql`select id from public.payroll_batch where id=${batchId}::uuid for update`);await tx.execute(sql`set local timezone='UTC'`);
  let elapsedMs=0,rows:{e:string;n:number;h:string}[]=[];
  for(let i=0;i<5;i++){const started=performance.now();rows=Array.from(await tx.execute(query)) as unknown as typeof rows;elapsedMs+=performance.now()-started;}
  const hash=createHash('sha256');let total=0;for(const row of rows){total+=Number(row.n);hash.update(`${row.e}:${Number(row.n)}:${row.h}\n`);}expect(total).toBe(expectedRows);
  const windows={attendance:{start:'2026-01-01',end:'2026-01-31'},overtime:{start:'2026-01-01',end:'2026-01-31'},leave:{start:'2026-01-01',end:'2026-01-31'},claim:{start:'2026-01-01',end:'2026-01-31'}};
  const actual=await runInputsTx(tx,{batchId,payPeriod:'2026-01',windows});expect(actual.components.claims).toEqual({rows:total,hash:hash.digest('hex')});
  const explain=await tx.execute(sql`explain(analyze,buffers,settings,format json) ${query}`);receipts.push({phase,actor,reads:5,elapsedMs,rows:total,component:actual.components.claims,explain});
 });}};
 const build=async(name:string,statement:string)=>{const start=performance.now();await owner.client.unsafe(statement);created.push(name);const [row]=await owner.client`select pg_relation_size(${name}::regclass)::text as bytes`;indexBuilds.push({name,elapsedMs:performance.now()-start,bytes:row.bytes});await owner.client.unsafe('analyze public.claim_request');};
 try{
  await probe('original',originalQuery);await probe('array-no-index',arrayQuery);
  await build('_perf_audit_claim_batch_probe','create index _perf_audit_claim_batch_probe on public.claim_request(tenant_id,payroll_batch_id) where payroll_batch_id is not null');
  await probe('batch-original',originalQuery);await probe('batch-array',arrayQuery);await probe('batch-array-warm',arrayQuery);
  await build('_perf_audit_claim_date_probe','create index _perf_audit_claim_date_probe on public.claim_request(tenant_id,incurred_on,employment_id)');
  await probe('batch-date-original',originalQuery);await probe('batch-date-array',arrayQuery);await probe('batch-date-array-warm',arrayQuery);
 }finally{for(const name of created.reverse())await owner.client.unsafe('drop index public.'+name);await owner.client.unsafe('analyze public.claim_request');}
 await probe('restored-original',originalQuery);const after=Array.from(await indexCatalog());expect(after).toEqual(before);
 const policies=await owner.db.execute(sql`select polname,pg_get_expr(polqual,polrelid) as using_expression from pg_policy where polrelid='public.claim_request'::regclass order by polname`);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-claim-audit-membership-'+shape+'.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_THOUSAND_MEMBER_BOUND_PROOF',releaseEligible:false,shape,decoyClaims:decoyCount,subjects:1001,batchMembers:1001,numericalPayrollCalculationClaim:false,receipts,indexBuilds,indexesBefore:before,indexesAfter:after,policies,limitations:'Native component only; no product/schema/privilege/lock changes retained and no500-user claim'},null,2));

},600000);
