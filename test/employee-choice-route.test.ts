import {beforeEach,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
const mocks=vi.hoisted(()=>({scope:vi.fn(),read:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedSession:mocks.scope}));
vi.mock('../core/employee-choice',()=>({readEmployeeChoices:mocks.read,EmployeeChoiceInputError:class extends Error{},EmployeeChoiceAccessError:class extends Error{}}));
import {POST} from '../app/api/employee-choices/route';
const request=(value:unknown,extra:Record<string,string>={})=>new Request('https://hr.example/api/employee-choices',{method:'POST',headers:{Origin:'https://hr.example','Content-Type':'application/json',...extra},body:JSON.stringify(value)});
beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockResolvedValue({s:{tenantId:'trusted'},scopeIds:['trusted-company']});mocks.read.mockResolvedValue({rows:[],total:0});});
it('uses a same-origin read body and trusted server scope, never posted grants or query strings',async()=>{
 const response=await POST(request({query:'PRIVATE_SEARCH',offset:25,limit:25,labelMode:'names'}));
 expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
 expect(mocks.read).toHaveBeenCalledWith({tenantId:'trusted'},{query:'PRIVATE_SEARCH',offset:25,limit:25,labelMode:'names',companyIds:['trusted-company']},expect.any(AbortSignal));
 for(const value of [{companyIds:[]},{grants:[]},{offset:'25'},{selectedId:42}]){
  mocks.read.mockClear();expect((await POST(request(value))).status).toBe(400);expect(mocks.read).not.toHaveBeenCalled();
 }
 expect((await POST(new Request('https://hr.example/api/employee-choices?q=PRIVATE_SEARCH',{method:'POST',headers:{Origin:'https://hr.example','Content-Type':'application/json'},body:'{}'}))).status).toBe(400);
});
it('refuses missing/foreign origin before reading scope and refuses missing authentication',async()=>{
 expect((await POST(request({}, {Origin:'https://foreign.example'}))).status).toBe(403);expect(mocks.scope).not.toHaveBeenCalled();
 mocks.scope.mockRejectedValue(new AuthRequiredError());expect((await POST(request({}))).status).toBe(401);expect(mocks.read).not.toHaveBeenCalled();
});
it('bounds request bytes and never discloses a native failure',async()=>{
 expect((await POST(request({query:'x'.repeat(17000)}))).status).toBe(400);expect(mocks.read).not.toHaveBeenCalled();
 mocks.read.mockRejectedValue(Error('PRIVATE_SQL_AND_IDENTITIES'));
 const response=await POST(request({query:'name'}));expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE_');
});
