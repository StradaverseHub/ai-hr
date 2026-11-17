import type { NextRequest } from 'next/server';
import { isCareersAddress } from '@/lib/careers-route';
import { careersReadBudgetKey } from '@/lib/careers-client';
import { RequestBudgetExceeded } from '@/lib/request-budget';
import { careersPageNumber, careersPublicPage } from '@/packs/recruitment/service';
import { admitCareersRead, careersOrigin, careersQueryText, logCareersFailure } from '../careers-http';
import { busyHtml, careersPageHtml, careersResponse, careersView, notFoundHtml, readLimitedHtml, unavailableHtml } from '../careers-html';

export const runtime = 'nodejs';

/**
 * Recruitment slice 8 — a company's public careers page (anonymous; admitted by middleware.ts by exact path). Every
 * address that is not public answers the same Not found. Search, location and employment-type filters and paging are
 * bound parameters of app.recruitment_careers_page. Bounded three ways: per-process admission (a short "busy" page), a
 * per-client read budget when the client can be told apart (429), and the careers pool's statement and lock timeouts
 * (503). No cookie is set; see ../careers-html.ts for the rendering choice.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ address: string }> }) {
  const { address } = await context.params;
  const view = await careersView(request, careersOrigin(request));
  if (!isCareersAddress(address)) return careersResponse(404, notFoundHtml(view));
  let release: () => void;
  try {
    release = admitCareersRead();
  } catch (e) {
    if (e instanceof RequestBudgetExceeded) return careersResponse(503, busyHtml(view), { 'retry-after': '1' });
    throw e;
  }
  try {
    const sp = request.nextUrl.searchParams;
    const filters = {
      query: careersQueryText(sp.get('q'), 100), location: careersQueryText(sp.get('location'), 200),
      employmentType: careersQueryText(sp.get('type'), 40), page: careersPageNumber(sp.get('page')),
    };
    const page = await careersPublicPage(address, { query: filters.query, location: filters.location, employmentType: filters.employmentType, page: filters.page },
      careersReadBudgetKey(request));
    if (page === 'limited') return careersResponse(429, readLimitedHtml(view), { 'retry-after': '60' });
    if (!page) return careersResponse(404, notFoundHtml(view));
    return careersResponse(200, careersPageHtml(view, address, page, filters));
  } catch (e) {
    logCareersFailure('page', e);
    return careersResponse(503, unavailableHtml(view), { 'retry-after': '60' });
  } finally {
    release();
  }
}
