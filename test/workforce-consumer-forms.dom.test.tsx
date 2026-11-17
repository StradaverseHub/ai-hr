import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
vi.mock('../components/derived-organisation-fields',()=>({useDerivedOrganisation:()=>({data:{status:'legacy'},loading:false,failed:false}),DerivedOrganisationFields:()=>null}));
vi.mock('../app/admin/personnel/[employmentId]/actions',()=>({correctHireDetailsAction:vi.fn(),saveMovementPageAction:vi.fn()}));
vi.mock('../app/admin/personnel/[employmentId]/rehire-actions',()=>({rehireEmploymentAction:vi.fn()}));
import {HireCorrectionForm} from '../app/admin/personnel/[employmentId]/hire-correction-form';
import {RehireEventForm} from '../app/admin/personnel/[employmentId]/rehire-form';
const wrap=(child:React.ReactNode)=><NextIntlClientProvider locale="en" messages={messages}>{child}</NextIntlClientProvider>;
const response={ok:true,json:async()=>({rows:[{employmentId:'manager-new',name:'New manager',employeeCode:null,companyId:'company-b'}],selected:[],total:1,offset:0,limit:25})};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('Correct Hire sends no untouched manager, then carries only the explicitly changed id and review label',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response));
 const {container}=render(wrap(<HireCorrectionForm remoteManagers employmentId="subject" heading="Hired" readOnly={[]} cancelHref="/cancel" fields={[{field:'managerEmploymentId',label:'Manager',required:false,currentId:'manager-old',currentLabel:'Prior manager',originalLabel:'Prior manager',options:[],carriesInto:[],stoppedBy:null,reachesCurrent:true}]}/>));
 const form=container.querySelector('form')!;expect(new FormData(form).has('managerEmploymentId')).toBe(false);
 fireEvent.click(container.querySelector('[aria-haspopup="listbox"]')!);await screen.findByRole('option',{name:'New manager'});fireEvent.mouseDown(screen.getByRole('option',{name:'New manager'}));expect(new FormData(form).get('managerEmploymentId')).toBe('manager-new');expect(screen.getAllByText('New manager').length).toBeGreaterThan(0);
});
it('Rehire keeps its default manager and scopes the remote chooser when changing the destination company',async()=>{
 const fetcher=vi.fn().mockResolvedValue(response);vi.stubGlobal('fetch',fetcher);
 const defaults={companyId:'company-a',departmentId:'department-a',positionId:null,businessUnitId:null,locationId:null,employmentType:'full_time',gradeId:null,managerEmploymentId:'manager-a',basicSalary:'3000',currency:'MYR',payMode:'monthly',paymentTerm:'monthly'};
 const org={departments:[{id:'department-a',name:'Department A'}],positions:[],businessUnits:[],locations:[]};
 const {container}=render(wrap(<RehireEventForm remoteManagers employmentId="subject" kindCode="rehire" personName="Fictional person" previousEmployeeCode="WF-1" previousStart="2020-01-01" previousEnd="2025-01-01" notOnOrBefore="2025-01-01" defaults={defaults} companies={[{id:'company-a',name:'Company A'},{id:'company-b',name:'Company B'}]} orgByCompany={{'company-a':org,'company-b':org}} grades={[]} managers={[{id:'manager-a',name:'Original manager',companyId:'company-a'}]} employmentTypes={[{value:'full_time',label:'Full time'}]} employeeIdRules={{}} cancelHref="/cancel"/>));
 const posted=()=>new FormData(container.querySelector('form')!).get('managerEmploymentId');expect(posted()).toBe('manager-a');fireEvent.change(container.querySelector('select[name="companyId"]')!,{target:{value:'company-b'}});expect(posted()).toBe('');fireEvent.click(container.querySelector('input[name="managerEmploymentId"]')!.parentElement!.querySelector('button')!);await screen.findByRole('option',{name:'New manager'});fireEvent.mouseDown(screen.getByRole('option',{name:'New manager'}));expect(posted()).toBe('manager-new');expect(JSON.parse(fetcher.mock.calls[0][1].body).companyId).toBe('company-b');
});
