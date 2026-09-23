import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin, requireModule } from '@/lib/authz';
import {
  CROSS_MODULE_CODE,
  listTestCases,
  listTestableModules,
  summarizeByModule,
} from '@/core/system-testing';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  Card,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  btnPrimary,
  inputCls,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  thCls,
  theadCls,
} from '@/components/ui';
import { Badge } from '@/components/ui/badge';

/**
 * System Testing — the library (e6be5a3b, r330).
 *
 * THREE GATES, ONLY ONE OF WHICH IS A CONTROL, exactly as deec1691 set out for the Dependency Explorer:
 *   1. the sidebar row is hidden when the module is off  — cosmetic (ADR-0077 slice 4),
 *   2. `requireModule` redirects with an explanation      — a courtesy, and it FAILS OPEN by design,
 *   3. `core/system-testing.ts` throws ModuleNotEnabledError / NotAdminError — THE control.
 * Deleting 1 or 2 degrades the experience. Only 3 decides who gets an answer, which is why the test that
 * matters asserts the throw and not the missing menu row.
 *
 * `requireAdmin` FIRST so an unauthenticated or non-admin visitor is bounced before anything asks the
 * database a question, and so test/function-access.test.ts can see the guard this route is gated by — a
 * screen with no permission-matrix column is a screen Security & Permissions cannot describe.
 *
 * NO CLIENT JAVASCRIPT ANYWHERE IN THIS FEATURE. The filter is a plain GET form and every write is a
 * `<form action={serverAction}>` in a server component, so no server action is ever handed to a
 * `'use client'` island as a prop — the failure that type-checks, builds, and 500s at runtime.
 *
 * ONE NAMESPACE, LITERAL KEYS. test/i18n-coverage.test.ts check C skips any file that opens two
 * namespaces, so a second `getTranslations` here would silently remove this screen from key coverage.
 * That is also why the outcome / type / priority labels are a literal record rather than a computed
 * `t(`outcome.${x}`)`: a dynamic key is invisible to that check.
 */
export default async function SystemTestingPage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string; error?: string }>;
}) {
  await requireAdmin();
  // The module code is a LITERAL here, not the SYSTEM_TESTING_MODULE constant, and that is a pinned
  // convention: test/slice4-nav-gating.test.ts greps every sellable module's entry page for
  // `requireModule('<code>')`, so a constant would read as an unguarded page to the one guard whose
  // job is to notice that.
  const s = await requireModule('system_testing');

  const t = await getTranslations('admin.systemTesting');
  const sp = await searchParams;
  const selectedModule = sp.module?.trim() || '';

  const modules = listTestableModules(s);
  const rows = await listTestCases(s, { moduleCode: selectedModule || null });
  const progress = summarizeByModule(rows);

  // The catalogue's `name` is the PRODUCT name and is deliberately not translated (the Dependency
  // Explorer renders it the same way). `cross_module` is the exception — it is not a product, so its
  // label is a real string in all six locales.
  const moduleLabel = (code: string): string => {
    if (code === CROSS_MODULE_CODE) return t('crossModule');
    // A case may name a module the tenant has since dropped: show the code rather than pretend it is
    // gone. The row is history and stays readable (see 0482's header).
    return modules.find((m) => m.code === code)?.name ?? code;
  };

  const outcomeLabel: Record<string, string> = {
    pass: t('outcomePass'),
    fail: t('outcomeFail'),
    blocked: t('outcomeBlocked'),
    partial: t('outcomePartial'),
    not_tested: t('outcomeNotTested'),
  };
  const typeLabel: Record<string, string> = {
    functional: t('typeFunctional'),
    negative: t('typeNegative'),
    integration: t('typeIntegration'),
    regression: t('typeRegression'),
    ui: t('typeUi'),
  };
  // Colour keys off the RAW outcome, the label off the locale — the StatusBadge contract, one component
  // over. `partial` and `blocked` share amber deliberately: both mean "did not pass, and not because the
  // product is wrong about this yet".
  const outcomeVariant: Record<string, 'success' | 'danger' | 'warning' | 'default'> = {
    pass: 'success',
    fail: 'danger',
    blocked: 'warning',
    partial: 'warning',
    not_tested: 'default',
  };
  const priorityLabel: Record<string, string> = {
    high: t('priorityHigh'),
    medium: t('priorityMedium'),
    low: t('priorityLow'),
  };

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Link href="/admin/system-testing/new" className={btnPrimary}>
            {t('newCase')}
          </Link>
        }
      />

      <ErrorBanner message={sp.error} />

      <Card className="p-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="min-w-60 flex-1">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('filterModule')}</span>
            <select name="module" defaultValue={selectedModule} className={inputCls}>
              <option value="">{t('allModules')}</option>
              {modules.map((m) => (
                <option key={m.code} value={m.code}>
                  {moduleLabel(m.code)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={btnPrimary}>
            {t('apply')}
          </button>
        </form>
      </Card>

      {/* Progress at a glance — the plan's fourth bullet. "Failing" is the DERIVED latest outcome, not
          any historical one: a case that failed in September and passes today is not failing. */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('progressTitle')} count={rows.length} subtitle={t('progressNote')} />
        {progress.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {progress.map((p) => (
              <li key={p.moduleCode} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2">
                <span className="text-sm font-medium">{moduleLabel(p.moduleCode)}</span>
                <span className="text-xs text-muted-foreground">
                  {t('progressTotal', { count: p.total })} · {t('progressRun', { count: p.run })} ·{' '}
                  {t('progressFailing', { count: p.failing })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('libraryTitle')} count={rows.length} />
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <div className={tableWrapCls}>
            <table className="w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>{t('colNo')}</th>
                  <th className={thCls}>{t('colModule')}</th>
                  <th className={thCls}>{t('colTitle')}</th>
                  <th className={thCls}>{t('colType')}</th>
                  <th className={thCls}>{t('colPriority')}</th>
                  <th className={thCls}>{t('colStatus')}</th>
                  <th className={thCls}>{t('colRuns')}</th>
                  <th className={thCls}>{t('colLastRun')}</th>
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-mono text-xs">TC-{String(r.caseNo).padStart(4, '0')}</td>
                    <td className="px-3 py-2">{moduleLabel(r.moduleCode)}</td>
                    <td className="px-3 py-2">
                      <Link href={`/admin/system-testing/${r.id}`} className="text-primary hover:underline">
                        {r.title}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{typeLabel[r.testType] ?? r.testType}</td>
                    <td className="px-3 py-2">{priorityLabel[r.priority] ?? r.priority}</td>
                    <td className="px-3 py-2">
                      <Badge variant={outcomeVariant[r.latestOutcome] ?? 'default'}>
                        {outcomeLabel[r.latestOutcome] ?? r.latestOutcome}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">{r.runCount}</td>
                    {/* A date from an INSTANT goes through todayInKualaLumpur (CLAUDE.md §8): the host's
                        timezone is not the tenant's, and a run recorded at 00:30 MYT would otherwise
                        print yesterday. */}
                    <td className="px-3 py-2">{r.latestRunAt ? todayInKualaLumpur(r.latestRunAt) : t('never')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
