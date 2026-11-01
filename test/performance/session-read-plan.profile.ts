/** Diagnostic only: actual OT-stage discovery with target-only prepared plans; no production adapter change. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {client,withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import type {OvertimePattern} from '../../lib/overtime-pattern-model';
import {hasOvertimePatternForDayTx,saveOvertimePatternDraft,validateOvertimePatternActivation,activateOvertimePattern,saveOvertimePatternAssignment} from '../../packs/attendance/overtime-patterns';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
const yes=(id:string)=>({id,type:'constant' as const,value:true});
function pattern(earningId:string):OvertimePattern{return {v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'earliest',eligibility:yes('eligible'),eligibleMinutes:{id:'fraction',type:'literal',unit:'minutes',value:'60.5'},durationCap:null,durationRounding:null,deductions:[],rates:[{id:'rate',name:'Test payment',description:'Fixture policy',priority:0,when:yes('rate_when'),timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:earningId,currency:'MYR'},payment:{method:'flat',basis:'day',chargeId:'day_charge',amount:{id:'amount',type:'literal',unit:'money',currency:'MYR',value:'25'}}}]}],paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};}

beforeAll(migrateTestDb);afterAll(closeAll);
type Wire={unsafe:(...args:any[])=>any;begin?:(...args:any[])=>any;savepoint?:(...args:any[])=>any};
it('measures empty-formula actual stage detection before, during and after target-only plan reuse',async()=>{
 expect(process.env.GITHUB_ACTIONS).toBe('true');expect(new URL(process.env.TEST_DATABASE_URL!).hostname).toBe('127.0.0.1');
 await resetDb();await owner.client`create extension if not exists pg_stat_statements`;const day=todayInKualaLumpur();
 const tenants=[await seedBase(),await seedBase()];
 const users=tenants.flatMap((b,t)=>Array.from({length:250},(_,i)=>({tenant:t,id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),role:(i===0||i===1?'hr_admin':i===2?'manager':'employee') as 'hr_admin'|'manager'|'employee',group:i===0})));
 for(let t=0;t<2;t++){
  const b=tenants[t],rows=users.filter(u=>u.tenant===t);
  await owner.db.insert(s.person).values(rows.map((u,i)=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional plan participant '+t+'-'+i,primaryEmail:u.id+'@example.test'})));
  await owner.db.insert(s.employment).values(rows.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2020-01-01'})));
  await owner.db.insert(s.assignment).values(rows.map(u=>({tenantId:b.tenantId,employmentId:u.employmentId,departmentId:b.deptA,companyId:b.companyId,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
  await owner.db.insert(s.appUser).values(rows.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'prepared_profile_'+u.id})));
  await owner.db.insert(s.roleAssignment).values(rows.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:u.role,companyId:u.group?null:b.companyId})));
 }
 for(let t=0;t<2;t++)await owner.db.insert(s.attendance).values(users.filter(u=>u.tenant===t).map(u=>({tenantId:tenants[t].tenantId,employmentId:u.employmentId,attendanceDate:day})));
 for(const table of ['person','employment','assignment','app_user','role_assignment','attendance','overtime_pattern','overtime_pattern_version','overtime_pattern_assignment'])await owner.client.unsafe('analyze '+table);
 const ctx=(u:typeof users[number]):SessionContext=>({...adminCtx(tenants[u.tenant]),userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.group?null:tenants[u.tenant].companyId}]});
 const pool=client as unknown as Wire,originalUnsafe=pool.unsafe,originalBegin=pool.begin;
 const store=new AsyncLocalStorage<Wire>(),seen=new WeakSet<object>(),templates=new Set<string>();
 let native=false;let enabled=false,captured:{query:string;params:unknown[]}|undefined;let selectedCalls=0;
 function instrument(connection:Wire):Wire{
  if(seen.has(connection))return connection;seen.add(connection);
  const raw=connection.unsafe;
  connection.unsafe=function(...args:any[]){
   const [query,params,options]=args;
   if(typeof query==='string'&&query.includes('"overtime_pattern_assignment"')&&query.includes('"superseded_at"')&&Array.isArray(params)&&params.includes(users[11].employmentId))captured={query,params:params.slice()};
   if(native&&typeof query==='string'&&query.includes('"overtime_pattern_assignment"')&&query.includes('"superseded_at"')&&Array.isArray(params)){
    expect([7,8]).toContain(params.length);selectedCalls++;const company=params.length===8?params[5]:null;
    return Reflect.apply(raw,connection,['select candidate as id from app._profile_ot_formula_candidate($1::uuid,$2::text,$3::date,$4::uuid) candidate where candidate is not null',[params[0],params[4],params[2],company]]);
   }
   if(enabled&&typeof query==='string'&&query.includes('"overtime_pattern_assignment"')&&query.includes('"superseded_at"')&&Array.isArray(params)&&params.length>0&&options?.prepare!==false&&options?.simple!==true&&(templates.has(query)||templates.size<128)){
    templates.add(query);selectedCalls++;return Reflect.apply(raw,connection,[query,params,{...options,prepare:true}]);
   }
   return Reflect.apply(raw,connection,args);
  };
  for(const key of ['begin','savepoint'] as const){const original=connection[key];if(typeof original!=='function')continue;
   connection[key]=function(...args:any[]){const index=args.findIndex(value=>typeof value==='function');if(index>=0){const callback=args[index];args[index]=function(this:unknown,...inputs:any[]){const nested=instrument(inputs[0]);inputs[0]=nested;return store.run(nested,()=>Reflect.apply(callback,this,inputs));};}return Reflect.apply(original,connection,args);};
  }
  return connection;
 }

 const signature='app._profile_ot_formula_candidate(uuid,text,date,uuid)';
 expect((await owner.client`select to_regprocedure(${signature}) as fn`)[0].fn).toBeNull();
 await owner.client.unsafe(`CREATE FUNCTION app._profile_ot_formula_candidate(p_tenant uuid,p_employment text,p_date date,p_company uuid) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
 DECLARE answer uuid;
 BEGIN
 SELECT a.id INTO answer FROM public.overtime_pattern_assignment a
 JOIN public.overtime_pattern_version v ON v.id=a.version_id
 JOIN public.overtime_pattern pat ON pat.id=v.pattern_id
 WHERE a.tenant_id=p_tenant AND v.kind='formula' AND pat.archived_at IS NULL
 AND a.superseded_at IS NULL AND a.valid_from<=p_date AND (a.valid_to IS NULL OR a.valid_to>p_date)
 AND (a.target->>'type'='group' OR a.target->'employmentIds' ? p_employment)
 AND (p_company IS NULL OR EXISTS(SELECT 1 FROM public.overtime_pattern_version_company co WHERE co.version_id=v.id AND co.company_id=p_company))
 AND (SELECT st.state FROM public.overtime_pattern_version_state st WHERE st.version_id=v.id AND st.effective_from<=p_date ORDER BY st.effective_from DESC,st.sequence DESC LIMIT 1)='active'
 ORDER BY a.id LIMIT 1;
 RETURN answer;
 END $fn$`);
 await owner.client.unsafe('REVOKE ALL ON FUNCTION '+signature+' FROM PUBLIC');
 const [role]=await pool.unsafe('select current_user as name',[]);await owner.client.unsafe('GRANT EXECUTE ON FUNCTION '+signature+' TO "'+String(role.name).replaceAll('"','""')+'"');
 const reports:Record<string,unknown>={};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'overtime-discovery-work.json'),JSON.stringify({kind:'REVERSIBLE_TARGET_ONLY_OT_DISCOVERY_PLAN_EXPERIMENT',releaseEligible:false,sourceCase:'500 visible attendance rows; empty then one active individually targeted formula in each tenant; native INVOKER plan reuse',principals:500,tenants:2,templateCount:templates.size,capturedQuerySha256:captured?createHash('sha256').update(captured.query).digest('hex'):null,reports},null,2));
 let populated=false;
 const read=async(u:typeof users[number])=>{const answer=await withTenant(ctx(u),tx=>hasOvertimePatternForDayTx(tx,ctx(u),{employmentId:u.employmentId,date:day}));expect(answer).toBe(populated&&users.indexOf(u)%250===11);};
 try{
  instrument(pool);
  for(const dataCase of ['empty','populated']){
   populated=dataCase==='populated';
   if(populated)for(let t=0;t<2;t++){
    const b=tenants[t];await setModule(b.tenantId,'attendance','active');await setModule(b.tenantId,'payroll','active');
    const [earning]=await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'OT_PROFILE',name:'Fictional profile earning',kind:'allowance'}).returning();
    const saved=await saveOvertimePatternDraft(adminCtx(b),{draft:{code:'OT_PROFILE',creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Fictional formula profile',description:'Isolated query-plan experiment',definition:pattern(earning.id)}});
    const check=await validateOvertimePatternActivation(adminCtx(b),{versionId:saved.versionId,expectedRevision:saved.revision});expect(check.issues).toEqual([]);expect(check.validationDigest).toBeTruthy();
    await activateOvertimePattern(adminCtx(b),{versionId:saved.versionId,expectedRevision:saved.revision,validationDigest:check.validationDigest!,effectiveFrom:day});
    await saveOvertimePatternAssignment(adminCtx(b),{versionId:saved.versionId,target:{type:'individual',employmentIds:[users[t*250+11].employmentId]},priority:1,from:day,to:null});
   }
   for(const phase of ['before','prepared','native-invoker','restored']){
   native=phase==='native-invoker';enabled=phase==='prepared';selectedCalls=0;await Promise.all(users.slice(0,40).map(u=>read(u)));await owner.client`select pg_stat_statements_reset()`;
   const times:number[]=[],started=performance.now();const results=await Promise.allSettled(users.map(async u=>{const before=performance.now();await read(u);times.push(performance.now()-before);}));
   const elapsedMs=performance.now()-started,errors=results.flatMap(r=>r.status==='rejected'?[String(r.reason)]:[]);times.sort((a,b)=>a-b);
   const roleMedians:Record<string,number>={};for(const [label,index]of [['employee',11],['manager',2],['companyHR',1],['groupHR',0]] as const){const samples:number[]=[];for(let i=0;i<5;i++){const before=performance.now();await read(users[index]);samples.push(performance.now()-before);}roleMedians[label]=samples.sort((a,b)=>a-b)[2];}
   expect(captured).toBeDefined();
   const freshness=await withTenant(ctx(users[11]),async tx=>{const original=await tx.execute(sql`select app.principal_snapshot_current() as current`);expect(original[0].current).toBe(true);await tx.execute(sql`select set_config('app.roles','super_admin',true)`);expect((await tx.execute(sql`select app.principal_snapshot_current() as current`))[0].current).toBe(false);return {forgedRoleStillDenied:true};});
   let liveNativeChecks:unknown=null;
   if(populated){
    native=false;enabled=false;
    liveNativeChecks=await withTenant(ctx(users[11]),async tx=>{
     const wire=store.getStore()!;expect(wire).toBeDefined();
     const compare=async()=>{const original=await wire.unsafe(captured!.query,captured!.params).values();const current=await wire.unsafe('select candidate as id from app._profile_ot_formula_candidate($1::uuid,$2::text,$3::date,$4::uuid) candidate where candidate is not null',[tenants[0].tenantId,users[11].employmentId,day,tenants[0].companyId]).values();expect(current).toEqual(original);return original;};
     expect(await compare()).toHaveLength(1);
     await tx.execute(sql`select set_config('app.roles','super_admin',true)`);await compare();expect((await tx.execute(sql`select app.principal_snapshot_current() as current`))[0].current).toBe(false);
     await tx.execute(sql`select set_config('app.roles','employee',true),set_config('app.user_id',${users[12].id},true)`);await compare();
     await tx.execute(sql`select set_config('app.user_id',${users[261].id},true)`);expect(await compare()).toEqual([]);
     await tx.execute(sql`select set_config('app.user_id',${users[11].id},true)`);
     try{await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,users[11].id));await compare();expect((await tx.execute(sql`select app.principal_snapshot_current() as current`))[0].current).toBe(false);}finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,users[11].id));}
     expect(await compare()).toHaveLength(1);
     const upper=users[11].employmentId.toUpperCase(),params=captured!.params.map(value=>value===users[11].employmentId?upper:value);
     const upperOriginal=await wire.unsafe(captured!.query,params).values(),upperNative=await wire.unsafe('select candidate as id from app._profile_ot_formula_candidate($1::uuid,$2::text,$3::date,$4::uuid) candidate where candidate is not null',[tenants[0].tenantId,upper,day,tenants[0].companyId]).values();expect(upperOriginal).toEqual([]);expect(upperNative).toEqual(upperOriginal);
     const cross=await wire.unsafe('select app._profile_ot_formula_candidate($1::uuid,$2::text,$3::date,$4::uuid) as id',[tenants[1].tenantId,users[261].employmentId,day,tenants[1].companyId]);expect(cross[0].id).toBeNull();
     return {positiveResult:true,sameConnectionIdentityComparison:true,forgedRolePrincipalDenied:true,liveArchivePrincipalDenied:true,metadataMatchesOriginal:true,liveForeignIdentityDenied:true,caseSensitiveTargetPreserved:true,foreignTenantDenied:true};
    });
   }
   const statements=await owner.client`select calls,total_plan_time,total_exec_time,left(query,2300) as normalized_query from pg_stat_statements where query not like '%pg_stat_%' order by total_plan_time+total_exec_time desc limit 30`;
   reports[dataCase+'-'+phase]={elapsedMs,p95Ms:times[474],roleMedians,selectedCalls,templateCount:templates.size,errors,freshness,liveNativeChecks,statements};save();expect(errors).toEqual([]);
  }
  }
 }finally{native=false;enabled=false;pool.unsafe=originalUnsafe;pool.begin=originalBegin;await owner.client.unsafe('DROP FUNCTION '+signature);save();}
},300000);
