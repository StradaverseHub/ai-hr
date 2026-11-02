/** Actual native governed configuration/lifecycle/proof/admission and SQL readback. Only pricing is
 * the existing explicit TEST-ONLY source-certified fictional transport fixture; HTTP is fake.
 * No authority/privacy mock, real key or network. This is not a live paid-carrier attestation.
 */
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {aiProviderConfig} from '../db/schema';
import {resolveActiveAiConfig} from '../core/ai-config';
import {grantAssistant} from '../core/assistant-grant';
import {bindAiSpendTaskTx} from '../core/ai-spend-task';
import {withAiAdmissionLifecycle,preparePrivateAiTask} from '../core/ai-governance';
import type {CertifiedAiSpendEnvelope} from '../lib/ai/spend-allocation';
import type {AiAdmission} from '../lib/ai/governance';
import type {ResolvedAiConfig} from '../lib/ai/types';
import {encryptSecret} from '../lib/ai/crypto';
import {converse} from '../lib/ai';
import {TERAS_HARNESS_CONTRACT} from '../lib/ai/teras-harness-policy';
import {createOpenRouterAdapter,openrouterAdapter} from '../lib/ai/providers/openrouter';
import {createNativeEvalWitness} from './helpers/ai-eval-native-witness';
import {installSyntheticSpendCapability} from './ai-spend-fixture';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

const active=vi.hoisted(()=>({witness:null as ReturnType<typeof import('./helpers/ai-eval-native-witness').createNativeEvalWitness>|null,
  requests:[] as Readonly<import('../lib/ai/governance').AiAdmission>[]}));
vi.mock('../core/ai-spend-capability',async original=>{
  const actual=await original<typeof import('../core/ai-spend-capability')>();
  return{...actual,withReviewedAiSpendDispatch:<T>(envelope:CertifiedAiSpendEnvelope,cfg:ResolvedAiConfig,
    request:Readonly<AiAdmission>,consume:()=>Promise<T>):Promise<T>=>{
      if(!active.witness)throw Error('Missing native witness fixture');
      return active.witness.dispatch(envelope,cfg,request,async()=>{
        active.requests.push(request);expect(active.witness!.attemptFor(request)?.runId).toMatch(/^[a-f0-9-]{36}$/);
        return consume();
      });
    }};
});
let ctx:SessionContext,configuration:ResolvedAiConfig;
let price:Awaited<ReturnType<typeof installSyntheticSpendCapability>>;
let http:ReturnType<typeof vi.fn<typeof fetch>>;
// Independent FULL fixture-tenant ledger, not run IDs selected by the candidate witness.
type Row={runId:string;rootId:string|null;capabilityDigest:string|null;requestDigest:string|null;configurationDigest:string|null;
  reservedNanos:string|null;confirmedNanos:string|null;spendState:string|null;provider:string;model:string;operation:string;runState:string};
const readback=()=>owner.db.execute<Row>(sql`select m.id::text as "runId",m.provider,m.model,m.operation,m.state as "runState",
  r.root_id::text as "rootId",r.capability_digest as "capabilityDigest",r.request_digest as "requestDigest",
  r.configuration_digest as "configurationDigest",r.reserved_nanos::text as "reservedNanos",
  r.confirmed_nanos::text as "confirmedNanos",r.state as "spendState"
  from public.ai_model_run m left join app.ai_spend_reservation r on r.run_id=m.id and r.tenant_id=m.tenant_id
  where m.tenant_id=${ctx.tenantId}::uuid order by m.id`);
beforeAll(migrateTestDb);afterAll(closeAll);
afterEach(()=>{price?.restore();active.witness=null;active.requests.length=0;vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});
beforeEach(async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Unexpected global network boundary');}));
  await resetDb();const base=await seedBase();await setModule(base.tenantId,'assistant','active');
  ctx={...await entitledCtx(base),grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(ctx,{appUserId:base.adminUserId});
  vi.stubEnv('AI_CONFIG_SECRET','fictional-native-witness-custody-key');
  vi.stubEnv('AI_SPEND_RECEIPT_KEY_ID','');vi.stubEnv('AI_SPEND_RECEIPT_SIGNING_KEY','');
  await owner.db.insert(aiProviderConfig).values({tenantId:base.tenantId,provider:'openrouter',model:'openai/gpt-6-luna',
    apiKeyCiphertext:encryptSecret('fictional-no-network-key',base.tenantId),keyLast4:'-key',isActive:true,
    providerOptions:{version:1,routing:{allowedProviders:['fictional'],allowFallbacks:false,sort:'latency'}}});
  const cfg=await withTenant(ctx,tx=>resolveActiveAiConfig(tx,ctx,'hr_assistant'));if(!cfg)throw Error('Missing native governed config');configuration=cfg;
  price=await installSyntheticSpendCapability(ctx,{provider:'openrouter',model:cfg.model,reservedNanos:'1000000',monthlyNanos:'15000000000',rootNanos:'15000000000'});
  const actual=await vi.importActual<typeof import('../core/ai-spend-capability')>('../core/ai-spend-capability');
  active.witness=createNativeEvalWitness({evaluationId:'fictional_evaluation',withLifecycle:withAiAdmissionLifecycle,nativeDispatch:actual.withReviewedAiSpendDispatch});
  http=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(JSON.stringify({id:'gen-fictional-witness',model:cfg.model,
    choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Fictional response'}}],
    usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0.001}}),{headers:{'content-type':'application/json'}}));
  const adapter=createOpenRouterAdapter(http);
  vi.spyOn(openrouterAdapter,'converse').mockImplementation((config,args)=>adapter.converse!(config,args));
});

