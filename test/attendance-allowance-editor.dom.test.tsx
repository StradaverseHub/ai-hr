/** Real editor and shared navigation guard. No service imports or mocked policy arithmetic. */
import { describe, expect, it, vi as vitest } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { AttendanceAllowanceEditor } from '../components/attendance-allowance-editor';
import { emptyAllowanceRules,emptyAllowanceRulesV4 } from '../lib/attendance-allowance-rules';
import type {AllowanceEmployeePageInput} from '../core/attendance-allowance-selection';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';
const { router, search } = vitest.hoisted(() => ({router: {push: vitest.fn(), refresh: vitest.fn()},search:vitest.fn()}));
vitest.mock('../app/(app)/admin/attendance-allowance/actions',()=>({searchAllowanceEmployees:search}));
vitest.mock('next/navigation', () => ({useRouter: () => router, usePathname: () => '/admin/attendance-allowance/create'}));
const catalogs = {en,ms,ta,th,vi,zh};
const companyId = '11111111-1111-4111-8111-111111111111';
const employeeId = '22222222-2222-4222-8222-222222222222';
const earningId = '33333333-3333-4333-8333-333333333333';
const deductionId = '44444444-4444-4444-8444-444444444444';
const options = {
  companies:[{id:companyId,label:'Example company',currency:'MYR'}],
  departments:[{id:'55555555-5555-4555-8555-555555555555',label:'Finance',companyId,isGlobal:false,assignedCompanyIds:[]}],
  businessUnits:[],positions:[],grades:[],categories:[],shifts:[],leaveTypes:[],
  employees:[{id:employeeId,label:'Example employee',companyId,category:null}],
};
search.mockImplementation(async({side,included}:AllowanceEmployeePageInput)=>{
  const visible=side==='included'?included.includes(employeeId):!included.includes(employeeId);
  return {rows:visible?[{id:employeeId,code:'EX001',name:'Example employee',department:'Finance',businessUnit:null}]:[],total:visible?1:0,unavailable:[]};
});
const components = [{id:earningId,code:'ATTENDANCE',name:'Attendance earning',kind:'allowance'},{id:deductionId,code:'ATT_DEDUCT',name:'Attendance deduction',kind:'deduction'}];
const submit = vitest.fn(async () => ({error:'Synthetic validation refusal'}));
function mount(locale:keyof typeof catalogs='en',policy?:Parameters<typeof AttendanceAllowanceEditor>[0]['policy'],setup:Parameters<typeof AttendanceAllowanceEditor>[0]['options']=options) {
  const errors:unknown[]=[];
  render(<NextIntlClientProvider locale={locale} messages={catalogs[locale]} onError={error=>errors.push(error)}><AttendanceAllowanceEditor options={setup} components={components} policy={policy} action={submit}/></NextIntlClientProvider>);
  return errors;
}
const form = () => document.getElementById('attendance-allowance-editor') as HTMLFormElement;
const submittedRules = () => JSON.parse(String(new FormData(form()).get('rules')));

