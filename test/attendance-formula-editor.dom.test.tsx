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
const options={canSelectAll:false,companies:[{id:companyId,label:'Fictional formula company',currency:'MYR'}],payItems:[{id:payItemId,code:'ATTENDANCE',name:'Fictional attendance earning',kind:'allowance' as const,companyIds:[companyId]}]};
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
 await waitFor(()=>expect(screen.getByRole('button',{name:en.attendanceFormula.aiApply})).toBeEnabled()); fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.aiApply}));expect(screen.getByRole('textbox',{name:en.attendanceFormula.formulaExpression})).toHaveValue('Return 1');expect(mocks.save).not.toHaveBeenCalled();expect(mocks.activate).not.toHaveBeenCalled();
});

it('requires a saved version, an actual test and an explicit review before activation',async()=>{
 const id='30000000-0000-4000-8000-000000000001',revisionId='40000000-0000-4000-8000-000000000001',employeeId='50000000-0000-4000-8000-000000000001',testId='60000000-0000-4000-8000-000000000001';
 const definition={code:'WORKED',description:'Fictional worked hours',companyId,payItemId,effectiveFrom:'2026-01-01',period:{method:'daily'},outputUnit:'hours',purpose:'earning',eligibility:{mode:'all'},posting:{kind:'exclusive'},library:{formulas:[{code:'WORKED',source:'Return {#FormulaID}("TotalWorkingMins") / 60'}],conditions:[]}};
 const saved={formula:{id,companyId,code:'WORKED'},latest:{id:revisionId,ordinal:1,definition},versions:[{id:revisionId,ordinal:1,createdAt:new Date('2026-11-08T00:00:00Z')}],tests:[],events:[],status:'inactive',activeRevisionId:null,activeOrdinal:null};
 const proof={id:testId,revisionId,employmentId:employeeId,periodFrom:'2026-11-08',periodTo:'2026-11-08',payload:{result:{amount:'8',trace:[{formula:'WORKED',event:{kind:'read',code:'FormulaID',value:{type:'decimal',value:'480'},loc:{line:1,column:8,offset:7}},request:{code:'FormulaID',args:[{type:'string',value:'TotalWorkingMins'}],loc:{line:1,column:8,offset:7}}},{formula:'WORKED',event:{kind:'arithmetic',operator:'/',left:'480',right:'60',result:'8',loc:{line:1,column:8,offset:7}}},{formula:'WORKED',event:{kind:'return',value:{type:'decimal',value:'8'},loc:{line:1,column:1,offset:0}}}]},days:[]}};
 mocks.search.mockResolvedValue({ok:true,value:{rows:[{id:employeeId,code:'FX001',name:'Fictional employee'}],hasMore:false,period:{from:'2026-11-08',to:'2026-11-08'}}});mocks.search.mockResolvedValueOnce({ok:true,value:{rows:[],hasMore:false,period:{from:'2026-11-08',to:'2026-11-08'}}});mocks.test.mockResolvedValue({ok:true,value:{proof,saved}});mocks.activate.mockResolvedValue({ok:true,value:{...saved,status:'active',activeRevisionId:revisionId,activeOrdinal:1}});
 render(<NextIntlClientProvider locale="en" messages={en}><AttendanceFormulaEditor initial={saved as unknown as NonNullable<Parameters<typeof AttendanceFormulaEditor>[0]['initial']>} options={options} today="2026-11-08"/></NextIntlClientProvider>);
 expect(screen.getByRole('button',{name:en.attendanceFormula.runTest})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.search}));await waitFor(()=>expect(screen.getByText(en.attendanceFormula.noEmployeeResults)).toBeTruthy());await waitFor(()=>expect(screen.getByRole('button',{name:en.attendanceFormula.search})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.search}));await waitFor(()=>expect(screen.getByLabelText(en.attendanceFormula.employee)).toBeTruthy());fireEvent.change(screen.getByLabelText(en.attendanceFormula.employee),{target:{value:employeeId}});fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.runTest}));
 await waitFor(()=>expect(screen.getByText('Result: 8')).toBeTruthy());expect(screen.getByText('Read FormulaID(TotalWorkingMins): 480')).toBeTruthy();expect(screen.getByText('Returned 8')).toBeTruthy();expect(mocks.test).toHaveBeenCalledWith({id,revisionId,employmentId:employeeId,date:'2026-11-08'});expect(mocks.activate).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:en.attendanceFormula.activate})).toBeDisabled();fireEvent.click(screen.getByRole('checkbox',{name:en.attendanceFormula.activationReview}));fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.activate}));
 await waitFor(()=>expect(screen.getByText('Currently active: version 1')).toBeTruthy());expect(mocks.activate).toHaveBeenCalledWith({id,revisionId,testId});fireEvent.change(screen.getByLabelText(en.attendanceFormula.description),{target:{value:'Fictional unsaved next version'}});expect(screen.getByRole('button',{name:en.attendanceFormula.runTest})).toBeDisabled();expect(screen.getByRole('button',{name:en.attendanceFormula.activate})).toBeDisabled();
});

