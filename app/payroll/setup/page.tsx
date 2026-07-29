import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { payrollCycleReadiness } from '@/core/payroll-readiness';
import { Card, PageHeader } from '@/components/ui';

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
 */
export default async function PayrollSetupPage() {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.setup');

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

  const cards = [
    { key: 'cycles', href: '/admin/payroll-cycle' },
    // The one surviving door onto /admin/payroll-config. The former `period` ("Payroll Period Template")
    // and `submission` ("Payment Submission Control") cards opened this identical screen.
    { key: 'schedule', href: '/admin/payroll-config' },
    { key: 'items', href: '/admin/pay-components' },
    { key: 'payrollPolicies', href: '/admin/payroll-policy' },
    // 'ea' card removed (Pay Items redesign, 4994a48f): the EA-line control left the Pay Items screen,
    // so the card led to a screen with no EA control. Its i18n keys are retained for the future
    // dedicated statutory-mapping module; stored eaFormLine data and the EA report are untouched.
    { key: 'statutory', href: '/payroll/configuration' },
  ] as const;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
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
              <Link href="/payroll/guide" className="font-medium text-primary hover:underline">
                {t('readinessFullReport')}
              </Link>
            </p>
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
