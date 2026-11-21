/** Provider-settings failure reasons: closed codes select fixed translated copy and one structured log line.
 * No database or provider. Every planted secret/message below must never reach a result, redirect or log. */
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,describe,expect,it,vi,type MockInstance} from 'vitest';
const owners=vi.hoisted(()=>({evaluate:vi.fn(),save:vi.fn(),activate:vi.fn(),disable:vi.fn(),remove:vi.fn(),metadata:vi.fn(),session:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:vi.fn((url:string)=>{throw Object.assign(Error('fixture redirect'),{url});})}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string,values?:Record<string,string>)=>values?`${key}${JSON.stringify(values)}`:key)}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:owners.session}));
vi.mock('../core/ai-provider-readiness',()=>({evaluateProviderCandidate:owners.evaluate}));
vi.mock('../core/ai-config',async()=>{
  class AiConfigError extends Error{constructor(message:string,readonly reason='invalid'){super(message);this.name='AiConfigError';}}
  return {AiConfigError,saveAiProviderConfig:owners.save,setActiveProvider:owners.activate,disableAi:owners.disable,removeAiProviderConfig:owners.remove,testConnection:owners.metadata};
});
import {redirect} from 'next/navigation';
import {AiConfigError} from '../core/ai-config';
import {evaluateProviderCandidateAction,saveAiProviderConfigAction,setActiveProviderAction,testConnectionAction} from '../app/admin/ai/actions';
import {describeProviderFailure,logProviderFailure,providerFailureView} from '../app/admin/ai/provider-failure';
import {PROVIDER_FAILURE_REASONS,providerFailureMessage,readProviderFailureView} from '../app/admin/ai/provider-failure-copy';
import {AI_ADMISSION_REFUSAL_CODES,AiAdmissionRefusal,AiSpendControlError,admissionStep,sqlAdmissionRefusalCode} from '../lib/ai/admission-refusal';
import {AiProviderReadinessError} from '../lib/ai/provider-readiness-error';
import {ProviderProtocolFailure} from '../lib/ai/provider-protocol';
import {AiPrivacyGateError} from '../lib/ai/provider-privacy-error';
import {AiAllowanceError,AiGatewayError} from '../lib/ai/types';
import {aiSpendAdmissionStep} from '../core/ai-spend-capability';

const SECRET='sk-or-v1-PRIVATE-0123456789abcdef';
const LEAK=/PRIVATE|sk-or|Failed query|params|select |ciphertext|prompt body/i;
const sqlRefusal=(raised:string)=>Object.assign(Error(`Failed query: select * from app.ai_admit($1) params: ${SECRET}`),{cause:Object.assign(Error(raised),{code:'P0001'})});
const probe=(stage:'draft'|'tool_call'|'tool_result',origin:'local'|'provider'|'response',refusal:unknown)=>
  new AiProviderReadinessError('probe_failed',{stage,origin,model:'openai/gpt-6-luna',refusal:new ProviderProtocolFailure(stage,origin,refusal).refusal});
let warn:MockInstance<typeof console.warn>;
const lines=()=>warn.mock.calls.map(call=>{expect(call[0]).toBe('[ai-provider-admin-failure]');return JSON.parse(String(call[1])) as Record<string,unknown>;});
beforeEach(()=>{warn=vi.spyOn(console,'warn').mockImplementation(()=>{});for(const spy of Object.values(owners))spy.mockReset();owners.session.mockResolvedValue({tenantId:'t',userId:'u'});vi.mocked(redirect).mockClear();});
afterEach(()=>warn.mockRestore());

