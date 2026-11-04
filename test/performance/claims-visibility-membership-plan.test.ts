/** Reversible isolated native RLS plan experiment. Exact policy restoration is mandatory. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {pendingClaimTaskSummary,createClaimType,saveClaimDraft,deleteClaimDraft} from '../../packs/claims/service';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
const file='test/performance/claims-visibility-membership-plan.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('compares actual scoped previews across one million pending Claims before/hashed/restored',async()=>{
 const report:Record<string,unknown>={kind:'CLAIMS_RETAINED_MILLION_RLS_MEMBERSHIP_COMPONENT_ONLY',releaseEligible:false,
  concurrentUsers:1,targetClaims:1_000_000,nativeTriggers:'unchanged',limitations:'Fictional retained data; not browser timing or500-user acceptance.'};
 expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'claims-visibility-membership-plan.json'),JSON.stringify(report,null,2));
 let originalPolicy:string|undefined,changed=false;
 let ownDraft:{ctx:SessionContext;employmentId:string;claimTypeId:string}|undefined;
 const policy="claim_request_rls";
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
    ownDraft={ctx:{...ctx,userId:employeeUser,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:companies[0].id}]},employmentId:employee.employmentId,claimTypeId:type.id};
    actors.push({name:'employee-no-decision-authority',ctx:{...ctx,userId:employeeUser,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:companies[0].id}]},companyIds:[companies[0].id],employmentIds:[],readEmploymentIds:[employee.employmentId]});
   }
  }
  for(const table of ['claim_request','person','employment','assignment','company','department','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
  const [count]=await owner.client`select count(*)::int as total,count(*)filter(where status='pending')::int as pending from claim_request`;
  expect(count).toEqual({total:1_000_000,pending:1_000_000});report.retainedCounts=count;report.fixtureMs=performance.now()-started;
  const schemaSnapshot=async()=>{
   const policies=await owner.client`select policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='claim_request' order by policyname`;
   const triggers=await owner.client`select tgname,pg_get_triggerdef(oid)as ddl,tgenabled from pg_trigger where tgrelid='public.claim_request'::regclass order by tgname`;
   const [access]=await owner.client`select relacl::text as acl,relrowsecurity,relforcerowsecurity from pg_class where oid='public.claim_request'::regclass`;
   return{policies,triggers,access};
  };
  const originalSchema=await schemaSnapshot();
  const normal=originalSchema.policies.find(row=>row.policyname===policy);expect(normal).toBeTruthy();originalPolicy=normal!.qual!;
  // Compare parsed native expressions rather than guessing that no other owner has narrowed this policy.
  await owner.client.begin(async tx=>{
   await tx.unsafe("create policy performance_claim_array_reference on public.claim_request for select to ai_hr_app using (((tenant_id=app.current_tenant_id())and(employment_id=any((select app.visible_employment_ids())::uuid[]))))");
   const [reference]=await tx`select qual from pg_policies where schemaname='public'and tablename='claim_request'and policyname='performance_claim_array_reference'`;
   expect(reference.qual).toBe(originalPolicy);
   await tx.unsafe('drop policy performance_claim_array_reference on public.claim_request');
  });
  const native=await owner.client`select oid::regprocedure::text as identity,pg_get_functiondef(oid)as ddl,proacl::text as acl from pg_proc where oid=any(array['app.visible_employment_ids()'::regprocedure,'app.delegated_subject_ids(text,text)'::regprocedure])order by 1`;
  const unchanged=async()=>{
   const current=await schemaSnapshot();
   expect(current.access).toEqual(originalSchema.access);expect(current.triggers).toEqual(originalSchema.triggers);
   expect(current.policies.map(row=>row.policyname===policy?{...row,qual:originalPolicy}:row)).toEqual(originalSchema.policies);
   expect(await owner.client`select oid::regprocedure::text as identity,pg_get_functiondef(oid)as ddl,proacl::text as acl from pg_proc where oid=any(array['app.visible_employment_ids()'::regprocedure,'app.delegated_subject_ids(text,text)'::regprocedure])order by 1`).toEqual(native);
  };
  const expected=new Map<string,unknown>();
  for(const actor of actors){
   const oracle=await owner.client<{id:string}[]>`select id from claim_request where tenant_id=${actor.ctx.tenantId}::uuid and status='pending'
    and employment_id=any(${actor.employmentIds}::uuid[])order by created_at desc,id limit 25`;
   expected.set(actor.name,{total:actor.employmentIds.length*2000,ids:oracle.map(row=>row.id)});
  }
  const fullResults=new Map<string,unknown>();
  const measure=async(phase:string)=>{
   report.phase=phase;save();
   const companyActor=actors.find(actor=>actor.name==='companyHR')!;
   await expect(pendingClaimTaskSummary({...companyActor.ctx,grants:[{role:'hr_admin',companyId:null}]},companyActor.companyIds)).rejects.toThrow();
   for(const actor of actors){
    const [identity]=await withTenant(actor.ctx,tx=>tx.execute<{role:string}>(sql`select current_user as role`));expect(identity.role).toBe('ai_hr_app');
    const began=performance.now(),result=await pendingClaimTaskSummary(actor.ctx,actor.companyIds),elapsedMs=performance.now()-began;
    expect({total:result.total,ids:result.items.map(row=>row.id)}).toEqual(expected.get(actor.name));
    if(phase==='original')fullResults.set(actor.name,result);else expect(result).toEqual(fullResults.get(actor.name));
    const readIds=actor.readEmploymentIds??actor.employmentIds;
    const expectedIds=sql`array[${sql.join(readIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
    const [read]=await withTenant(actor.ctx,tx=>tx.execute<{total:number;outside:number}>(sql`select count(*)::int as total,count(*)filter(where tenant_id<>${actor.ctx.tenantId}::uuid or not(employment_id=any(${expectedIds})))::int as outside from public.claim_request where status='pending'`));
    expect(read).toEqual({total:readIds.length*2000,outside:0});
    // SELECT FOR UPDATE also exercises the unchanged UPDATE policy admission without mutating a claim.
    if(result.items[0])expect(await withTenant(actor.ctx,tx=>tx.execute(sql`select id from public.claim_request where id=${result.items[0].id}::uuid for update`))).toHaveLength(1);
    measurements.push({phase,actor:actor.name,elapsedMs,total:result.total,previewRows:result.items.length,rawReadRows:read.total,unexpectedScope:read.outside});save();
   }
  };
  const draftCrud=async(phase:string)=>{
   expect(ownDraft).toBeTruthy();const own=ownDraft!,input={employmentId:own.employmentId,claimTypeId:own.claimTypeId,amount:1,incurredOn:todayInKualaLumpur()};
   const draft=await saveClaimDraft(own.ctx,input);
   try{
    await expect(saveClaimDraft(actors[0].ctx,{...input,id:draft.id,amount:3})).rejects.toThrow();
    await saveClaimDraft(own.ctx,{...input,id:draft.id,amount:2});
    await expect(deleteClaimDraft(actors.find(actor=>actor.name==='foreign-groupHR')!.ctx,draft.id)).rejects.toThrow();
    await expect(deleteClaimDraft(actors[0].ctx,draft.id)).rejects.toThrow();
    const [stored]=await owner.client`select status,amount from claim_request where id=${draft.id}::uuid`;
    expect(stored.status).toBe('draft');expect(Number(stored.amount)).toBe(2);
   }finally{await deleteClaimDraft(own.ctx,draft.id);}
   expect(await owner.client`select id from claim_request where id=${draft.id}::uuid`).toHaveLength(0);
   (report.draftCrud??=[] as unknown[]);(report.draftCrud as unknown[]).push({phase,ownCreateEditDelete:true,adminAndForeignRefused:true});save();
  };
  await measure('original');await draftCrud('original');
  await owner.client.unsafe('alter policy '+policy+' on public.claim_request using (tenant_id=app.current_tenant_id()and employment_id in(select unnest(app.visible_employment_ids())))');changed=true;
  await unchanged();
  await measure('hashed');await measure('hashed-warm');await draftCrud('hashed');
  const plans=await withTenant(actors[0].ctx,tx=>tx.execute(sql`explain(analyze,buffers,format json)select count(*)from public.claim_request where status='pending'`));
  report.hashedPlan=Array.from(plans);report.hashedSubplanObserved=JSON.stringify(plans).includes('hashed SubPlan');
  await owner.client.unsafe('alter policy '+policy+' on public.claim_request using ('+originalPolicy+')');changed=false;
  expect(await schemaSnapshot()).toEqual(originalSchema);
  await unchanged();await measure('restored');await draftCrud('restored');report.completed=true;
 }finally{
  if(originalPolicy){
   await owner.client.unsafe('alter policy '+policy+' on public.claim_request using ('+originalPolicy+')');changed=false;
   const [restored]=await owner.client`select qual from pg_policies where schemaname='public'and tablename='claim_request'and policyname=${policy}`;
   expect(restored.qual).toBe(originalPolicy);report.prototypePolicyRestored=true;
  }else report.prototypePolicyRestored=!changed;
  save();
 }
},600000);
