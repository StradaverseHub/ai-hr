import {beforeEach,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
import {WorkforceChoiceAccessError} from '../lib/workforce-choice';
const mocks=vi.hoisted(()=>({session:vi.fn(),read:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('../core/workforce-choice',()=>({readWorkforceChoices:mocks.read}));
import {POST} from '../app/api/workforce-choices/route';
const subjectId='00000000-0000-4000-8000-000000000001';
const request=(value:unknown,extra:Record<string,string>={})=>new Request('https://hr.example/api/workforce-choices',{method:'POST',headers:{Origin:'https://hr.example','Content-Type':'application/json',...extra},body:JSON.stringify(value)});
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue({tenantId:'trusted'});mocks.read.mockResolvedValue({rows:[],total:0});});
it('accepts bounded same-origin body input and authenticates without substituting generic employee scope',async()=>{
 const response=await POST(request({subjectId,query:'PRIVATE_SEARCH',offset:25}));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(mocks.read).toHaveBeenCalledWith({tenantId:'trusted'},{subjectId,query:'PRIVATE_SEARCH',offset:25});
 for(const input of [{subjectId,companyIds:[]},{subjectId,grants:[]},{subjectId,offset:'25'},{subjectId,selectedIds:['bad']},{subjectId,limit:500},{subjectId,query:'x'.repeat(17000)}]){mocks.read.mockClear();expect((await POST(request(input))).status).toBe(400);expect(mocks.read).not.toHaveBeenCalled();}
});
it('refuses foreign origins, expired sessions and access revocation without exposing native details',async()=>{
 expect((await POST(request({subjectId},{Origin:'https://foreign.example'}))).status).toBe(403);expect(mocks.session).not.toHaveBeenCalled();mocks.session.mockRejectedValueOnce(new AuthRequiredError());expect((await POST(request({subjectId}))).status).toBe(401);
 mocks.read.mockRejectedValueOnce(new WorkforceChoiceAccessError());expect((await POST(request({subjectId}))).status).toBe(403);mocks.read.mockRejectedValueOnce(Error('PRIVATE_DATABASE_DETAILS'));const failed=await POST(request({subjectId}));expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('PRIVATE_');
});
