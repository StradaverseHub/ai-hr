vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
// @vitest-environment jsdom
/** Authored UNRUN: actual native editor controls; catalogue mode forbids every unrelated request. */
import React from 'react';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const actions=vi.hoisted(()=>({search:vi.fn(async()=>[]),preview:vi.fn(),draft:vi.fn()}));
vi.mock('../app/admin/pay-components/actions',()=>({searchPreviewEmployeesAction:actions.search,previewPayRuleAction:actions.preview,draftPayRuleAction:actions.draft}));vi.mock('next-intl',()=>({useTranslations:()=>((key:string)=>key)}));
import {PayRuleEditor} from '../app/admin/pay-components/pay-rule-editor';
beforeEach(()=>{vi.clearAllMocks();vi.useFakeTimers();});afterEach(()=>{cleanup();vi.useRealTimers();});
const props={code:'HUMAN',kind:'allowance',prorates:true,rule:null,aiEnabled:true,payItems:[{code:'OTHER',name:'Human other allowance'}],previewEmployees:[{employmentId:'10000000-0000-4000-8000-000000000001',name:'Private employee',employeeCode:'PRIVATE'}]};
describe('native PayRuleEditor catalogueOnly boundary',()=>{
 it('no employee auto-search on mount even when supplied employee/AI props; no preview/AI controls or private metadata',async()=>{render(<PayRuleEditor {...props} catalogueOnly/>);await vi.advanceTimersByTimeAsync(1000);expect(actions.search).not.toHaveBeenCalled();expect(actions.preview).not.toHaveBeenCalled();expect(actions.draft).not.toHaveBeenCalled();expect(screen.queryByText('Private employee')).toBeNull();expect(screen.queryByText('previewTitle')).toBeNull();expect(screen.queryByText('assistTitle')).toBeNull();});
 it('offers direct amount and the two formula paths without exposing removed calculation types',async()=>{render(<PayRuleEditor {...props} catalogueOnly/>);const select=document.querySelector('select') as HTMLSelectElement;expect(Array.from(select.options).map(o=>o.value)).toEqual(['fixed','formula','formula_builder']);await vi.advanceTimersByTimeAsync(1000);expect(actions.search).not.toHaveBeenCalled();expect(actions.preview).not.toHaveBeenCalled();expect(actions.draft).not.toHaveBeenCalled();});
 it('preserves an existing removed calculation while editing unrelated configuration',()=>{render(<PayRuleEditor {...props} rule={{kind:'per_hour',rate:12.5}} catalogueOnly/>);expect(JSON.parse((document.querySelector('input[name="rule"]') as HTMLInputElement).value)).toEqual({kind:'per_hour',rate:12.5});expect(screen.getByRole('option',{name:'kind_per_hour · legacyInputType'})).toBeVisible();});
 it('shows the selected read-only explanation in order and replaces it when the Formula ID changes',()=>{
  const first=[{depth:0,text:'If Current input > 1:'},{depth:1,text:'The result is Basic salary ÷ 26.'},{depth:0,text:'Otherwise:'},{depth:1,text:'The result is 1.'}];
  render(<PayRuleEditor {...props} catalogueOnly rule={{kind:'formula_builder',formulaId:'A',dependencies:[]}} activeFormulas={[
   {formulaId:'A',description:'First catalogue label',dependencies:[],explanation:first},
   {formulaId:'B',description:'Second catalogue label',dependencies:[],explanation:[{depth:0,text:'The result is 2.'}]},
  ]}/>);
  const panel=screen.getByRole('region',{name:'explain.title'});
  expect(within(panel).getAllByRole('listitem').map(item=>item.textContent)).toEqual(first.map(row=>row.text));
  expect(within(panel).getAllByRole('listitem')[1]).toHaveStyle({listStyleType:'circle'});
  expect(within(panel).queryByRole('textbox')).toBeNull();
  fireEvent.change(screen.getByLabelText('builderFormula'),{target:{value:'B'}});
  expect(within(panel).getAllByRole('listitem').map(item=>item.textContent)).toEqual(['The result is 2.']);
  expect(JSON.parse((document.querySelector('input[name="rule"]') as HTMLInputElement).value)).toEqual({kind:'formula_builder',formulaId:'B',dependencies:[]});
 });
 it('keeps the saved ID visible when the linked formula is unavailable',()=>{
  render(<PayRuleEditor {...props} catalogueOnly rule={{kind:'formula_builder',formulaId:'MISSING',dependencies:['BASIC']}}/>);
  expect(screen.getByLabelText('builderFormula')).toHaveValue('MISSING');
  expect(within(screen.getByRole('region',{name:'explain.title'})).getByText('builderDescriptionUnavailable')).toBeVisible();
  expect(JSON.parse((document.querySelector('input[name="rule"]') as HTMLInputElement).value)).toEqual({kind:'formula_builder',formulaId:'MISSING',dependencies:['BASIC']});
 });
 it('persists explicit bindings before linking and serializes the active builder reference',()=>{render(<PayRuleEditor {...props} catalogueOnly formulaContext={{hoursPerDay:'8',rate:'1.5'}} activeFormulas={[{formulaId:'OT_TEST',description:'Approved overtime',dependencies:['BASIC'],explanation:null}]}/>);expect(document.querySelector('input[name="formulaHoursPerDay"]')).toHaveValue('8');fireEvent.change(document.querySelector('select')!,{target:{value:'formula_builder'}});const selector=screen.getByDisplayValue('builderNoFormula');fireEvent.change(selector,{target:{value:'OT_TEST'}});expect(JSON.parse((document.querySelector('input[name="rule"]') as HTMLInputElement).value)).toEqual({kind:'formula_builder',formulaId:'OT_TEST',dependencies:['BASIC']});expect(actions.preview).not.toHaveBeenCalled();});
 it('1832f810: changing an imported pending Formula to Fixed submits explicit intent',()=>{render(<PayRuleEditor {...props} catalogueOnly pendingInputKind="formula"/>);fireEvent.change(document.querySelector('select')!,{target:{value:'fixed'}});expect(JSON.parse((document.querySelector('input[name="rule"]') as HTMLInputElement).value)).toEqual({kind:'fixed'});});
 it('retains legacy maintenance kinds when the builder module is unavailable',()=>{render(<PayRuleEditor {...props} catalogueOnly builderEnabled={false}/>);expect(screen.queryByRole('option',{name:'kind_formula_builder'})).toBeNull();expect(screen.getByRole('option',{name:'kind_formula'})).toBeInTheDocument();});
 it('preserves ordinary native default employee search when catalogueOnly is omitted',async()=>{render(<PayRuleEditor {...props}/>);await vi.advanceTimersByTimeAsync(251);expect(actions.search).toHaveBeenCalledWith('');});
});
