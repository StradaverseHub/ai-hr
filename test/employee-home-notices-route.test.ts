import {beforeEach,describe,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
const state=vi.hoisted(()=>({session:vi.fn(),read:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:state.session}));
vi.mock('@/core/employee-home-notices',()=>({readEmployeeHomeNotices:state.read}));
vi.mock('@/core/employee-home',()=>({HomeAccessError:class extends Error{constructor(readonly code:string){super('Private Home context');}}}));
import {HomeAccessError} from '@/core/employee-home';
import {GET} from '../app/api/home/notices/route';
const ctx={tenantId:'fictional-tenant',userId:'fictional-login',personId:'fictional-person',roles:['employee']};
const value={version:1,employmentId:'own',total:23,unread:22,acknowledgementRequired:1,items:[{
 id:'21d29ae1-dc1c-4479-a7bf-cb882f12ef66',title:'Fictional notice',summary:'Recorded summary',category:'Policy',pinned:true,
 requiresAcknowledgement:true,publishedAt:new Date().toISOString(),publishedBy:'Fictional HR',firstViewedAt:null,acknowledgedAt:null}]};
beforeEach(()=>{vi.resetAllMocks();state.session.mockResolvedValue(ctx);state.read.mockResolvedValue(value);});
describe('Home Notice metadata transport',()=>{
 it('returns only the bounded metadata contract even if its owner later acquires private detail fields',async()=>{
  state.read.mockResolvedValueOnce({...value,body:'private body',items:[{...value.items[0],body:'private text',attachmentIds:['private file'],contentVersion:88}]});
  const response=await GET(new Request('http://localhost/api/home/notices?employmentId=own'));
  expect(response.status).toBe(200);expect(await response.json()).toEqual(value);expect(state.read).toHaveBeenCalledWith(ctx,'own');
  expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('vary')).toBe('Cookie, Authorization');
 });
 it('refuses authority, paging and ambiguous subjects before the owner runs',async()=>{
  for(const query of ['', 'companyId=foreign','employmentId=own&employmentId=foreign','employmentId=own&pageSize=100','employmentId=own&personId=foreign']){
   const response=await GET(new Request('http://localhost/api/home/notices?'+query));expect(response.status).toBe(400);
  }
  expect(state.read).not.toHaveBeenCalled();
 });
 it('refuses stale/foreign subjects and login failure without returning private errors or fake empty counts',async()=>{
  state.read.mockRejectedValueOnce(new HomeAccessError('employmentUnavailable'));
  let response=await GET(new Request('http://localhost/api/home/notices?employmentId=foreign'));expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'employmentUnavailable'});
  state.session.mockRejectedValueOnce(new AuthRequiredError('private login'));
  response=await GET(new Request('http://localhost/api/home/notices?employmentId=own'));expect(response.status).toBe(401);
  state.read.mockRejectedValueOnce(new Error('private database'));
  response=await GET(new Request('http://localhost/api/home/notices?employmentId=own'));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'unavailable'});
 });
});
