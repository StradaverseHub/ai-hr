import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies, listEmployees, replacementLeaveSummary } from '@/core/read';
import { Card, ErrorBanner, Field, PageHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { runToilExpiryAction, closeReplacementLeaveYearAction } from '../actions';
// 3fb1a611 — the two HR-minted credit actions live on this route, not in app/admin/actions.ts. See the
// header of that file for why (both of them move money and the reasoning belongs beside them).
import { grantToilCreditAction, reverseToilCreditAction } from './actions';
import { listHrMintedToilCredits } from '@/core/toil';
import { isModuleEnabledOrFalse } from '@/core/entitlements';

export default async function ToilPolicyPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    processed?: string;
    converted?: string;
    lapsed?: string;
    skipped?: string;
    closed?: string;
    closedAlready?: string;
    closedProcessed?: string;
    closedConverted?: string;
    closedLapsed?: string;
    closedCarried?: string;
    // 3fb1a611 — the manual grant / reversal outcome, including the OVERTIME the action moved.
    granted?: string;
    otDate?: string;
    otMinutes?: string;
    reversed?: string;
    otBackDate?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.toilPolicy');
  const { error, processed, converted, lapsed, skipped, closed, closedAlready, closedProcessed, closedConverted, closedLapsed, closedCarried, granted, otDate, otMinutes, reversed, otBackDate } =
    await searchParams;
  const moduleOn = isModuleEnabledOrFalse(s, 'toil');

  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  // RL Control Engine (0113): the active-vs-expired ledger split across everyone in scope.
  //
  // READ UNCONDITIONALLY as of ADR-0077 slice 3. It used to be `moduleOn ? … : null`, which is the UI
  // half of the defect that ungating `runToilExpiry` / `closeReplacementLeaveYear` (core/toil.ts) was
  // meant to close: a tenant whose `toil` entitlement lapses (trial end, downgrade, non-payment) still
  // owes its employees the days they already banked — for a First-Schedule-eligible employee that debt
  // is STATUTORY and must convert to pay, never lapse — and hiding the ledger meant an admin could not
  // even SEE the outstanding liability, let alone settle it. Ungating the services alone changed
  // nothing in production, because this page is their ONLY caller (there is no cron; see
  // app/admin/actions.ts runToilExpiryAction). The read itself is ungated (core/read.ts) and costs one
  // query; with no accruals it returns zeros.
  const summary = await replacementLeaveSummary(s, visible.map((c) => c.id));
  // 3fb1a611 — the manual-grant surface. Both reads are scoped to the SAME company list the ledger above
  // uses, so an administrator can only grant to, and reverse for, employees they administer; RLS enforces
  // it again underneath (the grant's own `assertCanDecide`-equivalent is `app.can_admin_employment` on the
  // register write, and the reversal's is the RESTRICTIVE delete policy from migration 0314).
  const visibleIds = visible.map((c) => c.id);
  const grantable = await listEmployees(s, visibleIds);
  const hrMinted = await listHrMintedToilCredits(s, visibleIds);
  // Is there an already-incurred obligation still on the books? `activeAccruals` counts accruals with
  // unspent days remaining, which is exactly what the two sweeps below would settle.
  const outstanding = summary.activeAccruals > 0;
  // WHAT THE ENTITLEMENT STILL GOVERNS is NEW accrual (the policy editor above, and the roster's
  // "bank in lieu" affordance). WHAT IT MUST NOT GOVERN is winding down what was already banked.
  const showSettlement = moduleOn || outstanding;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={error} />

      {processed !== undefined && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {Number(processed) === 0
            ? t('processedNone')
            : t('processedBanner', { processed: Number(processed), converted: Number(converted ?? 0), lapsed: Number(lapsed ?? 0) })}
        </div>
      )}

      {/* THE PARTIAL SWEEP, SAID OUT LOUD (review r3). `runToilExpiry` reads only accruals this caller
          can settle (core/toil.ts SETTLEABLE_BY_CALLER) so a dual-scoped operator no longer rolls the
          whole transaction back — but that turns "another company's statutory convert-to-pay is
          overdue and you may not settle it" into the same green banner as "nothing was due". AMBER,
          not emerald: an unsettled statutory obligation is not a success. */}
      {Number(skipped ?? 0) > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {t('processedSkipped', { skipped: Number(skipped) })}
        </div>
      )}

      {closed !== undefined && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {Number(closedAlready) === 1
            ? t('closeAlready')
            : t('closeBanner', {
                processed: Number(closedProcessed ?? 0),
                converted: Number(closedConverted ?? 0),
                lapsed: Number(closedLapsed ?? 0),
                carried: Number(closedCarried ?? 0),
              })}
        </div>
      )}

      {/* 3fb1a611 — THE GRANT BANNER SAYS WHAT IT DID TO THE MONEY. A credit banked against a worked day
          takes that day out of the overtime prefill (core/payroll.ts EXCLUDE_TOIL_BANKED_DAYS, applied in
          BOTH reads of attendance.ot_minutes and NOT behind the module flag), so an administrator who
          granted a credit for a day the employee had overtime on has just stopped that overtime being
          paid. Saying so here is the difference between a feature and a surprise at month end. */}
      {granted !== undefined && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {t('grantBanner', { days: granted })}
          {otDate && (
            <span className="mt-1 block font-medium">
              {t('grantOtWarning', { date: otDate, hours: (Number(otMinutes ?? 0) / 60).toFixed(2) })}
            </span>
          )}
        </div>
      )}
      {reversed !== undefined && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {t('reverseBanner', { days: reversed })}
          {otBackDate && <span className="mt-1 block font-medium">{t('reverseOtNote', { date: otBackDate })}</span>}
        </div>
      )}

      {!moduleOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {outstanding ? t('moduleOffWindDown', { accruals: summary.activeAccruals }) : t('moduleOff')}
        </div>
      )}

      {/*
        THE POLICY EDITOR MOVED (296fc027) — to HR Admin › Leave Config › Replacement Leave, which is now
        the single place replacement leave is CONFIGURED. What is left on this page is the running balance
        LEDGER and the two settlement sweeps, and that division is the wind-down argument made physical
        rather than a tidying-up of tabs.

        WHY THE SWEEPS DID NOT GO WITH IT, which is the thing to preserve if this page is ever edited
        again. `runToilExpiry` and `closeReplacementLeaveYear` are deliberately NOT entitlement-gated
        (core/toil.ts states this at length): a tenant whose `toil` module lapses — trial end, downgrade,
        non-payment — still owes its employees the days they already banked, and for a First-Schedule
        eligible employee that debt is STATUTORY and must convert to pay, never lapse. The configuration
        page is read-only without the module. Moving the settle-and-expire buttons behind it would have
        re-gated, through the UI, the exact obligation that ungating those services exists to protect —
        and this page is their ONLY caller (there is no cron). Configuration and settlement are gated
        differently on purpose, so they live on different screens.

        The read-only-not-hidden reasoning that used to sit here went WITH the form it was about; it is
        reproduced in full at the top of app/admin/leave-config/company-rules/page.tsx.
      */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-foreground">{t('configMovedTitle')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('configMovedHint')}{' '}
          {/* a6fe37fc ROUND 5 (cutover) — repointed at Company rules, which absorbed this configuration.
              1cf5b37c made this link ONE-DIRECTIONAL on purpose: an admin who lands on the legacy page
              still has to be told where configuration went, which is the half that stops a move reading
              as a deletion. Left at the old address it would still arrive, through the stub — but a link
              whose whole job is to say "it is over there" should name where it actually is. */}
          <Link href="/admin/leave-config/company-rules" className="font-medium text-primary hover:underline">
            {t('configMovedLink')}
          </Link>
        </p>
      </Card>

      {visible.length === 0 && <p className="text-sm text-muted-foreground">{t('noCompanies')}</p>}

      {showSettlement && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('ledgerTitle')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('ledgerHint')}</p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('ledgerActive')} value={summary.active} />
            <Stat label={t('ledgerTaken')} value={summary.taken} />
            <Stat label={t('ledgerExpired')} value={summary.expired} />
            <Stat label={t('ledgerConverted')} value={summary.convertedToPay} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {summary.soonestExpiry ? t('ledgerSoonest', { date: summary.soonestExpiry }) : t('ledgerNoneActive')}
          </p>
        </Card>
      )}

      {showSettlement && visible.length > 0 && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">{t('processTitle')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('processHint')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <form action={runToilExpiryAction}>
                <button className={btnPrimary}>{t('processButton')}</button>
              </form>
              <form action={closeReplacementLeaveYearAction}>
                <button className={btnPrimary}>{t('closeYearButton')}</button>
              </form>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('closeYearHint')}</p>
        </Card>
      )}

      {/* ── 3fb1a611 · GRANT A CREDIT BY HAND ─────────────────────────────────────────────────────────
          The reporter's case: the work happened, the employee never submitted a claim, and there is no
          approval for a credit to hang off. Before this the only manual route was a leave_ledger
          adjustment, which produces a GHOST CREDIT — a balance with no register row, so no expiry, no
          FIFO position and no worked day. This writes BOTH rows through the same executor every earned
          credit uses. GATED on the module, unlike the two settlement sweeps above: granting is accrual
          (a NEW obligation), not the settlement of one already incurred. */}
      {moduleOn && visible.length > 0 && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('grantTitle')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('grantHint')}</p>
          <form action={grantToilCreditAction} className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t('grantEmployee')}>
                <select name="employmentId" required className={inputCls} defaultValue="">
                  <option value="" disabled>
                    {t('grantEmployeePlaceholder')}
                  </option>
                  {grantable.map((e) => (
                    <option key={e.employmentId} value={e.employmentId}>
                      {e.employeeCode ? `${e.employeeCode} — ${e.name}` : e.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('grantWorkedDate')}>
                <input type="date" name="workedDate" required className={inputCls} />
              </Field>
              <Field label={t('grantDays')}>
                <input type="number" name="days" step="0.5" min="0.5" max="366" required className={inputCls} />
              </Field>
              <Field label={t('grantReason')}>
                <input type="text" name="reason" required maxLength={500} className={inputCls} />
              </Field>
            </div>
            {/* The statutory floor, on the face of the form. An employee at or below the overtime wage
                ceiling is entitled to CASH; banking time instead is lawful only with the company override
                AND that employee's own agreement. The service REFUSES without this for such an employee,
                so the box is the record of consent rather than a formality — and it is ignored entirely
                for anyone above the ceiling, who needs no such substitution agreement. */}
            <label className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-500/25 dark:bg-amber-500/5">
              <input type="checkbox" name="firstScheduleConsent" value="1" className="mt-0.5 h-4 w-4 accent-amber-600" />
              <span>
                <span className="text-sm font-medium text-foreground">{t('grantConsentLabel')}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t('grantConsentHint')}</span>
              </span>
            </label>
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {t('grantOtHint')}
            </p>
            <button className={btnPrimary}>{t('grantButton')}</button>
          </form>
        </Card>
      )}

      {/* ── 3fb1a611 · UNDO ONE. A power that both creates a credit and stops a worked day being payable
          has to be reversible, or an administrator cannot safely use it. Only HAND-MINTED credits appear
          here: an EARNED one is settled through the expiry run, never removed. */}
      {hrMinted.length > 0 && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('mintedTitle')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('mintedHint')}</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 text-left font-medium">{t('mintedEmployee')}</th>
                  <th scope="col" className="py-1.5 pr-3 text-left font-medium">{t('mintedWorkedDate')}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('mintedDays')}</th>
                  <th scope="col" className="py-1.5 pr-3 text-left font-medium">{t('mintedExpires')}</th>
                  <th scope="col" className="py-1.5 pr-3 text-left font-medium">{t('mintedReason')}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('mintedAction')}</th>
                </tr>
              </thead>
              <tbody>
                {hrMinted.map((r) => (
                  <tr key={r.id} className="border-b border-border/60 last:border-0">
                    <td className="py-1.5 pr-3">{r.employeeName}</td>
                    <td className="whitespace-nowrap py-1.5 pr-3">{r.workedDate}</td>
                    <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">
                      {r.daysCredited.toFixed(2)}
                    </td>
                    <td className="whitespace-nowrap py-1.5 pr-3">{r.expiresOn}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{r.note ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-right">
                      {r.reversible ? (
                        <form action={reverseToilCreditAction} className="inline-flex items-center gap-2">
                          <input type="hidden" name="accrualId" value={r.id} />
                          <input
                            type="text"
                            name="reason"
                            required
                            maxLength={500}
                            placeholder={t('mintedReversePlaceholder')}
                            className={`${inputCls} h-8 w-44`}
                          />
                          <button className={btnGhost}>{t('mintedReverse')}</button>
                        </form>
                      ) : (
                        // Not a disabled button: the reason a credit cannot be undone is the useful part.
                        <span className="text-xs text-muted-foreground">{t('mintedNotReversible')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="px-1 text-xs text-muted-foreground">{t('footnote')}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}
