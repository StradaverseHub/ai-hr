import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import vietnamese from '../messages/vi.json';
import {FormulaEditor} from '../app/payroll/formula-builder/editor';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import {PAY_FORMULA_TEMPLATE_KEYS,payFormulaTemplateSource} from '../lib/pay-formula-templates';
import {runPayFormulaSample} from '../lib/pay-formula-sample';
import {parsePayFormula,printPayFormula} from '../lib/pay-formula-language';
import type {FormulaBuilderOptions} from '../app/payroll/formula-builder/ui-types';
const visualFixture='Actual FormulaEditor help, explanation, checks and sample-test components; fictional sample values; inert browser rendering; no authenticated server journey or installed acceptance claimed.';
const state=vi.hoisted(()=>({save:vi.fn(),test:vi.fn(),sample:vi.fn(),activate:vi.fn(),remove:vi.fn(),group:vi.fn(),search:vi.fn(),batches:vi.fn(),push:vi.fn(),refresh:vi.fn(),replace:vi.fn()}));
vi.mock('../app/payroll/formula-builder/actions',()=>({saveFormulaAction:state.save,testFormulaAction:state.test,sampleFormulaAction:state.sample,formulaStateAction:state.activate,deleteFormulaAction:state.remove,saveAccumulationAction:state.group,searchFormulaEmployeesAction:state.search,listFormulaBatchesAction:state.batches}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:state.push,refresh:state.refresh,replace:state.replace})}));
const catalogues={en,ms,zh,ta,th,vi:vietnamese};
const words=en.payFormula;
const capabilities={view:true,edit:true,test:true,activate:true,deactivate:false,delete:true};
const options:FormulaBuilderOptions={companies:[{id:'company',name:'Fictional Company'}],employees:[{id:'employee',companyId:'company',code:'E1',name:'Fictional Employee'}],cycles:[{id:'cycle',companyId:'company',code:'MONTHLY',label:'Monthly'}],payItems:[{code:'OT',name:'Overtime'}],activeFormulas:[],accumulations:[],capabilities};
const mount=(template?:typeof PAY_FORMULA_TEMPLATE_KEYS[number],locale:keyof typeof catalogues='en')=>render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}><FormulaEditor key={template??'blank'} initial={null} options={options} template={template}/></NextIntlClientProvider>);
const source=()=>screen.getByRole('textbox',{name:words.source}) as HTMLTextAreaElement;
beforeEach(()=>{vi.clearAllMocks();state.save.mockResolvedValue({ok:false,error:'Fictional save refusal'});state.sample.mockImplementation(async(input:{source:string;values:Record<string,string>})=>({ok:true,value:runPayFormulaSample(input.source,input.values)}));});
afterEach(cleanup);

describe('Formula Help & Examples',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s shows translated help tabs and all five examples on a new draft',locale=>{
  mount(undefined,locale);const t=catalogues[locale].payFormula;
  expect(screen.getByRole('tab',{name:t.help.tabs.examples})).toHaveAttribute('aria-selected','true');
  for(const key of PAY_FORMULA_TEMPLATE_KEYS)expect(screen.getByRole('heading',{name:t.templates[key].name})).toBeVisible();
  for(const tab of ['variables','operators','conditions','returnExplain'] as const){fireEvent.click(screen.getByRole('tab',{name:t.help.tabs[tab]}));expect(screen.getByRole('tab',{name:t.help.tabs[tab]})).toHaveAttribute('aria-selected','true');}
  expect(screen.getByRole('tab',{name:t.testArea.sample})).toHaveAttribute('aria-selected','true');
 });
 it('previews an example and links "Use as template" to a new unsaved draft',async()=>{
  const rendered=mount();const card=screen.getByRole('heading',{name:words.templates.OT_1_5.name}).closest('li')!;
  fireEvent.click(within(card).getByRole('button',{name:new RegExp('^'+words.help.preview)}));
  expect(within(card).getByText(/Dim Gross As Decimal/)).toBeVisible();expect(within(card).getByText(words.templates.OT_1_5.explanation)).toBeVisible();
  expect(within(card).getByRole('link',{name:new RegExp('^'+words.help.useTemplate)})).toHaveAttribute('href','/payroll/formula-builder/new?template=OT_1_5');
  expect(state.save).not.toHaveBeenCalled();
  await captureAiReviewScreenshots(aiReviewDomHtml(rendered.container),'en','formula-help-examples',visualFixture,'atelier');
 },120000);
 it('loads a template into an unsaved draft with the curated explanation, then explains the edited copy',()=>{
  const original=payFormulaTemplateSource('OT_1_5',words.templates.hourlyRateNote);mount('OT_1_5');
  expect(source().value).toBe(original);expect(screen.getByLabelText(words.formulaId)).toHaveValue('');expect(screen.getByLabelText(words.description)).toHaveValue(words.templates.OT_1_5.name);
  expect(screen.getByText(words.copiedFrom.replace('{name}',words.templates.OT_1_5.name))).toBeVisible();
  const box=screen.getByRole('heading',{name:words.explain.title}).closest('section')!;expect(within(box).getByText(words.templates.OT_1_5.explanation)).toBeVisible();
  fireEvent.change(source(),{target:{value:original.replace('* 1.5 *','* 1.75 *')}});
  expect(within(box).queryByText(words.templates.OT_1_5.explanation)).not.toBeInTheDocument();
  expect(within(box).getByText('If Basic salary ≤ 4000:')).toBeVisible();expect(within(box).getByText('The result is Gross ÷ 26 ÷ 8 × 1.75 × Current input.')).toBeVisible();
  // The example itself is a constant and is unchanged by editing the copy; nothing was saved.
  expect(payFormulaTemplateSource('OT_1_5',words.templates.hourlyRateNote)).toBe(original);expect(state.save).not.toHaveBeenCalled();
 });
});

