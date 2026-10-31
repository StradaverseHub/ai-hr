/** Prepared rendered contract; actual role journeys still need the isolated app under all leases. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {WorkforceScopedRecord} from '../app/(app)/admin/personnel/[employmentId]/workforce-record';
import {workforceCommandAccess} from '../core/workforce-access';
import {workforceEditor,WorkforceMaintenanceUnavailableError,type WorkforceEditor} from '../core/workforce-maintenance';
import {workforceRecord,type WorkforceRecord} from '../core/workforce-record';
import {listWorkforcePickOptions} from '../core/read';
import {WORKFORCE_PROFILE_FIELDS,type WorkforceProfile} from '../lib/workforce-record-fields';
import {personnelField} from '../lib/personnel-field-registry';
import {todayInKualaLumpur} from '../lib/hr-date';
const language=vi.hoisted(()=>({current:'en'}));
// The production composition looks up registry-provided strings, not a literal message-key union.
// Keep all real catalogue bytes and runtime missing-key errors without expanding every locale's
// nested key union at each dynamic lookup during the repository's strict type check.
type RuntimeMessages=NonNullable<Parameters<typeof createTranslator>[0]['messages']>;
const catalogues:Record<'en'|'ms'|'zh'|'ta'|'th'|'vi',RuntimeMessages>={en,ms,zh,ta,th,vi:viMessages};
vi.mock('next-intl/server',()=>({getTranslations:async(namespace?:string)=>createTranslator({
 locale:language.current,messages:catalogues[language.current as keyof typeof catalogues],namespace,onError:error=>{throw error;},
})}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('not_found');}}));
vi.mock('../core/workforce-access',()=>({workforceCommandAccess:vi.fn(async()=>false)}));
vi.mock('../core/workforce-maintenance',()=>({workforceEditor:vi.fn(async()=>null),WorkforceMaintenanceUnavailableError:class extends Error{}}));
vi.mock('../app/(app)/admin/personnel/[employmentId]/workforce-record-actions',()=>({saveWorkforceCodeAction:vi.fn(),saveWorkforceRecordAction:vi.fn()}));
vi.mock('../core/workforce-record',()=>({workforceRecord:vi.fn()}));
vi.mock('../core/read',()=>({listWorkforcePickOptions:vi.fn()}));
vi.mock('../app/(app)/admin/personnel/employee-switcher',()=>({EmployeeSwitcher:()=> <span>Fictional authorized picker</span>}));
const id='11111111-1111-4111-8111-111111111111';
const ctx={tenantId:id,userId:id,personId:id,roles:['employee'],grants:[{role:'employee',companyId:null}]};
const profile=Object.fromEntries(WORKFORCE_PROFILE_FIELDS.map(({key})=>[key,null])) as WorkforceProfile;
const detail:WorkforceRecord={employment:{employmentId:id,name:'Fictional view-only colleague',email:'wf-profile@example.invalid',
 employeeCode:'WF-RO',department:'Fictional department',departmentId:id,position:'Fictional position',company:'Fictional company',companyId:id,
 hiredOn:todayInKualaLumpur(),terminatedOn:null,confirmationDate:null,finalConfirmationDate:null,resignationDate:null,lastWorkingDate:null,blacklistedAt:null,
 jobGrade:null,employmentType:'full_time',reportingTo:null,businessUnit:null,costCenter:null,workLocation:null,joinDate:null},
 profile:{...profile,fullName:'Fictional view-only colleague',primaryEmail:'wf-profile@example.invalid',gender:'female',permanentCity:'Fictional city'}};

describe('grant-based Workforce record view',()=>{
 beforeEach(()=>{vi.mocked(workforceCommandAccess).mockResolvedValue(false);vi.mocked(workforceEditor).mockResolvedValue(null);});
 it.each(Object.keys(catalogues))('renders the bounded profile in %s without a hidden maintenance form',async locale=>{
  language.current=locale;
  vi.mocked(workforceRecord).mockResolvedValue(detail);vi.mocked(listWorkforcePickOptions).mockResolvedValue([]);
  const root=createTranslator({locale,messages:catalogues[locale as keyof typeof catalogues],onError:error=>{throw error;}});
  for(const {fieldId}of WORKFORCE_PROFILE_FIELDS)expect(root.has(personnelField(fieldId)!.labelKey)).toBe(true);
  const {container}=render(await WorkforceScopedRecord({session:ctx,employmentId:id,scopeIds:[id]}));
  expect(screen.getByRole('heading',{name:'Fictional view-only colleague'})).toBeInTheDocument();
  expect(screen.getByText('wf-profile@example.invalid')).toBeInTheDocument();
  expect(screen.getByText('Fictional company')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(root('accessConfiguration.workforceReadOnly'));
  expect(container.querySelector('form')).toBeNull();expect(container.querySelector('input[type="file"]')).toBeNull();
  expect(container.querySelector('[name="fullName"]')).toBeNull();
 });
 it('refuses a revoked/missing projection and a malformed URL rather than rendering a partial record',async()=>{
  vi.mocked(workforceRecord).mockResolvedValue(null);vi.mocked(listWorkforcePickOptions).mockResolvedValue([]);
  await expect(WorkforceScopedRecord({session:ctx,employmentId:id,scopeIds:[id]})).rejects.toThrow('not_found');
  vi.mocked(workforceRecord).mockClear();
  await expect(WorkforceScopedRecord({session:ctx,employmentId:'not-an-id',scopeIds:[id]})).rejects.toThrow('not_found');
  expect(workforceRecord).not.toHaveBeenCalled();
 });
 it.each(Object.keys(catalogues))('offers only the implemented fixed command in %s, with translated durable feedback',async locale=>{
  language.current=locale;vi.mocked(workforceCommandAccess).mockResolvedValue(true);
  vi.mocked(workforceRecord).mockResolvedValue(detail);vi.mocked(listWorkforcePickOptions).mockResolvedValue([]);
  const root=createTranslator({locale,messages:catalogues[locale as keyof typeof catalogues],onError:error=>{throw error;}});
  const {container}=render(await WorkforceScopedRecord({session:ctx,employmentId:id,scopeIds:[id],feedback:'saved'}));
  expect(screen.getByRole('button',{name:root('accessConfiguration.workforceCode.save')})).toBeInTheDocument();
  expect(screen.getByLabelText(root('people.list.colCode'))).toHaveValue('WF-RO');
  expect(screen.getByText(root('accessConfiguration.workforceCode.saved'))).toBeInTheDocument();
  expect(Array.from(container.querySelectorAll('input')).map(input=>input.name).sort()).toEqual(['employeeCode','employmentId','expectedCode']);
  expect(container.querySelector('[name="expectedCode"]')).toHaveValue(JSON.stringify('WF-RO'));
  expect(container.querySelector('input[type="file"]')).toBeNull();
  expect(container.querySelector('[name="salary"]')).toBeNull();
 });
 it.each(Object.keys(catalogues))('renders bounded profile/register editors and real row revisions in %s',async locale=>{
  language.current=locale;vi.mocked(workforceRecord).mockResolvedValue(detail);vi.mocked(listWorkforcePickOptions).mockResolvedValue([]);
  const editor:WorkforceEditor={profileVersion:'1042',profile:detail.profile,sharedMaintain:true,employmentMaintain:true,options:[],registers:[
   {kind:'qualification',id,version:'1043',values:{qualification:'Legacy retained level',description:null,fromYm:'2020-01',toYm:'2023-01',institute:null,major:null,graduationDate:null,result:null,isHighest:true}},
   {kind:'emergency',id:'22222222-2222-4222-8222-222222222222',version:'1044',values:{fullName:'Fictional contact',relationship:null,mobilePhone:null,homePhone:null,address:null,priority:'primary'}},
   {kind:'dependent',id:'33333333-3333-4333-8333-333333333333',version:'1045',values:{fullName:'Fictional child',relationship:'child',childTaxRelief:null,isStudent:null,childReliefPercentage:50}},
  ]};
  vi.mocked(workforceEditor).mockResolvedValue(editor);
  const {container}=render(await WorkforceScopedRecord({session:ctx,employmentId:id,scopeIds:[id],editFeedback:'saved'}));
  const root=createTranslator({locale,messages:catalogues[locale as keyof typeof catalogues],onError:error=>{throw error;}});
  expect(screen.getByText(root('accessConfiguration.workforceEdit.saved'))).toBeInTheDocument();
  expect(container.querySelector('[name="fullName"]')).toHaveValue(detail.profile.fullName);
  expect(container.querySelector('[name="expectedVersion"][value="1042"]')).not.toBeNull();
  expect(container.querySelector('[name="expectedVersion"][value="1043"]')).not.toBeNull();
  expect(container.querySelector('[name="expectedVersion"][value="1044"]')).not.toBeNull();
  expect(container.querySelector('[name="isHighest"]')).toHaveValue('true');
  expect(container.querySelector('[name="childTaxRelief"]')).toHaveValue('');
  expect(container.querySelector('[name="childReliefPercentage"]')).toHaveValue('50');
  expect(container.querySelector('[name="expectedVersion"][value="1045"]')).not.toBeNull();
  for(const name of ['salary','bankAccount','personId','tenantId','companyId','role','remarks','isTestRecord'])expect(container.querySelector(`[name="${name}"]`)).toBeNull();
  expect(container.querySelector('input[type="file"]')).toBeNull();
 });
 it('keeps shared Person forms closed independently from employment Qualification maintenance',async()=>{
  language.current='en';vi.mocked(workforceRecord).mockResolvedValue(detail);vi.mocked(listWorkforcePickOptions).mockResolvedValue([]);
  vi.mocked(workforceEditor).mockResolvedValue({profileVersion:'42',profile:detail.profile,sharedMaintain:false,employmentMaintain:true,registers:[],options:[]});
  const {container}=render(await WorkforceScopedRecord({session:ctx,employmentId:id,scopeIds:[id]}));
  expect(container.querySelector('[name="fullName"]')).toBeNull();
  expect(container.querySelector('[name="qualification"]')).not.toBeNull();
  expect(container.querySelector('[name="kind"][value="emergency"]')).toBeNull();
 });
 it('binds form values to the versioned snapshot rather than the independent page summary',async()=>{
  language.current='en';vi.mocked(workforceRecord).mockResolvedValue(detail);vi.mocked(listWorkforcePickOptions).mockResolvedValue([]);
  vi.mocked(workforceEditor).mockResolvedValue({profileVersion:'1050',profile:{...detail.profile,fullName:'Fictional coherent snapshot'},sharedMaintain:true,employmentMaintain:false,registers:[],options:[]});
  const {container}=render(await WorkforceScopedRecord({session:ctx,employmentId:id,scopeIds:[id]}));
  expect(container.querySelector('[name="fullName"]')).toHaveValue('Fictional coherent snapshot');
  expect(container.querySelector('[name="expectedVersion"]')).toHaveValue('1050');
 });
 it('keeps a bounded unavailable editor from crashing the ordinary record view',async()=>{
  language.current='en';vi.mocked(workforceRecord).mockResolvedValue(detail);vi.mocked(listWorkforcePickOptions).mockResolvedValue([]);
  vi.mocked(workforceEditor).mockRejectedValue(new WorkforceMaintenanceUnavailableError());
  const {container}=render(await WorkforceScopedRecord({session:ctx,employmentId:id,scopeIds:[id]}));
  expect(screen.getByRole('alert')).toHaveTextContent(en.accessConfiguration.workforceEdit.unavailable);
  expect(screen.getByRole('heading',{name:detail.employment.name})).toBeInTheDocument();expect(container.querySelector('form')).toBeNull();
 });
});
