import { getTranslations } from 'next-intl/server';
import { requireAdmin, requireModule } from '@/lib/authz';
import {
  CROSS_MODULE_CODE,
  PRIORITIES,
  TEST_TYPES,
  listTestableModules,
} from '@/core/system-testing';
import { Card, ErrorBanner, PageHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { createTestCaseAction } from '../actions';

/**
 * System Testing — write a new case (e6be5a3b, r330).
 *
 * THE FORM CARRIES NO STATUS AND NO ACTUAL RESULT, and that absence is the design. The reporter listed
 * both as test-case fields; put here, a case could only ever remember its latest outcome and "passed in
 * September, failed in October" would be unanswerable. They belong to a RUN, recorded on the case's own
 * page, one row per execution.
 *
 * STEPS ARE A TEXTAREA, ONE PER LINE. A repeating field set would need client JavaScript to add a row,
 * and this whole feature is deliberately server-only; a numbered prefix the author types ("1. ") is
 * stripped by the action so pasting from a document does not double the numbering.
 *
 * Same three gates, same order, same reasoning as the list page — see its header.
 * ONE NAMESPACE, LITERAL KEYS (test/i18n-coverage.test.ts check C).
 */
export default async function NewTestCasePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireAdmin();
  // The module code is a LITERAL here, not the SYSTEM_TESTING_MODULE constant, and that is a pinned
  // convention: test/slice4-nav-gating.test.ts greps every sellable module's entry page for
  // `requireModule('<code>')`, so a constant would read as an unguarded page to the one guard whose
  // job is to notice that.
  const s = await requireModule('system_testing');

  const t = await getTranslations('admin.systemTesting');
  const sp = await searchParams;
  const modules = listTestableModules(s);

  const typeLabel: Record<string, string> = {
    functional: t('typeFunctional'),
    negative: t('typeNegative'),
    integration: t('typeIntegration'),
    regression: t('typeRegression'),
    ui: t('typeUi'),
  };
  const priorityLabel: Record<string, string> = {
    high: t('priorityHigh'),
    medium: t('priorityMedium'),
    low: t('priorityLow'),
  };

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('newTitle')}
        description={t('newDescription')}
        back={{ href: '/admin/system-testing', label: t('backToList') }}
      />

      <ErrorBanner message={sp.error} />

      <Card className="p-4">
        <form action={createTestCaseAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('fieldModule')}</span>
              <select name="moduleCode" defaultValue={CROSS_MODULE_CODE} className={inputCls} required>
                {modules.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.code === CROSS_MODULE_CODE ? t('crossModule') : m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('fieldTitle')}</span>
              <input name="title" className={inputCls} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('fieldTestType')}</span>
              <select name="testType" defaultValue="functional" className={inputCls}>
                {TEST_TYPES.map((v) => (
                  <option key={v} value={v}>
                    {typeLabel[v]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('fieldPriority')}</span>
              <select name="priority" defaultValue="medium" className={inputCls}>
                {PRIORITIES.map((v) => (
                  <option key={v} value={v}>
                    {priorityLabel[v]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('fieldPrecondition')}</span>
            <textarea name="precondition" rows={2} className={inputCls} />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('fieldSteps')}</span>
            <textarea name="steps" rows={6} className={inputCls} />
            <span className="mt-1 block text-xs text-muted-foreground">{t('stepsHint')}</span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('fieldExpectedBehavior')}
              </span>
              <textarea name="expectedBehavior" rows={3} className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('fieldExpectedFunction')}
              </span>
              <textarea name="expectedFunction" rows={3} className={inputCls} />
            </label>
          </div>

          <button type="submit" className={btnPrimary}>
            {t('create')}
          </button>
        </form>
      </Card>
    </div>
  );
}
