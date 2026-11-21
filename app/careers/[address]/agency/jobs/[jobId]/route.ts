import { NextResponse, type NextRequest } from 'next/server';
import { careersClientHash } from '@/lib/careers-client';
import { agencyPortalPath, isCareersAddress, isCareersJobId } from '@/lib/careers-route';
import { RequestBudgetExceeded } from '@/lib/request-budget';
import { agencyPortalView, submitAgencyPortal, type AgencyPortalView } from '@/packs/recruitment/service';
import { admitCareersRead, admitCareersSubmit, careersOrigin, logCareersFailure, readCareersForm } from '../../../../careers-http';
import { busyHtml, careersResponse, careersTooLargeHtml, careersView, link, notFoundHtml, submitLimitedHtml, unavailableHtml, type CareersView } from '../../../../careers-html';
import { agencyJobHtml, agencySignInHtml, type AgencyFormValues } from '../../../../agency-html';
import { clearPortalCookie, portalToken } from '../../../../agency-http';

export const runtime = 'nodejs';
type Params = { params: Promise<{ address: string; jobId: string }> };

function admit(admission: () => () => void): (() => void) | null {
  try {
    return admission();
  } catch (e) {
    if (e instanceof RequestBudgetExceeded) return null;
    throw e;
  }
}
const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
};
/** The released job (under the chosen contract when it is one of the job's), and every contract that releases it. */
function jobOf(data: AgencyPortalView, jobId: string, contractId: string | null) {
  const choices = data.jobs.filter((j) => j.jobId === jobId);
  return { job: choices.find((j) => j.contractId === contractId) ?? choices[0] ?? null, choices };
}
const signedOut = (view: CareersView, address: string, origin: string) =>
  clearPortalCookie(careersResponse(401, agencySignInHtml(view, address, { error: 'signed_out' })), address, origin);

/** Recruitment slice 25 — one job released to the signed-in consultant's contracts, with the submission form. */
export async function GET(request: NextRequest, context: Params) {
  const { address, jobId } = await context.params;
  const origin = careersOrigin(request);
  const view = await careersView(request, origin);
  if (!isCareersAddress(address) || !isCareersJobId(jobId)) return careersResponse(404, notFoundHtml(view));
  const release = admit(admitCareersRead);
  if (!release) return careersResponse(503, busyHtml(view), { 'retry-after': '1' });
  try {
    const data = await agencyPortalView(address, portalToken(request));
    if (!data) return signedOut(view, address, origin);
    const { job, choices } = jobOf(data, jobId, new URL(request.url).searchParams.get('contract'));
    if (!job) return careersResponse(404, notFoundHtml(view));
    return careersResponse(200, agencyJobHtml(view, address, data, job, choices));
  } catch (e) {
    logCareersFailure('agency-portal-job', e);
    return careersResponse(503, unavailableHtml(view), { 'retry-after': '60' });
  } finally {
    release();
  }
}

/** Submit a candidate into HR's inbox. A received submission returns to the portal with a confirmation (303). */
export async function POST(request: NextRequest, context: Params) {
  const { address, jobId } = await context.params;
  const origin = careersOrigin(request);
  const view = await careersView(request, origin);
  if (!isCareersAddress(address) || !isCareersJobId(jobId)) return careersResponse(404, notFoundHtml(view));
  let clientHash: string;
  try {
    clientHash = careersClientHash(request).hash;
  } catch {
    return careersResponse(503, unavailableHtml(view, 'submit'), { 'retry-after': '300' });
  }
  const release = admit(admitCareersSubmit);
  if (!release) return careersResponse(429, busyHtml(view), { 'retry-after': '5' });
  try {
    const token = portalToken(request);
    const data = await agencyPortalView(address, token);
    if (!data) return signedOut(view, address, origin);
    const form = await readCareersForm(request);
    if (form === 'too_large') return careersResponse(413, careersTooLargeHtml(view, address, jobId));
    const fields = form === 'malformed' ? new FormData() : form;
    const { job, choices } = jobOf(data, jobId, text(fields, 'contractId'));
    if (!job) return careersResponse(404, notFoundHtml(view));
    const values: AgencyFormValues = { fullName: text(fields, 'fullName'), email: text(fields, 'email'), mobile: text(fields, 'mobile'),
      comments: text(fields, 'comments'), permission: text(fields, 'permission') === 'on' };
    const file = fields.get('resume');
    const result = await submitAgencyPortal({ address, token, clientHash: () => clientHash, jobId, contractId: job.contractId, ...values,
      resume: file instanceof File && file.size > 0 ? { fileName: file.name, content: Buffer.from(await file.arrayBuffer()) } : null });
    switch (result.status) {
      case 'received': return NextResponse.redirect(new URL(link(view, agencyPortalPath(address), { notice: 'received' }), origin), 303);
      case 'invalid': return careersResponse(400, agencyJobHtml(view, address, data, job, choices, values, result.fields));
      case 'signed_out': return signedOut(view, address, origin);
      case 'client_limited': return careersResponse(429, submitLimitedHtml(view), { 'retry-after': '3600' });
      default: return careersResponse(result.status === 'not_available' ? 404 : 429, agencyJobHtml(view, address, data, job, choices, values, [], result.status));
    }
  } catch (e) {
    logCareersFailure('agency-portal-submit', e);
    return careersResponse(503, unavailableHtml(view, 'submit'), { 'retry-after': '60' });
  } finally {
    release();
  }
}
