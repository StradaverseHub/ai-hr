/** PRIVATE import-safe native candidate readback, UNRUN. Actual restricted app connection only;
 * no owner connection/row bypass, key/ciphertext/last4 readback, decryption, probe or activation.
 * Parent owns target/admission/session selection and this process's existing app pool lifetime. */
import {count,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {client,withTenant,type Grant,type SessionContext} from '../../db/client';
import {aiModelRun,aiProviderConfig} from '../../db/schema';
import {providerCandidatesTx} from '../../core/ai-provider-readiness';
import {currentAiProviderAdminTx} from '../../core/ai-provider-authority';
import {readOpenRouterOptions} from '../../lib/ai/providers/openrouter-configuration';
import {OpenRouterModel} from '../../lib/ai/providers/openrouter-transport';
const uuid=z.guid(),Expected=z.object({model:OpenRouterModel,providerOptions:z.unknown()}).strict();
const Phase=z.object({phase:z.enum(['baseline','invalid_routes','saved','reloaded'])}).strict();
const unavailable=():never=>{throw Error('provider_config_native_readback:unavailable');};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
type Fixture={state:'native_prerequisites_prepared_not_experienced';tenantId:string;actors:{operator:{userId:string;personId:string}}};
export async function createAiDeliveryProviderConfigNativeReadback({fixture,expected}:{fixture:Fixture;expected:unknown}){
 const selected=structuredClone({tenantId:fixture.tenantId,...fixture.actors.operator}),input=Expected.safeParse(structuredClone(expected));if(!input.success)return unavailable();const parsed=input.data;
 if(fixture.state!=='native_prerequisites_prepared_not_experienced'||![selected.tenantId,selected.userId,selected.personId].every(value=>uuid.safeParse(value).success))return unavailable();
 let selection:{model:string;providerOptions:ReturnType<typeof readOpenRouterOptions>};try{selection={model:parsed.model,providerOptions:readOpenRouterOptions(parsed.providerOptions)};}catch{return unavailable();}
 let url:URL;try{url=new URL(process.env.DATABASE_URL??'');}catch{return unavailable();}
 const database=url.pathname.slice(1);
 if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.username)!=='ai_hr_app'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.port!=='5433'||!(database==='aihr_ai_delivery_browser_v4_20261027'||/^aihr_assistant_browser_[a-f0-9]{16}$/.test(database))||url.hash||[...url.searchParams].some(([key,value])=>key!=='sslmode'||value!=='disable'))return unavailable();
 // A fresh fictional fixture must never inherit real provider credentials or environment fallback.
 if([process.env.ANTHROPIC_API_KEY,process.env.OPENAI_API_KEY,process.env.GOOGLE_API_KEY,process.env.GEMINI_API_KEY,process.env.OPENROUTER_API_KEY].some(value=>value?.trim()))return unavailable();
 const capturedUrl=url.toString();let phase=0,inFlight=false,completedCandidate:unknown;
 const phases=['baseline','invalid_routes','saved','reloaded'] as const;
 async function read(){
  if(new URL(process.env.DATABASE_URL??'').toString()!==capturedUrl)return unavailable();
  const ctx=await client.begin('isolation level read committed read only',async tx=>{
   const [physical]=await tx<{name:string;database:string;address:string;port:number;readonly:string;isolation:string;super:boolean;bypass:boolean}[]>`select current_user as name,current_database() as database,host(inet_server_addr()) as address,inet_server_port() as port,current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation,rolsuper as super,rolbypassrls as bypass from pg_roles where rolname=current_user`;
   if(physical?.name!=='ai_hr_app'||physical.database!==database||!['127.0.0.1','::1'].includes(physical.address)||physical.port!==5433||physical.readonly!=='on'||physical.isolation!=='read committed'||physical.super||physical.bypass)return unavailable();
   const rows=await tx<{tenant_id:string;person_id:string|null;grants:Grant[]|null}[]>`select tenant_id,person_id,grants from app.principal(${selected.userId}::uuid)`;
   if(rows.length!==1||rows[0].tenant_id!==selected.tenantId||rows[0].person_id!==selected.personId||!Array.isArray(rows[0].grants)||rows[0].grants.some(g=>!g||typeof g.role!=='string'||g.companyId!==null&&!uuid.safeParse(g.companyId).success))return unavailable();
   const grants=rows[0].grants.map(g=>({...g}));return {tenantId:selected.tenantId,userId:selected.userId,personId:selected.personId,roles:[...new Set(grants.map(g=>g.role))],grants} satisfies SessionContext;
  });
  return withTenant(ctx,async tx=>{
   await tx.execute(sql`set transaction read only`);
   if(!(await currentAiProviderAdminTx(tx,ctx)))return unavailable();
   const candidates=await providerCandidatesTx(tx,ctx);if(candidates.length>1)return unavailable();
   const [live]=await tx.select({n:count()}).from(aiProviderConfig).where(eq(aiProviderConfig.tenantId,ctx.tenantId));
   const [active]=await tx.select({n:count()}).from(aiProviderConfig).where(sql`${aiProviderConfig.tenantId}=${ctx.tenantId}::uuid and ${aiProviderConfig.isActive}=true`);
   const [runs]=await tx.select({n:count()}).from(aiModelRun).where(eq(aiModelRun.tenantId,ctx.tenantId));
   const c=candidates[0];
   return {currentActorUserId:ctx.userId,candidate:c?{candidateId:c.id,candidateVersion:c.version,model:c.model,providerOptions:c.providerOptions}:null,activeConfigurationCount:active.n,liveConfigurationCount:live.n,modelRunCount:runs.n};
  });
 }
 // Constructor positively checks actual current actor before a caller drives any save operation.
 try{await read();}catch{return unavailable();}
 return async function verifyInactiveProvider(value:unknown){
  if(inFlight)return unavailable();inFlight=true;
  try{
   const p=Phase.parse(value);if(p.phase!==phases[phase])return unavailable();const facts=await read();
   if(facts.activeConfigurationCount!==0||facts.liveConfigurationCount!==0||facts.modelRunCount!==0)return unavailable();
   if(phase<2){if(facts.candidate!==null)return unavailable();}
   else{const c=facts.candidate;if(!c||!uuid.safeParse(c.candidateId).success||!uuid.safeParse(c.candidateVersion).success||c.model!==selection.model||!same(c.providerOptions,selection.providerOptions))return unavailable();if(phase===2)completedCandidate=c;else if(!same(c,completedCandidate))return unavailable();}
   phase++;return facts;
  }catch{return unavailable();}finally{inFlight=false;}
 };
}
