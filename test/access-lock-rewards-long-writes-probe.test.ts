/** Temporary measurement probe (11 November 2026): where one approved review creation spends its exclusive hold.
 * Every statement of the creating transaction is timed and the slowest statement texts are printed. It asserts only
 * completion and is removed once read. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {businessUnit,jobGrade} from '../db/schema';
import {hireEmployee} from '../core/org';
import {createRewardUnit} from '../packs/rewards/service';
import {createApprovedRewardPlan} from './rewards-setup-fixture';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.restoreAllMocks());afterAll(closeAll);

it.each([200])('profiles one approved review creation with %i employees',async employees=>{
 const b=await seedBase();await setModule(b.tenantId,'rewards','active');
 const [unit]=await owner.db.insert(businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'PROBE-BU',name:'Probe Business unit'}).returning();
 const [grade]=await owner.db.insert(jobGrade).values({tenantId:b.tenantId,code:'12',name:'Probe grade 12',rank:12}).returning();
 for(let n=0;n<employees;n++)await hireEmployee(adminCtx(b),{person:{fullName:`Fictional reviewed employee ${n+1}`,primaryEmail:randomUUID()+'@example.invalid'},
  companyId:b.companyId,departmentId:b.deptA,businessUnitId:unit!.id,gradeId:grade!.id,employeeCode:'PROBE-'+(n+1),employmentType:'full_time',hiredOn:'2025-01-01'});
 const ctx:SessionContext=adminCtx(b);
 const plan=await createApprovedRewardPlan(ctx,{year:2026,companyId:b.companyId,businessUnitId:unit!.id,snapshotDate:'2026-01-01'});
 const timings=new Map<string,{count:number;ms:number}>();
 const native=database.withTenant;
 vi.spyOn(database,'withTenant').mockImplementation(<T,>(c:SessionContext,fn:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(c,async tx=>{
  type Prepared={execute:(...args:unknown[])=>Promise<unknown>};
  const session=(tx as unknown as {session:{prepareQuery:(...args:unknown[])=>Prepared}}).session,prepare=session.prepareQuery.bind(session);
  session.prepareQuery=(...args)=>{const prepared=prepare(...args),execute=prepared.execute.bind(prepared);
   const text=String((args[0] as {sql?:string})?.sql??'').replace(/\s+/g,' ').slice(0,140);
   prepared.execute=async(...values)=>{const started=performance.now();try{return await execute(...values);}finally{const t=timings.get(text)??{count:0,ms:0};t.count++;t.ms+=performance.now()-started;timings.set(text,t);}};return prepared;};
  return fn(tx);
 },options));
 const started=performance.now();
 await createRewardUnit(ctx,{name:plan.name,year:2026,companyId:b.companyId,businessUnitId:unit!.id,snapshotDate:'2026-01-01',approvedPlanVersionId:plan.versionId});
 const total=Math.round(performance.now()-started);
 const top=[...timings.entries()].sort((a,c)=>c[1].ms-a[1].ms).slice(0,15).map(([text,t])=>({ms:Math.round(t.ms),count:t.count,text}));
 console.log('[rewards-review-profile]',JSON.stringify({employees,totalMs:total,statements:[...timings.values()].reduce((s,t)=>s+t.count,0),top}));
 expect(total).toBeGreaterThan(0);
},600_000);
