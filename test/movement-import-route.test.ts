import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({catalog:vi.fn(),download:vi.fn(),preview:vi.fn(),commit:vi.fn(),build:vi.fn(),read:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>Object.assign((key:string)=>key,{has:()=>false})}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>({tenantId:'tenant',userId:'user',roles:['hr_admin']})}));
vi.mock('../lib/request-origin',()=>({isSameOriginBrowserRequest:()=>true}));
vi.mock('../core/movement-import',()=>({movementImportCatalog:mocks.catalog,movementImportDownloadData:mocks.download,previewMovementImport:mocks.preview,commitMovementImport:mocks.commit}));
vi.mock('../lib/movement-workbook.server',()=>({MOVEMENT_WORKBOOK_LIMITS:{maxBytes:5000000},movementWorkbookCatalogue:()=> 'catalogue',buildMovementWorkbook:mocks.build,readMovementWorkbook:mocks.read}));
import {POST} from '../app/admin/personnel/import/movement/route';
const catalog={types:[{code:'increment',label:'Increment',behaviour:'increment'}],companies:[{value:'company',label:'Fictional Company'}],fields:{}};
function request(operation:string,entries:Record<string,string|File>={}){const data=new FormData();data.set('operation',operation);data.set('companyId','company');data.set('typeCode','increment');data.set('csv','Employee ID,incrementAmount,effectiveDate\nFIXTURE,25.13,2026-11-01');for(const [key,value]of Object.entries(entries))data.set(key,value);return new Request('http://localhost/admin/personnel/import/movement',{method:'POST',body:data});}
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
});
