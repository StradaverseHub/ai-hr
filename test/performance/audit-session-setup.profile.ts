/** Compare warm, already-armed session setup; actual native principals, no result caching. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {db,withTenant,type SessionContext,type Tx} from '../../db/client';
import * as s from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);

async function proof(tx:Tx,ctx:SessionContext){
 const [row]=await tx.execute(sql`select app.principal_snapshot_current() and app.is_self_person(${ctx.personId}::uuid) as ok,
  current_setting('app.audit_hash_chain',true) as chain,current_setting('app.tenant_id',true) as tenant`);
 expect(row).toMatchObject({ok:true,chain:'on',tenant:ctx.tenantId});
}
// The original known-armed path fromc6a904865. Unknown/first-arm and suspended
// contexts are covered by application tests, not represented by this benchmark.
async function previous(ctx:SessionContext){
 return db.transaction(async tx=>{
  await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true), set_config('app.user_id', ${ctx.userId??''}, true), set_config('app.roles', ${(ctx.roles??[]).join(',')}, true), set_config('app.grants', ${JSON.stringify(ctx.grants)}, true), set_config('app.agent_principal_id', '', true)`);
  await tx.execute(sql`select set_config('app.audit_hash_chain', 'on', true)`);
  await proof(tx,ctx);
 });
}
it('compares separate and combined setup for500 actual principals over two already-armed tenants',async()=>{
 await resetDb();await owner.client`create extension if not exists pg_stat_statements`;
 const bases=[await seedBase(),await seedBase()];
 const users=Array.from({length:500},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),tenant:i<250?0:1}));
 for(const [index,b]of bases.entries()){
  const group=users.filter(u=>u.tenant===index);
  await owner.db.insert(s.person).values(group.map((u,i)=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional audit reader '+i,primaryEmail:u.id+'@example.invalid'})));
  await owner.db.insert(s.employment).values(group.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2025-01-01'})));
  await owner.db.insert(s.appUser).values(group.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'audit_setup_'+u.id})));
  await owner.db.insert(s.roleAssignment).values(group.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:'employee' as const,companyId:b.companyId})));
 }
 for(const table of ['person','employment','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
 const context=(u:typeof users[number]):SessionContext=>({...adminCtx(bases[u.tenant]),userId:u.id,personId:u.personId,roles:['employee'],grants:[{role:'employee',companyId:bases[u.tenant].companyId}]});
 const oldAudit=process.env.AUDIT_HASH_CHAIN_ENABLED,phases:Record<string,unknown>={};
 try{
  process.env.AUDIT_HASH_CHAIN_ENABLED='true';
  for(const u of [users[0],users[250]])await withTenant(context(u),tx=>proof(tx,context(u)));
  process.env.AUDIT_HASH_CHAIN_ENABLED='false';
  for(const phase of ['separate-before','combined','separate-after']){
   await owner.client`select pg_stat_statements_reset()`;
   const times:number[]=[],started=performance.now();
   const results=await Promise.allSettled(users.map(async u=>{
    const ctx=context(u),before=performance.now();
    for(let i=0;i<3;i++)await (phase==='combined'?withTenant(ctx,tx=>proof(tx,ctx)):previous(ctx));
    times.push(performance.now()-before);
   }));
   const elapsedMs=performance.now()-started,errors=results.flatMap(result=>result.status==='rejected'?[String(result.reason)]:[]);times.sort((a,b)=>a-b);
   const statements=await owner.client`select calls,query as normalized_query from pg_stat_statements where query ilike '%set_config%' and query not ilike '%pg_stat_%' order by query`;
   const calls=(setters:number)=>statements.filter(row=>(row.normalized_query.match(/set_config/g)??[]).length===setters).reduce((total,row)=>total+Number(row.calls),0);
   expect(calls(phase==='combined'?6:5)).toBe(1500);expect(calls(1)).toBe(phase==='combined'?0:1500);
   phases[phase]={principals:500,readsPerPrincipal:3,elapsedMs,p50Ms:times[249],p95Ms:times[474],maxMs:times.at(-1),errors,statements};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'audit-session-setup.json'),JSON.stringify({kind:'NATIVE_WARM_AUDIT_SETUP_COMPARISON',releaseEligible:false,tenants:2,phases},null,2));
   expect(errors).toEqual([]);
  }
 }finally{if(oldAudit===undefined)delete process.env.AUDIT_HASH_CHAIN_ENABLED;else process.env.AUDIT_HASH_CHAIN_ENABLED=oldAudit;}
},180000);
