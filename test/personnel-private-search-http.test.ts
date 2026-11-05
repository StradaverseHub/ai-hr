import {beforeEach,expect,it,vi} from 'vitest';
const scope=vi.hoisted(()=>({ctx:{tenantId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222'},company:'33333333-3333-4333-8333-333333333333'}));
const create=vi.hoisted(()=>vi.fn());
vi.mock('../lib/workforce-authz',()=>({requireWorkforceAccess:async()=>({s:scope.ctx,scopeIds:[scope.company]})}));
vi.mock('../core/personnel-private-search',()=>({createPersonnelPrivateSearch:create,privateSearchHash:()=>null,personnelPrivateSearchAvailable:async()=>false,PersonnelSearchLimitError:class extends Error{}}));
import {POST} from '../app/admin/personnel/search/route';
beforeEach(()=>{create.mockReset();create.mockResolvedValue('a'.repeat(43));});
const request=(body:string,origin='https://fixture.invalid')=>new Request('https://fixture.invalid/admin/personnel/search',{method:'POST',headers:{origin,host:'fixture.invalid','content-type':'application/x-www-form-urlencoded'},body});
it('posts all text privately, returns only opaque membership and validated ordinary filters',async()=>{
 const raw='FICTIONAL-PASSPORT-4321',body=new URLSearchParams({term:raw,companies:scope.company,grade:'12',joinedFrom:'2026-01-01'});
 const response=await POST(request(body.toString()));expect(response.status).toBe(303);expect(create).toHaveBeenCalledWith(scope.ctx,{text:raw,companyIds:[scope.company]});
 const location=response.headers.get('location')!;expect(location).not.toContain(raw);expect(location).toContain('search='+('a'.repeat(43)));expect(location).toContain('grade=12');expect(response.headers.get('cache-control')).toBe('private, no-store');expect(await response.text()).not.toContain(raw);
});
it('rejects cross-origin and oversized bodies before accessing native search',async()=>{
 expect((await POST(request('term=private','https://foreign.invalid'))).status).toBe(403);expect(create).not.toHaveBeenCalled();
 expect((await POST(request('term='+('x'.repeat(132000))))).status).toBe(413);expect(create).not.toHaveBeenCalled();
});
it('never echoes an underlying source failure or supplied search text',async()=>{
 create.mockRejectedValue(new Error('private backend sentinel'));const response=await POST(request('term=private-input-sentinel'));
 expect(response.status).toBe(400);expect(await response.text()).toBe('Search unavailable. Try again.');
});
