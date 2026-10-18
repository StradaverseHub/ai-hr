import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {beforeEach,describe,it,expect,vi} from 'vitest';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import {MovementImport} from '../app/admin/personnel/import/movement-import';
import {ImportWorkbench} from '../app/admin/personnel/import/import-workbench';
import type {MovementImportPreview,MovementImportResult} from '../lib/movement-import-contract';
const mocks=vi.hoisted(()=>({preview:vi.fn(),commit:vi.fn(),catalog:vi.fn(),read:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/admin/personnel/import/movement-actions',()=>({movementCatalogAction:mocks.catalog,previewMovementAction:mocks.preview,commitMovementAction:mocks.commit}));
vi.mock('../app/admin/personnel/import/actions',()=>({validateImportAction:vi.fn(),commitImportAction:vi.fn()}));
vi.mock('../app/admin/personnel/import/section-actions',()=>({validateSectionAction:vi.fn(),commitSectionAction:vi.fn(),registerRecordsAction:vi.fn()}));
vi.mock('../lib/import-file',async original=>({...await original<typeof import('../lib/import-file')>(),readImportFile:mocks.read}));
const companies=[{id:'a',name:'Fictional A'},{id:'b',name:'Fictional B'}];
const rows:MovementImportPreview['employees'][number]['rows']=[{row:2,employeeCode:'EMP-0004',eventType:'promotion',effectiveDate:'2026-10-18',status:'valid',errors:[],before:{basicSalary:'3000.00'},proposed:{basicSalary:'3500.00'}},{row:3,employeeCode:'EMP-0004',eventType:'bad_type',effectiveDate:'2026-10-19',status:'invalid',errors:['unknown_reference:event_type']},{row:4,employeeCode:'EMP-0004',eventType:'transfer',effectiveDate:'2026-10-20',status:'valid',errors:[],before:{departmentId:'Finance'},proposed:{departmentId:'Operations'}}];
const initial:MovementImportPreview={inputHash:'input',selection:[2,3,4],fileErrors:[],excluded:1,valid:2,employees:[{employeeCode:'EMP-0004',employmentId:'e',name:'Fictional Employee',fingerprint:'original',rows}]};
const selected:MovementImportPreview={...initial,selection:[2,4],employees:[{...initial.employees[0],fingerprint:'selected',rows:rows.map(row=>row.row===3?{...row,status:'excluded',errors:[]}:row)}]};
const result:MovementImportResult={employees:[{...selected.employees[0],rows:selected.employees[0].rows.map(row=>row.status==='valid'?{...row,status:'imported'}:row)}],imported:2,excluded:1,failed:0,byEventType:[{eventType:'promotion',imported:1,failed:0,excluded:0},{eventType:'transfer',imported:1,failed:0,excluded:0},{eventType:'bad_type',imported:0,failed:0,excluded:1}]};
const reference={departments:[],positions:[],costCenters:[],states:[],countries:[],nationalities:[],relationships:[],familyRelationships:[]};
function mount(workbench=false){render(<NextIntlClientProvider locale="en" messages={en}>{workbench?<ImportWorkbench companies={companies} defaultCompanyId="a" reference={reference}/>:<MovementImport companies={companies} defaultCompanyId="a"/>}</NextIntlClientProvider>);if(workbench)fireEvent.click(screen.getByRole('radio',{name:/^Movement /}));}
function input(){fireEvent.change(screen.getByLabelText('Or paste CSV'),{target:{value:'employee_code,event_type,effective_date\nEMP-0004,promotion,18-Oct-2026'}});}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {resolve,promise};}
beforeEach(()=>{vi.resetAllMocks();mocks.preview.mockResolvedValue(initial);mocks.commit.mockResolvedValue(result);mocks.read.mockResolvedValue({name:'fictional.csv',text:'new bytes'});Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:fixture')});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});});
describe('Movement import selection and immutable confirmation',()=>{
 it('retains all seven choices and replaces only Employment with Movement',()=>{
  mount(true);expect(screen.getAllByRole('radio')).toHaveLength(7);expect(screen.queryByRole('radio',{name:/^Employment /})).toBeNull();
  for(const name of ['Everything','Profile','Movement',en.people.import.sectionBankStatutory,'Family','Qualifications','Emergency Contacts'])expect(screen.getByRole('radio',{name:new RegExp('^'+name+' ')})).toBeInTheDocument();
 });
 it('requires rechecking the valid subset and explicit excluded-row acknowledgement, retaining its refusal reason',async()=>{
  mocks.preview.mockResolvedValueOnce(initial).mockResolvedValueOnce(selected);mount();input();fireEvent.click(screen.getByRole('button',{name:'Check file'}));
  expect(await screen.findByRole('heading',{name:'Review events before importing'})).toBeInTheDocument();expect(screen.getByRole('checkbox',{name:'Select row 3'})).toBeDisabled();
  const confirm=screen.getByRole('button',{name:'Confirm and import selected events'});expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Recheck selected sequence'}));await waitFor(()=>expect(mocks.preview).toHaveBeenLastCalledWith('a',expect.any(String),[2,4]));
  const ack=await screen.findByRole('checkbox',{name:/I confirm that 1/});expect(confirm).toBeDisabled();fireEvent.click(ack);expect(screen.getByRole('button',{name:'Confirm and import selected events'})).toBeEnabled();
  expect(screen.getByText(/The option is unavailable/)).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Confirm and import selected events'}));
  await screen.findByRole('heading',{name:'Import result'});expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({companyId:'a',selection:[2,4],inputHash:'input',fingerprints:{'EMP-0004':'selected'},acknowledgeExcluded:true}));
  expect(screen.getByText(/The option is unavailable/)).toBeInTheDocument();expect(screen.getByRole('link',{name:'Open Movement history'})).toHaveAttribute('href','/admin/personnel/e?tab=careerMovement');
 });
 it('disables confirmation when removing a predecessor makes the remaining sequence invalid',async()=>{
  const dependent={...selected,selection:[4],valid:0,excluded:3,employees:[{...selected.employees[0],rows:selected.employees[0].rows.map(row=>row.row===4?{...row,status:'invalid' as const,errors:['same_date_conflicting_changes']}:{...row,status:'excluded' as const})}]};
  mocks.preview.mockResolvedValueOnce(selected).mockResolvedValueOnce(dependent);mount();input();fireEvent.click(screen.getByRole('button',{name:'Check file'}));await screen.findByRole('heading',{name:'Review events before importing'});
  fireEvent.click(screen.getByRole('checkbox',{name:'Select row 2'}));fireEvent.click(screen.getByRole('button',{name:'Recheck selected sequence'}));
  await screen.findByText(/Two selected events change the same field/);expect(screen.getByRole('button',{name:'Confirm and import selected events'})).toBeDisabled();expect(mocks.commit).not.toHaveBeenCalled();
 });
 it('invalidates an old preview after editing CSV or the selected company',async()=>{
  mount();input();fireEvent.click(screen.getByRole('button',{name:'Check file'}));await screen.findByRole('heading',{name:'Review events before importing'});
  fireEvent.change(screen.getByLabelText('Selected company'),{target:{value:'b'}});expect(screen.queryByRole('heading',{name:'Review events before importing'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Check file'}));await screen.findByRole('heading',{name:'Review events before importing'});input();expect(screen.queryByRole('heading',{name:'Review events before importing'})).toBeNull();
 });
 it('removes the previous ready preview when a new check fails',async()=>{
  mocks.preview.mockResolvedValueOnce({...selected,excluded:0,selection:[2,4]}).mockRejectedValueOnce(new Error('fixture failure'));mount();input();fireEvent.click(screen.getByRole('button',{name:'Check file'}));await screen.findByRole('heading',{name:'Review events before importing'});
  fireEvent.click(screen.getByRole('button',{name:'Recheck selected sequence'}));await screen.findByRole('alert');expect(screen.queryByRole('button',{name:'Confirm and import selected events'})).toBeNull();expect(mocks.commit).not.toHaveBeenCalled();
 });
 it('freezes file, CSV, selected company, rows and all chooser radios until the real write finishes',async()=>{
  const saving=deferred<MovementImportResult>();mocks.preview.mockResolvedValue({...selected,excluded:0});mocks.commit.mockReturnValue(saving.promise);mount(true);input();fireEvent.click(screen.getByRole('button',{name:'Check file'}));await screen.findByRole('heading',{name:'Review events before importing'});
  fireEvent.click(screen.getByRole('button',{name:'Confirm and import selected events'}));await waitFor(()=>expect(mocks.commit).toHaveBeenCalledOnce());
  expect(screen.getByLabelText('Or paste CSV')).toBeDisabled();expect(screen.getByLabelText('Selected company')).toBeDisabled();expect(screen.getByLabelText('Excel or CSV file')).toBeDisabled();for(const radio of screen.getAllByRole('radio'))expect(radio).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Or paste CSV'),{target:{value:'forged replacement'}});fireEvent.change(screen.getByLabelText('Selected company'),{target:{value:'b'}});
  expect(screen.getByLabelText('Or paste CSV')).not.toHaveValue('forged replacement');expect(screen.getByLabelText('Selected company')).toHaveValue('a');
  await act(async()=>saving.resolve(result));await screen.findByRole('heading',{name:'Import result'});expect(screen.getByLabelText('Or paste CSV')).toBeDisabled();for(const radio of screen.getAllByRole('radio'))expect(radio).toBeEnabled();
 });
 it('shows human current/proposed values and affected payroll warnings without claiming a completed payroll was recalculated',async()=>{
  mocks.preview.mockResolvedValue({...selected,employees:[{...selected.employees[0],rows:[{...selected.employees[0].rows[0],payrollFlaggedPeriods:['2026-09']}]}]});mount();input();fireEvent.click(screen.getByRole('button',{name:'Check file'}));await screen.findByRole('heading',{name:'Review events before importing'});
  fireEvent.click(screen.getByText('Current and proposed values'));expect(screen.getByText('3000.00')).toBeInTheDocument();expect(screen.getByText('3500.00')).toBeInTheDocument();expect(screen.getByText(/does not recalculate a completed payroll/)).toBeInTheDocument();
 });
 it.each([{locale:'en',messages:en},{locale:'ms',messages:ms},{locale:'zh',messages:zh},{locale:'ta',messages:ta},{locale:'th',messages:th},{locale:'vi',messages:viMessages}])('$locale renders the full ready and excluded flow without missing messages',async entry=>{
  const errors=vi.spyOn(console,'error');render(<NextIntlClientProvider locale={entry.locale} messages={entry.messages}><MovementImport companies={companies} defaultCompanyId="a"/></NextIntlClientProvider>);
  const copy=entry.messages.people.import.movement;fireEvent.change(screen.getByLabelText(copy.csv),{target:{value:'fixture'}});fireEvent.click(screen.getByRole('button',{name:copy.check}));await screen.findByRole('heading',{name:copy.previewTitle});
  expect(screen.getByText(copy.sequenceHint)).toBeInTheDocument();expect(errors.mock.calls.flat().join(' ')).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
 });
});
