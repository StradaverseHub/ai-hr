/**
 * Board 8d02748a — every import log shows a readable batch number with the file name, and "Imported by" as
 * name (Employee ID); no internal 36-character id appears in visible text or tooltips, while links,
 * downloads and revert keep the full internal id. Fictional data only.
 */
import type {ReactNode} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';

const m=vi.hoisted(()=>({
 jobs:vi.fn(),legacy:vi.fn(),readImport:vi.fn(),readJob:vi.fn(),historyList:vi.fn(),historyGet:vi.fn(),clockList:vi.fn(),clockGet:vi.fn(),
}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator:tr,createFormatter:fmt}=await import('next-intl');const messages=(await import('../messages/en.json')).default;
 return {getTranslations:async(namespace?:string)=>tr({locale:'en',messages,namespace:namespace as never}),getFormatter:async()=>fmt({locale:'en',timeZone:'Asia/Kuala_Lumpur'}),getLocale:async()=>'en'};
});
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('notFound');},useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('@/lib/scope',()=>({scopedAdmin:async()=>({s:{userId:'viewer'},scopeIds:['company-a']})}));
vi.mock('@/lib/authz',()=>({requireAdmin:async()=>({userId:'viewer'})}));
vi.mock('@/packs/payroll/service',()=>({listIndividualImportJobs:m.jobs,listIndividualImports:m.legacy,readIndividualImport:m.readImport,readIndividualImportJob:m.readJob,listPayrollHistoryAttempts:m.historyList,getPayrollHistoryAttempt:m.historyGet}));
vi.mock('@/packs/attendance/service',()=>({listClockingImportRuns:m.clockList,getClockingImportRun:m.clockGet}));
vi.mock('../app/payroll/transactions/individual/imports/[attemptId]/result-rows',()=>({IndividualImportRows:()=>null}));
vi.mock('../app/payroll/transactions/individual/imports/batches/[jobId]/batch-controls',()=>({ImportBatchControls:()=>null}));
vi.mock('../app/payroll/transactions/import-excel/individual-actions',()=>({revertIndividualImportAction:vi.fn()}));
vi.mock('../app/payroll/history-import/revision-preview',()=>({RevisionPreview:()=>null}));
vi.mock('../app/payroll/history-import/logs/[attemptId]/revert-control',()=>({RevertControl:({attemptId}:{attemptId:string})=><button data-attempt={attemptId}>revert</button>}));
// The log page's "recent imports" table is an async server component of its own (tested directly below).
// Rendered inside the log page as JSX it is skipped (React DOM cannot render a nested async component); called
// directly by the list test it is the real table.
vi.mock('../app/attendance/import/logs/runs-table',async importOriginal=>{const real=await importOriginal<typeof import('../app/attendance/import/logs/runs-table')>();return {RunsTable:(props:Parameters<typeof real.RunsTable>[0]&{direct?:boolean})=>props.direct?real.RunsTable(props):null};});
vi.mock('../app/admin/leave-config/history-import/actions',()=>({validateLeaveHistoryImportAction:vi.fn(),commitLeaveHistoryImportAction:vi.fn()}));
vi.mock('../app/admin/leave-config/bf-import/actions',()=>({validateLeaveBfImportAction:vi.fn(),commitLeaveBfImportAction:vi.fn(),reverseLeaveBfImportAction:vi.fn()}));

import IndividualImportLogPage from '../app/payroll/transactions/individual/imports/page';
import IndividualImportDetailsPage from '../app/payroll/transactions/individual/imports/[attemptId]/page';
import ImportBatchPage from '../app/payroll/transactions/individual/imports/batches/[jobId]/page';
import PayrollHistoryLogsPage from '../app/payroll/history-import/logs/page';
import PayrollHistoryLogPage from '../app/payroll/history-import/logs/[attemptId]/page';
import {RunsTable} from '../app/attendance/import/logs/runs-table';
import ClockingImportLogPage from '../app/attendance/import/logs/[runId]/page';
import {LeaveDataImport} from '../app/admin/leave-config/data-import/leave-data-import';
import {LeaveBfImport} from '../app/admin/leave-config/bf-import/leave-bf-import';
import {LeaveHistoryImport} from '../app/admin/leave-config/history-import/leave-history-import';

