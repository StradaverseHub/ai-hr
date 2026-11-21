import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import {FormulaGenerator} from '../app/payroll/formula-builder/formula-generator';
import type {PayFormulaDraftJobView} from '../lib/pay-formula-draft-job';
const state=vi.hoisted(()=>({start:vi.fn(),read:vi.fn(),discard:vi.fn()}));
vi.mock('../app/payroll/formula-builder/actions',()=>({startFormulaDraftAction:state.start,readFormulaDraftAction:state.read,discardFormulaDraftAction:state.discard}));
const t=en.payFormula.generator;
const draft={source:'Return {#Basic}',explanation:'Review this proposed draft',questions:[],unsupported:[],variables:['Basic'],conditions:[],valid:true};
const job=(over:Partial<PayFormulaDraftJobView>={}):PayFormulaDraftJobView=>({id:'job-1',state:'running',reason:null,timeoutSeconds:90,startedAt:'2026-11-12T00:00:00.000Z',result:null,...over});
const done=(result:unknown=draft)=>({ok:true,value:job({state:'succeeded',result:result as PayFormulaDraftJobView['result']})});
const started={ok:true,value:{outcome:'started',job:job()}};
const mount=(source='Return 100',disabled=false)=>{const apply=vi.fn();render(<NextIntlClientProvider locale="en" messages={en}><FormulaGenerator source={source} disabled={disabled} apply={apply} pollMs={5}/></NextIntlClientProvider>);return apply;};
const request=(text='Use basic pay')=>{fireEvent.change(screen.getByRole('textbox',{name:t.requirement}),{target:{value:text}});fireEvent.click(screen.getByRole('checkbox',{name:t.consent}));fireEvent.click(screen.getByRole('button',{name:t.generate}));};
afterEach(cleanup);
beforeEach(()=>{vi.clearAllMocks();state.read.mockResolvedValue({ok:true,value:null});state.start.mockResolvedValue(started);state.discard.mockResolvedValue({ok:true,value:null});});
describe('formula generation runs in the background and remains an explicit unsaved draft',()=>{
 it('shows Generating… while the background draft runs, then the draft, and confirms replacement',async()=>{
  const apply=mount();await waitFor(()=>expect(state.read).toHaveBeenCalledTimes(1));
  let finish!:()=>void;state.read.mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve(done());}));
  expect(screen.getByRole('button',{name:t.generate})).toBeDisabled();request();
  expect(await screen.findByRole('button',{name:t.working})).toBeDisabled();expect(state.start).toHaveBeenCalledWith({requirement:'Use basic pay',disclosureAccepted:true});
  await waitFor(()=>expect(state.read).toHaveBeenCalledTimes(2));finish();
  await screen.findByText(draft.explanation);expect(screen.getByRole('button',{name:t.regenerate})).toBeVisible();expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:t.apply}));expect(screen.getByRole('alertdialog',{name:t.replaceTitle})).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:t.cancel}));expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:t.apply}));fireEvent.click(screen.getByRole('button',{name:t.replace}));expect(apply).toHaveBeenCalledExactlyOnceWith('Return {#Basic}');
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en','formula-generator','Real generator with synthetic background reply; no authenticated journey or live provider acceptance','atelier');
 },120000);
 it('keeps polling while the generation runs and stops once it ends',async()=>{
  state.read.mockResolvedValueOnce({ok:true,value:null}).mockResolvedValueOnce({ok:true,value:job()}).mockResolvedValueOnce({ok:true,value:job()}).mockResolvedValue(done());
  mount();request();await screen.findByText(draft.explanation);const calls=state.read.mock.calls.length;
  expect(calls).toBe(4);await new Promise(resolve=>setTimeout(resolve,50));expect(state.read).toHaveBeenCalledTimes(calls);
 });
 it('resumes a pending draft after a reload without a new request',async()=>{
  state.read.mockResolvedValueOnce({ok:true,value:job()}).mockResolvedValue(done());
  mount();expect(await screen.findByRole('button',{name:t.working})).toBeDisabled();
  await screen.findByText(draft.explanation);expect(state.start).not.toHaveBeenCalled();
 });
 it.each([
  ['timeout',t.reasons.timeout.replace('{seconds}','90')],
  ['provider_unavailable',t.reasons.provider_unavailable],
  ['invalid_draft',t.reasons.invalid_draft],
  ['paused',t.reasons.paused],
  ['interrupted',t.reasons.interrupted],
  ['review_required',t.reviewRequired],
  ['unavailable',t.unavailable],
  ['failed',t.failed],
 ] as const)('shows the specific reason %s',async(reason,text)=>{
  state.read.mockResolvedValueOnce({ok:true,value:null}).mockResolvedValue({ok:true,value:job({state:'failed',reason})});
  mount();request();expect(await screen.findByRole('alert')).toHaveTextContent(text);
  expect(screen.getByRole('button',{name:t.generate})).toBeEnabled();expect(screen.queryByRole('status')).toBeNull();
 });
 it('explains that a different request is still running',async()=>{
  state.start.mockResolvedValue({ok:true,value:{outcome:'busy',job:job()}});mount();request('Another calculation');
  expect(await screen.findByRole('alert')).toHaveTextContent(t.busy.replace('{seconds}','90'));
 });
 it('discards a stale reply after editing the requirement',async()=>{
  let finish!:()=>void;state.read.mockResolvedValueOnce({ok:true,value:null}).mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve(done());}));
  mount();request();await waitFor(()=>expect(state.read).toHaveBeenCalledTimes(2));
  fireEvent.change(screen.getByRole('textbox',{name:t.requirement}),{target:{value:'A changed request'}});finish();
  await new Promise(resolve=>setTimeout(resolve,30));expect(screen.queryByText(draft.explanation)).toBeNull();expect(screen.queryByRole('button',{name:t.apply})).toBeNull();
 });
 it('renders clarifying questions without an applicable source and Clear discards the stored draft',async()=>{
  state.read.mockResolvedValueOnce({ok:true,value:null}).mockResolvedValue(done({...draft,valid:false,source:null,variables:[],questions:['Which field value?']}));mount();request();
  await screen.findByText('Which field value?');expect(screen.getByRole('button',{name:t.apply})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:t.clear}));expect(screen.getByRole('textbox',{name:t.requirement})).toHaveValue('');expect(screen.getByRole('checkbox')).not.toBeChecked();
  await waitFor(()=>expect(state.discard).toHaveBeenCalledOnce());expect(screen.queryByText('Which field value?')).toBeNull();
 });
 it('shows only a generic failure when the request itself fails',async()=>{
  state.start.mockRejectedValueOnce(new Error('PRIVATE provider payload'));mount();request();
  expect(await screen.findByRole('alert')).toHaveTextContent(t.failed);expect(screen.queryByText(/PRIVATE/)).toBeNull();
 });
 it('inserts an explicitly unfinished suggestion without claiming it is valid or saving it',async()=>{
  const source='If {#MISSING:Company} = "EBAC" Then\nReturn {#Basic}\nElse\nReturn 0\nEnd If';
  state.read.mockResolvedValueOnce({ok:true,value:null}).mockResolvedValue(done({...draft,source,valid:false,unresolved:true,assumptions:['Basic means recorded basic salary.'],questions:['Resolve Company before validation.']}));
  const apply=mount('');request();await screen.findByText('Resolve Company before validation.');
  for(const label of [t.issue,t.suggestedFormula,t.assumptions,t.nextStep])expect(screen.getByRole('heading',{name:label})).toBeVisible();
  expect(screen.getByText(t.needsClarification)).toBeVisible();fireEvent.click(screen.getByRole('button',{name:t.apply}));expect(apply).toHaveBeenCalledExactlyOnceWith(source);
 });
 it('prevents unauthorized interaction and reads nothing',()=>{mount('',true);expect(screen.getByRole('textbox')).toBeDisabled();expect(screen.getByRole('checkbox')).toBeDisabled();expect(state.read).not.toHaveBeenCalled();});
});
