import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {movementErrorReceipt,verifyMovementErrorReceipt} from '../lib/movement-workbook-metadata.server';
const mocks=vi.hoisted(()=>({catalog:vi.fn(),download:vi.fn(),preview:vi.fn(),commit:vi.fn(),build:vi.fn(),read:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>Object.assign((key:string)=>key,{has:()=>false})}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>({tenantId:'tenant',userId:'user',roles:['hr_admin']})}));
vi.mock('../lib/request-origin',()=>({isSameOriginBrowserRequest:()=>true}));
vi.mock('../core/movement-import',()=>({movementImportCatalog:mocks.catalog,movementImportDownloadData:mocks.download,previewMovementImport:mocks.preview,commitMovementImport:mocks.commit}));
vi.mock('../lib/movement-workbook.server',()=>({MOVEMENT_WORKBOOK_LIMITS:{maxBytes:5000000},movementWorkbookCatalogue:()=> 'catalogue',buildMovementWorkbook:mocks.build,readMovementWorkbook:mocks.read}));
import {POST} from '../app/admin/personnel/import/movement/route';
const catalog={types:[{code:'increment',label:'Increment',behaviour:'increment'}],companies:[{value:'company',label:'Fictional Company'}],fields:{}};
const mixedCsv='employeeCode,incrementAmount,effectiveDate,departmentId\nGOOD,25.13,2026-11-01,\nBAD,25.13,2026-11-01,Missing Department\nMANUAL,25.13,2026-11-01,';
const mixedRow=(row:number,employeeCode:string,status:string,errors:string[]=[])=>({row,employeeCode,eventType:'increment',effectiveDate:'2026-11-01',status,errors,source:{sheet:'CSV',row}});
const mixedPreview={inputHash:'full-original-file',selection:[2,3,4],fileErrors:[],valid:2,excluded:1,employees:[{employeeCode:'GOOD',employmentId:'good',name:'Good',fingerprint:'good-fingerprint',rows:[mixedRow(2,'GOOD','valid')]},{employeeCode:'BAD',employmentId:'bad',name:'Bad',fingerprint:null,rows:[mixedRow(3,'BAD','invalid',['unknown_reference:departmentId'])]},{employeeCode:'MANUAL',employmentId:'manual',name:'Manual',fingerprint:'manual-fingerprint',rows:[mixedRow(4,'MANUAL','valid')]}]};
const mixedResult=()=>({imported:1,failed:0,excluded:2,batchId:'batch',byEventType:[],employees:mixedPreview.employees.map(e=>({...e,rows:e.rows.map(r=>({...r,status:e.employeeCode==='GOOD'?'imported':'excluded',errors:[]}))}))});
const enableSigning=()=>{vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY',Buffer.alloc(32,9).toString('base64url'));vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY_ID','public-report-fixture');};
function request(operation:string,entries:Record<string,string|File>={}){const data=new FormData();data.set('operation',operation);data.set('companyId','company');data.set('typeCode','increment');data.set('csv','Employee ID,incrementAmount,effectiveDate\nFIXTURE,25.13,2026-11-01');for(const [key,value]of Object.entries(entries))data.set(key,value);return new Request('http://localhost/admin/personnel/import/movement',{method:'POST',body:data});}
// Read the actual serialized request, rather than assuming multipart preserves the source literal's newlines.
async function requestReceiptContext(req:Request){const data=await req.clone().formData(),csv=data.get('csv'),typeCode=data.get('typeCode');expect(typeof csv).toBe('string');expect(typeof typeCode).toBe('string');return {tenantId:'tenant',userId:'user',companyId:String(data.get('companyId')),sourceHash:createHash('sha256').update(String(typeCode)+'\0'+String(csv)).digest('hex')};}
beforeEach(()=>{vi.resetAllMocks();mocks.catalog.mockResolvedValue(catalog);mocks.commit.mockResolvedValue({imported:1,failed:0,excluded:0,batchId:'batch',employees:[{employeeCode:'FIXTURE',employmentId:'employment',rows:[{row:2,status:'imported',errors:[]}]}],byEventType:[]});mocks.preview.mockResolvedValue({employees:[],fileErrors:[]});mocks.build.mockResolvedValue(Buffer.from('fictional generated workbook'));vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY','');vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY_ID','');});afterEach(()=>vi.unstubAllEnvs());
describe('actual-file Movement upload transport',()=>{
 it('returns the committed CSV result even when the optional workbook signing key is absent',async()=>{
  const response=await POST(request('apply',{selection:'[2]',fingerprints:'{"FIXTURE":"fingerprint"}',inputHash:'file-bound'})),result=await response.json();expect(response.status).toBe(200);expect(result).toMatchObject({ok:true,result:{imported:1},workbookReportUnavailable:true});expect(mocks.commit).toHaveBeenCalledTimes(1);expect(result.errorReceipt).toBeUndefined();
 });
 it('derives rows and file hash from fresh CSV parsing instead of accepting client prepared records or source hash',async()=>{
  await POST(request('preview',{records:'[{"row":999}]',sourceHash:'forged'}));const input=mocks.preview.mock.calls[0][1];expect(input.records[0]).toMatchObject({row:2,employeeCode:'FIXTURE',incrementAmount:'25.13'});expect(input.sourceHash).not.toBe('forged');
 });
 it('passes the actual XLSX bytes to bounded file admission and preserves original bound sheet names in annotated output',async()=>{
  const binding={sheet:'Increment (2)',code:'increment',behaviour:'increment',columns:['employeeCode'],captions:['Employee ID'],identities:[]};mocks.read.mockResolvedValue({records:[{row:1,employeeCode:'FIXTURE',cells:{kind:'increment'},errors:[],source:{sheet:'Increment (2)',row:6}}],fileErrors:[],metadata:{sheets:[binding]}});
  const file=new File(['exact fictional XLSX bytes'],'exercise.xlsx'),response=await POST(request('errors',{file}));expect(response.status).toBe(200);expect(mocks.read.mock.calls[0][0]).toEqual(Buffer.from('exact fictional XLSX bytes'));expect(mocks.build.mock.calls[0][0].sourceBindings).toEqual([binding]);
 });
 it('preserves a server-observed semantic exclusion through apply and the signed result download, without inventing an error for a manually excluded valid row',async()=>{
  enableSigning();mocks.preview.mockResolvedValue(mixedPreview);mocks.commit.mockResolvedValue(mixedResult());
  const previewRequest=request('preview',{csv:mixedCsv}),receiptContext=await requestReceiptContext(previewRequest),checked=await (await POST(previewRequest)).json();expect(checked.previewErrorReceipt).toEqual(expect.any(String));expect(mocks.preview.mock.calls[0][1].sourceHash).toBe(receiptContext.sourceHash);
  const applyRequest=request('apply',{csv:mixedCsv,selection:'[2]',fingerprints:'{"GOOD":"good-fingerprint"}',inputHash:mixedPreview.inputHash,acknowledgeExcluded:'true',previewErrorReceipt:checked.previewErrorReceipt,errors:'["forged explanation"]'});expect(await requestReceiptContext(applyRequest)).toEqual(receiptContext);const applied=await (await POST(applyRequest)).json();
  expect(applied.result.employees[1].rows[0]).toMatchObject({row:3,employeeCode:'BAD',status:'excluded',errors:['unknown_reference:departmentId'],source:{sheet:'CSV',row:3}});expect(applied.result.employees[2].rows[0].errors).toEqual([]);expect(applied.result.imported).toBe(1);
  expect(verifyMovementErrorReceipt(applied.errorReceipt,receiptContext)).toEqual([{row:3,errors:['unknown_reference:departmentId']},{row:4,errors:[]}]);
  const reportRequest=request('errors',{csv:mixedCsv,errorReceipt:applied.errorReceipt});expect(await requestReceiptContext(reportRequest)).toEqual(receiptContext);await POST(reportRequest);const report=mocks.build.mock.calls.at(-1)![0];expect(report.records.map((r:{row:number})=>r.row)).toEqual([3,4]);expect(report.employees.flatMap((e:{rows:unknown[]})=>e.rows)).toEqual(expect.arrayContaining([expect.objectContaining({row:3,errors:['unknown_reference:departmentId']})]));expect(mocks.commit).toHaveBeenCalledTimes(1);
 });
 it.each(['malformed','tenant','user','company','file','unknown-row','duplicate-row'])('refuses %s supplied preview evidence before invoking the write owner',async mismatch=>{
  enableSigning();const fields={csv:mixedCsv,selection:'[2]',fingerprints:'{}',inputHash:'original',acknowledgeExcluded:'true'},actualContext=await requestReceiptContext(request('apply',fields)),context={...actualContext};if(mismatch==='tenant')context.tenantId='foreign';if(mismatch==='user')context.userId='foreign';if(mismatch==='company')context.companyId='foreign';if(mismatch==='file')context.sourceHash='different-file';
  const rows=mismatch==='unknown-row'?[{row:999,errors:['unknown_reference:departmentId']}]:mismatch==='duplicate-row'?[{row:3,errors:['unknown_reference:departmentId']},{row:3,errors:[]}]:[{row:3,errors:['unknown_reference:departmentId']}];
  const token=mismatch==='malformed'?'invalid-display-token':movementErrorReceipt({...context,rows});
  if(mismatch==='unknown-row'||mismatch==='duplicate-row')expect(verifyMovementErrorReceipt(token,actualContext)).toEqual(rows);
  const submitted=request('apply',{...fields,previewErrorReceipt:token});expect(await requestReceiptContext(submitted)).toEqual(actualContext);const response=await POST(submitted);expect(response.status).toBe(400);expect(mocks.commit).not.toHaveBeenCalled();
 });
 it('keeps keyless CSV preview and committed result available while refusing a supplied invalid receipt before writes',async()=>{
  mocks.preview.mockResolvedValue(mixedPreview);mocks.commit.mockResolvedValue(mixedResult());const checked=await (await POST(request('preview',{csv:mixedCsv}))).json();expect(checked.previewErrorReceipt).toBeUndefined();
  const applied=await POST(request('apply',{csv:mixedCsv,selection:'[2]',fingerprints:'{}',inputHash:'original',acknowledgeExcluded:'true'}));expect(applied.status).toBe(200);expect((await applied.json()).result.imported).toBe(1);expect(mocks.commit).toHaveBeenCalledTimes(1);
  mocks.commit.mockClear();const refused=await POST(request('apply',{csv:mixedCsv,selection:'[2]',fingerprints:'{}',inputHash:'original',acknowledgeExcluded:'true',previewErrorReceipt:'invalid-even-without-key'}));expect(refused.status).toBe(400);expect(mocks.commit).not.toHaveBeenCalled();
 });
});
