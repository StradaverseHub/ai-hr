import type { NextRequest } from 'next/server';
import { careersClientHash } from '@/lib/careers-client';
import { isCareersResponseToken } from '@/lib/careers-route';
import { RequestBudgetExceeded } from '@/lib/request-budget';
import { answerCandidateResponse, candidateResponseView } from '@/packs/recruitment/service';
import { admitCareersRead, admitCareersSubmit, careersOrigin, logCareersFailure, readCareersForm } from '../../careers-http';
import {
  busyHtml, careersResponse, careersResponseHtml, careersResponseLimitedHtml, careersResponseNotFoundHtml, careersView, unavailableHtml,
} from '../../careers-html';

export const runtime = 'nodejs';

type Params = { params: Promise<{ token: string }> };

function admit(admission: () => () => void): (() => void) | null {
  try {
    return admission();
  } catch (e) {
    if (e instanceof RequestBudgetExceeded) return null;
    throw e;
  }
}

/**
 * Recruitment slice 21b — a candidate's response link (anonymous; admitted by middleware.ts by exact path, lib/careers-route.ts).
 * GET only shows what the link is about and the answer given: opening it changes nothing (mail scanners open links). An unknown
 * token answers the same Not found as a malformed one.
 */
export async function GET(request: NextRequest, context: Params) {
  const { token } = await context.params;
  const view = await careersView(request, careersOrigin(request));
  if (!isCareersResponseToken(token)) return careersResponse(404, careersResponseNotFoundHtml(view));
  const release = admit(admitCareersRead);
  if (!release) return careersResponse(503, busyHtml(view), { 'retry-after': '1' });
  try {
    const state = await candidateResponseView(token);
    if (!state) return careersResponse(404, careersResponseNotFoundHtml(view));
    return careersResponse(200, careersResponseHtml(view, token, state));
  } catch (e) {
    logCareersFailure('response-view', e);
    return careersResponse(503, unavailableHtml(view), { 'retry-after': '60' });
  } finally {
    release();
  }
}

/** Accept or Decline: 20 answers an hour per client (the slice 8 keyed client hash); the link's state decides the rest. */
export async function POST(request: NextRequest, context: Params) {
  const { token } = await context.params;
  const view = await careersView(request, careersOrigin(request));
  if (!isCareersResponseToken(token)) return careersResponse(404, careersResponseNotFoundHtml(view));
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
    const answer = form instanceof FormData ? form.get('answer') : null;
    if (answer !== 'accepted' && answer !== 'declined') {
      const state = await candidateResponseView(token);
      return state ? careersResponse(400, careersResponseHtml(view, token, state)) : careersResponse(404, careersResponseNotFoundHtml(view));
    }
    const r = await answerCandidateResponse(token, answer, clientHash);
    if (r.status === 'answered') return careersResponse(200, careersResponseHtml(view, token, r.state, true));
    if (r.status === 'closed') return careersResponse(409, careersResponseHtml(view, token, r.state));
    if (r.status === 'limited') return careersResponse(429, careersResponseLimitedHtml(view, token), { 'retry-after': '3600' });
    return careersResponse(404, careersResponseNotFoundHtml(view));
  } catch (e) {
    logCareersFailure('response-answer', e);
    return careersResponse(503, unavailableHtml(view, 'submit'), { 'retry-after': '60' });
  } finally {
    release();
  }
}
