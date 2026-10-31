/** @vitest-environment jsdom */
/** In-app walkthrough defects on /assistant: planner first render, chat-text clearing confirmation and its
 * visible outcome. Presentation only; the server actions are stubbed and proved elsewhere. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
const state=vi.hoisted(()=>({locale:'en'}));
const copies:Record<string,unknown>={en,ms,zh,ta,th,vi:viMessages};
vi.mock('next-intl/server',()=>({getLocale:async()=>state.locale,getTranslations:async(namespace:string)=>(key:string,params?:Record<string,string|number>)=>{
 let value:unknown=copies[state.locale];for(const name of [...namespace.split('.'),...key.split('.')])value=(value as Record<string,unknown>)[name];
 if(typeof value!=='string')throw Error('Missing test translation '+namespace+'.'+key);
 return value.replace(/\{(\w+)\}/g,(_whole,field:string)=>String(params?.[field]??'{'+field+'}'));
}}));
vi.mock('../app/(app)/assistant/history-privacy-actions',()=>({eraseAssistantHistoryAction:vi.fn()}));
vi.mock('../app/(app)/assistant/module-plan-actions',()=>({proposeModulePlanAction:vi.fn(),eraseModuleProposalsAction:vi.fn(),evaluateHumanPlannerAction:vi.fn()}));
vi.mock('../app/(app)/assistant/governed-job-actions',()=>({runGovernedPlanAction:vi.fn()}));
import {ModuleQuestionPlanner} from '../components/assistant/module-plan';
import {AssistantHistoryPrivacy} from '../components/assistant/history-privacy';
afterEach(()=>{cleanup();vi.restoreAllMocks();state.locale='en';});
const locales=['en','ms','zh','ta','th','vi'] as const;
const planning=(locale:string)=>(copies[locale] as typeof en).assistant.workspace.planning;
const privacy=(locale:string)=>(copies[locale] as typeof en).assistant.workspace.historyPrivacy;
// The planner's own-clear control uses the client confirm dialog, which needs the client intl provider.
const plan=(ui:ReactNode)=>render(<NextIntlClientProvider locale={state.locale} messages={copies[state.locale] as typeof en}>{ui}</NextIntlClientProvider>);

describe('Suggest my next tasks: nothing asked means nothing failed',()=>{
 it.each(locales)('%s shows a calm setup note, not a snag, when no provider is configured',async locale=>{
  state.locale=locale;const copy=planning(locale);
  plan(await ModuleQuestionPlanner({view:null,permit:null,availability:'no_provider'}));
  expect(screen.getByRole('status')).toHaveTextContent(copy.noProvider);
  expect(screen.queryByText(copy.unavailable)).toBeNull();expect(screen.queryByRole('alert')).toBeNull();
  expect(document.querySelector('textarea[name="question"]')).toBeNull();
 });
 it.each(locales)('%s says the planner is resting, not broken, when no permit could be issued',async locale=>{
  state.locale=locale;const copy=planning(locale);
  plan(await ModuleQuestionPlanner({view:null,permit:null,availability:'resting'}));
  expect(screen.getByRole('status')).toHaveTextContent(copy.resting);expect(screen.queryByText(copy.unavailable)).toBeNull();
 });
 it('renders the question form and no status line on a ready first load',async()=>{
  plan(await ModuleQuestionPlanner({view:null,permit:'sealed-permit',availability:'ready'}));
  expect(document.querySelector('textarea[name="question"]')).not.toBeNull();expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByText(en.assistant.workspace.planning.unavailable)).toBeNull();
 });
 it('still reports a snag after a submitted request actually failed',async()=>{
  plan(await ModuleQuestionPlanner({view:null,permit:'sealed-permit',availability:'ready',status:'unavailable'}));
  expect(screen.getByText(en.assistant.workspace.planning.unavailable)).toBeInTheDocument();
 });
});

describe('Clear my chat text asks first and then says it worked',()=>{
 const wrap=async(status?:string,locale='en')=>{state.locale=locale;return render(<NextIntlClientProvider locale={locale} messages={copies[locale] as typeof en}>{await AssistantHistoryPrivacy({status})}</NextIntlClientProvider>);};
 it('does not submit on the first click; Keep cancels; only the explicit confirmation submits',async()=>{
  const submit=vi.spyOn(HTMLFormElement.prototype,'requestSubmit').mockImplementation(()=>undefined);const user=userEvent.setup();
  const view=await wrap();const copy=privacy('en');
  await user.click(screen.getByText(copy.title));
  await user.click(screen.getByRole('button',{name:copy.clear}));
  const dialog=await screen.findByRole('alertdialog');expect(within(dialog).getByText(copy.confirmTitle)).toBeInTheDocument();expect(within(dialog).getByText(copy.confirmBody)).toBeInTheDocument();
  expect(submit).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button',{name:copy.keep}));expect(screen.queryByRole('alertdialog')).toBeNull();expect(submit).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:copy.clear}));
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button',{name:copy.confirmClear}));
  expect(submit).toHaveBeenCalledTimes(1);expect(submit.mock.contexts[0]).toBe(view.container.querySelector('form'));
 });
 it.each(locales)('%s shows the cleared outcome as a visible status outside the collapsed panel',async locale=>{
  await wrap('retired',locale);const copy=privacy(locale);
  const status=screen.getByRole('status');expect(status).toHaveTextContent(copy.retired);expect(status.closest('details')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
 });
 it('shows a failed clear outside the panel too, and nothing on an ordinary visit',async()=>{
  const failed=await wrap('unavailable');expect(screen.getByRole('alert')).toHaveTextContent(privacy('en').unavailable);expect(screen.getByRole('alert').closest('details')).toBeNull();failed.unmount();
  await wrap();expect(screen.queryByRole('status')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();
 });
});
