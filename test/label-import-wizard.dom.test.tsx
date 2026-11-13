import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viLocale from '../messages/vi.json';
import {SystemLabelImport} from '../components/system-label-import';
import {labelImportFailureLines,labelImportProblemLines} from '../lib/system-label-import-problems';
import {labelRootTranslator} from './label-import-translators';
const mocks=vi.hoisted(()=>({fetch:vi.fn(),post:vi.fn(),job:vi.fn(),errors:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
// 44810ec04 runs the import as a background job: on mount the wizard rejoins an active job (GET .../import/jobs), the
// confirmation enqueues one, and the wizard follows it (GET .../import/jobs/{id}) to the same summary or refusal.
// Preview and confirmation still POST to the import route; `post` and `job` answer those two in order.
// Board c074c6b8: a finished job's rows come from GET .../import/jobs/{id}/errors (`errors`), built from the job's
// stored rows by the same adapter the screen uses.
const JOBS='/admin/settings/system-labels/import/jobs',IMPORT='/admin/settings/system-labels/import';
beforeEach(()=>{vi.clearAllMocks();mocks.errors.mockResolvedValue(response({lines:[],total:0,legacy:false}));mocks.fetch.mockImplementation((url:string,init?:RequestInit)=>url===JOBS?Promise.resolve(response({jobs:[]})):url.startsWith(JOBS+'/')&&url.includes('/errors')?mocks.errors(url,init):url.startsWith(JOBS+'/')?mocks.job(url,init):mocks.post(url,init));vi.stubGlobal('fetch',mocks.fetch);});
const queued={id:'00000000-0000-4000-8000-000000000001',state:'queued',sourceName:'fictional.xls',stepsTotal:0,stepsDone:0,error:null,errors:[],result:null,worker:'running',createdAt:'2026-11-11T00:00:00.000Z',updatedAt:'2026-11-11T00:00:00.000Z'};
const rows=[{sheet:'division',row:2,values:{Code:'NEW',Label:'New label'},after:{Code:'NEW',Label:'New label'},before:null,outcome:'add',selected:true,message:'Valid new code.'},{sheet:'department',row:3,values:{Code:'EXISTING'},after:{Code:'EXISTING'},before:null,outcome:'error',selected:false,reason:'existing',reasonDetail:'existing',reasonColumn:'Code',message:'SERVER_ENGLISH_MUST_NOT_RENDER'}] as const;
const response=(data:unknown)=>({ok:true,status:200,headers:new Headers({'Content-Type':'application/json'}),json:async()=>data});
// Result rows can render before React finishes the transition. Act only on the settled control.
async function clickReady(user:ReturnType<typeof userEvent.setup>,name:string,scope:Pick<typeof screen,'getByRole'>=screen){
 await waitFor(()=>expect(scope.getByRole('button',{name})).toBeEnabled(),{timeout:5000});
 await user.click(scope.getByRole('button',{name}));
}
const locales=[['en',en],['ms',ms],['zh',zh],['ta',ta],['th',th],['vi',viLocale]] as const;
function mount(locale:string='en',messages:Record<string,unknown>=en){return render(<NextIntlClientProvider locale={locale} messages={messages} onError={error=>{throw error;}}><SystemLabelImport/></NextIntlClientProvider>);}
async function upload(user:ReturnType<typeof userEvent.setup>,name='fictional.xls'){
 await user.click(screen.getByRole('button',{name:en.admin.systemLabels.excel.import}));
 await user.upload(screen.getByLabelText(en.labelsImportWizard.upload),new File(['fictional workbook'],name));
}
describe('three-step new-code import wizard',()=>{
 it.each(locales)('renders Upload, mixed Check and Done with real translations in %s',async(locale,messages)=>{
  const user=userEvent.setup();mount(locale,messages);const w=messages.labelsImportWizard;
  const template=screen.getByRole('link',{name:messages.labelExcelRoundTrip.template});
  expect(template).toHaveAttribute('href','/admin/settings/system-labels/template');
  expect(template.nextElementSibling).toBe(screen.getByRole('button',{name:messages.admin.systemLabels.excel.import}));
  expect(screen.queryByRole('button',{name:messages.labelExcelRoundTrip.current})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:messages.admin.systemLabels.excel.import}));
  const dialog=screen.getByRole('dialog',{name:w.title});expect(within(dialog).getByText(w.warning)).toBeVisible();expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
  expect(within(dialog).getByRole('link',{name:messages.labelExcelRoundTrip.template})).toHaveAttribute('href','/admin/settings/system-labels/template');
  await user.upload(within(dialog).getByLabelText(w.upload),new File(['fictional'],'fictional.xls'));
  mocks.post.mockResolvedValueOnce(response({ok:true,preview:{token:'source-bound-token',mode:'add',valid:true,rows}}));
  await clickReady(user,w.check,within(dialog));
  expect(await within(dialog).findByText(w.problem.existing,{},{timeout:5000})).toBeVisible();expect(within(dialog).getByText(w.ready.replace('{count}','1'))).toBeVisible();
  expect(within(dialog).getByText(w.fix.existing)).toBeVisible();expect(within(dialog).getByRole('heading',{name:w.problemsTitle})).toBeVisible();
  expect(within(dialog).queryByText('Current values')).not.toBeInTheDocument();
  mocks.post.mockResolvedValueOnce(response({ok:true,job:queued,existing:false}));
  mocks.job.mockResolvedValueOnce(response({job:{...queued,state:'completed',stepsTotal:1,stepsDone:1,result:{imported:1,updated:0,skipped:1,failed:0}}}));
  // What the job errors route returns: the stored refused row through the same adapter, in this locale.
  const stored=labelImportProblemLines([...rows],labelRootTranslator(locale,messages));
  mocks.errors.mockResolvedValueOnce(response({lines:stored,total:stored.length,legacy:false}));
  await clickReady(user,w.importCount.replace('{count}','1'),within(dialog));
  expect(await within(dialog).findByText(w.summary.replace('{created}','1').replace('{skipped}','1'),{},{timeout:5000})).toBeVisible();expect(mocks.refresh).toHaveBeenCalledOnce();
  // Step 3 lists the row that was not imported, not only its count.
  const done=await within(dialog).findByRole('table',{},{timeout:5000});
  expect(within(done).getByText(w.problem.existing)).toBeVisible();expect(within(done).getAllByText('EXISTING').length).toBeGreaterThan(0);
  expect(within(done).getByRole('cell',{name:'3'})).toBeVisible();expect(mocks.errors).toHaveBeenCalledWith(`${JOBS}/${queued.id}/errors`,expect.anything());
  expect(mocks.job).toHaveBeenCalledWith(`${JOBS}/${queued.id}`,expect.anything());expect(mocks.post.mock.calls.map(call=>call[0])).toEqual([IMPORT,IMPORT]);
  const body=mocks.post.mock.calls[1][1].body as FormData;expect(body.get('operation')).toBe('apply');expect(body.get('token')).toBe('source-bound-token');expect(body.has('mode')).toBe(false);expect(body.has('confirmUpdates')).toBe(false);
 });
 // Board c074c6b8: the screen no longer collapses a reason into one general sentence. Each refusal shows its own
 // problem, column and entered value, translated from labelsImportWizard.problem/fix. The server's English `message`
 // is still never printed (it stays in the import history only): what English readers see is the catalogue sentence,
 // which is deliberately word for word what the downloaded report says, and what other locales see is its translation.
 it.each(locales)('shows each refusal with its own translated problem, column and value in %s, never the server message',async(locale,messages)=>{
  const user=userEvent.setup();mount(locale,messages);const w=messages.labelsImportWizard;
  await user.click(screen.getByRole('button',{name:messages.admin.systemLabels.excel.import}));await user.upload(screen.getByLabelText(w.upload),new File(['fictional'],'invalid.xlsx'));
  const refusals=[
   ['unsupportedCategory',undefined],['companyNotPermitted','Company'],['companyUnknown','Company'],['companyOutOfScope','Criteria Companies'],
   ['invalidCriteria','Criteria'],['globalWithCompanies','Company'],['globalAdminRequired','Criteria'],['noOwnerCompany','Company'],
   ['companyNotInCriteria','Company'],['criteriaCompaniesRequired','Criteria Companies'],['invalidHeadEmployee','Head Employee Code'],
   ['invalidStatus','Status'],['wholeNumber','Rank'],['invalidGradeCode','Code'],['gradeLabelExists','Label'],
   ['invalidGradeReferences','Grade Codes'],['gradeAlreadyGrouped','Grade Codes'],['gradeScope','Grade Codes'],['invalidRow',undefined],['existing','Code'],
  ] as const;
  const invalid=[
   {...rows[1],row:99,outcome:'skip',reason:'notSelected',reasonDetail:'notSelected',reasonColumn:'Code',values:{Code:'UNSELECTED_99'}},
   {...rows[1],row:98,outcome:'skip',reason:'duplicate',reasonDetail:'duplicate',reasonColumn:'Code',values:{Code:'DUP_98'}},
   ...refusals.map(([detail,column],index)=>({...rows[1],row:index+2,reason:'invalidRow',reasonDetail:detail,reasonColumn:column,values:{Code:`CODE_${index+2}`,...(column&&column!=='Code'?{[column]:`VALUE_${index+2}`}:{})}})),
   ...(['Code','Company','Description','Label','Name'] as const).map((reasonField,index)=>({...rows[1],row:index+30,reason:'required',reasonField,reasonDetail:'required',reasonColumn:reasonField,values:{Code:reasonField==='Code'?'':`REQ_${index+30}`}})),
   // A row stored before details existed still maps by its reason.
   {...rows[1],row:40,reason:'invalidHeadEmployee',reasonDetail:undefined,reasonColumn:undefined,values:{Code:'OLD_40'}},
  ];
  mocks.post.mockResolvedValueOnce(response({ok:true,preview:{token:'invalid-locales',valid:false,rows:invalid}}));await user.click(screen.getByRole('button',{name:w.check}));
  const table=await screen.findByRole('table',{name:w.problemsTitle},{timeout:5000});
  const rowOf=(excelRow:number)=>within(table).getAllByRole('row').find(tr=>tr.getAttribute('data-problem-row')===String(excelRow))!;
  for(const [index,[detail,column]] of refusals.entries()){
   const tr=rowOf(index+2);expect(tr,detail).toBeDefined();
   expect(within(tr).getByText(w.problem[detail])).toBeVisible();expect(within(tr).getByText(w.fix[detail])).toBeVisible();
   if(column&&column!=='Code')expect(within(tr).getByText(`VALUE_${index+2}`)).toBeVisible();
  }
  expect(within(rowOf(refusals.findIndex(([detail])=>detail==='invalidHeadEmployee')+2)).getByText('Head (leave approver)')).toBeVisible();
  expect(within(rowOf(99)).getByText(w.problem.notSelected)).toBeVisible();expect(within(rowOf(99)).getByText(messages.importProblems.result.skipped)).toBeVisible();
  expect(within(rowOf(98)).getByText(w.problem.duplicate)).toBeVisible();
  expect(within(rowOf(40)).getByText(w.problem.invalidHeadEmployee)).toBeVisible();
  for(const [index,field] of (['Code','Company','Description','Label','Name'] as const).entries())expect(within(rowOf(index+30)).getByText(w.problem.required.replace('{field}',w.fields[field]))).toBeVisible();
  expect(within(rowOf(2)).getByText(messages.importProblems.result.refused)).toBeVisible();
  expect(screen.queryByText('SERVER_ENGLISH_MUST_NOT_RENDER')).not.toBeInTheDocument();expect(await screen.findByRole('button',{name:w.importCount.replace('{count}','0')})).toBeDisabled();
 });
 it('keeps all-blocked rows read-only and disables import; Escape closes and restores the trigger',async()=>{
  const user=userEvent.setup();mount();await upload(user);
  mocks.post.mockResolvedValueOnce(response({ok:true,preview:{token:'blocked',valid:false,rows:[rows[1]]}}));
  await user.click(screen.getByRole('button',{name:en.labelsImportWizard.check}));
  expect(await screen.findByText(en.labelsImportWizard.allBlocked,{},{timeout:5000})).toBeVisible();expect(screen.getByRole('button',{name:'Import 0 new codes'})).toBeDisabled();
  expect(screen.getByRole('button',{name:en.labelsImportWizard.errorReport})).toBeEnabled();
  await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:en.admin.systemLabels.excel.import})).toHaveFocus();expect(mocks.post).toHaveBeenCalledOnce();expect(mocks.job).not.toHaveBeenCalled();
 });
 it('preserves the file after a failed confirmation and requires a fresh preview before retry',async()=>{
  const user=userEvent.setup();mount();await upload(user,'preserved.xlsx');
  mocks.post.mockResolvedValueOnce(response({ok:true,preview:{token:'t',valid:true,rows}}));await user.click(screen.getByRole('button',{name:en.labelsImportWizard.check}));await screen.findByText(en.labelsImportWizard.problem.existing,{},{timeout:5000});
  // The writer now runs in the job; its failure reaches the wizard as the stopped job's reason.
  mocks.post.mockResolvedValueOnce(response({ok:true,job:{...queued,sourceName:'preserved.xlsx'},existing:false}));
  mocks.job.mockResolvedValueOnce(response({job:{...queued,sourceName:'preserved.xlsx',state:'failed',error:'Fixture writer failure; no additions saved.'}}));
  // Board c074c6b8: the stopped import lists the row involved and its reason, as the job errors route serves them.
  const stopped=labelImportFailureLines({failed:[{sheet:'division',row:2,code:'NEW',detail:'releaseConflict',message:''}],jobId:queued.id},labelRootTranslator('en',en));
  mocks.errors.mockResolvedValueOnce(response({lines:stopped,total:1,legacy:false}));
  await clickReady(user,'Import 1 new codes');
  expect(await screen.findByText('Fixture writer failure; no additions saved.',{},{timeout:5000})).toBeVisible();
  const table=await screen.findByRole('table',{name:en.labelsImportWizard.stoppedTitle},{timeout:5000});
  expect(within(table).getByText('Code "NEW" was added by someone else while the import was running.')).toBeVisible();
  expect(within(table).getByText(en.importProblems.result.stopped)).toBeVisible();expect(within(table).getByRole('cell',{name:'2'})).toBeVisible();expect(await screen.findByRole('button',{name:en.labelsImportWizard.checkAgain},{timeout:5000})).toBeEnabled();expect(screen.queryByText('1 new codes created · 1 rows skipped')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:en.labelsImportWizard.back}));expect(screen.getByText(/preserved.xlsx/)).toBeVisible();
 });
 it('refuses unsupported and oversized files immediately without contacting the server',async()=>{
  const user=userEvent.setup();mount();await user.click(screen.getByRole('button',{name:en.admin.systemLabels.excel.import}));
  for(const file of [new File(['x'],'bad.csv'),new File([new Uint8Array(5_000_001)],'large.xlsx')]){
   fireEvent.change(screen.getByLabelText(en.labelsImportWizard.upload),{target:{files:[file]}});
   expect(screen.getByText(en.labelsImportWizard.fileError)).toBeVisible();expect(screen.getByRole('button',{name:en.labelsImportWizard.check})).toBeDisabled();
  }
  // Only the mount-time rejoin check ran; no preview or import request reached the server.
  expect(mocks.post).not.toHaveBeenCalled();expect(mocks.job).not.toHaveBeenCalled();expect(mocks.fetch.mock.calls.map(call=>call[0])).toEqual([JOBS]);
 });
});
