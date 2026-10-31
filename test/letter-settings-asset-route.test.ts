import {beforeEach,it,expect,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
import {LetterWorkflowError} from '../lib/letter-workflow';
const mocks=vi.hoisted(()=>({session:vi.fn(),asset:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('../core/letters',()=>({readLetterAsset:mocks.asset}));
import {GET} from '../app/(app)/letters/settings/assets/[assetId]/route';
const assetId='00000000-0000-4000-8000-000000000001',ctx={tenantId:'fixture',userId:'actual-owner'},params=()=>({params:Promise.resolve({assetId})}),request=new Request('https://fixture.test/letters/settings/assets/'+assetId);
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue(ctx);});
it('serves only the owner-authorized exact pixels with private image headers',async()=>{
 const bytes=Buffer.from('89504e470d0a1a0a','hex');mocks.asset.mockResolvedValue({content:bytes,mimeType:'image/png'});const response=await GET(request,params());expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));expect(response.headers.get('content-type')).toBe('image/png');expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('referrer-policy')).toBe('no-referrer');expect(mocks.asset).toHaveBeenCalledExactlyOnceWith(ctx,assetId);
});
it('conceals foreign signatures and internal exceptions without returning pixels',async()=>{
 for(const [error,status] of [[new LetterWorkflowError('permission'),404],[new Error('PRIVATE STORAGE DETAIL'),503]] as const){mocks.asset.mockRejectedValue(error);const response=await GET(request,params());expect(response.status).toBe(status);expect(await response.text()).toBe('');expect(response.headers.get('cache-control')).toContain('no-store');}
});
it('requires a current session before entering the image owner',async()=>{
 mocks.session.mockRejectedValue(new AuthRequiredError());const response=await GET(request,params());expect(response.status).toBe(401);expect(mocks.asset).not.toHaveBeenCalled();
});
