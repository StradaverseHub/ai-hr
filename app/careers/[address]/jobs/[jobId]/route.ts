import type { NextRequest } from 'next/server';
import { careersApplicationsAccepted, careersClientHash, careersReadBudgetKey } from '@/lib/careers-client';
import { isCareersAddress, isCareersJobId } from '@/lib/careers-route';
import { RequestBudgetExceeded } from '@/lib/request-budget';
import { careersClientLimited, careersPublicJob, submitCareersApplication, type CareersSubmitResult } from '@/packs/recruitment/service';
import { admitCareersRead, admitCareersSubmit, careersOrigin, logCareersFailure, readCareersForm } from '../../../careers-http';
import {
  busyHtml, careersJobHtml, careersLimitedHtml, careersResponse, careersThanksHtml, careersTooLargeHtml, careersView, notFoundHtml, readLimitedHtml,
  submitLimitedHtml, unavailableHtml, type CareersView,
} from '../../../careers-html';

export const runtime = 'nodejs';

type Params = { params: Promise<{ address: string; jobId: string }> };
const wellFormed = (address: string, jobId: string) => isCareersAddress(address) && isCareersJobId(jobId);

/** Per-process admission; null when turned away. */
function admit(admission: () => () => void): (() => void) | null {
  try {
    return admission();
  } catch (e) {
    if (e instanceof RequestBudgetExceeded) return null;
    throw e;
  }
}

/**
 * Recruitment slice 8 — one public job and its application form (anonymous; admitted by middleware.ts by exact path).
 * A job that is hidden, not Open, another company's or on an unpublished page answers the same Not found as an unknown
 * one. The form posts back here; see ../../../careers-html.ts for the rendering and ../../../careers-http.ts for the
 * admission caps and the bounded body. While the installation does not accept online applications (no verified request
 * source, lib/careers-client.ts) the job is shown without the form.
 */
export async function GET(request: NextRequest, context: Params) {
  const { address, jobId } = await context.params;
  const view = await careersView(request, careersOrigin(request));
  if (!wellFormed(address, jobId)) return careersResponse(404, notFoundHtml(view));
  const release = admit(admitCareersRead);
  if (!release) return careersResponse(503, busyHtml(view), { 'retry-after': '1' });
  try {
    const data = await careersPublicJob(address, jobId, careersReadBudgetKey(request));
    if (data === 'limited') return careersResponse(429, readLimitedHtml(view), { 'retry-after': '60' });
    if (!data) return careersResponse(404, notFoundHtml(view));
    return careersResponse(200, careersJobHtml(view, address, data, undefined, careersApplicationsAccepted()));
  } catch (e) {
    logCareersFailure('job', e);
    return careersResponse(503, unavailableHtml(view), { 'retry-after': '60' });
  } finally {
    release();
  }
}

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
};

/**
 * The application. Order: the request source (no verified source: 503 before anything is read), admission, the hourly
 * per-client limit (a read-only check: 429 before the body is read), the body limit (before anything is parsed), the job (a job no longer public stores nothing), the form (field messages, the
 * current notice), then app.recruitment_careers_submit decides the rest in one transaction. A well-formed submission that
 * is stored, repeated or caught by the honeypot gets the same thank-you page. Any unexpected failure is "unavailable".
 */
export async function POST(request: NextRequest, context: Params) {
  const { address, jobId } = await context.params;
  const view: CareersView = await careersView(request, careersOrigin(request));
  if (!wellFormed(address, jobId)) return careersResponse(404, notFoundHtml(view));
  let clientHash: string;
  try {
    clientHash = careersClientHash(request).hash;
  } catch {
    return careersResponse(503, unavailableHtml(view, 'submit'), { 'retry-after': '300' });
  }
  const release = admit(admitCareersSubmit);
  if (!release) return careersResponse(429, busyHtml(view), { 'retry-after': '5' });
  try {
    if (await careersClientLimited(clientHash)) return careersResponse(429, submitLimitedHtml(view), { 'retry-after': '3600' });
    const form = await readCareersForm(request);
    if (form === 'too_large') return careersResponse(413, careersTooLargeHtml(view, address, jobId));
    const data = await careersPublicJob(address, jobId);
    if (data === 'limited' || !data) return careersResponse(404, notFoundHtml(view));
    const fields = form === 'malformed' ? new FormData() : form;
    const file = fields.get('resume');
    const values = {
      fullName: text(fields, 'fullName'), email: text(fields, 'email'), mobile: text(fields, 'mobile'), message: text(fields, 'message'),
      consent: text(fields, 'consent') === 'on',
    };
    const result: CareersSubmitResult = await submitCareersApplication({
      address, jobId, ...values, consent: values.consent ? 'on' : '', noticeVersion: text(fields, 'noticeVersion'), website: text(fields, 'website'),
      resume: file instanceof File && file.size > 0 ? { fileName: file.name, content: Buffer.from(await file.arrayBuffer()) } : null,
      clientHash: () => clientHash, currentNoticeVersion: data.notice.version,
    });
    if (!result.ok) {
      // A changed notice must be read and ticked again: the box is shown unticked with the current notice.
      const consent = values.consent && result.fields.consent !== 'notice_changed';
      return careersResponse(400, careersJobHtml(view, address, data, { values: { ...values, consent }, errors: result.fields }));
    }
    switch (result.outcome) {
      case 'received': return careersResponse(200, careersThanksHtml(view, address, data));
      case 'rate_limited': return careersResponse(429, careersLimitedHtml(view, address, data, 'client'), { 'retry-after': '3600' });
      case 'company_limit': return careersResponse(429, careersLimitedHtml(view, address, data, 'company'), { 'retry-after': '3600' });
      default: return careersResponse(404, notFoundHtml(view));
    }
  } catch (e) {
    logCareersFailure('submit', e);
    return careersResponse(503, unavailableHtml(view, 'submit'), { 'retry-after': '60' });
  } finally {
    release();
  }
}
