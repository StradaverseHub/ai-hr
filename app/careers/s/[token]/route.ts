import type { NextRequest } from 'next/server';
import { careersClientHash } from '@/lib/careers-client';
import { isCareersResponseToken } from '@/lib/careers-route';
import { RequestBudgetExceeded } from '@/lib/request-budget';
import { answerCandidateSurvey, candidateSurveyView } from '@/packs/recruitment/service';
import { admitCareersRead, admitCareersSubmit, careersOrigin, logCareersFailure, readCareersForm } from '../../careers-http';
import {
  busyHtml, careersResponse, careersSurveyClosedHtml, careersSurveyHtml, careersSurveyLimitedHtml, careersSurveyThanksHtml, careersView, unavailableHtml,
  type SurveyFormValues,
} from '../../careers-html';

export const runtime = 'nodejs';

type Params = { params: Promise<{ token: string }> };
const FIELDS = ['overall', 'communication', 'respect', 'process', 'recommend', 'comment'] as const;

function admit(admission: () => () => void): (() => void) | null {
  try {
    return admission();
  } catch (e) {
    if (e instanceof RequestBudgetExceeded) return null;
    throw e;
  }
}

/**
 * Recruitment slice 22 — a candidate's anonymous survey link (admitted by middleware.ts by exact path, lib/careers-route.ts). GET only
 * shows the form: opening it changes nothing (mail scanners open links). An unknown, used or expired link — or a malformed one — gets
 * the same closed page, so a link never tells which.
 */
export async function GET(request: NextRequest, context: Params) {
  const { token } = await context.params;
  const view = await careersView(request, careersOrigin(request));
  if (!isCareersResponseToken(token)) return careersResponse(404, careersSurveyClosedHtml(view));
  const release = admit(admitCareersRead);
  if (!release) return careersResponse(503, busyHtml(view), { 'retry-after': '1' });
  try {
    const survey = await candidateSurveyView(token);
    if (!survey) return careersResponse(404, careersSurveyClosedHtml(view));
    return careersResponse(200, careersSurveyHtml(view, token, survey.companyName));
  } catch (e) {
    logCareersFailure('survey-view', e);
    return careersResponse(503, unavailableHtml(view), { 'retry-after': '60' });
  } finally {
    release();
  }
}

/** The answers: once per link; 20 an hour per client (the slice 8 keyed client hash, shared with response links). */
export async function POST(request: NextRequest, context: Params) {
  const { token } = await context.params;
  const view = await careersView(request, careersOrigin(request));
  if (!isCareersResponseToken(token)) return careersResponse(404, careersSurveyClosedHtml(view));
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
    const values: SurveyFormValues = {};
    if (form instanceof FormData) for (const f of FIELDS) { const v = form.get(f); if (typeof v === 'string') values[f] = v; }
    const r = await answerCandidateSurvey(token, values, clientHash);
    if (r.status === 'answered') return careersResponse(200, careersSurveyThanksHtml(view, token));
    if (r.status === 'limited') return careersResponse(429, careersSurveyLimitedHtml(view, token), { 'retry-after': '3600' });
    if (r.status === 'invalid') {
      const survey = await candidateSurveyView(token);
      return survey ? careersResponse(400, careersSurveyHtml(view, token, survey.companyName, values, r.fields)) : careersResponse(404, careersSurveyClosedHtml(view));
    }
    return careersResponse(404, careersSurveyClosedHtml(view));
  } catch (e) {
    logCareersFailure('survey-answer', e);
    return careersResponse(503, unavailableHtml(view, 'submit'), { 'retry-after': '60' });
  } finally {
    release();
  }
}
