import fs from 'node:fs';
import path from 'node:path';
import {describe,it,expect,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {MovementNewEvent} from '../app/(app)/admin/personnel/[employmentId]/movement-new-event';
import type {MovementCurrentValues} from '../app/(app)/admin/personnel/[employmentId]/movement-new-event';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import messages from '../messages/en.json';
vi.mock('../app/(app)/admin/personnel/[employmentId]/actions',()=>({createMovementEventAction:vi.fn(),editMovementEventAction:vi.fn()}));

const current:MovementCurrentValues={companyId:'company-a',companyName:'Fictional A',departmentId:'department-a',positionId:null,businessUnitId:null,locationId:null,employmentType:'full_time',gradeId:null,managerEmploymentId:null,basicSalary:'3500.00',currency:'MYR',payMode:'monthly',paymentTerm:'monthly',orgDivision:null,employmentCategory:null,orgRegion:null,orgBranch:null,orgTeam:null,orgSection:null,orgLine:null,orgBase:null};
const profileOptions:Record<string,{value:string;label:string}[]>={};
for(const field of PERSONNEL_FIELDS)if(field.allowedValuesOwner?.startsWith('profile_option:'))profileOptions[field.allowedValuesOwner.slice(15)]=[];
const base={employmentId:'fictional-employee',today:todayInKualaLumpur(),isBlacklisted:false,current,departments:[{id:'department-a',name:'Fictional department'}],positions:[],businessUnits:[],grades:[],locations:[],managers:[],employmentTypes:[{value:'full_time',label:'Full time'}],profileOptions,terminationReasons:[],cancelHref:'/fictional-cancel'};
const active={code:'transfer',label:'Active transfer',behaviourKind:'transfer'};
const inactive={code:'fictional_career_step',label:'Retired career step',behaviourKind:'promotion'};
const edit={movementId:'fictional-movement',kind:inactive.code,effectiveDate:base.today,endDate:null,remarks:null,allowedKinds:[inactive.code,active.code],payrollWarning:false};
const mount=(props:Parameters<typeof MovementNewEvent>[0])=>render(<NextIntlClientProvider locale="en" messages={messages}><MovementNewEvent {...props}/></NextIntlClientProvider>);

describe('an inactive custom Movement keeps its authorized Edit behavior metadata',()=>{
 it('renders the real comparison grid and editable retained facts for the inactive current code',()=>{
  const {container}=mount({...base,types:[active,inactive],edit});
  expect(screen.getByText(messages.people.detail.movement.form.currentInformation)).toBeInTheDocument();
  expect(screen.getByText(messages.people.detail.movement.form.afterInformation)).toBeInTheDocument();
  expect(container.querySelector('select[name="kind"]')).toHaveValue(inactive.code);
  expect(screen.getByRole('option',{name:inactive.label})).toHaveValue(inactive.code);
  expect(container.querySelector('select[name="departmentId"]')).toHaveValue('department-a');
  expect(container.querySelector('input[name="basicSalary"]')).toHaveValue(3500);
  expect(container.querySelector('select[name="companyId"]')).toBeNull();
  expect(screen.queryByRole('option',{name:'Other inactive type'})).toBeNull();
 });
 it('keeps record-only custom behavior out of the comparison grid',()=>{
  const type={...inactive,behaviourKind:'secondment'};
  const {container}=mount({...base,types:[active,type],edit});
  expect(container.querySelector('select[name="kind"]')).toHaveValue(type.code);
  expect(screen.queryByText(messages.people.detail.movement.form.currentInformation)).toBeNull();
  expect(container.querySelector('input[name="basicSalary"]')).toBeNull();
 });
 it('keeps New Event limited to its active catalogue',()=>{
  const {container}=mount({...base,types:[active]});
  expect(container.querySelector('select[name="kind"]')).toHaveValue(active.code);
  expect(screen.queryByRole('option',{name:inactive.label})).toBeNull();
 });
 it('the actual parent passes active-only New Event metadata and active plus exactly the edited code for Edit',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../app/(app)/admin/personnel/[employmentId]/page.tsx'),'utf8');
  const propsStart=source.indexOf('const movementFormProps'),propsEnd=source.indexOf('const newEventCard',propsStart);
  expect(propsStart).toBeGreaterThanOrEqual(0);expect(propsEnd).toBeGreaterThan(propsStart+500);
  const props=source.slice(propsStart,propsEnd);
  expect(props).toContain('types: movementTypes');expect(props).toMatch(/\.filter\(\(r\) => r\.active\)/);
  const start=source.indexOf('const editEventCard'),end=source.indexOf('const hireCorrectionCard',start);
  expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(start+500);
  const parent=source.slice(start,end);
  expect(parent).toContain('.filter((r) => r.active || r.code === movementEditRow.kind)');
  expect(parent).toContain('behaviourKind: r.behaviourKind');
  expect(parent).toContain('movementTypeByCode.get(movementEditRow.kind)?.behaviourKind');
  expect(parent).toContain('isComparisonKind(behaviour)');
  expect(parent).toContain('return Array.from(new Set([movementEditRow.kind, ...codes]))');
 });
});
