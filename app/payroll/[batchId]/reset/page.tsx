import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { batchDetail, listBatches } from '@/core/payroll';
import { settingEnabledOrDefault } from '@/core/entitlements';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { formatMoney } from '@/lib/money';
// 9066bd6c — Back returns the Payroll Process list EXACTLY as it was left. The list hands each row link
// its own filter query as `?from=…`; whitelisted BY SHAPE at this end, never echoed raw.
import { payrollListReturnTo } from '@/lib/return-to';
import { resetAction } from '../../actions';

/**
 * 9f8cd608 — RESET PAYROLL, a screen of its own.
 *
 * WHY THIS ROUTE EXISTS, AND IT IS NOT A REDESIGN. Reset payroll was a `<form action={resetAction}>`
 * with a ConfirmSubmit dialog rendered INSIDE the Payroll Process row menu (PayrollRowActions). That
 * panel is `position: fixed` and closes itself on ANY scroll captured at the window; the dialog body is
 * portalled but its OWNER is the menu subtree, so the menu closing unmounted the dialog with it. Opening
 * the dialog emitted a scroll event on the table's `overflow-x-auto` wrapper, the menu closed on it, and
 * the dialog was created and destroyed in the same tick.
 *
 * MEASURED IN CHROMIUM AGAINST A REAL PROCESSED RUN, not argued: at 1280×720, where that wrapper is
 * genuinely scrollable, the click produced one scroll event on `DIV.overflow-x-auto` and left
 * `[role=menu]` = 0 and `[role=alertdialog]` = 0 — nothing on screen at all, which is exactly what the
 * reporter saw. At 1600 and wider, where the wrapper needs no scroll, the same click opened the dialog
 * normally. That width dependence is why it read as intermittent, and jsdom never sees it: jsdom computes
 * no layout, so nothing scrolls there and a DOM test of the old code passes.
 *
 * WHICH OF THE DIALOG'S SIDE EFFECTS EMITS THAT SCROLL WAS NOT ISOLATED, and this comment does not claim
 * it. Two candidates fit the measurement and the width dependence equally: the focus move into the
 * portalled dialog, and react-remove-scroll's body scroll-lock (`overflow: hidden` plus padding
 * compensation), which reflows the page and can clamp the wrapper's `scrollLeft`. It does not change the
 * conclusion or the fix — the menu closes on ANY scroll, from anywhere, so a dialog owned by it is
 * destroyed by its own opening either way, and the answer is not to open dialogs from inside it.
 *
 * THE ACTION IS UNCHANGED AND SO ARE ITS RULES. `resetAction` and `resetProcessedBatch` are correct —
 * risk-switch gated, `payroll.rollback` gated, processed-only, mandatory reason, loan and claim
 * side-effects reversed, audited — and this screen changes none of it. The visibility conditions stay
 * where they were, on the list's server page (`b.status === 'processed' && resetOn`).
 *
 * WHAT THE SCREEN ADDS IS THE ONE THING THE DIALOG NEVER HAD: WHICH RUN. `resetDescription` says only
 * "this payroll process". The summary strip below names the company, the period, the payroll cycle, the
 * payment date and the employee count before anything can be pressed — for an action that deletes a whole
 * run's payslips, the operator must be able to check the target rather than trust that the row they
 * clicked is the row the panel is still standing beside.
 *
 * THE REFUSALS ARE A SECOND SURFACE, NEVER THE AUTHORITY — the same division the sibling Remove screen
 * documents. Both entry points hide the link while `payroll.reset_enabled` is off, so the only way onto
 * this route is a direct visit, and answering that visit with the form would let the operator discover
 * the refusal by pressing a destructive button. The two the page can read for itself are rendered with
 * their reason. The `payroll.rollback` permission is NOT re-read here: it needs a tenant transaction and
 * there is no reader for it, so `requireAdmin` gates the door and `resetProcessedBatch` remains the
 * authority.
 *
 * AND A REFUSED SUBMIT COMES BACK HERE, on `?error=`, with the reason still in the box and `from` intact
 * — the sibling Remove screen's precedent, and the reason the form posts a `surface` flag. Every refusal
 * `resetProcessedBatch` can raise now has a translated line in `resetAction`, `SettingNotEnabledError`
 * included: the operator who presses a destructive button on payroll money must not get the service's
 * raw English back. Redirecting to `/payroll/<id>` instead would answer a refusal by moving the operator
 * to the long run screen this ticket exists to get them off, and lose the filter query on the way.
 *
 * A SCREEN, NOT A DIALOG, ALSO MEANS NO CONFIRMSUBMIT. This page IS the confirmation step: it states the
 * run, explains the consequence, takes the mandatory reason and offers Cancel / Reset Payroll. Wrapping
 * that in a second dialog would restore the ownership problem in a new place.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ResetPayrollPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ from?: string; error?: string; reason?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.batch');
  // The summary strip reuses the Payroll Process list's own column labels for the same facts, read from
  // the namespace that actually holds them — r134 shipped a screen reading a namespace that never had
  // its keys and every page rendered MISSING_MESSAGE.
  const tl = await getTranslations('payroll.list');
  // Cancel is a NEUTRAL button label, not copy that describes this action, so it comes from the shared
  // `common` namespace rather than a minted `payroll.batch.resetCancel`. That is not only tidiness: a
  // `reset*` key reading "Cancel" would collide with `removeCancel` under
  // test/payroll-remove-i18n.test.ts, whose rule is that Remove and Reset never share a string — and
  // inventing a different word for Cancel to satisfy it would be the wrong way round.
  const tc = await getTranslations('common');
  const locale = await getLocale();
  const { batchId } = await params;
  // Same shape check as the run screen: `/payroll/<segment>` hands any non-uuid straight to a uuid
  // parameter and Postgres answers with an error, i.e. a 500 where a 404 belongs.
  if (!UUID_RE.test(batchId)) notFound();
  const sp = await searchParams;
  // Whitelisted by shape, never echoed raw — a href taken out of searchParams is the open-redirect
  // shape (lib/return-to.ts). `null` when it is just the default, so nothing is carried needlessly.
  const back = payrollListReturnTo(sp.from);
  const from = back === '/payroll' ? null : back;

  const data = await batchDetail(s, batchId);
  if (!data) notFound();
  const { batch, slips } = data;

  // The setting is resolved HERE, not in a reader, and the app/ idiom is deliberate: an
  // entitlements-resolution failure must degrade to the catalog default rather than 500 a route with no
  // error boundary. The sibling Remove and run screens resolve their gates the same way.
  const resetOn = settingEnabledOrDefault(s, 'payroll.reset_enabled');

  // The run's identity, read through the SAME projection the Payroll Process list renders, so the strip
  // you check the run against cannot start disagreeing with the row you clicked. Narrowed to this run's
  // company and period — a company runs at most a handful of times in one month.
  const listed = (await listBatches(s, [batch.companyId], batch.payPeriod)).find((b) => b.id === batchId);
  const currency = listed?.currency ?? null;
  const totals = (batch.totals ?? {}) as Record<string, number>;

  const dateFmt = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  // A date-only column ('YYYY-MM-DD') is parsed as UTC and formatted as UTC — matched ends, so the day
  // printed is the day stored. Parsing it in local time is the classic off-by-one.
  const paymentDate = batch.batchDate ? dateFmt.format(new Date(`${batch.batchDate}T00:00:00Z`)) : '—';

  // THE FIVE FACTS THE PLAN PROMISED, in the order an operator checks them: whose payroll, which month,
  // which cycle, when it pays, how many people. Total net rides along because it is the size of what is
  // about to be cleared, and it is the same strip the Remove screen shows for the same run.
  const summary: { label: string; value: string }[] = [
    { label: tl('colCompany'), value: listed?.company ?? '—' },
    { label: t('summaryPeriod'), value: batch.payPeriod },
    {
      label: t('summaryCycle'),
      value: `${tl(`runType.${batch.runType}`)}${batch.remarks ? ` — ${batch.remarks}` : ''}`,
    },
    { label: t('summaryPaymentDate'), value: paymentDate },
    { label: tl('colEmployees'), value: String(slips.length) },
    { label: t('totalNet'), value: formatMoney(totals.net, currency) },
  ];

  const header = (
    <PageHeader
      back={{ href: back, label: t('resetBack') }}
      title={t('resetTitle')}
      description={`${batch.payPeriod} · ${listed?.company ?? ''}`}
    />
  );

  // Rendered rather than 404'd: the run exists and the operator can see it on the list, so "not found"
  // would be a lie and a dead end. Ordered as `resetProcessedBatch` asserts them, so the two surfaces
  // agree about which reason comes back when more than one applies.
  const refusal = !resetOn ? t('resetDisabled') : batch.status !== 'processed' ? t('resetOnlyProcessed') : null;
  if (refusal) {
    return (
      <div className={pageWideCls}>
        {header}
        <ErrorBanner message={refusal} />
      </div>
    );
  }

  return (
    <div className={pageWideCls}>
      {header}

      {/* A REFUSED SUBMIT COMES BACK HERE, not on the run screen — `resetAction` redirects to this route
          with the translated message when the form posted the `surface` flag below. Same shape as the
          sibling Remove screen: the operator stays on the screen they were reading, the summary strip
          still names the run, and the reason is still in the box. */}
      <ErrorBanner message={sp.error} />

      <Card className="px-4 py-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {summary.map((f) => (
            <div key={f.label}>
              <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
                {f.label}
              </div>
              <div className="mt-0.5 text-sm font-medium tabular-nums">{f.value}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionHeader title={t('resetTitle')} />
        <div className="px-4 pb-4">
          <p className="mb-2 text-xs text-muted-foreground">{t('resetDescription')}</p>
          <p className="mb-4 text-xs text-muted-foreground">{t('resetCollectsOutstanding')}</p>
          <form action={resetAction} className="space-y-4">
            <input type="hidden" name="batchId" value={batchId} />
            {/* WHICH SURFACE PRESSED IT. `resetAction` is posted to by this screen and by the run screen's
                own panel; this flag is how a refusal knows to come back HERE rather than dropping the
                operator onto the run screen (and losing the filter query and the reason with it). A flag
                and not a path: a destination read off a form is an untrusted value. */}
            <input type="hidden" name="surface" value="reset-screen" />
            {/* The filter selection the operator arrived under, posted so `payrollListAfterReset` can
                return them to the list as they left it. Raw path, not the encoded href — a FormData value
                must not be double-encoded. */}
            {from && <input type="hidden" name="from" value={from} />}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-foreground">{t('resetReasonLabel')}</span>
              {/* `required` is the browser's nudge, not the rule: `resetProcessedBatch` throws
                  ResetReasonRequiredError on a blank or whitespace-only reason BEFORE any write, and that
                  is what actually decides it — a single space satisfies `required` and is refused there.
                  Which is why the refused text comes back as `defaultValue`: whatever the operator wrote
                  is still in front of them when the refusal is. */}
              <textarea
                name="reason"
                rows={2}
                required
                defaultValue={sp.reason}
                placeholder={t('resetReasonPlaceholder')}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring dark:bg-input/30"
              />
            </label>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {/* Cancel returns the list AS LEFT — the same destination as Back, so leaving by either
                  route costs nothing. */}
              <Link
                href={back}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                {tc('cancel')}
              </Link>
              <Button type="submit" variant="destructive" size="sm">
                {t('resetConfirm')}
              </Button>
            </div>
          </form>
        </div>
      </Card>
    </div>
  );
}
