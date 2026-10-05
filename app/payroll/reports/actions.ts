'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { markReportFiled, recordReport, reverseReportFiling, StatutoryFilingError } from '@/core/reporting';

export async function recordReportAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  const reportId = String(formData.get('reportId'));
  const periodKey = String(formData.get('periodKey'));
  const qs = `companyId=${encodeURIComponent(companyId)}&reportId=${encodeURIComponent(reportId)}&periodKey=${encodeURIComponent(periodKey)}`;
  try {
    await recordReport(s, { companyId, reportId, periodKey });
  } catch (e) {
    redirect(`/payroll/reports?${qs}&error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath('/payroll/reports');
  redirect(`/payroll/reports?${qs}&toast=Report%20recorded`);
}

/**
 * r292 / readiness 3.2 — MARK A RECORDED STATUTORY RETURN AS FILED WITH ITS AGENCY.
 *
 * All the authority lives in `markReportFiled` (core/reporting.ts): the `payroll.statutory_file`
 * permission, the mandatory acknowledgement reference, the no-future-date rule, and whether this is a
 * plain submission or an amendment. This action does three things and nothing else — read the form,
 * translate a refusal, come back to the same company filter.
 *
 * ⚠️ WHY THE `catch` MAPS A CODE AND NEVER A MESSAGE. `recordReportAction` above pushes
 * `(e as Error).message` — a raw English core string — into the URL. That is the bug r291 found on the
 * route that answered 200 with a raw message key in the payload, in a different costume. Every refusal
 * this action can produce is a NAMED code on StatutoryFilingError, so each one becomes translated copy;
 * anything unnamed falls back to the generic key rather than leaking an internal sentence. Nothing here
 * ever puts a message KEY in the query string either — `t()` is resolved server-side, so what travels
 * is finished copy.
 */
const FILING_ERROR_KEYS: Record<StatutoryFilingError['code'], string> = {
  forbidden: 'errFilingForbidden',
  notFound: 'errFilingNotFound',
  ackRefRequired: 'errAckRefRequired',
  ackRefTooLong: 'errAckRefTooLong',
  reasonRequired: 'errFilingReasonRequired',
  invalidFiledOn: 'errInvalidFiledOn',
  filedOnInFuture: 'errFiledOnInFuture',
  alreadyFiled: 'errAlreadyFiled',
  notFiled: 'errNotFiled',
};

async function filingErrorCopy(e: unknown): Promise<string> {
  const t = await getTranslations('payroll.reports');
  if (e instanceof StatutoryFilingError) return t(FILING_ERROR_KEYS[e.code]);
  return t('errFilingFailed');
}

export async function markFiledAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const reportId = String(formData.get('reportId') ?? '');
  const ackRef = String(formData.get('ackRef') ?? '');
  const filedOn = String(formData.get('filedOn') ?? '');
  const home = `/payroll/reports?companyId=${encodeURIComponent(companyId)}`;
  let toastKey = 'markFiledDoneSubmitted';
  try {
    const r = await markReportFiled(s, { reportId, ackRef, filedOn });
    toastKey = r?.status === 'amended' ? 'markFiledDoneAmended' : 'markFiledDoneSubmitted';
  } catch (e) {
    redirect(`${home}&error=${encodeURIComponent(await filingErrorCopy(e))}`);
  }
  const t = await getTranslations('payroll.reports');
  revalidatePath('/payroll/reports');
  redirect(`${home}&toast=${encodeURIComponent(t(toastKey))}`);
}

/** Reverse a filing mark made in error — back to draft, with a mandatory reason on the audit event. */
export async function reverseFilingAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const reportId = String(formData.get('reportId') ?? '');
  const reason = String(formData.get('reason') ?? '');
  const home = `/payroll/reports?companyId=${encodeURIComponent(companyId)}`;
  try {
    await reverseReportFiling(s, { reportId, reason });
  } catch (e) {
    redirect(`${home}&error=${encodeURIComponent(await filingErrorCopy(e))}`);
  }
  const t = await getTranslations('payroll.reports');
  revalidatePath('/payroll/reports');
  redirect(`${home}&toast=${encodeURIComponent(t('reverseFilingDone'))}`);
}
