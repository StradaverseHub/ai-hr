import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import vietnamese from '../messages/vi.json';
import {PayRuleEditor} from '../app/admin/pay-components/pay-rule-editor';
import {FormulaEditor} from '../app/payroll/formula-builder/editor';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
const visualFixture='Actual FormulaEditor and variable-library components; fictional employee/company/payroll owner fixtures; inert browser rendering; no authenticated server journey or installed acceptance claimed.';
import {parsePayFormula,printPayFormula} from '../lib/pay-formula-language';
import {PAY_FORMULA_VARIABLE_CATEGORIES} from '../lib/pay-formula-registry';
import type {FormulaBuilderOptions,FormulaBuilderView} from '../app/payroll/formula-builder/ui-types';
const state=vi.hoisted(()=>({save:vi.fn(),test:vi.fn(),activate:vi.fn(),remove:vi.fn(),group:vi.fn(),search:vi.fn(),batches:vi.fn(),push:vi.fn(),refresh:vi.fn(),replace:vi.fn()}));
vi.mock('../app/payroll/formula-builder/actions',()=>({saveFormulaAction:state.save,testFormulaAction:state.test,formulaStateAction:state.activate,deleteFormulaAction:state.remove,saveAccumulationAction:state.group,searchFormulaEmployeesAction:state.search,listFormulaBatchesAction:state.batches}));
vi.mock('../app/admin/pay-components/actions',()=>({draftPayRuleAction:vi.fn(),previewPayRuleAction:vi.fn(),searchPreviewEmployeesAction:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:state.push,refresh:state.refresh,replace:state.replace})}));
const catalogues={en,ms,zh,ta,th,vi:vietnamese};
const capabilities={view:true,edit:true,test:true,activate:true,deactivate:false,delete:true};
const context={companyId:'company',employmentId:'employee',period:'2026-10',cycleId:'cycle',asOf:'2026-10-30',currentCode:'OT',input:'2'};
const options:FormulaBuilderOptions={companies:[{id:'company',name:'Fictional Company'}],employees:[{id:'employee',companyId:'company',code:'E1',name:'Fictional Employee'}],cycles:[{id:'cycle',companyId:'company',code:'MONTHLY',label:'Monthly'}],payItems:[{code:'OT',name:'Overtime'},{code:'BASIC',name:'Basic salary'}],activeFormulas:[],accumulations:[{id:'group',code:'GROSS',members:['BASIC']}],capabilities};
const source=`'Retained comment
Dim Amount As Decimal = 1.005
Dim Label As String = "Example"
Dim Eligible As Boolean = True
Dim Start As Date = {#Date}("2026-10-01")
If Eligible And Start <= {#JoinDate} Then
  If Amount > 0 Then
    Amount = {#Rounding}(Amount, 2)
  Else
    Amount = -1
  End If
ElseIf Not Eligible Then
  Amount = 2 * (3 + 1) / 2
Else
  Amount = 0
End If
{#Explain}(Label & " result")
Return Amount`;
const fixture=():FormulaBuilderView=>{const latest={id:'revision-1',ordinal:1,description:'Fictional formula',method:'write' as const,source,program:parsePayFormula(source),contentHash:'hash',dependencies:[],createdAt:'2026-10-30T00:00:00Z'};return {id:'formula',formulaId:'OT_TEST',status:'tested',activeRevisionId:null,latest,versions:[latest],tests:[{id:'receipt',revisionId:latest.id,passed:true,amount:'1.01',explanations:['Example result'],error:null,context,sourceFingerprint:'source',dependencyFingerprint:'deps',readRequirements:{categories:[],fieldIds:[]},createdAt:'2026-10-30T01:00:00Z'}],usage:[],idLocked:false,updatedAt:'2026-10-30T01:00:00Z',capabilities};};
function mount(locale:keyof typeof catalogues='en',formula=fixture(),readOnly=false,employeeOptions:FormulaBuilderOptions=options){return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}><FormulaEditor initial={formula} options={employeeOptions} readOnly={readOnly}/></NextIntlClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();state.save.mockResolvedValue({ok:false,error:'Fictional save refusal'});state.test.mockResolvedValue({ok:false,error:'Fictional test refusal'});state.batches.mockResolvedValue({ok:true,value:[{id:'run-2',runSeq:2,status:'draft'}]});state.search.mockResolvedValue({ok:true,value:[{id:'employee2',companyId:'company',code:'E2',name:'Found employee'}]});});afterEach(cleanup);
describe('Formula Builder actual editor',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s labels both editors and all 14 variable categories',async locale=>{const rendered=mount(locale);const words=catalogues[locale].payFormula;expect(screen.getByRole('tab',{name:words.methods.write})).toHaveAttribute('aria-selected','true');expect(screen.getByRole('tab',{name:words.methods.conditions})).toBeVisible();const categories=screen.getByLabelText(words.category);expect(categories.querySelectorAll('option')).toHaveLength(15);for(const category of PAY_FORMULA_VARIABLE_CATEGORIES)expect(categories).toHaveTextContent(words.categories[category.code]);expect(screen.getByRole('button',{name:words.save})).toBeDisabled();await captureAiReviewScreenshots(aiReviewDomHtml(rendered.container),locale,'formula-write',visualFixture,'atelier');},120000);
 it('captures the actual English condition editor and guided variable library with fictional owners',async()=>{
  const formula=fixture();const conditionSource=`Dim Amount As Decimal = {#Basic} / 26 / 8 * {#Input}
If {#Payrate} = "M" Then
    {#Explain}("Fictional monthly overtime example")
    Return {#Rounding}(Amount, 2)
Else
    Return 0
End If`;
  formula.latest={...formula.latest,source:conditionSource,program:parsePayFormula(conditionSource)};formula.versions=[formula.latest];
  const rendered=mount('en',formula);fireEvent.click(screen.getByRole('tab',{name:en.payFormula.methods.conditions}));
  expect(screen.getByRole('tab',{name:en.payFormula.methods.conditions})).toHaveAttribute('aria-selected','true');
  await captureAiReviewScreenshots(aiReviewDomHtml(rendered.container),'en','formula-conditions',visualFixture,'atelier');
 },120000);
 it('round trips every statement type, all value types, nested branches and comments through actual visual controls',()=>{mount();fireEvent.click(screen.getByRole('tab',{name:en.payFormula.methods.conditions}));expect(screen.getByDisplayValue('Retained comment')).toBeVisible();expect(screen.getAllByRole('button',{name:en.payFormula.addElseIf})).toHaveLength(2);expect(screen.getAllByDisplayValue('Amount').length).toBeGreaterThan(0);fireEvent.click(screen.getByRole('tab',{name:en.payFormula.methods.write}));const text=screen.getByRole('textbox',{name:en.payFormula.source}) as HTMLTextAreaElement;expect(printPayFormula(parsePayFormula(text.value))).toBe(printPayFormula(parsePayFormula(source)));});
 it('refuses an invalid source switch with a precise error and preserves the source',()=>{mount();const text=screen.getByRole('textbox',{name:en.payFormula.source});fireEvent.change(text,{target:{value:'Return fetch("https://example.com")'}});fireEvent.click(screen.getByRole('tab',{name:en.payFormula.methods.conditions}));expect(screen.getByRole('alert')).toHaveTextContent(/line 1, column/);expect(text).toHaveValue('Return fetch("https://example.com")');expect(screen.getByRole('tab',{name:en.payFormula.methods.write})).toHaveAttribute('aria-selected','true');});
 it('blocks test and activation after edits and does not call the service',()=>{mount();fireEvent.change(screen.getByLabelText(en.payFormula.description),{target:{value:'Changed'}});expect(screen.getByRole('button',{name:en.payFormula.testSaved})).toBeDisabled();expect(screen.getByRole('button',{name:en.payFormula.activate})).toBeDisabled();expect(state.test).not.toHaveBeenCalled();expect(state.activate).not.toHaveBeenCalled();});
 it('invalidates activation when the simulation context changes',()=>{mount();expect(screen.getByRole('button',{name:en.payFormula.activate})).toBeEnabled();fireEvent.change(screen.getByLabelText(en.payFormula.input),{target:{value:'3'}});expect(screen.getByRole('button',{name:en.payFormula.activate})).toBeDisabled();expect(screen.getByText(en.payFormula.staleReceipt)).toBeVisible();});
 it('tests the exact saved revision and prevents repeated submissions while pending',async()=>{let finish!:(value:unknown)=>void;state.test.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));mount();const button=screen.getByRole('button',{name:en.payFormula.testSaved});fireEvent.click(button);fireEvent.click(button);expect(state.test).toHaveBeenCalledTimes(1);expect(state.test).toHaveBeenCalledWith({id:'formula',revisionId:'revision-1',context});finish({ok:false,error:'Fictional stale revision refusal'});await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Fictional stale revision refusal'));});
 it('searches beyond initial employee options through the authorized service',async()=>{mount();fireEvent.change(screen.getByLabelText(en.payFormula.searchEmployee),{target:{value:'Found'}});fireEvent.click(screen.getByRole('button',{name:en.payFormula.search}));await waitFor(()=>expect(state.search).toHaveBeenCalledWith({query:'Found',companyId:'company',period:'2026-10',asOf:'2026-10-30'}));expect(await screen.findByRole('option',{name:'E2 · Found employee'})).toBeInTheDocument();});
 it('requires an explicit payroll run selection and invalidates it when the cycle context changes',async()=>{mount();fireEvent.click(screen.getByRole('button',{name:en.payFormula.loadRuns}));await waitFor(()=>expect(state.batches).toHaveBeenCalledWith({companyId:'company',period:'2026-10',cycleId:'cycle'}));fireEvent.change(screen.getByLabelText(en.payFormula.payrollRun),{target:{value:'run-2'}});fireEvent.click(screen.getByRole('button',{name:en.payFormula.testSaved}));await waitFor(()=>expect(state.test).toHaveBeenCalledWith({id:'formula',revisionId:'revision-1',context:{...context,batchId:'run-2'}}));fireEvent.change(screen.getByLabelText(en.payFormula.period),{target:{value:'2026-11'}});expect(screen.getByLabelText(en.payFormula.payrollRun)).toHaveValue('');});
 it('inserts typed Date, String and Boolean library calls into the actual visual editor without name collisions',()=>{const formula=fixture();formula.latest={...formula.latest,source:'Dim Value3 As Decimal = 1\nReturn 0',program:parsePayFormula('Dim Value3 As Decimal = 1\nReturn 0')};mount('en',formula);fireEvent.click(screen.getByRole('tab',{name:en.payFormula.methods.conditions}));for(const code of ['EmployeeProfile','Payrate','JoinedThisMonth'] as const){fireEvent.click(screen.getByRole('button',{name:en.payFormula.functions[code]}));fireEvent.click(screen.getByRole('button',{name:en.payFormula.addNamedValue}));}expect(screen.queryByRole('alert')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('tab',{name:en.payFormula.methods.write}));const value=(screen.getByRole('textbox',{name:en.payFormula.source}) as HTMLTextAreaElement).value;const program=parsePayFormula(value);expect(program.statements.filter(s=>s.kind==='declare').map(s=>s.type)).toEqual(['decimal','date','string','boolean']);expect(new Set(program.statements.filter(s=>s.kind==='declare').map(s=>s.name)).size).toBe(4);});
 it('displays the saved transferred employee for a historical paying company without substituting another employee',()=>{
  const formula=fixture(),transferred={id:'employee',companyId:'company-B',code:'TR-1',name:'Fictional transferred employee'};
  mount('en',formula,false,{...options,employees:[{id:'other-A',companyId:'company',code:'A-2',name:'Different employee'},transferred]});
  const select=screen.getByLabelText(en.payFormula.employee) as HTMLSelectElement;expect(select).toHaveValue('employee');expect(select.selectedOptions[0].textContent).toBe('TR-1 · Fictional transferred employee');expect(select.selectedOptions[0].value).not.toBe('other-A');
 });
 it('shows a protected sentinel with the exact missing saved employee ID instead of displaying the first different person',()=>{
  mount('en',fixture(),false,{...options,employees:[{id:'other-A',companyId:'company',code:'A-2',name:'Different employee'}]});
  const select=screen.getByLabelText(en.payFormula.employee) as HTMLSelectElement;expect(select).toHaveValue('employee');expect(select.selectedOptions[0].textContent).toBe(en.payFormula.traceEmployeeProtected);expect(select.selectedOptions[0].value).not.toBe('other-A');
 });
 it('searches in the selected dated context, preserves the authorized selection and deduplicates incoming owner rows',async()=>{
  const transferred={id:'employee',companyId:'company-B',code:'TR-1',name:'Fictional transferred employee'};
  state.search.mockResolvedValue({ok:true,value:[{id:'historical-A',companyId:'company',code:'DATED-A',name:'Fictional dated employee'},{id:'historical-A',companyId:'company',code:'DATED-A',name:'Fictional dated employee'}]});
  mount('en',fixture(),false,{...options,employees:[transferred,{id:'other-A',companyId:'company',code:'A-2',name:'Different employee'}]});
  fireEvent.change(screen.getByLabelText(en.payFormula.period),{target:{value:'2026-09'}});fireEvent.change(screen.getByLabelText(en.payFormula.asOf),{target:{value:'2026-09-30'}});fireEvent.change(screen.getByLabelText(en.payFormula.searchEmployee),{target:{value:'dated'}});fireEvent.click(screen.getByRole('button',{name:en.payFormula.search}));
  await waitFor(()=>expect(state.search).toHaveBeenCalledWith({query:'dated',companyId:'company',period:'2026-09',asOf:'2026-09-30'}));
  const select=screen.getByLabelText(en.payFormula.employee) as HTMLSelectElement;expect(select).toHaveValue('employee');expect(select.selectedOptions[0].textContent).toBe('TR-1 · Fictional transferred employee');expect(await screen.findAllByRole('option',{name:'DATED-A · Fictional dated employee'})).toHaveLength(1);
  fireEvent.change(select,{target:{value:'historical-A'}});expect(select.selectedOptions[0].textContent).toBe('DATED-A · Fictional dated employee');fireEvent.click(screen.getByRole('button',{name:en.payFormula.testSaved}));
  await waitFor(()=>expect(state.test).toHaveBeenCalledWith({id:'formula',revisionId:'revision-1',context:{...context,period:'2026-09',asOf:'2026-09-30',batchId:undefined,employmentId:'historical-A'}}));
 });
 it('prefers a newly authorized dated owner label for the same employee ID while retaining one option',async()=>{
  state.search.mockResolvedValue({ok:true,value:[{id:'employee',companyId:'company',code:'E1-DATED',name:'Updated dated label'}]});mount();fireEvent.click(screen.getByRole('button',{name:en.payFormula.search}));
  await screen.findByRole('option',{name:'E1-DATED · Updated dated label'});const select=screen.getByLabelText(en.payFormula.employee) as HTMLSelectElement;expect(select).toHaveValue('employee');expect([...select.options].filter(option=>option.value==='employee')).toHaveLength(1);expect(select.selectedOptions[0].textContent).toBe('E1-DATED · Updated dated label');
 });
 it('inserts a date call into the actual text selection',()=>{const formula=fixture(),text='Dim Start As Date = {#Date}("2026-10-01")\nReturn 0';formula.latest={...formula.latest,source:text,program:parsePayFormula(text)};mount('en',formula);const input=screen.getByRole('textbox',{name:en.payFormula.source}) as HTMLTextAreaElement;input.setSelectionRange(text.indexOf('{#Date}'),text.indexOf('\n'));fireEvent.click(screen.getByRole('button',{name:en.payFormula.functions.JoinDate}));fireEvent.click(screen.getByRole('button',{name:en.payFormula.insertVariable}));expect(input.value).toBe('Dim Start As Date = {#JoinDate}\nReturn 0');expect(()=>parsePayFormula(input.value)).not.toThrow();expect(screen.queryByRole('alert')).not.toBeInTheDocument();});
 it('renders the native Formula Builder input kind and explicit context bindings',async()=>{const native=render(<NextIntlClientProvider locale="en" messages={en}><form><PayRuleEditor catalogueOnly code="FIXTURE_OT" kind="allowance" prorates={false} rule={null} aiEnabled={false} payItems={[{code:'BASIC',name:'Basic salary'}]} previewEmployees={[]} activeFormulas={[{formulaId:'OT_TEST',description:'Fictional tested overtime',dependencies:['BASIC']}]}/></form></NextIntlClientProvider>);fireEvent.change(screen.getByLabelText(en.payRule.kindLabel),{target:{value:'formula_builder'}});fireEvent.change(screen.getByLabelText(en.payRule.builderFormula),{target:{value:'OT_TEST'}});for(const [label,value] of [[en.payRule.builderOrdinaryRate,'26'],[en.payRule.builderHoursPerDay,'8'],[en.payRule.builderRate,'1.5']])fireEvent.change(screen.getByLabelText(label),{target:{value}});expect(JSON.parse((native.container.querySelector('input[name="rule"]') as HTMLInputElement).value)).toEqual({kind:'formula_builder',formulaId:'OT_TEST',dependencies:['BASIC']});expect(new FormData(native.container.querySelector('form')!).get('formulaHoursPerDay')).toBe('8');await captureAiReviewScreenshots(aiReviewDomHtml(native.container),'en','formula-pay-item',visualFixture,'atelier');},120000);
 it('shows immutable versions and disables editing in view mode',()=>{mount('en',fixture(),true);expect(screen.getByLabelText(en.payFormula.formulaId)).toBeDisabled();expect(screen.getByRole('textbox',{name:en.payFormula.source})).toBeDisabled();expect(screen.queryByRole('button',{name:en.payFormula.save})).not.toBeInTheDocument();expect(screen.getByText(en.payFormula.usageAndVersions)).toBeVisible();});
 it('honors authoritative view-only capabilities',()=>{const formula=fixture();formula.capabilities={view:true,edit:false,test:false,activate:false,deactivate:false,delete:false};mount('en',formula);expect(screen.getByLabelText(en.payFormula.description)).toBeDisabled();expect(screen.getByRole('button',{name:en.payFormula.testSaved})).toBeDisabled();expect(screen.queryByRole('button',{name:en.payFormula.activate})).not.toBeInTheDocument();});
});
