import { getLocale, getTranslations } from 'next-intl/server';
import { Download } from 'lucide-react';

import { scopedSession } from '@/lib/scope';
import { Button, Card, EmployeeCode, Input, btnGhost } from '@/components/ui';
import { Field } from '@/components/monolith';
import { MONO_LABEL, MONO_NUM } from '@/components/monolith/classes';
import { InquiryNote } from '@/components/leave/inquiry-note';
import { EntitlementBreakdown } from '@/components/leave/EntitlementBreakdown';
import { dayPluralCategory, formatDays } from '@/lib/day-format';
import {
  ENTITLEMENT_STATUS_LABEL_KEY,
  ENTITLEMENT_STATUS_TIP_KEY,
  entitlementStatusNeedsNotice,
} from '@/lib/entitlement-status';
import { isPoolBorrower, otherContributors, poolBadges, pooledEntitlementCaption } from '@/lib/shared-leave-balance';
import { cn } from '@/lib/utils';
import type { SelfBalanceRow } from '../employee-balances/rows';
import { LEAVE_DETAILS_COLUMNS, leaveDetailsExportHref, loadLeaveDetails } from './data';

/**
 * r404 (42e55e2b) · MY LEAVE › LEAVE DETAILS (`/leave/details`).
 *
 * The employee's own balance for every leave type, as at a date they choose, laid out like HR's Leave Config ›
 * Employee Leave Inquiry › Employee Balances — so "why is my balance 9 days?" can be answered without HR.
 *
 * ── WHOSE ROWS ───────────────────────────────────────────────────────────────────────────────────────────
 * The signed-in person's: `loadLeaveDetails` resolves `myEmployment(session)` and reads only `asOf` and `q`
 * off the address (./data.ts says why that is the entire security design). There is no employee picker, no
 * company filter, no Edit or Adjust, no Employee Leave Record tab, and the leave code and Taken figure are
 * plain text (on HR's screen they open Employee Leave Record, which employees do not have).
 *
 * ── WHICH FIGURES ─────────────────────────────────────────────────────────────────────────────────────────
 * HR's own row builder with `audience: 'self'` (app/leave/employee-balances/rows.ts). This page computes no
 * figure; every cell prints a field of the row through the shared `formatDays`, a hidden figure (Employee
 * Leave View Configuration) prints "—", exactly as HR's grid prints a figure nobody computed.
 *
 * ── HR'S SCREEN IS NOT REFACTORED ONTO A SHARED TABLE ─────────────────────────────────────────────────────
 * The plan suggested one table body for both screens. Not done, deliberately: twenty-three guards pin HR's
 * page source line by line, and the load-bearing promise — the same numbers — lives in the row builder both
 * screens read and is pinned field for field by test/r404-leave-details.test.ts. The captions below reuse
 * HR's exact helpers and keys (`pooledEntitlementCaption`, `poolBadges`, `otherContributors`, the status
 * maps), so the two screens also say the same words.
 *
 * ── TWO THEMES ────────────────────────────────────────────────────────────────────────────────────────────
 * Classic classes first, Monolith appended under `monolith:` (r400's pattern), so Classic is the screen it
 * would be without Monolith and Monolith paints the board: kicker, 56px title, hairline rows, mono figures.
 * The table scrolls sideways inside its own box on a phone, with Leave Code held at the left edge.
 *
 * SERVER COMPONENT. The islands it mounts (InquiryNote, EntitlementBreakdown, Field, Button) receive strings,
 * plain data and ReactNodes only — no translator and no closure crosses the boundary.
 */
