import {beforeEach,describe,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({companies:vi.fn(),scope:vi.fn(),list:vi.fn(),counts:vi.fn(),reroutes:vi.fn()}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('NOT_FOUND');}}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>Object.assign((key:string)=>key,{has:()=>true})}));
vi.mock('@/lib/authz',()=>({requireAdmin:async()=>({tenantId:'tenant',roles:['hr_admin']}),isGroupAdmin:()=>false}));
vi.mock('@/core/read',()=>({allowedCompanies:f.companies}));
vi.mock('@/lib/scope',()=>({getScopeIds:f.scope}));
vi.mock('@/core/profile',()=>({listProfileChangeRequests:f.list}));
vi.mock('@/core/profile-routing',()=>({profileRouteCounts:f.counts,profileRerouteCandidates:f.reroutes}));
vi.mock('@/app/(app)/admin/personnel/profile-changes/actions',()=>({decideProfileChangeAction:vi.fn(),rerouteProfileChangeAction:vi.fn()}));
import Page from '../app/(app)/admin/personnel/profile-changes/page';
beforeEach(()=>vi.clearAllMocks());
describe('relocated profile queue invalid-query boundary',()=>{
 for(const requestId of ['-'.repeat(36),'a'.repeat(36),'11111111-1111-1111-11111111111','not-a-request'])it(`refuses ${requestId} before company/queue/count queries`,async()=>{
  await expect(Page({searchParams:Promise.resolve({requestId})})).rejects.toThrow('NOT_FOUND');
  expect(f.companies).not.toHaveBeenCalled();expect(f.scope).not.toHaveBeenCalled();expect(f.list).not.toHaveBeenCalled();expect(f.counts).not.toHaveBeenCalled();expect(f.reroutes).not.toHaveBeenCalled();
 });
 for(const rerouteAfter of ['not-a-date|'+('-'.repeat(36)),'2026-01-01T00:00:00Z|'+('-'.repeat(36))])it('refuses malformed maintenance cursors before loading request identities',async()=>{
  await expect(Page({searchParams:Promise.resolve({rerouteAfter})})).rejects.toThrow('NOT_FOUND');
  expect(f.companies).not.toHaveBeenCalled();expect(f.reroutes).not.toHaveBeenCalled();
 });
});