const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const JOB='7f3a2c19-4b8e-4d21-9a6f-0c5e8b13d7a2',LEGACY='2d84e6b0-91c3-4a7f-b52e-e8f04a6c19d3',ATTEMPT='9e01b7c4-3c2a-4f00-8a1b-5d6e7f809a1b';
const USER='b91e07d4-2c6a-4f3b-8e15-6a9d4c2f0e71',ADMIN='5c0a9e3f-7d12-4e8b-a46c-31f2b8d07e94';
const aisyah={kind:'person' as const,name:'Aisyah Rahman',employeeCode:'EMP-0412'};
const lim={kind:'person' as const,name:'Lim Wei Jie',employeeCode:'EMP-0218'};
const admin={kind:'unlinked' as const,loginSuffix:'9C41E2'};
const wrap=(node:ReactNode)=>render(<NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>);
function assertNoRawIds(container:HTMLElement){
 expect(container.textContent).not.toMatch(UUID);
 for(const el of container.querySelectorAll('[title]'))expect(el.getAttribute('title')).not.toMatch(UUID);
}
const preview={total:48,valid:48,invalid:0,rows:[]};
const attempt=(over:Record<string,unknown>={})=>({id:ATTEMPT,sourceName:'Oct-2026-claims-adjust.xlsx',method:'monthly',createdBy:ADMIN,createdAt:'2026-10-28T01:15:00.000Z',state:'completed',records:[],preview,outcomes:[],written:30,recalcBatchIds:[],revertedAt:null,revertedBy:null,events:[],createdByActor:admin,revertedByActor:null,jobId:null,...over});
const jobRow={id:JOB,source_name:'Nov-2026-overtime.xlsx',created_by:USER,created_at:new Date('2026-11-05T02:42:00Z'),started_at:null,finished_at:null,attempt_id:null,state:'completed',processed:48,total:48,written:48,failed_rows:0,method:'monthly',error:null,created_by_actor:aisyah};

beforeEach(()=>{vi.clearAllMocks();});
afterEach(cleanup);

describe('Payroll > Individual Transaction > Import log',()=>{
 it('folds the file under a short batch number linking by full id and shows Imported by as name (Employee ID)',async()=>{
  m.jobs.mockResolvedValue([jobRow]);m.legacy.mockResolvedValue([{...attempt({id:LEGACY,createdBy:USER,sourceName:'shift-allowance-wk44.xlsx',createdAt:'2026-11-03T08:05:00.000Z',createdByActor:lim})}]);
  const {container}=wrap(await IndividualImportLogPage({searchParams:Promise.resolve({})}));
  const headers=screen.getAllByRole('columnheader').map(th=>th.textContent);
  expect(headers).toEqual(['Batch reference','Input method','Date and time','Imported by','Outcome','Progress',en.payroll.individualImport.details]);
  const batch=screen.getByRole('link',{name:'Batch 7F3A2C19'});expect(batch).toHaveAttribute('href',`/payroll/transactions/individual/imports/batches/${JOB}`);
  expect(within(batch.closest('td')!).getByText('Nov-2026-overtime.xlsx')).toBeInTheDocument();
  expect(screen.getByRole('link',{name:'Batch 2D84E6B0'})).toHaveAttribute('href',`/payroll/transactions/individual/imports/${LEGACY}`);
  expect(screen.getByText('Aisyah Rahman (EMP-0412)')).toBeInTheDocument();expect(screen.getByText('Lim Wei Jie (EMP-0218)')).toBeInTheDocument();
  assertNoRawIds(container);
 });
 it('keeps the full id in the older-page cursor',async()=>{
  const rows=Array.from({length:101},(_,i)=>({...jobRow,id:`${String(i).padStart(8,'0')}-0000-4000-8000-000000000000`,created_at:new Date(Date.UTC(2026,10,5,0,0,0)-i*60000)}));
  m.jobs.mockResolvedValue(rows);m.legacy.mockResolvedValue([]);
  wrap(await IndividualImportLogPage({searchParams:Promise.resolve({})}));
  expect(screen.getByRole('link',{name:en.payroll.individualImport.older}).getAttribute('href')).toContain('beforeId=00000099-0000-4000-8000-000000000000');
 });
 it('shows the batch number, readable importer, reverter and audit actors on the details page, and revert names the batch',async()=>{
  m.readImport.mockResolvedValue(attempt({jobId:JOB,createdByActor:aisyah,events:[{type:'completed',at:'2026-10-28T01:16:00.000Z',actorId:USER,actor:aisyah},{type:'reverted',at:'2026-10-29T01:16:00.000Z',actorId:ADMIN,actor:admin}]}));
  const {container}=wrap(await IndividualImportDetailsPage({params:Promise.resolve({attemptId:ATTEMPT})}));
  expect(screen.getAllByText('Batch 7F3A2C19').length).toBeGreaterThan(0);
  expect(screen.getByText(/Imported by: Aisyah Rahman \(EMP-0412\)/)).toBeInTheDocument();
  expect(screen.getByText(/Administrator login \(no employee record · login ending 9C41E2\)/)).toBeInTheDocument();
  expect(screen.getByText(/Revert Batch 7F3A2C19 \(Oct-2026-claims-adjust.xlsx\)\?/)).toBeInTheDocument();
  assertNoRawIds(container);
 });
 it('uses the attempt\'s own number for a legacy attempt and shows Unavailable user for a missing login',async()=>{
  m.readImport.mockResolvedValue(attempt({createdByActor:{kind:'unavailable'},state:'reverted',revertedAt:'2026-10-29T01:16:00.000Z',revertedBy:USER,revertedByActor:lim}));
  const {container}=wrap(await IndividualImportDetailsPage({params:Promise.resolve({attemptId:ATTEMPT})}));
  expect(screen.getByText('Batch 9E01B7C4')).toBeInTheDocument();expect(screen.getByText(/Imported by: Unavailable user/)).toBeInTheDocument();expect(screen.getByText(/Lim Wei Jie \(EMP-0218\)/)).toBeInTheDocument();
  assertNoRawIds(container);
 });
 it('shows the batch number and importer on the batch page while the workbook download keeps the full id',async()=>{
  m.readJob.mockResolvedValue(jobRow);
  const {container}=wrap(await ImportBatchPage({params:Promise.resolve({jobId:JOB})}));
  expect(screen.getByText('Batch 7F3A2C19')).toBeInTheDocument();expect(screen.getByText(/Imported by: Aisyah Rahman \(EMP-0412\)/)).toBeInTheDocument();
  expect(screen.getByRole('link',{name:en.payroll.individualImport.downloadWorkbook})).toHaveAttribute('href',`/payroll/transactions/individual/imports/batches/${JOB}/workbook`);
  assertNoRawIds(container);
 });
});

