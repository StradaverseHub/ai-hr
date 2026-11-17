import {beforeEach,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
const mocks=vi.hoisted(()=>({session:vi.fn(),scope:vi.fn(),context:vi.fn(),shared:vi.fn(),attendance:vi.fn(),draft:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('../lib/scope',()=>({scopedSession:mocks.scope,companyContextForPage:mocks.context}));
vi.mock('../core/shared-employee-picker',()=>({sharedEmployeePickerPage:mocks.shared}));
vi.mock('../core/attendance-application-history',()=>({attendanceApplicationEmployeeChoices:mocks.attendance}));
vi.mock('../core/draft-manager-choice',()=>({draftManagerChoices:mocks.draft}));
vi.mock('../core/employee-choice',()=>({EmployeeChoiceInputError:class extends Error{},EmployeeChoiceAccessError:class extends Error{}}));
import {POST as shared} from '../app/api/shared-employee-choices/[purpose]/route';
import {POST as attendance} from '../app/api/attendance/application-history/employees/route';
import {POST as draft} from '../app/api/draft-manager-choices/route';
const subjectId='00000000-0000-4000-8000-000000000001';
const request=(value:unknown,origin='https://hr.example')=>new Request('https://hr.example/api/test-choices',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
const purpose=(value:string)=>({params:Promise.resolve({purpose:value})});
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue({tenantId:'trusted',roles:['hr_admin']});mocks.scope.mockResolvedValue({s:{tenantId:'trusted',roles:['hr_admin']},scopeIds:['trusted-company']});mocks.context.mockResolvedValue({scopeIds:['trusted-company']});for(const reader of [mocks.shared,mocks.attendance,mocks.draft])reader.mockResolvedValue({rows:[],total:0});});
it('derives scoped/active authority from the server and keeps Loans independent of the company cookie',async()=>{
 expect((await shared(request({query:'PRIVATE',offset:25,labelMode:'labels'}),purpose('scoped'))).status).toBe(200);
 expect(mocks.shared).toHaveBeenLastCalledWith({tenantId:'trusted',roles:['hr_admin']},['trusted-company'],'scoped',{query:'PRIVATE',offset:25,labelMode:'labels'},expect.any(AbortSignal));
 expect((await shared(request({status:'ended'}),purpose('active'))).status).toBe(200);expect(mocks.shared.mock.calls.at(-1)?.[2]).toBe('active');
 mocks.context.mockClear();const response=await shared(request({}),purpose('loans'));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(mocks.context).not.toHaveBeenCalled();expect(mocks.shared.mock.calls.at(-1)?.slice(1,3)).toEqual([[],'loans']);
});
it('rejects caller-supplied populations, dates and grants before any native choice reader',async()=>{
 for(const input of [{companyIds:[]},{activeOnly:false},{assignmentAsOf:'2026-01-01'},{employmentIds:[]},{grants:[]},{query:'x'.repeat(17000)}]){mocks.shared.mockClear();expect((await shared(request(input),purpose('scoped'))).status).toBe(400);expect(mocks.shared).not.toHaveBeenCalled();}
 expect((await shared(request({}),purpose('unknown'))).status).toBe(400);
 for(const read of [(r:Request)=>shared(r,purpose('scoped')),attendance,draft])expect((await read(request({},'https://foreign.example'))).status).toBe(403);
 mocks.session.mockRejectedValueOnce(new AuthRequiredError());expect((await shared(request({}),purpose('loans'))).status).toBe(401);
});
it('uses separate Attendance and draft subject owners and never discloses a native failure',async()=>{
 expect((await attendance(request({query:'employee',selectedId:subjectId,limit:25}))).status).toBe(200);expect(mocks.attendance).toHaveBeenCalledWith({tenantId:'trusted',roles:['hr_admin']},['trusted-company'],{query:'employee',selectedId:subjectId,limit:25},expect.any(AbortSignal));
 expect((await attendance(request({limit:200}))).status).toBe(400);
 expect((await draft(request({subjectId,query:'manager',selectedIds:[]}))).status).toBe(200);expect(mocks.draft).toHaveBeenCalledWith({tenantId:'trusted',roles:['hr_admin']},['trusted-company'],{subjectId,query:'manager',selectedIds:[]},expect.any(AbortSignal));
 mocks.shared.mockRejectedValue(Error('PRIVATE_SQL_OR_PERSON'));const failure=await shared(request({}),purpose('scoped'));expect(failure.status).toBe(503);expect(await failure.text()).not.toContain('PRIVATE_');
});
