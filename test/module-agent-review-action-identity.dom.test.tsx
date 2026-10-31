/** @vitest-environment jsdom */
/** Action-identity regression for the agent management forms. A real button click goes through native
 * form submission and React's form-action dispatch, so a comma expression, swapped import or reused
 * action reaches a DIFFERENT mock and fails here. Mocks prove which bound action a submit reaches —
 * not authorization, erasure, model quality or provider behaviour. */
import type {ReactNode} from 'react';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import en from '../messages/en.json';
const actions=vi.hoisted(()=>({createAgentCandidateAction:vi.fn(),evaluateAgentCandidateAction:vi.fn(),promoteAgentCandidateAction:vi.fn(),rollbackAgentCandidateAction:vi.fn(),tryAgentCandidateAction:vi.fn(),
 createConversationCandidateAction:vi.fn(),evaluateConversationCandidateAction:vi.fn(),promoteConversationCandidateAction:vi.fn(),eraseConversationMetadataAction:vi.fn()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async(namespace:string)=>(key:string,args:Record<string,string|number>={})=>{let value:unknown=en;for(const part of [...namespace.split('.'),...key.split('.')])value=(value as Record<string,unknown>)[part];if(typeof value!=='string')throw Error('Missing fixture translation');return value.replace(/\{(\w+)\}/g,(_all,name:string)=>String(args[name]??''));}}));
vi.mock('../app/(app)/assistant/agent-review-actions',()=>actions);
import {ModuleAgentReview} from '../components/assistant/module-agent-review';
import {PROMPT_HOLDOUTS} from '../lib/ai/module-agent-prompt-candidate';
import {MODULE_AGENT_SOURCE_DIGEST} from '../lib/ai/module-agent-source-manifest';
type View=Parameters<typeof ModuleAgentReview>[0]['view'];
type ActionName=keyof typeof actions;
/** Every management form is present, so a wrong action identity has somewhere wrong to land. */
function view():View{return{sourceDigest:MODULE_AGENT_SOURCE_DIGEST,nextVersion:3,lastTrial:null,ownSignalChoices:[],ownNativeSignalChoices:[],nativeSignalChoicesTruncated:false,
 candidates:[{id:'00000000-0000-4000-8000-000000000011',version:1,kind:'read_plan_prompt_v1',own:false,attempts:1,progress:null,verifiedSignalCount:null}],
 promotions:[{id:'00000000-0000-4000-8000-000000000012',version:1,kind:'read_plan_prompt_v1',used:0,maximum:5,expiresAt:new Date().toISOString(),retired:false}],
 conversationCandidates:[{id:'00000000-0000-4000-8000-000000000001',version:2,own:false,progress:null}],
 conversationPromotions:[{id:'00000000-0000-4000-8000-000000000002',version:2,used:0,maximum:5,expiresAt:new Date().toISOString(),retired:false}]};}
// The erase controls ask first through the shared client confirm dialog, which needs the client intl provider.
const intl=({children}:{children:ReactNode})=><NextIntlClientProvider locale="en" messages={en}>{children}</NextIntlClientProvider>;
async function mount(){const result=render(await ModuleAgentReview({view:view()}),{wrapper:intl});for(const details of result.container.querySelectorAll('details'))details.open=true;return result;}
function onlyCalled(expected:ActionName){for(const [name,action] of Object.entries(actions) as [ActionName,typeof actions[ActionName]][])if(name!==expected)expect(action,name).not.toHaveBeenCalled();}
beforeEach(()=>{vi.clearAllMocks();});afterEach(cleanup);
describe('management form action identity',()=>{
 it('the Try form submits its fixture and consent to tryAgentCandidateAction and nothing else',async()=>{
  await mount();const copy=en.assistant.workspace.agentReview,button=screen.getByRole('button',{name:copy.tryout}),form=button.closest('form')!;
  expect(form.querySelector('select[name="fixtureId"]')).not.toBeNull();
  fireEvent.click(within(form).getByRole('checkbox'));fireEvent.click(button);
  await waitFor(()=>expect(actions.tryAgentCandidateAction).toHaveBeenCalledTimes(1));onlyCalled('tryAgentCandidateAction');
  const submitted=actions.tryAgentCandidateAction.mock.calls[0][0] as FormData;expect(submitted).toBeInstanceOf(FormData);
  expect(submitted.get('fixtureId')).toBe(PROMPT_HOLDOUTS.filter(row=>row.locale==='en')[0].id);expect(submitted.get('consented')).toBe('yes');
 });
 it('the conversation erase control asks first, then submits to eraseConversationMetadataAction with no posted target and nothing else',async()=>{
  await mount();const governance=en.assistant.workspace.conversationGovernance,clear=en.assistant.workspace.ownClear,region=screen.getByRole('region',{name:governance.title}),button=within(region).getByRole('button',{name:governance.erase}),form=button.closest('form')!;
  expect([...new FormData(form).keys()]).toEqual([]);
  fireEvent.click(button);const dialog=await screen.findByRole('alertdialog');expect(within(dialog).getByText(clear.conversation.title)).toBeTruthy();for(const action of Object.values(actions))expect(action).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button',{name:clear.conversation.confirm}));
  await waitFor(()=>expect(actions.eraseConversationMetadataAction).toHaveBeenCalledTimes(1));onlyCalled('eraseConversationMetadataAction');
 });
 it('Try and erase are distinct forms, so one submission can never reach both actions',async()=>{
  await mount();const tryForm=screen.getByRole('button',{name:en.assistant.workspace.agentReview.tryout}).closest('form'),eraseForm=screen.getByRole('button',{name:en.assistant.workspace.conversationGovernance.erase}).closest('form');
  expect(tryForm).not.toBeNull();expect(eraseForm).not.toBeNull();expect(tryForm).not.toBe(eraseForm);expect(tryForm!.contains(eraseForm)).toBe(false);expect(eraseForm!.contains(tryForm)).toBe(false);
 });
});
