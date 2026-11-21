import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({admin:vi.fn(),read:vi.fn()}));
vi.mock('../lib/authz',()=>({requireAdmin:mocks.admin}));
vi.mock('../core/system-labels',()=>({labelMaintenanceHeadChoices:mocks.read,LabelHeadChoiceAccessError:class extends Error{}}));
vi.mock('next/navigation',()=>({unstable_rethrow:(error:unknown)=>{if(error instanceof Error&&error.message.startsWith('NEXT_REDIRECT'))throw error;}}));
import {POST} from '../app/admin/settings/system-labels/head-choices/route';
import {LabelHeadChoiceAccessError} from '../core/system-labels';
import {AuthRequiredError} from '../lib/auth-errors';
import {AiGatewayError} from '../lib/ai/types';
const companyId='abcdef01-2345-6789-abcd-ef0123456789',selectedId='abcdef02-2345-6789-abcd-ef0123456789';
const session={tenantId:'native-tenant',userId:'native-admin',roles:['hr_admin']};
const packet=()=>({companyId:companyId.toUpperCase(),query:'  Private employee query  ',offset:25,selectedId:selectedId.toUpperCase()});
function request(body:unknown=packet(),headers:Record<string,string>={}){return new Request('https://hr.example/admin/settings/system-labels/head-choices',{method:'POST',headers:{origin:'https://hr.example','content-type':'application/json',...headers},body:JSON.stringify(body)});}
beforeEach(()=>{vi.clearAllMocks();mocks.admin.mockResolvedValue(session);mocks.read.mockResolvedValue({companyId,query:'Private employee query',offset:25,limit:25,total:5010,rows:[],selected:null});});
it('uses a bounded private POST and fresh native owner, without URL lookup state or writes',async()=>{
 const req=request(),response=await POST(req);expect(response.status).toBe(200);
 expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('referrer-policy')).toBe('no-referrer');expect(response.headers.get('vary')).toBe('Cookie, Authorization');
 expect(response.headers.get('content-type')).toContain('application/json');
 expect(mocks.admin).toHaveBeenCalledOnce();expect(mocks.read).toHaveBeenCalledWith(session,{companyId,query:'Private employee query',offset:25,selectedId},req.signal);
 expect(req.url).not.toContain('Private');expect(req.url).not.toContain(selectedId);expect(await response.json()).toMatchObject({total:5010,offset:25,limit:25});
});
it('closes field names, value types, UUIDs, offsets and actual body bytes',async()=>{
 const invalid:unknown[]=[null,[],{}, {...packet(),companyId:'not-uuid'}, {...packet(),query:'x'.repeat(1001)}, {...packet(),query:'x\0y'}, {...packet(),query:1}, {...packet(),selectedId:[]},
  {...packet(),selectedId:'not-uuid'}, {...packet(),offset:-1}, {...packet(),offset:0.5}, {...packet(),offset:Number.MAX_SAFE_INTEGER}, {...packet(),limit:5000}, {...packet(),roles:['hr_admin']}, {...packet(),companyIds:[companyId]}];
 for(const body of invalid)expect((await POST(request(body))).status).toBe(400);
 expect((await POST(request(packet(),{'content-type':'multipart/form-data'}))).status).toBe(400);
 expect((await POST(request(packet(),{'content-length':'8193'}))).status).toBe(400);
 const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify({companyId,query:'x'.repeat(9000)})));controller.close();}});
 expect((await POST(new Request('https://hr.example/admin/settings/system-labels/head-choices',{method:'POST',headers:{origin:'https://hr.example','content-type':'application/json'},body:stream,duplex:'half'} as RequestInit&{duplex:'half'}))).status).toBe(400);
 expect(mocks.read).not.toHaveBeenCalled();
});
it('refuses cross-origin, bearer and URL transports before lookup',async()=>{
 const headers:Record<string,string>[]=[{origin:'https://foreign.example'},{origin:''},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'},{authorization:'Bearer anything'}];
 for(const extra of headers)expect((await POST(request(packet(),extra))).status).toBe(403);
 expect(mocks.admin).not.toHaveBeenCalled();
 expect((await POST(new Request('https://hr.example/admin/settings/system-labels/head-choices?query=PRIVATE',{method:'POST',headers:{origin:'https://hr.example','content-type':'application/json'},body:JSON.stringify(packet())}))).status).toBe(400);
 expect(mocks.read).not.toHaveBeenCalled();
});
it('rejects duplicate and escaped duplicate keys while allowing quoted key-like query text',async()=>{
 for(const body of ['{"companyId":"'+companyId+'","query":"first","query":"second"}',
  '{"companyId":"'+companyId+'","query":"first","qu\\u0065ry":"second"}']){
  expect((await POST(new Request('https://hr.example/admin/settings/system-labels/head-choices',{method:'POST',headers:{origin:'https://hr.example','content-type':'application/json'},body}))).status).toBe(400);
 }
 expect(mocks.read).not.toHaveBeenCalled();
 expect((await POST(request({companyId,query:'Quoted "query": "value" remains a search'}))).status).toBe(200);
});
it('keeps explicit safe refusal/unavailable states and preserves framework login redirects',async()=>{
 for(const error of [new LabelHeadChoiceAccessError(),new AiGatewayError('PRIVATE authority detail')]){
  mocks.read.mockRejectedValue(error);const response=await POST(request());expect(response.status).toBe(403);expect(await response.text()).not.toContain('PRIVATE');
 }
 mocks.read.mockRejectedValue(Error('PRIVATE SQL and parameters'));let response=await POST(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE');
 mocks.admin.mockRejectedValue(new AuthRequiredError());response=await POST(request());expect(response.status).toBe(401);
 const redirect=Error('NEXT_REDIRECT;login');mocks.admin.mockRejectedValue(redirect);await expect(POST(request())).rejects.toBe(redirect);
});
