import {beforeEach,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
import {InquiryQueryError} from '../lib/leave-inquiry-query';
const mocks=vi.hoisted(()=>({scope:vi.fn(),read:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedSession:mocks.scope}));
vi.mock('next-intl/server',()=>({getLocale:async()=> 'ta'}));
vi.mock('../packs/leave/service',()=>({readLeaveInquiryPicker:mocks.read}));
import {POST} from '../app/api/leave/inquiry/employees/route';
const request=(value:unknown,origin='https://hr.example')=>new Request('https://hr.example/api/leave/inquiry/employees',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockResolvedValue({s:{tenantId:'trusted'},scopeIds:['trusted-company']});mocks.read.mockResolvedValue({rows:[],total:0});});
it('uses only trusted company context, a private bounded body and the current locale',async()=>{
 const response=await POST(request({query:'PRIVATE SEARCH',offset:25,limit:25}));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
 expect(mocks.read).toHaveBeenCalledWith({tenantId:'trusted'},['trusted-company'],{query:'PRIVATE SEARCH',offset:25,limit:25},'ta',expect.any(AbortSignal));
 for(const value of [{companyIds:[]},{grants:[]},{roles:[]},{offset:'25'},{selectedId:42},{limit:201},{offset:-1},{labelMode:'labels'}]){
  mocks.read.mockClear();expect((await POST(request(value))).status).toBe(400);expect(mocks.read).not.toHaveBeenCalled();
 }
 expect((await POST(new Request('https://hr.example/api/leave/inquiry/employees?q=PRIVATE',{method:'POST',headers:{Origin:'https://hr.example','Content-Type':'application/json'},body:'{}'}))).status).toBe(400);
});
it('denies foreign origin, missing authentication and stale native authority without disclosing failures',async()=>{
 expect((await POST(request({},'https://foreign.example'))).status).toBe(403);expect(mocks.scope).not.toHaveBeenCalled();
 mocks.scope.mockRejectedValueOnce(new AuthRequiredError());expect((await POST(request({}))).status).toBe(401);
 mocks.read.mockRejectedValueOnce(new InquiryQueryError('Forbidden'));expect((await POST(request({}))).status).toBe(403);
 mocks.read.mockRejectedValueOnce(Error('PRIVATE_SQL_AND_IDENTITIES'));const failure=await POST(request({}));expect(failure.status).toBe(503);expect(await failure.text()).not.toContain('PRIVATE_');
});
it('bounds bytes before reading application scope or data',async()=>{
 expect((await POST(request({query:'x'.repeat(17000)}))).status).toBe(400);expect(mocks.scope).not.toHaveBeenCalled();expect(mocks.read).not.toHaveBeenCalled();
});
