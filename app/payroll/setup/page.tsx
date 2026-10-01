import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import {
  payrollCycleReadiness,
  payrollReadiness,
  type PayrollReadiness,
  type ReadinessCheck,
} from '@/core/payroll-readiness';
import { statutoryPackStale } from '@/lib/statutory-readiness';
import { Card, PageHeader, pageWideCls } from '@/components/ui';

/**
 * Feature 2.0 — Payroll Configuration landing (information architecture over existing config surfaces).
 * Re-surfaces the already-wired payroll-config sub-modules as a card grid under the Payroll module,
 * modelled on the approved Feature 1.2 Transactions hub. Like that precedent we render ONLY the wired
 * destinations — no "coming soon" placeholders.
 *
 * No schema, no service, no DomainEvent (deliberate, not an omission): this page performs no writes.
 * Config *changes* are already audited by the destination services (core/payroll-config.ts,
 * core/pay-components.ts), so the audit / "only active settings" guarantees live there, not here.
 *
 * RBAC: gated by scopedAdmin (was requireAdmin — the readiness panel below is per company, so the page
 * needs the admin's company scope, and /payroll/setup is already registered under the scopedAdmin payroll
 * screen in lib/permissions.ts). Every linked destination is admin-reachable.
 *
 * Currency Rate is intentionally omitted (no FX-rate table/service exists yet — backlog item with its
 * own ADR + schema + service) rather than shown as a dead tile, per the no-placeholder precedent.
 *
 * r79a (4fb8b75a step 1) — THREE cards became ONE. `policies`, `period` and `submission` all resolved to
 * /admin/payroll-config: it was never three screens, it was one screen with three doors, each named after
 * a different section of the same form. That is why the settings area looked duplicated. The surviving
 * card is named for what the screen is (Payroll Schedule) and its description lists everything the screen
 * actually holds, so nothing is lost by removing the other two doors. No data moved, no stored setting
 * moved, and no payroll behaves differently.
 *
 * r79a (707b3851) — the readiness panel above the grid. Two companies name a default payroll cycle while
 * holding no cycles at all, so a run is refused with INVALID_CYCLE and nothing said so until someone
 * tried. This says it where payroll is set up, and lists every company in scope that cannot run.
 *
 * efe1d230 — THE FULL EIGHT-CHECK PER-COMPANY REPORT MOVED HERE from the retired Workflow Guide. It is
 * the only surface that NAMES the blocking reason per company (master data, pay items, statutory config,
 * cycles, the stored-default-cycle check, schedule, policy, pay modes, transactions), so deleting the
 * guide page without rehousing it would have lost the answer to "why will this company not open a run".
 *
 * IT IS BEHIND `?readiness=full`, NOT ALWAYS ON, and that is load-bearing rather than shy. The cheap
 * two-query `payrollCycleReadiness` above exists precisely BECAUSE this page must stay fast
 * (core/payroll-readiness.ts says so at the top of that function); `payrollReadiness` is eight checks
 * PER COMPANY. Rendering it unconditionally would have moved the guide's cost onto the landing page the
 * cheap version was written to protect. A plain GET link keeps the whole screen a server component — no
 * client state, no RSC boundary — and the report is one click away on the page you already go to when
 * something is wrong, which is what the approved plan promised.
 *
 * The copy stays under the `payroll.guide` namespace, unmoved. That namespace is now the payroll
 * SEQUENCE + READINESS vocabulary rather than one page's strings (packs/payroll/phases.ts reads
 * `payroll.guide.phase{n}Title` for the wizard rail), it is already translated in all six catalogs, and
 * re-keying forty strings across six files to rename a namespace would risk a MISSING_MESSAGE for no
 * user-visible gain.
 */

const STATUS_PILL: Record<ReadinessCheck['status'], string> = {
  ok: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  warning: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  blocker: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
};

