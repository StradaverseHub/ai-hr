'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { recordReport } from '@/core/reporting';

/**
 * Record a generation from the per-form statutory screen (6babf4f6).
 *
 * The SAME `recordReport` the Reports page has always called — the append-only `statutory_report`
 * artefact plus its domain event, unchanged. The only thing this action adds is returning you to the
 * form you were on rather than to the general Reports page, which is the whole point of the redesign.
 *
 * `year`/`month` ride along so the redirect restores the period you were looking at. `periodKey` is what
 * is actually recorded — for an annual form it is the year, and the month is then simply carried back to
 * the landing page's filter.
 */
export async function recordReportAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  const formId = String(formData.get('formId'));
  const periodKey = String(formData.get('periodKey'));
  const year = String(formData.get('year'));
  const month = String(formData.get('month'));
  const path = `/payroll/statutory-forms/${encodeURIComponent(formId)}`;
  const qs = `companyId=${encodeURIComponent(companyId)}&year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`;
  try {
    await recordReport(s, { companyId, reportId: formId, periodKey });
  } catch (e) {
    redirect(`${path}?${qs}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(path);
  redirect(`${path}?${qs}&toast=Report%20recorded`);
}
