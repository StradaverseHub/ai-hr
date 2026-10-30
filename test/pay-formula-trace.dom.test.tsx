import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import vietnamese from '../messages/vi.json';
import {FormulaTraceView,type FormulaTraceViewData} from '../app/payroll/formula-builder/evaluations/trace-view';
import FormulaEvaluationPage from '../app/payroll/formula-builder/evaluations/[id]/page';
import FormulaEvaluationError from '../app/payroll/formula-builder/evaluations/[id]/error';
import {FormulaEditor} from '../app/payroll/formula-builder/editor';
import type {FormulaBuilderOptions,FormulaBuilderView} from '../app/payroll/formula-builder/ui-types';
import type {PayFormulaEvaluationDetail} from '../lib/pay-formula-model';
import {parsePayFormula} from '../lib/pay-formula-language';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
const state=vi.hoisted(()=>({read:vi.fn(),requireAdmin:vi.fn(),notFound:vi.fn(),refresh:vi.fn(),push:vi.fn(),replace:vi.fn()}));
vi.mock('../packs/payroll/service',()=>({getFormulaEvaluation:state.read}));
vi.mock('../lib/authz',()=>({requireAdmin:state.requireAdmin}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>createTranslator({locale:'en',messages:en,namespace:'payFormula'})}));
vi.mock('next/navigation',()=>({notFound:()=>{state.notFound();throw new Error('NEXT_NOT_FOUND');},useRouter:()=>({push:state.push,refresh:state.refresh,replace:state.replace})}));
vi.mock('../app/payroll/formula-builder/actions',()=>({saveFormulaAction:vi.fn(),testFormulaAction:vi.fn(),formulaStateAction:vi.fn(),deleteFormulaAction:vi.fn(),saveAccumulationAction:vi.fn(),searchFormulaEmployeesAction:vi.fn(),listFormulaBatchesAction:vi.fn()}));
const catalogues={en,ms,zh,ta,th,vi:vietnamese};
const detail:FormulaTraceViewData={formulaId:'FICTIONAL_OT',revisionId:'immutable-revision-2',ordinal:2,contentHash:'d'.repeat(64),componentCode:'FICT_OT',period:'2026-10',amount:'215.67',createdAt:'2026-10-30T04:00:00Z',explanations:['Fictional overtime calculation','<script>never execute explanation</script>'],reads:[{code:'Basic',args:[],loc:{line:2,column:1},value:{type:'decimal',value:'1234.567890123456'}},{code:'EmployeeInformation',args:[{type:'string',value:'nationality'}],loc:{line:3,column:1},value:{type:'string',value:'Fictional nationality'}},{code:'JoinDate',args:[],loc:{line:4,column:1},value:{type:'date',value:'2020-02-29'}},{code:'JoinedThisMonth',args:[],loc:{line:5,column:1},value:{type:'boolean',value:false}}]};
const serviceDetail:PayFormulaEvaluationDetail={...detail,id:'evaluation-1',batchId:'private-batch-id',companyId:'private-company-id',employmentId:'private-employment-id',payload:{explanations:detail.explanations,reads:detail.reads,sources:{privateContext:'INTERNAL_CONTEXT_MUST_NOT_SERIALIZE'}}};
function mount(node:React.ReactNode,locale:keyof typeof catalogues='en'){return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}>{node}</NextIntlClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();state.requireAdmin.mockResolvedValue({tenantId:'fictional-tenant',userId:'fictional-reviewer'});state.read.mockResolvedValue(serviceDetail);});afterEach(cleanup);
const caps={view:true,edit:false,test:false,activate:false,deactivate:false,delete:false};
const options:FormulaBuilderOptions={companies:[],employees:[],cycles:[],payItems:[],activeFormulas:[],accumulations:[],capabilities:caps};
function formula(evaluations:FormulaBuilderView['evaluations']):FormulaBuilderView{const revision={id:detail.revisionId,ordinal:2,description:'Fictional formula',method:'write' as const,source:'Return 1',program:parsePayFormula('Return 1'),contentHash:detail.contentHash,dependencies:[],createdAt:detail.createdAt};return {id:'formula-1',formulaId:detail.formulaId,status:'inactive',activeRevisionId:null,latest:revision,versions:[revision],tests:[],usage:[],idLocked:true,updatedAt:detail.createdAt,capabilities:caps,evaluations};}
describe('authorized immutable payroll formula evidence UI',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s displays exact saved values and typed source labels',locale=>{
  const rendered=mount(<FormulaTraceView evaluation={detail}/>,locale),words=catalogues[locale].payFormula;
  expect(screen.getByRole('heading',{name:words.traceSavedResult})).toBeVisible();expect(screen.getByRole('heading',{name:words.traceExplanations})).toBeVisible();expect(screen.getByRole('heading',{name:words.traceReads})).toBeVisible();expect(screen.getByText(detail.amount)).toBeVisible();expect(screen.getByText(detail.contentHash)).toBeVisible();expect(screen.getByText('1234.567890123456')).toBeVisible();expect(screen.getByText('2020-02-29')).toBeVisible();expect(screen.getByText(words.false)).toBeVisible();expect(screen.getByText(words.functions.Basic)).toBeVisible();expect(rendered.container.querySelector('script')).toBeNull();expect(screen.getByText('<script>never execute explanation</script>')).toBeVisible();
 });
 it('renders actual immutable evidence for desktop and mobile review with fictional source values',async()=>{const rendered=mount(<FormulaTraceView evaluation={detail}/>);await captureAiReviewScreenshots(aiReviewDomHtml(rendered.container),'en','formula-trace','Actual FormulaTraceView; fictional authorized source values; inert rendering; no authenticated server journey or installed acceptance.','atelier');},120000);
 it('projects only authorized product evidence across the server/client boundary',async()=>{
  const page=await FormulaEvaluationPage({params:Promise.resolve({id:'evaluation-1'})});
  expect(state.requireAdmin).toHaveBeenCalledTimes(1);expect(state.read).toHaveBeenCalledWith({tenantId:'fictional-tenant',userId:'fictional-reviewer'},'evaluation-1');
  const trace=React.Children.toArray(page.props.children).find(child=>React.isValidElement(child)&&child.type===FormulaTraceView) as React.ReactElement<{evaluation:FormulaTraceViewData}>;
  expect(trace.props.evaluation).toEqual(detail);expect(JSON.stringify(trace.props)).not.toContain('INTERNAL_CONTEXT_MUST_NOT_SERIALIZE');expect(JSON.stringify(trace.props)).not.toContain('private-employment-id');
  const rendered=mount(page);expect(rendered.container).not.toHaveTextContent('private-company-id');expect(screen.getByRole('link',{name:new RegExp(en.payFormula.title)})).toHaveAttribute('href','/payroll/formula-builder');
 });
 it('uses the same not-found path for absent and currently inaccessible evidence',async()=>{state.read.mockResolvedValue(null);await expect(FormulaEvaluationPage({params:Promise.resolve({id:'unavailable-record'})})).rejects.toThrow('NEXT_NOT_FOUND');expect(state.notFound).toHaveBeenCalledTimes(1);expect(document.body).not.toHaveTextContent(detail.formulaId);});
 it('rechecks the service after a previously permitted record becomes unavailable',async()=>{mount(await FormulaEvaluationPage({params:Promise.resolve({id:'evaluation-1'})}));expect(screen.getByText(detail.formulaId)).toBeVisible();cleanup();state.read.mockResolvedValue(null);await expect(FormulaEvaluationPage({params:Promise.resolve({id:'evaluation-1'})})).rejects.toThrow('NEXT_NOT_FOUND');expect(state.read).toHaveBeenCalledTimes(2);expect(document.body).not.toHaveTextContent(detail.formulaId);});
 it('displays only authorized historical links from the owner payload',()=>{mount(<FormulaEditor initial={formula([{id:'evaluation-1',revisionId:detail.revisionId,componentCode:detail.componentCode,period:detail.period,amount:detail.amount,createdAt:detail.createdAt}])} options={options} readOnly/>);expect(screen.getByRole('link',{name:en.payFormula.traceOpen})).toHaveAttribute('href','/payroll/formula-builder/evaluations/evaluation-1');expect(screen.getByText(en.payFormula.traceHistoryTitle)).toBeVisible();});
 it('uses generic empty history without disclosing hidden calculation records',()=>{mount(<FormulaEditor initial={formula([])} options={options} readOnly/>);expect(screen.getByText(en.payFormula.traceHistoryEmpty)).toBeVisible();expect(screen.queryByRole('link',{name:en.payFormula.traceOpen})).not.toBeInTheDocument();});
 it('renders a localized retry boundary without exposing raw server errors',()=>{const reset=vi.fn();mount(<FormulaEvaluationError error={new Error('PRIVATE SQL AND SOURCE CONTEXT')} reset={reset}/>);expect(screen.getByRole('alert')).not.toHaveTextContent('PRIVATE SQL');fireEvent.click(screen.getByRole('button',{name:en.payFormula.traceRetry}));expect(reset).toHaveBeenCalledTimes(1);});
});
