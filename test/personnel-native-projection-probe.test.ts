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
async function readTx(tx:Tx,native:boolean,page:Page,facets:EmployeeListFilters):Promise<Result>{
 const today=todayInKualaLumpur();
 const source=native?sql`select * from app.perf_personnel_minimal(${today}::date)`:sql`select value,(value->>'employmentId')::uuid as id,value->>'name' as name,value->>'email' as email,value->>'employeeCode' as employee_code,(value->>'departmentId')::uuid as department_id,(value->>'companyId')::uuid as company_id,value->>'employmentType' as employment_type,(value->>'terminatedOn')::date as terminated_on,${statusJson(today)} as status,value->>'company' as company from app.access_workforce_list_rows() as w(value)`;
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
 await append(foreign,0,7,'FOREIGN');
 const signature='app.access_workforce_list_rows()';const [original]=await owner.client`select pg_get_functiondef(p.oid) as definition,p.prosrc as body,to_jsonb(p) as attributes from pg_proc p where p.oid=${signature}::regprocedure`;
 expect(createHash('sha256').update(original.body).digest('hex')).toBe('c46bc8f629c6c5f51675548e90bd2a8348feb1dc91f3a72c81d37a25a88db23a');expect(original.body).toContain('AND app.data_permission_matches(me.id)');expect(original.body).toContain('AND app.data_permission_matches(e.id)');
 const select=' SELECT jsonb_build_object(',from=' FROM public.employment e JOIN permitted allowed';
 expect(original.body.split(select)).toHaveLength(2);expect(original.body.split(from)).toHaveLength(2);
 const prefix=original.body.slice(0,original.body.indexOf(select)),tail=original.body.slice(original.body.indexOf(from));
 const minimal=prefix+` SELECT e.id,p.full_name::text,p.primary_email::text,e.employee_code::text,a.department_id,e.company_id,a.employment_type::text,e.terminated_on,
 app.employment_status_on(e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on,e.final_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on,p_today)::text,co.legal_name::text\n`+tail;
 const wide=original.definition.replace(signature,'app.perf_personnel_wide(p_ids uuid[])').replace(original.body,original.body.trim().replace(/;$/,'')+' AND e.id=ANY(p_ids);');
 const report:Record<string,unknown>={kind:'PRIVATE_NATIVE_PERSONNEL_PROTOTYPE_NOT_RELEASE_OR_CAPACITY',ownerSource:'7cfcebef22e7b2acfcd7a7ea86de35a5059ef1bd',ownerBodySha256:createHash('sha256').update(original.body).digest('hex'),publicUnchanged:false,privateHelpersDropped:false,controls:0,volumes:[],complete:false,limitations:'Current published security snapshot, simple organization, native single-reader prototype only; no shared SQL edits, migration, provider access, full500 run or deployment.'};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/personnel-native-projection.json',JSON.stringify(report));};
 const page:Page={companyIds:[b.companyId],limit:25,offset:0},facets={companyIds:[b.companyId]};
 const read=(native:boolean,p=page,f:EmployeeListFilters=facets,actor:SessionContext=ctx)=>withTenant(actor,async tx=>{await lockAccessConfigurationTx(tx,actor.tenantId);return readTx(tx,native,p,f);});
 const compare=async(p=page,f:EmployeeListFilters=facets,actor:SessionContext=ctx)=>{const old=await read(false,p,f,actor);expect(await read(true,p,f,actor)).toEqual(old);report.controls=Number(report.controls)+1;return old;};
 try{
  await owner.client.begin(async tx=>{
   await tx.unsafe(`CREATE FUNCTION app.perf_personnel_minimal(p_today date) RETURNS TABLE(id uuid,name text,email text,employee_code text,department_id uuid,company_id uuid,employment_type text,terminated_on date,status text,company text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $minimal$${minimal}$minimal$`);
   await tx.unsafe(wide);await tx.unsafe('REVOKE ALL ON FUNCTION app.perf_personnel_minimal(date),app.perf_personnel_wide(uuid[]) FROM PUBLIC,ai_hr_app;GRANT EXECUTE ON FUNCTION app.perf_personnel_minimal(date),app.perf_personnel_wide(uuid[]) TO ai_hr_app');
  });save();
  for(const size of [512,4096]){
   ids.push(...await append(b,ids.length,size,'MAIN'));await owner.client.unsafe('ANALYZE person,employment,assignment');
   const current=await compare();const resigned=Array.from({length:size},(_,i)=>i).filter(i=>i%5===0).length;
   expect(current.total).toBe(size);expect(current.rows.map(r=>r.employmentId)).toEqual(ids.slice(0,25));expect(current.headcount).toEqual({total:size,byStatus:{active:size-resigned,resigned}});
   const [legacyRows,legacyFacets]=await Promise.all([listEmployeesPage(ctx,page,'workforce'),countEmployeesByStatus(ctx,facets,'workforce')]);expect(current).toEqual({...legacyRows,headcount:legacyFacets});
   const rounds:Record<string,unknown>[]=[];const volume={size,rounds};(report.volumes as unknown[]).push(volume);save();
   for(let round=0;round<4;round++){
    let ownerMs=0,prototypeMs=0;const old=async()=>{const t=performance.now();const v=await read(false);ownerMs=performance.now()-t;expect(v).toEqual(current);};const proposed=async()=>{const t=performance.now();const v=await read(true);prototypeMs=performance.now()-t;expect(v).toEqual(current);};
    if(round%2===0){await old();await proposed();}else{await proposed();await old();}rounds.push({round,order:round%2===0?'owner-prototype':'prototype-owner',ownerMs,prototypeMs});save();
   }
  }
  for(const p of [{...page,offset:25},{...page,offset:4096-25},{...page,sort:'company' as const},{...page,q:'MAIN0000010'},{...page,q:'MAIN00000%'},{...page,departmentId:b.deptB},{...page,departmentIds:[b.deptA]},{...page,employmentStatuses:['resigned' as const]},{...page,status:'active' as const},{...page,status:'terminated' as const},{...page,employmentType:'contract'},{...page,companyIds:[]},{...page,companyIds:[foreign.companyId]}])await compare(p);
  const empty={rows:[],total:0,headcount:{total:0,byStatus:{}}};expect(await compare({...page,companyIds:[]},{companyIds:[]})).toEqual(empty);expect(await compare({...page,companyIds:[foreign.companyId]},{companyIds:[foreign.companyId]})).toEqual(empty);
  const [ungranted]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'native_ungranted_'+randomUUID()}).returning();expect(await compare(page,facets,{...ctx,userId:ungranted.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]})).toEqual(empty);
  // Real live profile assignment and revision transitions; native owner remains policy authority.
  const profile=randomUUID(),revision=randomUUID();await owner.client`insert into data_permission_profile(id,tenant_id,name,enabled)values(${profile},${b.tenantId},'Fictional native profile',true)`;
  await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${revision},${b.tenantId},${profile},${JSON.stringify({legacyCompany:false,predicates:[{field:'gender',values:['female']}]})}::jsonb,${b.adminUserId})`;
  await owner.client`update data_permission_profile set active_revision_id=${revision} where id=${profile}`;await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${ctx.userId!},${profile},${b.adminUserId})`;
  const restricted=await compare();expect(restricted.total).toBe(2048);expect(restricted.rows.map(r=>r.employmentId)).toEqual(ids.filter((_,i)=>i%2===0).slice(0,25));
  await owner.client`update data_permission_profile set enabled=false where id=${profile}`;expect(await compare()).toEqual(empty);
  await owner.client`update data_permission_profile set enabled=true,active_revision_id=null where id=${profile}`;expect(await compare()).toEqual(empty);
  await owner.client`update data_permission_profile set active_revision_id=${revision} where id=${profile}`;expect(await compare()).toEqual(restricted);
  await owner.client`delete from user_data_permission_assignment where user_id=${ctx.userId!} and tenant_id=${b.tenantId}`;
  const outcome=async(native:boolean,grants?:string)=>{try{return {result:await withTenant(ctx,async tx=>{if(grants)await tx.execute(sql`select set_config('app.grants',${grants},true)`);await lockAccessConfigurationTx(tx,ctx.tenantId);await readTx(tx,native,page,facets);if(!grants)await tx.execute(sql`select 1/0`);return 'unexpected-success';})};}catch(error){let e=error as {code?:string;cause?:unknown};while(e.cause&&!e.code)e=e.cause as typeof e;return {error:e.code??String(e)};}};
  for(const grants of ['{broken','{}','null','[]'])expect(await outcome(true,grants)).toEqual(await outcome(false,grants));expect(await outcome(true)).toEqual({error:'22012'});expect(await outcome(false)).toEqual({error:'22012'});expect((await compare()).total).toBe(4096);
  report.complete=true;
 }finally{
  await owner.client.unsafe('DROP FUNCTION IF EXISTS app.perf_personnel_minimal(date);DROP FUNCTION IF EXISTS app.perf_personnel_wide(uuid[])');report.privateHelpersDropped=true;
  const [after]=await owner.client`select pg_get_functiondef(p.oid)as definition,to_jsonb(p)as attributes from pg_proc p where p.oid=${signature}::regprocedure`;expect(after.definition).toBe(original.definition);expect(after.attributes).toEqual(original.attributes);report.publicUnchanged=true;save();
 }
},240000);
