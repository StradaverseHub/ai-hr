/** Import-safe PRIVATE bridge. Candidate-native principal and current controls, READ ONLY+RC.
 * No pool lifecycle, environment mutation, effects, provider/config/key provisioning or arbitrary SQL
 * RPC. Owner reads are fixture-tenant aggregates only; current values use the actual app principal.
 * Only the separate journey's fixed checks may enter public artifacts, never these private facts. */
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {AI_CONTROLS_PHASES} from './assistant-ai-controls-experience.mjs';
const unavailable=()=>{throw Error('assistant_ai_controls_native_readback:unavailable');};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
/** Pure target boundary only. Returns no credentials/URL and never connects or changes an env var. */
export function parseAiControlsReadbackTarget(environment=process.env){
 try{
  const urls=[environment.DATABASE_URL,environment.MIGRATION_DATABASE_URL].map(value=>{
   const u=new URL(value??'');if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.port!=='5433'||!/^aihr_assistant_browser_[a-f0-9]{16}$/.test(u.pathname.slice(1))||u.hash||[...u.searchParams].some(([key,value])=>key!=='sslmode'||value!=='disable'))return unavailable();return u;
  });
  const app=decodeURIComponent(urls[0].username),owner=decodeURIComponent(urls[1].username);if(urls[0].pathname!==urls[1].pathname||app!=='ai_hr_app'||!owner||app===owner)return unavailable();
  return Object.freeze({database:urls[0].pathname.slice(1),ownerName:owner});
 }catch{return unavailable();}
}
export function assertAiControlsReadbackPhysical(row,target,owner){
 if(!row||row.database!==target.database||!['127.0.0.1','::1'].includes(row.address)||row.port!==5433||row.readonly!=='on'||row.isolation!=='read committed')return unavailable();
 if(owner){if(row.name!==target.ownerName||row.name==='ai_hr_app'||row.full!==true)return unavailable();}
 else if(row.name!=='ai_hr_app'||row.super!==false||row.bypass!==false)return unavailable();
}
export async function createAssistantAiControlsNativeReadback({root,owner,fixture}){
 try{
  if(typeof root!=='string'||!isAbsolute(root)||!owner?.client||fixture?.state!=='native_prerequisites_prepared_not_experienced')return unavailable();
  const captured=structuredClone({tenantId:fixture.tenantId,personId:fixture.actors?.operator?.personId,userId:fixture.actors?.operator?.userId});if(![captured.tenantId,captured.personId,captured.userId].every(uuid))return unavailable();
  const target=parseAiControlsReadbackTarget(),require=createRequire(join(root,'package.json')),{sql}=require('drizzle-orm');
  const [{client,withTenant},{aiSpendStatusTx}]=await Promise.all([import(pathToFileURL(join(root,'db/client.ts')).href),import(pathToFileURL(join(root,'core/ai-spend-management.ts')).href)]);
  let next=0,inFlight=false,failed=false;
  async function totals(){return owner.client.begin('isolation level read committed read only',async tx=>{
   const[role]=await tx`select current_user as name,current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port,current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation,rolsuper or rolbypassrls as full from pg_roles where rolname=current_user`;assertAiControlsReadbackPhysical(role,target,true);
   const[row]=await tx`select
    (select count(*)::int from public.domain_event where tenant_id=${captured.tenantId}::uuid and actor_type='user' and actor_id=${captured.userId}::uuid and event_type='ai-control.spend-allocation-changed') as "spendEventCount",
    (select count(*)::int from public.domain_event where tenant_id=${captured.tenantId}::uuid and actor_type='user' and actor_id=${captured.userId}::uuid and event_type='ai-control.allowance-changed') as "allowanceEventCount",
    (select count(*)::int from public.domain_event where tenant_id=${captured.tenantId}::uuid and aggregate_type='ai-control' and (actor_type<>'user' or actor_id is distinct from ${captured.userId}::uuid or event_type not in('ai-control.spend-allocation-changed','ai-control.allowance-changed'))) as "otherControlEventCount",
    (select count(*)::int from public.ai_model_run where tenant_id=${captured.tenantId}::uuid) as "modelRunCount",
    (select count(*)::int from public.ai_provider_config where tenant_id=${captured.tenantId}::uuid) as "providerConfigCount",
    (select count(*)::int from public.ai_provider_candidate where tenant_id=${captured.tenantId}::uuid) as "providerCandidateCount",
    ((select count(*)::int from app.ai_spend_reviewed_carrier_catalog where tenant_id=${captured.tenantId}::uuid)+(select count(*)::int from app.ai_spend_reviewed_metered_carrier_catalog where tenant_id=${captured.tenantId}::uuid)) as "reviewedCarrierRecordCount"`;
   return row;
  });}
  async function current(){return client.begin('isolation level read committed read only',async tx=>{
   const[role]=await tx`select current_user as name,current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port,current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation,rolsuper as super,rolbypassrls as bypass from pg_roles where rolname=current_user`;assertAiControlsReadbackPhysical(role,target,false);
   const rows=await tx`select tenant_id,person_id,grants from app.principal(${captured.userId}::uuid)`;
   if(rows.length!==1||rows[0].tenant_id!==captured.tenantId||rows[0].person_id!==captured.personId||!Array.isArray(rows[0].grants)||rows[0].grants.some(g=>!g||typeof g.role!=='string'||g.companyId!==null&&!uuid(g.companyId)))return unavailable();
   const grants=rows[0].grants.map(g=>({...g}));return{tenantId:captured.tenantId,userId:captured.userId,personId:captured.personId,grants,roles:[...new Set(grants.map(g=>g.role))]};
  });}
  // Actual owner/app physical guards before yielding the callback; no phase is fabricated here.
  await totals();await current();
  return async function verifyNative(invocation){
   if(failed||inFlight||!invocation||typeof invocation!=='object'||Array.isArray(invocation)||Object.keys(invocation).length!==1||!Object.hasOwn(invocation,'phase')||typeof invocation.phase!=='string'||!AI_CONTROLS_PHASES.includes(invocation.phase)||invocation.phase!==AI_CONTROLS_PHASES[next])return unavailable();inFlight=true;
   try{
    const freshTarget=parseAiControlsReadbackTarget();if(freshTarget.database!==target.database||freshTarget.ownerName!==target.ownerName)return unavailable();
    const counts=await totals(),ctx=await current();
    const values=await withTenant(ctx,async tx=>{
     await tx.execute(sql`SET TRANSACTION READ ONLY`);
     const[role]=await tx.execute(sql`select current_user as name,current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port,current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation,rolsuper as super,rolbypassrls as bypass from pg_roles where rolname=current_user`);assertAiControlsReadbackPhysical(role,target,false);
     const status=await aiSpendStatusTx(tx,ctx);if(!status)return unavailable();const budgets=status.budgets.filter(b=>b.scopeKey==='tenant');if(budgets.length>1)return unavailable();
     // Same authoritative policy row consumed by aiManagementView; never a posted allowance/actor.
     const rows=await tx.execute(sql`select enabled,daily_requests as "dailyRequests",monthly_tokens::text as "monthlyTokens",max_concurrent as "maxConcurrent" from public.ai_control_policy where tenant_id=${captured.tenantId}::uuid and kind='user_default' and scope_key='user_default'`);if(rows.length>1)return unavailable();
     const row=rows[0];return{currentActorUserId:ctx.userId,spend:budgets[0]?{monthlyNanos:budgets[0].monthlyNanos,rootNanos:budgets[0].rootNanos}:null,defaultAllowance:row?{enabled:row.enabled,dailyRequests:row.dailyRequests,monthlyTokens:row.monthlyTokens,maxConcurrent:row.maxConcurrent}:null};
    });
    next++;return{...values,...counts};
   }catch{failed=true;return unavailable();}finally{inFlight=false;}
  };
 }catch{return unavailable();}
}
