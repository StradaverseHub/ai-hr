import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import viMessages from '../messages/vi.json';import ta from '../messages/ta.json';import th from '../messages/th.json';
import {AttendanceFormulaEditor} from '../app/admin/attendance/settings/formula-builder/editor';
const mocks=vi.hoisted(()=>({draft:vi.fn(),save:vi.fn(),test:vi.fn(),activate:vi.fn(),status:vi.fn(),read:vi.fn(),search:vi.fn(),replace:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:mocks.replace})}));
vi.mock('../app/admin/attendance/settings/formula-builder/actions',()=>({draftAttendanceFormulaAction:mocks.draft,saveAttendanceFormulaAction:mocks.save,testAttendanceFormulaAction:mocks.test,activateAttendanceFormulaAction:mocks.activate,statusAttendanceFormulaAction:mocks.status,readAttendanceFormulaTestAction:mocks.read,searchAttendanceFormulaEmployeesAction:mocks.search}));
vi.mock('../app/admin/attendance-allowance/actions',()=>({searchAllowanceEmployees:vi.fn(async()=>({rows:[],total:0,unavailable:[]})),searchAllowanceEmployeeValues:vi.fn(async()=>({rows:[],hasMore:false}))}));
const companyId='10000000-0000-4000-8000-000000000001',payItemId='20000000-0000-4000-8000-000000000001';
const options={companies:[{id:companyId,label:'Fictional formula company',currency:'MYR'}],payItems:[{id:payItemId,code:'ATTENDANCE',name:'Fictional attendance earning',kind:'allowance',companyIds:[companyId]}]};
const catalogs={en,ms,zh,vi:viMessages,ta,th};
function mount(locale:keyof typeof catalogs='en'){const errors:unknown[]=[];render(<NextIntlClientProvider locale={locale} messages={catalogs[locale]} onError={error=>errors.push(error)}><AttendanceFormulaEditor initial={null} options={options} today="2026-11-08"/></NextIntlClientProvider>);return errors;}
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();});
describe('attendance authoring remains an explicit unsaved draft',()=>{
 it.each(Object.keys(catalogs) as (keyof typeof catalogs)[])('renders real controls and condition fields in %s without missing translations',locale=>{
  const errors=mount(locale),t=catalogs[locale].attendanceFormula;
  expect(screen.getByText(t.unsaved)).toBeTruthy();expect(screen.getByRole('button',{name:t.save})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:t.conditions}));fireEvent.click(screen.getByRole('button',{name:t.addCondition}));
  expect(screen.getByLabelText(t.conditionId)).toBeTruthy();expect(screen.getByLabelText(t.conditionExpression)).toBeTruthy();
  expect(screen.getByRole('combobox',{name:t.returnType})).toHaveValue('decimal');expect(errors).toEqual([]);
  expect(mocks.save).not.toHaveBeenCalled();expect(mocks.activate).not.toHaveBeenCalled();
 });
 it('inserts the exact stable variable ID into the unsaved source and supports criteria without activation',()=>{
  mount();fireEvent.change(screen.getByLabelText(en.attendanceFormula.code),{target:{value:'WORKED'}});
  fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.variables}));fireEvent.change(screen.getByLabelText(en.attendanceFormula.searchVariables),{target:{value:'ZoneAWorkingMins'}});
  const variable=screen.getByText('ZoneAWorkingMins').parentElement!;expect(within(variable).getByText('Before Shift Working Mins · minutes')).toBeTruthy();fireEvent.click(within(variable.parentElement!).getByRole('button',{name:en.attendanceFormula.insert}));
  expect(screen.getByRole('textbox',{name:en.attendanceFormula.formulaExpression})).toHaveValue('{#FormulaID}("ZoneAWorkingMins")');
  fireEvent.change(screen.getByLabelText(en.attendanceFormula.employeeSelection),{target:{value:'criteria'}});expect(screen.getByText(en.allowanceV4.employeeGroup)).toBeTruthy();
  expect(mocks.save).not.toHaveBeenCalled();expect(mocks.activate).not.toHaveBeenCalled();
 });
 it('submits only the reviewed draft configuration and surfaces an owner refusal without inventing a saved state',async()=>{
  mocks.save.mockResolvedValue({ok:false,error:'Fictional scoped owner refusal'});mount();
  fireEvent.change(screen.getByLabelText(en.attendanceFormula.code),{target:{value:'WORKED'}});fireEvent.change(screen.getByLabelText(en.attendanceFormula.description),{target:{value:'Fictional worked amount'}});fireEvent.change(screen.getByLabelText(en.attendanceFormula.payItem),{target:{value:payItemId}});fireEvent.change(screen.getByRole('textbox',{name:en.attendanceFormula.formulaExpression}),{target:{value:'Return {#FormulaID}("TotalWorkingMins") / 60 * 10'}});
  fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.save}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('Fictional scoped owner refusal'));
  expect(mocks.save).toHaveBeenCalledWith({id:undefined,expectedRevisionId:undefined,configuration:expect.objectContaining({code:'WORKED',companyId,payItemId,eligibility:{mode:'all'}})});expect(mocks.test).not.toHaveBeenCalled();expect(mocks.activate).not.toHaveBeenCalled();expect(mocks.replace).not.toHaveBeenCalled();
 });
});

it('requires explicit disclosure and applies a proposal only to the unsaved draft',async()=>{
 mocks.draft.mockResolvedValue({ok:true,value:{source:'Return 1',conditions:[],explanation:'Fictional proposal',questions:[],assumptions:[],valid:true}});mount();
 fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.ai}));fireEvent.change(screen.getByLabelText(en.attendanceFormula.aiRequirement),{target:{value:'Fictional attendance rule'}});
 expect(screen.getByRole('button',{name:en.attendanceFormula.aiGenerate})).toBeDisabled();fireEvent.click(screen.getByRole('checkbox',{name:en.attendanceFormula.aiDisclosure}));fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.aiGenerate}));
 await waitFor(()=>expect(screen.getByText('Fictional proposal')).toBeTruthy());expect(mocks.draft).toHaveBeenCalledWith({companyId,requirement:'Fictional attendance rule',disclosureAccepted:true});
 fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.aiApply}));expect(screen.getByRole('textbox',{name:en.attendanceFormula.formulaExpression})).toHaveValue('Return 1');expect(mocks.save).not.toHaveBeenCalled();expect(mocks.activate).not.toHaveBeenCalled();
});
