/** TEST ONLY: synthetic privacy-review seam for this legacy gateway-control suite. The new
 * disclosure assertion/consumption is isolated so the original protocol, capture, source, admission,
 * spend and accounting controls below are still exercised. Actual binding/transfer/revocation and
 * provider egress dispatch remain real. Dedicated provider-privacy-request, provider-data-review-gate
 * and ai-private-analysis suites exercise the real default-block/review policy separately. This
 * fixture grants no production review status and admits no real provider data. */
vi.mock('../lib/ai/provider-privacy-request', async importActual => {
  const actual = await importActual<typeof import('../lib/ai/provider-privacy-request')>();
  return { ...actual, assertProviderPrivacyRequest: () => {}, consumeProviderPrivacyRequest: () => {} };
});

import {fixtureOpenRouterTransport as createOpenRouterTransport} from './helpers/provider-egress-fixture';
/** Authored UNRUN. Real app-role admission/cryptographic verifier/reconciliation; fictional price
 * capability only + HTTP transport mock. No live provider ceiling or actual key provisioning proof. */
import {createHmac,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {saveAiProviderConfig} from '../core/ai-config';
import {providerCandidatesTx} from '../core/ai-provider-readiness';
import {resolveAiProviderCandidateSnapshotTx} from '../core/ai-provider-snapshot';
import {bindStrictAiSpendRoot,governedAiConfig} from '../core/ai-governance';
import {readOpenRouterOptions} from '../lib/ai/providers/openrouter-configuration';
import {aiSpendConfigurationDigest,createAiSpendReceiptScope} from '../lib/ai/spend-receipt';
import {generateDraft} from '../lib/ai';
import {installSyntheticSpendCapability,installSyntheticSpendReceiptVerifier} from './ai-spend-fixture';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,ctx:SessionContext,root:string,fixture:Awaited<ReturnType<typeof installSyntheticSpendCapability>>,signer:Awaited<ReturnType<typeof installSyntheticSpendReceiptVerifier>>;
const options=readOpenRouterOptions({version:1,routing:{allowedProviders:['fictional'],allowFallbacks:false,sort:'latency'}}),configuration={provider:'openrouter' as const,model:'fictional/model',apiKey:'fictional-not-live',providerOptions:options};
const raw=(meta:boolean,id='gen-receipt-fixture',cost='0.0000000012')=>meta?`{"data":{"id":"${id}","model":"fictional/model","total_cost":${cost},"is_byok":false,"streamed":false}}`:`{"id":"${id}","model":"fictional/model","usage":{"cost":${cost}},"choices":[{"index":0,"message":{"role":"assistant","content":"Fictional"},"finish_reason":"stop"}]}`;
const response=(text:string)=>new Response(text,{headers:{'content-type':'application/json'}});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{fixture?.restore();vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});
beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);vi.stubEnv('AI_CONFIG_SECRET','fictional-spend-receipt-key');await saveAiProviderConfig(ctx,{provider:'openrouter',model:configuration.model,apiKey:configuration.apiKey,providerOptions:options});root=await withTenant(ctx,async tx=>(await providerCandidatesTx(tx,ctx))[0].id);fixture=await installSyntheticSpendCapability(ctx,{provider:'openrouter',model:configuration.model});signer=await installSyntheticSpendReceiptVerifier();});
async function admitted(){return withTenant(ctx,async tx=>{const[r]=await tx.execute<{run_id:string}>(sql`select * from app.ai_admit('provider_evaluation','draft','openrouter','fictional/model',32)`);await tx.execute(sql`select app.ai_spend_reserve(${r.run_id}::uuid,${root}::uuid,'evaluation',${fixture.digest},${'a'.repeat(64)},${fixture.reservedNanos}::bigint,${aiSpendConfigurationDigest(configuration)})`);return r.run_id;});}
async function actualReceipt(runId:string,generationId='gen-receipt-fixture',cost='0.0000000012'){
 const scope=createAiSpendReceiptScope({tenantId:ctx.tenantId,userId:ctx.userId!,runId,rootTaskId:root,requestDigest:'a'.repeat(64),capabilityDigest:fixture.digest,configurationDigest:aiSpendConfigurationDigest(configuration)});
 const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(raw(false,generationId,cost))).mockResolvedValueOnce(response(raw(true,generationId,cost)));
 await scope.run(()=>createOpenRouterTransport(fetcher)({model:configuration.model,apiKey:configuration.apiKey,routing:options.routing},{system:['Fictional'],turns:[{role:'user',content:'No HR facts'}],tools:[],maxTokens:8}));return scope.receipt()!;
}
const reconcile=(proof:{payload:string;signature:string})=>withTenant(ctx,async tx=>(await tx.execute<{state:string}>(sql`select app.ai_spend_reconcile_receipt(${proof.payload},${proof.signature}) as state`))[0].state);
const reservation=(runId:string)=>owner.db.execute<{state:string;confirmed:string|null}>(sql`select state,confirmed_nanos::text as confirmed from app.ai_spend_reservation where run_id=${runId}::uuid`);
describe('authenticated actual transport USD reconciliation',()=>{
 it('actual issued gateway uses official terminal verification and reconciles exact ceil USD without ordinary callback cost authority',async()=>{
  vi.stubGlobal('fetch',vi.fn<typeof fetch>().mockResolvedValueOnce(response(raw(false))).mockResolvedValueOnce(response(raw(true))));
  const cfg=await withTenant(ctx,async tx=>{const snapshot=await resolveAiProviderCandidateSnapshotTx(tx,ctx,'openrouter');return bindStrictAiSpendRoot(governedAiConfig(ctx,snapshot,'provider_evaluation'),{rootTaskId:snapshot.candidate!.id,kind:'evaluation'});});
  await expect(generateDraft(cfg,{system:'Fictional',prompt:'No HR data',maxTokens:8})).resolves.toBe('Fictional');const[run]=await owner.db.execute<{id:string}>(sql`select id from ai_model_run where tenant_id=${b.tenantId}::uuid`);expect(await reservation(run.id)).toMatchObject([{state:'confirmed',confirmed:'2'}]);
 });
 it('accepts same exact authenticated receipt once, including a confirmed zero, and refuses changed receipt/cross-run reuse',async()=>{const run=await admitted(),proof=await actualReceipt(run,'gen-zero-fixture','0');expect(await reconcile(proof)).toBe('confirmed');expect(await reconcile(proof)).toBe('confirmed');expect(await reservation(run)).toMatchObject([{confirmed:'0'}]);const altered=JSON.parse(proof.payload);altered[3]=await admitted();const payload=JSON.stringify(altered),signature=createHmac('sha256',Buffer.from(signer.secret,'hex')).update(payload).digest('hex');await expect(reconcile({payload,signature})).rejects.toThrow();});
 it.each([1,2,4,5,6,7])('refuses signed-but-wrong tenant/user/root/request/cert/config field %s with original allocation held',async field=>{const run=await admitted(),proof=await actualReceipt(run),body=JSON.parse(proof.payload);body[field]=field<=4?randomUUID():'0'.repeat(64);const payload=JSON.stringify(body),signature=createHmac('sha256',Buffer.from(signer.secret,'hex')).update(payload).digest('hex');await expect(reconcile({payload,signature})).rejects.toThrow();expect(await reservation(run)).toMatchObject([{state:'held',confirmed:null}]);});
 it('ordinary app SQL cannot forge zero evidence or read verifier keys; a revoked verifier cannot release exposure',async()=>{const run=await admitted(),proof=await actualReceipt(run);await expect(reconcile({...proof,signature:'0'.repeat(64)})).rejects.toThrow();await expect(withTenant(ctx,tx=>tx.execute(sql`select secret from app.ai_spend_receipt_verifier`))).rejects.toThrow();await owner.db.execute(sql`update app.ai_spend_receipt_verifier set enabled=false where key_id=${signer.keyId}`);await expect(reconcile(proof)).rejects.toThrow();expect(await reservation(run)).toMatchObject([{state:'held',confirmed:null}]);});
 it('a held verifier row refuses without partial monetary effects, then the same actual receipt verifies after release',async()=>{const run=await admitted(),proof=await actualReceipt(run);let arrive!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{arrive=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});const holder=owner.db.transaction(async tx=>{await tx.execute(sql`select key_id from app.ai_spend_receipt_verifier where key_id=${signer.keyId} for update`);arrive();await resume;});const watchdog=setTimeout(()=>release(),10000);try{await Promise.race([entered,holder.then(()=>{throw Error('Expected actual held verifier row');})]);await expect(reconcile(proof)).rejects.toThrow();expect(await reservation(run)).toMatchObject([{state:'held',confirmed:null}]);}finally{release();clearTimeout(watchdog);await holder;}expect(await reconcile(proof)).toBe('confirmed');});
 it('a larger authenticated charge records the actual conservative debit and breach; rollback/storage failure cannot release a hold',async()=>{const run=await admitted(),proof=await actualReceipt(run,'gen-breach-fixture','0.002');await expect(withTenant(ctx,async tx=>{await tx.execute(sql`select app.ai_spend_reconcile_receipt(${proof.payload},${proof.signature})`);throw Error('Fictional later persistence failure');})).rejects.toThrow('Fictional later');expect(await reservation(run)).toMatchObject([{state:'held',confirmed:null}]);expect(await reconcile(proof)).toBe('breach');expect(await reservation(run)).toMatchObject([{state:'breach',confirmed:'2000000'}]);await expect(admitted()).rejects.toThrow();});
});
