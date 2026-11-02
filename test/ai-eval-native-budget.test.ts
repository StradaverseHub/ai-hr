/** No network. Explicit TEST-ONLY fictional fixed-total certificate selector; not live carrier or
 * privacy review evidence. Native question-root/policy/admission/reservation and the original opaque
 * proof validator are real. The injected HTTP boundary tests budgeting, not gateway/body serialization.
 */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {saveAiProviderConfig} from '../core/ai-config';
import {resolveAiProviderCandidateSnapshotTx} from '../core/ai-provider-snapshot';
import {grantAssistant} from '../core/assistant-grant';
import {setAiSpendBudget} from '../core/ai-spend-management';
import {resolveAiSpendPolicyTx,resolveReviewedAiSpendCapabilityTx,withReviewedAiSpendDispatch} from '../core/ai-spend-capability';
import {aiSpendConfigurationDigest} from '../lib/ai/spend-receipt';
import type {AiAdmission} from '../lib/ai/governance';
import {createNativeEvalBudget} from './helpers/ai-eval-native-budget';
import {installSyntheticSpendCapability} from './ai-spend-fixture';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

let ctx:SessionContext,configuration:Awaited<ReturnType<typeof resolveAiProviderCandidateSnapshotTx>>['configuration'];
let certificate:Awaited<ReturnType<typeof installSyntheticSpendCapability>>;
beforeAll(migrateTestDb);afterAll(closeAll);
afterEach(()=>{certificate?.restore();vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
  await resetDb();const base=await seedBase();await setModule(base.tenantId,'assistant','active');
  ctx={...await entitledCtx(base),grants:[{role:'hr_admin',companyId:null}]};
  await grantAssistant(ctx,{appUserId:base.adminUserId});
  vi.stubEnv('AI_CONFIG_SECRET','fictional-native-eval-secret');
  await saveAiProviderConfig(ctx,{provider:'openrouter',model:'openai/gpt-6-luna',apiKey:'fictional-never-network',
    providerOptions:{version:1,routing:{allowedProviders:['fictional'],allowFallbacks:false,sort:'latency'}}});
  configuration=(await withTenant(ctx,tx=>resolveAiProviderCandidateSnapshotTx(tx,ctx,'openrouter'))).configuration;
  certificate=await installSyntheticSpendCapability(ctx,{provider:'openrouter',model:configuration.model,
    reservedNanos:'6000000000',monthlyNanos:'15000000000',rootNanos:'15000000000'});
});

async function admitQuestion(question:string,operation:'conversation'|'draft'='conversation'){
  const request:Readonly<AiAdmission>=Object.freeze({operation,reservedTokens:32,
    inputDigest:createHash('sha256').update(question).digest('hex')});
  return withTenant(ctx,async tx=>{
    const[root]=await tx.execute<{id:string}>(sql`select app.ai_spend_task_issue('hr_assistant','assistant_question',null,'question') as id`);
    expect((await resolveAiSpendPolicyTx(tx,ctx,'hr_assistant',{rootTaskId:root.id,kind:'agent'})).requiresMonetaryCeiling).toBe(true);
    const envelope=await resolveReviewedAiSpendCapabilityTx(tx,ctx,configuration,request);
    const[run]=await tx.execute<{run_id:string;allowed:boolean}>(sql`select * from app.ai_admit('hr_assistant',${operation},'openrouter',${configuration.model},32)`);
    expect(run.allowed).toBe(true);
    await tx.execute(sql`select app.ai_spend_reserve(${run.run_id}::uuid,${root.id}::uuid,'agent',${envelope.capabilityDigest},${envelope.requestDigest},${envelope.reservedNanos}::bigint,${aiSpendConfigurationDigest(configuration)})`);
    return{rootId:root.id,runId:run.run_id,envelope,request};
  });
}
const holdRows=()=>owner.db.execute<{root:string;state:string;reserved:string;confirmed:string|null}>(sql`
  select root_id::text as root,state,reserved_nanos::text as reserved,confirmed_nanos::text as confirmed
  from app.ai_spend_reservation where tenant_id=${ctx.tenantId}::uuid order by created_at,run_id`);
const allocation=(nanos=15_000_000_000n)=>createNativeEvalBudget({allocationNanos:nanos,maxAttempts:10,nativeDispatch:withReviewedAiSpendDispatch});

