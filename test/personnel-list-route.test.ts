/** ADR 0181 Phase 4, list-only filters: POST /personnel/list answers the directory's list view under the page's own
 * authority and fails closed. The view itself is app/personnel/directory-view.ts, which the page renders too. */
import {beforeEach,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
const mocks=vi.hoisted(()=>({scope:vi.fn(),view:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('../lib/scope',()=>({scopedSession:mocks.scope}));
vi.mock('../app/personnel/directory-view',()=>({directoryView:mocks.view}));
import {POST} from '../app/personnel/list/route';
const request=(value:unknown,extra:Record<string,string>={},url='https://hr.example/personnel/list')=>new Request(url,{method:'POST',
 headers:{Origin:'https://hr.example','Content-Type':'application/json',...extra},body:typeof value==='string'?value:JSON.stringify(value)});
beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockResolvedValue({s:{tenantId:'trusted'},scopeIds:['trusted-company']});mocks.view.mockResolvedValue({href:'/personnel',rows:[]});});

it('answers the page\'s own view for the trusted session scope and the directory\'s own parameters only',async()=>{
 const params={q:'PRIVATE_SEARCH',company:'c',dept:'d',status:'active',type:'full_time',page:'2',size:'50',after:'0b6f1d1e-3c55-4c6a-9a43-0d2f0c6f1a01',count:'exact'};
 const response=await POST(request(params));
 expect(response.status).toBe(200);
 expect(response.headers.get('cache-control')).toBe('private, no-store');
 expect(mocks.view).toHaveBeenCalledWith({tenantId:'trusted'},['trusted-company'],params);
});

it('refuses anything but a small JSON object of the directory\'s string parameters',async()=>{
 for(const value of [{companyIds:['x']},{scopeIds:[]},{grants:[]},{page:2},{q:null},{q:'x'.repeat(201)},[],'null','not json',{q:'x'.repeat(5000)}]){
  mocks.view.mockClear();
  expect((await POST(request(value))).status,JSON.stringify(value).slice(0,40)).toBe(400);
  expect(mocks.view).not.toHaveBeenCalled();
 }
 // The search term never rides in the URL of this read.
 expect((await POST(request({},{},'https://hr.example/personnel/list?q=PRIVATE_SEARCH'))).status).toBe(400);
 expect((await POST(request({},{'Content-Type':'text/plain'}))).status).toBe(400);
});

it('fails closed: foreign origin before any read, no session 401, a database failure 503 without detail',async()=>{
 expect((await POST(request({},{Origin:'https://foreign.example'}))).status).toBe(403);
 expect(mocks.scope).not.toHaveBeenCalled();
 mocks.scope.mockRejectedValueOnce(new AuthRequiredError());
 expect((await POST(request({}))).status).toBe(401);
 expect(mocks.view).not.toHaveBeenCalled();
 mocks.view.mockRejectedValueOnce(Error('PRIVATE_SQL_AND_IDENTITIES'));
 const response=await POST(request({q:'name'}));
 expect(response.status).toBe(503);
 expect(await response.text()).not.toContain('PRIVATE_');
});
