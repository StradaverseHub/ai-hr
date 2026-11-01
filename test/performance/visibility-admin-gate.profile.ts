/** Reversible native last-administrator candidate experiment. Never a migration or HTTP witness. */
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../../db/client';
import * as s from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
const signature='app.access_assert_administrator_for(uuid)';
const previous=`SELECT 1 FROM public.access_group g JOIN public.access_effective_membership m ON m.group_id=g.id AND m.tenant_id=g.tenant_id
  WHERE g.tenant_id=p_tenant AND g.system_administrator AND g.retired_at IS NULL
   AND m.company_id IS NULL
   AND app.access_allowed_for_tenant(p_tenant,m.user_id,'access.system_admin',NULL)
   AND app.access_allowed_for_tenant(p_tenant,m.user_id,'access.configure',NULL)
   AND app.access_recovery_available(m.user_id)`;
const candidate=`WITH candidate_administrators AS MATERIALIZED (
 SELECT m.user_id FROM public.access_group g JOIN public.access_effective_membership m ON m.group_id=g.id AND m.tenant_id=g.tenant_id
 WHERE g.tenant_id=p_tenant AND g.system_administrator AND g.retired_at IS NULL AND m.company_id IS NULL
 ) SELECT 1 FROM candidate_administrators m
 WHERE app.access_allowed_for_tenant(p_tenant,m.user_id,'access.system_admin',NULL)
 AND app.access_allowed_for_tenant(p_tenant,m.user_id,'access.configure',NULL)
 AND app.access_recovery_available(m.user_id)`;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function catalog(){
 const [row]=await owner.client`select pg_get_functiondef(oid) as definition,prosrc as body,to_jsonb(p)-'prosrc' as attributes from pg_proc p where oid=${signature}::regprocedure`;
 return row;
}
async function outcome(connection:any,tenantId:string){
 try{await connection.savepoint(async(sp:any)=>{await sp`select app.access_assert_administrator_for(${tenantId}::uuid)`;});return 'allowed';}
 catch(error){return (error as {code?:string}).code??String(error);}
}
it('fences matching administrator memberships before live eligibility checks with identical native outcomes and attributes',async()=>{
 await resetDb();const base=await seedBase(),foreign=await seedBase();
 for(const b of [base,foreign])await withTenant(adminCtx(b),tx=>tx.execute(sql`select app.access_configuration_initialize()`));
 const users=Array.from({length:500},()=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID()}));
 await owner.db.insert(s.person).values(users.map((u,i)=>({id:u.personId,tenantId:base.tenantId,fullName:'Fictional administrator-candidate person '+i,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:base.tenantId,personId:u.personId,companyId:base.companyId,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:base.tenantId,personId:u.personId,workosUserId:'admin_candidate_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:base.tenantId,appUserId:u.id,role:'employee' as const,companyId:base.companyId})));
 const [membership]=await owner.client`select count(*)::int as total,count(*) filter(where g.system_administrator)::int as administrators from access_effective_membership m join access_group g on g.id=m.group_id and g.tenant_id=m.tenant_id where m.tenant_id=${base.tenantId}::uuid`;
 expect(membership.total).toBeGreaterThanOrEqual(501);expect(membership.administrators).toBe(1);
 for(const table of ['app_user','person','employment','role_assignment','access_group','access_configuration'])await owner.client.unsafe('analyze '+table);
 const original=await catalog();expect(original.body.split(previous)).toHaveLength(2);expect(original.definition.split(previous)).toHaveLength(2);
 const phases:Record<string,unknown>={},untouched=randomUUID();let baselineOutcomes:unknown;
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'administrator-candidate-work.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_ADMINISTRATOR_CANDIDATE_EXPERIMENT',releaseEligible:false,users:500,membership,originalBodySha256:hash(original.body),phases},null,2));
 try{
  for(const phase of ['before','candidate','restored']){
   const body=phase==='candidate'?original.body.replace(previous,candidate):original.body;
   await owner.client.unsafe(phase==='candidate'?original.definition.replace(previous,candidate):original.definition);
   const actual=await catalog();expect(actual.body).toBe(body);expect(actual.attributes).toEqual(original.attributes);
   const [permission]=await owner.client`select has_function_privilege('ai_hr_app',${signature},'EXECUTE') as app_can_execute`;
   expect(permission.app_can_execute).toBe(false);
   await owner.client`select app.access_assert_administrator_for(${base.tenantId}::uuid)`;
   await owner.client`select pg_stat_statements_reset()`;
   const elapsedMs:number[]=[];
   for(let i=0;i<3;i++){const start=performance.now();await owner.client`select app.access_assert_administrator_for(${base.tenantId}::uuid)`;elapsedMs.push(performance.now()-start);}
   const statements=await owner.client`select calls,total_exec_time,total_plan_time,left(query,1800) as normalized_query from pg_stat_statements where query not like '%pg_stat_%' order by total_exec_time+total_plan_time desc limit 14`;
   const outcomes=[];
   for(const tenantId of [base.tenantId,foreign.tenantId,untouched])outcomes.push(await owner.client.begin(tx=>outcome(tx,tenantId)));
   const rollback=new Error('Rollback isolated native refusal fixture');let archivedOutcome:string|undefined;
   try{await owner.client.begin(async tx=>{await tx`update app_user set archived_at=now() where id=${base.adminUserId}::uuid`;archivedOutcome=await outcome(tx,base.tenantId);throw rollback;});}
   catch(error){if(error!==rollback)throw error;}
   expect(archivedOutcome).toBe('23514');outcomes.push(archivedOutcome);
   expect(outcomes.slice(0,3)).toEqual(['allowed','allowed','allowed']);
   if(baselineOutcomes===undefined)baselineOutcomes=outcomes;else expect(outcomes).toEqual(baselineOutcomes);
   const [restoredUser]=await owner.client`select archived_at from app_user where id=${base.adminUserId}::uuid`;expect(restoredUser.archived_at).toBeNull();
   phases[phase]={elapsedMs,medianMs:[...elapsedMs].sort((a,b)=>a-b)[1],outcomes,attributesIdentical:true,appExecuteDenied:true,bodySha256:hash(body),statements};save();
  }
 }finally{await owner.client.unsafe(original.definition);const restored=await catalog();expect(restored).toEqual(original);save();}
},240000);