describe('evaluation lifetime adapter after actual native proof admission',()=>{
  it('different actual question roots share one lifetime allowance; the second dispatch never reaches HTTP',async()=>{
    const guard=allocation(10_000_000_000n),http=vi.fn(async()=>new Response('fictional response'));
    const first=await admitQuestion('Fictional first turn');
    expect(await guard.dispatch(first.envelope,configuration,first.request,http)).toBeInstanceOf(Response);
    // Complete only the token run. No receipt exists, so its actual monetary allocation stays held.
    await withTenant(ctx,tx=>tx.execute(sql`select app.ai_settle(${first.runId}::uuid,true,1)`));
    const second=await admitQuestion('Fictional second turn');expect(second.rootId).not.toBe(first.rootId);
    await expect(guard.dispatch(second.envelope,configuration,second.request,http)).rejects.toThrow();
    expect(http).toHaveBeenCalledOnce();
    expect(guard.snapshot()).toMatchObject({reservedNanos:6_000_000_000n,remainingNanos:4_000_000_000n,attempts:1});
    expect(guard.attemptEvidence()).toEqual([{requestId:'native_1',requestDigest:first.request.inputDigest,
      configurationDigest:aiSpendConfigurationDigest(configuration),ceilingNanos:6_000_000_000n}]);
    expect(await holdRows()).toHaveLength(2);
    expect((await holdRows()).every(row=>row.state==='held'&&row.confirmed===null&&row.reserved==='6000000000')).toBe(true);
  });

  it('copied, missing and reused proof refuse before lifetime reservation or HTTP',async()=>{
    const guard=allocation(),admitted=await admitQuestion('Fictional proof identity'),http=vi.fn(async()=>null);
    await expect(guard.dispatch({...admitted.envelope},configuration,admitted.request,http)).rejects.toThrow();
    await expect(guard.dispatch(undefined as unknown as typeof admitted.envelope,configuration,admitted.request,http)).rejects.toThrow();
    expect(guard.snapshot().attempts).toBe(0);expect(http).not.toHaveBeenCalled();
    await guard.dispatch(admitted.envelope,configuration,admitted.request,http);
    await expect(guard.dispatch(admitted.envelope,configuration,admitted.request,http)).rejects.toThrow();
    expect(http).toHaveBeenCalledOnce();expect(guard.snapshot().attempts).toBe(1);
  });

  it('HTTP failure retains BOTH the native unknown hold and the complete lifetime allocation',async()=>{
    const guard=allocation(),admitted=await admitQuestion('Fictional failed attempt');
    const http=vi.fn(async()=>{throw Error('Fictional HTTP abort');});
    await expect(guard.dispatch(admitted.envelope,configuration,admitted.request,http)).rejects.toThrow('Fictional HTTP abort');
    expect(http).toHaveBeenCalledOnce();expect(guard.snapshot().reservedNanos).toBe(6_000_000_000n);
    expect(await holdRows()).toEqual([{root:admitted.rootId,state:'held',reserved:'6000000000',confirmed:null}]);
  });

  it('an authentic native draft proof cannot enter the conversation-only evaluation allocation',async()=>{
    const guard=allocation(),admitted=await admitQuestion('Fictional other operation','draft'),http=vi.fn(async()=>null);
    await expect(guard.dispatch(admitted.envelope,configuration,admitted.request,http)).rejects.toThrow('Native evaluation request unavailable');
    expect(http).not.toHaveBeenCalled();expect(guard.snapshot().attempts).toBe(0);
    expect(await holdRows()).toHaveLength(1);
  });

  it('a stricter actual native limit still refuses admission and cannot be bypassed by the lifetime adapter',async()=>{
    await setAiSpendBudget(ctx,{kind:'tenant',monthlyUsd:'0',rootUsd:'15'});
    const guard=allocation(),http=vi.fn(async()=>null);
    const execute=async()=>{const admitted=await admitQuestion('Fictional native zero allocation');
      return guard.dispatch(admitted.envelope,configuration,admitted.request,http);};
    await expect(execute()).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();expect(guard.snapshot().attempts).toBe(0);
    expect(await holdRows()).toEqual([]);
    const[runs]=await owner.db.execute<{count:number}>(sql`select count(*)::int as count from ai_model_run where tenant_id=${ctx.tenantId}::uuid`);
    expect(runs.count).toBe(0);
  });
});
