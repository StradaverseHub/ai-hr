/** Authored UNRUN. Actual selected-cookie session resolver; provider/configuration owners are spies.
 * Demonstrates that DEV_USER_ID convenience fallback cannot authorize browser mutations or probes.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined}));
const owners=vi.hoisted(()=>({save:vi.fn(),activate:vi.fn(),disable:vi.fn(),remove:vi.fn(),metadata:vi.fn(),evaluate:vi.fn(),assessment:vi.fn(),discard:vi.fn(),run:vi.fn(),accept:vi.fn()}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:vi.fn(()=>{throw Error('fixture redirect');})}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>key)}));
vi.mock('../core/ai-config',()=>({AiConfigError:class extends Error{},saveAiProviderConfig:owners.save,setActiveProvider:owners.activate,disableAi:owners.disable,removeAiProviderConfig:owners.remove,testConnection:owners.metadata,discardPendingAiProviderChange:owners.discard}));
vi.mock('../core/ai-provider-baseline',()=>({runProviderBaseline:owners.run,acceptProviderBaselineFailure:owners.accept}));
vi.mock('../core/ai-provider-readiness',()=>({evaluateProviderCandidate:owners.evaluate}));
vi.mock('../packs/performance/service',()=>({ASSESSMENT_AI_FEATURES:['review_summary'],setAssessmentAiSwitch:owners.assessment}));
import {redirect} from 'next/navigation';
import {AiConfigError} from '../core/ai-config';
import { getSession } from '../lib/session';
import { acceptProviderBaselineAction, disableAiAction, discardPendingProviderChangeAction, evaluateProviderCandidateAction, removeAiProviderConfigAction, runProviderBaselineAction, saveAiProviderConfigAction, setActiveProviderAction, testConnectionAction } from '../app/admin/ai/actions';
import { closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
let base:Base;
const candidateId='11111111-1111-4111-8111-111111111111',candidateVersion='22222222-2222-4222-8222-222222222222';
const command={accountReview:true,consent:true,candidateId,candidateVersion};
beforeAll(migrateTestDb);
beforeEach(async()=>{
  vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NODE_ENV','test');vi.stubEnv('ALLOW_DEMO_SESSION','false');
  await resetDb();base=await seedBase();vi.stubEnv('DEV_USER_ID',base.adminUserId);browser.selected=undefined;
  for(const spy of Object.values(owners))spy.mockReset();
  owners.metadata.mockResolvedValue({ok:true});
  owners.evaluate.mockResolvedValue({receipt:'opaque-fixture-receipt',candidateId,candidateVersion,expiresAt:new Date(Date.now()+60000).toISOString()});
});
afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
const form=()=>{const value=new FormData();value.set('provider','openrouter');value.set('model','fictional/model');value.set('feature','review_summary');value.set('on','true');value.set('kind','environment');value.set('consent','true');value.set('runId',candidateId);value.set('reason','Fictional accepted reason for the fixture.');return value;};
describe('provider browser selected-session boundary',()=>{
  it.each(['absent','unknown'] as const)('refuses %s cookie on every mutation and RPC before calling an owner',async mode=>{
    if(mode==='absent')expect((await getSession()).userId).toBe(base.adminUserId);
    else browser.selected=randomUUID();
    for(const invoke of [()=>saveAiProviderConfigAction(form()),()=>setActiveProviderAction(form()),()=>removeAiProviderConfigAction(form()),()=>disableAiAction(),
      ()=>discardPendingProviderChangeAction(form()),()=>runProviderBaselineAction(form()),()=>acceptProviderBaselineAction(form())]) {
      await expect(invoke()).rejects.toThrow();
    }
    expect(await testConnectionAction({provider:'openrouter',model:'fictional/model'})).toEqual({ok:false,error:'testFail'});
    expect(await evaluateProviderCandidateAction(command)).toEqual({ok:false});
    for(const spy of Object.values(owners))expect(spy).not.toHaveBeenCalled();
  });
  it('passes the actual explicitly selected actor and exact candidate consent to the source owner',async()=>{
    browser.selected=base.adminUserId;
    const result=await evaluateProviderCandidateAction(command);
    expect(result).toMatchObject({ok:true,candidateId,candidateVersion});
    expect(owners.evaluate).toHaveBeenCalledTimes(1);
    expect(owners.evaluate.mock.calls[0][0]).toMatchObject({tenantId:base.tenantId,userId:base.adminUserId});
    expect(owners.evaluate.mock.calls[0][1]).toEqual({provider:'openrouter',candidateId,candidateVersion,review:{version:1,accountDefaultsReviewed:true,externalProcessingReviewed:true},syntheticProbeConsent:true});
  });
});

/** Authored UNRUN: typed error constructors never authorize arbitrary browser disclosure. */
describe('provider commands keep bounded localized failure boundaries',()=>{
 it('maps absent strict sessions to a friendly settings redirect without calling any owner',async()=>{browser.selected=undefined;vi.mocked(redirect).mockClear();await expect(saveAiProviderConfigAction(form())).rejects.toThrow('fixture redirect');expect(redirect).toHaveBeenLastCalledWith('/control-tower/agents/provider?error=commandFailed');expect(owners.save).not.toHaveBeenCalled();});
 it.each(['typed','raw'] as const)('never exposes %s owner error messages, API-key text or causes in redirects',async kind=>{browser.selected=base.adminUserId;owners.save.mockRejectedValueOnce(kind==='typed'?new AiConfigError('PRIVATE provider-key SECRET'):Error('PRIVATE SQL credential'));await expect(saveAiProviderConfigAction(form())).rejects.toThrow('fixture redirect');expect(redirect).toHaveBeenLastCalledWith('/control-tower/agents/provider?error=commandFailed');expect(JSON.stringify(vi.mocked(redirect).mock.calls)).not.toContain('PRIVATE');});
 it('never forwards a returned metadata reason or exception message to the RPC browser result',async()=>{browser.selected=base.adminUserId;owners.metadata.mockResolvedValueOnce({ok:false,error:'PRIVATE provider response'});expect(await testConnectionAction({provider:'openrouter',model:'fictional/model'})).toEqual({ok:false,error:'testFail'});owners.metadata.mockRejectedValueOnce(Error('PRIVATE network'));expect(await testConnectionAction({provider:'openrouter',model:'fictional/model'})).toEqual({ok:false,error:'testFail'});});
});
