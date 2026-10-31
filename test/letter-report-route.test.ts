import {beforeEach,it,expect,vi} from 'vitest';
import {LetterWorkflowError} from '../lib/letter-workflow';
import {AuthRequiredError} from '../lib/auth-errors';
const mocks=vi.hoisted(()=>({session:vi.fn(),read:vi.fn(),workbook:vi.fn(),pdf:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedSession:mocks.session}));
vi.mock('../core/letters',()=>({readLetterReport:mocks.read}));
vi.mock('../app/(app)/letters/reports/labels',()=>({reportLabels:async()=>({title:'Fixture report'})}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en'}));
vi.mock('../lib/letter-report',async original=>({...await original<typeof import('../lib/letter-report')>(),letterReportWorkbook:mocks.workbook,letterReportPdf:mocks.pdf}));
import {GET} from '../app/(app)/letters/reports/export/route';
const companyId='00000000-0000-4000-8000-000000000001',hash='d'.repeat(64),ctx={tenantId:'fixture',userId:'current-user'},request=(format='xlsx')=>new Request(`https://fixture.test/letters/reports/export?from=2026-10-01&to=2026-10-26&companyId=${companyId}&hash=${hash}&format=${format}`);
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue({s:ctx,scopeIds:[companyId]});mocks.read.mockResolvedValue({dataHash:hash});mocks.workbook.mockReturnValue(new Uint8Array([1,2,3]));mocks.pdf.mockResolvedValue({bytes:Buffer.from('%PDF-fixture')});});
it('rechecks the complete authorised cohort and exact displayed fingerprint before exporting',async()=>{
 const response=await GET(request());expect(response.status).toBe(200);expect(mocks.read).toHaveBeenCalledExactlyOnceWith(ctx,{from:'2026-10-01',to:'2026-10-26',companyId,companyIds:[companyId],exportAll:true,expectedDataHash:hash});expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1,2,3]);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('referrer-policy')).toBe('no-referrer');expect(response.headers.get('content-disposition')).toContain('letters-2026-10-01-2026-10-26.xlsx');
});
it('uses the same bound DTO for the PDF exporter',async()=>{const response=await GET(request('pdf'));expect(response.headers.get('content-type')).toBe('application/pdf');expect(await response.text()).toBe('%PDF-fixture');expect(mocks.pdf).toHaveBeenCalledExactlyOnceWith({dataHash:hash},{title:'Fixture report'},'en');});
it('refuses stale or unauthorised exports without exposing source details or exporting a different dataset',async()=>{
 for(const [error,status,code]of [[new LetterWorkflowError('stale','reportChanged'),409,'stale'],[new LetterWorkflowError('permission'),403,'permission'],[new Error('private SQL detail'),503,'unavailable']] as const){mocks.read.mockRejectedValue(error);const response=await GET(request());expect(response.status).toBe(status);expect(await response.json()).toEqual({error:code});}
 expect(mocks.workbook).not.toHaveBeenCalled();mocks.session.mockRejectedValue(new AuthRequiredError());expect((await GET(request())).status).toBe(401);
});
it('validates export format and dataset evidence before reading any report',async()=>{
 expect((await GET(request('html'))).status).toBe(400);expect((await GET(new Request('https://fixture.test/letters/reports/export?format=xlsx'))).status).toBe(400);expect(mocks.read).not.toHaveBeenCalled();
});

it('derives export scope from the current session rather than a supplied company list',async()=>{
 await GET(new Request(request().url+'&companyIds=00000000-0000-4000-8000-000000000002'));
 expect(mocks.read).toHaveBeenCalledWith(ctx,expect.objectContaining({companyIds:[companyId]}));
});
