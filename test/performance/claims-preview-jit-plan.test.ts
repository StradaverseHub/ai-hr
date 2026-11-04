/** Reversible isolated native RLS plan experiment. Exact policy restoration is mandatory. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {pendingClaimTaskSummary,createClaimType} from '../../packs/claims/service';
import * as database from '../../db/client';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import * as s from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
const file='test/performance/claims-preview-jit-plan.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('compares actual million-Claim metadata with transaction-local JIT on, off and restored',async()=>{
 const report:Record<string,unknown>={kind:'CLAIMS_RETAINED_MILLION_JIT_COMPONENT_ONLY',releaseEligible:false,
  concurrentUsers:1,targetClaims:1_000_000,nativeTriggers:'unchanged',limitations:'Fictional retained data; not browser timing or500-user acceptance.'};
 expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'claims-preview-jit-plan.json'),JSON.stringify(report,null,2));
 const measurements:unknown[]=[];report.measurements=measurements;
 try{
  await resetDb();const started=performance.now(),tenants=[await seedBase(),await seedBase()];
  const actors:{name:string;ctx:SessionContext;companyIds:string[];employmentIds:string[];readEmploymentIds?:string[]}[]=[];
  for(const [t,b]of tenants.entries()){
   await setModule(b.tenantId,'claims','active');
   const ctx:SessionContext={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
   const companies=await owner.db.insert(s.company).values(Array.from({length:5},(_,i)=>({tenantId:b.tenantId,country:'MY',legalName:`Fictional Claims ${t}/${i}`}))).returning();
   const departments=await owner.db.insert(s.department).values(companies.map(c=>({tenantId:b.tenantId,companyId:c.id,name:'Fictional Claims department'}))).returning();
   const people=Array.from({length:250},(_,i)=>({personId:randomUUID(),employmentId:randomUUID(),companyIndex:Math.floor(i/50),name:`Fictional Claims ${t}/${i}`}));
   await owner.db.insert(s.person).values(people.map(p=>({id:p.personId,tenantId:b.tenantId,fullName:p.name,primaryEmail:p.personId+'@example.invalid'})));
   await owner.db.insert(s.employment).values(people.map(p=>({id:p.employmentId,tenantId:b.tenantId,personId:p.personId,companyId:companies[p.companyIndex].id,hiredOn:'2020-01-01'})));
   await owner.db.insert(s.assignment).values(people.map(p=>({tenantId:b.tenantId,employmentId:p.employmentId,companyId:companies[p.companyIndex].id,departmentId:departments[p.companyIndex].id,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
   const type=await createClaimType(ctx,{code:'PERF_PENDING',name:'Fictional retained pending Claims',requiresReceipt:false,defaultTaxable:false});
   for(let offset=0;offset<people.length;offset+=50){
    const ids=people.slice(offset,offset+50).map(p=>p.employmentId);
    await owner.client`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
     select ${b.tenantId}::uuid,e.id,${type.id}::uuid,1,'2026-01-01'::date,'pending',
      '2026-01-02T00:00:00Z'::timestamptz-n*interval '1 minute'
     from unnest(${ids}::uuid[])e(id)cross join generate_series(1,2000)n`;
    report.committedClaims=t*500_000+(offset+50)*2000;save();
   }
   actors.push({name:t?'foreign-groupHR':'groupHR',ctx,companyIds:companies.map(c=>c.id),employmentIds:people.map(p=>p.employmentId)});
   if(t===0){
    const companyUser=randomUUID(),employeeUser=randomUUID(),employee=people[4];
    await owner.db.insert(s.appUser).values([{id:companyUser,tenantId:b.tenantId,workosUserId:'perf_'+companyUser},{id:employeeUser,tenantId:b.tenantId,personId:employee.personId,workosUserId:'perf_'+employeeUser}]);
    await owner.db.insert(s.roleAssignment).values([{tenantId:b.tenantId,appUserId:companyUser,role:'hr_admin',companyId:companies[0].id},{tenantId:b.tenantId,appUserId:employeeUser,role:'employee',companyId:companies[0].id}]);
    actors.push({name:'companyHR',ctx:{...ctx,userId:companyUser,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:companies[0].id}]},companyIds:[companies[0].id],employmentIds:people.slice(0,50).map(p=>p.employmentId)});
    actors.push({name:'employee-no-decision-authority',ctx:{...ctx,userId:employeeUser,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:companies[0].id}]},companyIds:[companies[0].id],employmentIds:[],readEmploymentIds:[employee.employmentId]});
   }
  }
  for(const table of ['claim_request','person','employment','assignment','company','department','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
  const [count]=await owner.client`select count(*)::int as total,count(*)filter(where status='pending')::int as pending from claim_request`;
  expect(count).toEqual({total:1_000_000,pending:1_000_000});report.retainedCounts=count;report.fixtureMs=performance.now()-started;
  const snapshot=async()=>({
   policies:await owner.client`select policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public'and tablename='claim_request'order by policyname`,
   triggers:await owner.client`select tgname,pg_get_triggerdef(oid)as ddl,tgenabled from pg_trigger where tgrelid='public.claim_request'::regclass order by tgname`,
   functions:await owner.client`select oid::regprocedure::text as identity,pg_get_functiondef(oid)as ddl,proacl::text as acl from pg_proc where oid=any(array['app.visible_employment_ids()'::regprocedure,'app.delegated_subject_ids(text,text)'::regprocedure])order by 1`,
  });
  const originalSchema=await snapshot(),fullResults=new Map<string,unknown>(),expected=new Map<string,unknown>();
  for(const actor of actors){
   const oracle=await owner.client<{id:string}[]>`select id from claim_request where tenant_id=${actor.ctx.tenantId}::uuid and status='pending'and employment_id=any(${actor.employmentIds}::uuid[])order by created_at desc,id limit 25`;
   expected.set(actor.name,{total:actor.employmentIds.length*2000,ids:oracle.map(row=>row.id)});
  }
  const [initial]=await withTenant(actors[0].ctx,tx=>tx.execute<{jit:string}>(sql`select current_setting('jit')as jit`));
  report.originalApplicationJit=initial.jit;
  const actual=database.withTenant;let mode:'on'|'off'='on';
  const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>actual(ctx,async tx=>{
   await tx.execute(mode==='on'?sql`set local jit=on`:sql`set local jit=off`);
   const [state]=await tx.execute<{jit:string;role:string;readOnly:boolean;isolation:string}>(sql`select current_setting('jit')as jit,current_user as role,current_setting('transaction_read_only')='on'as "readOnly",current_setting('transaction_isolation')as isolation`);
   expect(state.jit).toBe(mode);expect(state.role).toBe('ai_hr_app');
   if(options?.readOnlySnapshot){expect(state.readOnly).toBe(true);expect(state.isolation).toBe('repeatable read');}
   return read(tx);
  },options));
  try{
   for(const [ordinal,jit]of(['on','off','off','on']as const).entries()){
    mode=jit;report.phase=String(ordinal)+'-'+jit;save();
    const companyActor=actors.find(actor=>actor.name==='companyHR')!;
    await expect(pendingClaimTaskSummary({...companyActor.ctx,grants:[{role:'hr_admin',companyId:null}]},companyActor.companyIds)).rejects.toThrow();
    for(const actor of actors){
     const began=performance.now(),result=await pendingClaimTaskSummary(actor.ctx,actor.companyIds),elapsedMs=performance.now()-began;
     expect({total:result.total,ids:result.items.map(row=>row.id)}).toEqual(expected.get(actor.name));
     if(ordinal===0)fullResults.set(actor.name,result);else expect(result).toEqual(fullResults.get(actor.name));
     const readIds=actor.readEmploymentIds??actor.employmentIds;
     const expectedIds=sql`array[${sql.join(readIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
     const [scope]=await withTenant(actor.ctx,tx=>tx.execute<{total:number;outside:number}>(sql`select count(*)::int as total,count(*)filter(where tenant_id<>${actor.ctx.tenantId}::uuid or not(employment_id=any(${expectedIds})))::int as outside from public.claim_request where status='pending'`));
     expect(scope).toEqual({total:readIds.length*2000,outside:0});
     measurements.push({ordinal,jit,actor:actor.name,elapsedMs,total:result.total,previewRows:result.items.length,exactFullDtoCountOrder:true,rawRlsOutside:scope.outside});save();
    }
   }
  }finally{spy.mockRestore();}
  const [restored]=await withTenant(actors[0].ctx,tx=>tx.execute<{jit:string}>(sql`select current_setting('jit')as jit`));
  expect(restored.jit).toBe(initial.jit);expect(await snapshot()).toEqual(originalSchema);
  report.transactionSettingRestored=true;report.nativePoliciesTriggersFunctionsUnchanged=true;report.phase='complete';save();
 }catch(error){report.errorType=(error as Error).name;report.phase='failed';save();throw error;}
 finally{save();}
},600000);
