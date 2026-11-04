import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import {FormulaGenerator} from '../app/payroll/formula-builder/formula-generator';
const state=vi.hoisted(()=>({draft:vi.fn()}));
vi.mock('../app/payroll/formula-builder/actions',()=>({draftFormulaAction:state.draft}));
const t=en.payFormula.generator;
const result={ok:true,value:{source:'Return {#Basic}',explanation:'Review this proposed draft',questions:[],unsupported:[],variables:['Basic'],conditions:[],valid:true}};
const mount=(source='Return 100',disabled=false)=>{const apply=vi.fn();render(<NextIntlClientProvider locale="en" messages={en}><FormulaGenerator source={source} disabled={disabled} apply={apply}/></NextIntlClientProvider>);return apply;};
const request=()=>{fireEvent.change(screen.getByRole('textbox',{name:t.requirement}),{target:{value:'Use basic pay'}});fireEvent.click(screen.getByRole('checkbox',{name:t.consent}));fireEvent.click(screen.getByRole('button',{name:t.generate}));};
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();state.draft.mockResolvedValue(result);});
describe('formula generation remains an explicit unsaved draft',()=>{
 it('requires disclosure and confirms replacement before changing existing source',async()=>{
  const apply=mount();expect(screen.getByRole('button',{name:t.generate})).toBeDisabled();request();
  await screen.findByText(result.value.explanation);expect(state.draft).toHaveBeenCalledWith({requirement:'Use basic pay',disclosureAccepted:true});expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:t.apply}));expect(screen.getByRole('alertdialog',{name:t.replaceTitle})).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:t.cancel}));expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:t.apply}));fireEvent.click(screen.getByRole('button',{name:t.replace}));expect(apply).toHaveBeenCalledExactlyOnceWith('Return {#Basic}');
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en','formula-generator','Real generator with synthetic provider reply; no authenticated journey or live provider acceptance','atelier');
 },120000);
 it('discards a stale response after editing the requirement',async()=>{
  let resolve!:(value:typeof result)=>void;state.draft.mockImplementation(()=>new Promise(r=>{resolve=r;}));mount();request();
  fireEvent.change(screen.getByRole('textbox',{name:t.requirement}),{target:{value:'A changed request'}});resolve(result);
  await waitFor(()=>expect(screen.queryByText(result.value.explanation)).toBeNull());expect(screen.queryByRole('button',{name:t.apply})).toBeNull();
 });
 it('renders clarifying questions without an applicable source and clears local state',async()=>{
  state.draft.mockResolvedValue({ok:true,value:{...result.value,valid:false,source:null,variables:[],questions:['Which field value?']}});mount();request();
  await screen.findByText('Which field value?');expect(screen.getByRole('button',{name:t.apply})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:t.clear}));expect(screen.getByRole('textbox',{name:t.requirement})).toHaveValue('');expect(screen.getByRole('checkbox')).not.toBeChecked();
 });
 it('discards a response after Clear and shows only a generic transport failure',async()=>{
  let resolve!:(value:typeof result)=>void;state.draft.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));mount();request();fireEvent.click(screen.getByRole('button',{name:t.clear}));resolve(result);
  await waitFor(()=>expect(screen.queryByText(result.value.explanation)).toBeNull());state.draft.mockRejectedValueOnce(new Error('PRIVATE provider payload'));request();
  expect(await screen.findByRole('alert')).toHaveTextContent(t.failed);expect(screen.queryByText(/PRIVATE/)).toBeNull();
 });
 it('inserts an explicitly unfinished suggestion without claiming it is valid or saving it',async()=>{
  const source='If {#MISSING:Company} = "EBAC" Then\nReturn {#Basic}\nElse\nReturn 0\nEnd If';
  state.draft.mockResolvedValue({ok:true,value:{...result.value,source,valid:false,unresolved:true,assumptions:['Basic means recorded basic salary.'],questions:['Resolve Company before validation.']}});
  const apply=mount('');request();await screen.findByText('Resolve Company before validation.');
  for(const label of [t.issue,t.suggestedFormula,t.assumptions,t.nextStep])expect(screen.getByRole('heading',{name:label})).toBeVisible();
  expect(screen.getByText(t.needsClarification)).toBeVisible();fireEvent.click(screen.getByRole('button',{name:t.apply}));expect(apply).toHaveBeenCalledExactlyOnceWith(source);
 });
 it('prevents unauthorized interaction',()=>{mount('',true);expect(screen.getByRole('textbox')).toBeDisabled();expect(screen.getByRole('checkbox')).toBeDisabled();});
});
