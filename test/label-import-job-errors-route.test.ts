/** Board c074c6b8: GET .../import/jobs/{id}/errors serves a finished import's rows from what its worker stored. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import * as XLSX from 'xlsx';
import en from '../messages/en.json';
import zh from '../messages/zh.json';
const calls=vi.hoisted(()=>({admin:vi.fn(async()=>({s:{tenantId:'fictional-tenant'}})),read:vi.fn(),locale:{value:'en'}}));
vi.mock('../lib/scope',()=>({scopedAdmin:calls.admin}));
vi.mock('../core/system-label-import-job',()=>{
 class SystemLabelImportJobError extends Error{constructor(message:string,readonly status=400){super(message);}}
 return {readSystemLabelImportProblems:calls.read,SystemLabelImportJobError};
});
vi.mock('next-intl/server',async()=>{
 const {labelRootTranslator}=await import('./label-import-translators');
 const catalogues={en:(await import('../messages/en.json')).default,zh:(await import('../messages/zh.json')).default} as Record<string,object>;
 return {getTranslations:vi.fn(async()=>labelRootTranslator(calls.locale.value,catalogues[calls.locale.value]))};
});
import {GET} from '../app/admin/settings/system-labels/import/jobs/[jobId]/errors/route';
import {SystemLabelImportJobError} from '../core/system-label-import-job';
import {labelImportProblemLines,labelProblemTranslator} from '../lib/system-label-import-problems';
import {importProblemSheetRows} from '../lib/import-problem-workbook';
import {IMPORT_PROBLEM_SCREEN_LIMIT} from '../lib/import-problem-lines';
import type {LabelImportPreviewRow} from '../lib/system-label-definition';
import {labelRootTranslator} from './label-import-translators';

const JOB='00000000-0000-4000-8000-0000000000aa';
const blocked:LabelImportPreviewRow[]=Array.from({length:250},(_,i)=>({sheet:'division',row:i+2,values:{Code:`DUP_${i}`},after:{},before:null,
 outcome:'skip',selected:false,reason:'duplicate',reasonDetail:'duplicate',reasonColumn:'Code',message:'SERVER_ENGLISH'}));
const source=(p:Record<string,unknown>={})=>({id:JOB,state:'completed',blocked,failed:[],errors:[],error:null,legacy:false,...p});
const get=(query='')=>GET(new Request(`http://localhost/admin/settings/system-labels/import/jobs/${JOB}/errors${query}`),{params:Promise.resolve({jobId:JOB})});
beforeEach(()=>{vi.clearAllMocks();calls.locale.value='en';calls.read.mockResolvedValue(source());});

describe('System Labels job errors route',()=>{
 it.each([['en',en],['zh',zh]] as const)('lists the stored refused rows (first %s page bounded) and downloads all of them',async(locale,messages)=>{
  calls.locale.value=locale;
  const response=await get();expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
  const body=await response.json() as {lines:{row:number;problem:string;result:string}[];total:number;legacy:boolean};
  expect(body.total).toBe(250);expect(body.lines).toHaveLength(IMPORT_PROBLEM_SCREEN_LIMIT);expect(body.legacy).toBe(false);
  expect(body.lines[0]).toMatchObject({row:2,reference:'DUP_0',problem:messages.labelsImportWizard.problem.duplicate,result:'skipped',stage:'check'});
  expect(JSON.stringify(body)).not.toContain('SERVER_ENGLISH');
  // One read of the job's own stored rows; nothing is checked again.
  expect(calls.read).toHaveBeenCalledOnce();expect(calls.read).toHaveBeenCalledWith({tenantId:'fictional-tenant'},JOB);
  const file=await get('?format=xlsx');expect(file.status).toBe(200);expect(file.headers.get('content-type')).toContain('spreadsheetml');
  const rows=XLSX.utils.sheet_to_json<string[]>(XLSX.read(await file.arrayBuffer(),{type:'array'}).Sheets.Errors,{header:1,raw:false,defval:''});
  const t=labelRootTranslator(locale,messages);
  expect(rows).toEqual(importProblemSheetRows({lines:labelImportProblemLines(blocked,t),t:labelProblemTranslator(t)}));
  expect(rows).toHaveLength(251);
 });
 it('lists the rows that stopped a failed import with the job as the support reference',async()=>{
  calls.read.mockResolvedValue(source({state:'failed',blocked:[],failed:[{sheet:'grades',row:4,code:'G_CONFLICT',detail:'releaseConflict',message:''},{sheet:'division',row:6,code:'DIV_X',detail:'saveRefused',message:'Fixture writer refusal.'}],error:'No labels were imported.'}));
  const body=await (await get()).json() as {lines:Record<string,unknown>[];total:number};
  expect(body.total).toBe(2);
  expect(body.lines).toEqual([
   {row:4,category:en.admin.systemLabels.category.grade,reference:'G_CONFLICT',problem:'Code "G_CONFLICT" was added by someone else while the import was running.',correction:en.labelsImportWizard.fix.releaseConflict,stage:'save',result:'stopped'},
   {row:6,category:en.admin.profileOptions.category.division,reference:'DIV_X',problem:'Fixture writer refusal.',correction:en.labelsImportWizard.fix.saveRefused,stage:'save',result:'stopped',errorReference:JOB},
  ]);
 });
 it('names a whole-import failure once, with the job as the support reference',async()=>{
  calls.read.mockResolvedValue(source({state:'failed',blocked:[],error:'No labels were imported. Labels changed.'}));
  const body=await (await get()).json() as {lines:Record<string,unknown>[]};
  expect(body.lines).toEqual([{row:null,problem:'No labels were imported. Labels changed.',correction:en.labelsImportWizard.fix.saveRefused,stage:'system',result:'not_saved',errorReference:JOB}]);
 });
 it('tells an import released before this change to use its stored report',async()=>{
  calls.read.mockResolvedValue(source({blocked:[],legacy:true}));
  expect(await (await get()).json()).toEqual({lines:[],total:0,legacy:true});
  expect((await get('?format=xlsx')).status).toBe(409);
 });
 it("refuses another administrator's job or an unknown job as unavailable",async()=>{
  calls.read.mockRejectedValue(new SystemLabelImportJobError('Import unavailable.',404));
  const response=await get();expect(response.status).toBe(404);expect(await response.json()).toEqual({error:'Import unavailable.'});
  calls.read.mockRejectedValue(new SystemLabelImportJobError('Preview the workbook again.',400));
  expect((await get()).status).toBe(404);
 });
});
