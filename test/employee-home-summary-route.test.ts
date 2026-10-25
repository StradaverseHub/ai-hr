import {beforeEach,describe,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
const state=vi.hoisted(()=>({session:vi.fn(),read:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:state.session}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'ms',getTranslations:async()=>()=> 'Cuti gantian'}));
vi.mock('@/core/employee-home-summary',()=>({readEmployeeHomeSummary:state.read}));
vi.mock('@/core/employee-home',()=>({HomeAccessError:class extends Error{constructor(readonly code:string){super('Private own context');}}}));
import {HomeAccessError} from '@/core/employee-home';
import {GET} from '../app/api/home/summary/route';
const ctx={userId:'login',personId:'person'},value={version:1,employmentId:'own',serverNow:new Date().toISOString(),items:[],calm:null,quickActions:[]};
beforeEach(()=>{vi.resetAllMocks();state.session.mockResolvedValue(ctx);state.read.mockResolvedValue(value);});
describe('Own Home summary transport',()=>{
 it('uses server locale, private no-store and exact own context',async()=>{
  const response=await GET(new Request('http://local/api/home/summary?employmentId=own'));expect(response.status).toBe(200);expect(await response.json()).toEqual(value);
  expect(state.read).toHaveBeenCalledWith(ctx,'own','ms','Cuti gantian');expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('vary')).toBe('Cookie, Authorization');
 });
 it.each(['','employmentId=','employmentId=own&employmentId=foreign','employmentId=own&role=admin','employmentId=own&now=2000-01-01'])('refuses ambiguous/caller-authored facts: %s',async query=>{
  expect((await GET(new Request('http://local/api/home/summary?'+query))).status).toBe(400);expect(state.read).not.toHaveBeenCalled();
 });
 it('refuses rather than serializing accidental richer owner fields',async()=>{
  state.read.mockResolvedValue({...value,items:[{key:'payslip',message:'Ready',destination:'payslip',amount:'private'}]});const response=await GET(new Request('http://local/api/home/summary?employmentId=own'));
  expect(response.status).toBe(503);expect(await response.text()).not.toContain('private');
 });
 it('separates denied, signed-out and failed states without returning error detail',async()=>{
  state.read.mockRejectedValueOnce(new HomeAccessError('employmentUnavailable'));expect((await GET(new Request('http://local/api/home/summary?employmentId=foreign'))).status).toBe(403);
  state.session.mockRejectedValueOnce(new AuthRequiredError('private'));expect((await GET(new Request('http://local/api/home/summary?employmentId=own'))).status).toBe(401);
  state.read.mockRejectedValueOnce(Error('private'));const response=await GET(new Request('http://local/api/home/summary?employmentId=own'));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'unavailable'});
 });
});
