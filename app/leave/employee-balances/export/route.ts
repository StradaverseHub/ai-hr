/**
 * Employee Balances export (feedback 20c699f8) — the CURRENTLY SHOWN table, in CSV or Excel.
 *
 * Admin-gated like the leave-requests export next door, and read-only (no DomainEvent — downloading a
 * report mutates nothing). Rows come from the same `employeeBalanceRows` the screen renders, so the file
 * and the screen can never disagree about a figure, an as-at date, or a filter.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { LEAVE_FIGURE_LABEL_KEY, LEAVE_FIGURE_NS } from '@/lib/leave-figure-labels';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { listEmployees } from '@/core/read';
import { todayInKualaLumpur } from '@/core/leave';
import { toCsvReport, toXlsxReport, type ReportData } from '@/lib/report-export';
import { pickInquiryEmployee, sortInquiryEmployees } from '@/lib/leave-inquiry';
import { formatDays } from '@/lib/day-format';
import { pooledEntitlementCaption, isPoolBorrower, poolBadges } from '@/lib/shared-leave-balance';
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
  // 7da0a4e7 — this route's standing invariant is that the FILE exports the table that was on screen. A
  // column whose header said one thing here and another there would break it just as surely as a missing
  // column, so the two figures with standardised names resolve through lib/leave-figure-labels.ts, the
  // same dictionary the screen reads.
  const tf = await getTranslations(LEAVE_FIGURE_NS);

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
  /**
   * 2a57a007 — WHERE A SHARED DAY WENT, OR CAME FROM, IN A FILE READ AWAY FROM THE SCREEN.
   *
   * Share and Pending Share are the only two columns in this file whose figure names no counterparty. On
   * screen the pool's row answers that with a badge per contributing leave type and the borrower's row with
   * the "Shares one balance with…" caption under its Leave Code; a spreadsheet has neither a badge nor a
   * sub-cell, so both become a column — which is this route's own header invariant applied to the thing the
   * item added ("the file exports the table that was on screen").
   *
   *   · the POOL's row lists each borrower that moved days in THIS column, as `CODE 1.00`, semicolon
   *     separated — the badges, flattened, with the figure their tooltip carries.
   *   · a BORROWER's row names the pool its days come from, which is what its on-screen caption says.
   *   · a leave type in no pool leaves the cell EMPTY, the same convention `cell()` above uses for a figure
   *     nobody computed: a spreadsheet cell must not assert something the screen does not.
   */
  const shareSource = (r: (typeof rows)[number], which: 'share' | 'pendingShare') => {
    if (!r.sharedBalance) return '';
    if (isPoolBorrower(r)) return r.sharedBalance.sourceLeaveTypeName;
    return poolBadges(r.sharedBalance, which)
      .map((c) => `${c.code ?? c.leaveType} ${formatDays(c[which])}`)
      .join('; ');
  };
  /**
   * 2a57a007 (r340) — THE POOLED SENTENCE, OR NULL SO THE CELL FALLS THROUGH TO THE SHARED STATUS MAP.
   *
   * One decision, taken in lib/shared-leave-balance.ts and read by the screen's caption and by this cell, so
   * the two cannot tell one row apart differently — this route's header states that invariant. Everything
   * that is not a pooled borrower still resolves `ENTITLEMENT_STATUS_LABEL_KEY` exactly as it did, in the
   * cell below, where 31e39d74's cross-surface guard can see it.
   */
  const pooledStatusCell = (r: (typeof rows)[number]) => {
    const pooled = pooledEntitlementCaption(r);
    return pooled ? tMe(pooled.labelKey, { pool: pooled.pool }) : null;
  };
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
      tf(LEAVE_FIGURE_LABEL_KEY.ytdEntitled),
      tInq('colBroughtForward'),
      tMe('colTaken'),
      tInq('colPendingApproval'),
      tMe('colAdjustment'),
      // 39136455 — the two pooled-transfer columns, in the SAME position as on screen. This route's header
      // states the invariant they are here to satisfy: the file exports the table that was on screen.
      tMe('colShare'),
      // 2a57a007 — the counterparty each pooled figure moved with. See `shareSource` above for why a
      // spreadsheet needs a column where the screen has a badge and a caption.
      tMe('colShareSource'),
      tMe('colPendingShare'),
      tMe('colPendingShareSource'),
      tMe('colOverutilized'),
      tInq('colForfeitedBf'),
      tf(LEAVE_FIGURE_LABEL_KEY.balance),
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
      shareSource(r, 'share'),
      cell(r.pendingShare),
      shareSource(r, 'pendingShare'),
      cell(r.overutilized),
      cell(r.forfeitedBf),
      cell(r.balance),
      // 2a57a007 (r340) — THE SAME DECISION THE SCREEN'S CAPTION MAKES, through the same function. It matters
      // most in this column: `statusNotConfigured` and `statusNoEntitlementTable` are THE SAME SENTENCE
      // ("No entitlement table"), so a borrower row printed, in a file HR forwards, the one instruction that
      // would stop Emergency Leave drawing on the Annual pool. A pooled borrower reads "draws on the <pool>
      // pool" instead, which is what the screen says above its figure; every other row is unchanged.
      pooledStatusCell(r) ?? tMe(ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus]),
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
