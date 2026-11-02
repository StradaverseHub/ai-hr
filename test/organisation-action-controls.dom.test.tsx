import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {afterEach,describe,expect,it,vi} from 'vitest';
import en from '../messages/en.json';
import {GradeLabelsGrid} from '../components/grade-labels-grid';
import {ProfileOptionsGrid} from '../components/profile-options-grid';
import {SystemLabelsGrid,type GridRecord} from '../components/system-labels-grid';
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn(),push:vi.fn(),refresh:vi.fn()}),useSearchParams:()=>new URLSearchParams()}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
afterEach(cleanup);
const wrap=(children:React.ReactNode)=><NextIntlClientProvider locale="en" timeZone="Asia/Kuala_Lumpur" messages={en}>{children}</NextIntlClientProvider>;
const denied={add:false,edit:false,delete:false};
describe('configuration controls reflect independent action decisions',()=>{
 it('retains selectable grade values while refusing Add/Edit/Delete controls',()=>{
  const save=vi.fn(),remove=vi.fn();render(wrap(<GradeLabelsGrid actionControls={denied} data={[{id:'grade-a',code:'A',name:'Grade A',description:null,rank:1,archivedAt:null,inUse:false}]} actions={{save,remove,restore:vi.fn()}}/>));
  expect(screen.getByDisplayValue('Grade A')).toHaveProperty('readOnly',true);
  expect(screen.getByRole('button',{name:en.admin.systemLabels.addRow})).toHaveProperty('disabled',true);
  for(const button of screen.getAllByRole('button',{name:en.admin.systemLabels.deleteRow}))expect(button).toHaveProperty('disabled',true);
  expect(save).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();
 });
 it('allows a new profile-option draft without enabling edits to retained catalogue rows',()=>{
  render(wrap(<ProfileOptionsGrid actionControls={{add:true,edit:false,delete:false}} categories={['religion']} data={{religion:[{id:'option-a',category:'religion',value:'retained',label:'Retained value',description:'',sortOrder:0,isActive:true}]}} actions={{save:vi.fn(),remove:vi.fn()}}/>));
  expect(screen.getByDisplayValue('Retained value')).toHaveProperty('readOnly',true);
  fireEvent.click(screen.getByRole('button',{name:en.admin.profileOptions.addRow}));
  expect(screen.getAllByRole('textbox').some(input=>!(input as HTMLInputElement).readOnly)).toBe(true);
 });
 it('keeps profile-option category actions independent on an empty catalogue',()=>{
  render(wrap(<ProfileOptionsGrid categories={['religion','race']} categoryActionControls={{religion:denied,race:{add:true,edit:false,delete:false}}} data={{religion:[],race:[]}} actions={{save:vi.fn(),remove:vi.fn()}}/>));
  expect(screen.getByRole('button',{name:en.admin.profileOptions.addRow})).toHaveProperty('disabled',true);
  fireEvent.click(screen.getByRole('button',{name:new RegExp(en.admin.profileOptions.category.race)}));
  expect(screen.getByRole('button',{name:en.admin.profileOptions.addRow})).toHaveProperty('disabled',false);
  fireEvent.click(screen.getByRole('button',{name:en.admin.profileOptions.addRow}));
  expect(screen.getAllByRole('textbox').some(field=>!(field as HTMLInputElement).readOnly)).toBe(true);
 });
 it('switches label submenu controls independently within the same company',()=>{
  render(wrap(<SystemLabelsGrid data={{department:[],position:[],cost_center:[],business_unit:[]}} companies={[{id:'company-a',name:'Company A'}]} writableCompanyIds={['company-a']} kindActionControls={{department:{'company-a':denied},position:{'company-a':{add:true,edit:false,delete:false}}}} isGroupAdmin={false} actions={{save:vi.fn(),assign:vi.fn(),unassign:vi.fn(),setCriteria:vi.fn(),copyToCompanies:vi.fn()}}/>));
  expect(screen.getByRole('button',{name:en.admin.systemLabels.addRow})).toHaveProperty('disabled',true);
  fireEvent.click(screen.getByRole('button',{name:new RegExp(en.admin.systemLabels.category.position)}));
  expect(screen.getByRole('button',{name:en.admin.systemLabels.addRow})).toHaveProperty('disabled',false);
 });
 it('permits archiving independently of ordinary Edit on a company label',()=>{
  const row:GridRecord={id:'label-a',companyId:'company-a',code:'A',name:'Department A',title:'',jobFamily:'',label:'',businessUnitId:null,headEmploymentId:null,description:'',isGlobal:false,archived:false,inUse:false,assignedCompanyIds:['company-a'],createdAt:null,lastUpdatedAt:null,lastUpdatedBy:null};
  render(wrap(<SystemLabelsGrid data={{department:[row],position:[],cost_center:[],business_unit:[]}} companies={[{id:'company-a',name:'Company A'}]} writableCompanyIds={['company-a']} companyActionControls={{'company-a':{add:false,edit:false,delete:true}}} isGroupAdmin={false} actions={{save:vi.fn(),assign:vi.fn(),unassign:vi.fn(),setCriteria:vi.fn(),copyToCompanies:vi.fn()}}/>));
  expect(screen.getByDisplayValue('Department A')).toHaveProperty('readOnly',true);
  const archive=screen.getByTitle(en.admin.systemLabels.archive);expect(archive).toHaveProperty('disabled',false);
  fireEvent.click(archive);expect(screen.queryByTitle(en.admin.systemLabels.archive)).toBeNull();
 });
});
