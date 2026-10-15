import React from 'react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import type {OvertimeEvaluation,OvertimePattern} from '../lib/overtime-pattern-model';
import {todayInKualaLumpur} from '../lib/hr-date';
const mocks=vi.hoisted(()=>({employee:vi.fn(),sample:vi.fn(),review:vi.fn(),calculate:vi.fn(),transfer:vi.fn(),choices:vi.fn()}));
vi.mock('../app/admin/attendance/settings/overtime-patterns/actions',()=>({previewOvertimeEmployeeAction:mocks.employee,previewOvertimeSampleAction:mocks.sample,readOvertimeTransferAction:mocks.review,calculateOvertimeDayAction:mocks.calculate,transferOvertimePayrollAction:mocks.transfer,overtimeChoicesAction:mocks.choices}));
import {OvertimePreviewPanel} from '../components/overtime-patterns/preview-panel';
const words=en.overtimePatterns;
const id='00000000-0000-4000-8000-000000000001',versionId='00000000-0000-4000-8000-000000000002',batchId='00000000-0000-4000-8000-000000000003';
const date=todayInKualaLumpur();
const pattern:OvertimePattern={v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',eligibility:{id:'eligible',type:'constant',value:true},eligibleMinutes:null,durationCap:null,durationRounding:null,deductions:[],rates:[],paymentCap:null,moneyRounding:{stage:'line',mode:'halfUp'}};
const evaluation:OvertimeEvaluation={status:'ready',source:{tenantId:id,employmentId:id,attendanceId:id,date,inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64)},patternVersionId:versionId,assignmentId:id,transferable:false,currency:pattern.currency,rawMinutes:{state:'known',value:{unit:'minutes',numerator:'120',denominator:'1'}},eligibleMinutes:{state:'known',value:{unit:'minutes',numerator:'120',denominator:'1'}},approvedMinutes:{state:'known',value:{unit:'minutes',numerator:'120',denominator:'1'}},payableMinutes:{unit:'minutes',numerator:'120',denominator:'1'},amountMinorUnits:'12345',lines:[],trace:[]};
const review={options:{companyId:id,currency:'MYR',employmentId:id,date,calculation:{id:'saved-calculation',sourceRevision:4,status:'ready',approvalStatus:'approved',transferable:true,amountMinorUnits:'12345',minorScale:2},runs:[{id:batchId,payPeriod:date.slice(0,7),runType:'regular',batchDate:date,cycleName:'Fictional cycle',status:'draft'}],settlement:null},recorded:{sourceId:id,sourceRevision:4,calculationId:'saved-calculation',status:'ready',approvalStatus:'approved',evaluation:{...evaluation,transferable:true},recordedAt:new Date().toISOString()}};
function mount(disabled=false){render(<NextIntlClientProvider locale="en" messages={en}><OvertimePreviewPanel patternId={id} versionId={versionId} pattern={pattern} employees={[{id,companyId:id,name:'Fictional Employee',employeeCode:'SYNTH-01'}]} choices={{dayType:[{id:'workday',label:'Workday'}]}} disabled={disabled}/></NextIntlClientProvider>);}
function chooseEmployee(){fireEvent.change(screen.getByLabelText(words.employees),{target:{value:id}});fireEvent.change(screen.getByLabelText(words.attendanceDate),{target:{value:date}});}
beforeEach(()=>{cleanup();vi.clearAllMocks();mocks.choices.mockResolvedValue({ok:true,value:{employees:[],employeeNextCursor:null}});mocks.employee.mockResolvedValue({ok:true,value:evaluation});mocks.sample.mockResolvedValue({ok:true,value:evaluation});mocks.review.mockResolvedValue({ok:true,value:review});mocks.transfer.mockResolvedValue({ok:false,code:'stale'});});

describe('preview and actual Payroll are separate operations',()=>{
 it('previews the saved authorized employee without creating an actual calculation or transfer',async()=>{
  mount();chooseEmployee();fireEvent.click(screen.getByRole('button',{name:words.runPreview}));
  await waitFor(()=>expect(mocks.employee).toHaveBeenCalledExactlyOnceWith({patternId:id,versionId,employmentId:id,date}));
  expect(await screen.findByText('MYR 123.45')).toBeVisible();expect(mocks.calculate).not.toHaveBeenCalled();expect(mocks.transfer).not.toHaveBeenCalled();
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
 it('refuses UI transfer when the source is claimed for TOIL',async()=>{
  mocks.review.mockResolvedValue({ok:true,value:{...review,options:{...review.options,settlement:{id:'toil-claim',mode:'toil',batchId:null}}}});
  mount();chooseEmployee();fireEvent.click(screen.getByRole('button',{name:words.reviewActual}));await waitFor(()=>expect(screen.getByText(new RegExp(words.toilClaimed))).toBeVisible());
  expect(screen.getByRole('button',{name:words.transfer})).toBeDisabled();expect(mocks.transfer).not.toHaveBeenCalled();
 });
 it('keeps preview and financial buttons unavailable for unsaved changes',()=>{
  mount(true);expect(screen.getByText(words.saveBeforePreview)).toBeVisible();expect(screen.getByRole('button',{name:words.runPreview})).toBeDisabled();expect(screen.getByRole('button',{name:words.reviewActual})).toBeDisabled();
 });
});
