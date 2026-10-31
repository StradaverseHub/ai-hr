import React from 'react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import zh from '../messages/zh.json';
const catalogues={en,ms,ta,th,vi:viMessages,zh};
import type {OvertimeEvaluation,OvertimePattern} from '../lib/overtime-pattern-model';
import {todayInKualaLumpur} from '../lib/hr-date';
const mocks=vi.hoisted(()=>({employee:vi.fn(),sample:vi.fn(),review:vi.fn(),calculate:vi.fn(),transfer:vi.fn(),choices:vi.fn()}));
vi.mock('../app/(app)/admin/attendance/settings/overtime-patterns/actions',()=>({previewOvertimeEmployeeAction:mocks.employee,previewOvertimeSampleAction:mocks.sample,readOvertimeTransferAction:mocks.review,calculateOvertimeDayAction:mocks.calculate,transferOvertimePayrollAction:mocks.transfer,overtimeChoicesAction:mocks.choices}));
import {OvertimePreviewPanel} from '../components/overtime-patterns/preview-panel';
const words=en.overtimePatterns;
const id='00000000-0000-4000-8000-000000000001',versionId='00000000-0000-4000-8000-000000000002',batchId='00000000-0000-4000-8000-000000000003';
const date=todayInKualaLumpur();
const pattern:OvertimePattern={v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'earliest',eligibility:{id:'eligible',type:'constant',value:true},eligibleMinutes:null,durationCap:null,durationRounding:null,deductions:[],rates:[],paymentCap:null,moneyRounding:{stage:'line',mode:'halfUp'}};
const evaluation:OvertimeEvaluation={status:'ready',source:{tenantId:id,employmentId:id,attendanceId:id,date,inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64)},patternVersionId:versionId,assignmentId:id,transferable:false,currency:pattern.currency,rawMinutes:{state:'known',value:{unit:'minutes',numerator:'120',denominator:'1'}},eligibleMinutes:{state:'known',value:{unit:'minutes',numerator:'120',denominator:'1'}},approvedMinutes:{state:'known',value:{unit:'minutes',numerator:'120',denominator:'1'}},payableMinutes:{unit:'minutes',numerator:'120',denominator:'1'},amountMinorUnits:'12345',lines:[],trace:[]};
const review={options:{companyId:id,currency:'MYR',employmentId:id,date,calculation:{id:'saved-calculation',sourceRevision:4,status:'ready',approvalStatus:'approved',transferable:true,amountMinorUnits:'12345',minorScale:2},runs:[{id:batchId,payPeriod:date.slice(0,7),runType:'regular',batchDate:date,cycleName:'Fictional cycle',status:'draft',transferable:true,refusal:null}],settlement:null},recorded:{sourceId:id,sourceRevision:4,calculationId:'saved-calculation',status:'ready',approvalStatus:'approved',evaluation:{...evaluation,transferable:true},recordedAt:new Date().toISOString()}};
function mount(disabled=false,locale:keyof typeof catalogues='en'){render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}><OvertimePreviewPanel patternId={id} versionId={versionId} pattern={pattern} earningItems={[{id:batchId,label:'Fictional authorized OT earning'}]} employees={[{id,companyId:id,name:'Fictional Employee',employeeCode:'SYNTH-01'}]} choices={{dayType:[{id:'workday',label:'Workday'}]}} disabled={disabled}/></NextIntlClientProvider>);}
function chooseEmployee(){fireEvent.change(screen.getByLabelText(words.employees),{target:{value:id}});fireEvent.change(screen.getByLabelText(words.attendanceDate),{target:{value:date}});}
beforeEach(()=>{cleanup();vi.clearAllMocks();mocks.choices.mockResolvedValue({ok:true,value:{employees:[],employeeNextCursor:null}});mocks.employee.mockResolvedValue({ok:true,value:evaluation});mocks.sample.mockResolvedValue({ok:true,value:evaluation});mocks.review.mockResolvedValue({ok:true,value:review});mocks.transfer.mockResolvedValue({ok:false,code:'stale'});});

