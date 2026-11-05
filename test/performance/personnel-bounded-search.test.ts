/** Hosted retained-data experiment only; every native row trigger/constraint remains enabled. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {eq,sql,type SQL} from 'drizzle-orm';
import {personnelListPage,personnelListPageSql} from '../../core/read';
import {withTenant,type SessionContext} from '../../db/client';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import * as schema from '../../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from '../harness';
import {installPersonnelSearchProbe,readWithPersonnelSearchProbe,type SearchProbe} from './personnel-bounded-search-prototype';
const file='test/performance/personnel-bounded-search.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('compares atomic bounded search candidates with exact fallback over fifty thousand native employees',async()=>{
 const count=50_000,started=performance.now();let probe:SearchProbe|undefined,extensionCreated=false;
 const createdIndexes:string[]=[];
 const report:Record<string,unknown>={kind:'PERSONNEL_BOUNDED_SEARCH_50K_COMPONENT_ONLY',releaseEligible:false,targetEmployees:count,
  concurrentUsers:1,nativeTriggers:'unchanged',snapshot:'one SQL statement; fresh RC Access-read carrier',
  limitations:'Synthetic retained-data query experiment, not million-row or500-user/browser acceptance; optional index write probe is owner fixture update cost, not application CRUD throughput.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-bounded-search.json'),JSON.stringify(report,null,2));
 const phase=(value:string)=>{report.phase=value;report.elapsedMs=performance.now()-started;save();};
 let beforeFunctions:unknown;
 const functions=()=>owner.client`select oid::regprocedure::text as identity,prosrc,proowner::regrole::text as owner,proacl::text as acl,proconfig,procost,prorows from pg_proc where oid=any(array['app.access_workforce_list_facts()'::regprocedure,'app.access_workforce_list_rows_for_ids(uuid[])'::regprocedure,'app._access_workforce_list_rows(uuid[])'::regprocedure])order by oid`;
 try{
  await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx:SessionContext={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
  beforeFunctions=Array.from(await functions());
  const ids:string[]=[],personIds:string[]=[];
  for(let offset=0;offset<count;offset+=5000){
   const end=offset+5000,pp=randomUUID().slice(0,24),ep=randomUUID().slice(0,24);phase('native-fixture');
   await owner.client.begin(async tx=>{
    await tx`insert into person(id,tenant_id,full_name,primary_email)select(${pp}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,'Fictional retained Personnel '||lpad(n::text,9,'0'),(${pp}||lpad(n::text,12,'0'))||'@example.invalid'from generate_series(${offset+1}::int,${end}::int)n`;
    await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,terminated_on)select(${ep}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${pp}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,'PERF'||lpad(n::text,9,'0'),'2020-01-01'::date,case when n%5=0 then '2024-01-01'::date else null end from generate_series(${offset+1}::int,${end}::int)n`;
    await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)select ${b.tenantId}::uuid,(${ep}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,${b.deptA}::uuid,'full_time','2020-01-01'::date from generate_series(${offset+1}::int,${end}::int)n`;
   });
   for(let n=offset+1;n<=end;n++){ids.push(ep+String(n).padStart(12,'0'));personIds.push(pp+String(n).padStart(12,'0'));}
   report.committedFixtureEmployees=end;save();
  }
  await owner.client`update person set full_name='DUPMARK',primary_email='dupmark@example.invalid'where id=${personIds[0]}::uuid`;
  await owner.client`update employment set employee_code='DUPMARK',blacklisted_at='2025-01-01'where id=${ids[0]}::uuid`;
  await owner.client`update person set full_name='Literal %_ marker'where id=${personIds[1]}::uuid`;
  await owner.client`update person set full_name='Escape END%'where id=${personIds[2]}::uuid`;
  await owner.client`update person set full_name=${'Backslash\\middle'} where id=${personIds[3]}::uuid`;
  await owner.client`update person set primary_email='unique-email-search@example.invalid'where id=${personIds[4]}::uuid`;
  await owner.client`update employment set employee_code='LIMIT25-'||id::text where id=any(${ids.slice(100,125)}::uuid[])`;
  await owner.client`update employment set employee_code='LIMIT26-'||id::text where id=any(${ids.slice(150,176)}::uuid[])`;
  const [secondary]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Other same-tenant company'}).returning();
  const forbiddenPerson=randomUUID(),forbiddenEmployment=randomUUID(),foreignPerson=randomUUID(),foreignEmployment=randomUUID();
  await owner.db.insert(schema.person).values([{id:forbiddenPerson,tenantId:b.tenantId,fullName:'SCOPEFORBIDDEN',primaryEmail:'scope-forbidden@example.invalid'},{id:foreignPerson,tenantId:foreign.tenantId,fullName:'Foreign DUPMARK',primaryEmail:'foreign@example.invalid'}]);
  await owner.db.insert(schema.employment).values([{id:forbiddenEmployment,tenantId:b.tenantId,personId:forbiddenPerson,companyId:secondary.id,hiredOn:'2020-01-01'},{id:foreignEmployment,tenantId:foreign.tenantId,personId:foreignPerson,companyId:foreign.companyId,hiredOn:'2020-01-01'}]);
  for(const table of ['person','employment','assignment','company','department','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
  report.fixturePreparationMs=performance.now()-started;
  const [retained]=await owner.client`select count(*)::int as employees from employment where tenant_id=${b.tenantId}::uuid and company_id=${b.companyId}::uuid`;expect(retained.employees).toBe(count);
  const [identity]=await withTenant(ctx,tx=>tx.execute<{role:string}>(sql`select current_user as role`));expect(identity.role).toBe('ai_hr_app');
  probe=await installPersonnelSearchProbe();
  type Page=Parameters<typeof personnelListPage>[1];type Facets=Parameters<typeof personnelListPage>[2];
  const base={companyIds:[b.companyId,foreign.companyId]},filtered=(q:string)=>({...base,q});
  const cases:{name:string;page:Page;facets:Facets;bounded:boolean;rawHits?:number;total?:number}[]=[
   {name:'initial',page:{...base,limit:25,offset:0},facets:base,bounded:false,total:count},
   {name:'deep-page',page:{...base,limit:25,offset:count-25},facets:base,bounded:false,total:count},
   {name:'selective-code',page:{...filtered('PERF000050000'),limit:25,offset:0},facets:filtered('PERF000050000'),bounded:true,rawHits:1,total:1},
   {name:'duplicate-field-hit',page:{...filtered('DUPMARK'),limit:25,offset:0},facets:filtered('DUPMARK'),bounded:true,rawHits:2,total:1},
   {name:'trim-normalization',page:{...filtered(' \nDUPMARK\t '),limit:25,offset:0},facets:filtered('DUPMARK'),bounded:true,rawHits:2,total:1},
   {name:'email',page:{...filtered('unique-email-search'),limit:25,offset:0},facets:filtered('unique-email-search'),bounded:true,rawHits:1,total:1},
   {name:'escaped-wildcards',page:{...filtered('\\%\\_'),limit:25,offset:0},facets:filtered('\\%\\_'),bounded:true,total:1},
   {name:'trailing-escape',page:{...filtered('END\\'),limit:25,offset:0},facets:filtered('END\\'),bounded:true,total:1},
   {name:'literal-backslash',page:{...filtered('\\\\'),limit:25,offset:0},facets:filtered('\\\\'),bounded:true,total:1},
   {name:'empty-match',page:{...filtered('not-a-native-match'),limit:25,offset:0},facets:filtered('not-a-native-match'),bounded:true,rawHits:0,total:0},
   {name:'exactly25',page:{...filtered('LIMIT25-'),limit:25,offset:0},facets:filtered('LIMIT25-'),bounded:true,rawHits:25,total:25},
   {name:'overflow26',page:{...filtered('LIMIT26-'),limit:25,offset:0},facets:filtered('LIMIT26-'),bounded:false,rawHits:26,total:26},
   {name:'broad-code-fallback',page:{...filtered('PERF'),limit:25,offset:0},facets:filtered('PERF'),bounded:false,rawHits:26},
   {name:'broad-name-fallback',page:{...filtered('Fictional retained'),limit:25,offset:0},facets:filtered('Fictional retained'),bounded:false,rawHits:26},
   {name:'wildcard-fallback',page:{...filtered('%'),limit:25,offset:0},facets:filtered('%'),bounded:false,rawHits:26,total:count},
   {name:'independent-q',page:{...filtered('DUPMARK'),limit:25,offset:0},facets:filtered('LIMIT25-'),bounded:false,total:1},
   {name:'independent-status',page:{...filtered('unique-email-search'),status:'active',limit:25,offset:0},facets:filtered('unique-email-search'),bounded:true,total:0},
   {name:'independent-department',page:{...filtered('LIMIT25-'),departmentId:b.deptB,limit:25,offset:0},facets:{...filtered('LIMIT25-'),departmentId:b.deptA},bounded:true,total:0},
   {name:'independent-company',page:{...filtered('LIMIT25-'),limit:25,offset:0},facets:{companyIds:[secondary.id],q:'LIMIT25-'},bounded:true,total:25},
   {name:'zero-limit',page:{...filtered('LIMIT25-'),limit:0,offset:1},facets:filtered('LIMIT25-'),bounded:true,total:25},
   {name:'beyond-page',page:{...filtered('LIMIT25-'),limit:25,offset:26},facets:filtered('LIMIT25-'),bounded:true,total:25},
   {name:'company-sort',page:{...filtered('LIMIT25-'),sort:'company',limit:25,offset:1},facets:filtered('LIMIT25-'),bounded:true,total:25},
   {name:'empty-scope',page:{companyIds:[],q:'DUPMARK',limit:25,offset:0},facets:{companyIds:[],q:'DUPMARK'},bounded:true,total:0},
   {name:'all-authorized-companies',page:{q:'SCOPEFORBIDDEN',limit:25,offset:0},facets:{q:'SCOPEFORBIDDEN'},bounded:true,total:1},
  ];
  const controls:unknown[]=[],measurements:{mode:string;indexed:boolean;phase:string;reads:number;elapsedMs:number}[]=[],plans:unknown[]=[];
  for(const value of cases){
   phase('semantic-'+value.name);const expected=await personnelListPage(ctx,value.page,value.facets),observed=await readWithPersonnelSearchProbe(ctx,value.page,value.facets,probe);
   expect(observed.dto).toEqual(expected);expect(observed.usedBounded).toBe(value.bounded);if(value.rawHits!==undefined)expect(observed.rawHits).toBe(value.rawHits);if(value.total!==undefined)expect(observed.dto.total).toBe(value.total);
   expect(observed.dto.rows.some(row=>row.employmentId===foreignEmployment)).toBe(false);controls.push({name:value.name,rawHits:observed.rawHits,bounded:observed.usedBounded,exactRowsCountsFacetsOrder:true});
  }
  report.controls=controls;save();
  // Synthetic authorized relational fanout only, not invalid native assignment data or authority proof.
  const fanout=(source:SQL)=>sql`(select * from ${source}facts union all select employment_id,name,email,employee_code,company,company_id,${b.deptB}::uuid as department_id,employment_type,terminated_on,final_confirmation_date,confirmation_date,probation_end_date,provisional_end_on,resignation_date,last_working_date,blacklisted_at from ${source}facts where employment_id=${ids[0]}::uuid)`;
  for(const departmentId of [undefined,b.deptB]){
   const page={...filtered('DUPMARK'),departmentId,limit:25,offset:0},facets={...filtered('DUPMARK'),departmentId:b.deptA};
   const expected=await withTenant(ctx,async tx=>{
    await lockAccessConfigurationReadTx(tx,ctx.tenantId);
    const [row]=await tx.execute<{rows:unknown[];total:number;status_counts:{status:string;count:number}[]}>(personnelListPageSql(page,facets,{source:fanout(sql`app.access_workforce_list_facts()`),materialized:true,projectPageFacts:true}));
    return {rows:row.rows,total:Number(row.total),headcount:{total:row.status_counts.reduce((n,v)=>n+Number(v.count),0),byStatus:Object.fromEntries(row.status_counts.map(v=>[v.status,Number(v.count)]))}};
   });expect((await readWithPersonnelSearchProbe(ctx,page,facets,probe,fanout)).dto).toEqual(expected);
  }
  report.syntheticFanoutAndIndependentAssignmentFilters=true;
  const narrow=cases.find(value=>value.name==='selective-code')!;
  const scopedUser=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,scopedUser));
  const employeeUser=await createAppUser(b.tenantId,personIds[1],'employee');
  const actors:SessionContext[]=[{...ctx,userId:randomUUID()},{...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]},{...ctx,userId:scopedUser,grants:[{role:'hr_admin',companyId:b.companyId}]},{...ctx,userId:employeeUser,personId:personIds[1],roles:['employee'],grants:[{role:'employee',companyId:null}]}];
  for(const actor of actors)expect((await readWithPersonnelSearchProbe(actor,narrow.page,narrow.facets,probe)).dto).toEqual(await personnelListPage(actor,narrow.page,narrow.facets));
  const deniedScope={companyIds:[secondary.id],q:'SCOPEFORBIDDEN'};expect((await readWithPersonnelSearchProbe(actors[2],{...deniedScope,limit:25,offset:0},deniedScope,probe)).dto.total).toBe(0);
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,b.adminUserId));
  try{expect((await readWithPersonnelSearchProbe(ctx,narrow.page,narrow.facets,probe)).dto).toEqual(await personnelListPage(ctx,narrow.page,narrow.facets));}
  finally{await owner.db.update(schema.appUser).set({archivedAt:null}).where(eq(schema.appUser.id,b.adminUserId));}
  const deleted=await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,b.adminUserId)).returning();
  try{expect((await readWithPersonnelSearchProbe(ctx,narrow.page,narrow.facets,probe)).dto).toEqual(await personnelListPage(ctx,narrow.page,narrow.facets));}
  finally{await owner.db.insert(schema.roleAssignment).values(deleted);}
  report.archivedForgedRevokedForeignEmployeeAndScopedHrControls=true;save();
  const benchmark=async(indexed:boolean)=>{
   for(const name of ['initial','selective-code','exactly25','deep-page','broad-code-fallback','broad-name-fallback']){
    const value=cases.find(item=>item.name===name)!,expected=await personnelListPage(ctx,value.page,value.facets);phase((indexed?'indexed-':'no-index-')+name);
    for(const namePhase of ['original','candidate','candidate-warm','restored']){
     const began=performance.now();for(let n=0;n<3;n++)expect(namePhase.startsWith('candidate')?(await readWithPersonnelSearchProbe(ctx,value.page,value.facets,probe!)).dto:await personnelListPage(ctx,value.page,value.facets)).toEqual(expected);
     measurements.push({mode:name,indexed,phase:namePhase,reads:3,elapsedMs:performance.now()-began});
    }
    if(['selective-code','exactly25','broad-code-fallback'].includes(name))plans.push({mode:name,indexed,...await readWithPersonnelSearchProbe(ctx,value.page,value.facets,probe!,undefined,true)});
   }report.measurements=measurements;report.plans=plans;save();
  };
  const writes:unknown[]=[];
  const measureWrites=async(indexed:boolean)=>{
   const targetPeople=personIds.slice(-100),targetIds=ids.slice(-100);
   const previousPeople=await owner.client`select id,primary_email from person where id=any(${targetPeople}::uuid[])`,previousEmployment=await owner.client`select id,employee_code from employment where id=any(${targetIds}::uuid[])`;
   const began=performance.now();
   await owner.client.begin(async tx=>{
    await tx`update person set primary_email='write-probe-'||id::text||'@example.invalid'where id=any(${targetPeople}::uuid[])`;
    await tx`update employment set employee_code='WRITE-'||id::text where id=any(${targetIds}::uuid[])`;
   });const elapsedMs=performance.now()-began;
   await owner.client.begin(async tx=>{for(const row of previousPeople)await tx`update person set primary_email=${row.primary_email} where id=${row.id}::uuid`;for(const row of previousEmployment)await tx`update employment set employee_code=${row.employee_code} where id=${row.id}::uuid`;});
   writes.push({indexed,personRows:100,employmentRows:100,elapsedMs,kind:'OWNER_NATIVE_FIXTURE_UPDATES_NOT_APP_CRUD'});report.writeProbe=writes;save();
  };
  await benchmark(false);await measureWrites(false);
  const [extension]=await owner.client`select exists(select 1 from pg_extension where extname='pg_trgm')as present`;
  if(!extension.present){await owner.client`create extension pg_trgm`;extensionCreated=true;}
  const names=['performance_personnel_search_person_gin','performance_personnel_search_code_gin'];
  for(const name of names){const [present]=await owner.client`select to_regclass(${'public.'+name})as relation`;expect(present.relation).toBeNull();}
  phase('index-build');const indexBegan=performance.now();
  await owner.client.unsafe('create index '+names[0]+' on public.person using gin(full_name gin_trgm_ops,primary_email gin_trgm_ops)');createdIndexes.push(names[0]);
  await owner.client.unsafe('create index '+names[1]+' on public.employment using gin(employee_code gin_trgm_ops)');createdIndexes.push(names[1]);
  report.indexBuildMs=performance.now()-indexBegan;report.indexBytes=await owner.client`select relname,pg_relation_size(oid)::text as bytes from pg_class where relname=any(${names}::text[])order by relname`;
  await owner.client`analyze person`;await owner.client`analyze employment`;await benchmark(true);await measureWrites(true);
  const improvements=[false,true].map(indexed=>{const rows=measurements.filter(item=>item.indexed===indexed&&item.mode==='selective-code');return{indexed,ratio:Math.max(rows[1].elapsedMs,rows[2].elapsedMs)/Math.min(rows[0].elapsedMs,rows[3].elapsedMs)};});
  report.selectiveImprovement=improvements;phase('complete');
  expect(improvements.some(value=>value.ratio<.8),'At least one selective search plan must improve>=20% against the faster original/restored native control').toBe(true);
 }catch(error){report.errorType=(error as Error).name;phase('failed');throw error;}
 finally{
  for(const name of [...createdIndexes].reverse())await owner.client.unsafe('drop index if exists public.'+name);
  if(probe)await probe.drop();if(extensionCreated)await owner.client`drop extension pg_trgm`;
  if(beforeFunctions)expect(Array.from(await functions())).toEqual(beforeFunctions);
  report.prototypeFunctionsAndIndexesRemoved=true;report.originalNativeFunctionsUnchanged=true;save();
 }
},600000);