describe('four-section allowance editor', () => {
  it('clears the visible leave-type choice when changing to a different leave measure, matching the saved rule',async()=>{
    const leaveId='77777777-7777-4777-8777-777777777777';
    mount('en',undefined,{...options,leaveTypes:[{id:leaveId,label:'Annual leave',companyId,archived:false}]});
    const user=userEvent.setup(),t=en.allowanceV2,v=en.allowanceV3;
    await user.click(screen.getByRole('button',{name:t.addAttendanceCriterion}));
    await user.selectOptions(screen.getByLabelText(t.field),'leaveDays');
    await user.click(screen.getByRole('button',{name:v.leaveTypes}));
    await user.click(screen.getByRole('checkbox',{name:'Annual leave'}));
    expect(submittedRules().attendance.expression.children[0].leaveTypeIds).toEqual([leaveId]);
    expect(screen.getByRole('button',{name:'Remove Annual leave'})).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(t.field),'leaveCount');
    expect(submittedRules().attendance.expression.children[0].leaveTypeIds).toEqual([]);
    expect(screen.queryByRole('button',{name:'Remove Annual leave'})).not.toBeInTheDocument();
  });

  it('keeps current flat draft edits when explicitly switching to grouped conditions and requires review again',async()=>{
    const rules=emptyAllowanceRules();rules.attendance.criteria=[{field:'actualMinutes',operator:'gte',value:'8',unit:'hours'}];
    const policy={id:'66666666-6666-4666-8666-666666666666',tenantId:companyId,companyId,code:'V2',name:'Existing flat policy',method:'daily',amount:'20.00',payComponentId:earningId,effectiveFrom:'2025-01-01',status:'active',policyType:'earning',version:2,rules,criteria:{},scope:{},archivedAt:null,createdAt:new Date('2025-01-01T00:00:00Z')};
    mount('en',policy);const user=userEvent.setup(),t=en.allowanceV2;
    expect(submittedRules().v).toBe(2);
    fireEvent.change(screen.getByLabelText(t.threshold),{target:{value:'9.5'}});
    await user.click(screen.getByRole('checkbox',{name:t.reviewConfirm}));
    await user.click(screen.getByRole('button',{name:en.allowanceV3.upgrade}));
    expect(submittedRules()).toMatchObject({v:3,attendance:{expression:{type:'group',children:[{field:'actualMinutes',value:'9.5',unit:'hours'}]}}});
    expect(screen.getByRole('checkbox',{name:t.reviewConfirm})).not.toBeChecked();
    expect(screen.getByRole('button',{name:en.allowanceV3.savePreview})).toBeDisabled();
    expect(rules.attendance.criteria[0].value).toBe('8');
  });

  it('serializes nested Any groups, preserves stable condition identities when reordered, and clears review after removal',async()=>{
    mount();const user=userEvent.setup(),t=en.allowanceV2,v=en.allowanceV3;
    await user.click(screen.getByRole('button',{name:v.addGroup}));
    const nested=screen.getByRole('group',{name:v.nestedGroup});
    await user.selectOptions(within(nested).getByLabelText(v.match),'or');
    await user.selectOptions(within(nested).getByLabelText(t.field),'lateCount');
    await user.click(within(nested).getByRole('button',{name:t.addAttendanceCriterion}));
    const before=submittedRules().attendance.expression.children[0];
    expect(before).toMatchObject({logic:'or',children:[{field:'lateCount',unit:'occurrences'},{field:'actualMinutes',unit:'hours'}]});
    await user.click(within(nested).getByRole('button',{name:'Move condition 1 down'}));
    const moved=submittedRules().attendance.expression.children[0];
    expect(moved.children.map((child:{id:string})=>child.id)).toEqual([before.children[1].id,before.children[0].id]);
    await user.click(screen.getByRole('checkbox',{name:t.reviewConfirm}));
    await user.click(within(nested).getByRole('button',{name:'Remove condition 1'}));
    expect(submittedRules().attendance.expression.children[0].children.map((child:{id:string})=>child.id)).toEqual([before.children[0].id]);
    expect(screen.getByRole('checkbox',{name:t.reviewConfirm})).not.toBeChecked();
  });

  it.each(Object.keys(catalogs) as (keyof typeof catalogs)[])('renders real rule controls and review wording in %s without unresolved messages', async locale => {
    const errors=mount(locale), t=catalogs[locale].allowanceV2;
    expect(screen.getByRole('heading',{name:t.sections.information})).toBeInTheDocument();
    expect(screen.getByRole('heading',{name:t.sections.employees})).toBeInTheDocument();
    expect(screen.getByRole('heading',{name:t.sections.attendance})).toBeInTheDocument();
    expect(screen.getByRole('heading',{name:t.sections.review})).toBeInTheDocument();
    expect(screen.getByText(catalogs[locale].allowanceV3.fixedRule)).toBeInTheDocument();
    expect(screen.getByRole('button',{name:catalogs[locale].allowanceV3.savePreview})).toBeDisabled();
    const user=userEvent.setup();
    await user.selectOptions(screen.getByLabelText(t.method),'weekly');
    expect(screen.getByText(t.weeklyRule)).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:t.addAttendanceCriterion}));
    expect(screen.getByLabelText(t.field)).toHaveValue('actualMinutes');
    expect(errors).toEqual([]);
    expect(form().querySelectorAll('form')).toHaveLength(0);
  });

  it('serializes typed rules, requires review again after an edit, and keeps failed-save input dirty', async () => {
    submit.mockClear();mount();
    const user=userEvent.setup(),t=en.allowanceV2;
    fireEvent.change(screen.getByLabelText(t.code),{target:{value:'ATT_TEST'}});
    fireEvent.change(screen.getByLabelText(t.name),{target:{value:'Attendance test'}});
    fireEvent.change(screen.getByLabelText(`${t.amount} (MYR)`),{target:{value:'0.10'}});
    fireEvent.change(screen.getByLabelText(t.effectiveFrom),{target:{value:'2025-01-01'}});
    await user.selectOptions(screen.getByLabelText(t.earningCode),earningId);
    await user.selectOptions(screen.getByLabelText(t.selection),'selected');
    const available=within(screen.getByRole('region',{name:en.allowanceV4.available}));
    await user.click(await available.findByRole('checkbox',{name:/Example employee/}));
    await user.click(screen.getByRole('button',{name:'Include checked (1)'}));
    await user.click(screen.getByRole('button',{name:t.addAttendanceCriterion}));
    await user.selectOptions(screen.getByLabelText(t.operator),'between');
    fireEvent.change(screen.getByLabelText(t.upper),{target:{value:'9'}});
    expect(submittedRules()).toMatchObject({v:4,employee:{mode:'selected',employmentIds:[employeeId]},attendance:{expression:{type:'group',children:[{field:'actualMinutes',operator:'between',value:'8',upper:'9',unit:'hours'}]}}});
    const review=screen.getByRole('checkbox',{name:t.reviewConfirm}),save=screen.getByRole('button',{name:en.allowanceV3.savePreview});
    await user.click(review);expect(save).toBeEnabled();
    fireEvent.change(screen.getByLabelText(t.upper),{target:{value:'10'}});
    expect(review).not.toBeChecked();expect(save).toBeDisabled();
    await user.click(review);await user.click(save);
    await waitFor(()=>expect(submit).toHaveBeenCalledTimes(1));
    await screen.findByText('Synthetic validation refusal');
    expect(screen.getByLabelText(t.name)).toHaveValue('Attendance test');
    expect(screen.getByLabelText(`${t.amount} (MYR)`)).toHaveValue(0.1);
    expect(submittedRules().attendance.expression.children[0].upper).toBe('10');
    const leave=new Event('beforeunload',{cancelable:true});window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
  });

  it('locks the submitted draft until the action resolves, then retains it after refusal', async () => {
    let resolve!: (result:{error:string})=>void;
    submit.mockImplementationOnce(()=>new Promise<{error:string}>(done=>{resolve=done;}));
    mount();const user=userEvent.setup(),t=en.allowanceV2;
    const name=screen.getByLabelText(t.name);
    fireEvent.change(name,{target:{value:'Reviewed draft'}});
    fireEvent.submit(form());
    await waitFor(()=>expect(name).toBeDisabled());
    await user.type(name,' lost edit');
    expect(name).toHaveValue('Reviewed draft');
    expect(screen.getByLabelText(t.method)).toBeDisabled();
    resolve({error:'Save refused'});
    await screen.findByText('Save refused');
    expect(name).toBeEnabled();expect(name).toHaveValue('Reviewed draft');
    const leave=new Event('beforeunload',{cancelable:true});window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
  });

  it('filters earning/deduction mappings and keeps legacy monthly rules until explicitly converted', async () => {
    const policy={id:'66666666-6666-4666-8666-666666666666',tenantId:companyId,companyId,code:'LEGACY',name:'Legacy',method:'monthly',amount:'20.00',payComponentId:earningId,effectiveFrom:'2025-01-01',status:'active',policyType:'earning',version:1,rules:null,criteria:{maxAbsentDays:0},scope:{},archivedAt:null,createdAt:new Date('2025-01-01T00:00:00Z')};
    mount('en',policy);const user=userEvent.setup(),t=en.allowanceV2;
    expect(new FormData(form()).get('rules')).toBe('');
    expect(screen.getByLabelText(t.method).querySelectorAll('option')).toHaveLength(1);
    expect(screen.getByLabelText(t.legacyCriteria.maxAbsentDays)).toHaveValue(0);
    await user.click(screen.getByRole('checkbox',{name:t.convertLegacy}));
    expect(submittedRules()).toEqual(emptyAllowanceRulesV4());
    expect(screen.getByLabelText(t.method).querySelectorAll('option')).toHaveLength(3);
    await user.selectOptions(screen.getByLabelText(t.policyType),'deduction');
    const code=screen.getByLabelText(t.deductionCode);
    expect(code).toHaveValue('');
    expect(Array.from(code.querySelectorAll('option')).map(option=>option.value)).toEqual(['',deductionId]);
  });
});