describe('preview and actual Payroll are separate operations',()=>{
 it('previews the saved authorized employee without creating an actual calculation or transfer',async()=>{
  mount();chooseEmployee();fireEvent.click(screen.getByRole('button',{name:words.runPreview}));
  await waitFor(()=>expect(mocks.employee).toHaveBeenCalledExactlyOnceWith({patternId:id,versionId,employmentId:id,date}));
  expect(await screen.findByText('MYR 123.45')).toBeVisible();expect(mocks.calculate).not.toHaveBeenCalled();expect(mocks.transfer).not.toHaveBeenCalled();
 });
 it('passes authorized earning labels to both preview and saved calculation rows',async()=>{
  const minutes={unit:'minutes' as const,numerator:'120',denominator:'1'};
  const value={state:'known' as const,value:minutes};
  const priced={...evaluation,lines:[{id:'line',source:evaluation.source,sessionId:`${id}:day`,segmentId:'segment',rateId:'rate',tierId:'tier',mapping:{earningItemId:batchId,currency:'MYR'},rawMinutes:value,eligibleMinutes:value,approvedMinutes:value,payableMinutes:minutes,gross:{unit:'money' as const,numerator:'12345',denominator:'100'},adjusted:{unit:'money' as const,numerator:'12345',denominator:'100'},amountMinorUnits:'12345'}],trace:[{kind:'duration' as const,id:'input',data:{sessionGranularity:'dayAggregate'}}]};
  mocks.employee.mockResolvedValue({ok:true,value:priced});
  mocks.review.mockResolvedValue({ok:true,value:{...review,recorded:{...review.recorded,evaluation:priced}}});
  mount();chooseEmployee();fireEvent.click(screen.getByRole('button',{name:words.runPreview}));
  expect(await screen.findByText('Fictional authorized OT earning')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:words.reviewActual}));
  await waitFor(()=>expect(screen.getAllByText('Fictional authorized OT earning')).toHaveLength(2));
  for(const table of screen.getAllByRole('table')) {
   const cells=within(within(table).getAllByRole('row')[1]).getAllByRole('cell');
   expect(cells[2].firstElementChild).toHaveTextContent(words.bases.day);
   expect(cells[4].firstElementChild).toHaveTextContent('Fictional authorized OT earning');
   expect(cells[4].lastElementChild).toHaveTextContent(batchId);
  }
 });
 it('retains unknown sample facts and keeps actual Payroll actions unavailable in sample mode',async()=>{
  mount();fireEvent.change(screen.getByLabelText(words.previewMode),{target:{value:'sample'}});fireEvent.change(screen.getByLabelText(words.attendanceDate),{target:{value:date}});
  fireEvent.change(screen.getByLabelText(words.fields.rawMinutes),{target:{value:'120'}});
  expect(screen.getByLabelText(words.knownClock)).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:words.runPreview}));await waitFor(()=>expect(mocks.sample).toHaveBeenCalledOnce());
  const input=mocks.sample.mock.calls[0][0];expect(input.sample.facts).toEqual({});expect(input.sample.approvalMinutes).toBe('');expect(input.sample.segments[0].clockKnown).toBe(false);
  expect(screen.queryByRole('button',{name:words.reviewActual})).toBeNull();expect(mocks.transfer).not.toHaveBeenCalled();
 });
 it('requires a recorded result, run, reason and explicit acknowledgement for transfer, and never reprices a stale source',async()=>{
  mount();chooseEmployee();expect(screen.queryByRole('button',{name:words.transfer})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:words.reviewActual}));await waitFor(()=>expect(screen.getByRole('button',{name:words.transfer})).toBeDisabled());
  fireEvent.change(screen.getByLabelText(words.reason),{target:{value:'Reviewed fictional source'}});fireEvent.change(screen.getByLabelText(words.payrollRun),{target:{value:batchId}});fireEvent.click(screen.getByLabelText(words.transferAcknowledgement));
  fireEvent.click(screen.getByRole('button',{name:words.transfer}));
  await waitFor(()=>expect(mocks.transfer).toHaveBeenCalledExactlyOnceWith({employmentId:id,date,expectedCalculationId:'saved-calculation',expectedSourceRevision:4,batchId,reason:'Reviewed fictional source'}));
  expect(await screen.findByText(words.errors.stale)).toBeVisible();expect(mocks.calculate).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:words.transfer})).toBeDisabled();
 });
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders stale-transfer guidance with the canonical translated action in %s',async locale=>{
  const labels=catalogues[locale].overtimePatterns;
  mocks.review.mockResolvedValue({ok:true,value:{...review,options:{...review.options,calculation:{...review.options.calculation,transferable:false},runs:[{...review.options.runs[0],transferable:false,refusal:'stale'}]}}});
  mount(false,locale);
  fireEvent.change(screen.getByLabelText(labels.employees),{target:{value:id}});
  fireEvent.change(screen.getByLabelText(labels.attendanceDate),{target:{value:date}});
  fireEvent.click(screen.getByRole('button',{name:labels.reviewActual}));
  await screen.findByRole('button',{name:labels.transfer});
  fireEvent.change(screen.getByLabelText(labels.payrollRun),{target:{value:batchId}});
  expect(screen.getByText(labels.transferStaleHelp.replace('{action}',labels.calculateActual))).toBeVisible();
  expect(screen.getByRole('button',{name:labels.transfer})).toBeDisabled();expect(mocks.calculate).not.toHaveBeenCalled();
 });
 it('explains a selected stale target without treating another ready target as permission to transfer',async()=>{
  const otherBatch='00000000-0000-4000-8000-000000000005';
  mocks.review.mockResolvedValue({ok:true,value:{...review,options:{...review.options,runs:[
   {...review.options.runs[0],transferable:false,refusal:'stale'},
   {...review.options.runs[0],id:otherBatch,transferable:true,refusal:null},
  ]}}});
  mount();chooseEmployee();fireEvent.click(screen.getByRole('button',{name:words.reviewActual}));
  await screen.findByRole('button',{name:words.transfer});
  fireEvent.change(screen.getByLabelText(words.reason),{target:{value:'Reviewed fictional source'}});
  fireEvent.change(screen.getByLabelText(words.payrollRun),{target:{value:batchId}});
  fireEvent.click(screen.getByLabelText(words.transferAcknowledgement));
  expect(screen.getByRole('button',{name:words.transfer})).toBeDisabled();
  expect(screen.getByText(words.transferStaleHelp.replace('{action}',words.calculateActual))).toBeVisible();
  expect(mocks.calculate).not.toHaveBeenCalled();expect(mocks.transfer).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(words.payrollRun),{target:{value:otherBatch}});
  expect(screen.queryByText(words.transferStaleHelp.replace('{action}',words.calculateActual))).toBeNull();
  expect(screen.getByRole('button',{name:words.transfer})).toBeDisabled();
  fireEvent.click(screen.getByLabelText(words.transferAcknowledgement));
  expect(screen.getByRole('button',{name:words.transfer})).toBeEnabled();
  fireEvent.change(screen.getByLabelText(words.previewMode),{target:{value:'sample'}});
  expect(screen.queryByRole('button',{name:words.transfer})).toBeNull();
  expect(screen.queryByText(words.transferStaleHelp.replace('{action}',words.calculateActual))).toBeNull();
 });
 it.each(['mapping','statutoryFloor','currency','approval','unavailable'] as const)('shows the selected target’s safe %s explanation',async refusal=>{
  mocks.review.mockResolvedValue({ok:true,value:{...review,options:{...review.options,calculation:{...review.options.calculation,transferable:false},runs:[{...review.options.runs[0],transferable:false,refusal}]}}});
  mount();chooseEmployee();fireEvent.click(screen.getByRole('button',{name:words.reviewActual}));
  await screen.findByRole('button',{name:words.transfer});
  fireEvent.change(screen.getByLabelText(words.payrollRun),{target:{value:batchId}});
  expect(screen.getByText(words.errors[refusal])).toBeVisible();
  expect(screen.getByRole('button',{name:words.transfer})).toBeDisabled();expect(mocks.calculate).not.toHaveBeenCalled();
 });
 it('refuses UI transfer when the source is claimed for TOIL',async()=>{
  mocks.review.mockResolvedValue({ok:true,value:{...review,options:{...review.options,settlement:{id:'toil-claim',mode:'toil',batchId:null}}}});
  mount();chooseEmployee();fireEvent.click(screen.getByRole('button',{name:words.reviewActual}));await waitFor(()=>expect(screen.getByText(new RegExp(words.toilClaimed))).toBeVisible());
  expect(screen.getByRole('button',{name:words.transfer})).toBeDisabled();expect(mocks.transfer).not.toHaveBeenCalled();
 });
 it('shows ready recorded duration separately when cash pricing is refused, without enabling transfer',async()=>{
  const duration={status:'ready',source:evaluation.source,patternVersionId:versionId,assignmentId:id,mode:'actual',transferable:true,rawMinutes:evaluation.rawMinutes,eligibleMinutes:evaluation.eligibleMinutes,approvedMinutes:evaluation.approvedMinutes,payableMinutes:evaluation.payableMinutes,trace:[]};
  const refused={status:'refused',source:evaluation.source,patternVersionId:versionId,assignmentId:id,transferable:false,issues:[{code:'unknown',path:'facts.basicSalary',severity:'error',detail:'Missing recorded salary'}],trace:[]};
  mocks.review.mockResolvedValue({ok:true,value:{...review,options:{...review.options,calculation:{...review.options.calculation,status:'refused',transferable:false,amountMinorUnits:null}},recorded:{...review.recorded,status:'refused',durationStatus:'ready',duration,evaluation:refused}}});
  mount();chooseEmployee();fireEvent.click(screen.getByRole('button',{name:words.reviewActual}));
  expect(await screen.findByRole('region',{name:words.durationResult})).toBeVisible();expect(screen.getByText(words.cashResult)).toBeVisible();
  expect(screen.getByText(words.errors.unknown)).toBeVisible();expect(screen.getByRole('button',{name:words.transfer})).toBeDisabled();expect(mocks.transfer).not.toHaveBeenCalled();
 });
 it('keeps preview and financial buttons unavailable for unsaved changes',()=>{
  mount(true);expect(screen.getByText(words.saveBeforePreview)).toBeVisible();expect(screen.getByRole('button',{name:words.runPreview})).toBeDisabled();expect(screen.getByRole('button',{name:words.reviewActual})).toBeDisabled();
 });
});
