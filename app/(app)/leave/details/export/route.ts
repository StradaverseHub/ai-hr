/**
 * r404 (42e55e2b) · MY LEAVE › LEAVE DETAILS, DOWNLOADED — "the same columns and figures as the table on screen,
 * for the employee's own record only, as at the chosen date".
 *
 * WHOSE ROWS. The page's own loader (`loadLeaveDetails`), which resolves `myEmployment(session)` itself and
 * reads only `asOf` and `q` off the query string. `?emp=`, `?employmentId=` or anything else that names a
 * person is not read at all, so a file of somebody else's balances is not a value that can be typed — under
 * an employee, a manager or an HR session alike (test/r404-leave-details.test.ts). The filename's Employee No.
 * is the session's own, for the same reason.
 *
 * WHAT IS IN IT. Exactly `LEAVE_DETAILS_COLUMNS` — the sixteen on-screen headings, in screen order, through
 * the same catalogue keys — and one row per on-screen row. A figure hidden from employees is an EMPTY cell
 * (never "0.00", which is a claim; never "—", which is text a spreadsheet cannot sum), as HR's export does.
 * Figures are numeric cells. The Explanation column cannot hold a button, so it holds the words the row's
 * notes carry on screen: the resolved entitlement table, and the Earned to Date status (pooled or not).
 *
 * A REAL .xlsx (SheetJS, already a dependency), named LeaveDetails_<EmployeeNo>_<AsAtDate>.xlsx as the plan
 * says — not the HTML-flavoured .xls lib/report-export.ts writes for HR's export. Read-only, no DomainEvent.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { formatDays } from '@/lib/day-format';
import { ENTITLEMENT_STATUS_LABEL_KEY } from '@/lib/entitlement-status';
import { pooledEntitlementCaption } from '@/lib/shared-leave-balance';
import { LEAVE_DETAILS_COLUMNS, LEAVE_DETAILS_FIGURES, leaveDetailsFilename, loadLeaveDetails } from '../data';

export const runtime = 'nodejs';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function GET(req: Request) {
  const session = await getSession();
  const url = new URL(req.url);
  const locale = await getLocale();
  const { me, asOf, rows } = await loadLeaveDetails(session, Object.fromEntries(url.searchParams.entries()), locale);
  if (!me) return new Response('Forbidden', { status: 403 });

  const t = await getTranslations();
  const tInq = await getTranslations('leave.inquiry');
  const tMe = await getTranslations('me.leaveBalanceTable');
  const tLd = await getTranslations('leaveDetails');

  const header = LEAVE_DETAILS_COLUMNS.map((c) => t(`${c.ns}.${c.key}`));
  // A figure is a NUMBER cell holding exactly the digits the screen prints (the same `formatDays`), or an
  // empty cell when it is hidden or was never computed.
  const fig = (v: number | null) => {
    const s = formatDays(v, { placeholder: '' });
    return s === '' ? null : Number(s);
  };
  const explanation = (r: (typeof rows)[number]) => {
    const parts: string[] = [];
    if (r.entitlementTemplateName) parts.push(tInq('resolvedEntitlementTable', { name: r.entitlementTemplateName }));
    if (r.ytdEntitled != null) {
      const pooled = pooledEntitlementCaption(r);
      parts.push(pooled ? tMe(pooled.labelKey, { pool: pooled.pool }) : tMe(ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus]));
    }
    return parts.join(' · ');
  };
  const body = rows.map((r) => [
    r.code && r.code !== r.leaveType ? `${r.code} (${r.leaveType})` : r.code || r.leaveType,
    r.entitlementYear ?? '',
    ...LEAVE_DETAILS_FIGURES.map((k) => fig(r[k])),
    asOf,
    explanation(r),
  ]);

  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  // Two decimals on every figure cell, as on screen.
  const figCols = LEAVE_DETAILS_FIGURES.map((_, i) => i + 2);
  for (let ri = 1; ri <= body.length; ri++) {
    for (const ci of figCols) {
      const cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })];
      if (cell && cell.t === 'n') cell.z = '0.00';
    }
  }
  ws['!cols'] = header.map((h, i) => ({ wch: i === 0 ? 28 : i === header.length - 1 ? 48 : Math.max(10, Math.min(18, h.length + 2)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, tLd('title').slice(0, 31) || 'Leave Details');
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);

  const filename = `${leaveDetailsFilename(me.employeeCode, asOf)}.xlsx`;
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
