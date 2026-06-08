'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { recordReport } from '@/core/reporting';

export async function recordReportAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  const reportId = String(formData.get('reportId'));
  const periodKey = String(formData.get('periodKey'));
  const qs = `companyId=${encodeURIComponent(companyId)}&reportId=${encodeURIComponent(reportId)}&periodKey=${encodeURIComponent(periodKey)}`;
  try {
    await recordReport(s, { companyId, reportId, periodKey });
  } catch (e) {
    redirect(`/payroll/reports?${qs}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/reports');
  redirect(`/payroll/reports?${qs}&toast=Report%20recorded`);
}