describe('admission refusal codes',()=>{
  it('maps only exact constant SQL refusals to closed codes and never carries driver text',async()=>{
    expect(sqlAdmissionRefusalCode('Actual AI task root unavailable')).toBe('spend_root_unavailable');
    expect(sqlAdmissionRefusalCode('Current AI admission policy unavailable')).toBe('admission_policy_unavailable');
    expect(sqlAdmissionRefusalCode('AI admission custody requires this actual admission')).toBe('admission_custody');
    expect(sqlAdmissionRefusalCode(`Actual AI task root unavailable ${SECRET}`)).toBe('admission_unavailable');
    expect(sqlAdmissionRefusalCode('constructor')).toBe('admission_unavailable');
    const refused=await aiSpendAdmissionStep(async()=>{throw sqlRefusal('Actual AI task root unavailable');}).then(()=>null,(error:unknown)=>error);
    expect(refused).toBeInstanceOf(AiAdmissionRefusal);expect(refused).toBeInstanceOf(AiGatewayError);
    expect((refused as AiAdmissionRefusal).code).toBe('spend_root_unavailable');
    expect((refused as Error).message).toBe('The AI request could not be admitted.');expect((refused as Error).cause).toBeUndefined();
    expect(JSON.stringify(refused)+String(refused)).not.toMatch(LEAK);
    const spend=await aiSpendAdmissionStep(async()=>{throw sqlRefusal('AI spend allocation exhausted');}).then(()=>null,(error:unknown)=>error);
    expect(spend).toBeInstanceOf(AiSpendControlError);expect(spend).toBeInstanceOf(AiAllowanceError);
    expect((spend as AiSpendControlError).code).toBe('spend_allocation_exhausted');expect((spend as AiSpendControlError).reason).toBe('paused');
  });
  it('relabels only an untyped gateway refusal; typed refusals and raw errors pass unchanged',async()=>{
    const plain=await admissionStep('ai_controls_unavailable',()=>{throw new AiGatewayError('AI controls could not be confirmed.');}).catch((error:unknown)=>error);
    expect(plain).toBeInstanceOf(AiAdmissionRefusal);expect((plain as AiAdmissionRefusal).code).toBe('ai_controls_unavailable');
    expect((plain as Error).message).toBe('AI controls could not be confirmed.');expect((plain as Error).name).toBe('AiGatewayError');
    const paused=new AiAllowanceError('paused'),raw=Error('raw driver');
    expect(await admissionStep('ai_controls_unavailable',()=>{throw paused;}).catch((error:unknown)=>error)).toBe(paused);
    expect(await admissionStep('ai_controls_unavailable',()=>{throw raw;}).catch((error:unknown)=>error)).toBe(raw);
    const labelled=new AiAdmissionRefusal('spend_root_required');
    expect(await admissionStep('ai_controls_unavailable',()=>{throw labelled;}).catch((error:unknown)=>error)).toBe(labelled);
    expect(new AiAdmissionRefusal('not-a-code' as never).code).toBe('admission_unavailable');
  });
});

describe('failure classification',()=>{
  it.each([
    [new AiProviderReadinessError('consent_required'),'consent_required'],[new AiProviderReadinessError('candidate_required'),'candidate_required'],
    [new AiProviderReadinessError('receipt_required'),'receipt_required'],[new AiProviderReadinessError('unavailable'),'unavailable'],
    [new AiAllowanceError('paused'),'paused'],[new AiAllowanceError('daily_limit'),'daily_limit'],[new AiAllowanceError('monthly_limit'),'monthly_limit'],
    [new AiAllowanceError('concurrent_limit'),'concurrent_limit'],[new AiSpendControlError('AI spend ceiling breach requires review'),'spend_control'],
    [new AiPrivacyGateError('unreviewed'),'privacy_review'],[new AiPrivacyGateError('source'),'privacy_source'],
    [new AiAdmissionRefusal('spend_capability_unavailable'),'spend_capability'],[new AiAdmissionRefusal('spend_root_unavailable'),'spend_root'],
    [new AiAdmissionRefusal('provider_configuration_changed'),'configuration_changed'],[new AiAdmissionRefusal('ai_controls_unavailable'),'controls'],
    [new AiAdmissionRefusal('admission_custody'),'admission'],[new AiGatewayError(`PRIVATE ${SECRET}`),'unavailable'],
    [new AiConfigError(`PRIVATE ${SECRET}`,'secret_unavailable' as never),'secret_unavailable'],[new AiConfigError(`PRIVATE ${SECRET}`),'config_invalid'],
    [Object.assign(Error(`PRIVATE ${SECRET}`),{cause:{code:'55P03',message:`PRIVATE ${SECRET}`}}),'database'],
    [Object.assign(Error(`PRIVATE ${SECRET}`),{cause:{code:'55000',message:'AI connection check stopped'}}),'controls'],[Error(`PRIVATE ${SECRET}`),'unexpected'],
  ] as const)('%s → %s',(error,reason)=>{
    const failure=describeProviderFailure(error);
    expect(failure.reason).toBe(reason);expect(failure.probe).toBe(false);expect(JSON.stringify(failure)).not.toMatch(LEAK);
  });
  it('names the failing evaluation call, how far it got and the local refusal of that call',()=>{
    const local=describeProviderFailure(probe('draft','local',new AiAdmissionRefusal('spend_root_unavailable')));
    expect(local).toMatchObject({reason:'spend_root',probe:true,stage:'draft',origin:'local',code:'probe_failed',refusal:'spend_root_unavailable',model:'openai/gpt-6-luna'});
    expect(describeProviderFailure(probe('tool_call','provider',Error(`PRIVATE ${SECRET}`)))).toMatchObject({reason:'connection_failed',stage:'tool_call',origin:'provider',refusal:null});
    expect(describeProviderFailure(probe('tool_result','response',new AiGatewayError(`PRIVATE ${SECRET}`)))).toMatchObject({reason:'connection_failed',stage:'tool_result',origin:'response',refusal:null});
    expect(describeProviderFailure(probe('draft','local',new AiSpendControlError('Unpriced AI history requires monetary review')))).toMatchObject({reason:'spend_control',refusal:'spend_unpriced_history'});
    expect(describeProviderFailure(new AiProviderReadinessError('probe_failed',{stage:'summary',origin:'local',model:null}))).toMatchObject({probe:true,stage:'summary',origin:'local'});
    // A detail cannot smuggle an arbitrary model string or refusal text into the description.
    expect(describeProviderFailure(new AiProviderReadinessError('probe_failed',{stage:'draft',origin:'local',model:`bad model ${SECRET}`,refusal:Error(SECRET)})).model).toBeNull();
  });
  it('keeps the original refusal out of enumerable and serialized error state',()=>{
    const error=probe('draft','local',Error(`PRIVATE ${SECRET}`));
    expect(Object.keys(error)).not.toContain('detail');expect(Object.keys(error.detail!).sort()).toEqual(['model','origin','stage']);expect(JSON.stringify(error)).not.toMatch(LEAK);
    expect(JSON.stringify(error.detail)).not.toMatch(LEAK);expect(Object.keys(new ProviderProtocolFailure('draft','local',Error(SECRET)))).not.toContain('refusal');
  });
});