describe('templates in the Condition Builder',()=>{
 it.each(PAY_FORMULA_TEMPLATE_KEYS.map(key=>[key]))('%s round-trips through the actual Condition Builder controls',key=>{
  mount(key);fireEvent.click(screen.getByRole('tab',{name:words.methods.conditions}));expect(screen.getByRole('tab',{name:words.methods.conditions})).toHaveAttribute('aria-selected','true');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('tab',{name:words.methods.write}));
  expect(printPayFormula(parsePayFormula(source().value))).toBe(printPayFormula(parsePayFormula(payFormulaTemplateSource(key,words.templates.hourlyRateNote))));
 });
});

describe('sample-value test',()=>{
 it('runs the unsaved source with typed values and shows the amount and each step',async()=>{
  const rendered=mount('OT_1_5');const panel=document.getElementById('formula-test-sample')!;
  for(const [field,value] of [['Basic','3,500.00'],['FixedAllowances','300.00'],['CalendarDays','31'],['Input','10']] as const)fireEvent.change(within(panel).getByLabelText(words.testArea.fields[field]),{target:{value}});
  fireEvent.click(within(panel).getByRole('button',{name:words.testArea.run}));
  await waitFor(()=>expect(state.sample).toHaveBeenCalledWith({source:payFormulaTemplateSource('OT_1_5',words.templates.hourlyRateNote),values:{Basic:'3500.00',FixedAllowances:'300.00',CalendarDays:'31',Input:'10'}}));
  expect(await within(panel).findByText('274.04')).toBeVisible();expect(within(panel).getByText(words.testArea.passed)).toBeVisible();
  expect(within(panel).getByText('Gross = 3800')).toBeVisible();expect(within(panel).getByText(/^Line 2: the condition is true/)).toBeVisible();
  expect(within(panel).getByText(words.testArea.note)).toBeVisible();expect(state.save).not.toHaveBeenCalled();expect(state.test).not.toHaveBeenCalled();
  await captureAiReviewScreenshots(aiReviewDomHtml(rendered.container),'en','formula-sample-test',visualFixture,'atelier');
 },120000);
 it('names a variable that needs a real employee test instead of guessing',async()=>{
  mount();fireEvent.change(source(),{target:{value:'Return {#PayItem}("OT")'}});const panel=document.getElementById('formula-test-sample')!;
  fireEvent.click(within(panel).getByRole('button',{name:words.testArea.run}));
  expect(await within(panel).findByText(words.testArea.errors.needs_employee_test.replace('{variable}',words.functions.PayItem))).toBeVisible();
 });
});

describe('checks before saving',()=>{
 const broken='Dim DailyRate As Decimal = {#Basic} / {#Input}\nIf {#Basic} <= 4000 Then\n    Return DailyRate * {#CalenderDays}\nEnd If';
 it('lists every problem with its position, underlines it and moves the cursor there',async()=>{
  const rendered=mount();fireEvent.change(source(),{target:{value:broken}});
  const checks=screen.getByRole('heading',{name:words.checks.title}).closest('section')!;
  const unknown=within(checks).getByRole('button',{name:/line 3, column 24/});
  expect(unknown).toHaveTextContent('"CalenderDays" is not a payroll variable. Did you mean CalendarDays?');
  expect(within(checks).getByRole('button',{name:/Cannot save · line 2, column 1/})).toHaveTextContent(words.checks.missing_return);
  expect(within(checks).getByRole('button',{name:/Check · line 1, column 39/})).toHaveTextContent('This divides by {#Input}.');
  expect([...rendered.container.querySelectorAll('[data-formula-mark="error"]')].map(node=>node.textContent)).toEqual(['If','{#CalenderDays}']);
  expect(rendered.container.querySelector('[data-formula-mark="warning"]')).toHaveTextContent('{#Input}');
  fireEvent.click(unknown);const offset=broken.indexOf('{#CalenderDays}');
  expect(source().selectionStart).toBe(offset);expect(source().selectionEnd).toBe(offset+'{#CalenderDays}'.length);expect(document.activeElement).toBe(source());
  fireEvent.change(screen.getByLabelText(words.formulaId),{target:{value:'BROKEN'}});fireEvent.change(screen.getByLabelText(words.description),{target:{value:'Fictional'}});
  fireEvent.click(screen.getByRole('button',{name:words.save}));expect(await screen.findByText(words.checks.blocked)).toBeVisible();expect(state.save).not.toHaveBeenCalled();
  await captureAiReviewScreenshots(aiReviewDomHtml(rendered.container),'en','formula-checks',visualFixture,'atelier');
 },120000);
 it('saves through the existing path when only warnings remain',async()=>{
  mount();fireEvent.change(source(),{target:{value:'Return {#Basic} / {#Input}'}});
  fireEvent.change(screen.getByLabelText(words.formulaId),{target:{value:'WARN_ONLY'}});fireEvent.change(screen.getByLabelText(words.description),{target:{value:'Fictional'}});
  fireEvent.click(screen.getByRole('button',{name:words.save}));
  await waitFor(()=>expect(state.save).toHaveBeenCalledWith({id:undefined,expectedRevisionId:undefined,formulaId:'WARN_ONLY',description:'Fictional',method:'write',source:'Return {#Basic} / {#Input}'}));
 });
});
