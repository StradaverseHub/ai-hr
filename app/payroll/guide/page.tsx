import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { payrollReadiness, type PayrollReadiness, type ReadinessCheck } from '@/core/payroll-readiness';
import { statutoryPackStale } from '@/lib/statutory-readiness';
import { Card, PageHeader } from '@/components/ui';
import { PayrollTabs } from '@/components/payroll-tabs';

/**
 * Payroll Workflow Guide (feedback 5db3ae48) — a GUIDED, clearly-sequenced end-to-end view over the
 * already-shipped payroll module. It signposts the reporter's Phase 1→6 flow and surfaces config-level
 * readiness (core/payroll-readiness.ts, Phase A) at a glance. Every action LINKS OUT to the existing
 * screens — this page duplicates none of them. Product decision 1 (RECOMMENDED): "Processing" is a
 * transient label, NOT a persisted 4th status; the lifecycle stays Draft → Processed → Closed.
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
  payrollSchedule: 'PayrollSchedule',
  payrollPolicy: 'PayrollPolicy',
  transactions: 'Transactions',
};
const STATUS_CAP: Record<ReadinessCheck['status'], string> = { ok: 'Ok', warning: 'Warning', blocker: 'Blocker' };

export default async function PayrollGuidePage() {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.guide');
  const companies = (await listCompanies(s)).filter((c) => scopeIds.includes(c.id));
  // Statutory staleness is a server-only disk read, computed once (the MY pack is tenant-global) and
  // threaded into each company's readiness so the core aggregator stays filesystem-free.
  const stale = await statutoryPackStale(s);
  const readiness: { company: { id: string; name: string }; report: PayrollReadiness }[] = await Promise.all(
    companies.map(async (c) => ({
      company: { id: c.id, name: c.name },
      report: await payrollReadiness(s, { companyId: c.id, statutoryStale: stale }),
    })),
  );

  // The six phases, each linking OUT to the existing screens (never duplicating them). Phase 3's body is
  // the readiness panel below; Phase 4 carries the "Processing is transient" note (product decision 1).
  const phases: { n: number; titleKey: string; descKey: string; noteKey?: string; links: { labelKey: string; href: string }[] }[] = [
    {
      n: 1,
      titleKey: 'phase1Title',
      descKey: 'phase1Desc',
      links: [
        { labelKey: 'linkPeople', href: '/people' },
        { labelKey: 'linkPayItems', href: '/admin/pay-components' },
        { labelKey: 'linkStatutory', href: '/payroll/configuration' },
        { labelKey: 'linkCycles', href: '/admin/payroll-cycle' },
        { labelKey: 'linkSchedule', href: '/admin/payroll-config' },
        { labelKey: 'linkPolicies', href: '/admin/payroll-policy' },
      ],
    },
    { n: 2, titleKey: 'phase2Title', descKey: 'phase2Desc', links: [{ labelKey: 'linkTransactions', href: '/payroll/transactions' }] },
    { n: 3, titleKey: 'phase3Title', descKey: 'phase3Desc', links: [] },
    { n: 4, titleKey: 'phase4Title', descKey: 'phase4Desc', noteKey: 'phase4Processing', links: [{ labelKey: 'linkProcess', href: '/payroll/process' }] },
    { n: 5, titleKey: 'phase5Title', descKey: 'phase5Desc', links: [{ labelKey: 'linkTransactionView', href: '/payroll/transaction-view' }] },
    { n: 6, titleKey: 'phase6Title', descKey: 'phase6Desc', links: [{ labelKey: 'linkBatches', href: '/payroll' }] },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <PayrollTabs active="guide" />

      <ol className="space-y-3">
        {phases.map((phase) => (
          <li key={phase.n}>
            <Card className="overflow-hidden">
              <div className="flex items-start gap-3 px-4 py-4">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
                  {phase.n}
                </span>
                <div className="min-w-0 flex-1 space-y-2">
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t('phaseLabel', { n: phase.n })}
                    </div>
                    <h3 className="text-sm font-semibold text-foreground">{t(phase.titleKey)}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground">{t(phase.descKey)}</p>
                  {phase.noteKey && (
                    <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      {t(phase.noteKey)}
                    </p>
                  )}
                  {phase.n === 6 && (
                    <p className="text-xs font-medium tabular-nums text-muted-foreground">{t('lifecycle')}</p>
                  )}
                  {phase.links.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-0.5">
                      {phase.links.map((l) => (
                        <Link
                          key={l.href + l.labelKey}
                          href={l.href}
                          className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                        >
                          {t(l.labelKey)} →
                        </Link>
                      ))}
                    </div>
                  )}

                  {/* Phase 3 body — the config-level readiness panel, per scoped company. */}
                  {phase.n === 3 && (
                    <div className="space-y-4 pt-1">
                      {readiness.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
                      {readiness.map(({ company, report }) => (
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
                                ? t('readinessBlocked', { n: report.blockers })
                                : report.warnings > 0
                                  ? t('readinessWarnings', { n: report.warnings })
                                  : t('readinessReady')}
                            </span>
                          </div>
                          <ul className="divide-y divide-border">
                            {report.checks.map((check) => {
                              const msgKey = `check${CHECK_CAP[check.key]}${STATUS_CAP[check.status]}`;
                              return (
                                <li key={check.key} className="flex items-start justify-between gap-3 px-3 py-2.5">
                                  <div className="min-w-0 flex-1 space-y-0.5">
                                    <div className="flex items-center gap-2">
                                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_PILL[check.status]}`}>
                                        {t(`status${STATUS_CAP[check.status]}`)}
                                      </span>
                                      <span className="text-sm font-medium text-foreground">
                                        {t(`check${CHECK_CAP[check.key]}Title`)}
                                      </span>
                                    </div>
                                    <p className="text-xs text-muted-foreground">{t(msgKey, check.detail)}</p>
                                  </div>
                                  <Link
                                    href={check.href}
                                    className="shrink-0 text-xs font-medium text-primary hover:underline"
                                  >
                                    {t('fix')} →
                                  </Link>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}
