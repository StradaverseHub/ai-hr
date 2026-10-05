/**
 * r389 bc3e203d · LEAVE CREDIT HISTORY, EXPORTED — "it downloads exactly what you are looking at".
 *
 * WHOSE ROWS. The SAME read the page uses (`listOwnLeaveCreditHistory`), which resolves the signed-in
 * person's employments itself. No employment or person id is read off the query string at all, so a download
 * of somebody else's requests is not a value that can be typed. Pattern: app/attendance/request-status/
 * export/route.ts.
 *
 * WHICH ROWS. The query string is parsed by the page's own `parseCreditHistoryQuery` and filtered by the
 * page's own `applyCreditHistoryFilters`, so the tab, Credit Status, Day Type, Year and date bounds narrow the
 * file exactly as they narrow the screen (test/r389-leave-credit-history.test.ts compares the two). Paging is
 * ignored on purpose: the file is the whole filtered list, not the ten rows of one page.
 *
 * WHAT IS IN IT. Day figures and dates only — the read selects no money, so there is none to leak. Column
 * headers stay English (ADR-0047 §9: the payload is read by external tools); the VALUES that name a state are
 * the viewer's words, as on screen.
 */
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { listOwnLeaveCreditHistory } from '@/packs/leave/service';
import { serializeReport, type ReportFormat } from '@/lib/report-export';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { formatDays } from '@/lib/day-format';
import {
  CREDIT_STATUS_LABEL_KEY,
  DAY_TYPE_LABEL_KEY,
  applyCreditHistoryFilters,
  dmy,
  hhmm,
  hoursLabel,
  parseCreditHistoryQuery,
  type CreditHistoryLine,
} from '@/lib/leave-credit-history';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime (serializeReport dispatches to it)

const FORMATS: ReportFormat[] = ['csv', 'xlsx', 'pdf'];

/** English, in the screen's column order (the Action column has nothing to export). Not exported: a route
 * file may export only its handlers and segment config. */
const LEAVE_CREDIT_HISTORY_EXPORT_COLUMNS = [
  'Date Worked',
  'Day Type',
  'Extended Hours',
  'Credit Days',
  'Expiry Date',
  'Applied On',
  'Approval Status',
  'Credit Status',
] as const;
const WIDTHS = [11, 12, 20, 10, 11, 11, 13, 12];

/** RFC 5987 Content-Disposition: an ASCII-safe fallback plus a UTF-8-encoded `filename*`. */
function contentDisposition(base: string, ext: string): string {
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function GET(req: Request) {
  const s = await getSession();
  const me = await myEmployment(s);
  if (!me) return new Response('Forbidden', { status: 403 });
  if (!isModuleEnabledOrFalse(s, 'toil')) return new Response('Forbidden', { status: 403 });

  const url = new URL(req.url);
  const fmtRaw = url.searchParams.get('format');
  const format: ReportFormat = FORMATS.includes(fmtRaw as ReportFormat) ? (fmtRaw as ReportFormat) : 'xlsx';
  // The same default as the screen: no `year` is the current year on the Kuala Lumpur clock.
  const q = parseCreditHistoryQuery(Object.fromEntries(url.searchParams.entries()), Number(todayInKualaLumpur().slice(0, 4)));

  const t = await getTranslations('leaveCreditHistory');
  const tLeave = await getTranslations('leave');
  const tCredit = await getTranslations('admin.leaveCredit');
  const tRR = await getTranslations('replacementRequest');

  try {
    const { rows } = applyCreditHistoryFilters(await listOwnLeaveCreditHistory(s), q.filters);
    if (rows.length === 0) return new Response(t('emptyFiltered'), { status: 404 });

    const hours = (l: CreditHistoryLine) =>
      l.fromTime && l.toTime
        ? l.hours != null
          ? t('hoursValue', { from: hhmm(l.fromTime), to: hhmm(l.toTime), hours: hoursLabel(l.hours) })
          : `${hhmm(l.fromTime)} – ${hhmm(l.toTime)}`
        : '';
    const body = rows.map((l) => [
      dmy(l.workedDate),
      l.dayType ? tRR(DAY_TYPE_LABEL_KEY[l.dayType]) : '',
      hours(l),
      formatDays(l.days, { placeholder: '' }),
      l.credit ? dmy(l.credit.expiresOn) : '',
      dmy(l.submittedOn),
      tLeave(`status.${l.approvalStatus}`),
      l.credit ? tCredit(CREDIT_STATUS_LABEL_KEY[l.credit.status]) : '',
    ]);

    const stamp = todayInKualaLumpur().replace(/-/g, '');
    const base = `LeaveCreditHistory_${me.employeeCode ?? me.employmentId}_${stamp}`;
    const { bytes, contentType, ext } = await serializeReport(
      {
        filename: base,
        title: t('title'),
        columns: [...LEAVE_CREDIT_HISTORY_EXPORT_COLUMNS],
        rows: body,
        layout: {
          header: [me.name, me.employeeCode, me.position, me.company].filter(Boolean).join(' · '),
          description: `Produced ${dmy(todayInKualaLumpur())} (Malaysia time)`,
          orientation: 'landscape',
          widths: WIDTHS,
          freeze: 1,
        },
      },
      format,
    );
    return new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': contentType, 'Content-Disposition': contentDisposition(base, ext) },
    });
  } catch (e) {
    console.error('leave credit history export failed', e);
    return new Response('Could not generate the export — please try again.', { status: 500 });
  }
}
