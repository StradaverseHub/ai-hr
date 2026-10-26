/** @vitest-environment jsdom */
/** Authored settings interaction controls, UNRUN; no network/database/provider. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { AiConfigForm } from '../components/ai-config-form';
import type { AiConfigView } from '../core/ai-config';
import { testConnectionAction } from '../app/admin/ai/actions';
vi.mock('../app/admin/ai/actions',()=>({disableAiAction:vi.fn(),removeAiProviderConfigAction:vi.fn(),
 saveAiProviderConfigAction:vi.fn(),setActiveProviderAction:vi.fn(),testConnectionAction:vi.fn(async()=>({ok:true}))}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const config:AiConfigView={storable:true,envFallback:null,usingEnvFallback:false,providers:[{
 provider:'openrouter',label:'OpenRouter',models:[],defaultModel:'',model:'',configured:false,keyLast4:null,
 isActive:false,envKeyPresent:false,providerOptions:null}]};
const t=messages.admin.ai;
function show(){return render(<NextIntlClientProvider locale="en" messages={messages}><AiConfigForm config={config}/></NextIntlClientProvider>);}
describe('OpenRouter admin settings form',()=>{
 it('requires labeled explicit model/routes and leaves live activation unchecked',()=>{
  const view=show(),save=screen.getByRole('button',{name:t.save}) as HTMLButtonElement;
  expect(save.disabled).toBe(true);expect((screen.getByLabelText(t.makeActive) as HTMLInputElement).checked).toBe(false);
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
  expect((screen.getByLabelText(t.makeActive) as HTMLInputElement).checked).toBe(false);
 });
});