// key → PascalCase segment used to build the localisation key (checkMasterDataOk / …Warning / …Blocker).
const CHECK_CAP: Record<ReadinessCheck['key'], string> = {
  masterData: 'MasterData',
  payrollItems: 'PayrollItems',
  statutoryConfig: 'StatutoryConfig',
  payrollCycle: 'PayrollCycle',
  // 707b3851 — the company's stored default cycle name actually resolving to an active cycle. Distinct
  // from payrollCycle above (which asks whether the catalog has anything in it at all).
  defaultCycle: 'DefaultCycle',
  payrollSchedule: 'PayrollSchedule',
  payrollPolicy: 'PayrollPolicy',
  payModes: 'PayModes', // ADR-0078 — custom_period pay-mode blocker (names the affected employees)
  transactions: 'Transactions',
};
const STATUS_CAP: Record<ReadinessCheck['status'], string> = { ok: 'Ok', warning: 'Warning', blocker: 'Blocker' };

export default async function PayrollSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ readiness?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.setup');
  // The rehoused report's copy — see the namespace note in the header.
  const tg = await getTranslations('payroll.guide');
  const showFullReadiness = (await searchParams).readiness === 'full';

  const companies = (await listCompanies(s)).filter((c) => scopeIds.includes(c.id));
  const readiness = await payrollCycleReadiness(
    s,
    companies.map((c) => c.id),
  );
  // One line per gap, per company. Two distinct failures, both reported: (a) no usable cycle at all, so a
  // run is refused outright; (b) a stored default that names a cycle which does not exist, so the field
  // reads as configured when it is not. A company can have either, both, or neither.
  // These four keys are built dynamically, so test/i18n-coverage.test.ts Check C cannot resolve them —
  // they are listed here so the set stays greppable, and were verified by hand in all six locales.
  const problems = readiness
    .map((r) => {
      const issues: { key: 'readinessNoCycles' | 'readinessNoRegularCycle' | 'readinessStaleDefault' | 'readinessNoDefault'; name: string }[] = [];
      if (r.activeCycles === 0) issues.push({ key: 'readinessNoCycles', name: '' });
      else if (r.activeRegularCycles === 0) issues.push({ key: 'readinessNoRegularCycle', name: '' });
      if (!r.defaultCycleName) issues.push({ key: 'readinessNoDefault', name: '' });
      else if (!r.defaultCycleResolves) issues.push({ key: 'readinessStaleDefault', name: r.defaultCycleName });
      return { ...r, issues };
    })
    .filter((r) => r.issues.length > 0)
    // Companies that cannot run at all first — that is the urgent half.
    .sort((a, b) => Number(a.canRunRegularPayroll) - Number(b.canRunRegularPayroll));

  // efe1d230 — the eight-check report, computed ONLY when it is asked for. Statutory staleness is a
  // server-only disk read, done once (the MY pack is tenant-global) and threaded into each company's
  // readiness so the core aggregator stays filesystem-free — exactly as the guide page did it.
  const fullReadiness: { company: { id: string; name: string }; report: PayrollReadiness }[] =
    showFullReadiness
      ? await (async () => {
          const stale = await statutoryPackStale(s);
          return Promise.all(
            companies.map(async (c) => ({
              company: { id: c.id, name: c.name },
              report: await payrollReadiness(s, { companyId: c.id, statutoryStale: stale }),
            })),
          );
        })()
      : [];

  const cards = [
    { key: 'cycles', href: '/admin/payroll-cycle' },
    // The one surviving door onto /admin/payroll-config. The former `period` ("Payroll Period Template")
    // and `submission` ("Payment Submission Control") cards opened this identical screen.
    { key: 'schedule', href: '/admin/payroll-config' },
    { key: 'items', href: '/admin/pay-components' },
    { key: 'payslipInformation', href: '/payroll/payslip-information' },
    { key: 'payrollPolicies', href: '/admin/payroll-policy' },
    // 'ea' card removed (Pay Items redesign, 4994a48f): the EA-line control left the Pay Items screen,
    // so the card led to a screen with no EA control. Its i18n keys are retained for the future
    // dedicated statutory-mapping module; stored eaFormLine data and the EA report are untouched.
    { key: 'statutory', href: '/payroll/configuration' },
  ] as const;

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('title')} description={t('subtitle')} />

      {problems.length > 0 && (
        <Card className="border-amber-300 dark:border-amber-500/40">
          <div className="space-y-3 p-4">
            <div>
              <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">{t('readinessTitle')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('readinessSubtitle')}</p>
            </div>
            <ul className="space-y-2">
              {problems.map((r) => (
                <li key={r.companyId} className="rounded-lg border border-border px-3 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-sm font-medium text-foreground">
                      {r.companyName}
                      {!r.canRunRegularPayroll && (
                        <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-500/10 dark:text-red-400">
                          {t('readinessCannotRun')}
                        </span>
                      )}
                    </span>
                    <Link
                      href={r.activeCycles === 0 ? '/admin/payroll-cycle' : '/admin/organization'}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      {t('readinessFix')} →
                    </Link>
                  </div>
                  <ul className="mt-0.5 space-y-0.5">
                    {r.issues.map((issue) => (
                      <li key={issue.key} className="text-xs text-amber-700 dark:text-amber-400">
                        {t(issue.key, { name: issue.name })}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {t('readinessNoAutoCreate')}{' '}
              {/* efe1d230 — the full report is no longer a page you navigate away to; it opens below,
                  on this screen. Same link text, same promise, one fewer menu row. */}
              <Link href="/payroll/setup?readiness=full" className="font-medium text-primary hover:underline">
                {t('readinessFullReport')}
              </Link>
            </p>
          </div>
        </Card>
      )}

      {/* efe1d230 — the rehoused per-company report. Reachable whether or not the cheap CYCLE check found
          anything: a company with a perfectly good cycle catalog can still be blocked on master data, pay
          items or pay modes, and this is the only screen that names which. */}
      {!showFullReadiness ? (
        <p className="text-xs text-muted-foreground">
          <Link href="/payroll/setup?readiness=full" className="font-medium text-primary hover:underline">
            {t('readinessFullReport')} →
          </Link>
        </p>
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{tg('title')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{tg('subtitle')}</p>
            </div>
            <Link href="/payroll/setup" className="text-xs font-medium text-primary hover:underline">
              {t('readinessHideReport')}
            </Link>
          </div>
          <div className="space-y-4 p-4">
            {fullReadiness.length === 0 && <p className="text-sm text-muted-foreground">{tg('empty')}</p>}
            {fullReadiness.map(({ company, report }) => (
              <div key={company.id} className="rounded-lg border border-border">
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <span className="text-sm font-medium text-foreground">{company.name}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      report.blockers > 0
                        ? STATUS_PILL.blocker
                        : report.warnings > 0
                          ? STATUS_PILL.warning
                          : STATUS_PILL.ok
                    }`}
                  >
                    {report.blockers > 0
                      ? tg('readinessBlocked', { n: report.blockers })
                      : report.warnings > 0
                        ? tg('readinessWarnings', { n: report.warnings })
                        : tg('readinessReady')}
                  </span>
                </div>
                <ul className="divide-y divide-border">
                  {report.checks.map((check) => {
                    const msgKey = `check${CHECK_CAP[check.key]}${STATUS_CAP[check.status]}`;
                    return (
                      <li key={check.key} className="flex items-start justify-between gap-3 px-3 py-2.5">
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_PILL[check.status]}`}
                            >
                              {tg(`status${STATUS_CAP[check.status]}`)}
                            </span>
                            <span className="text-sm font-medium text-foreground">
                              {tg(`check${CHECK_CAP[check.key]}Title`)}
                            </span>
                          </div>
                          {/* ADR-0078 — `names` rides only on the payModes blocker; the join is a
                              harmless extra ICU arg for every other message. */}
                          <p className="text-xs text-muted-foreground">
                            {tg(msgKey, { ...check.detail, names: (check.names ?? []).join(', ') })}
                          </p>
                        </div>
                        <Link href={check.href} className="shrink-0 text-xs font-medium text-primary hover:underline">
                          {tg('fix')} →
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <Card key={`${c.key}-${c.href}`} className="flex flex-col p-5">
            <h2 className="text-base font-semibold">{t(`${c.key}.title`)}</h2>
            <p className="mt-1 flex-1 text-sm text-muted-foreground">{t(`${c.key}.desc`)}</p>
            <Link
              href={c.href}
              className="mt-4 inline-flex w-fit items-center rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {t(`${c.key}.cta`)}
            </Link>
          </Card>
        ))}
      </div>
    </div>
  );
}
