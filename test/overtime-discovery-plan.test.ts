/** Native invoker reader: same selection, live table RLS and target spelling as the former query. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import type {OvertimePattern} from '../lib/overtime-pattern-model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {hasOvertimePatternForDayTx,saveOvertimePatternDraft,validateOvertimePatternActivation,activateOvertimePattern,saveOvertimePatternAssignment} from '../packs/attendance/overtime-patterns';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
const yes=(id:string)=>({id,type:'constant' as const,value:true});
function pattern(earningId:string):OvertimePattern{return {v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'earliest',eligibility:yes('eligible'),eligibleMinutes:{id:'fraction',type:'literal',unit:'minutes',value:'60.5'},durationCap:null,durationRounding:null,deductions:[],rates:[{id:'rate',name:'Test payment',description:'Fixture policy',priority:0,when:yes('rate_when'),timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:earningId,currency:'MYR'},payment:{method:'flat',basis:'day',chargeId:'day_charge',amount:{id:'amount',type:'literal',unit:'money',currency:'MYR',value:'25'}}}]}],paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};}


let privateCreated=false;
const publicSnapshot=async()=>(await owner.client`select pg_get_functiondef(p.oid) as definition,p.prosrc as body,p.prosecdef,p.provolatile,p.proconfig,p.proacl::text as acl from pg_proc p where p.oid='app.overtime_formula_candidate_for_day(uuid,text,date,uuid)'::regprocedure`)[0];
let originalPublic:Awaited<ReturnType<typeof publicSnapshot>>;
beforeAll(async()=>{
 await migrateTestDb();originalPublic=await publicSnapshot();
 expect(originalPublic.prosecdef).toBe(false);expect(originalPublic.provolatile).toBe('s');
 const select=' SELECT a.id INTO answer FROM public.overtime_pattern_assignment a';
 const tenant=" WHERE a.tenant_id=p_tenant AND v.kind='formula' AND pat.archived_at IS NULL";
 const dated=' AND a.superseded_at IS NULL AND a.valid_from<=p_date AND (a.valid_to IS NULL OR a.valid_to>p_date)';
 const target=" AND (a.target->>'type'='group' OR a.target->'employmentIds' ? p_employment)";
 for(const part of [select,tenant,dated,target])expect(originalPublic.body.split(part)).toHaveLength(2);
 // Keep every original table, column privilege and RLS owner in one statement.
 // The fence avoids joining versions/patterns before finding eligible assignments.
 const body=originalPublic.body.replace(select,'__CANDIDATE_SELECT__')
  .replace(tenant," WHERE v.kind='formula' AND pat.archived_at IS NULL").replace(dated,'').replace(target,'')
  .replace('__CANDIDATE_SELECT__'," WITH candidate_assignments AS MATERIALIZED (\n SELECT a.id,a.version_id FROM public.overtime_pattern_assignment a WHERE a.tenant_id=p_tenant\n"+dated+'\n'+target+"\n ) SELECT a.id INTO answer FROM candidate_assignments a");
 expect((await owner.client`select to_regprocedure('app.perf_formula_empty_candidate(uuid,text,date,uuid)') as oid`)[0].oid).toBeNull();
 await owner.client.unsafe('CREATE FUNCTION app.perf_formula_empty_candidate(p_tenant uuid,p_employment text,p_date date,p_company uuid) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $perf$'+body+'$perf$');privateCreated=true;
 await owner.client.unsafe('REVOKE ALL ON FUNCTION app.perf_formula_empty_candidate(uuid,text,date,uuid) FROM PUBLIC,ai_hr_app');
 await owner.client.unsafe('GRANT EXECUTE ON FUNCTION app.perf_formula_empty_candidate(uuid,text,date,uuid) TO ai_hr_app');
});
afterAll(async()=>{
 try{if(privateCreated)await owner.client.unsafe('DROP FUNCTION app.perf_formula_empty_candidate(uuid,text,date,uuid)');expect((await owner.client`select to_regprocedure('app.perf_formula_empty_candidate(uuid,text,date,uuid)') as oid`)[0].oid).toBeNull();expect(await publicSnapshot()).toEqual(originalPublic);}
 finally{await closeAll();}
});
const signature='app.overtime_formula_candidate_for_day(uuid,text,date,uuid)';
it('runs as the caller with live table RLS and no public execute privilege',async()=>{
 const [fn]=await owner.client`select p.prosecdef,p.provolatile,p.proconfig,has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE') as public_execute from pg_proc p where p.oid=${signature}::regprocedure`;
 expect(fn).toMatchObject({prosecdef:false,provolatile:'s',app_execute:true,public_execute:false});expect(fn.proconfig.some((value:string)=>value.replaceAll(' ','')==='search_path=pg_catalog,public,pg_temp')).toBe(true);
 const tables=await owner.client`select relrowsecurity,relforcerowsecurity from pg_class where oid=any(array['public.overtime_pattern'::regclass,'public.overtime_pattern_version'::regclass,'public.overtime_pattern_assignment'::regclass])`;expect(tables).toHaveLength(3);expect(tables.every(row=>row.relrowsecurity&&row.relforcerowsecurity)).toBe(true);
});
it('matches the independent original query and actual stage reader across identities, dates and live principal changes',async()=>{
 await resetDb();const tenants=[await seedBase(),await seedBase()],day=todayInKualaLumpur();
 const people:{tenant:number;id:string;personId:string;employmentId:string}[]=[];
 for(let t=0;t<2;t++)for(let n=0;n<2;n++)people.push({tenant:t,id:randomUUID(),personId:randomUUID(),employmentId:randomUUID()});
 for(let t=0;t<2;t++){
  const b=tenants[t],rows=people.filter(u=>u.tenant===t);await setModule(b.tenantId,'attendance','active');await setModule(b.tenantId,'payroll','active');
  await owner.db.insert(s.person).values(rows.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional plan reader',primaryEmail:u.id+'@example.invalid'})));
  await owner.db.insert(s.employment).values(rows.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2020-01-01'})));
  await owner.db.insert(s.assignment).values(rows.map(u=>({tenantId:b.tenantId,employmentId:u.employmentId,departmentId:b.deptA,companyId:b.companyId,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
  await owner.db.insert(s.appUser).values(rows.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'ot_plan_'+u.id})));
  await owner.db.insert(s.roleAssignment).values(rows.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:'employee' as const,companyId:b.companyId})));
  await owner.db.insert(s.attendance).values(rows.map(u=>({tenantId:b.tenantId,employmentId:u.employmentId,attendanceDate:day})));
 }
 const ctx=(u:typeof people[number]):SessionContext=>({...adminCtx(tenants[u.tenant]),userId:u.id,personId:u.personId,roles:['employee'],grants:[{role:'employee',companyId:tenants[u.tenant].companyId}]});
 for(const u of people)expect(await withTenant(ctx(u),tx=>hasOvertimePatternForDayTx(tx,ctx(u),{employmentId:u.employmentId,date:day}))).toBe(false);
 const malformed=async()=>{
  const b=tenants[0];
  const outcome=async(proposed:boolean,value:string)=>{
   try{return await withTenant(ctx(people[1]),async tx=>{
    await tx.execute(sql`select set_config('app.grants',${value},true)`);
    const [row]=await tx.execute(proposed?sql`select app.perf_formula_empty_candidate(${b.tenantId}::uuid,${people[1].employmentId}::text,${day}::date,${b.companyId}::uuid) as id`:sql`select app.overtime_formula_candidate_for_day(${b.tenantId}::uuid,${people[1].employmentId}::text,${day}::date,${b.companyId}::uuid) as id`);
    return {kind:'value',value:row.id};
   });}catch(error){let e=error as {code?:string;message?:string;cause?:unknown};while(e.cause&&!e.code)e=e.cause as typeof e;return {kind:'error',code:e.code,message:e.message};}
  };
  for(const value of ['', '{not-json'])expect(await outcome(true,value)).toEqual(await outcome(false,value));
 };
 await malformed();
 const readers=[...people.map(u=>({ctx:ctx(u),tenantId:tenants[u.tenant].tenantId,companyId:tenants[u.tenant].companyId,employmentId:u.employmentId})),...tenants.map((b,t)=>({ctx:adminCtx(b),tenantId:b.tenantId,companyId:b.companyId,employmentId:people[t*2].employmentId}))];
 const measure=async(proposed:boolean,expected?:unknown[])=>{
  const start=performance.now();const values=await Promise.all([...readers,...readers].map(r=>withTenant(r.ctx,async tx=>{
   const [row]=await tx.execute(proposed?sql`select app.perf_formula_empty_candidate(${r.tenantId}::uuid,${r.employmentId}::text,${day}::date,${r.companyId}::uuid) as id`:sql`select app.overtime_formula_candidate_for_day(${r.tenantId}::uuid,${r.employmentId}::text,${day}::date,${r.companyId}::uuid) as id`);return row.id;
  })));expect(values).toEqual(expected??values.map(()=>null));return performance.now()-start;
 };
 const paired=[];
 for(let round=0;round<4;round++){
  let currentMs,proposedMs;if(round%2===0){currentMs=await measure(false);proposedMs=await measure(true);}else{proposedMs=await measure(true);currentMs=await measure(false);}
  paired.push({round,order:round%2===0?'current-proposed':'proposed-current',currentMs,proposedMs});
 }
 const versions:string[]=[];
 for(let t=0;t<2;t++){
  const b=tenants[t];const [earning]=await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'OT_PLAN',name:'Fictional plan earning',kind:'allowance'}).returning();
  const saved=await saveOvertimePatternDraft(adminCtx(b),{draft:{code:'OT_PLAN',creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Fictional formula',description:'Native regression',definition:pattern(earning.id)}});
  const check=await validateOvertimePatternActivation(adminCtx(b),{versionId:saved.versionId,expectedRevision:saved.revision});expect(check.issues).toEqual([]);expect(check.validationDigest).toBeTruthy();
  await activateOvertimePattern(adminCtx(b),{versionId:saved.versionId,expectedRevision:saved.revision,validationDigest:check.validationDigest!,effectiveFrom:day});
  versions.push(saved.versionId);
  await saveOvertimePatternAssignment(adminCtx(b),{versionId:saved.versionId,target:{type:'individual',employmentIds:[people[t*2].employmentId]},priority:1,from:day,to:null});
 }
 for(const u of people)expect(await withTenant(ctx(u),tx=>hasOvertimePatternForDayTx(tx,ctx(u),{employmentId:u.employmentId,date:day}))).toBe(people.indexOf(u)%2===0);
 const compare=async(tx:Tx,tenantId:string,employmentId:string,on:string,companyId:string|null)=>{
  const original=await tx.execute(sql`select a.id from public.overtime_pattern_assignment a join public.overtime_pattern_version v on v.id=a.version_id join public.overtime_pattern pat on pat.id=v.pattern_id where a.tenant_id=${tenantId}::uuid and v.kind='formula' and pat.archived_at is null and a.superseded_at is null and a.valid_from<=${on}::date and (a.valid_to is null or a.valid_to>${on}::date) and (a.target->>'type'='group' or a.target->'employmentIds' ? ${employmentId}) and (${companyId}::uuid is null or exists(select 1 from public.overtime_pattern_version_company co where co.version_id=v.id and co.company_id=${companyId}::uuid)) and (select st.state from public.overtime_pattern_version_state st where st.version_id=v.id and st.effective_from<=${on}::date order by st.effective_from desc,st.sequence desc limit 1)='active' order by a.id limit 1`);
  const [current]=await tx.execute(sql`select app.overtime_formula_candidate_for_day(${tenantId}::uuid,${employmentId}::text,${on}::date,${companyId}::uuid) as id`);expect(current.id).toBe(original[0]?.id??null);const [proposed]=await tx.execute(sql`select app.perf_formula_empty_candidate(${tenantId}::uuid,${employmentId}::text,${on}::date,${companyId}::uuid) as id`);expect(proposed.id).toBe(current.id);return current.id;
 };
 await withTenant(ctx(people[0]),async tx=>{
  const b=tenants[0],own=()=>compare(tx,b.tenantId,people[0].employmentId,day,b.companyId);
  expect(await own()).toEqual(expect.any(String));expect(await compare(tx,b.tenantId,people[0].employmentId.toUpperCase(),day,b.companyId)).toBeNull();
  expect(await compare(tx,b.tenantId,people[0].employmentId,'2020-01-01',b.companyId)).toBeNull();expect(await compare(tx,b.tenantId,people[0].employmentId,day,null)).toEqual(expect.any(String));
  expect(await compare(tx,tenants[1].tenantId,people[2].employmentId,day,tenants[1].companyId)).toBeNull();
  await tx.execute(sql`select set_config('app.user_id',${people[2].id},true)`);expect(await own()).toBeNull();
  await tx.execute(sql`select set_config('app.user_id',${people[0].id},true),set_config('app.roles','super_admin',true)`);await own();expect((await tx.execute(sql`select app.principal_snapshot_current() as current`))[0].current).toBe(false);
  await tx.execute(sql`select set_config('app.roles','employee',true)`);
  try{await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,people[0].id));await own();expect((await tx.execute(sql`select app.principal_snapshot_current() as current`))[0].current).toBe(false);}finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,people[0].id));}
  expect(await own()).toEqual(expect.any(String));
 });
 // Exercise the untouched fallback's group branch, including same-transaction visibility.
 await saveOvertimePatternAssignment(adminCtx(tenants[0]),{versionId:versions[0],target:{type:'group',condition:yes('all_fictional')},priority:0,from:day,to:null});
 await withTenant(ctx(people[1]),async tx=>{
  const b=tenants[0];expect(await compare(tx,b.tenantId,people[1].employmentId,day,b.companyId)).toEqual(expect.any(String));

 });
 await malformed();
 const expected=await Promise.all([...readers,...readers].map(r=>withTenant(r.ctx,tx=>compare(tx,r.tenantId,r.employmentId,day,r.companyId))));
 const configuredPaired=[];
 for(let round=0;round<2;round++){
  let currentMs,proposedMs;if(round%2===0){currentMs=await measure(false,expected);proposedMs=await measure(true,expected);}else{proposedMs=await measure(true,expected);currentMs=await measure(false,expected);}
  configuredPaired.push({round,order:round%2===0?'current-proposed':'proposed-current',currentMs,proposedMs});
 }
 expect(await publicSnapshot()).toEqual(originalPublic);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/formula-empty-prototype.json',JSON.stringify({kind:'PRIVATE_INVOKER_FORMULA_ASSIGNMENT_PLAN_NOT_CAPACITY_OR_IMPLEMENTATION',paired,configuredPaired,readersPerBurst:12,principals:6,tenants:2,originalQueryAndPublicFunctionParity:true,liveScopeAndInvalidPrincipalControls:true,publicFunctionUnchanged:true,limitations:'Native empty and configured assignment query-plan measurements; private query preserves individual/group results. No public function, visibility function, policy, migration or provider binding changed.'}));
});