async function question(caseId:string,cfg=configuration,addWitness=true){
  return active.witness!.runCase(caseId,async()=>{
    const witnessed=addWitness?active.witness!.configuration(cfg,'hr_assistant'):cfg;
    const rooted=await withTenant(ctx,tx=>bindAiSpendTaskTx(tx,ctx,witnessed,{kind:'assistant_question'}));
    const source={version:1,messages:[{role:'system',content:'Fictional witness fixture only'},
      {role:'user',content:'Exactly identical fictional question'}],tools:[],maxOutputTokens:8,timeoutMs:1000};
    const prepared=await preparePrivateAiTask(rooted,TERAS_HARNESS_CONTRACT,async()=>source);
    try{if(prepared.operation!=='conversation')throw Error('Expected conversation');return await converse(prepared.configuration,prepared.args);}
    finally{prepared.dispose();}
  });
}

describe('native evaluation run witness without authority mocks or real provider calls',()=>{
  it('identical requests in different cases correlate to DISTINCT committed native runs and roots',async()=>{
    await question('case_one');await question('case_two');expect(http).toHaveBeenCalledTimes(2);
    const attempts=active.witness!.committedAttempts(),rows=await readback();
    expect(attempts.map(row=>row.caseId)).toEqual(['case_one','case_two']);expect(attempts).toHaveLength(2);
    expect(attempts[0].requestDigest).toBe(attempts[1].requestDigest);
    expect(new Set(attempts.map(row=>row.runId)).size).toBe(2);expect(new Set(rows.map(row=>row.rootId)).size).toBe(2);
    expect(rows).toHaveLength(2);
    for(const attempt of attempts){const row=rows.find(item=>item.runId===attempt.runId)!;
      expect(row).toMatchObject({runId:attempt.runId,capabilityDigest:attempt.capabilityDigest,requestDigest:attempt.requestDigest,
        configurationDigest:attempt.configurationDigest,reservedNanos:attempt.ceilingNanos,confirmedNanos:null,
        spendState:'held',provider:'openrouter',model:'openai/gpt-6-luna',operation:'conversation',runState:'completed'});
      expect(row.rootId).toMatch(/^[a-f0-9-]{36}$/);
    }
    expect(active.witness!.attemptFor(active.requests[0])).toBe(attempts[0]);
    expect(active.witness!.attemptFor({...active.requests[0]})).toBeNull();
    const wire=String(http.mock.calls[0][1]?.body);
    for(const attempt of attempts){expect(wire).not.toContain(attempt.runId);expect(wire).not.toContain(attempt.caseId);}
    expect(JSON.stringify(attempts)).not.toContain('fictional-no-network-key');
  });

  it('transport failure retains the exact committed failed run and unknown native reservation',async()=>{
    http.mockRejectedValueOnce(Error('Fictional HTTP failure'));
    await expect(question('failed_case')).rejects.toThrow();expect(http).toHaveBeenCalledOnce();
    expect(active.witness!.committedAttempts()).toHaveLength(1);
    const [row]=await readback();expect(row).toMatchObject({runState:'failed',spendState:'held',confirmedNanos:null,reservedNanos:'1000000'});
    expect(row.runId).toBe(active.witness!.committedAttempts()[0].runId);
  });

  it('preserves preceding lifecycle hooks and publishes no phantom committed attempt after admission rollback',async()=>{
    const previous=vi.fn(async()=>{}),settled=vi.fn(async()=>{});
    const prior=withAiAdmissionLifecycle(configuration,'hr_assistant',{admitted:previous,settled});
    await question('composed_case',prior);expect(previous).toHaveBeenCalledOnce();expect(settled).toHaveBeenCalledOnce();
    const before=active.witness!.committedAttempts();
    const later=vi.fn(async()=>{throw Error('Fictional later lifecycle failure');});
    await active.witness!.runCase('rolled_back_case',async()=>{
      const witnessed=active.witness!.configuration(configuration,'hr_assistant');
      const refused=withAiAdmissionLifecycle(witnessed,'hr_assistant',{admitted:later});
      await expect(question('rolled_back_case',refused,false)).rejects.toThrow();
    });
    expect(later).toHaveBeenCalledOnce();
    expect(active.witness!.committedAttempts()).toEqual(before);expect(http).toHaveBeenCalledOnce();
    const [count]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from ai_model_run where tenant_id=${ctx.tenantId}::uuid`);
    expect(count.n).toBe(1);
  });

  it('a copied governed configuration cannot acquire a lifecycle witness; app role cannot read the private ledger',async()=>{
    expect(()=>active.witness!.configuration({...configuration},'hr_assistant')).toThrow();
    await question('private_readback');
    await expect(withTenant(ctx,tx=>tx.execute(sql`select run_id from app.ai_spend_reservation`))).rejects.toThrow();
    expect(await readback()).toHaveLength(1);expect(http).toHaveBeenCalledOnce();
  });
});
