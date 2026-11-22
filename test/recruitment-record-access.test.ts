import {beforeEach,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';

const mocks=vi.hoisted(()=>({viewer:vi.fn(),defaults:vi.fn()}));
vi.mock('../packs/recruitment/service',()=>({
 recruitmentViewer:mocks.viewer,ensureRecruitmentDefaults:mocks.defaults,
 RECRUITMENT_ERROR_CODES:[],SCREENING_LIST_LIMIT:200,
}));
vi.mock('../lib/authz',()=>({canAdminRecruitment:vi.fn(),withEffectiveGrants:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error('redirect:'+path);}}));
import {recruitmentViewerAccess} from '../app/recruitment/shared';

const session:SessionContext={tenantId:'fictional-tenant',userId:'fictional-hr'};
const scope=['first-company','second-company'];
const administered=scope.map(id=>({id,name:id}));
const access={adminCompanies:administered,teamCompanies:[],pendingApprovals:0,
 reportCompanies:administered,pendingScreening:0,poolCompanies:administered};

beforeEach(()=>{
 vi.resetAllMocks();
 mocks.viewer.mockResolvedValue(access);
});

it('keeps the authorized record scope without initializing the companies on open',async()=>{
 await expect(recruitmentViewerAccess(session,scope,{seed:false})).resolves.toEqual({
  ...access,companies:administered,isAdmin:true,
 });
 expect(mocks.viewer).toHaveBeenCalledExactlyOnceWith(session,scope);
 expect(mocks.defaults).not.toHaveBeenCalled();
});

it('retains the existing initialization for callers that use it',async()=>{
 await recruitmentViewerAccess(session,scope);
 expect(mocks.defaults).toHaveBeenCalledExactlyOnceWith(session,scope);
});

it('refuses an unrelated viewer before any initialization',async()=>{
 mocks.viewer.mockResolvedValue({...access,adminCompanies:[]});
 await expect(recruitmentViewerAccess(session,scope,{seed:false})).rejects.toThrow('redirect:/');
 expect(mocks.defaults).not.toHaveBeenCalled();
});
