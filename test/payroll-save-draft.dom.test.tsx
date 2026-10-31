import React,{useEffect} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const calls=vi.hoisted(()=>({save:vi.fn(),process:vi.fn(),resume:vi.fn(),employees:vi.fn()}));
vi.mock('../app/(app)/payroll/process/actions',()=>({savePayrollDraftsAction:calls.save,runMultiCompanyAction:calls.process,resumeRunAction:calls.resume,fetchPayrollRunEmployees:calls.employees}));
vi.mock('next-intl',()=>({useTranslations:()=>((key:string)=>key)}));
vi.mock('@/components/ui',()=>({Button:({children,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>)=><button {...props}>{children}</button>,Card:({children,...props}:React.HTMLAttributes<HTMLDivElement>)=><div {...props}>{children}</div>}));
vi.mock('../app/(app)/payroll/process/steps/step-period',()=>({StepPeriod:({onCompanyIds,onCycleId}:{onCompanyIds:(ids:string[])=>void;onCycleId:(id:string)=>void})=><button onClick={()=>{onCompanyIds(['a','b']);onCycleId('regular-a');}}>Choose both companies</button>}));
vi.mock('../app/(app)/payroll/process/steps/step-selection',()=>({StepSelection:({onSelectedChange,onFiltersTouchedChange}:{onSelectedChange:(ids:Set<string>)=>void;onFiltersTouchedChange:(touched:boolean)=>void})=><button onClick={()=>{onSelectedChange(new Set(['employee-a','employee-b']));onFiltersTouchedChange(true);}}>Choose exact employees</button>}));
vi.mock('../app/(app)/payroll/process/steps/step-validation',()=>({StepValidation:({onStatusChange}:{onStatusChange:(s:{loading:boolean;hasBlockers:boolean})=>void})=>{useEffect(()=>onStatusChange({loading:false,hasBlockers:false}),[onStatusChange]);return <p>Reviewed selection</p>;}}));
import {Wizard} from '../app/(app)/payroll/process/wizard';
const props:React.ComponentProps<typeof Wizard>={companies:[{id:'a',name:'A'},{id:'b',name:'B'}],departments:[],businessUnits:[],positions:[],costCenters:[],jobGrades:[],payDayByCompany:{a:25},existingRuns:[],cyclesByCompany:{a:[{id:'regular-a',name:'Monthly',runType:'regular',remarks:null,description:null}]},defaultCycleByCompany:{a:'Monthly'},thisMonth:'2026-05',multiCycle:false,from:'/payroll?year=2026'};
beforeEach(()=>{vi.clearAllMocks();calls.employees.mockResolvedValue([]);calls.process.mockResolvedValue(undefined);calls.save.mockResolvedValue(undefined);calls.resume.mockResolvedValue(undefined);});
afterEach(cleanup);
async function review(input=props){render(<Wizard {...input}/>);fireEvent.click(screen.getByText('Choose both companies'));await waitFor(()=>expect(screen.getByText('continue')).not.toBeDisabled());fireEvent.click(screen.getByText('continue'));fireEvent.click(screen.getByText('Choose exact employees'));fireEvent.click(screen.getByText('continue'));await screen.findByText('Reviewed selection');}
describe('visible Payroll Save as draft',()=>{
 it('posts the full reviewed selection only to the draft action, with a synchronous double-click guard',async()=>{
  let finish:()=>void=()=>{throw new Error('Not pending');};calls.save.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));await review();
  const save=screen.getByTestId('payroll-save-draft');fireEvent.click(save);fireEvent.click(save);
  await waitFor(()=>expect(calls.save).toHaveBeenCalledTimes(1));expect(calls.process).not.toHaveBeenCalled();
  const form=calls.save.mock.calls[0][0] as FormData;expect(form.getAll('companyIds')).toEqual(['a','b']);expect(form.getAll('employmentIds')).toEqual(['employee-a','employee-b']);expect(form.get('filtersTouched')).toBe('true');expect(form.get('payPeriod')).toBe(props.thisMonth);expect(form.get('payrollCycleId')).toBe('regular-a');expect(form.get('paymentDate')).toBe('2026-05-25');expect(form.get('from')).toBe(props.from);
  await act(async()=>{finish();});
 });
 it('retains normal Process as a separate action with the same explicit selection',async()=>{
  await review();fireEvent.click(screen.getByText('processPayroll'));await waitFor(()=>expect(calls.process).toHaveBeenCalledTimes(1));expect(calls.save).not.toHaveBeenCalled();
  const form=calls.process.mock.calls[0][0] as FormData;expect(form.getAll('companyIds')).toEqual(['a','b']);expect(form.getAll('employmentIds')).toEqual(['employee-a','employee-b']);expect(form.get('filtersTouched')).toBe('true');
 });
 it('explains and disables draft saving for an additional cycle without disabling normal Process',async()=>{
  await review({...props,multiCycle:true,cyclesByCompany:{a:[{id:'regular-a',name:'Bonus',runType:'bonus',remarks:null,description:null}]}});
  expect(screen.getByText('saveDraftRegularOnly')).toBeVisible();expect(screen.getByTestId('payroll-save-draft')).toBeDisabled();expect(screen.getByText('processPayroll')).not.toBeDisabled();
  fireEvent.click(screen.getByTestId('payroll-save-draft'));expect(calls.save).not.toHaveBeenCalled();
 });
 it('keeps all six localized draft/refusal messages and a truthful draft result branch',()=>{
  const keys=['saveAsDraft','draftSaving','saveDraftHelp','saveDraftRegularOnly','draftResultTitle','draftResultSubtitle','draftCompanySaved'];
  for(const locale of ['en','ms','zh','ta','th','vi']){const messages=JSON.parse(readFileSync(resolve(process.cwd(),'messages',locale+'.json'),'utf8')).payroll.process;for(const key of keys)expect(messages[key]).toEqual(expect.any(String));for(const reason of ['EMPTY_SELECTION','INVALID_SELECTION','DRAFT_REQUIRES_REGULAR'])expect(messages.reason[reason]).toEqual(expect.any(String));}
  const page=readFileSync(resolve(process.cwd(),'app/(app)/payroll/process/result/page.tsx'),'utf8'),start=page.indexOf("if (result.mode === 'draft')"),end=page.indexOf('// Phase-1 failed-employee table:',start);expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);const draft=page.slice(start,end);expect(draft.length).toBeGreaterThan(500);expect(draft).toContain('draftResultSubtitle');expect(draft).toContain('draftCompanySaved');expect(draft).not.toContain('totalEmployeesSucceeded');expect(draft).not.toContain('listSkippedEmployees');
 });
});
