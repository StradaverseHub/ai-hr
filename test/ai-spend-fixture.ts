/** TEST ONLY. Certifies ONLY a mocked fixed-total transport in this test process, never a live
 * provider route. No production flag or writable runtime price registry is introduced. Actual
 * app-role admission/root/scope/reservation/settlement still execute. Tests must separately assert
 * the unmocked production selector refuses every currently unverified real route. */
import {createHash} from 'node:crypto';
import {vi} from 'vitest';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import type {AiProvider} from '../lib/ai/types';
import * as spend from '../lib/ai/spend-allocation';
import {owner} from './harness';
export async function installSyntheticSpendCapability(ctx:SessionContext,input:{provider:AiProvider;model:string;reservedNanos?:string;monthlyNanos?:string;rootNanos?:string}){
 const p=Object.freeze({...input}),nanos=p.reservedNanos??'1000000',digest=createHash('sha256').update(JSON.stringify(['fictional-fixed-total-MOCK-TRANSPORT-ONLY',p.provider,p.model,nanos])).digest('hex');
 if(!/^\d+$/.test(nanos)||BigInt(nanos)<=0n)throw Error('Invalid synthetic ceiling');
 await owner.db.execute(sql`insert into app.ai_spend_capability(digest,provider,model,operation,max_request_nanos,source_digest,verified_at,expires_at,semantics)
 values(${digest},${p.provider},${p.model},'draft',${nanos}::bigint,${'f'.repeat(64)},now(),now()+interval '1 hour','complete_inference_usd_ceiling_v1')
 on conflict(digest) do update set verified_at=now(),expires_at=now()+interval '1 hour',revoked_at=null`);
 // A second synthetic operation uses another exact digest; no wildcard operation/model certificate.
 const conversationDigest=createHash('sha256').update(digest+':conversation').digest('hex');
 await owner.db.execute(sql`insert into app.ai_spend_capability(digest,provider,model,operation,max_request_nanos,source_digest,verified_at,expires_at,semantics)
 values(${conversationDigest},${p.provider},${p.model},'conversation',${nanos}::bigint,${'f'.repeat(64)},now(),now()+interval '1 hour','complete_inference_usd_ceiling_v1')
 on conflict(digest) do update set verified_at=now(),expires_at=now()+interval '1 hour',revoked_at=null`);
 await owner.db.execute(sql`insert into app.ai_spend_budget(tenant_id,scope_key,kind,monthly_nanos,root_nanos,updated_by)
 values(${ctx.tenantId}::uuid,'tenant','tenant',${p.monthlyNanos??'1000000000'}::bigint,${p.rootNanos??'1000000000'}::bigint,${ctx.userId}::uuid)
 on conflict(tenant_id,scope_key) do update set monthly_nanos=excluded.monthly_nanos,root_nanos=excluded.root_nanos`);
 const selector=vi.spyOn(spend,'certifiedAiSpendEnvelope').mockImplementation((configuration,request)=>{
  if(configuration.provider!==p.provider||configuration.model!==p.model||!request.inputDigest||!['draft','conversation'].includes(request.operation))throw Error('Uncertified synthetic request');
  return Object.freeze({capabilityDigest:request.operation==='draft'?digest:conversationDigest,requestDigest:request.inputDigest,reservedNanos:nanos});
 });
 return{digest,conversationDigest,reservedNanos:nanos,restore(){selector.mockRestore();}};
}
