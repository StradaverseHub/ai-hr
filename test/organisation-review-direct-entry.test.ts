import {beforeEach,expect,it,vi} from 'vitest';
import OrganisationReviewPage from '../app/admin/organization/organisation-tagging/page';

const h=vi.hoisted(()=>{
 const redirectSignal=new Error('redirect');
 const notFoundSignal=new Error('not found');
 return {
  redirect:vi.fn((_href:string)=>{throw redirectSignal;}),
  notFound:vi.fn(()=>{throw notFoundSignal;}),
  getSession:vi.fn(),
  report:vi.fn(),
  redirectSignal,notFoundSignal,
 };
});
vi.mock('next/navigation',()=>({redirect:h.redirect,notFound:h.notFound}));
vi.mock('../lib/session',()=>({getSession:h.getSession}));
vi.mock('../core/company-organisation',()=>({companyOrganisationRunReport:h.report}));
vi.mock('../app/admin/organization/organisation-tagging-controls',()=>({OrganisationTaggingReview:()=>null}));
vi.mock('../app/admin/organization/organisation-tagging-actions',()=>({decideOrganisationAction:vi.fn(),processOrganisationAction:vi.fn()}));
vi.mock('../components/ui',()=>({pageWideCls:'page'}));

beforeEach(()=>{vi.clearAllMocks();h.getSession.mockResolvedValue({tenantId:'fictional'});});

it('opens the organisation workspace when a review has no run identifier',async()=>{
 await expect(OrganisationReviewPage({searchParams:Promise.resolve({})})).rejects.toBe(h.redirectSignal);
 expect(h.redirect).toHaveBeenCalledExactlyOnceWith('/admin/organization');
 expect(h.report).not.toHaveBeenCalled();
});

it('gives a missing or forbidden run the same unavailable outcome',async()=>{
 const invalid='------------------------------------';
 await expect(OrganisationReviewPage({searchParams:Promise.resolve({runId:invalid})})).rejects.toBe(h.notFoundSignal);
 expect(h.report).not.toHaveBeenCalled();
 const runId='10000000-0000-4000-8000-000000000001';
 h.report.mockRejectedValueOnce({cause:{code:'42501'}});
 await expect(OrganisationReviewPage({searchParams:Promise.resolve({runId,offset:'100'})})).rejects.toBe(h.notFoundSignal);
 expect(h.report).toHaveBeenCalledExactlyOnceWith({tenantId:'fictional'},runId,100);
});
