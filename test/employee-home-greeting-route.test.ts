import {beforeEach,describe,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
const state=vi.hoisted(()=>({session:vi.fn(),read:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:state.session}));
vi.mock('@/core/employee-home',()=>({
 readEmployeeHomeGreetingIdentity:state.read,
 HomeAccessError:class extends Error{constructor(readonly code:string){super('Fictional private context');}},
}));
import {HomeAccessError} from '@/core/employee-home';
import {GET} from '../app/api/home/greeting/route';

const ctx={tenantId:'fictional-tenant',userId:'fictional-login',roles:['employee']};
const greeting={version:1,employmentId:'own',name:'Recorded preferred name',photoHref:'/personnel/photo/fictional-person'};
beforeEach(()=>{vi.clearAllMocks();state.session.mockResolvedValue(ctx);state.read.mockResolvedValue(greeting);});
describe('Home greeting identity transport',()=>{
 it('passes only the own selector and emits a minimal private response',async()=>{
  state.read.mockResolvedValueOnce({...greeting,salary:'Fictional private amount',birthYear:1900,personId:'private-id'});
  const response=await GET(new Request('http://localhost/api/home/greeting?employmentId=own'));
  expect(state.read).toHaveBeenCalledWith(ctx,'own');expect(await response.json()).toEqual(greeting);
  expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('vary')).toBe('Cookie, Authorization');
 });
 it('refuses caller-supplied identity/scope and duplicate selectors before loading presentation',async()=>{
  for(const query of ['?personId=other','?tenantId=other','?companyId=other','?employmentId=one&employmentId=two']){
   const response=await GET(new Request('http://localhost/api/home/greeting'+query));
   expect(response.status,query).toBe(400);expect(await response.json()).toEqual({error:'invalid'});
  }
  expect(state.read).not.toHaveBeenCalled();
 });
 it('keeps missing authentication, unavailable own selection and failed reads distinct',async()=>{
  state.session.mockRejectedValueOnce(new AuthRequiredError('Fictional private identity'));
  let response=await GET(new Request('http://localhost/api/home/greeting'));
  expect(response.status).toBe(401);expect(await response.json()).toEqual({error:'authentication'});
  state.read.mockRejectedValueOnce(new HomeAccessError('employmentUnavailable'));
  response=await GET(new Request('http://localhost/api/home/greeting?employmentId=foreign'));
  expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'employmentUnavailable'});
  state.read.mockRejectedValueOnce(new HomeAccessError('chooseEmployment'));
  response=await GET(new Request('http://localhost/api/home/greeting'));
  expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'chooseEmployment'});
  state.read.mockRejectedValueOnce(new Error('Fictional private database/photo failure'));
  response=await GET(new Request('http://localhost/api/home/greeting'));
  expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'unavailable'});
 });
});
