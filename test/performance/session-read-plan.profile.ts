/** Diagnostic only: explicit native own-recipient parent predicate plus resolved own IDs; original policy restored. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {and,asc,desc,eq,gte,inArray,isNotNull,isNull,lte,sql} from 'drizzle-orm';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {client,withTenant,type SessionContext,type Tx} from '../../db/client';
import * as s from '../../db/schema';
import {createNotice,publishNotice,pendingNoticeAcknowledgementTasks} from '../../core/notice';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
type Wire={unsafe:(...args:any[])=>any;begin?:(...args:any[])=>any;savepoint?:(...args:any[])=>any};
function code(error:unknown){let e=error as {code?:string;cause?:unknown};for(let i=0;e&&i<8;i++){if(e.code)return e.code;e=e.cause as typeof e;}return String(error);}
it('compares actual empty/populated Notice reads while keeping pooled identities and revocation live',async()=>{
 expect(process.env.GITHUB_ACTIONS).toBe('true');expect(new URL(process.env.TEST_DATABASE_URL!).hostname).toBe('127.0.0.1');
 await resetDb();await owner.client`create extension if not exists pg_stat_statements`;
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
 for(const table of ['person','employment','assignment','app_user','role_assignment','notice','notice_recipient'])await owner.client.unsafe('analyze '+table);
 const ctx=(u:typeof users[number]):SessionContext=>({...adminCtx(tenants[u.tenant]),userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.group?null:tenants[u.tenant].companyId}]});
 const pool=client as unknown as Wire,originalUnsafe=pool.unsafe,originalBegin=pool.begin;
 const store=new AsyncLocalStorage<Wire>(),seen=new WeakSet<object>(),templates=new Set<string>();
 let enabled=false,captured:{query:string;params:unknown[]}|undefined;let selectedCalls=0;
 function instrument(connection:Wire):Wire{
  if(seen.has(connection))return connection;seen.add(connection);
  const raw=connection.unsafe;
  connection.unsafe=function(...args:any[]){
   const [query,params,options]=args;
   if(!captured&&typeof query==='string'&&query.includes('"notice_recipient"')&&query.includes('"content_version"')&&Array.isArray(params))captured={query,params:params.slice()};
   return Reflect.apply(raw,connection,args);
  };
  for(const key of ['begin','savepoint'] as const){const original=connection[key];if(typeof original!=='function')continue;
   connection[key]=function(...args:any[]){const index=args.findIndex(value=>typeof value==='function');if(index>=0){const callback=args[index];args[index]=function(this:unknown,...inputs:any[]){const nested=instrument(inputs[0]);inputs[0]=nested;return store.run(nested,()=>Reflect.apply(callback,this,inputs));};}return Reflect.apply(original,connection,args);};
  }
  return connection;
 }
 const reports:Record<string,unknown>={},noticeRows:typeof s.notice.$inferSelect[]=[];
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'notice-parent-membership-work.json'),JSON.stringify({kind:'REVERSIBLE_NOTICE_PARENT_MEMBERSHIP_EXPERIMENT',releaseEligible:false,principals:500,tenants:2,templateLimit:128,templateCount:templates.size,capturedQuerySha256:captured?createHash('sha256').update(captured.query).digest('hex'):null,reports},null,2));
 const candidateTx=async(tx:Tx,context:SessionContext)=>{
  const ids=await tx.select({id:s.employment.id}).from(s.employment)
   .innerJoin(s.appUser,eq(s.appUser.personId,s.employment.personId))
   .where(and(eq(s.employment.tenantId,context.tenantId),eq(s.appUser.tenantId,s.employment.tenantId),
    sql`${s.appUser.id}=app.current_user_id()`,sql`app.principal_snapshot_current()`,sql`app.is_self_person(${s.employment.personId})`));
  if(!ids.length)return [];
  const today=todayInKualaLumpur();selectedCalls++;
  return tx.select({noticeId:s.notice.id,employmentId:s.noticeRecipient.employmentId,title:s.notice.title,contentVersion:s.notice.contentVersion,sourceUpdatedAt:s.notice.updatedAt})
   .from(s.noticeRecipient).innerJoin(s.notice,eq(s.notice.id,s.noticeRecipient.noticeId))
   .where(and(inArray(s.noticeRecipient.employmentId,ids.map(row=>row.id)),eq(s.noticeRecipient.tenantId,s.notice.tenantId),eq(s.notice.tenantId,context.tenantId),
    sql`app.principal_snapshot_current()`,isNotNull(s.notice.publishedAt),isNull(s.notice.archivedAt),lte(s.notice.startOn,today),gte(s.notice.endOn,today),eq(s.notice.requiresAcknowledgement,true),
    sql`EXISTS(SELECT 1 FROM public.employment self_employment WHERE self_employment.id=notice_recipient.employment_id AND self_employment.tenant_id=notice_recipient.tenant_id AND app.is_self_person(self_employment.person_id))`,
    sql`NOT EXISTS(SELECT 1 FROM public.notice_acknowledgement a WHERE a.recipient_id=notice_recipient.id AND a.tenant_id=notice_recipient.tenant_id AND a.notice_id=notice.id AND a.content_version=notice.content_version)`))
   .orderBy(desc(s.notice.updatedAt),asc(s.notice.id),asc(s.noticeRecipient.employmentId));
 };
 const candidate=(context:SessionContext)=>withTenant(context,tx=>candidateTx(tx,context));
 const expected=(u:typeof users[number],populated:boolean)=>populated?[{noticeId:noticeRows[u.tenant].id,employmentId:u.employmentId,title:noticeRows[u.tenant].title,contentVersion:noticeRows[u.tenant].contentVersion,sourceUpdatedAt:noticeRows[u.tenant].updatedAt}]:[];
 const read=async(u:typeof users[number],populated:boolean)=>{const rows=await (enabled?candidate(ctx(u)):pendingNoticeAcknowledgementTasks(ctx(u)));expect(rows).toEqual(expected(u,populated));if(rows.length)expect(rows[0].sourceUpdatedAt).toBeInstanceOf(Date);return rows;};
 const [originalPolicy]=await owner.client`select pg_get_expr(polqual,polrelid) as expression from pg_policy where polrelid='public.notice'::regclass and polname='notice_recipient_read_rls'`;
 expect(originalPolicy.expression).toContain('notice_recipient');
 let restoredPolicy=true;
 const restorePolicy=async()=>{await owner.client.unsafe('alter policy notice_recipient_read_rls on public.notice using ('+originalPolicy.expression+')');await owner.client.unsafe('drop function if exists app.perf_notice_self_membership(uuid)');restoredPolicy=true;};
 const installPolicy=async()=>{
  await owner.client.unsafe(`create function app.perf_notice_self_membership(wanted_notice uuid) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $body$
   SELECT (SELECT app.principal_snapshot_current()) AND EXISTS(
    SELECT 1 FROM public.app_user u JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
    JOIN public.notice_recipient nr ON nr.employment_id=e.id AND nr.tenant_id=e.tenant_id
    WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND nr.notice_id=wanted_notice AND app.is_self_person(e.person_id)) $body$;
   revoke all on function app.perf_notice_self_membership(uuid) from public,ai_hr_app;
   grant execute on function app.perf_notice_self_membership(uuid) to ai_hr_app;
   alter policy notice_recipient_read_rls on public.notice using(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND published_at IS NOT NULL AND archived_at IS NULL AND start_on-1<=current_date AND current_date<=end_on+1 AND app.perf_notice_self_membership(id))`);
  restoredPolicy=false;
 };
 try{
  instrument(pool);
  for(const dataCase of ['empty','populated']){
   const populated=dataCase==='populated';
   if(populated)for(let t=0;t<2;t++){
    const b=tenants[t],{id}=await createNotice(adminCtx(b),{title:'Fictional planning notice '+t,body:'Read this fictional planning notice.',startOn:'2020-01-01',endOn:'2099-12-31',criteria:{companyIds:[b.companyId]},requiresAcknowledgement:true});
    expect((await publishNotice(adminCtx(b),id)).recipients).toBe(250);
    const [row]=await owner.db.select().from(s.notice).where(eq(s.notice.id,id));noticeRows.push(row);
   }
   for(const phase of ['before','own-ids','restored']){
    enabled=phase==='own-ids';selectedCalls=0;if(enabled)await installPolicy();else await restorePolicy();
    await Promise.all(users.slice(0,100).map(u=>read(u,populated)));await owner.client`select pg_stat_statements_reset()`;
    const times:number[]=[],started=performance.now();
    const results=await Promise.allSettled(users.map(async u=>{const before=performance.now();await read(u,populated);times.push(performance.now()-before);}));
    const errors=results.flatMap(r=>r.status==='rejected'?[String(r.reason)]:[]);expect(errors).toEqual([]);times.sort((a,b)=>a-b);
    const elapsedMs=performance.now()-started;
    const roleMedians:Record<string,number>={};
    for(const [label,index]of [['employee',11],['manager',2],['companyHR',1],['groupHR',0]] as const){const samples=[];for(let i=0;i<5;i++){const before=performance.now();await read(users[index],populated);samples.push(performance.now()-before);}roleMedians[label]=samples.sort((a,b)=>a-b)[2];}
    expect(captured).toBeDefined();
    const freshness=await withTenant(ctx(users[11]),async tx=>{
     const wire=store.getStore();expect(wire).toBeDefined();
     const ask=async()=>{if(enabled)return(await candidateTx(tx,ctx(users[11]))).map(row=>row.employmentId);const rows=await wire!.unsafe(captured!.query,captured!.params).values();return rows.map((row:unknown[])=>row[1]);};
     const own=populated?[users[11].employmentId]:[],other=populated?[users[12].employmentId]:[];
     expect(await ask()).toEqual(own);
     await tx.execute(sql`select set_config('app.roles','super_admin',true)`);expect(await ask()).toEqual([]);
     await tx.execute(sql`select set_config('app.roles','employee',true),set_config('app.user_id',${users[12].id},true)`);expect(await ask()).toEqual(other);
     await tx.execute(sql`select set_config('app.user_id',${users[11].id},true)`);
     await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,users[11].id));expect(await ask()).toEqual([]);
     await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,users[11].id));expect(await ask()).toEqual(own);
     const named=await wire!.unsafe(`select count(*)::int as n,coalesce(sum(generic_plans),0)::text as generic,coalesce(sum(custom_plans),0)::text as custom from pg_prepared_statements where statement like '%"notice_recipient"%'`);
     return {sameConnectionIdentityChanges:true,liveArchiveObserved:true,preparedNoticeStatements:named[0],parentPolicyExperiment:enabled};
    });
    let malformed:string|null=null;try{await (enabled?candidate:pendingNoticeAcknowledgementTasks)({...ctx(users[11]),tenantId:'invalid-uuid'});}catch(error){malformed=code(error);}expect(malformed).toBe('22P02');
    const statements=await owner.client`select calls,total_plan_time,total_exec_time,left(query,2200) as normalized_query from pg_stat_statements where query not like '%pg_stat_%' order by total_plan_time+total_exec_time desc limit 24`;
    reports[dataCase+'-'+phase]={elapsedMs,p95Ms:times[474],roleMedians,selectedCalls,templateCount:templates.size,exact500OwnResults:true,freshness,malformed,statements};save();
   }
  }
 }finally{
  enabled=false;await restorePolicy();pool.unsafe=originalUnsafe;pool.begin=originalBegin;
  await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,users[11].id));save();
 }
},240000);