describe('Payroll > Import payroll history > Log File',()=>{
 const item={id:ATTEMPT,sourceName:'history-2025.xlsx',sourceHash:'a'.repeat(64),companyIds:[],plan:{rows:[{companyName:'Acme Sdn Bhd'}],counts:{total:1,changed:1,unchanged:0,invalid:0}},createdBy:USER,createdByName:'Aisyah Rahman',createdByActor:aisyah,createdAt:new Date('2026-10-28T01:15:00Z'),
  events:[{id:'e1',attemptId:ATTEMPT,kind:'confirmed',actorId:ADMIN,actor:admin,actorName:null,detail:{},changes:[{}],createdAt:new Date('2026-10-28T01:20:00Z')}]};
 it('shows the batch number with the source file, and Imported by, on the log list',async()=>{
  m.historyList.mockResolvedValue({items:[item],nextCursor:null});
  const {container}=wrap(await PayrollHistoryLogsPage({searchParams:Promise.resolve({})}));
  expect(screen.getAllByRole('columnheader').map(th=>th.textContent)).toEqual(['Batch reference','Date and time','Imported by','Companies','Outcome'].map(label=>label==='Date and time'?en.payroll.historyRevisions.time:label==='Companies'?en.payroll.historyRevisions.companies:label==='Outcome'?en.payroll.historyRevisions.outcome:label));
  expect(screen.getByRole('link',{name:'Batch 9E01B7C4'})).toHaveAttribute('href',`/payroll/history-import/logs/${ATTEMPT}`);
  expect(screen.getByText('history-2025.xlsx')).toBeInTheDocument();expect(screen.getByText('Aisyah Rahman (EMP-0412)')).toBeInTheDocument();
  assertNoRawIds(container);
 });
 it('shows the batch number, importer and audit actor on the details page; downloads and revert keep the full id',async()=>{
  m.historyGet.mockResolvedValue(item);
  const {container}=wrap(await PayrollHistoryLogPage({params:Promise.resolve({attemptId:ATTEMPT})}));
  expect(screen.getByText('Batch 9E01B7C4')).toBeInTheDocument();expect(screen.getByText('Aisyah Rahman (EMP-0412)')).toBeInTheDocument();
  expect(screen.getByText('Administrator login (no employee record · login ending 9C41E2)')).toBeInTheDocument();
  expect(screen.getByRole('link',{name:en.payroll.historyRevisions.downloadSource})).toHaveAttribute('href',`/payroll/history-import/logs/${ATTEMPT}/source`);
  expect(screen.getByRole('link',{name:en.payroll.historyRevisions.downloadReport})).toHaveAttribute('href',`/payroll/history-import/logs/${ATTEMPT}/report`);
  expect(container.querySelector('[data-attempt]')).toHaveAttribute('data-attempt',ATTEMPT);
  assertNoRawIds(container);
 });
});

