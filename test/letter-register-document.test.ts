import {beforeEach,it,expect,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
import {LetterWorkflowError} from '../lib/letter-workflow';
const mocks=vi.hoisted(()=>({session:vi.fn(),download:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('../core/letters',()=>({downloadStaffLetter:mocks.download}));
import {GET} from '../app/(app)/letters/register/[letterId]/document/route';
const letterId='00000000-0000-4000-8000-000000000001',ctx={tenantId:'fixture',userId:'current-user'},params=()=>({params:Promise.resolve({letterId})}),request=(inline=false)=>new Request('https://fixture.test/letters/register/'+letterId+'/document'+(inline?'?inline=1':''));
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue(ctx);});
it('serves the authorized sealed bytes with private headers for review and download',async()=>{
 mocks.download.mockResolvedValue({content:Buffer.from('%PDF-sealed-fixture'),contentHash:'a'.repeat(64),fileName:'HR_2026_000001.pdf'});
 for(const inline of [false,true]){const response=await GET(request(inline),params());expect(await response.text()).toBe('%PDF-sealed-fixture');expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('content-type')).toBe('application/pdf');expect(response.headers.get('referrer-policy')).toBe('no-referrer');expect(response.headers.get('content-disposition')).toBe((inline?'inline':'attachment')+'; filename="HR_2026_000001.pdf"');}
 expect(mocks.download).toHaveBeenCalledWith(ctx,letterId);
});
it('conceals unavailable or foreign artifacts and never includes private exception details',async()=>{
 for(const error of [new LetterWorkflowError('permission'),new LetterWorkflowError('state'),new LetterWorkflowError('configuration','artifactHash')]){mocks.download.mockRejectedValue(error);const response=await GET(request(),params());expect(response.status).toBe(404);expect(await response.text()).toBe('');}
 mocks.download.mockRejectedValue(new Error('PRIVATE DATABASE DETAILS'));const response=await GET(request(),params());expect(response.status).toBe(503);expect(await response.text()).toBe('');expect(response.headers.get('cache-control')).toContain('no-store');
});
it('returns an expired-session status before calling the artifact owner',async()=>{
 mocks.session.mockRejectedValue(new AuthRequiredError());const response=await GET(request(),params());expect(response.status).toBe(401);expect(mocks.download).not.toHaveBeenCalled();
});