it('adopts the canonical saved definition so trimmed input is ready to test',async()=>{
 mocks.save.mockImplementation(async({configuration})=>{const definition={...configuration,description:configuration.description.trim()};return {ok:true,value:{formula:{id:'30000000-0000-4000-8000-000000000001',companyId,code:definition.code},latest:{id:'40000000-0000-4000-8000-000000000001',ordinal:1,definition},versions:[],tests:[],events:[],status:'inactive',activeRevisionId:null,activeOrdinal:null}};});mount();
 fireEvent.change(screen.getByLabelText(en.attendanceFormula.code),{target:{value:'WORKED'}});fireEvent.change(screen.getByLabelText(en.attendanceFormula.description),{target:{value:'  Fictional draft with outer spaces  '}});fireEvent.change(screen.getByLabelText(en.attendanceFormula.payItem),{target:{value:payItemId}});fireEvent.change(screen.getByRole('textbox',{name:en.attendanceFormula.formulaExpression}),{target:{value:'Return 1'}});fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.save}));await waitFor(()=>expect(screen.getByLabelText(en.attendanceFormula.description)).toHaveValue('Fictional draft with outer spaces'));expect(screen.getByRole('button',{name:en.attendanceFormula.save})).toBeDisabled();expect(screen.getByText(en.attendanceFormula.savedHelp)).toBeTruthy();expect(mocks.test).not.toHaveBeenCalled();
});

it('shows invalid condition identity beside Save and restores authoring after correction',()=>{
 mount();fireEvent.change(screen.getByLabelText(en.attendanceFormula.code),{target:{value:'WORKED'}});
 fireEvent.change(screen.getByRole('textbox',{name:en.attendanceFormula.formulaExpression}),{target:{value:'Return {#ConditionID}("CONDITION_1")'}});
 fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.conditions}));fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.addCondition}));
 const input=screen.getByRole('textbox',{name:en.attendanceFormula.conditionExpression});fireEvent.change(input,{target:{value:'Return process.env.SECRET'}});
 const save=screen.getByRole('button',{name:en.attendanceFormula.save});expect(save).toBeDisabled();expect(document.getElementById(save.getAttribute('aria-describedby')!)?.textContent).toContain('CONDITION_1:');
 fireEvent.change(input,{target:{value:'If True Then\nReturn 1\nElse\nReturn 0\nEnd If'}});fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.formatSource}));
 expect(input).toHaveValue('If True Then\n    Return 1\nElse\n    Return 0\nEnd If');expect(save).toBeEnabled();expect(mocks.save).not.toHaveBeenCalled();
});
it('indents the next source line without intercepting Tab navigation',()=>{
 mount();const input=screen.getByRole('textbox',{name:en.attendanceFormula.formulaExpression}) as HTMLTextAreaElement;
 fireEvent.change(input,{target:{value:'If True Then'}});input.setSelectionRange(12,12);fireEvent.keyDown(input,{key:'Enter'});expect(input.value).toBe('If True Then\n    ');
 expect(fireEvent.keyDown(input,{key:'Tab'})).toBe(true);expect(mocks.save).not.toHaveBeenCalled();
});

it('defaults authorised whole-organisation drafts to all companies and filters Pay Items against every selected company',()=>{
 const other='10000000-0000-4000-8000-000000000002',limited='20000000-0000-4000-8000-000000000002',t=en.attendanceFormula;
 const groupOptions={canSelectAll:true,companies:[...options.companies,{id:other,label:'Fictional company B',currency:'MYR'}],
  payItems:[{...options.payItems[0],companyIds:[companyId,other]},
   {id:limited,code:'LIMITED',name:'Company A only',kind:'allowance' as const,companyIds:[companyId]}]};
 render(<NextIntlClientProvider locale="en" messages={en}><AttendanceFormulaEditor initial={null} options={groupOptions} today="2026-11-08"/></NextIntlClientProvider>);
 const all=screen.getByRole('checkbox',{name:t.allCompanies});
 expect(all).toBeChecked();
 expect(within(screen.getByLabelText(t.payItem)).queryByRole('option',{name:/LIMITED/})).toBeNull();
 fireEvent.click(all);
 const company=screen.getByLabelText('Fictional company B');
 expect(company).toBeChecked();
 fireEvent.click(company);
 expect(within(screen.getByLabelText(t.payItem)).getByRole('option',{name:/LIMITED/})).toBeTruthy();
});
