import {beforeEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({template:vi.fn(),build:vi.fn(),preview:vi.fn(),confirm:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>Object.assign((key:string)=>key,{has:()=>false})}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>({tenantId:'tenant',userId:'user',roles:['hr_admin']})}));
vi.mock('../lib/request-origin',()=>({isSameOriginBrowserRequest:()=>true}));
vi.mock('../core/movement-import',()=>({movementImportTemplateData:mocks.template}));
vi.mock('../core/movement-import-history',()=>({previewMovementUpload:mocks.preview,confirmMovementUpload:mocks.confirm}));
vi.mock('../lib/movement-workbook.server',()=>({MOVEMENT_WORKBOOK_LIMITS:{maxBytes:5000000},buildMovementWorkbook:mocks.build}));
import {POST} from '../app/admin/personnel/import/movement/route';
import {ImportHistoryError} from '../core/import-history';
function request(operation:string,entries:Record<string,string|File>={}){const data=new FormData();data.set('operation',operation);for(const [key,value]of Object.entries(entries))data.set(key,value);return new Request('http://localhost/admin/personnel/import/movement',{method:'POST',body:data});}
beforeEach(()=>{vi.resetAllMocks();mocks.template.mockResolvedValue({types:[{code:'transfer',label:'Transfer',behaviour:'transfer'}],companies:[]});mocks.build.mockResolvedValue(Buffer.from('fictional workbook'));mocks.preview.mockResolvedValue({attemptId:'attempt',previewHash:'hash',preview:{employees:[],fileErrors:[]}});mocks.confirm.mockResolvedValue({attemptId:'attempt',imported:1,failed:0,excluded:0,employees:[],byEventType:[],alreadyCommitted:false});});
describe('single-template Movement transport (ac6645ec)',()=>{
 it('downloads one template with no company or movement type in the request',async()=>{
  const response=await POST(request('download',{companyId:'ignored',typeCode:'ignored'}));
  expect(response.headers.get('content-type')).toContain('spreadsheetml');expect(mocks.template).toHaveBeenCalledTimes(1);expect(mocks.template.mock.calls[0]).toHaveLength(1);
  expect(mocks.build.mock.calls[0][0]).toMatchObject({tenantId:'tenant',types:[{code:'transfer'}],companies:[]});
 });
 it('records the actual uploaded bytes as an attempt and returns its reference and preview hash',async()=>{
  const file=new File(['exact fictional bytes'],'movements.xlsx');const value=await (await POST(request('preview',{file,operationKey:'op'}))).json();
  expect(value).toMatchObject({ok:true,attemptId:'attempt',previewHash:'hash'});
  const input=mocks.preview.mock.calls[0][1];expect(input.content).toEqual(Buffer.from('exact fictional bytes'));expect(input.name).toBe('movements.xlsx');expect(input.operationKey).toBe('op');
 });
 it('confirms only the attempt, its hash and chosen employee keys; client rows, fingerprints and hashes are never forwarded',async()=>{
  const response=await POST(request('apply',{attemptId:'attempt',previewHash:'hash',employees:'["company|E1"]',acknowledgeExcluded:'true',fingerprints:'{"E1":"forged"}',records:'[{"row":1}]',inputHash:'forged'}));
  expect(response.status).toBe(200);const input=mocks.confirm.mock.calls[0][1];
  expect(input).toMatchObject({attemptId:'attempt',previewHash:'hash',employees:['company|E1'],acknowledgeExcluded:true});expect(Object.keys(input).sort()).toEqual(['acknowledgeClosedPayroll','acknowledgeExcluded','attemptId','employees','previewHash','resolve']);expect(input.acknowledgeClosedPayroll).toBe(false); // 646355e5 — only an explicit 'true' acknowledges closed payroll
 });
 it.each(['not json','{"a":1}','[1]'])('refuses a malformed employee selection %s before any write',async employees=>{
  const response=await POST(request('apply',{attemptId:'attempt',previewHash:'hash',employees}));expect(response.status).toBe(400);expect((await response.json()).error).toBe('invalid_selection');expect(mocks.confirm).not.toHaveBeenCalled();
 });
 it('returns an import history refusal as its message and hides other failures behind a finite code',async()=>{
  mocks.confirm.mockRejectedValueOnce(new ImportHistoryError('This import was reverted. Upload the file again to import it.'));
  expect(await (await POST(request('apply',{attemptId:'a',previewHash:'h',employees:'[]'}))).json()).toMatchObject({ok:false,message:'This import was reverted. Upload the file again to import it.'});
  mocks.preview.mockRejectedValueOnce(Object.assign(new Error('select * from secret'),{query:'select'}));vi.spyOn(console,'error').mockImplementation(()=>{});
  expect(await (await POST(request('preview',{file:new File(['x'],'m.csv')}))).json()).toEqual({ok:false,error:'change_refused'});
 });
});
