/** @vitest-environment jsdom */
/** Presentation only; metadata fixtures are not evaluation, role or provider proof. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
import {cleanup,render as rtlRender,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
const state=vi.hoisted(()=>({locale:'en'}));const copies:Record<string,typeof en>={en,ms,zh,ta,th,vi:viCopy};
vi.mock('next-intl/server',()=>({getLocale:async()=>state.locale,getTranslations:async(namespace:string)=>(key:string,args?:Record<string,string|number>)=>{
 let value:unknown=copies[state.locale];for(const part of [...namespace.split('.'),...key.split('.')])value=(value as Record<string,unknown>)[part];
 if(typeof value!=='string')throw Error('Missing fixture translation');return value.replace(/\{(\w+)\}/g,(_whole,name:string)=>String(args?.[name]??'{'+name+'}'));
}}));
vi.mock('../app/assistant/agent-review-actions',()=>({createAgentCandidateAction:async()=>{},evaluateAgentCandidateAction:async()=>{},promoteAgentCandidateAction:async()=>{},rollbackAgentCandidateAction:async()=>{},tryAgentCandidateAction:async()=>{},
 createConversationCandidateAction:async()=>{},evaluateConversationCandidateAction:async()=>{},promoteConversationCandidateAction:async()=>{},eraseConversationMetadataAction:async()=>{}}));
import {ModuleAgentReview} from '../components/assistant/module-agent-review';
import {PROMPT_HOLDOUTS,PROMPT_HOLDOUT_REQUEST_LIMIT} from '../lib/ai/module-agent-prompt-candidate';
import {compareMeasuredQuality} from '../lib/ai/paired-evaluation';
import {MODULE_AGENT_SOURCE_DIGEST} from '../lib/ai/module-agent-source-manifest';
type View=Parameters<typeof ModuleAgentReview>[0]['view'];
function view(progress:View['candidates'][number]['progress']):View{return {sourceDigest:MODULE_AGENT_SOURCE_DIGEST,nextVersion:2,lastTrial:null,ownSignalChoices:[],ownNativeSignalChoices:[],nativeSignalChoicesTruncated:false,
 candidates:[{id:'candidate',version:1,kind:'read_plan_prompt_v1',own:false,attempts:1,progress,verifiedSignalCount:null}],promotions:[],conversationCandidates:[],conversationPromotions:[]};}
// The erase controls ask first through the shared client confirm dialog, which needs the client intl provider.
const render=(ui:ReactNode)=>rtlRender(ui,{wrapper:({children})=><NextIntlClientProvider locale={state.locale} messages={copies[state.locale]}>{children}</NextIntlClientProvider>});
beforeEach(()=>{state.locale='en';});afterEach(cleanup);
describe('human evaluation scope, consent and authenticated progress',()=>{
 it.each(['en','ms','zh','ta','th','vi'])('%s shows only its fixed trial questions and the real per-click request cap',async locale=>{
  state.locale=locale;const result=render(await ModuleAgentReview({view:view({completedCases:6,totalCases:144,state:'incomplete',retainedFailures:1,knownFailures:1,comparison:compareMeasuredQuality([],[],144)})}));
  result.container.querySelector('details')!.open=true;
  const trial=result.container.querySelector<HTMLSelectElement>('select[name="fixtureId"]')!;
  expect([...trial.options].map(option=>option.value)).toEqual(PROMPT_HOLDOUTS.filter(row=>row.locale===locale).map(row=>row.id));
  expect(trial.options).toHaveLength(24);
  const scope=copies[locale].assistant.workspace.agentReview;
  expect(result.container.textContent).toContain(scope.consent.replace('{requests}',String(PROMPT_HOLDOUT_REQUEST_LIMIT)));
  expect(result.container.textContent).toContain(scope.progress.replace('{completed}','6').replace('{total}','144').replace('{failures}','1').replace('{state}',scope.state_incomplete));
  for(const checkbox of result.container.querySelectorAll<HTMLInputElement>('input[name="consented"]'))expect(checkbox.required).toBe(true);
  expect(result.container.textContent).toContain(scope.pairedBudget.replace('{requests}','12').replace('{pairs}','6'));expect(result.container.textContent).toContain(scope.qualityPending);expect(result.container.textContent).toContain(scope.metricUnknown);expect(result.container.textContent).toContain(scope.resourceObservations);
  expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
 });
 it('offers only explicit own feedback selections and distinguishes verified zero from missing evidence',async()=>{
  const data=view(null);data.ownSignalChoices=[{id:'own-signal',outcome:'helpful',createdAt:'2026-10-26T00:00:00Z'}];data.candidates[0].verifiedSignalCount=0;
  const result=render(await ModuleAgentReview({view:data}));const selected=result.container.querySelector<HTMLInputElement>('input[name="signalId"]')!;
  expect(selected.value).toBe('own-signal');expect(selected.checked).toBe(false);expect(result.container.textContent).toContain(en.assistant.workspace.agentReview.signalsConsent);
  expect(result.container.textContent).toContain(en.assistant.workspace.agentReview.signalsCount.replace('{count}','0'));
 });
 it('keeps absent authenticated evidence unknown rather than displaying zero completed or failed cases',async()=>{
  const result=render(await ModuleAgentReview({view:view(null)}));expect(result.container.textContent).toContain(en.assistant.workspace.agentReview.progressUnknown);
  expect(result.container.textContent).not.toContain('0/144');
 });
 it('shows equal perfect arms as no gain and does not replace unknown cost with zero',async()=>{
  const measured=Array.from({length:144},(_,index)=>({id:String(index),passed:true,securityFailure:false,elapsedMs:1,readCount:0,tokens:0,costCredits:null}));
  const data=view({completedCases:144,totalCases:144,state:'complete',retainedFailures:0,knownFailures:0,comparison:compareMeasuredQuality(measured,measured,144)});
  const result=render(await ModuleAgentReview({view:data}));expect(result.container.textContent).toContain(en.assistant.workspace.agentReview.qualityNoGain);expect(result.container.textContent).not.toContain(en.assistant.workspace.agentReview.qualityGain);expect(result.container.textContent).toContain(en.assistant.workspace.agentReview.metricUnknown);
 });

});

it.each(['en','ms','zh','ta','th','vi'])('%s names nonempty native signals without passing native values into candidate forms',async locale=>{
 state.locale=locale;const data=view(null);data.ownNativeSignalChoices=[{associationId:'20000000-0000-4000-8000-000000000001',module:'employees',action:'employees.bank.maintain',semantics:'bank_destination_saved_not_payment_processed_or_statutory_changed',createdAt:'2026-01-01T00:00:00Z'},{associationId:'20000000-0000-4000-8000-000000000002',module:'payroll',action:'payroll.close',semantics:'batch_close_recorded_not_payment',createdAt:'2026-01-01T00:00:00Z'}];
 const {container}=render(await ModuleAgentReview({view:data}));const pickers=container.querySelectorAll<HTMLSelectElement>('select[name="nativeSignalId"]');expect(pickers).toHaveLength(2);
 const copy=copies[locale].assistant.workspace;
 for(const picker of pickers){expect([...picker.options].map(option=>option.value)).toEqual(['',...data.ownNativeSignalChoices.map(row=>row.associationId)]);expect(picker.textContent).toContain(copy.nativeOutcomes.action_employees_bank_maintain);expect(picker.textContent).toContain(copy.nativeOutcomes.action_payroll_close);expect(picker.value).toBe('');}
 expect(container.querySelector('[name="bankAccountNo"],[name="personId"],[name="eventId"],[name="salary"]')).toBeNull();expect(container.textContent).not.toMatch(/action_employees_bank_maintain|action_payroll_close/);
});
