import type { NextRequest } from 'next/server';
import { careersClientHash } from '@/lib/careers-client';
import { isCareersAddress } from '@/lib/careers-route';
import { RequestBudgetExceeded } from '@/lib/request-budget';
import { agencyPortalAvailable, agencyPortalView, checkAgencyPortalCode, requestAgencyPortalCode, signOutAgencyPortal } from '@/packs/recruitment/service';
import { admitCareersRead, admitCareersSubmit, careersOrigin, logCareersFailure, readCareersForm } from '../../careers-http';
import { busyHtml, careersResponse, careersView, notFoundHtml, submitLimitedHtml, unavailableHtml } from '../../careers-html';
import { agencyCodeHtml, agencyPortalHtml, agencySignInHtml } from '../../agency-html';
import { clearPortalCookie, portalToken, setPortalCookie } from '../../agency-http';

export const runtime = 'nodejs';
type Params = { params: Promise<{ address: string }> };

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

/**
 * Recruitment slice 25 — the agency portal on a careers address (anonymous; admitted by middleware.ts by exact path). With a live
 * session cookie: the portal. Without: the sign-in step. A company without the portal, an unpublished page or an unknown address
 * answers the careers Not found.
 */
export async function GET(request: NextRequest, context: Params) {
  const { address } = await context.params;
  const origin = careersOrigin(request);
  const view = await careersView(request, origin);
  if (!isCareersAddress(address)) return careersResponse(404, notFoundHtml(view));
  const release = admit(admitCareersRead);
  if (!release) return careersResponse(503, busyHtml(view), { 'retry-after': '1' });
  try {
    const token = portalToken(request);
    const data = token ? await agencyPortalView(address, token) : null;
    if (data) return careersResponse(200, agencyPortalHtml(view, address, data, new URL(request.url).searchParams.get('notice') === 'received' ? 'received' : undefined));
    if (!(await agencyPortalAvailable(address))) return careersResponse(404, notFoundHtml(view));
    const response = careersResponse(200, agencySignInHtml(view, address, token ? { error: 'signed_out' } : {}));
    return token ? clearPortalCookie(response, address, origin) : response;
  } catch (e) {
    logCareersFailure('agency-portal', e);
    return careersResponse(503, unavailableHtml(view), { 'retry-after': '60' });
  } finally {
    release();
  }
}

/** Sign-in steps (intent code / verify) and sign-out (intent signout). */
export async function POST(request: NextRequest, context: Params) {
  const { address } = await context.params;
  const origin = careersOrigin(request);
  const view = await careersView(request, origin);
  if (!isCareersAddress(address)) return careersResponse(404, notFoundHtml(view));
  let clientHash: string;
  try {
    clientHash = careersClientHash(request).hash;
  } catch {
    return careersResponse(503, unavailableHtml(view, 'submit'), { 'retry-after': '300' });
  }
  const release = admit(admitCareersSubmit);
  if (!release) return careersResponse(429, busyHtml(view), { 'retry-after': '5' });
  try {
    const form = await readCareersForm(request);
    const fields = form === 'too_large' || form === 'malformed' ? new FormData() : form;
    const intent = text(fields, 'intent');
    if (intent === 'signout') {
      await signOutAgencyPortal(portalToken(request));
      return clearPortalCookie(careersResponse(200, agencySignInHtml(view, address)), address, origin);
    }
    if (intent === 'verify') {
      const email = text(fields, 'email').trim().toLowerCase();
      const checked = await checkAgencyPortalCode({ address, email, code: text(fields, 'code'), clientHash: () => clientHash });
      if (checked.status === 'signed_in') {
        const data = await agencyPortalView(address, checked.token);
        if (!data) return careersResponse(404, notFoundHtml(view));
        return setPortalCookie(careersResponse(200, agencyPortalHtml(view, address, data)), address, checked.token, origin);
      }
      if (checked.status === 'client_limited') return careersResponse(429, submitLimitedHtml(view), { 'retry-after': '3600' });
      if (checked.status === 'not_found') return careersResponse(404, notFoundHtml(view));
      return careersResponse(400, agencyCodeHtml(view, address, { email, error: checked.status }));
    }
    const email = text(fields, 'email');
    const sent = await requestAgencyPortalCode({ address, email, clientHash: () => clientHash });
    if (sent === 'invalid_email') return careersResponse(400, agencySignInHtml(view, address, { email, error: 'email' }));
    if (sent === 'client_limited') return careersResponse(429, submitLimitedHtml(view), { 'retry-after': '3600' });
    if (sent === 'not_found') return careersResponse(404, notFoundHtml(view));
    if (sent === 'unavailable') return careersResponse(503, unavailableHtml(view, 'submit'), { 'retry-after': '300' });
    return careersResponse(200, agencyCodeHtml(view, address, { email: email.trim().toLowerCase() }));
  } catch (e) {
    logCareersFailure('agency-portal-sign-in', e);
    return careersResponse(503, unavailableHtml(view, 'submit'), { 'retry-after': '60' });
  } finally {
    release();
  }
}