describe('copy and browser view',()=>{
  const t=(key:string,values?:Record<string,string>)=>values?`${key}${JSON.stringify(values)}`:key;
  it('selects fixed copy keys only, nesting the call and its local refusal',()=>{
    expect(providerFailureMessage(t,providerFailureView(describeProviderFailure(probe('draft','local',new AiAllowanceError('paused')))),'evaluationFailed'))
      .toBe('failure.probe_local{"call":"failure.call_draft","reason":"failure.paused"}');
    expect(providerFailureMessage(t,providerFailureView(describeProviderFailure(probe('tool_call','provider',Error(SECRET)))),'evaluationFailed')).toBe('failure.probe_provider{"call":"failure.call_tool_call"}');
    expect(providerFailureMessage(t,providerFailureView(describeProviderFailure(probe('draft','local',Error(SECRET)))),'evaluationFailed')).toBe('failure.probe_local{"call":"failure.call_draft","reason":"evaluationFailed"}');
    expect(providerFailureMessage(t,providerFailureView(describeProviderFailure(Error(SECRET))),'commandFailed')).toBe('commandFailed');
  });
  it('re-validates the browser view against the closed vocabulary',()=>{
    expect(readProviderFailureView({reason:'paused',probe:false,stage:null,origin:null})).toEqual({reason:'paused',probe:false,stage:null,origin:null});
    expect(readProviderFailureView({reason:SECRET,probe:false})).toBeNull();expect(readProviderFailureView('failure.paused')).toBeNull();
    expect(readProviderFailureView({reason:'paused',probe:true,stage:'x',origin:SECRET})).toEqual({reason:'paused',probe:true,stage:null,origin:null});
  });
  it('has translated copy with the same placeholders in every maintained locale',()=>{
    const keys=[...PROVIDER_FAILURE_REASONS.filter(reason=>reason!=='unexpected'),'call_draft','call_tool_call','call_tool_result','probe_local','probe_provider','probe_response','probe_summary'];
    const english=(JSON.parse(readFileSync('messages/en.json','utf8')) as {admin:{ai:{failure:Record<string,string>}}}).admin.ai.failure;
    const placeholders=(text:string)=>(text.match(/\{[a-z]+\}/g)??[]).sort();
    for(const locale of ['en','ms','ta','th','vi','zh']){
      const copy=(JSON.parse(readFileSync(`messages/${locale}.json`,'utf8')) as {admin:{ai:{failure:Record<string,string>}}}).admin.ai.failure;
      expect(Object.keys(copy).sort(),locale).toEqual([...keys].sort());
      for(const key of keys){expect(copy[key].trim().length,`${locale}.${key}`).toBeGreaterThan(5);expect(placeholders(copy[key]),`${locale}.${key}`).toEqual(placeholders(english[key]));expect(copy[key]).not.toMatch(LEAK);}
    }
    expect(AI_ADMISSION_REFUSAL_CODES.length).toBeGreaterThan(10);
  });
});