describe('Attendance > Import Clocking Data > Import logs',()=>{
 const run={id:JOB,createdAt:new Date('2026-11-05T02:42:00Z'),fileName:'clock-nov.csv',fileBytes:10,mappingId:null,mappingName:'AIHR Standard Template',userName:'Aisyah Rahman',actor:aisyah,totalLines:2,validLines:2,importedLines:2,duplicateLines:0,unmatchedCardLines:0,invalidDatetimeLines:0,otherErrorLines:0,failedLines:0,daysUpdated:1,employeesUpdated:1,failureReason:null,status:'successful'};
 it('uses the Batch reference cell and Imported by on the list',async()=>{
  const {container}=wrap(await (RunsTable as unknown as (props:{direct:boolean;runs:unknown[]})=>Promise<ReactNode>)({direct:true,runs:[run,{...run,id:LEGACY,fileName:'clock-old.csv',actor:{kind:'unavailable'},userName:null}]}));
  expect(screen.getByRole('link',{name:'Batch 7F3A2C19'})).toHaveAttribute('href',`/attendance/import/logs/${JOB}`);
  expect(screen.getByText('clock-nov.csv')).toBeInTheDocument();expect(screen.getByText('Aisyah Rahman (EMP-0412)')).toBeInTheDocument();expect(screen.getByText('Unavailable user')).toBeInTheDocument();
  expect(screen.getAllByText('Batch reference').length).toBeGreaterThan(0);expect(screen.getAllByText('Imported by').length).toBeGreaterThan(0);
  assertNoRawIds(container);
 });
 it('shows the batch number and importer on each log page',async()=>{
  m.clockGet.mockResolvedValue({run,lines:[]});m.clockList.mockResolvedValue([run]);
  const {container}=wrap(await ClockingImportLogPage({params:Promise.resolve({runId:JOB}),searchParams:Promise.resolve({})}));
  expect(screen.getAllByText('Batch 7F3A2C19').length).toBeGreaterThan(0);expect(screen.getAllByText('Aisyah Rahman (EMP-0412)').length).toBeGreaterThan(0);
  assertNoRawIds(container);
 });
});

describe('Leave Configuration > Leave Data Import > Import history',()=>{
 const bf={id:JOB,actorName:'Aisyah Rahman',actor:aisyah,fileName:'bf-2026.csv',mode:'replace' as const,totalRows:1,importedRows:1,failedRows:0,ledgerRows:1,errors:[],errorsTruncated:false,reversedAt:null,createdAt:'2026-11-05T02:42:00.000Z'};
 const history={id:LEGACY,actorName:null,actor:admin,fileName:'',totalRows:1,importedRows:1,failedRows:0,duplicateRows:0,errors:[],errorsTruncated:false,createdAt:'2026-11-04T02:42:00.000Z'};
 it('gives the combined table the Batch reference cell and no user column',async()=>{
  const {container}=wrap(<LeaveDataImport initialType={null} historyRuns={[history]} bfRuns={[bf]}/>);
  expect(screen.getByText('Batch 7F3A2C19')).toBeInTheDocument();expect(screen.getByText('Batch 2D84E6B0')).toBeInTheDocument();
  expect(screen.getByText('bf-2026.csv')).toBeInTheDocument();expect(screen.getByText(en.admin.leaveDataImport.pasted)).toBeInTheDocument();
  expect(screen.queryByText('Imported by')).toBeNull();
  assertNoRawIds(container);
  await userEvent.setup().click(screen.getAllByRole('button',{name:en.admin.leaveDataImport.details})[0]);
  expect(screen.getAllByText('Aisyah Rahman (EMP-0412)').length).toBeGreaterThan(0);
 });
 it('shows Imported by in the Brought-Forward and Leave History logs',()=>{
  const {container}=wrap(<><LeaveBfImport historyOnly runs={[bf]}/><LeaveHistoryImport historyOnly runs={[history]}/></>);
  expect(screen.getByText('Aisyah Rahman (EMP-0412)')).toBeInTheDocument();
  expect(screen.getByText('Administrator login (no employee record · login ending 9C41E2)')).toBeInTheDocument();
  expect(screen.getAllByText('Imported by')).toHaveLength(2);expect(screen.getAllByText('Batch reference')).toHaveLength(2);
  assertNoRawIds(container);
 });
});
