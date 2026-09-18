/**
 * Employee Balances export (feedback 20c699f8) — the CURRENTLY SHOWN table, in CSV or Excel.
 *
 * Admin-gated like the leave-requests export next door, and read-only (no DomainEvent — downloading a
 * report mutates nothing). Rows come from the same `employeeBalanceRows` the screen renders, so the file
 * and the screen can never disagree about a figure, an as-at date, or a filter.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { listEmployees } from '@/core/read';
import { todayInKualaLumpur } from '@/core/leave';
import { toCsvReport, toXlsxReport, type ReportData } from '@/lib/report-export';
import { pickInquiryEmployee, sortInquiryEmployees } from '@/lib/leave-inquiry';
import { formatDays } from '@/lib/day-format';
import { ENTITLEMENT_STATUS_LABEL_KEY } from '@/lib/entitlement-status';
import { employeeBalanceRows } from '../rows';

export async function GET(req: Request) {
  const { s: session, scopeIds } = await scopedSession();
  if (!isAdmin(session)) return new Response('Forbidden', { status: 403 });

  const sp = new URL(req.url).searchParams;
  const format = sp.get('format') === 'xlsx' ? 'xlsx' : 'csv';
  const rawAsOf = sp.get('asOf') ?? '';
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(rawAsOf) ? rawAsOf : todayInKualaLumpur();
  const dir = sp.get('dir') === 'desc' ? 'desc' : 'asc';

  const locale = await getLocale();
  const t = await getTranslations('leave');
  const tInq = await getTranslations('leave.inquiry');
  const tMe = await getTranslations('me.leaveBalanceTable');

  // Same selection rule as the screen: an unknown/absent employee falls back to the first by company
  // then name, so an export link can never resolve to a different employee than the page did.
  const employees = sortInquiryEmployees(await listEmployees(session, scopeIds), locale);
  const selected = pickInquiryEmployee(employees, sp.get('emp') ?? undefined);
  const rows = selected
    ? await employeeBalanceRows(session, selected.employmentId, asOf, locale, {
        q: sp.get('q') ?? undefined,
        typeIds: sp.getAll('type').filter(Boolean),
        dir,
      })
    : [];

  // 4a1abc4a: the export prints the same digits as the screen it exports, through the same formatter. The
  // placeholder is the ONE difference and it is deliberate — a spreadsheet cell for a figure nobody
  // computed must be EMPTY, not an em dash (which is text a reader could not sum) and not "0.00" (which is
  // a claim). `pending` is non-nullable, so it takes the same call and simply never hits the placeholder.
  const cell = (v: number | null) => formatDays(v, { placeholder: '' });
  const data: ReportData = {
    filename: `leave-balances-${selected?.employeeCode ?? 'employee'}-${asOf}`,
    title: tInq('balancesTitle'),
    columns: [
      tInq('employee'),
      tInq('colLeaveCode'),
      t('colType'),
      tInq('colEntitlementYear'),
      // r279 — Full Entitlement, in the screen's own position (before Earned to Date). This route's header
      // states the invariant: the file exports the table that was on screen, so a column added to the screen
      // and not to the file is exactly the disagreement it forbids.
      tMe('colFullEntitlement'),
      tMe('colYtdEntitled'),
      tInq('colBroughtForward'),
      tMe('colTaken'),
      tInq('colPendingApproval'),
      tMe('colAdjustment'),
      // 39136455 — the two pooled-transfer columns, in the SAME position as on screen. This route's header
      // states the invariant they are here to satisfy: the file exports the table that was on screen.
      tMe('colShare'),
      tMe('colPendingShare'),
      tMe('colOverutilized'),
      tInq('colForfeitedBf'),
      tMe('colBalance'),
      // 31e39d74 — the screen captions an ungenerated 0.00 and the export must too, or the file and the
      // screen disagree about the one thing the reporter asked to be told (this route's own header states
      // that invariant). It is a COLUMN here rather than a note under a cell because a spreadsheet has no
      // sub-cell, and unlike the screen it costs no horizontal room. All four states print — a downloaded
      // report is read away from the screen, so "generated" is worth saying rather than leaving blank.
      tInq('colEntitlementStatus'),
      tInq('colDate'),
    ],
    rows: rows.map((r) => [
      selected?.name ?? '',
      r.code,
      r.leaveType,
      r.entitlementYear ?? '',
      cell(r.fullEntitlement),
      cell(r.ytdEntitled),
      cell(r.broughtForward),
      cell(r.taken),
      cell(r.pending),
      cell(r.adjustment),
      cell(r.share),
      cell(r.pendingShare),
      cell(r.overutilized),
      cell(r.forfeitedBf),
      cell(r.balance),
      tMe(ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus]),
      asOf,
    ]),
  };

  const file = format === 'xlsx' ? toXlsxReport(data) : toCsvReport(data);
  return new Response(Buffer.from(file.bytes), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${data.filename}.${file.ext}"`,
    },
  });
}
