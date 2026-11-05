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
 const count=50_000,started=performance.now();let probe:SearchProbe|undefined,plainProbe:SearchProbe|undefined,extensionCreated=false,diagnosticInstalled=false;
 const createdIndexes:string[]=[],diagnostic='app.performance_personnel_overflow_explain';
 const report:Record<string,unknown>={kind:'PERSONNEL_BOUNDED_SEARCH_OVERFLOW_SAMPLE_50K_ONLY',releaseEligible:false,targetEmployees:count,
  concurrentUsers:1,nativeTriggers:'unchanged',snapshot:'one SQL statement; fresh RC Access-read carrier',
  limitations:'Synthetic retained-data query experiment, not million-row or500-user/browser acceptance; write costs for unchanged indexes measured separately in41966136847.'};
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
  const [extension]=await owner.client`select exists(select 1 from pg_extension where extname='pg_trgm')as present`;
  if(!extension.present){await owner.client`create extension pg_trgm`;extensionCreated=true;}
  const names=['performance_personnel_search_person_gin','performance_personnel_search_code_gin'];
  for(const name of names){const [present]=await owner.client`select to_regclass(${'public.'+name})as relation`;expect(present.relation).toBeNull();}
  phase('index-build');const indexBegan=performance.now();
  await owner.client.unsafe('create index '+names[0]+' on public.person using gin(full_name gin_trgm_ops,primary_email gin_trgm_ops)');createdIndexes.push(names[0]);
  await owner.client.unsafe('create index '+names[1]+' on public.employment using gin(employee_code gin_trgm_ops)');createdIndexes.push(names[1]);
  report.indexBuildMs=performance.now()-indexBegan;report.indexBytes=await owner.client`select relname,pg_relation_size(oid)::text as bytes from pg_class where relname=any(${names}::text[])order by relname`;
  await owner.client`analyze person`;await owner.client`analyze employment`;
  probe=await installPersonnelSearchProbe(true);
  plainProbe=await installPersonnelSearchProbe(false);
  const [source]=await owner.client<{body:string;owner:string}[]>`select prosrc as body,proowner::regrole::text as owner from pg_proc where oid=${probe.name+'(text,uuid[])'}::regprocedure`;
  const body=source.body.replaceAll('search_pattern','$1').replaceAll('company_scope','$2');
  await owner.client.begin(async tx=>{
   await tx.unsafe('create function '+diagnostic+'(pattern text,scope uuid[]) returns json language plpgsql volatile security definer set search_path=pg_catalog,public,pg_temp as $diag$declare result json;begin execute $query$explain(analyze,buffers,format json) '+body+'$query$ into result using pattern,scope;return result;end$diag$');
   await tx.unsafe('revoke all on function '+diagnostic+'(text,uuid[]) from public;grant execute on function '+diagnostic+'(text,uuid[]) to ai_hr_app');
   const [properties]=await tx`select proowner::regrole::text as owner,prosecdef as definer,has_function_privilege('ai_hr_app',oid,'EXECUTE')as app,exists(select 1 from aclexplode(proacl) where grantee=0 and privilege_type='EXECUTE')as public_execute from pg_proc where oid=${diagnostic+'(text,uuid[])'}::regprocedure`;
   expect(properties).toEqual({owner:source.owner,definer:true,app:true,public_execute:false});
  });diagnosticInstalled=true;
  type Page=Parameters<typeof personnelListPage>[1];type Facets=Parameters<typeof personnelListPage>[2];
  const base={companyIds:[b.companyId,foreign.companyId]},filtered=(q:string)=>({...base,q});
  const cases:{name:string;page:Page;facets:Facets;bounded:boolean;rawHits?:number;total?:number}[]=[
   {name:'initial',page:{...base,limit:25,offset:0},facets:base,bounded:false,total:count},
   {name:'deep-page',page:{...base,limit:25,offset:count-25},facets:base,bounded:false,total:count},
   {name:'selective-code',page:{...filtered('PERF000050000'),limit:25,offset:0},facets:filtered('PERF000050000'),bounded:true,rawHits:1,total:1},
   {name:'selective-name',page:{...filtered('Fictional retained Personnel 000050000'),limit:25,offset:0},facets:filtered('Fictional retained Personnel 000050000'),bounded:true,rawHits:1,total:1},
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
   {name:'broad-name-fallback',page:{...filtered('Fictional retained Personnel'),limit:25,offset:0},facets:filtered('Fictional retained Personnel'),bounded:false,rawHits:26},
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
  const controls:unknown[]=[],measurements:{mode:string;phase:string;reads:number;elapsedMs:number;maxReadMs:number}[]=[],plans:unknown[]=[];
  for(const value of cases){
   phase('semantic-'+value.name);const expected=await personnelListPage(ctx,value.page,value.facets),observed=await readWithPersonnelSearchProbe(ctx,value.page,value.facets,probe);
   expect(observed.dto).toEqual(expected);expect(observed.usedBounded).toBe(value.bounded);if(value.rawHits!==undefined)expect(observed.rawHits).toBe(value.rawHits);if(value.total!==undefined)expect(observed.dto.total).toBe(value.total);
   expect(observed.dto.rows.some(row=>row.employmentId===foreignEmployment)).toBe(false);
   if(['broad-code-fallback','broad-name-fallback','wildcard-fallback'].includes(value.name))expect(observed.usedSampleOverflow).toBe(true);
   if(value.bounded)expect(observed.usedSampleOverflow).toBe(false);
   controls.push({name:value.name,rawHits:observed.rawHits,bounded:observed.usedBounded,sampleOverflow:observed.usedSampleOverflow,exactRowsCountsFacetsOrder:true});
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
  const modes=['initial','selective-code','selective-name','email','exactly25','deep-page','overflow26','broad-code-fallback','broad-name-fallback','wildcard-fallback'];
  const broadModes=['broad-code-fallback','broad-name-fallback','wildcard-fallback'];
  const selective=['selective-code','selective-name','email','exactly25'];
  const planDuration=(plan:unknown)=>{
   const rows=plan as Record<string,Record<string,number>[]>[];
   return Number(rows[0]['QUERY PLAN'][0]['Execution Time']);
  };
  const probeCost:Record<string,unknown>[]=[],internalPlans:Record<string,unknown>[]=[];
  const nodes=(v:unknown):Record<string,unknown>[]=>Array.isArray(v)?v.flatMap(nodes):v&&typeof v==='object'?
   [...('Node Type' in v?[v as Record<string,unknown>]:[]),...Object.values(v).flatMap(nodes)]:[];
  for(const name of modes){
   const value=cases.find(item=>item.name===name)!,expected=await personnelListPage(ctx,value.page,value.facets);phase('paired-'+name);
   const broad=broadModes.includes(name);
   for(const stage of ['original',...(broad?['prior-indexed-probe']:[]),'candidate','candidate-warm','restored']){
    const durations:number[]=[];
    for(let n=0;n<3;n++){
     const start=performance.now(),observed=stage.startsWith('candidate')?await readWithPersonnelSearchProbe(ctx,value.page,value.facets,probe!)
      :stage==='prior-indexed-probe'?await readWithPersonnelSearchProbe(ctx,value.page,value.facets,plainProbe!):null;
     const dto=observed?.dto??await personnelListPage(ctx,value.page,value.facets);
     durations.push(performance.now()-start);expect(dto).toEqual(expected);
     if(observed&&broad)expect(observed.usedSampleOverflow).toBe(stage.startsWith('candidate'));
    }
    measurements.push({mode:name,phase:stage,reads:3,elapsedMs:durations.reduce((sum,v)=>sum+v,0),maxReadMs:Math.max(...durations)});
    report.measurements=measurements;save();
   }
   if(selective.includes(name)||broad){
    const after=await readWithPersonnelSearchProbe(ctx,value.page,value.facets,probe!,undefined,true);expect(after.dto).toEqual(expected);
    plans.push({mode:name,variant:'candidate',...after});
    const scope=sql`array[${sql.join(base.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
    const internal=await withTenant(ctx,async tx=>{
     await lockAccessConfigurationReadTx(tx,ctx.tenantId);
     const [row]=await tx.execute<{plan:unknown}>(sql`select ${sql.raw(diagnostic)}(${'%'+value.page.q+'%'},${scope}) as plan`);
     return row.plan;
    });
    const indexed=nodes(internal).find(node=>node['Subplan Name']==='CTE indexed_hits');
    const sample=nodes(internal).find(node=>node['Subplan Name']==='CTE sampled');
    internalPlans.push({mode:name,indexedLoops:indexed?.['Actual Loops'],sampleRows:sample?.['Actual Rows'],plan:internal});
    report.internalPlans=internalPlans;save();
    expect(indexed?.['Actual Loops'],name+' native full probe executions').toBe(broad?0:1);
    expect(Number(sample?.['Actual Rows']),name+' bounded sample rows').toBeLessThanOrEqual(128);
    if(broad){
     const before=await readWithPersonnelSearchProbe(ctx,value.page,value.facets,plainProbe!,undefined,true);expect(before.dto).toEqual(expected);
     plans.push({mode:name,variant:'prior-indexed-probe',...before});
     probeCost.push({mode:name,originalProbeMs:planDuration(before.plans?.probe),sampleProbeMs:planDuration(after.plans?.probe),sampleUsed:after.usedSampleOverflow});
    }
    report.plans=plans;report.probeCost=probeCost;save();
   }
  }
  const comparisons=modes.map(mode=>{
   const rows=measurements.filter(item=>item.mode===mode),baseline=rows.filter(r=>r.phase==='original'||r.phase==='restored'),candidates=rows.filter(r=>r.phase.startsWith('candidate'));
   const ratio=Math.max(...candidates.map(r=>r.elapsedMs))/Math.min(...baseline.map(r=>r.elapsedMs)),maxReadMs=Math.max(...candidates.map(r=>r.maxReadMs));
   return {mode,ratio,maxReadMs,qualified:selective.includes(mode)?ratio<.8&&maxReadMs<1000:ratio<=1.1};
  });
  report.comparisons=comparisons;phase('all-measured');
  expect(comparisons.filter(v=>broadModes.includes(v.mode)||selective.includes(v.mode)).every(v=>v.qualified),'selective gain and every broad control within unchanged 10% regression bound').toBe(true);
  phase('complete');
 }catch(error){report.errorType=(error as Error).name;phase('failed');throw error;}
 finally{
  if(diagnosticInstalled)await owner.client.unsafe('drop function '+diagnostic+'(text,uuid[])');
  for(const name of [...createdIndexes].reverse())await owner.client.unsafe('drop index if exists public.'+name);
  if(probe)await probe.drop();if(plainProbe)await plainProbe.drop();if(extensionCreated)await owner.client`drop extension pg_trgm`;
  if(beforeFunctions)expect(Array.from(await functions())).toEqual(beforeFunctions);
  report.prototypeFunctionsAndIndexesRemoved=true;report.originalNativeFunctionsUnchanged=true;save();
 }
},600000);
