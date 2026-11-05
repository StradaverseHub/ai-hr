/** Small native prequalification only; no new constraint, row cap, migration or production change. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {personnelListPage} from '../core/read';
import {lockAccessConfigurationReadTx} from '../core/access-configuration-lock';
import * as s from '../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {personnelNativeAggregatePrototype} from './performance/personnel-native-aggregate-prototype';
import {nativePersonnelPlanDiagnostic} from './performance/personnel-native-plan-diagnostic';
import {witnessCurrentAssignmentCardinality} from './performance/assignment-current-cardinality-witness';
import {personnelUnusedAssignmentFacts} from './performance/personnel-unused-assignment-prototype';
beforeAll(migrateTestDb);afterAll(closeAll);
it('omits only proven unused assignment joins while native detail/facets and every actor remain exact',async()=>{
 const report:Record<string,unknown>={kind:'SMALL_NATIVE_UNUSED_ASSIGNMENT_JOIN_PROOF_ONLY',releaseEligible:false};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'personnel-unused-assignment-plan.json'),JSON.stringify(report,null,2));};
 const ordering='performance_personnel_unused_name_order';let orderCreated=false;let originalFunctions:unknown;
 const functions=()=>owner.client`select oid::regprocedure::text as identity,prosrc,proowner::regrole::text as owner,proacl::text as acl,proconfig,procost,prorows from pg_proc where oid=any(array['app.access_workforce_list_facts()'::regprocedure,'app.access_workforce_list_rows_for_ids(uuid[])'::regprocedure,'app._access_workforce_list_rows(uuid[])'::regprocedure])order by oid`;
 try{
  await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);
  await witnessCurrentAssignmentCardinality(b,foreign,report,save);originalFunctions=Array.from(await functions());
  const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Plan company'}).returning();
  const departments=await owner.db.insert(s.department).values([{tenantId:b.tenantId,companyId:company.id,name:'Actual A'},{tenantId:b.tenantId,companyId:company.id,name:'Actual B'}]).returning();
  const people=Array.from({length:200},(_,n)=>({n,id:randomUUID(),employmentId:randomUUID(),name:n%50===0?'Repeated name':'Planning Person '+String(n).padStart(4,'0')}));
  await owner.db.insert(s.person).values(people.map(p=>({id:p.id,tenantId:b.tenantId,fullName:p.name,primaryEmail:p.id+'@example.invalid'})));
  await owner.db.insert(s.employment).values(people.map(p=>({id:p.employmentId,tenantId:b.tenantId,personId:p.id,companyId:company.id,hiredOn:'2020-01-01',employeeCode:'PRUNE'+p.n,terminatedOn:p.n%5===0?'2024-01-01':null})));
  // Reachable native history states, written in the real supersede-before-replacement order.
  await owner.db.insert(s.assignment).values([1,5].map(n=>({tenantId:b.tenantId,employmentId:people[n].employmentId,companyId:company.id,departmentId:departments[0].id,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
  await owner.client`update assignment set superseded_at=now()where employment_id=any(${[people[1].employmentId,people[5].employmentId]}::uuid[])`;
  await owner.db.insert(s.assignment).values(people.filter(p=>p.n!==0&&p.n!==1).map(p=>({tenantId:b.tenantId,employmentId:p.employmentId,companyId:company.id,departmentId:departments[p.n===2||p.n===5?1:0].id,employmentType:p.n===3?'contract' as const:'full_time' as const,validFrom:p.n===2?'2099-01-01':p.n===5?'2021-01-01':'2020-01-01'})));
  for(const table of ['person','employment','assignment','company'])await owner.client.unsafe('analyze '+table);
  const [facts]=await owner.client<{body:string;owner:string;columns:string[]}[]>`select prosrc as body,proowner::regrole::text as owner,proargnames as columns from pg_proc where oid='app.access_workforce_list_facts()'::regprocedure`;
  type Page=Parameters<typeof personnelListPage>[1];type Facets=Parameters<typeof personnelListPage>[2];
  const base={companyIds:[company.id]};
  const cases:{name:string;page:Page;facets:Facets;pruned:boolean}[]=[
   {name:'initial',page:{...base,limit:25,offset:0},facets:base,pruned:true},
   {name:'deep',page:{...base,limit:25,offset:175},facets:base,pruned:true},
   {name:'company-sort',page:{...base,sort:'company',limit:25,offset:0},facets:base,pruned:true},
   {name:'zero-limit',page:{...base,limit:0,offset:0},facets:base,pruned:true},
   {name:'independent-status',page:{...base,status:'active',limit:25,offset:0},facets:base,pruned:true},
   {name:'department-page',page:{...base,departmentId:departments[0].id,limit:25,offset:0},facets:base,pruned:false},
   {name:'department-facet',page:{...base,limit:25,offset:0},facets:{...base,departmentIds:[departments[1].id]},pruned:false},
   {name:'independent-departments',page:{...base,departmentIds:[departments[0].id],limit:25,offset:0},facets:{...base,departmentId:departments[1].id},pruned:false},
   {name:'type-page',page:{...base,employmentType:'contract',limit:25,offset:0},facets:base,pruned:false},
   {name:'type-facet',page:{...base,limit:25,offset:0},facets:{...base,employmentType:'contract'},pruned:false},
   {name:'independent-q',page:{...base,q:'PRUNE2',limit:25,offset:0},facets:{...base,q:'PRUNE5'},pruned:true},
   {name:'repeated-name-order',page:{...base,q:'Repeated name',limit:25,offset:0},facets:{...base,q:'Repeated name'},pruned:true},
  ];
  const records:{phase:string;mode:string;pruned:boolean;assignmentNodes:number;cost:number;plan:unknown}[]=[];
  const run=async(actor:SessionContext,value:typeof cases[number],prune:boolean,explain=false)=>{
   const chosen=prune?personnelUnusedAssignmentFacts(value.page,value.facets,facts):{facts,pruned:false};
   if(prune)expect(chosen.pruned).toBe(value.pruned);
   const native=await personnelNativeAggregatePrototype(value.page,value.facets,chosen.facts,false),diagnostic=explain?await nativePersonnelPlanDiagnostic(native.query):null;
   try{return await withTenant(actor,async tx=>{
    await lockAccessConfigurationReadTx(tx,actor.tenantId);
    const [row]=await tx.execute<{rows:unknown[];total:number;status_counts:{status:string;count:number}[]}>(native.query);
    const dto={rows:row.rows,total:Number(row.total),headcount:{total:row.status_counts.reduce((n,v)=>n+Number(v.count),0),byStatus:Object.fromEntries(row.status_counts.map(v=>[v.status,Number(v.count)]))}};
    const [result]=diagnostic?await tx.execute<{plan:{Plan:Record<string,unknown>}[]}>(diagnostic.query):[{plan:null}];return {dto,plan:result.plan,pruned:chosen.pruned};
   });}finally{if(diagnostic)await diagnostic.drop();await native.drop();}
  };
  for(const value of cases){
   const expected=await personnelListPage(ctx,value.page,value.facets),observed=await run(ctx,value,true);expect(observed.dto).toEqual(expected);
   if(value.name==='department-facet'){expect(observed.dto.total).toBe(200);expect(observed.dto.headcount.total).toBe(2);}
   if(value.name==='independent-departments'){expect(observed.dto.total).toBe(196);expect(observed.dto.headcount.total).toBe(2);}
   if(value.name==='type-facet')expect(observed.dto.headcount.total).toBe(1);
   // Real detail fields, not placeholders, survive zero/future/superseded assignment conditions.
   if(value.name==='initial'){
    const q={...base,q:'PRUNE2'},future=await run(ctx,{name:'future',page:{...q,limit:25,offset:0},facets:q,pruned:true},true);
    const actual=(future.dto.rows as {employmentId:string;departmentId:string|null}[]).find(row=>row.employmentId===people[2].employmentId);expect(actual?.departmentId).toBe(departments[1].id);
    for(const n of [0,1]){const p={...base,q:'PRUNE'+n},row=await run(ctx,{name:'zero-assignment',page:{...p,limit:25,offset:0},facets:p,pruned:true},true);expect((row.dto.rows as {employmentId:string;departmentId:string|null}[]).find(r=>r.employmentId===people[n].employmentId)?.departmentId).toBeNull();}
   }
  }
  report.semanticCases=cases.map(value=>({name:value.name,pruned:value.pruned,exactNativeDtoAndFacets:true}));save();
  const narrow=cases[0];
  for(const actor of [{...ctx,userId:randomUUID()},adminCtx(foreign)])expect((await run(actor,narrow,true)).dto).toEqual(await personnelListPage(actor,narrow.page,narrow.facets));
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,b.adminUserId));
  try{expect((await run(ctx,narrow,true)).dto).toEqual(await personnelListPage(ctx,narrow.page,narrow.facets));}finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,b.adminUserId));}
  const roles=await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,b.adminUserId)).returning();
  try{expect((await run(ctx,narrow,true)).dto).toEqual(await personnelListPage(ctx,narrow.page,narrow.facets));}finally{await owner.db.insert(s.roleAssignment).values(roles);}
  const scopedUser=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,scopedUser));
  const scoped={...ctx,userId:scopedUser,grants:[{role:'hr_admin',companyId:b.companyId}]};expect((await run(scoped,narrow,true)).dto).toEqual(await personnelListPage(scoped,narrow.page,narrow.facets));report.nativeActorControls=true;
  const inspect=async(phase:string,prune:boolean)=>{
   for(const name of ['initial','deep','department-facet']){
    const value=cases.find(v=>v.name===name)!,actual=await run(ctx,value,prune,true);expect(actual.dto).toEqual(await personnelListPage(ctx,value.page,value.facets));
    let assignmentNodes=0;const visit=(v:unknown)=>{if(Array.isArray(v))for(const row of v)visit(row);else if(v&&typeof v==='object'){const row=v as Record<string,unknown>;if(row['Relation Name']==='assignment')assignmentNodes++;for(const nested of Object.values(row))visit(nested);}};visit(actual.plan);
    records.push({phase,mode:name,pruned:actual.pruned,assignmentNodes,cost:Number(actual.plan![0].Plan['Total Cost']),plan:actual.plan});report.plans=records;save();
   }
  };
  await inspect('original-native-inline',false);await inspect('unused-join-omitted',true);
  await owner.client.unsafe('create index '+ordering+' on public.person(tenant_id,full_name,id)');orderCreated=true;await owner.client`analyze person`;await inspect('omitted-plus-name-order',true);
  for(const mode of ['initial','deep']){const before=records.find(r=>r.phase==='original-native-inline'&&r.mode===mode)!,after=records.find(r=>r.phase==='unused-join-omitted'&&r.mode===mode)!;expect(before.assignmentNodes).toBeGreaterThan(0);expect(after.assignmentNodes).toBe(0);expect(after.cost).toBeLessThan(before.cost);}
  expect(records.find(r=>r.phase==='unused-join-omitted'&&r.mode==='department-facet')!.assignmentNodes).toBeGreaterThan(0);
  report.smallNativePlanQualified=true;save();
 }finally{if(orderCreated)await owner.client.unsafe('drop index public.'+ordering);if(originalFunctions)expect(Array.from(await functions())).toEqual(originalFunctions);report.originalNativeFunctionsUnchanged=true;report.noNewConstraint=true;report.prototypeObjectsRemoved=true;save();}
},180000);
