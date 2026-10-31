/** @vitest-environment jsdom */
/** The owner's own "erase my…" controls on /assistant: each asks first, and the post-redirect page says
 * whether it worked. Owners and the session are stubbed; erasure itself is proved by each owner's suite. */
import type {ReactNode} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
const state=vi.hoisted(()=>({locale:'en'}));
const owner=vi.hoisted(()=>({session:vi.fn(),proposals:vi.fn(),ratings:vi.fn(),feedback:vi.fn(),conversation:vi.fn()}));
const copies:Record<string,unknown>={en,ms,zh,ta,th,vi:viMessages};
vi.mock('next-intl/server',()=>({getLocale:async()=>state.locale,getTranslations:async(namespace:string)=>(key:string)=>{
 let value:unknown=copies[state.locale];for(const name of [...namespace.split('.'),...key.split('.')])value=(value as Record<string,unknown>)[name];
 if(typeof value!=='string')throw Error('Missing test translation '+namespace+'.'+key);return value;
}}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(location:string)=>{throw Object.assign(Error('fixture navigation'),{location});}}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:owner.session}));
vi.mock('../core/module-agent-feedback',()=>({recordOwnAgentFeedback:vi.fn(),eraseOwnAgentFeedback:owner.feedback,AGENT_FEEDBACK_OUTCOMES:['helpful','needs_correction','incorrect']}));
vi.mock('../core/module-agent-releases',()=>({eraseOwnModulePlanProposals:owner.proposals,eraseOwnGovernedJobFeedback:owner.ratings,eraseOwnConversationStrategyMetadata:owner.conversation,
 GOVERNED_JOB_FEEDBACK_OUTCOMES:['helpful','needs_correction','incorrect'],proposeOwnModuleReadPlan:vi.fn(),evaluateHumanQuestionPlannerCandidate:vi.fn(),recordOwnGovernedJobFeedback:vi.fn(),
 createPromptAgentCandidate:vi.fn(),evaluatePromptAgentCandidate:vi.fn(),promotePromptAgentCandidate:vi.fn(),rollbackAssistantPromotion:vi.fn(),runPromptPlannedSyntheticJob:vi.fn(),
 createConversationAgentCandidate:vi.fn(),evaluateConversationAgentCandidate:vi.fn(),promoteConversationAgentCandidate:vi.fn()}));
import {eraseModuleProposalsAction} from '../app/(app)/assistant/module-plan-actions';
import {eraseGovernedJobFeedbackAction} from '../app/(app)/assistant/job-feedback-actions';
import {eraseAgentFeedbackAction} from '../app/(app)/assistant/feedback-actions';
import {eraseConversationMetadataAction} from '../app/(app)/assistant/agent-review-actions';
import {OwnClearForm,OwnClearStatus} from '../components/assistant/own-clear';
const locales=['en','ms','zh','ta','th','vi'] as const;
const clear=(locale:string)=>(copies[locale] as typeof en).assistant.workspace.ownClear;
const ctx={tenantId:'fixture-tenant',userId:'fixture-user'};
async function location(invoke:()=>Promise<unknown>){try{await invoke();throw Error('Expected navigation');}catch(error){const value=(error as {location?:unknown}).location;if(typeof value!=='string')throw error;return value;}}
const cases=[['proposals',eraseModuleProposalsAction,owner.proposals],['ratings',eraseGovernedJobFeedbackAction,owner.ratings],['feedback',eraseAgentFeedbackAction,owner.feedback],['conversation',eraseConversationMetadataAction,owner.conversation]] as const;
beforeEach(()=>{for(const mock of Object.values(owner))mock.mockReset();owner.session.mockResolvedValue(ctx);});
afterEach(()=>{cleanup();vi.restoreAllMocks();state.locale='en';});

describe('own-clear actions report their outcome',()=>{
 it.each(cases)('%s says it worked only after its owner erased for the current login',async(kind,action,erase)=>{
  expect(await location(action)).toBe('/assistant?ownClear='+kind);expect(erase).toHaveBeenCalledExactlyOnceWith(ctx);
 });
 it.each(cases)('%s reports a bounded failure without claiming erasure or echoing private detail',async(_kind,action,erase)=>{
  erase.mockRejectedValueOnce(Error('PRIVATE_SQL'));expect(await location(action)).toBe('/assistant?ownClear=unavailable');
  owner.session.mockRejectedValueOnce(Error('PRIVATE_SESSION'));expect(await location(action)).toBe('/assistant?ownClear=unavailable');expect(erase).toHaveBeenCalledTimes(1);
 });
});

describe('own-clear controls ask first',()=>{
 const wrap=(ui:ReactNode)=>render(<NextIntlClientProvider locale={state.locale} messages={copies[state.locale] as typeof en}>{ui}</NextIntlClientProvider>);
 it.each(['proposals','ratings','feedback','conversation','importHistory','outcomes'] as const)('%s does not submit on the first click; Keep cancels; only the confirmation submits',async kind=>{
  const submit=vi.spyOn(HTMLFormElement.prototype,'requestSubmit').mockImplementation(()=>undefined);const user=userEvent.setup(),copy=clear('en');
  const view=wrap(<OwnClearForm kind={kind} action={async()=>{}} label="Erase mine"/>);const form=view.container.querySelector('form')!;
  expect([...new FormData(form).keys()]).toEqual([]);
  await user.click(screen.getByRole('button',{name:'Erase mine'}));const dialog=await screen.findByRole('alertdialog');
  expect(within(dialog).getByText(copy[kind].title)).toBeInTheDocument();expect(within(dialog).getByText(copy[kind].body)).toBeInTheDocument();expect(submit).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button',{name:copy.keep}));expect(screen.queryByRole('alertdialog')).toBeNull();expect(submit).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Erase mine'}));
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button',{name:copy[kind].confirm}));
  expect(submit).toHaveBeenCalledTimes(1);expect(submit.mock.contexts[0]).toBe(form);
 });
});

describe('own-clear outcome is visible after the redirect',()=>{
 it.each(locales)('%s shows each outcome as its own status and a failure as an alert',async locale=>{
  state.locale=locale;const copy=clear(locale);
  for(const kind of ['proposals','ratings','feedback','conversation'] as const){const view=render(<>{await OwnClearStatus({status:kind})}</>);expect(screen.getByRole('status')).toHaveTextContent(copy[kind].done);expect(screen.queryByRole('alert')).toBeNull();view.unmount();}
  const failed=render(<>{await OwnClearStatus({status:'unavailable'})}</>);expect(screen.getByRole('alert')).toHaveTextContent(copy.unavailable);failed.unmount();
 });
 it('renders nothing on an ordinary visit or an edited query value',async()=>{
  for(const status of [undefined,'importHistory','outcomes','erased','<script>']){const view=render(<>{await OwnClearStatus({status})}</>);expect(view.container.textContent).toBe('');view.unmount();}
 });
});
