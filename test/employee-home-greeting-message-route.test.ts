import {beforeEach,describe,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
const state=vi.hoisted(()=>({session:vi.fn(),read:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:state.session}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'ms'}));
vi.mock('@/core/employee-home-greeting',()=>({readEmployeeHomeGreeting:state.read}));
vi.mock('@/core/employee-home',()=>({HomeAccessError:class extends Error{constructor(readonly code:string){super('Private Home context');}}}));
import {HomeAccessError} from '@/core/employee-home';
import {GET} from '../app/api/home/greeting-message/route';
const ctx={tenantId:'fictional-tenant',userId:'fictional-login',personId:'fictional-person',roles:['employee']};
const value={version:1,employmentId:'own',serverNow:new Date().toISOString(),displayDate:'2026-10-01',timeZone:'Asia/Kuala_Lumpur',message:'Fictional greeting',templateKey:'greetingMorning',photoHref:null};
beforeEach(()=>{vi.resetAllMocks();state.session.mockResolvedValue(ctx);state.read.mockResolvedValue(value);});
describe('Home greeting message transport',()=>{
 it('uses server locale and returns only rendered presentation, never underlying birthday or leave context',async()=>{
  state.read.mockResolvedValueOnce({...value,dateOfBirth:'private birth date',leaveReason:'private leave reason'});
  const response=await GET(new Request('http://localhost/api/home/greeting-message?employmentId=own'));
  expect(response.status).toBe(200);expect(await response.json()).toEqual(value);expect(state.read).toHaveBeenCalledWith(ctx,'own','ms');
  expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('vary')).toBe('Cookie, Authorization');
 });
 it('rejects caller-supplied event facts, clock, roles and ambiguous selection',async()=>{
  for(const query of ['', 'employmentId=own&birthday=true','employmentId=own&hour=8','employmentId=own&now=2020-01-01','employmentId=own&role=hr_admin','employmentId=own&employmentId=foreign']){
   expect((await GET(new Request('http://localhost/api/home/greeting-message?'+query))).status).toBe(400);
  }
  expect(state.read).not.toHaveBeenCalled();
 });
 it('keeps a refused subject and an unavailable reader separate without disclosing internal errors',async()=>{
  state.read.mockRejectedValueOnce(new HomeAccessError('employmentUnavailable'));
  let response=await GET(new Request('http://localhost/api/home/greeting-message?employmentId=foreign'));expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'employmentUnavailable'});
  state.session.mockRejectedValueOnce(new AuthRequiredError('private login'));
  response=await GET(new Request('http://localhost/api/home/greeting-message?employmentId=own'));expect(response.status).toBe(401);
  state.read.mockRejectedValueOnce(new Error('private database'));
  response=await GET(new Request('http://localhost/api/home/greeting-message?employmentId=own'));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'unavailable'});
 });
});
