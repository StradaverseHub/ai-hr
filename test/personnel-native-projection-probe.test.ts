/** Private native prototype on published policy-equivalent pre-financial7cfc; never replaces a public projection. */
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {and,eq,ilike,inArray,isNotNull,isNull,or,sql,type SQL} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import * as s from '../db/schema';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {countEmployeesByStatus,listEmployeesPage,type EmployeeListFilters} from '../core/read';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);

type Page=EmployeeListFilters&{limit:number;offset:number;sort?:'name'|'company'};
type Result={rows:{employmentId:string;name:string;reportingTo:string|null}[];total:number;headcount:{total:number;byStatus:Record<string,number>}};
const where=(p:EmployeeListFilters)=>and(
 p.companyIds?.length===0?sql`false`:p.companyIds?inArray(sql`m.company_id`,p.companyIds):undefined,
 p.companyId?eq(sql`m.company_id`,p.companyId):undefined,
 p.filterCompanyIds?.length?inArray(sql`m.company_id`,p.filterCompanyIds):undefined,
 p.departmentId?eq(sql`m.department_id`,p.departmentId):undefined,
 p.departmentIds?.length?inArray(sql`m.department_id`,p.departmentIds):undefined,
 p.employmentStatuses?.length?inArray(sql`m.status`,p.employmentStatuses):undefined,
 p.status==='terminated'?isNotNull(sql`m.terminated_on`):p.status==='active'?isNull(sql`m.terminated_on`):undefined,
 p.employmentType?eq(sql`m.employment_type`,p.employmentType):undefined,
 p.q?.trim()?or(ilike(sql`m.name`,'%'+p.q.trim()+'%'),ilike(sql`m.email`,'%'+p.q.trim()+'%'),ilike(sql`m.employee_code`,'%'+p.q.trim()+'%')):undefined,
)??sql`true`;
const statusJson=(today:string)=>sql`app.employment_status_on((value->>'blacklistedAt')::timestamptz,(value->>'resignationDate')::date,(value->>'lastWorkingDate')::date,(value->>'terminatedOn')::date,(value->>'finalConfirmationDate')::date,(value->>'confirmationDate')::date,(value->>'probationEndDate')::date,(value->>'provisionalEndOn')::date,${today}::date)`;
async function readTx(tx:Tx,native:boolean,page:Page,facets:EmployeeListFilters,factored=false,fast=false,trusted=false):Promise<Result>{
 const today=todayInKualaLumpur();
 const source=native?sql`select * from app.perf_personnel_minimal(${today}::date)`:sql`select value,(value->>'employmentId')::uuid as id,value->>'name' as name,value->>'email' as email,value->>'employeeCode' as employee_code,(value->>'departmentId')::uuid as department_id,(value->>'companyId')::uuid as company_id,value->>'employmentType' as employment_type,(value->>'terminatedOn')::date as terminated_on,${statusJson(today)} as status,value->>'company' as company from ${trusted?sql`app.perf_personnel_trusted()`:fast?sql`app.perf_personnel_fast()`:factored?sql`app.perf_personnel_factored()`:sql`app.access_workforce_list_rows()`} as w(value)`;
 const name=page.sort==='company'?sql`lower(m.name)`:sql`m.name`,order=page.sort==='company'?sql`lower(m.company),${name}`:name;
 const aggOrder=page.sort==='company'?sql`sel.company_key,sel.name_key`:sql`sel.name_key`;
 const rowsSource=native?sql`app.perf_personnel_wide(coalesce((select array_agg(id) from page_ids),'{}'::uuid[])) as w(value) join page_ids sel on sel.id=(w.value->>'employmentId')::uuid`:sql`page_ids sel`;
 const value=native?sql`w.value`:sql`sel.value`;
 const [out]=await tx.execute<{rows:Result['rows'];total:number;counts:{status:string;count:number}[]}>(sql`
 with m as materialized (${source}),page_ids as materialized (
  select m.*,lower(m.company) as company_key,${name} as name_key from m where ${where(page)} order by ${order} limit ${page.limit} offset ${page.offset}
 ) select coalesce((select jsonb_agg(${value} order by ${aggOrder}) from ${rowsSource}),'[]'::jsonb) as rows,
 (select count(distinct m.id)::int from m where ${where(page)}) as total,
 coalesce((select jsonb_agg(jsonb_build_object('status',c.status,'count',c.count)) from (select m.status,count(distinct m.id)::int as count from m where ${where(facets)} group by 1)c),'[]'::jsonb)as counts`);
 const byStatus:Record<string,number>={};let total=0;for(const row of out.counts){byStatus[row.status]=Number(row.count);total+=Number(row.count);}
 return {rows:out.rows,total:Number(out.total),headcount:{total,byStatus}};
}
it('qualifies a narrow-count/bounded-wide prototype against the current exact projection, including live scope and native failure recovery',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);const ids:string[]=[];
 await owner.client.unsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
 async function append(base:Base,from:number,to:number,prefix:string){
  const result:string[]=[];
  for(let start=from;start<to;start+=256){
   const people=Array.from({length:Math.min(256,to-start)},(_,j)=>({id:randomUUID(),tenantId:base.tenantId,fullName:'Fictional native '+prefix+String(start+j).padStart(7,'0'),primaryEmail:prefix+(start+j)+'@example.invalid',gender:(start+j)%2===0?'female':'male'}));
   const rows=people.map((p,j)=>({id:randomUUID(),tenantId:base.tenantId,personId:p.id,companyId:base.companyId,employeeCode:prefix+String(start+j).padStart(7,'0'),hiredOn:'2020-01-01',terminatedOn:(start+j)%5===0?'2024-01-01':null}));
   await owner.db.insert(s.person).values(people);await owner.db.insert(s.employment).values(rows);
   await owner.db.insert(s.assignment).values(rows.map((e,j)=>({tenantId:base.tenantId,employmentId:e.id,companyId:base.companyId,departmentId:(start+j)%2===0?base.deptA:base.deptB,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
   result.push(...rows.map(e=>e.id));
  }return result;
 }
 const foreignIds=await append(foreign,0,7,'FOREIGN');
 const signature='app.access_workforce_list_rows()';const [original]=await owner.client`select pg_get_functiondef(p.oid) as definition,p.prosrc as body,to_jsonb(p) as attributes from pg_proc p where p.oid=${signature}::regprocedure`;
 expect(createHash('sha256').update(original.body).digest('hex')).toBe('c46bc8f629c6c5f51675548e90bd2a8348feb1dc91f3a72c81d37a25a88db23a');expect(original.body).toContain('AND app.data_permission_matches(me.id)');expect(original.body).toContain('AND app.data_permission_matches(e.id)');
 const select=' SELECT jsonb_build_object(',from=' FROM public.employment e JOIN permitted allowed';
 expect(original.body.split(select)).toHaveLength(2);expect(original.body.split(from)).toHaveLength(2);
 const [wrapper]=await owner.client`select pg_get_functiondef(p.oid)as definition,prosrc as body from pg_proc p where oid='app.data_permission_matches(uuid,date)'::regprocedure`;
 const signatures=['app.data_permission_matches_for(uuid,uuid,uuid,date)','app.data_permission_subject_for(uuid,uuid,date)','app.data_permission_matches(uuid,date)','app.principal_snapshot_current()'];
 const originals=await owner.client`select p.oid::text as oid,pg_get_functiondef(p.oid)as definition,p.prosrc as body,to_jsonb(p)as attributes from pg_proc p where p.oid=any(${signatures}::regprocedure[])order by p.oid`;
 const [matcher]=originals.filter(row=>row.definition.startsWith('CREATE OR REPLACE FUNCTION app.data_permission_matches_for('));
 const [subjectOwner]=originals.filter(row=>row.definition.startsWith('CREATE OR REPLACE FUNCTION app.data_permission_subject_for('));
 expect(createHash('sha256').update(matcher.body).digest('hex')).toBe('58364d3d83ba8222a6b610de0f738f74e576e42bb7543434ae82305854804c20');expect(createHash('sha256').update(subjectOwner.body).digest('hex')).toBe('fb98549d73688cf5460b67e429ab54f7844b98c47ed2f115d7e4ebe265e057e2');
 const [ownership]=await owner.client`select p.proowner=(select oid from pg_roles where rolname=current_user) and p.proowner=(select proowner from pg_proc where oid='app.data_permission_subject_for(uuid,uuid,date)'::regprocedure) and p.proowner=(select proowner from pg_proc where oid='app.access_workforce_list_rows()'::regprocedure) and p.proowner=(select relowner from pg_class where oid='user_data_permission_assignment'::regclass)as same from pg_proc p where p.oid='app.data_permission_matches_for(uuid,uuid,uuid,date)'::regprocedure`;
 expect(ownership.same).toBe(true); // Test fixture ownership only; installed ownership needs separate qualification.
 const subjectStart=' subject:=app.data_permission_subject_for(p_tenant,p_employment,p_date);',lookupStart=' SELECT profile.* INTO p FROM public.user_data_permission_assignment a LEFT JOIN public.data_permission_profile profile',lookupEnd=' IF NOT FOUND THEN RETURN true;END IF;';
 expect(matcher.body.split(subjectStart)).toHaveLength(2);expect(matcher.body.split(lookupStart)).toHaveLength(2);expect(matcher.body.split(lookupEnd)).toHaveLength(2);
 const subjectOffset=matcher.body.indexOf(subjectStart),lookupOffset=matcher.body.indexOf(lookupStart),lookupEndOffset=matcher.body.indexOf(lookupEnd);
 expect(subjectOffset).toBeLessThan(lookupOffset);expect(lookupOffset).toBeLessThan(lookupEndOffset);
 // Same single profile lookup in the configured branch; no duplicate precheck.
 const fastMatchBody=matcher.body.slice(0,subjectOffset)+matcher.body.slice(lookupOffset,lookupEndOffset)+` IF NOT FOUND THEN RETURN EXISTS(SELECT 1 FROM public.employment e JOIN public.person target_person ON target_person.id=e.person_id AND target_person.tenant_id=e.tenant_id WHERE e.id=p_employment AND e.tenant_id=p_tenant AND e.voided_at IS NULL AND target_person.voided_at IS NULL);END IF;\n`+matcher.body.slice(subjectOffset,lookupOffset)+matcher.body.slice(lookupEndOffset+lookupEnd.length);
 const [principalOwner]=originals.filter(row=>row.definition.startsWith('CREATE OR REPLACE FUNCTION app.principal_snapshot_current('));
 expect(createHash('sha256').update(principalOwner.body).digest('hex')).toBe('42404ac86659acde0fd7ac4066db904e5e5abb4ddccf59ef15546e81c61bcd6a');
 const actorStart=' IF NOT EXISTS(SELECT 1 FROM public.app_user u',actorEnd='THEN RETURN false;END IF;';
 expect(fastMatchBody.split(actorStart)).toHaveLength(2);const actorOffset=fastMatchBody.indexOf(actorStart),actorEndOffset=fastMatchBody.indexOf(actorEnd,actorOffset)+actorEnd.length;expect(actorEndOffset).toBeGreaterThan(actorOffset);
 // Only proof-gated current-actor callers may use this private helper; the general matcher stays intact.
 const trustedMatchBody=fastMatchBody.slice(0,actorOffset)+fastMatchBody.slice(actorEndOffset);
 const trustedMatch=matcher.definition.replace('app.data_permission_matches_for(','app.perf_personnel_trusted_for(').replace(matcher.body,trustedMatchBody);
 const trustedWrapper=wrapper.definition.replace('app.data_permission_matches(','app.perf_personnel_trusted_match(').replace(wrapper.body,' SELECT CASE WHEN app.principal_snapshot_current() THEN app.perf_personnel_trusted_for(app.current_user_id(),app.current_tenant_id(),p_employment,p_date) ELSE false END;');
 const fastMatch=matcher.definition.replace('app.data_permission_matches_for(','app.perf_personnel_match_for(').replace(matcher.body,fastMatchBody);
 const fastWrapper=wrapper.definition.replace('app.data_permission_matches(','app.perf_personnel_match(').replace('app.data_permission_matches_for(','app.perf_personnel_match_for(');
 expect(wrapper.body.replace(/\s+/g,' ').trim()).toBe('SELECT app.principal_snapshot_current() AND app.data_permission_matches_for(app.current_user_id(),app.current_tenant_id(),p_employment,p_date);');
 // STABLE proofs share this statement's snapshot only. Later statements create a fresh CTE.
 let factoredBody=original.body.replace(' WITH permitted AS MATERIALIZED (',' WITH principal_proof AS MATERIALIZED (SELECT app.principal_snapshot_current() AS valid), permitted AS MATERIALIZED (');
 expect(factoredBody).not.toBe(original.body);
 for(const alias of ['e','me'])factoredBody=factoredBody.replace('app.data_permission_matches('+alias+'.id)','((SELECT valid FROM principal_proof) AND app.data_permission_matches_for(app.current_user_id(),app.current_tenant_id(),'+alias+'.id,current_date))');
 expect(factoredBody).not.toContain('app.data_permission_matches(');
 const fastBody=factoredBody.replaceAll('app.data_permission_matches_for(','app.perf_personnel_match_for(');
 let trustedBody=original.body.replace(' WITH permitted AS MATERIALIZED (',' WITH principal_proof AS MATERIALIZED (SELECT app.principal_snapshot_current() AS valid), permitted AS MATERIALIZED (');
 for(const alias of ['e','me'])trustedBody=trustedBody.replace('app.data_permission_matches('+alias+'.id)','(CASE WHEN (SELECT valid FROM principal_proof) THEN app.perf_personnel_trusted_for(app.current_user_id(),app.current_tenant_id(),'+alias+'.id,current_date) ELSE false END)');
 const prefix=trustedBody.slice(0,trustedBody.indexOf(select)),tail=trustedBody.slice(trustedBody.indexOf(from));
 const minimal=prefix+` SELECT e.id,p.full_name::text,p.primary_email::text,e.employee_code::text,a.department_id,e.company_id,a.employment_type::text,e.terminated_on,
 app.employment_status_on(e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on,e.final_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on,p_today)::text,co.legal_name::text\n`+tail;
 const wide=original.definition.replace(signature,'app.perf_personnel_wide(p_ids uuid[])').replace(original.body,original.body.trim().replace(/;$/,'')+' AND e.id=ANY(p_ids);');
 const report:Record<string,unknown>={kind:'PRIVATE_NATIVE_PERSONNEL_PROTOTYPE_NOT_RELEASE_OR_CAPACITY',ownerSource:'7cfcebef22e7b2acfcd7a7ea86de35a5059ef1bd',ownerBodySha256:createHash('sha256').update(original.body).digest('hex'),publicUnchanged:false,privateHelpersDropped:false,statementLocalPrincipalProof:true,profileLookupReordered:true,proofGatedPrivateActorPath:true,privateTrustedBodySha256:createHash('sha256').update(trustedMatchBody).digest('hex'),privateTrustedProjectionSha256:createHash('sha256').update(trustedBody).digest('hex'),sameOwnerFixture:true,matcherBodySha256:'58364d3d83ba8222a6b610de0f738f74e576e42bb7543434ae82305854804c20',controls:0,volumes:[],complete:false,limitations:'Current published security snapshot, simple organization, native single-reader prototype only; no shared SQL edits, migration, provider access, full500 run or deployment.'};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/personnel-native-projection.json',JSON.stringify(report));};
 const page:Page={companyIds:[b.companyId],limit:25,offset:0},facets={companyIds:[b.companyId]};
 const read=(native:boolean,p=page,f:EmployeeListFilters=facets,actor:SessionContext=ctx,factored=false,fast=false,trusted=false)=>withTenant(actor,async tx=>{await lockAccessConfigurationTx(tx,actor.tenantId);return readTx(tx,native,p,f,factored,fast,trusted);});
 const compare=async(p=page,f:EmployeeListFilters=facets,actor:SessionContext=ctx)=>{const old=await read(false,p,f,actor);expect(await read(true,p,f,actor)).toEqual(old);expect(await read(false,p,f,actor,true)).toEqual(old);expect(await read(false,p,f,actor,true,true)).toEqual(old);expect(await read(false,p,f,actor,true,true,true)).toEqual(old);report.controls=Number(report.controls)+1;return old;};
 try{
  await owner.client.begin(async tx=>{
   await tx.unsafe(trustedMatch);await tx.unsafe(trustedWrapper);await tx.unsafe(original.definition.replace(signature,'app.perf_personnel_trusted()').replace(original.body,trustedBody));
   await tx.unsafe('REVOKE ALL ON FUNCTION app.perf_personnel_trusted_for(uuid,uuid,uuid,date),app.perf_personnel_trusted_match(uuid,date),app.perf_personnel_trusted() FROM PUBLIC,ai_hr_app;GRANT EXECUTE ON FUNCTION app.perf_personnel_trusted_match(uuid,date),app.perf_personnel_trusted() TO ai_hr_app');
   await tx.unsafe(fastMatch);await tx.unsafe(fastWrapper);await tx.unsafe('REVOKE ALL ON FUNCTION app.perf_personnel_match_for(uuid,uuid,uuid,date),app.perf_personnel_match(uuid,date) FROM PUBLIC,ai_hr_app;GRANT EXECUTE ON FUNCTION app.perf_personnel_match(uuid,date) TO ai_hr_app');
   await tx.unsafe(original.definition.replace(signature,'app.perf_personnel_fast()').replace(original.body,fastBody));await tx.unsafe('REVOKE ALL ON FUNCTION app.perf_personnel_fast() FROM PUBLIC,ai_hr_app;GRANT EXECUTE ON FUNCTION app.perf_personnel_fast() TO ai_hr_app');
   await tx.unsafe(`CREATE FUNCTION app.perf_personnel_minimal(p_today date) RETURNS TABLE(id uuid,name text,email text,employee_code text,department_id uuid,company_id uuid,employment_type text,terminated_on date,status text,company text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $minimal$${minimal}$minimal$`);
   await tx.unsafe(wide);await tx.unsafe(original.definition.replace(signature,'app.perf_personnel_factored()').replace(original.body,factoredBody));await tx.unsafe('REVOKE ALL ON FUNCTION app.perf_personnel_minimal(date),app.perf_personnel_wide(uuid[]),app.perf_personnel_factored() FROM PUBLIC,ai_hr_app;GRANT EXECUTE ON FUNCTION app.perf_personnel_minimal(date),app.perf_personnel_wide(uuid[]),app.perf_personnel_factored() TO ai_hr_app');
  });save();
  let privateRefused=false;
  try{await withTenant(ctx,tx=>tx.execute(sql`select app.perf_personnel_trusted_for(${ctx.userId!}::uuid,${ctx.tenantId}::uuid,${randomUUID()}::uuid,current_date)`));}catch(error){let e=error as {code?:string;cause?:unknown};while(e.cause&&!e.code)e=e.cause as typeof e;expect(e.code).toBe('42501');privateRefused=true;}
  expect(privateRefused).toBe(true);report.directPrivateAPPCallRefused=true;
  const policyStats=async()=>{
   const out:Record<string,{calls:number;execMs:number}>={};
   const rows=await owner.client`select query,calls,total_exec_time from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database())`;
   for(const row of rows){const q=String(row.query).replace(/\s+/g,' ').trim().toLowerCase();if(q.startsWith('create'))continue;
    const key=q.includes('from app.principal(app.current_user_id())')?'principalSnapshot':q.startsWith('select app.principal_snapshot_current() and app.data_permission_matches_for(')?'dataMatchWrapper':q.includes('jsonb_build_object(')&&q.includes('from public.employment e join public.person p')?'subjectProjection':q.includes('from public.user_data_permission_assignment a left join public.data_permission_profile profile')?'profileLookup':q.includes('from public.app_user u')&&q.includes('app.login_blocked(u.id)')?'actorEligibility':null;
    if(key){out[key]??={calls:0,execMs:0};out[key].calls+=Number(row.calls);out[key].execMs+=Number(row.total_exec_time);}
   }return out;
  };
  const measure=async(size:number)=>{
   ids.push(...await append(b,ids.length,size,'MAIN'));await owner.client.unsafe('ANALYZE person,employment,assignment');
   const current=await compare();const resigned=Array.from({length:size},(_,i)=>i).filter(i=>i%5===0).length;
   expect(current.total).toBe(size);expect(current.rows.map(r=>r.employmentId)).toEqual(ids.slice(0,25));expect(current.headcount).toEqual({total:size,byStatus:{active:size-resigned,resigned}});
   const [legacyRows,legacyFacets]=await Promise.all([listEmployeesPage(ctx,page,'workforce'),countEmployeesByStatus(ctx,facets,'workforce')]);expect(current).toEqual({...legacyRows,headcount:legacyFacets});
   const rounds:Record<string,unknown>[]=[];const volume={size,rounds};(report.volumes as unknown[]).push(volume);save();
   for(let round=0;round<4;round++){
    let ownerMs=0,prototypeMs=0,factoredWideMs=0,fastWideMs=0,trustedWideMs=0;const old=async()=>{const t=performance.now();const v=await read(false);ownerMs=performance.now()-t;expect(v).toEqual(current);};const proposed=async()=>{const t=performance.now();const v=await read(true);prototypeMs=performance.now()-t;expect(v).toEqual(current);};
    const factored=async()=>{const t=performance.now();const v=await read(false,page,facets,ctx,true);factoredWideMs=performance.now()-t;expect(v).toEqual(current);};
    const fast=async()=>{const t=performance.now();const v=await read(false,page,facets,ctx,true,true);fastWideMs=performance.now()-t;expect(v).toEqual(current);};
    const trusted=async()=>{const t=performance.now();const v=await read(false,page,facets,ctx,true,true,true);trustedWideMs=performance.now()-t;expect(v).toEqual(current);};
    if(round%2===0){await old();await proposed();await factored();await fast();await trusted();}else{await trusted();await fast();await factored();await proposed();await old();}rounds.push({round,order:round%2===0?'owner-bounded-proof-plan-trusted':'trusted-plan-proof-bounded-owner',ownerMs,prototypeMs,factoredWideMs,fastWideMs,trustedWideMs});save();
   }
   const samples:Record<string,unknown>[]=[];(volume as typeof volume&{statementSamples:typeof samples}).statementSamples=samples;
   for(const mode of ['owner','bounded','factored-wide','fast-wide','trusted-wide']){
    const before=await policyStats(),start=performance.now();expect(await read(mode==='bounded',page,facets,ctx,mode==='factored-wide'||mode==='fast-wide'||mode==='trusted-wide',mode==='fast-wide'||mode==='trusted-wide',mode==='trusted-wide')).toEqual(current);const elapsedMs=performance.now()-start,after=await policyStats();
    const delta:Record<string,{calls:number;execMs:number}>={};for(const key of Object.keys(after))delta[key]={calls:after[key].calls-(before[key]?.calls??0),execMs:after[key].execMs-(before[key]?.execMs??0)};
    samples.push({mode,elapsedMs,nestedStatementDelta:delta});save();
   }
  };
  await measure(512);
  expect((await withTenant(ctx,tx=>tx.execute(sql`select current_user as role`)))[0].role).toBe('ai_hr_app');
  for(const p of [{...page,offset:25},{...page,offset:512-25},{...page,sort:'company' as const},{...page,q:'MAIN0000010'},{...page,q:'MAIN00000%'},{...page,departmentId:b.deptB},{...page,departmentIds:[b.deptA]},{...page,employmentStatuses:['resigned' as const]},{...page,status:'active' as const},{...page,status:'terminated' as const},{...page,employmentType:'contract'},{...page,companyIds:[]},{...page,companyIds:[foreign.companyId]}])await compare(p);
  const empty={rows:[],total:0,headcount:{total:0,byStatus:{}}};expect(await compare({...page,companyIds:[]},{companyIds:[]})).toEqual(empty);expect(await compare({...page,companyIds:[foreign.companyId]},{companyIds:[foreign.companyId]})).toEqual(empty);
  const [ungranted]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'native_ungranted_'+randomUUID()}).returning();expect(await compare(page,facets,{...ctx,userId:ungranted.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]})).toEqual(empty);
  await owner.db.insert(s.reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:ids[0],managerEmploymentId:ids[1],lineType:'administrative',validFrom:'2020-01-01'});
  expect((await compare()).rows[0].reportingTo).toBe('Fictional native MAIN0000001');
  const compareMatch=async(id:string|null,date:string|null=todayInKualaLumpur())=>withTenant(ctx,async tx=>{
   const [result]=await tx.execute<{actual:boolean;proposed:boolean;trusted:boolean}>(sql`select app.data_permission_matches(${id}::uuid,${date}::date)as actual,app.perf_personnel_match(${id}::uuid,${date}::date)as proposed,app.perf_personnel_trusted_match(${id}::uuid,${date}::date)as trusted`);expect(result.trusted).toBe(result.actual);expect(result.proposed).toBe(result.actual);report.matcherCases=Number(report.matcherCases??0)+1;return result.actual;
  });
  for(const id of [null,randomUUID(),foreignIds[0],ids[0],ids[1]])for(const date of [null,'2010-01-01','2020-01-01','2030-01-01'])await compareMatch(id,date);
  // Negative retained fixtures only: no claim to exercise the native void command.
  const voidPersonId=randomUUID(),normalPersonId=randomUUID(),personTarget=randomUUID(),employmentTarget=randomUUID();
  await owner.db.insert(s.person).values([{id:voidPersonId,tenantId:b.tenantId,fullName:'Fictional void person',primaryEmail:randomUUID()+'@example.invalid',voidedAt:new Date()},{id:normalPersonId,tenantId:b.tenantId,fullName:'Fictional void employment',primaryEmail:randomUUID()+'@example.invalid'}]);
  await owner.db.insert(s.employment).values([{id:personTarget,tenantId:b.tenantId,personId:voidPersonId,companyId:b.companyId,employeeCode:'VOID-PERSON',hiredOn:'2020-01-01'},{id:employmentTarget,tenantId:b.tenantId,personId:normalPersonId,companyId:b.companyId,hiredOn:'2020-01-01',voidedAt:new Date(),voidedBy:b.adminUserId,voidReason:'Fictional retained void exclusion target',voidedImportAttemptId:randomUUID(),employeeCode:null,voidedEmployeeCode:'VOID-EMPLOYMENT'}]);
  expect(await compareMatch(personTarget)).toBe(false);expect(await compareMatch(employmentTarget)).toBe(false);
  // Real live profile assignment and revision transitions; native owner remains policy authority.
  const profile=randomUUID(),revision=randomUUID();await owner.client`insert into data_permission_profile(id,tenant_id,name,enabled)values(${profile},${b.tenantId},'Fictional native profile',true)`;
  await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${revision},${b.tenantId},${profile},${JSON.stringify({legacyCompany:false,predicates:[{field:'gender',values:['female']}]})}::jsonb,${b.adminUserId})`;
  await owner.client`update data_permission_profile set active_revision_id=${revision} where id=${profile}`;await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${ctx.userId!},${profile},${b.adminUserId})`;
  const restricted=await compare();expect(restricted.total).toBe(256);expect(restricted.rows[0].reportingTo).toBeNull();expect(restricted.rows.map(r=>r.employmentId)).toEqual(ids.filter((_,i)=>i%2===0).slice(0,25));
  for(const id of [null,randomUUID(),foreignIds[0],ids[0],ids[1]])for(const date of [null,'2010-01-01','2030-01-01'])await compareMatch(id,date);
  const configuredRounds:{round:number;proofOnlyMs:number;reorderedMs:number;trustedMs:number}[]=[];report.configuredRounds=configuredRounds;
  for(let round=0;round<4;round++){
   let proofOnlyMs=0,reorderedMs=0,trustedMs=0;const proof=async()=>{const t=performance.now();expect(await read(false,page,facets,ctx,true)).toEqual(restricted);proofOnlyMs=performance.now()-t;};const reordered=async()=>{const t=performance.now();expect(await read(false,page,facets,ctx,true,true)).toEqual(restricted);reorderedMs=performance.now()-t;};
   const trusted=async()=>{const t=performance.now();expect(await read(false,page,facets,ctx,true,true,true)).toEqual(restricted);trustedMs=performance.now()-t;};
   if(round%2===0){await proof();await reordered();await trusted();}else{await trusted();await reordered();await proof();}configuredRounds.push({round,proofOnlyMs,reorderedMs,trustedMs});save();
  }
  const configuredSamples:{mode:string;profileLookupCalls:number;subjectCalls:number}[]=[];report.configuredSamples=configuredSamples;
  for(const mode of ['proof','reordered','trusted']){const before=await policyStats();expect(await read(false,page,facets,ctx,true,mode!=='proof',mode==='trusted')).toEqual(restricted);const after=await policyStats();configuredSamples.push({mode,profileLookupCalls:(after.profileLookup?.calls??0)-(before.profileLookup?.calls??0),subjectCalls:(after.subjectProjection?.calls??0)-(before.subjectProjection?.calls??0)});}save();
  await owner.client`update data_permission_profile set enabled=false where id=${profile}`;expect(await compare()).toEqual(empty);
  await owner.client`update data_permission_profile set enabled=true,active_revision_id=null where id=${profile}`;expect(await compare()).toEqual(empty);
  await owner.client`update data_permission_profile set active_revision_id=${revision} where id=${profile}`;expect(await compare()).toEqual(restricted);
  await owner.client`delete from user_data_permission_assignment where user_id=${ctx.userId!} and tenant_id=${b.tenantId}`;
  const outcome=async(native:boolean,grants?:string,factored=false,fast=false,trusted=false)=>{try{return {result:await withTenant(ctx,async tx=>{if(grants)await tx.execute(sql`select set_config('app.grants',${grants},true)`);await lockAccessConfigurationTx(tx,ctx.tenantId);await readTx(tx,native,page,facets,factored,fast,trusted);if(!grants)await tx.execute(sql`select 1/0`);return 'unexpected-success';})};}catch(error){let e=error as {code?:string;cause?:unknown};while(e.cause&&!e.code)e=e.cause as typeof e;return {error:e.code??String(e)};}};
  for(const grants of ['{broken','{}','null','[]']){const expected=await outcome(false,grants);expect(await outcome(true,grants)).toEqual(expected);expect(await outcome(false,grants,true)).toEqual(expected);expect(await outcome(false,grants,true,true)).toEqual(expected);expect(await outcome(false,grants,true,true,true)).toEqual(expected);}expect(await outcome(true)).toEqual({error:'22012'});expect(await outcome(false)).toEqual({error:'22012'});expect(await outcome(false,undefined,true)).toEqual({error:'22012'});expect(await outcome(false,undefined,true,true)).toEqual({error:'22012'});expect(await outcome(false,undefined,true,true,true)).toEqual({error:'22012'});expect((await compare()).total).toBe(512);
  await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${ctx.userId!},${profile},${b.adminUserId})`;
  await withTenant(ctx,async tx=>{
   expect((await readTx(tx,true,page,facets)).total).toBe(256);expect((await readTx(tx,false,page,facets,true)).total).toBe(256);
   await owner.client`update data_permission_profile set enabled=false where id=${profile}`;
   expect(await readTx(tx,true,page,facets)).toEqual(empty);expect(await readTx(tx,false,page,facets,true)).toEqual(empty);expect(await readTx(tx,false,page,facets,true,true)).toEqual(empty);expect(await readTx(tx,false,page,facets,true,true,true)).toEqual(empty);expect(await readTx(tx,false,page,facets)).toEqual(empty);
  });report.liveProfileRevocationSameTransaction=true;
  await owner.client`update data_permission_profile set enabled=true where id=${profile}`;await owner.client`delete from user_data_permission_assignment where user_id=${ctx.userId!} and tenant_id=${b.tenantId}`;
  await withTenant(ctx,async tx=>{
   expect((await readTx(tx,false,page,facets,true,true)).total).toBe(512);
   await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${ctx.userId!},${profile},${b.adminUserId})`;
   expect((await readTx(tx,true,page,facets)).total).toBe(256);expect((await readTx(tx,false,page,facets,true,true)).total).toBe(256);expect((await readTx(tx,false,page,facets)).total).toBe(256);
   await owner.client`delete from user_data_permission_assignment where user_id=${ctx.userId!} and tenant_id=${b.tenantId}`;expect((await readTx(tx,false,page,facets,true,true)).total).toBe(512);
  });report.liveAssignmentSameTransaction=true;
  const [scoped]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'native_scoped_'+randomUUID()}).returning();
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:scoped.id,role:'hr_admin',companyId:b.companyId});
  const actor={...ctx,userId:scoped.id,grants:[{role:'hr_admin',companyId:b.companyId}]};
  await withTenant(actor,async tx=>{
   expect((await readTx(tx,true,page,facets)).total).toBe(512);expect((await readTx(tx,false,page,facets,true)).total).toBe(512);
   await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,scoped.id));
   expect(await readTx(tx,true,page,facets)).toEqual(empty);expect(await readTx(tx,false,page,facets,true)).toEqual(empty);expect(await readTx(tx,false,page,facets,true,true)).toEqual(empty);expect(await readTx(tx,false,page,facets,true,true,true)).toEqual(empty);expect(await readTx(tx,false,page,facets)).toEqual(empty);
  });report.liveRoleRevocationSameTransaction=true;
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:scoped.id,role:'hr_admin',companyId:b.companyId});
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,scoped.id));expect(await compare(page,facets,actor)).toEqual(empty);
  expect(await compare(page,facets,{...ctx,userId:foreign.adminUserId})).toEqual(empty);
  await withTenant(ctx,async tx=>{
   expect((await readTx(tx,true,page,facets)).total).toBe(512);
   await tx.execute(sql`select set_config('app.user_id',${foreign.adminUserId},true)`);
   expect(await readTx(tx,true,page,facets)).toEqual(empty);expect(await readTx(tx,false,page,facets,true)).toEqual(empty);expect(await readTx(tx,false,page,facets,true,true)).toEqual(empty);expect(await readTx(tx,false,page,facets,true,true,true)).toEqual(empty);expect(await readTx(tx,false,page,facets)).toEqual(empty);
   await tx.execute(sql`select set_config('app.user_id',${ctx.userId!},true)`);expect((await readTx(tx,true,page,facets)).total).toBe(512);
  });report.liveActorRebindSameTransaction=true;
  await measure(8192);report.complete=true;
 }finally{
  await owner.client.unsafe('DROP FUNCTION IF EXISTS app.perf_personnel_minimal(date);DROP FUNCTION IF EXISTS app.perf_personnel_trusted();DROP FUNCTION IF EXISTS app.perf_personnel_trusted_match(uuid,date);DROP FUNCTION IF EXISTS app.perf_personnel_trusted_for(uuid,uuid,uuid,date);DROP FUNCTION IF EXISTS app.perf_personnel_wide(uuid[]);DROP FUNCTION IF EXISTS app.perf_personnel_factored();DROP FUNCTION IF EXISTS app.perf_personnel_fast();DROP FUNCTION IF EXISTS app.perf_personnel_match(uuid,date);DROP FUNCTION IF EXISTS app.perf_personnel_match_for(uuid,uuid,uuid,date)');report.privateHelpersDropped=true;
  const [after]=await owner.client`select pg_get_functiondef(p.oid)as definition,to_jsonb(p)as attributes from pg_proc p where p.oid=${signature}::regprocedure`;expect(after.definition).toBe(original.definition);expect(after.attributes).toEqual(original.attributes);const afterPolicy=await owner.client`select p.oid::text as oid,pg_get_functiondef(p.oid)as definition,p.prosrc as body,to_jsonb(p)as attributes from pg_proc p where p.oid=any(${signatures}::regprocedure[])order by p.oid`;expect(afterPolicy).toEqual(originals);report.publicUnchanged=true;save();
 }
},240000);
