/** @vitest-environment jsdom */
/** Authored settings interaction controls, UNRUN; no network/database/provider. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { AiConfigForm } from '../components/ai-config-form';
import type { AiConfigView } from '../core/ai-config';
import { evaluateProviderCandidateAction, testConnectionAction, setActiveProviderAction, saveAiProviderConfigAction } from '../app/admin/ai/actions';
vi.mock('../app/admin/ai/actions',()=>({disableAiAction:vi.fn(),removeAiProviderConfigAction:vi.fn(),
 saveAiProviderConfigAction:vi.fn(),setActiveProviderAction:vi.fn(),testConnectionAction:vi.fn(async()=>({ok:true})),evaluateProviderCandidateAction:vi.fn()}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const config:AiConfigView={storable:true,envFallback:null,usingEnvFallback:false,providers:[{
 provider:'openrouter',label:'OpenRouter',models:[],defaultModel:'',model:'',configured:false,keyLast4:null,
 isActive:false,envKeyPresent:false,providerOptions:null,candidateSaved:false,candidateId:null,candidateVersion:null,activeModel:null}]};
const t=messages.admin.ai;
function show(value=config){return render(<NextIntlClientProvider locale="en" messages={messages}><AiConfigForm config={value}/></NextIntlClientProvider>);}
describe('OpenRouter admin settings form',()=>{
 it('requires labeled explicit model/routes and offers no direct activation bypass',()=>{
  const view=show(),save=screen.getByRole('button',{name:t.save}) as HTMLButtonElement;
  expect(save.disabled).toBe(true);expect(screen.queryByLabelText(t.makeActive)).toBeNull();
  fireEvent.change(screen.getByLabelText(new RegExp('^'+t.model)),{target:{value:'fictional/model'}});
  fireEvent.change(screen.getByLabelText(t.approvedProviders),{target:{value:'approved-a\napproved-b'}});
  expect(save.disabled).toBe(false);
  const hidden=view.container.querySelector('input[name="providerOptions"]') as HTMLInputElement;
  expect(JSON.parse(hidden.value)).toEqual({version:1,routing:{allowedProviders:['approved-a','approved-b'],allowFallbacks:false,sort:'latency'}});
  expect(screen.getByText(t.metadataOnly)).toBeTruthy();expect(screen.getByText(t.routingPrivacy)).toBeTruthy();
 });
 it('shows route-specific errors after blur and cannot silently broaden fallback or privacy options',()=>{
  const view=show(),field=screen.getByLabelText(t.approvedProviders);
  fireEvent.change(field,{target:{value:'approved-a\napproved-a'}});fireEvent.blur(field);
  expect(field.getAttribute('aria-invalid')).toBe('true');expect(screen.getByRole('alert').textContent).toBe(t.routingInvalid);
  expect((screen.getByRole('button',{name:t.save}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(field,{target:{value:'approved-a'}});fireEvent.click(screen.getByLabelText(t.boundedFallbacks));
  const hidden=view.container.querySelector('input[name="providerOptions"]') as HTMLInputElement;
  expect(JSON.parse(hidden.value)).toEqual({version:1,routing:{allowedProviders:['approved-a'],allowFallbacks:true,sort:'latency'}});
  expect(view.container.querySelector('[name="zdr"]')).toBeNull();expect(view.container.querySelector('[name="data_collection"]')).toBeNull();
 });
 it('sends only an explicit metadata probe after a typed key/model/route, never saves or activates on Test',async()=>{
  show();fireEvent.change(screen.getByLabelText(new RegExp('^'+t.model)),{target:{value:'fictional/model'}});
  fireEvent.change(screen.getByLabelText(t.approvedProviders),{target:{value:'approved-a'}});
  fireEvent.change(screen.getByLabelText(t.apiKey),{target:{value:'fixture-key'}});
  fireEvent.click(screen.getByRole('button',{name:t.metadataTest}));
  await waitFor(()=>expect(testConnectionAction).toHaveBeenCalledTimes(1));
  expect(testConnectionAction).toHaveBeenCalledWith({provider:'openrouter',model:'fictional/model',apiKey:'fixture-key',
   providerOptions:{version:1,routing:{allowedProviders:['approved-a'],allowFallbacks:false,sort:'latency'}}});
  expect(screen.queryByLabelText(t.makeActive)).toBeNull();
 });
});

const saved: AiConfigView = { ...config, providers: [{ ...config.providers[0], configured:true,candidateSaved:true,candidateId:'11111111-1111-4111-8111-111111111111',candidateVersion:'22222222-2222-4222-8222-222222222222',
 model:'fictional/model',keyLast4:'key4',providerOptions:{version:1,routing:{allowedProviders:['approved-a'],allowFallbacks:false,sort:'latency'}} }] };
// Translation keys come from the coordinated six-locale management change, never hardcoded output.
describe('explicit synthetic evaluation interaction',()=>{
 it('runs no evaluation automatically and requires both account review and processing consent',async()=>{
  show(saved);expect(evaluateProviderCandidateAction).not.toHaveBeenCalled();
  const run=screen.getByRole('button',{name:t.evaluationRun}) as HTMLButtonElement;
  const activate=screen.getByRole('button',{name:t.evaluationActivate}) as HTMLButtonElement;
  expect(run.disabled).toBe(true);expect(activate.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(t.evaluationAccountReview));expect(run.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(t.evaluationConsent));expect(run.disabled).toBe(false);
  vi.mocked(evaluateProviderCandidateAction).mockResolvedValueOnce({ok:true,receipt:'opaque-fixture-receipt',candidateId:saved.providers[0].candidateId!,candidateVersion:saved.providers[0].candidateVersion!,expiresAt:new Date(Date.now()+60000).toISOString()});
  fireEvent.click(run);await waitFor(()=>expect(activate.disabled).toBe(false));
  expect(evaluateProviderCandidateAction).toHaveBeenCalledWith({accountReview:true,consent:true,candidateId:saved.providers[0].candidateId,candidateVersion:saved.providers[0].candidateVersion});
  expect(setActiveProviderAction).not.toHaveBeenCalled();expect(saveAiProviderConfigAction).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toBe(t.evaluationVerified);
  fireEvent.change(screen.getByLabelText(t.approvedProviders),{target:{value:'approved-b'}});
  expect(activate.disabled).toBe(true);
 });
 it('ignores a stale in-flight result after any candidate edit',async()=>{
  const view=show(saved);let finish!:(value:{ok:true;receipt:string;expiresAt:string;candidateId:string;candidateVersion:string})=>void;
  vi.mocked(evaluateProviderCandidateAction).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  fireEvent.click(screen.getByLabelText(t.evaluationAccountReview));fireEvent.click(screen.getByLabelText(t.evaluationConsent));
  fireEvent.click(screen.getByRole('button',{name:t.evaluationRun}));
  await waitFor(()=>expect(evaluateProviderCandidateAction).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText(t.apiKey),{target:{value:'changed-fixture-key'}});
  await act(async()=>finish({ok:true,receipt:'stale-opaque-receipt',candidateId:saved.providers[0].candidateId!,candidateVersion:saved.providers[0].candidateVersion!,expiresAt:new Date(Date.now()+60000).toISOString()}));
  expect((screen.getByRole('button',{name:t.evaluationActivate}) as HTMLButtonElement).disabled).toBe(true);
  expect(view.container.querySelector('input[name="evaluationReceipt"]')?.getAttribute('value')).toBe('');
 });
});

describe('candidate result binding',()=>{
 it('does not offer activation when a returned result names a different candidate version',async()=>{
  show(saved);
  vi.mocked(evaluateProviderCandidateAction).mockResolvedValueOnce({ok:true,receipt:'wrong-candidate-receipt',candidateId:saved.providers[0].candidateId!,candidateVersion:'33333333-3333-4333-8333-333333333333',expiresAt:new Date(Date.now()+60000).toISOString()});
  fireEvent.click(screen.getByLabelText(t.evaluationAccountReview));fireEvent.click(screen.getByLabelText(t.evaluationConsent));
  fireEvent.click(screen.getByRole('button',{name:t.evaluationRun}));
  await waitFor(()=>expect(screen.getByRole('status').textContent).toBe(t.evaluationFailed));
  expect((screen.getByRole('button',{name:t.evaluationActivate}) as HTMLButtonElement).disabled).toBe(true);
  expect(setActiveProviderAction).not.toHaveBeenCalled();
 });
});
