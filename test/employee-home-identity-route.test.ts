import {beforeEach,describe,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
const state=vi.hoisted(()=>({session:vi.fn(),read:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:state.session}));
vi.mock('@/core/employee-home',()=>({
 readEmployeeHomeIdentity:state.read,
 HomeAccessError:class extends Error{constructor(readonly code:string){super('Fictional private context');}},
}));
import {HomeAccessError} from '@/core/employee-home';
import {GET} from '../app/api/home/identity/route';

const ctx={tenantId:'fictional-tenant',userId:'fictional-login',roles:['employee']};
const identity={version:1,name:'Fictional viewer',photoHref:null,role:'employee',employmentState:'selected',
 selectedEmploymentId:'own-employment',companyEstablished:true,
 employments:[{employmentId:'own-employment',employeeCode:'EMP-FICTIONAL',company:'Fictional company'}]};
beforeEach(()=>{vi.clearAllMocks();state.session.mockResolvedValue(ctx);state.read.mockResolvedValue(identity);});
describe('Home own-identity transport',()=>{
 it('takes only an employment selector and emits only the minimal identity contract under private no-store headers',async()=>{
  state.read.mockResolvedValueOnce({...identity,salary:'Fictional private amount',birthYear:1900,
   employments:[{...identity.employments[0],medicalReason:'Fictional private reason'}]});
  const result=await GET(new Request('http://localhost/api/home/identity?employmentId=own-employment'));
  expect(state.read).toHaveBeenCalledWith(ctx,'own-employment');
  expect(await result.json()).toEqual(identity);
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(result.headers.get('vary')).toBe('Cookie, Authorization');
 });
 it('rejects alternate identity/scope selectors and duplicates before the own-subject reader runs',async()=>{
  for(const query of ['?personId=other','?tenantId=other','?companyId=other','?employmentId=one&employmentId=two']){
   const result=await GET(new Request('http://localhost/api/home/identity'+query));
   expect(result.status,query).toBe(400);expect(await result.json()).toEqual({error:'invalid'});
  }
  expect(state.read).not.toHaveBeenCalled();
 });
 it('keeps authentication, unavailable selection and infrastructure failure distinct without error-body disclosure',async()=>{
  state.session.mockRejectedValueOnce(new AuthRequiredError('Fictional private identity'));
  let result=await GET(new Request('http://localhost/api/home/identity'));
  expect(result.status).toBe(401);expect(await result.json()).toEqual({error:'authentication'});
  state.read.mockRejectedValueOnce(new HomeAccessError('employmentUnavailable'));
  result=await GET(new Request('http://localhost/api/home/identity?employmentId=foreign'));
  expect(result.status).toBe(403);expect(await result.json()).toEqual({error:'employmentUnavailable'});
  state.read.mockRejectedValueOnce(new Error('Fictional private SQL detail'));
  result=await GET(new Request('http://localhost/api/home/identity'));
  expect(result.status).toBe(503);expect(await result.json()).toEqual({error:'unavailable'});
 });
});
