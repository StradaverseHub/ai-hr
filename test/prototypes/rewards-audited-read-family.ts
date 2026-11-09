/** UNINSTALLED isolated family. No production singleton, env credential fallback,
 * application pool or runtime adoption. Production must reserve its real family. */
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {createDatabaseAdmission} from '../../db/admission';
import {assertModuleEnabled} from '../../core/entitlements';
import {setupYear} from '../../packs/rewards/setup-model';
import {rewardLibrariesQueryTx,rewardPatInputsQueryTx} from '../../packs/rewards/setup-query-owner';
import {receiptRewardSetupQueryPort} from './rewards-audited-read-port';
import {rewardsAuditPrototypeStartup} from './rewards-audit-startup';
type Receipt={id:string;observed_at:string};
function captured(ctx:SessionContext):SessionContext{return{...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};}
function human(supplied:SessionContext){const ctx=captured(supplied);assertModuleEnabled(ctx,'rewards');if(!ctx.userId||ctx.agent||ctx.entitlementsExempt!==undefined||ctx.statutoryOverride!==undefined)throw Error('Current human prototype context required');return ctx;}
const count=z.string().regex(/^(?:0|[1-9][0-9]*)$/),coverageSchema=z.object({version:z.literal(1),scope:z.literal('armed-chain-prototype'),processor:z.literal('uninstalled'),failures:z.null(),committedReceipts:count,projectedReceipts:count,pendingReceipts:count,oldestPendingAt:z.string().nullable(),caughtUp:z.boolean()}).strict();
export function createUninstalledRewardsAuditFamily(options:{database:string;readerUrl:string;projectorUrl:string;connectTimeoutSeconds?:2}){
 const parse=(raw:string,role:string)=>{const url=new URL(raw);if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.username!==role||!url.password||url.pathname!=='/'+options.database||url.search||url.hash)throw Error('Exact private prototype LOGIN required');return url;};
 const readUrl=parse(options.readerUrl,'ai_hr_reward_audit_read'),projectUrl=parse(options.projectorUrl,'ai_hr_reward_audit_projector');
 const startup=rewardsAuditPrototypeStartup(options.connectTimeoutSeconds);
 if(readUrl.port!==projectUrl.port)throw Error('Prototype family endpoints differ');
 // Physical maxima1+2 and a COMMON three-slot admission owner. The second fixed
 // projector connection proves concurrent native claims; no independent full pool.
 const reader=postgres(readUrl.toString(),{max:1,...startup,connection:{statement_timeout:20000,lock_timeout:300}}),projector=postgres(projectUrl.toString(),{max:2,...startup,connection:{statement_timeout:20000,lock_timeout:300}});
 const readDb=drizzle(reader),gate=createDatabaseAdmission({capacity:3,backgroundCapacity:2,maxWaiting:16,maxBackgroundWaiting:4,waitMs:30000});
 // Admitted role reservations wait in an abortable owner BEFORE checkout, never
 // in an invisible postgres.js queue. The outer family still owns all budgets.
 const readLane=createDatabaseAdmission({capacity:1,backgroundCapacity:1,maxWaiting:2,waitMs:30000});
 async function readWork<T>(tenant:string,signal:AbortSignal|undefined,work:()=>Promise<T>){const release=await gate.acquire(tenant,'interactive',signal);let lane:(()=>void)|undefined;try{lane=await readLane.acquire(tenant,'interactive',signal);signal?.throwIfAborted();return await work();}finally{lane?.();release();}}
 async function snapshot<T>(supplied:SessionContext,operation:'libraries'|'pat',kind:'salary'|'bonus'|null,year:number|null,query:(tx:Tx,ctx:SessionContext)=>Promise<T>,signal?:AbortSignal){
  const ctx=human(supplied);signal?.throwIfAborted();
  return readWork(ctx.tenantId,signal,()=>readDb.transaction(async tx=>{
   signal?.throwIfAborted();
   const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null})),roles=ctx.roles??Array.from(new Set(grants.map(grant=>grant.role)));
   await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId},true),set_config('app.roles',${roles.join(',')},true),set_config('app.grants',${JSON.stringify(grants)},true),set_config('app.agent_principal_id','',true)`);
   const [admission]=await tx.execute<{id:string}>(sql`select reward_audit_read.begin_read(${operation},${kind},${year}::integer)as id`);
   const data=await query(tx,ctx);signal?.throwIfAborted();
   const [receipt]=await tx.execute<Receipt>(sql`select * from reward_audit_read.finalize_read(${admission.id}::uuid)`);
   signal?.throwIfAborted();return{data,receipt};
  },{isolationLevel:'repeatable read',accessMode:'read write'}));
 }
 return{
  libraries(supplied:SessionContext,kind?:'salary'|'bonus',year?:number,signal?:AbortSignal){if(kind!==undefined&&!['salary','bonus'].includes(kind))throw Error('Invalid library kind');if(year!==undefined)setupYear.parse(year);return snapshot(supplied,'libraries',kind??null,year??null,(tx,ctx)=>rewardLibrariesQueryTx(tx,ctx,kind,year,receiptRewardSetupQueryPort),signal);},
  pat(supplied:SessionContext,year:number,signal?:AbortSignal){setupYear.parse(year);return snapshot(supplied,'pat',null,year,(tx,ctx)=>rewardPatInputsQueryTx(tx,ctx,year,receiptRewardSetupQueryPort),signal);},
  async materialize(limit=25){if(!Number.isInteger(limit)||limit<1||limit>25)throw Error('Bounded prototype drain required');const release=await gate.acquire('reward-audit-projection','background');try{const [result]=await projector<{projected:number}[]>`select reward_audit_projection.materialize(${limit}::integer)as projected`;return result.projected;}finally{release();}},
  async coverage(supplied:SessionContext){const ctx=human(supplied);return readWork(ctx.tenantId,undefined,()=>readDb.transaction(async tx=>{const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null}));await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),set_config('app.roles',${(ctx.roles??Array.from(new Set(grants.map(g=>g.role)))).join(',')},true),set_config('app.grants',${JSON.stringify(grants)},true),set_config('app.agent_principal_id','',true)`);const [row]=await tx.execute<{value:unknown}>(sql`select reward_audit_read.coverage()as value`);return coverageSchema.parse(row.value);},{isolationLevel:'repeatable read',accessMode:'read only'}));},
  async close(){await Promise.all([reader.end({timeout:0}),projector.end({timeout:0})]);},
 };
}
