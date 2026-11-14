import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import * as XLSX from 'xlsx';
import {importProblemSheetRows} from '../lib/import-problem-workbook';
import {movementPreviewProblemLines,movementResultProblemLines} from '../lib/movement-import-problems';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import en from '../messages/en.json';
import {MovementImport} from '../app/admin/personnel/import/movement-import';
import {ImportWorkbench} from '../app/admin/personnel/import/import-workbench';
const mocks=vi.hoisted(()=>({fetch:vi.fn(),jobs:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/admin/personnel/import/movement-actions',()=>({movementCatalogAction:vi.fn()}));
vi.mock('../app/admin/personnel/import/actions',()=>({validateImportAction:vi.fn(),commitImportAction:vi.fn()}));
vi.mock('../app/admin/personnel/import/section-actions',()=>({validateSectionAction:vi.fn(),commitSectionAction:vi.fn(),registerRecordsAction:vi.fn()}));
const companies=[{id:'a',name:'Fictional A'},{id:'b',name:'Fictional B'}];
const row=(row:number,employeeCode:string,status:'valid'|'invalid',errors:string[]=[])=>({row,employeeCode,eventType:'transfer',effectiveDate:'2026-11-01',status,errors,source:{sheet:'Movements',row},sourceRows:[row],companyCode:'EXT'});
const preview={inputHash:'file-bound',selection:[2,3,4],fileErrors:[],valid:1,excluded:2,employees:[
 {key:'company-a|BAD',companyId:'company-a',companyName:'EXT · Fictional A',employeeCode:'BAD',employmentId:'bad',name:'Fictional invalid',fingerprint:null,rows:[row(2,'BAD','invalid',['before_mismatch:departmentId']),row(3,'BAD','invalid',['employee_sequence_invalid'])]},
 {key:'company-a|GOOD',companyId:'company-a',companyName:'EXT · Fictional A',employeeCode:'GOOD',employmentId:'good',name:'Fictional valid',fingerprint:'good-fingerprint',rows:[row(4,'GOOD','valid')]},
]};
const reference={departments:[],positions:[],costCenters:[],states:[],countries:[],nationalities:[],relationships:[],familyRelationships:[]};
const response=(data:unknown)=>({ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>data});
function mount(workbench=false){render(<NextIntlClientProvider locale="en" messages={en}>{workbench?<ImportWorkbench companies={companies} defaultCompanyId="a" reference={reference}/>:<MovementImport/>}</NextIntlClientProvider>);if(workbench)fireEvent.click(screen.getByRole('radio',{name:/^Movement /}));}
const choose=()=>fireEvent.change(screen.getByLabelText(en.people.import.movement.file),{target:{files:[new File(['fictional bytes'],'movements.xlsx')]}});
beforeEach(()=>{vi.resetAllMocks();mocks.fetch.mockResolvedValue(response({ok:true,attemptId:'attempt-1',previewHash:'hash-1',preview}));vi.stubGlobal('fetch',(url:string,init?:RequestInit)=>url==='/admin/personnel/import/movement/jobs'||url==='/admin/personnel/import/movement/checks'?mocks.jobs(url,init):mocks.fetch(url,init));mocks.jobs.mockResolvedValue(response({jobs:[]}));vi.stubGlobal('requestAnimationFrame',(fn:()=>void)=>{fn();return 1;});Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:fixture')});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});});afterEach(()=>vi.unstubAllGlobals());
describe('single-template Movement import screen (ac6645ec)',()=>{
 it('offers the template and import history with no company or movement type selection',()=>{
  mount(true);
  expect(screen.queryByLabelText(en.people.import.movement.company)).toBeNull();expect(screen.queryByLabelText('Movement type')).toBeNull();
  expect(screen.getByRole('button',{name:'Download template'})).toBeEnabled();expect(screen.getByRole('link',{name:'Import history'})).toHaveAttribute('href','/admin/personnel/import/history?kind=movement');
 });
 it('sends the file, keeps an invalid employee out, and confirms only the attempt and chosen employee keys',async()=>{
  mount();choose();fireEvent.click(screen.getByRole('button',{name:'Check file'}));await screen.findByRole('heading',{name:'Review events before importing'});
  const first=mocks.fetch.mock.calls[0][1].body as FormData;expect(first.get('operation')).toBe('preview');expect((first.get('file') as File).name).toBe('movements.xlsx');expect(first.get('companyId')).toBeNull();
  const checks=screen.getAllByRole('checkbox',{name:'Include employee'});expect(checks[0]).toBeDisabled();expect(checks[1]).toBeChecked();
  expect(screen.getByText(en.people.import.movement.issues.before_mismatch+' · Department')).toBeInTheDocument();
  // d9e33556 — each movement names its worksheet and original Excel rows.
  expect(screen.getByText(/Movements · Rows 2 · Invalid/)).toBeInTheDocument();expect(screen.getByText(/Movements · Rows 4 · Valid/)).toBeInTheDocument();expect(screen.getByText('BAD · Fictional invalid · EXT · Fictional A')).toBeInTheDocument();
  const save=screen.getByRole('button',{name:'Confirm and import selected events'});expect(save).toBeDisabled();fireEvent.click(screen.getByRole('checkbox',{name:/I confirm that 2/}));expect(save).toBeEnabled();
  mocks.fetch.mockResolvedValueOnce(response({ok:true,result:{...preview,attemptId:'attempt-1',imported:1,failed:0,excluded:2,byEventType:[],employees:preview.employees.map(e=>({...e,rows:e.rows.map(r=>({...r,status:e.employeeCode==='GOOD'?'imported':'excluded'}))}))}}));fireEvent.click(save);
  await screen.findByRole('heading',{name:'Import result'});const body=mocks.fetch.mock.calls[1][1].body as FormData;
  expect(body.get('attemptId')).toBe('attempt-1');expect(body.get('previewHash')).toBe('hash-1');expect(JSON.parse(String(body.get('employees')))).toEqual(['company-a|GOOD']);expect(body.get('fingerprints')).toBeNull();expect(body.get('selection')).toBeNull();
  expect(screen.getAllByRole('link',{name:en.people.import.movement.viewHistory}).map(link=>link.getAttribute('href'))).toContain('/admin/personnel/good/movement/history');
  expect(screen.getByRole('link',{name:'View this import in Import History'})).toHaveAttribute('href','/admin/personnel/import/history/attempt-1');
 });
 it('lists file-level issues distinctly: an unchanged template has no entries, not an unsupported structure (d9e33556)',async()=>{
  mocks.fetch.mockResolvedValueOnce(response({ok:true,attemptId:'attempt-2',previewHash:'hash-2',preview:{inputHash:'',selection:[],fileErrors:['no_movement_entries'],employees:[],excluded:0,valid:0}}));mount();choose();fireEvent.click(screen.getByRole('button',{name:'Check file'}));
  const alert=await screen.findByRole('alert');expect(alert).toHaveTextContent(en.people.import.movement.issues.no_movement_entries);expect(alert).not.toHaveTextContent(en.people.import.movement.issues.workbook_structure_invalid);
  // d3ba1e9f — a file problem is a whole-file line of the problem table and the Error Log.
  expect(within(screen.getByRole('table')).getByText(en.importProblems.wholeFile)).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Confirm and import selected events'})).toBeNull();
 });
 it('646355e5 slice C — names an Update or Delete and its closed months, and posts the closed-payroll confirmation only when ticked',async()=>{
  const correction={...row(2,'GOOD','valid'),action:'delete',movementId:'7d1c2e4a-5b6f-4a8b-9c0d-1e2f3a4b5c6d',closedPayrollPeriods:['2026-09']};
  const closed={inputHash:'file-bound',selection:[2],fileErrors:[],valid:1,excluded:0,employees:[{key:'company-a|GOOD',companyId:'company-a',companyName:'EXT · Fictional A',employeeCode:'GOOD',employmentId:'good',name:'Fictional valid',fingerprint:'good-fingerprint',rows:[correction]}]};
  mocks.fetch.mockResolvedValueOnce(response({ok:true,attemptId:'attempt-3',previewHash:'hash-3',preview:closed}));mount();choose();fireEvent.click(screen.getByRole('button',{name:'Check file'}));
  await screen.findByRole('heading',{name:'Review events before importing'});
  expect(screen.getByText(/^Delete · /)).toBeInTheDocument();expect(screen.getByText('Payroll for 2026-09 is already closed.')).toBeInTheDocument();
  const box=screen.getByRole('checkbox',{name:en.people.import.movement.sheet.closedPayrollAcknowledge});expect(box).not.toBeChecked();
  const save=screen.getByRole('button',{name:'Confirm and import selected events'});expect(save).toBeEnabled();
  mocks.fetch.mockResolvedValueOnce(response({ok:false,message:'stop here'}));fireEvent.click(save);await screen.findByText('stop here');
  expect((mocks.fetch.mock.calls[1][1].body as FormData).get('acknowledgeClosedPayroll')).toBe('false');
  fireEvent.click(box);mocks.fetch.mockResolvedValueOnce(response({ok:false,message:'stop again'}));fireEvent.click(save);await screen.findByText('stop again');
  expect((mocks.fetch.mock.calls[2][1].body as FormData).get('acknowledgeClosedPayroll')).toBe('true');
 });
 // Board d3ba1e9f — the check and result screens list the problems in the standard table, and "Download Error Log"
 // builds the .xlsx in the browser from the SAME lines (the client CSV is gone).
 const root=createTranslator({locale:'en',messages:en}) as unknown as {(k:string):string;has(k:string):boolean};
 const resolve=(k:string,f:string)=>root.has(k)?root(k):f;
 const shared=createTranslator({locale:'en',messages:en,namespace:'importProblems'}) as unknown as (k:string)=>string;
 const tableCells=()=>within(screen.getByRole('table')).getAllByRole('row').map(r=>within(r).queryAllByRole(r.querySelector('th')?'columnheader':'cell').map(c=>c.textContent??''));
 it('lists the check problems with Excel rows and fields, and downloads the same lines as the Error Log (d3ba1e9f)',async()=>{
  mount();choose();fireEvent.click(screen.getByRole('button',{name:'Check file'}));await screen.findByRole('heading',{name:'Review events before importing'});
  const expected=importProblemSheetRows({lines:movementPreviewProblemLines(preview as never,resolve),t:shared});
  expect(tableCells()).toEqual(expected);
  expect(expected.slice(1).map(r=>[r[0],r[1]])).toEqual([['Movements','2'],['Movements','3']]);
  expect(expected[1]).toContain('Department');expect(expected[1]).toContain(en.people.import.movement.issues.before_mismatch);
  expect(expected[2]).toContain(en.importProblems.result.cancelled);
  expect(screen.queryByRole('button',{name:en.people.import.movement.downloadErrors})).toBeNull();
  const create=URL.createObjectURL as unknown as ReturnType<typeof vi.fn>;
  fireEvent.click(screen.getByRole('button',{name:en.importProblems.downloadLog}));
  const click=HTMLAnchorElement.prototype.click as unknown as ReturnType<typeof vi.fn>;
  await waitFor(()=>expect(click).toHaveBeenCalledTimes(1));
  const blob=create.mock.calls.at(-1)![0] as Blob;
  const bytes=await new Promise<ArrayBuffer>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result as ArrayBuffer);reader.onerror=reject;reader.readAsArrayBuffer(blob);});
  const wb=XLSX.read(new Uint8Array(bytes),{type:'array'});
  expect(XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Errors,{header:1,raw:false,defval:''})).toEqual(expected);
  expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('movements-error-log.xlsx');
 });
 it('lists a refused save on the result screen as stopping that employee (d3ba1e9f)',async()=>{
  mount();choose();fireEvent.click(screen.getByRole('button',{name:'Check file'}));await screen.findByRole('heading',{name:'Review events before importing'});
  fireEvent.click(screen.getByRole('checkbox',{name:/I confirm that 2/}));
  const result={...preview,attemptId:'attempt-1',imported:0,failed:1,excluded:2,byEventType:[],employees:preview.employees.map(e=>({...e,rows:e.rows.map(r=>e.employeeCode==='GOOD'?{...r,status:'failed',errors:['change_refused']}:{...r,status:'excluded',errors:[]})}))};
  mocks.fetch.mockResolvedValueOnce(response({ok:true,result}));fireEvent.click(screen.getByRole('button',{name:'Confirm and import selected events'}));
  await screen.findByRole('heading',{name:'Import result'});
  const expected=importProblemSheetRows({lines:movementResultProblemLines(result as never,preview as never,resolve),t:shared});
  expect(tableCells()).toEqual(expected);
  expect(expected.slice(1).map(r=>[r[1],r.at(-1)])).toEqual([['2',en.importProblems.result.refused],['3',en.importProblems.result.cancelled],['4',en.importProblems.result.stopped]]);
 });
 it('shows the import history refusal message as returned',async()=>{
  mocks.fetch.mockResolvedValueOnce(response({ok:false,error:'workbook_old_layout'}));mount();choose();fireEvent.click(screen.getByRole('button',{name:'Check file'}));
  expect(await screen.findByRole('alert')).toHaveTextContent(en.people.import.movement.issues.workbook_old_layout);
 });
});