describe('provider actions report a specific reason and log one closed line',()=>{
  it('evaluation returns only the closed view and logs action/code/stage/origin/provider/model',async()=>{
    owners.evaluate.mockRejectedValueOnce(probe('draft','local',new AiAdmissionRefusal('spend_root_unavailable')));
    const result=await evaluateProviderCandidateAction({accountReview:true,consent:true,candidateId:'c',candidateVersion:'v'});
    expect(result).toEqual({ok:false,failure:{reason:'spend_root',probe:true,stage:'draft',origin:'local'}});
    expect(lines()).toEqual([{action:'evaluate',code:'probe_failed',reason:'spend_root',stage:'draft',origin:'local',refusal:'spend_root_unavailable',sqlstate:null,provider:'openrouter',model:'openai/gpt-6-luna'}]);
  });
  it('evaluation without consent names consent_required without calling the owner',async()=>{
    expect(await evaluateProviderCandidateAction({accountReview:true,consent:false,candidateId:'c',candidateVersion:'v'})).toEqual({ok:false,failure:{reason:'consent_required',probe:false,stage:null,origin:null}});
    expect(owners.evaluate).not.toHaveBeenCalled();expect(lines()).toHaveLength(1);
  });
  it('never leaks a key, SQL or arbitrary message into results, redirects or the log',async()=>{
    owners.evaluate.mockRejectedValueOnce(Object.assign(Error(`PRIVATE ${SECRET} prompt body`),{cause:{code:'P0001',message:SECRET}}));
    const evaluated=await evaluateProviderCandidateAction({accountReview:true,consent:true,candidateId:'c',candidateVersion:'v'});
    owners.metadata.mockRejectedValueOnce(new AiGatewayError(`PRIVATE ${SECRET}`));
    const tested=await testConnectionAction({provider:'openrouter',model:'openai/gpt-6-luna',apiKey:SECRET});
    owners.metadata.mockResolvedValueOnce({ok:false,error:`PRIVATE upstream ${SECRET}`});
    const returned=await testConnectionAction({provider:'openrouter',model:`PRIVATE ${SECRET}`,apiKey:SECRET});
    owners.save.mockRejectedValueOnce(new AiConfigError(`PRIVATE ${SECRET}`,'secret_unavailable' as never));
    const form=new FormData();form.set('provider','openrouter');form.set('model','openai/gpt-6-luna');form.set('apiKey',SECRET);
    await expect(saveAiProviderConfigAction(form)).rejects.toThrow('fixture redirect');
    expect(redirect).toHaveBeenLastCalledWith('/control-tower/agents/provider?error=failure.secret_unavailable');
    owners.activate.mockRejectedValueOnce(new AiConfigError(`PRIVATE ${SECRET}`,'receipt_required' as never));
    const activation=new FormData();activation.set('provider','openrouter');activation.set('evaluationReceipt',SECRET);
    await expect(setActiveProviderAction(activation)).rejects.toThrow('fixture redirect');
    expect(redirect).toHaveBeenLastCalledWith('/control-tower/agents/provider?error=failure.receipt_required');
    expect(returned).toEqual({ok:false,error:'testFail'});expect(tested).toMatchObject({ok:false,error:'testFail',failure:{reason:'unavailable'}});
    const logged=lines();
    expect(logged.map(line=>line.action)).toEqual(['evaluate','test_connection','test_connection','save','activate']);
    expect(logged[2]).toMatchObject({code:'connection_failed',model:null});
    for(const line of logged)expect(Object.keys(line).sort()).toEqual(['action','code','model','origin','provider','reason','refusal','sqlstate','stage']);
    expect(JSON.stringify([evaluated,tested,returned,logged,vi.mocked(redirect).mock.calls])).not.toMatch(LEAK);
  });
  it('a failing log sink cannot change the result',()=>{
    warn.mockImplementation(()=>{throw Error('sink');});
    expect(()=>logProviderFailure('evaluate',describeProviderFailure(Error(SECRET)))).not.toThrow();
  });
});
