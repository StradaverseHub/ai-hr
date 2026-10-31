import {beforeEach,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({session:{tenantId:'fictional'},allowed:{canOpen:true,companyIds:['allowed']},search:vi.fn(),scope:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:async()=>f.session}));
vi.mock('../lib/scope',()=>({getScopeIds:f.scope}));
vi.mock('../core/workforce-access',()=>({workforceViewScope:async()=>f.allowed}));
vi.mock('../core/read',()=>({searchWorkforceEmployeesTx:f.search}));
vi.mock('../db/client',()=>({withTenant:async(_ctx:unknown,run:(tx:unknown)=>unknown)=>run('tx')}));
import {GET} from '../app/api/personnel/search/route';
beforeEach(()=>{vi.clearAllMocks();f.allowed={canOpen:true,companyIds:['allowed']};f.scope.mockResolvedValue(['scoped']);f.search.mockResolvedValue([{employmentId:'one',name:'Name',employeeCode:'EMP1',company:'Company',department:null,companyId:'private',terminatedOn:null}]);});
it('uses fresh authorized scope, ignores posted companies and returns only switcher fields without caching',async()=>{
 const response=await GET(new Request('https://example.test/api/personnel/search?q=EMP&companyIds=foreign'));
 expect(f.scope).toHaveBeenCalledWith(['allowed']);expect(f.search).toHaveBeenCalledWith(f.session,'tx',['scoped'],'EMP');
 expect(response.headers.get('Cache-Control')).toBe('private, no-store');expect(await response.json()).toEqual({rows:[{employmentId:'one',name:'Name',employeeCode:'EMP1',company:'Company',department:null}]});
});
it('refuses denied actors and oversized input before reading employees',async()=>{
 f.allowed.canOpen=false;expect((await GET(new Request('https://example.test/?q=EMP'))).status).toBe(403);expect(f.search).not.toHaveBeenCalled();
 f.allowed.canOpen=true;expect((await GET(new Request('https://example.test/?q='+ 'x'.repeat(201)))).status).toBe(400);expect(f.search).not.toHaveBeenCalled();
});
