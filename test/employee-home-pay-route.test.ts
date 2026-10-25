import {beforeEach,describe,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
const state=vi.hoisted(()=>({session:vi.fn(),read:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:state.session}));
vi.mock('@/core/employee-home',()=>({readEmployeeHomePayHints:state.read,
 HomeAccessError:class extends Error{constructor(readonly code:string){super('Private Home context');}}}));
vi.mock('@/packs/payroll/service',()=>({OwnPayrollSubjectUnavailableError:class extends Error{}}));
import {OwnPayrollSubjectUnavailableError} from '@/packs/payroll/service';
import {GET} from '../app/api/home/pay/route';
const ctx={tenantId:'fictional-tenant',userId:'fictional-login',personId:'fictional-person',roles:['employee']};
const value={version:1,employmentId:'own',payslips:[{id:'published',period:'2026-09',runType:'regular',runSequence:1}],
 nextPayment:{date:'2026-10-28',period:'2026-10',runType:'regular'}};
beforeEach(()=>{vi.resetAllMocks();state.session.mockResolvedValue(ctx);state.read.mockResolvedValue(value);});
describe('Home pay hint transport',()=>{
 it('returns only the metadata allowlist even if an upstream owner gains other fields',async()=>{
  state.read.mockResolvedValueOnce({...value,gross:'private amount',bank:'private account',payslips:[{...value.payslips[0],net:'private net'}],nextPayment:{...value.nextPayment,amount:'private pay'}});
  const response=await GET(new Request('http://localhost/api/home/pay?employmentId=own'));
  expect(response.status).toBe(200);expect(state.read).toHaveBeenCalledWith(ctx,'own');expect(await response.json()).toEqual(value);
  expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('vary')).toBe('Cookie, Authorization');
 });
 it('refuses supplied authority or duplicated subjects before invoking payroll',async()=>{
  for(const query of ['companyId=foreign','tenantId=foreign','employmentId=own&employmentId=other','personId=foreign']){
   const response=await GET(new Request('http://localhost/api/home/pay?'+query));expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'invalid'});
  }
  expect(state.read).not.toHaveBeenCalled();
 });
 it('keeps unavailable subjects, authentication and unexpected failures distinct without error details',async()=>{
  state.read.mockRejectedValueOnce(new OwnPayrollSubjectUnavailableError());
  let response=await GET(new Request('http://localhost/api/home/pay?employmentId=foreign'));expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'employmentUnavailable'});
  state.session.mockRejectedValueOnce(new AuthRequiredError('Private login details'));
  response=await GET(new Request('http://localhost/api/home/pay'));expect(response.status).toBe(401);expect(await response.json()).toEqual({error:'authentication'});
  state.read.mockRejectedValueOnce(new Error('Private database details'));
  response=await GET(new Request('http://localhost/api/home/pay'));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'unavailable'});
 });
});
