import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {PERSONNEL_FIELDS,type PersonnelFieldDescriptor} from '../lib/personnel-field-registry';
import {defaultMasterColumn,runEmployeeMasterProjection,validateEmployeeMasterSpec,type EmployeeMasterSpec,type MasterExpression,type MasterSubject} from '../lib/employee-master-report';
import {EmployeeMasterBuilder} from '../app/(app)/reports/employee-master/EmployeeMasterBuilder';
const ports=vi.hoisted(()=>({preview:vi.fn(),save:vi.fn()}));
vi.mock('../app/(app)/reports/employee-master/actions',()=>({previewEmployeeMaster:ports.preview,saveEmployeeMaster:ports.save}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn(),refresh:vi.fn()})}));
const today='2026-10-17',company='11111111-1111-4111-8111-111111111111';
const field=(owner:string,key:string)=>PERSONNEL_FIELDS.find(field=>field.owner===owner&&field.ownerField===key)!;
const name=field('person','fullName'),status=field('employmentStatus','status'),department=field('assignment','departmentName'),employmentType=field('assignment','employmentType');
const fields:PersonnelFieldDescriptor[]=[name,status,department,employmentType];
const subject=(id:string,kind:'employment'|'draft'):MasterSubject=>({id,kind,personId:id,companyId:company,owners:{person:[{id:'person-'+id,values:{fullName:{value:kind==='draft'?'Draft recipient':'Employed recipient'}}}],employmentStatus:[{id:'status-'+id,values:{status:{value:kind==='draft'?'draft':'confirmed'}}}],assignment:[{id:'assignment-'+id,values:{departmentName:{value:'Department A'},employmentType:{value:'full_time'}}}]}});
const subjects=[subject('employed','employment'),subject('unfinished','draft')];
function definition(expression:MasterExpression={id:'root',type:'group',logic:'and',children:[]}):EmployeeMasterSpec{return {v:2,asAt:today,companyIds:[company],includeDrafts:true,columns:[defaultMasterColumn(name)],expression,sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};}
function mount(initial=definition()){
 render(<NextIntlClientProvider locale="en" messages={messages}><EmployeeMasterBuilder initial={initial} fields={fields} companies={[{value:company,label:'Fictional company'}]} options={{[status.id]:[{value:'draft',label:'Draft'},{value:'confirmed',label:'Confirmed'}],[department.id]:[{value:'dept-a',label:'Department A'}],[employmentType.id]:[{value:'full_time',label:'Full time'}]}} roles={[]} reportId={null} version={null} today={today}/></NextIntlClientProvider>);
}
async function preview(){await act(async()=>{await vi.advanceTimersByTimeAsync(600);});return ports.preview.mock.calls.at(-1)![0] as EmployeeMasterSpec;}
function selectQuick(label:string,values:string[]){const select=screen.getByRole('listbox',{name:label}) as HTMLSelectElement;for(const option of select.options)option.selected=values.includes(option.value);fireEvent.change(select);}
const words=messages.employeeMasterReports;
beforeEach(()=>{vi.useFakeTimers();ports.preview.mockReset().mockImplementation(async(raw:unknown)=>{try{const spec=validateEmployeeMasterSpec(raw,fields,today);return {ok:true,result:runEmployeeMasterProjection(spec,fields,subjects,today),snapshotToken:'test-preview'};}catch(error){return {ok:false,error:(error as Error).message};}});});
afterEach(()=>{cleanup();vi.useRealTimers();});
describe('Employee Master builder quick conditions use the shared validator',()=>{
 it('adds Draft to an empty all-employees root and clears it back to all rows without an empty nested group',async()=>{
  mount();await preview();expect(screen.getByText('Employed recipient')).toBeInTheDocument();expect(screen.getByText('Draft recipient')).toBeInTheDocument();
  selectQuick(words.quick.status,['draft']);const draft=await preview();expect(()=>validateEmployeeMasterSpec(draft,fields,today)).not.toThrow();expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Draft recipient')).toBeInTheDocument();expect(screen.queryByText('Employed recipient')).not.toBeInTheDocument();
  expect(draft.expression).toMatchObject({type:'group',logic:'and',children:[{id:'quick-status',type:'condition',field:status.id,operator:'in',values:['draft']}]});
  selectQuick(words.quick.status,[]);const cleared=await preview();expect(()=>validateEmployeeMasterSpec(cleared,fields,today)).not.toThrow();expect(cleared.expression).toMatchObject({type:'group',children:[]});expect(cleared.includeDrafts).toBe(true);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(screen.getByText('Employed recipient')).toBeInTheDocument();expect(screen.getByText('Draft recipient')).toBeInTheDocument();
 });
 it('clears an existing quick selection left with the old empty advanced wrapper',async()=>{
  mount(definition({id:'selection-root',type:'group',logic:'and',children:[{id:'advanced-root',type:'group',logic:'and',children:[]},{id:'quick-status',type:'condition',field:status.id,operator:'in',values:['draft']}]}));
  await preview();expect(screen.getByRole('alert')).toHaveTextContent('Add a condition or remove the empty group.');
  selectQuick(words.quick.status,[]);const cleared=await preview();expect(()=>validateEmployeeMasterSpec(cleared,fields,today)).not.toThrow();expect(cleared.expression).toMatchObject({children:[]});
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(screen.getByText('Employed recipient')).toBeInTheDocument();expect(screen.getByText('Draft recipient')).toBeInTheDocument();
 });
 it.each(['and','or'] as const)('preserves populated %s/nested user groups while quick filters are added and removed',async logic=>{
  const advanced:MasterExpression={id:'root',type:'group',logic,children:[{id:'name-match',type:'condition',field:name.id,operator:'contains',value:'recipient'},{id:'nested',type:'group',logic:'or',children:[{id:'draft-name',type:'condition',field:name.id,operator:'eq',value:'Draft recipient'},{id:'other-name',type:'condition',field:name.id,operator:'eq',value:'Unrelated'}]}]};
  mount(definition(advanced));await preview();
  selectQuick(words.quick.status,['draft']);selectQuick(words.quick.department,['dept-a']);selectQuick(words.quick.employmentType,['full_time']);const filtered=await preview();expect(()=>validateEmployeeMasterSpec(filtered,fields,today)).not.toThrow();
  expect(filtered.expression).toMatchObject({logic:'and',children:[{...advanced,id:'advanced-root'},{id:'quick-status',values:['draft']},{id:'quick-department',values:['dept-a']},{id:'quick-employmentType',values:['full_time']}]});
  for(const label of [words.quick.status,words.quick.department,words.quick.employmentType])selectQuick(label,[]);
  const cleared=await preview();expect(()=>validateEmployeeMasterSpec(cleared,fields,today)).not.toThrow();expect(cleared.expression).toMatchObject({children:[{...advanced,id:'advanced-root'}]});expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 });
 it('can add and remove the last advanced condition after a quick-only selection, retaining the quick filter',async()=>{
  const initial=definition();initial.includeDrafts=false;mount(initial);await preview();selectQuick(words.quick.status,['draft']);await preview();
  fireEvent.click(screen.getByRole('button',{name:words.addCondition}));fireEvent.change(screen.getByLabelText(words.conditionValue),{target:{value:'Draft recipient'}});
  const combined=await preview();expect(combined.includeDrafts).toBe(true);expect(()=>validateEmployeeMasterSpec(combined,fields,today)).not.toThrow();expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:words.removeCondition}));const removed=await preview();expect(()=>validateEmployeeMasterSpec(removed,fields,today)).not.toThrow();expect(removed.expression).toMatchObject({children:[{id:'quick-status',values:['draft']}]});expect(screen.getByText('Draft recipient')).toBeInTheDocument();
  selectQuick(words.quick.status,[]);const all=await preview();expect(()=>validateEmployeeMasterSpec(all,fields,today)).not.toThrow();expect(screen.getByText('Employed recipient')).toBeInTheDocument();
 });
 it('does not discard or legalise a genuinely nested empty user group',async()=>{
  const initial=definition({id:'root',type:'group',logic:'and',children:[{id:'unfinished-user-group',type:'group',logic:'or',children:[]}]});
  expect(()=>validateEmployeeMasterSpec(initial,fields,today)).toThrow('Add a condition or remove the empty group.');mount(initial);await preview();selectQuick(words.quick.status,['draft']);const filtered=await preview();
  expect(()=>validateEmployeeMasterSpec(filtered,fields,today)).toThrow('Add a condition or remove the empty group.');expect(screen.getByRole('alert')).toHaveTextContent('Add a condition or remove the empty group.');
 });
});
