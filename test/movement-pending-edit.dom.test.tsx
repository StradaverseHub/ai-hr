import fs from 'node:fs';
import path from 'node:path';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {MovementNewEvent,type MovementCurrentValues} from '../app/(app)/admin/personnel/[employmentId]/movement-new-event';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import messages from '../messages/en.json';
const actions=vi.hoisted(()=>({createMovementEventAction:vi.fn(async (_data:FormData)=>{}),editMovementEventAction:vi.fn(async (_data:FormData)=>{})}));
vi.mock('../app/(app)/admin/personnel/[employmentId]/actions',()=>actions);
const today=todayInKualaLumpur(),day=(n:number)=>new Date(Date.parse(today+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const current:MovementCurrentValues={companyId:'company-a',companyName:'Fictional Main',departmentId:'department-a',positionId:null,businessUnitId:null,locationId:null,employmentType:'full_time',gradeId:null,managerEmploymentId:null,basicSalary:'3000.00',currency:'MYR',payMode:'monthly',paymentTerm:'monthly',orgDivision:null,employmentCategory:null,orgRegion:null,orgBranch:null,orgTeam:null,orgSection:null,orgLine:null,orgBase:null};
const profileOptions:Record<string,{value:string;label:string}[]>={};
for(const field of PERSONNEL_FIELDS)if(field.allowedValuesOwner?.startsWith('profile_option:'))profileOptions[field.allowedValuesOwner.slice(15)]=[];
const base={employmentId:'fictional-subject',today,isBlacklisted:false,current,departments:[{id:'department-a',name:'Main Operations'}],positions:[],businessUnits:[],grades:[{id:'grade-b',name:'Fictional Grade B'}],locations:[],managers:[{id:'manager-dest',name:'Fictional Destination Manager',companyId:'company-b'}],companies:[{id:'company-a',name:'Fictional Main'},{id:'company-b',name:'Fictional Destination'}],orgByCompany:{'company-a':{departments:[{id:'department-a',name:'Main Operations'}],positions:[],businessUnits:[],locations:[]},'company-b':{departments:[{id:'department-b',name:'Destination Operations'}],positions:[],businessUnits:[],locations:[]}},employmentTypes:[{value:'full_time',label:'Full time'}],profileOptions,terminationReasons:[],cancelHref:'/fictional-cancel',types:[{code:'reportingLineChange',label:null,behaviourKind:'reportingLineChange'},{code:'entityTransfer',label:null,behaviourKind:'entityTransfer'},{code:'salaryAdjustment',label:null,behaviourKind:'salaryAdjustment'}]};
const edit=(kind:string,pendingInput:Record<string,string|null>)=>({movementId:'fictional-pending',kind,effectiveDate:day(14),endDate:null,remarks:'Original fictional remarks',allowedKinds:[kind],payrollWarning:false,pendingInput});
const mount=(props:Parameters<typeof MovementNewEvent>[0])=>render(<NextIntlClientProvider locale="en" messages={messages} onError={e=>{throw e;}}><MovementNewEvent {...props}/></NextIntlClientProvider>);
afterEach(()=>{cleanup();vi.clearAllMocks();});
async function submit(container:HTMLElement){fireEvent.change(container.querySelector('input[name="reason"]')!,{target:{value:'Fictional correction'}});fireEvent.submit(container.querySelector('form')!);await waitFor(()=>expect(actions.editMovementEventAction).toHaveBeenCalledTimes(1));return actions.editMovementEventAction.mock.calls[0][0];}

describe('pending Movement Edit retains its saved target independently of current information',()=>{
 it('submits the saved future manager after a date/remarks-only correction, without freezing current defaults',async()=>{
  const {container}=mount({...base,edit:edit('reportingLineChange',{managerEmploymentId:'manager-dest'})});
  expect(container.querySelector('select[name="managerEmploymentId"]')).toHaveValue('manager-dest');
  expect(screen.getByText('3000.00')).toBeInTheDocument(); // Current salary stays the current baseline.
  fireEvent.change(container.querySelector('input[name="effectiveDate"]')!,{target:{value:day(15)}});
  fireEvent.change(container.querySelector('input[name="remarks"]')!,{target:{value:'Corrected fictional remarks'}});
  const data=await submit(container);
  expect(data.get('managerEmploymentId')).toBe('manager-dest');expect(data.get('effectiveDate')).toBe(day(15));expect(data.get('remarks')).toBe('Corrected fictional remarks');
  for(const key of ['departmentId','basicSalary','employmentType','currency','payMode','paymentTerm','gradeId'])expect(data.has(key),key).toBe(false);
 });
 it('prefills destination-company controls and saved salary/explicit clears while retaining changed optional fields',async()=>{
  const {container}=mount({...base,edit:edit('entityTransfer',{companyId:'company-b',departmentId:'department-b',managerEmploymentId:'manager-dest',basicSalary:'3500',positionId:null})});
  expect(container.querySelector('select[name="companyId"]')).toHaveValue('company-b');expect(container.querySelector('select[name="departmentId"]')).toHaveValue('department-b');
  expect(container.querySelector('select[name="managerEmploymentId"]')).toHaveValue('manager-dest');expect(container.querySelector('input[name="basicSalary"]')).toHaveValue(3500);
  expect(screen.getByText('3000.00')).toBeInTheDocument();expect(screen.getAllByText('Fictional Main').length).toBeGreaterThan(0);
  fireEvent.change(container.querySelector('select[name="gradeId"]')!,{target:{value:'grade-b'}});
  const data=await submit(container);expect(data.get('companyId')).toBe('company-b');expect(data.get('departmentId')).toBe('department-b');expect(data.get('basicSalary')).toBe('3500');expect(data.get('positionId')).toBe('');expect(data.get('gradeId')).toBe('grade-b');
 });
 it('fails closed when a saved reference is no longer in authorized choices instead of silently selecting None',()=>{
  const {container}=mount({...base,managers:[],edit:edit('reportingLineChange',{managerEmploymentId:'manager-dest'})});
  expect(screen.getByRole('alert')).toBeInTheDocument();expect(container.querySelector('form')).toBeNull();expect(screen.queryByRole('option',{name:'Fictional Destination Manager'})).toBeNull();
 });
 it('wires the actual page to a canonical pending-only edit read, preserving the separate current prop',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../app/(app)/admin/personnel/[employmentId]/page.tsx'),'utf8');
  const start=source.indexOf('const movementEditRow'),end=source.indexOf('const hireCorrectionCard',start);
  expect(start).toBeGreaterThan(-1);expect(end).toBeGreaterThan(start+500);const parent=source.slice(start,end);
  expect(parent).toContain('movementPendingEditInput(s, employmentId, movementEditRow.id)');expect(parent).toContain("movementEditRow.status === 'pending'");expect(parent).toContain('pendingInput: movementEditInput?.values');expect(parent).toContain('{...movementFormProps}');
 });
});
