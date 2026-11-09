import {beforeEach,expect,it,vi} from 'vitest';
import {PHASE_PRODUCTION_SERVER} from 'next/constants';
import {getPathMatch} from 'next/dist/shared/lib/router/utils/path-match';
import config from '../next.config';
const scope=vi.hoisted(()=>({ctx:{tenantId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222'},company:'33333333-3333-4333-8333-333333333333'}));
const create=vi.hoisted(()=>vi.fn());
vi.mock('../lib/workforce-authz',()=>({requireWorkforceAccess:async()=>({s:scope.ctx,scopeIds:[scope.company]})}));
vi.mock('../core/personnel-private-search',()=>({createPersonnelPrivateSearch:create,privateSearchHash:()=>null,personnelPrivateSearchAvailable:async()=>false,PersonnelSearchLimitError:class extends Error{}}));
import {POST} from '../app/admin/personnel/search/route';
import {PersonnelSearchLimitError} from '../core/personnel-private-search';
beforeEach(()=>{create.mockReset();create.mockResolvedValue('a'.repeat(43));});
const request=(body:string,origin='https://fixture.invalid')=>new Request('https://fixture.invalid/admin/personnel/search',{method:'POST',headers:{origin,host:'fixture.invalid','content-type':'application/x-www-form-urlencoded'},body});
it('applies no-referrer at the Next router only for the private search endpoint',async()=>{
 const rules=await config(PHASE_PRODUCTION_SERVER).headers!();
 const effective=(pathname:string)=>new Headers(Object.fromEntries(rules
  .filter(rule=>getPathMatch(rule.source,{strict:true})(pathname)!==false)
  .flatMap(rule=>rule.headers.map(({key,value})=>[key,value]))));
 const search=effective('/admin/personnel/search');
 expect(search.get('referrer-policy')).toBe('no-referrer');
 for(const pathname of ['/admin/personnel','/admin/personnel/export','/admin/personnel/searching','/admin/personnel/search/detail']){
  const neighbor=effective(pathname);
  expect(neighbor.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  for(const name of ['content-security-policy','x-frame-options','x-content-type-options','strict-transport-security','permissions-policy']){
   expect(search.get(name)).not.toBeNull();
   expect(search.get(name)).toBe(neighbor.get(name));
  }
 }
});
it('posts all text privately, returns only opaque membership and validated ordinary filters',async()=>{
 const raw='FICTIONAL-PASSPORT-4321',body=new URLSearchParams({term:raw,companies:scope.company,grade:'12',joinedFrom:'2026-01-01'});
 const response=await POST(request(body.toString()));expect(response.status).toBe(303);expect(create).toHaveBeenCalledWith(scope.ctx,{text:raw,companyIds:[scope.company],columnFilters:[],replaceCriteria:true});
 const location=response.headers.get('location')!;expect(location).not.toContain(raw);expect(location).toContain('search='+('a'.repeat(43)));expect(location).toContain('grade=12');expect(response.headers.get('cache-control')).toBe('private, no-store');expect(await response.text()).not.toContain(raw);
});
it('rejects cross-origin and oversized bodies before accessing native search',async()=>{
 expect((await POST(request('term=private','https://foreign.invalid'))).status).toBe(403);expect(create).not.toHaveBeenCalled();
 expect((await POST(request('term='+('x'.repeat(132000))))).status).toBe(413);expect(create).not.toHaveBeenCalled();
});
it('reports an unexpected source failure as 500 without echoing the failure or search text',async()=>{
 create.mockRejectedValue(new Error('private backend sentinel'));const response=await POST(request('term=private-input-sentinel'));
 expect(response.status).toBe(500);expect(response.headers.get('cache-control')).toBe('private, no-store');
 expect(await response.text()).toBe('Search unavailable. Try again.');
});
it('keeps malformed form input and the typed search limit as no-store 400 responses',async()=>{
 for(const form of [new URLSearchParams({term:'x'.repeat(201)}),new URLSearchParams({'field.joinDate':'invalid-date'})]){
  const response=await POST(request(form.toString()));expect(response.status).toBe(400);
  expect(response.headers.get('cache-control')).toBe('private, no-store');expect(await response.text()).toBe('Search unavailable. Try again.');
 }
 expect(create).not.toHaveBeenCalled();
 const limit=new PersonnelSearchLimitError();limit.message='Narrow the requested scope.';create.mockRejectedValue(limit);
 const response=await POST(request('term=private-input-sentinel'));expect(response.status).toBe(400);
 expect(response.headers.get('cache-control')).toBe('private, no-store');expect(await response.text()).toBe(limit.message);
});

it('keeps column filter text out of the redirect and passes conjunctive filters to the private owner',async()=>{
 const raw='PRIVATE-FICTIONAL-EMPLOYEE';const form=new URLSearchParams({'field.name':raw,'field.employment.contractStartDate':'2026-01-01','operator.employment.contractStartDate':'from',sort:'joinDate',direction:'desc'});
 const response=await POST(request(form.toString()));expect(response.status).toBe(303);expect(response.headers.get('location')).not.toContain(raw);expect(response.headers.get('location')).toContain('sort=joinDate');expect(create.mock.calls[0][1].columnFilters).toEqual([{field:'name',operator:'contains',value:raw},{field:'employment.contractStartDate',operator:'from',value:'2026-01-01'}]);
});
it('ordinary filters do not create private membership and untrusted search text never enters the URL',async()=>{
 const response=await POST(request('companies='+scope.company+'&search=private-text'));expect(response.status).toBe(303);expect(response.headers.get('location')).not.toContain('private-text');expect(create).not.toHaveBeenCalled();
});

it('individual removal sends a complete replacement while retaining the other private text',async()=>{
 const form=new URLSearchParams({term:'PRIVATE-TERM','field.name':'PRIVATE-NAME','field.company':scope.company,'operator.company':'equals',removeField:'company'});
 const response=await POST(request(form.toString()));expect(response.status).toBe(303);expect(create).toHaveBeenCalledWith(scope.ctx,{text:'PRIVATE-TERM',companyIds:[scope.company],replaceCriteria:true,columnFilters:[{field:'name',operator:'contains',value:'PRIVATE-NAME'}]});
 expect(response.headers.get('location')).not.toMatch(/PRIVATE-TERM|PRIVATE-NAME/);
});
it('removing the last private criterion clears the token instead of reusing its old membership',async()=>{
 const response=await POST(request('term=private&removeField=term&search='+('a'.repeat(43))));expect(response.status).toBe(303);expect(create).not.toHaveBeenCalled();expect(response.headers.get('location')).toBe('/admin/personnel');
});
