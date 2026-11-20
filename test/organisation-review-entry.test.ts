import {beforeEach,expect,it,vi} from 'vitest';

const {getSession,readReport,notFoundSignal}=vi.hoisted(()=>({
  getSession:vi.fn(),
  readReport:vi.fn(),
  notFoundSignal:new Error('NEXT_HTTP_ERROR_FALLBACK;404'),
}));
vi.mock('next/navigation',()=>({notFound:()=>{throw notFoundSignal;}}));
vi.mock('../lib/session',()=>({getSession}));
vi.mock('../core/company-organisation',()=>({companyOrganisationRunReport:readReport}));
vi.mock('../app/admin/organization/organisation-tagging-actions',()=>({
  decideOrganisationAction:vi.fn(),
  processOrganisationAction:vi.fn(),
}));
vi.mock('../app/admin/organization/organisation-tagging-controls',()=>({OrganisationTaggingReview:()=>null}));

import OrganisationReviewPage from '../app/admin/organization/organisation-tagging/page';

const session={tenantId:'fictional-tenant',userId:'fictional-independent-checker'};
beforeEach(()=>{
  getSession.mockReset().mockResolvedValue(session);
  readReport.mockReset();
});

it.each([undefined,'bad-id','a'.repeat(36)])('handles an invalid review link (%s) before reading run data',async runId=>{
  await expect(OrganisationReviewPage({searchParams:Promise.resolve({runId})})).rejects.toBe(notFoundSignal);
  expect(getSession).toHaveBeenCalledOnce();
  expect(readReport).not.toHaveBeenCalled();
});

it('uses the existing report owner for a checker opening an exact run and page',async()=>{
  const runId='11111111-2222-4333-8444-555555555555';
  readReport.mockResolvedValue({run:{id:runId},rows:[],hasMore:false});
  await expect(OrganisationReviewPage({searchParams:Promise.resolve({runId,offset:'100'})})).resolves.toBeDefined();
  expect(readReport).toHaveBeenCalledExactlyOnceWith(session,runId,100);
});
