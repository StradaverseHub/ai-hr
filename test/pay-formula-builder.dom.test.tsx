import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import vietnamese from '../messages/vi.json';
import {FormulaEditor} from '../app/payroll/formula-builder/editor';
import {parsePayFormula,printPayFormula} from '../lib/pay-formula-language';
import {PAY_FORMULA_VARIABLE_CATEGORIES} from '../lib/pay-formula-registry';
import type {FormulaBuilderOptions,FormulaBuilderView} from '../app/payroll/formula-builder/ui-types';
const state=vi.hoisted(()=>({save:vi.fn(),test:vi.fn(),activate:vi.fn(),remove:vi.fn(),group:vi.fn(),search:vi.fn(),push:vi.fn(),refresh:vi.fn(),replace:vi.fn()}));
vi.mock('../app/payroll/formula-builder/actions',()=>({saveFormulaAction:state.save,testFormulaAction:state.test,formulaStateAction:state.activate,deleteFormulaAction:state.remove,saveAccumulationAction:state.group,searchFormulaEmployeesAction:state.search}));
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
function mount(locale:keyof typeof catalogues='en',formula=fixture(),readOnly=false){return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}><FormulaEditor initial={formula} options={options} readOnly={readOnly}/></NextIntlClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();state.save.mockResolvedValue({ok:false,error:'Fictional save refusal'});state.test.mockResolvedValue({ok:false,error:'Fictional test refusal'});state.search.mockResolvedValue({ok:true,value:[{id:'employee2',companyId:'company',code:'E2',name:'Found employee'}]});});afterEach(cleanup);
describe('Formula Builder actual editor',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s labels both editors and all 14 variable categories',locale=>{mount(locale);const words=catalogues[locale].payFormula;expect(screen.getByRole('tab',{name:words.methods.write})).toHaveAttribute('aria-selected','true');expect(screen.getByRole('tab',{name:words.methods.conditions})).toBeVisible();const categories=screen.getByLabelText(words.category);expect(categories.querySelectorAll('option')).toHaveLength(15);for(const category of PAY_FORMULA_VARIABLE_CATEGORIES)expect(categories).toHaveTextContent(words.categories[category.code]);expect(screen.getByRole('button',{name:words.save})).toBeDisabled();});
 it('round trips every statement type, all value types, nested branches and comments through actual visual controls',()=>{mount();fireEvent.click(screen.getByRole('tab',{name:en.payFormula.methods.conditions}));expect(screen.getByDisplayValue('Retained comment')).toBeVisible();expect(screen.getAllByRole('button',{name:en.payFormula.addElseIf})).toHaveLength(2);expect(screen.getAllByDisplayValue('Amount').length).toBeGreaterThan(0);fireEvent.click(screen.getByRole('tab',{name:en.payFormula.methods.write}));const text=screen.getByRole('textbox',{name:en.payFormula.source}) as HTMLTextAreaElement;expect(printPayFormula(parsePayFormula(text.value))).toBe(printPayFormula(parsePayFormula(source)));});
 it('refuses an invalid source switch with a precise error and preserves the source',()=>{mount();const text=screen.getByRole('textbox',{name:en.payFormula.source});fireEvent.change(text,{target:{value:'Return fetch("https://example.com")'}});fireEvent.click(screen.getByRole('tab',{name:en.payFormula.methods.conditions}));expect(screen.getByRole('alert')).toHaveTextContent(/line 1, column/);expect(text).toHaveValue('Return fetch("https://example.com")');expect(screen.getByRole('tab',{name:en.payFormula.methods.write})).toHaveAttribute('aria-selected','true');});
 it('blocks test and activation after edits and does not call the service',()=>{mount();fireEvent.change(screen.getByLabelText(en.payFormula.description),{target:{value:'Changed'}});expect(screen.getByRole('button',{name:en.payFormula.testSaved})).toBeDisabled();expect(screen.getByRole('button',{name:en.payFormula.activate})).toBeDisabled();expect(state.test).not.toHaveBeenCalled();expect(state.activate).not.toHaveBeenCalled();});
 it('invalidates activation when the simulation context changes',()=>{mount();expect(screen.getByRole('button',{name:en.payFormula.activate})).toBeEnabled();fireEvent.change(screen.getByLabelText(en.payFormula.input),{target:{value:'3'}});expect(screen.getByRole('button',{name:en.payFormula.activate})).toBeDisabled();expect(screen.getByText(en.payFormula.staleReceipt)).toBeVisible();});
 it('tests the exact saved revision and prevents repeated submissions while pending',async()=>{let finish!:(value:unknown)=>void;state.test.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));mount();const button=screen.getByRole('button',{name:en.payFormula.testSaved});fireEvent.click(button);fireEvent.click(button);expect(state.test).toHaveBeenCalledTimes(1);expect(state.test).toHaveBeenCalledWith({id:'formula',revisionId:'revision-1',context});finish({ok:false,error:'Fictional stale revision refusal'});await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Fictional stale revision refusal'));});
 it('searches beyond initial employee options through the authorized service',async()=>{mount();fireEvent.change(screen.getByLabelText(en.payFormula.searchEmployee),{target:{value:'Found'}});fireEvent.click(screen.getByRole('button',{name:en.payFormula.search,exact:true}));await waitFor(()=>expect(state.search).toHaveBeenCalledWith({query:'Found',companyId:'company'}));expect(await screen.findByRole('option',{name:'E2 · Found employee'})).toBeInTheDocument();});
 it('shows immutable versions and disables editing in view mode',()=>{mount('en',fixture(),true);expect(screen.getByLabelText(en.payFormula.formulaId)).toBeDisabled();expect(screen.getByRole('textbox',{name:en.payFormula.source})).toBeDisabled();expect(screen.queryByRole('button',{name:en.payFormula.save})).not.toBeInTheDocument();expect(screen.getByText(en.payFormula.usageAndVersions)).toBeVisible();});
 it('honors authoritative view-only capabilities',()=>{const formula=fixture();formula.capabilities={view:true,edit:false,test:false,activate:false,deactivate:false,delete:false};mount('en',formula);expect(screen.getByLabelText(en.payFormula.description)).toBeDisabled();expect(screen.getByRole('button',{name:en.payFormula.testSaved})).toBeDisabled();expect(screen.queryByRole('button',{name:en.payFormula.activate})).not.toBeInTheDocument();});
});
