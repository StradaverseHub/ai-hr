vi.mock('../components/derived-organisation-fields',()=>({useDerivedOrganisation:()=>({data:{status:'legacy'},loading:false,failed:false}),DerivedOrganisationFields:()=>null}));
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import type {ReactNode} from 'react';
import messages from '../messages/en.json';
import {PostingsTable,postingEditHref,type PostingTableRow} from '../app/lifecycle/probation/postings/postings-table';
import {MovementNewEvent,type MovementCurrentValues} from '../app/admin/personnel/[employmentId]/movement-new-event';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {normalisePostingValues,postingValueChanges,postingDisplayStatus} from '../lib/personnel-posting';

/** Screen 7 (the queue's three states) and screen 8 (New Event prefilled from a posting). Fixtures are fictional. */
const actions=vi.hoisted(()=>({createMovementEventAction:vi.fn(async(_data:FormData)=>{}),editMovementEventAction:vi.fn(async(_data:FormData)=>{}),saveMovementPageAction:vi.fn(async()=>null)}));
vi.mock('../app/admin/personnel/[employmentId]/actions',()=>actions);
vi.mock('next/link',()=>({__esModule:true,
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 default:({href,children,prefetch:_prefetch,...rest}:any)=><a href={typeof href==='string'?href:String(href)} {...rest}>{children}</a>}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const wrap=(node:ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages} onError={e=>{throw e;}}>{node}</NextIntlClientProvider>);

const row=(over:Partial<PostingTableRow>):PostingTableRow=>({id:'00000000-0000-4000-8000-000000001043',label:'PP-1043',employmentId:'emp-aina',employeeName:'Fictional Aina',employeeCode:'F001',
 eventType:'confirmation',proposed:{effectiveDate:'2026-11-24'},edited:null,current:{effectiveDate:'2026-11-24'},displayStatus:'pending',editedBy:null,editedAt:null,
 approvedBy:null,approvedAt:null,approverGroupName:'Fictional People Ops',createdAt:'2026-11-24T08:00:00Z',revision:1,canApprove:true,canEdit:true,...over});

describe('Personnel postings queue',()=>{
 it('shows Pending, Edited · waiting for approval (who changed what) and Approved, with Approve only for the approver group',()=>{
  const approve=vi.fn();
  wrap(<PostingsTable approveAction={approve} rows={[
   row({}),
   row({id:'00000000-0000-4000-8000-000000001042',label:'PP-1042',employmentId:'emp-daniel',employeeName:'Fictional Daniel',eventType:'probationExtension',
    proposed:{effectiveDate:'2026-11-01',endDate:'2027-02-01'},edited:{effectiveDate:'2026-11-02',endDate:'2027-02-01'},current:{effectiveDate:'2026-11-02',endDate:'2027-02-01'},
    displayStatus:'edited',editedBy:{name:'Fictional Alicia'},editedAt:'2026-11-02T03:00:00Z',revision:2,canApprove:false}),
   row({id:'00000000-0000-4000-8000-000000001041',label:'PP-1041',employmentId:'emp-nur',employeeName:'Fictional Nur',displayStatus:'approved',approvedBy:{name:'Fictional Siteng'},approvedAt:'2026-11-03T08:00:00Z',current:{effectiveDate:'2026-11-03'}}),
  ]}/>);
  const pending=document.querySelector('tr[data-posting="PP-1043"]') as HTMLElement,edited=document.querySelector('tr[data-posting="PP-1042"]') as HTMLElement,approved=document.querySelector('tr[data-posting="PP-1041"]') as HTMLElement;
  expect(within(pending).getByText('Pending')).toBeInTheDocument();
  expect(within(pending).getByText('Confirmation Date 24-Nov-2026 · status Probation → Active')).toBeInTheDocument();
  expect(within(pending).getByRole('button',{name:'Approve'})).toBeInTheDocument();
  expect(within(pending).getByRole('link',{name:'Edit PP-1043 in Personnel Management'})).toHaveAttribute('href','/admin/personnel/emp-aina/movement/new?posting=00000000-0000-4000-8000-000000001043');
  expect(within(edited).getByText('Edited · waiting for approval')).toBeInTheDocument();
  expect(within(edited).getByTestId('posting-edited-note')).toHaveTextContent('Edited by Fictional Alicia 02-Nov-2026: effective date 01-Nov-2026 → 02-Nov-2026');
  expect(within(edited).getByText('Probation extended · new end date 01-Feb-2027 · effective 02-Nov-2026')).toBeInTheDocument();
  expect(within(edited).queryByRole('button',{name:'Approve'})).toBeNull();
  expect(within(edited).getByText('Only Fictional People Ops can approve')).toBeInTheDocument();
  expect(within(edited).getByRole('link',{name:'Edit PP-1042 in Personnel Management'})).toBeInTheDocument();
  expect(within(approved).getByText('Approved')).toBeInTheDocument();
  expect(within(approved).getByText('Fictional Siteng · 03-Nov-2026')).toBeInTheDocument();
  expect(within(approved).queryByRole('button')).toBeNull();expect(within(approved).queryByRole('link')).toBeNull();
  const form=within(pending).getByRole('button',{name:'Approve'}).closest('form')!;
  expect(new FormData(form).get('postingId')).toBe('00000000-0000-4000-8000-000000001043');expect(new FormData(form).get('revision')).toBe('1');
 });
 it('hides Edit from someone who cannot record events and shows the empty state',()=>{
  wrap(<PostingsTable approveAction={vi.fn()} rows={[row({canEdit:false})]}/>);
  expect(screen.queryByRole('link')).toBeNull();expect(screen.getByRole('button',{name:'Approve'})).toBeInTheDocument();
  cleanup();wrap(<PostingsTable approveAction={vi.fn()} rows={[]}/>);expect(screen.getByText('No postings here.')).toBeInTheDocument();
 });
 it('keeps the value allowlist and change diff the database enforces',()=>{
  expect(normalisePostingValues('confirmation',{effectiveDate:'2026-02-30'})).toEqual({ok:false,problem:'effectiveDate'});
  expect(normalisePostingValues('confirmation',{effectiveDate:'2026-11-24',endDate:'2027-01-01'})).toEqual({ok:false,problem:'endDate'});
  expect(normalisePostingValues('probationExtension',{effectiveDate:'2026-11-24'})).toEqual({ok:false,problem:'endDate'});
  expect(normalisePostingValues('confirmation',{effectiveDate:'2026-11-24',basicSalary:'9000'})).toEqual({ok:false,problem:'fields'});
  expect(normalisePostingValues('probationExtension',{effectiveDate:' 2026-11-24 ',endDate:'2027-02-28',remarks:'  '})).toEqual({ok:true,values:{effectiveDate:'2026-11-24',endDate:'2027-02-28'}});
  expect(postingValueChanges({effectiveDate:'2026-11-01'},{effectiveDate:'2026-11-02',remarks:'Late start'})).toEqual([{field:'effectiveDate',before:'2026-11-01',after:'2026-11-02'},{field:'remarks',before:null,after:'Late start'}]);
  expect(postingDisplayStatus({status:'pending',edited:null})).toBe('pending');expect(postingDisplayStatus({status:'pending',edited:{effectiveDate:'2026-11-02'}})).toBe('edited');
  expect(postingEditHref({id:'p 1',employmentId:'e1'})).toBe('/admin/personnel/e1/movement/new?posting=p%201');
 });
});

const today=todayInKualaLumpur();
const current:MovementCurrentValues={companyId:'company-a',companyName:'Fictional Main',departmentId:'department-a',positionId:null,businessUnitId:null,locationId:null,employmentType:'full_time',gradeId:null,managerEmploymentId:null,basicSalary:'3000.00',currency:'MYR',payMode:'monthly',paymentTerm:'monthly',orgDivision:null,employmentCategory:null,orgRegion:null,orgBranch:null,orgTeam:null,orgSection:null,orgLine:null,orgBase:null};
const profileOptions:Record<string,{value:string;label:string}[]>={};
for(const field of PERSONNEL_FIELDS)if(field.allowedValuesOwner?.startsWith('profile_option:'))profileOptions[field.allowedValuesOwner.slice(15)]=[];
const base={employmentId:'fictional-subject',today,isBlacklisted:false,current,departments:[{id:'department-a',name:'Main Operations'}],positions:[],businessUnits:[],grades:[],locations:[],managers:[],
 employmentTypes:[{value:'full_time',label:'Full time'}],profileOptions,terminationReasons:[],cancelHref:'/lifecycle/probation/postings',
 types:[{code:'transfer',label:null,behaviourKind:'transfer'},{code:'confirmation',label:null,behaviourKind:'confirmation'},{code:'probationExtension',label:null,behaviourKind:'probationExtension'}]};
const m=messages.personnelPostings.movement,fill=(text:string,values:Record<string,string>)=>text.replace(/\{(\w+)\}/g,(_,k:string)=>values[k]);
/** The page pre-translates these from the personnelPostings namespace; the island adds no namespace of its own. */
const labels=(canApprove:boolean)=>({banner:fill(m.banner,{posting:'PP-1043'}),hint:fill(canApprove?m.approverHint:m.editorHint,{group:'Fictional People Ops'}),leaveHint:m.leaveHint,submit:canApprove?m.saveAndApprove:m.saveForApproval});
const target=(over:{kind?:string;effectiveDate?:string;endDate?:string|null;remarks?:string|null;canApprove?:boolean}={})=>({id:'00000000-0000-4000-8000-000000001043',label:'PP-1043',revision:3,kind:'confirmation',effectiveDate:'2026-11-24',endDate:null,remarks:null,canApprove:true,...over,labels:labels(over.canApprove??true)});

describe('New Event prefilled from a posting',()=>{
 it('offers Save event and approve to an approver, with only the posting event type and no comparison grid',async()=>{
  const postingAction=vi.fn(async(_previous:string|null,_data:FormData)=>null);
  const {container}=wrap(<MovementNewEvent {...base} posting={target()} postingAction={postingAction}/>);
  expect(screen.getByTestId('movement-posting-banner')).toHaveTextContent('From Personnel posting PP-1043 · Probation Confirmation.');
  expect(screen.getByTestId('movement-posting-banner')).toHaveTextContent('You are in the posting approver group (Fictional People Ops)');
  expect(screen.getByTestId('movement-posting-banner')).toHaveTextContent('Leaving without saving changes nothing.');
  const kind=container.querySelector('select[name="kind"]') as HTMLSelectElement;expect(kind.value).toBe('confirmation');expect(Array.from(kind.options).map(o=>o.value)).toEqual(['confirmation']);
  expect(container.querySelector('input[name="effectiveDate"]')).toHaveValue('2026-11-24');
  expect(container.querySelector('input[name="basicSalary"]')).toBeNull();expect(container.querySelector('input[name="recordHistory"]')).toBeNull();
  expect(screen.getByRole('link',{name:'Cancel'})).toHaveAttribute('href','/lifecycle/probation/postings');
  fireEvent.change(container.querySelector('input[name="effectiveDate"]')!,{target:{value:'2026-11-25'}});
  expect(screen.getByRole('button',{name:'Save event and approve'})).toBeInTheDocument();fireEvent.submit(container.querySelector('form')!);
  await waitFor(()=>expect(postingAction).toHaveBeenCalledTimes(1));
  const data=postingAction.mock.calls[0][1];
  expect(Object.fromEntries(['postingId','postingRevision','postingIntent','employmentId','kind','effectiveDate'].map(k=>[k,data.get(k)]))).toEqual({postingId:'00000000-0000-4000-8000-000000001043',postingRevision:'3',postingIntent:'approve',employmentId:'fictional-subject',kind:'confirmation',effectiveDate:'2026-11-25'});
  for(const key of ['basicSalary','departmentId','gradeId','companyId'])expect(data.has(key),key).toBe(false);
  expect(actions.createMovementEventAction).not.toHaveBeenCalled();expect(actions.saveMovementPageAction).not.toHaveBeenCalled();
 });
 it('offers Save changes for approval to someone outside the approver group and shows the end date for an extension',async()=>{
  const postingAction=vi.fn(async(_previous:string|null,_data:FormData)=>'This posting changed or was already approved. Reload the page and try again.');
  const {container}=wrap(<MovementNewEvent {...base} posting={target({kind:'probationExtension',effectiveDate:'2026-11-01',endDate:'2027-02-01',canApprove:false,remarks:'Fictional extension'})} postingAction={postingAction}/>);
  expect(screen.getByTestId('movement-posting-banner')).toHaveTextContent('The posting stays Pending until Fictional People Ops approves it; Personnel Management does not change yet.');
  expect(container.querySelector('input[name="endDate"]')).toHaveValue('2027-02-01');expect(container.querySelector('input[name="remarks"]')).toHaveValue('Fictional extension');
  expect(screen.queryByRole('button',{name:'Save event and approve'})).toBeNull();
  expect(screen.getByRole('button',{name:'Save changes for approval'})).toBeInTheDocument();fireEvent.submit(container.querySelector('form')!);
  await waitFor(()=>expect(postingAction).toHaveBeenCalledTimes(1));
  expect(postingAction.mock.calls[0][1].get('postingIntent')).toBe('edit');expect(postingAction.mock.calls[0][1].get('endDate')).toBe('2027-02-01');
  expect(await screen.findByRole('alert')).toHaveTextContent('This posting changed or was already approved.');
 });
 it('keeps the ordinary New Event form unchanged without a posting',()=>{
  const {container}=wrap(<MovementNewEvent {...base}/>);
  expect(screen.queryByTestId('movement-posting-banner')).toBeNull();
  expect(Array.from((container.querySelector('select[name="kind"]') as HTMLSelectElement).options).map(o=>o.value)).toEqual(['transfer','confirmation','probationExtension']);
  expect(screen.getByRole('button',{name:'Save Event'})).toBeInTheDocument();expect(container.querySelector('input[name="postingId"]')).toBeNull();
 });
});
