import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import en from '../messages/en.json';
import {MovementImport} from '../app/admin/personnel/import/movement-import';
import {ImportWorkbench} from '../app/admin/personnel/import/import-workbench';
const mocks=vi.hoisted(()=>({catalog:vi.fn(),fetch:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/admin/personnel/import/movement-actions',()=>({movementCatalogAction:mocks.catalog}));
vi.mock('../app/admin/personnel/import/actions',()=>({validateImportAction:vi.fn(),commitImportAction:vi.fn()}));
vi.mock('../app/admin/personnel/import/section-actions',()=>({validateSectionAction:vi.fn(),commitSectionAction:vi.fn(),registerRecordsAction:vi.fn()}));
const companies=[{id:'a',name:'Fictional A'},{id:'b',name:'Fictional B'}],catalog={types:[{code:'increment',label:'Increment',behaviour:'increment'}],companies:[],fields:{departmentId:[],businessUnitId:[],gradeId:[],locationId:[]}};
const row=(row:number,employeeCode:string,status:'valid'|'invalid')=>({row,employeeCode,eventType:'increment',effectiveDate:'2026-11-01',status,errors:status==='invalid'?['employee_sequence_invalid']:[],source:{sheet:'Increment',row:row+5}});
const preview={inputHash:'file-bound',selection:[1,2,3],fileErrors:[],valid:1,excluded:2,employees:[{employeeCode:'BAD',employmentId:'bad',name:'Fictional invalid',fingerprint:null,rows:[row(1,'BAD','invalid'),row(2,'BAD','invalid')]},{employeeCode:'GOOD',employmentId:'good',name:'Fictional valid',fingerprint:'good-fingerprint',rows:[row(3,'GOOD','valid')]}]};
const reference={departments:[],positions:[],costCenters:[],states:[],countries:[],nationalities:[],relationships:[],familyRelationships:[]};
const response=(data:unknown)=>({ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>data});
function mount(workbench=false){render(<NextIntlClientProvider locale="en" messages={en}>{workbench?<ImportWorkbench companies={companies} defaultCompanyId="a" reference={reference}/>:<MovementImport companies={companies} defaultCompanyId="a"/>}</NextIntlClientProvider>);if(workbench)fireEvent.click(screen.getByRole('radio',{name:/^Movement /}));}
async function fill(){await screen.findByRole('option',{name:'Increment'});fireEvent.change(screen.getByLabelText('Movement type'),{target:{value:'increment'}});fireEvent.change(screen.getByLabelText('Or paste CSV'),{target:{value:'Employee ID,Increment Amount,Effective Date\nGOOD,25.13,2026-11-01'}});}
beforeEach(()=>{vi.resetAllMocks();mocks.catalog.mockResolvedValue(catalog);mocks.fetch.mockResolvedValue(response({ok:true,preview}));vi.stubGlobal('fetch',mocks.fetch);vi.stubGlobal('requestAnimationFrame',(fn:()=>void)=>{fn();return 1;});Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:fixture')});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});});afterEach(()=>vi.unstubAllGlobals());
describe('whole-employee Movement import experience',()=>{
 it('keeps the other six section choices and replaces Employment with Movement',()=>{mount(true);expect(screen.getAllByRole('radio')).toHaveLength(7);expect(screen.queryByRole('radio',{name:/^Employment /})).toBeNull();});
 it('cannot salvage a failing predecessor and explicitly acknowledges excluded whole employees',async()=>{
  mount();await fill();fireEvent.click(screen.getByRole('button',{name:'Check file'}));await screen.findByRole('heading',{name:'Review events before importing'});
  const checks=screen.getAllByRole('checkbox',{name:'Include employee'});expect(checks[0]).toBeDisabled();expect(checks[1]).toBeChecked();
  expect(screen.queryByRole('checkbox',{name:/Select row/})).toBeNull();const save=screen.getByRole('button',{name:'Confirm and import selected events'});expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox',{name:/I confirm that 2/}));expect(save).toBeEnabled();
  mocks.fetch.mockResolvedValueOnce(response({ok:true,result:{...preview,imported:1,failed:0,excluded:2,batchId:'batch',byEventType:[]},errorReceipt:'server-display-only'}));fireEvent.click(save);
  await screen.findByRole('heading',{name:'Import result'});const body=mocks.fetch.mock.calls[1][1].body as FormData;expect(JSON.parse(String(body.get('selection')))).toEqual([3]);expect(body.get('records')).toBeNull();expect(body.get('sourceHash')).toBeNull();expect(screen.getByRole('link',{name:'View import audit'})).toHaveAttribute('href','/admin/audit?record=batch');
 });
 it('sends the actual XLSX file and discards old preview/file when company or type context changes',async()=>{
  mount();await fill();const file=new File(['fictional bytes'],'exercise.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});fireEvent.change(screen.getByLabelText(en.people.import.movement.file),{target:{files:[file]}});fireEvent.click(screen.getByRole('button',{name:'Check file'}));await screen.findByRole('heading',{name:'Review events before importing'});
  expect((mocks.fetch.mock.calls[0][1].body as FormData).get('file')).toBe(file);
  fireEvent.change(screen.getByLabelText('Selected company'),{target:{value:'b'}});expect(screen.queryByRole('heading',{name:'Review events before importing'})).toBeNull();expect(screen.getByLabelText('Or paste CSV')).toHaveValue('');
 });
 it.each([undefined,'signed-server-preview'])('retains semantic preview reasons in the result with optional display evidence %s and leaves a manually excluded valid row error-free',async token=>{
  const semantic={...preview,valid:2,excluded:1,employees:[{...preview.employees[0],rows:[{...row(1,'BAD','invalid'),errors:['unknown_reference:departmentId; unknown_reference:departmentId']}]},{...preview.employees[1],rows:[row(2,'GOOD','valid')]},{employeeCode:'MANUAL',employmentId:'manual',name:'Fictional manual',fingerprint:'manual-fingerprint',rows:[row(3,'MANUAL','valid')]}]};
  mocks.fetch.mockResolvedValueOnce(response({ok:true,preview:semantic,previewErrorReceipt:token}));mount();await fill();fireEvent.click(screen.getByRole('button',{name:'Check file'}));await screen.findByRole('heading',{name:'Review events before importing'});
  fireEvent.click(screen.getAllByRole('checkbox',{name:'Include employee'})[2]);fireEvent.click(screen.getByRole('checkbox',{name:/I confirm that 2/}));
  mocks.fetch.mockResolvedValueOnce(response({ok:true,result:{...semantic,imported:1,failed:0,excluded:2,batchId:'batch',byEventType:[],employees:semantic.employees.map(e=>({...e,rows:e.rows.map(r=>({...r,status:e.employeeCode==='GOOD'?'imported':'excluded',errors:[]}))}))},workbookReportUnavailable:!token}));fireEvent.click(screen.getByRole('button',{name:'Confirm and import selected events'}));await screen.findByRole('heading',{name:'Import result'});
  const body=mocks.fetch.mock.calls[1][1].body as FormData;expect(body.get('previewErrorReceipt')).toBe(token??null);expect(body.get('errors')).toBeNull();expect(JSON.parse(String(body.get('selection')))).toEqual([2]);
  expect(screen.getByText(en.people.import.movement.issues.unknown_reference+' · Department')).toBeInTheDocument();expect(screen.queryByText('unknown_reference:departmentId')).toBeNull();expect(screen.getByText('MANUAL · Fictional manual')).toBeInTheDocument();
 });
});