export default async function LeaveDetailsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { s: session } = await scopedSession();
  const locale = await getLocale();
  const t = await getTranslations('leaveDetails');
  const tNav = await getTranslations('nav');
  const tInq = await getTranslations('leave.inquiry');
  const tMe = await getTranslations('me');
  const tCol = await getTranslations();
  const sp = await searchParams;

  const { me, asOf, q, rows } = await loadLeaveDetails(session, sp, locale);

  const kicker = (
    <p className={cn('text-xs font-medium uppercase tracking-wide text-muted-foreground', MONO_LABEL, 'monolith:text-mid')}>
      {tNav('myLeave')}
    </p>
  );
  const header = (
    <header className="space-y-2" data-testid="leave-details-header">
      {kicker}
      <h1 className="text-xl font-semibold tracking-tight monolith:text-[40px] monolith:font-medium monolith:leading-[1.05] monolith:tracking-[-0.04em] sm:monolith:text-[56px]">
        {t('title')}
      </h1>
      <p className="text-sm text-muted-foreground monolith:text-[17px] monolith:text-mid">{t('description')}</p>
    </header>
  );

  if (!me) {
    return (
      <div className="w-full min-w-0 space-y-6">
        {header}
        <Card className="p-8 text-center">
          <p className="text-sm text-muted-foreground" data-testid="leave-details-not-linked">
            {tMe('notLinked')}
          </p>
        </Card>
      </div>
    );
  }

  const num = (v: number | null) => formatDays(v);

  /** HR's pool badges, under Share / Pending Share on the POOL's row, and only when the figure is shown. */
  const poolBadgeCells = (r: SelfBalanceRow, which: 'share' | 'pendingShare', tipKey: 'shareBadgeTip' | 'pendingShareBadgeTip') => {
    if (r[which] == null || !r.sharedBalance || isPoolBorrower(r)) return null;
    const badges = poolBadges(r.sharedBalance, which);
    if (badges.length === 0) return null;
    return (
      <div className="mt-0.5 flex flex-wrap justify-end gap-1" data-testid={`pool-badges-${which}`}>
        {badges.map((c) => (
          <span
            key={c.leaveTypeId}
            className={cn('rounded border border-border px-1 text-xs font-medium text-muted-foreground', 'monolith:rounded-none monolith:border-ink monolith:font-mono monolith:text-[10px] monolith:text-ink')}
            title={tMe(`leaveBalanceTable.${tipKey}`, {
              v: formatDays(c[which]),
              cat: dayPluralCategory(c[which], locale),
              type: c.leaveType,
              pool: r.sharedBalance!.sourceLeaveTypeName,
            })}
          >
            {c.code ?? c.leaveType}
          </span>
        ))}
      </div>
    );
  };

  /** HR's Earned to Date caption — pooled (muted) or a status that needs a word (amber) — only when the figure is shown. */
  const entitlementCaptionCell = (r: SelfBalanceRow) => {
    if (r.ytdEntitled == null) return null;
    const pooled = pooledEntitlementCaption(r);
    if (pooled) {
      return (
        <span className="inline text-muted-foreground" data-testid="entitlement-pooled-caption">
          <InquiryNote label={tInq('noteLabel')}>
            <span>{tMe(`leaveBalanceTable.${pooled.labelKey}`, { pool: pooled.pool })}</span>
            <span className="mt-1 block">{tMe(`leaveBalanceTable.${pooled.tipKey}`, { pool: pooled.pool })}</span>
          </InquiryNote>
        </span>
      );
    }
    if (!entitlementStatusNeedsNotice(r.entitlementStatus)) return null;
    return (
      <span className="inline text-amber-700 dark:text-amber-500 monolith:text-signal-text">
        <InquiryNote label={tInq('noteLabel')}>
          <span className="text-amber-700 dark:text-amber-500 monolith:text-signal-text">{tMe(`leaveBalanceTable.${ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus]}`)}</span>
          <span className="mt-1 block">{tMe(`leaveBalanceTable.${ENTITLEMENT_STATUS_TIP_KEY[r.entitlementStatus]!}`)}</span>
        </InquiryNote>
      </span>
    );
  };

  const exportHref = leaveDetailsExportHref(asOf, q);
  const panelHiddenParams: Record<string, string> = q ? { q } : {};

  // Layout: HR's measured asymmetry (026e16b9) — headings wrap on their spaces, figures never wrap.
  const thBase = cn('px-2 py-2 align-bottom font-medium', MONO_LABEL, 'monolith:px-1.5 monolith:text-[10px] monolith:text-mid');
  const tdNum = cn('whitespace-nowrap px-2 py-2 text-right', MONO_NUM, 'monolith:px-1.5 monolith:text-[13px]');
  // LEAVE CODE IS HELD AT THE LEFT EDGE while the rest of the row scrolls under it (the plan: "On a phone the
  // table scrolls sideways with Leave Code fixed on the left"). It needs an opaque background or the scrolled
  // figures show through it: the Card's in Classic, the bone page in Monolith (where a card is a section).
  const stickyCol = 'sticky left-0 z-10 bg-card monolith:bg-background';
  const cols = LEAVE_DETAILS_COLUMNS.map((c) => ({ ...c, label: tCol(`${c.ns}.${c.key}`) }));

  return (
    <div className="w-full min-w-0 space-y-5">
      {header}

      {/* WHO THIS IS — the session's own employment, said once, with the read-only label the plan names. */}
      <section
        aria-label={t('viewOnly')}
        data-testid="leave-details-identity"
        className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-md border border-border bg-card px-4 py-3 monolith:rounded-none monolith:border-x-0 monolith:border-b-hairline monolith:border-t-ink monolith:bg-transparent monolith:px-0"
      >
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <EmployeeCode code={me.employeeCode} className="monolith:text-[13px] monolith:text-mid" />
          <span className="text-sm font-semibold text-foreground monolith:text-[17px]">{me.name}</span>
          <span className="text-sm text-muted-foreground monolith:text-mid">· {me.company}</span>
        </span>
        <span className={cn('text-xs text-muted-foreground', MONO_LABEL, 'monolith:text-mid')} data-testid="leave-details-view-only">
          {t('viewOnly')}
        </span>
      </section>

      {/* Date + search in ONE GET form to this same address. No hidden employee field: there is no employee to
          carry — the page always shows the person who is signed in. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form method="get" action="/leave/details" className="flex flex-wrap items-end gap-3 monolith:gap-6" data-testid="leave-details-form">
          <Field label={tMe('leaveBalanceTable.asAtDate')} className="w-44">
            <Input type="date" name="asOf" defaultValue={asOf} />
          </Field>
          <Field label={t('searchLabel')} className="w-48">
            <Input name="q" defaultValue={q ?? ''} placeholder={t('searchPlaceholder')} aria-label={t('searchLabel')} />
          </Field>
          <Button type="submit" size="sm">
            {tMe('leaveBalanceTable.apply')}
          </Button>
        </form>
        {rows.length > 0 && (
          // A plain anchor, not <Link>: a file download must not be prefetched or client-routed.
          <a
            href={exportHref}
            data-testid="leave-details-export"
            className={cn(
              btnGhost,
              'min-h-9',
              'monolith:h-auto monolith:min-h-11 monolith:rounded-none monolith:border-0 monolith:border-b monolith:border-ink monolith:bg-transparent monolith:px-0.5 monolith:text-[15px] monolith:font-medium monolith:text-ink monolith:hover:border-signal-text monolith:hover:bg-transparent monolith:hover:text-signal-text monolith:active:scale-100',
            )}
          >
            <Download className="size-4 monolith:hidden" aria-hidden />
            {t('downloadExcel')}
          </a>
        )}
      </div>

      <Card className="overflow-hidden p-0">
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground monolith:px-0" data-testid="leave-details-empty">
            {q ? t('noMatch') : t('noRows')}
          </p>
        ) : (
          <div className="overflow-x-auto overscroll-x-contain" data-testid="leave-details-scroll" tabIndex={0} aria-label={t('scrollHint')}>
            <table className="w-full min-w-[1180px] border-collapse text-sm" data-testid="leave-details-table">
              <caption className="sr-only">{t('tableLabel')}</caption>
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground monolith:bg-transparent">
                <tr className="monolith:border-b monolith:border-ink">
                  {cols.map((c, i) => (
                    <th
                      key={c.id}
                      scope="col"
                      className={cn(thBase, c.align === 'right' && 'text-right', i === 0 && cn(stickyCol, 'min-w-36 bg-muted monolith:bg-background'))}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border monolith:divide-hairline">
                {rows.map((r) => (
                  <tr key={r.leaveTypeId} data-testid="leave-details-row" data-leave-type={r.leaveTypeId}>
                    <th scope="row" className={cn('px-2 py-2 text-left align-top font-normal monolith:px-1.5', stickyCol)}>
                      <span className="flex items-center gap-0.5">
                        <span className="font-semibold text-foreground monolith:font-medium">{r.code || r.leaveType}</span>
                        {r.entitlementTemplateName && (
                          <InquiryNote label={tInq('noteLabel')}>{tInq('resolvedEntitlementTable', { name: r.entitlementTemplateName })}</InquiryNote>
                        )}
                        {r.sharedBalance && otherContributors(r.sharedBalance, r.leaveType).length > 0 && (
                          <InquiryNote label={tInq('noteLabel')}>
                            {tInq('sharedBalanceWith', {
                              pool: r.sharedBalance.sourceLeaveTypeName,
                              types: otherContributors(r.sharedBalance, r.leaveType).join(', '),
                            })}
                          </InquiryNote>
                        )}
                      </span>
                      {r.code && r.code !== r.leaveType && (
                        <span className="block max-w-40 truncate text-xs text-muted-foreground monolith:text-mid" title={r.leaveType}>
                          {r.leaveType}
                        </span>
                      )}
                    </th>
                    <td className={cn('whitespace-nowrap px-2 py-2 text-muted-foreground', MONO_NUM, 'monolith:px-1.5 monolith:text-mid')}>
                      {r.entitlementYear ?? '—'}
                    </td>
                    <td className={tdNum}>{num(r.fullEntitlement)}</td>
                    <td className={tdNum}>
                      <span>{num(r.ytdEntitled)}</span>
                      {entitlementCaptionCell(r)}
                    </td>
                    <td className={tdNum}>{num(r.broughtForward)}</td>
                    <td className={tdNum}>{num(r.taken)}</td>
                    <td className={tdNum}>{num(r.pending)}</td>
                    <td className={tdNum}>{num(r.adjustment)}</td>
                    <td className={tdNum}>
                      <div>{num(r.share)}</div>
                      {poolBadgeCells(r, 'share', 'shareBadgeTip')}
                    </td>
                    <td className={tdNum}>
                      <div>{num(r.pendingShare)}</div>
                      {poolBadgeCells(r, 'pendingShare', 'pendingShareBadgeTip')}
                    </td>
                    <td className={tdNum}>{num(r.overutilized)}</td>
                    <td className={tdNum}>{num(r.forfeitedBf)}</td>
                    <td className={cn(tdNum, 'font-semibold text-foreground')}>{num(r.balance)}</td>
                    <td className={cn(tdNum, 'font-semibold text-foreground')}>{num(r.available)}</td>
                    <td className={cn('whitespace-nowrap px-2 py-2 text-muted-foreground', MONO_NUM, 'monolith:px-1.5 monolith:text-[12px] monolith:text-mid')}>{asOf}</td>
                    <td className="px-2 py-2 monolith:px-1.5">
                      {/* The SAME read-only side-sheet HR opens, fed the row's own breakdown, in the reader's voice
                          ("you"), with the leave type's Employee Leave View applied. No breakdown — none resolved,
                          or a figure on this row is hidden from employees (rows.ts `selfView`) — ⇒ an em dash. */}
                      {r.breakdown && r.available != null ? (
                        <EntitlementBreakdown
                          data={r.breakdown}
                          summary={{ available: r.available }}
                          visual={r.visual}
                          asOf={asOf}
                          action="/leave/details"
                          hiddenParams={panelHiddenParams}
                          applyEssConfig
                          triggerLabel={tInq('explainAction')}
                          hrExplanation={r.hrExplanation}
                          voice="self"
                          triggerClassName="whitespace-nowrap rounded-md border border-input bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-muted dark:hover:bg-muted/40 monolith:rounded-none monolith:border-0 monolith:border-b monolith:border-ink monolith:bg-transparent monolith:px-0.5 monolith:text-[14px] monolith:hover:border-signal-text monolith:hover:bg-transparent monolith:hover:text-signal-text"
                        />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-muted-foreground monolith:text-[14px] monolith:text-mid" data-testid="leave-details-footnote">
        {t('footnote')}
      </p>
    </div>
  );
}
