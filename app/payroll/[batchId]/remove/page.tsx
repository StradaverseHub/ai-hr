import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import {
  batchDetail,
  batchEditImpact,
  listBatches,
  listRemovableEmployees,
  listRemovalHistory,
  removeEligibility,
} from '@/core/payroll';
import { isModuleEnabledOrFalse, settingEnabledOrDefault } from '@/core/entitlements';
import { Card, EmployeeCode, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { formatMoney } from '@/lib/money';
import { payrollListReturnTo } from '@/lib/return-to';
import { RemoveForm, type RemoveCandidate } from './remove-form';

/**
 * 9066bd6c — REMOVE EMPLOYEE PAYROLL, a screen of its own.
 *
 * WHY THIS ROUTE EXISTS. On a processed run the only tool was Reset, which clears every employee on it.
 * Production measures the cost: the ISEDECOR August run was reset twice at 23 employees each, July once
 * at 22 and January once at 19 — 87 employee results destroyed inside eighteen minutes to correct a
 * handful of people, and the August run is still sitting in Draft. This is the per-employee half of the
 * pair whose other half (selective reprocessing, 87 completed jobs across 10 runs) already works.
 *
 * IT IS A SCREEN, NOT A PANEL ON THE RUN PAGE. That is the shape the reporter accepted in e440991b
 * after rejecting a selection buried at the bottom of the long run screen, and this is its sibling.
 *
 * THE ENGINE IS THE AUTHORITY. `removeEmployeePayroll` re-asserts the setting gate, the module gate,
 * payroll.remove.employee, processed-only, period-open, the cross-run intersection and the whole-run
 * refusal inside its own transaction. The refusals rendered below are a SECOND surface — the operator is
 * told why the door is shut instead of finding out by pressing the button.
 *
 * WHICH MEANS THE SECOND SURFACE HAS TO COVER EVERY DOOR, and the promise above is only worth what is
 * actually checked below. Every gate the engine can throw for is answered before the operator can press
 * anything: the module gate 404s (the route does not exist without it, matching the absent entry points);
 * `payroll.reset_enabled`, the permission, processed-only and period-open each render their own reason;
 * and the three that depend on what is on the form — no reason, nothing ticked, everybody ticked — are
 * stated by the form itself. A gate the engine throws for and this page does not render is the failure
 * this header exists to forbid: the operator presses a destructive button on payroll money and gets an
 * untranslated core string back.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function RemoveEmployeePayrollPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string; removed?: string; from?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.batch');
  // The summary strip reuses the Payroll Process list's own column labels for the same facts, read from
  // the namespace that actually holds them — r134 shipped a screen reading a namespace that never had
  // its keys and every page rendered MISSING_MESSAGE.
  const tl = await getTranslations('payroll.list');
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

  // The way BACK from a removal is the Reprocess screen's New / Pending group, which only exists with
  // multi-cycle on. Off ⇒ this route does not exist, matching the absence of the button that leads here
  // (and matching the module refusal the service throws).
  if (!isModuleEnabledOrFalse(s, 'multi_cycle_payroll')) notFound();

  // The setting is resolved HERE, not in the reader, and the app/ idiom is deliberate: an
  // entitlements-resolution failure must degrade to the catalog default rather than 500 a route with no
  // error boundary. The sibling run screen resolves its own gates the same way. core/ may not use that
  // form — test/module-catalog-drift.test.ts refuses it, because in a service it turns an incident into a
  // silent refusal that reads like a plan change.
  const removeOn = settingEnabledOrDefault(s, 'payroll.reset_enabled');
  const eligibility = await removeEligibility(s, { batchId, enabled: removeOn });
  if (!eligibility) notFound();

  const listed = (await listBatches(s, [batch.companyId], batch.payPeriod)).find((b) => b.id === batchId);
  const currency = listed?.currency ?? null;
  const totals = (batch.totals ?? {}) as Record<string, number>;

  const dateFmt = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  // A date-only column ('YYYY-MM-DD') is parsed as UTC and formatted as UTC — matched ends, so the day
  // printed is the day stored. Parsing it in local time is the classic off-by-one.
  const paymentDate = batch.batchDate ? dateFmt.format(new Date(`${batch.batchDate}T00:00:00Z`)) : '—';

  const summary: { label: string; value: string }[] = [
    { label: t('summaryPeriod'), value: batch.payPeriod },
    {
      label: t('summaryCycle'),
      value: `${tl(`runType.${batch.runType}`)}${batch.remarks ? ` — ${batch.remarks}` : ''}`,
    },
    { label: tl('colCompany'), value: listed?.company ?? '—' },
    { label: t('summaryPaymentDate'), value: paymentDate },
    { label: tl('colEmployees'), value: String(slips.length) },
    { label: t('totalNet'), value: formatMoney(totals.net, currency) },
  ];

  const header = (
    <PageHeader
      back={{ href: back, label: t('removeBack') }}
      title={t('removeTitle')}
      description={`${batch.payPeriod} · ${listed?.company ?? ''}`}
    />
  );

  // ── The four refusals, each with its reason on screen ───────────────────────────────────────────
  // Rendered rather than 404'd: the run exists and the operator can see it on the list, so "not found"
  // would be a lie and a dead end.
  //
  // `enabled` IS THE ONE THAT WAS MISSING, and it is the one the header's promise most depended on: both
  // entry points hide their link while `payroll.reset_enabled` is off, so the only way onto this route is
  // a direct visit — and this page used to answer that visit with the full selection form, letting the
  // operator discover the refusal by pressing the button on a destructive payroll action. Ordered FIRST
  // because that is the order `removeEmployeePayroll` asserts them in, so the two surfaces agree about
  // which reason comes back when more than one applies.
  const refusal = !eligibility.enabled
    ? t('removeDisabled')
    : !eligibility.permitted
      ? t('removeAdminOnly')
      : !eligibility.processed
        ? t('removeNotProcessed')
        : eligibility.periodClosed
          ? t('removePeriodClosed')
          : null;
  if (refusal) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        {header}
        <ErrorBanner message={refusal} />
      </div>
    );
  }

  const candidates: RemoveCandidate[] = (await listRemovableEmployees(s, { batchId })).map((r) => ({
    employmentId: r.employmentId,
    employeeCode: r.employeeCode,
    name: r.name,
    department: r.department,
    gross: r.gross,
    net: r.net,
    laterPeriods: r.laterPeriods,
  }));

  // What this run has already sent downstream. Read through the SAME derivation the unlock and the
  // Individual Transaction screens use, so a second answer can never disagree with the first. A
  // WARNING, never a gate: the operator is the one who knows whether the file will be re-sent.
  const impact = await batchEditImpact(s, { batchId });
  const history = await listRemovalHistory(s, { batchId });
  const removed = Number(sp.removed ?? 0);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {header}

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

      {/* THE RESULT, when there is one — rendered ABOVE the selection because after a submit this is
          what the operator came back for; the selection stays below so a second correction needs no
          second navigation. */}
      {removed > 0 && (
        <Card className="border-emerald-200 px-4 py-3 text-sm font-medium text-emerald-900 dark:border-emerald-500/30 dark:text-emerald-300">
          ✓ {t('removeResultTitle', { n: removed, total: slips.length })}
        </Card>
      )}

      {/* BEFORE YOU CONFIRM — what has already left the building for this month. Stated up front rather
          than inside the dialog: it may change the operator's mind about doing this at all. */}
      {(impact?.paymentDisbursed || impact?.statutoryFiled) && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <ul className="space-y-1">
            {impact.paymentDisbursed && <li>{t('removeWarnPaymentExported')}</li>}
            {impact.statutoryFiled && <li>{t('removeWarnStatutoryFiled')}</li>}
          </ul>
        </div>
      )}

      <Card>
        <SectionHeader title={t('removeTitle')} />
        <div className="px-4 pb-4">
          <p className="mb-3 text-xs text-muted-foreground">
            {t('removeHint')} {t('removeNotPersonnel')}
          </p>
          <RemoveForm batchId={batchId} employees={candidates} currency={currency} from={from} />
        </div>
      </Card>

      {/* THE RECORD. Read from `payroll_employee_result_history` (action 'remove'), which is where the
          full snapshot of each removed payslip lives — after a removal there is no other copy of it
          anywhere, so this card is the only place the figures survive. */}
      {history.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('removeHistoryTitle')} count={history.length} />
          <p className="px-4 pb-2 text-xs text-muted-foreground">{t('removeHistoryNote')}</p>
          <ul className="divide-y divide-border">
            {history.map((r) => (
              <li key={r.id} className="space-y-1 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">{r.employeeName}</span>
                  <EmployeeCode code={r.employeeCode} />
                  <span className="text-xs text-muted-foreground">
                    {r.at.toISOString().slice(0, 16).replace('T', ' ')}
                  </span>
                  {r.reason && <span className="text-xs text-muted-foreground">{r.reason}</span>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('colGross')} <span className="tabular-nums text-foreground">{formatMoney(r.gross, currency)}</span>
                  {' · '}
                  {t('colNet')} <span className="tabular-nums text-foreground">{formatMoney(r.net, currency)}</span>
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
