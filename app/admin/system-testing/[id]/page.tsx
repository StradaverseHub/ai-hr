import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin, requireModule } from '@/lib/authz';
import {
  CROSS_MODULE_CODE,
  OUTCOMES,
  PRIORITIES,
  RAISEABLE_OUTCOMES,
  TEST_TYPES,
  getTestCase,
  listTestableModules,
} from '@/core/system-testing';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  Card,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  btnGhost,
  btnPrimary,
  inputCls,
  pageWideCls,
} from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { raiseRunAsFeedbackAction, recordTestRunAction, updateTestCaseAction } from '../actions';

/**
 * System Testing — one case, its script, and every run of it (e6be5a3b, r330).
 *
 * THE RUN HISTORY IS THE POINT OF THE SCREEN. Every execution is kept, newest first, ordered by
 * `run_no` — not by `run_at`, which is the TRANSACTION timestamp and therefore identical for runs
 * written together (CLAUDE.md §8 forbids a position-dependent "newest"). The case's status at the top
 * is DERIVED from the first row of that list and is stored nowhere.
 *
 * "RAISE THIS AS A REQUEST" IS A BUTTON, NOT A BOX FOR A DEFECT ID. A hand-keyed id is a second source
 * of truth that can point at nothing (CLAUDE.md §1) and makes the tester re-type the steps they just
 * carried out. The button posts to a server action that calls the board's OWN writer
 * (core/feedback.ts submitFeedback — the same one app/feedback uses) with the case's title, steps,
 * Expected Behaviour and Expected Function, plus this run's actual result, and stores the id it returns
 * as a real foreign key. Once raised, the row shows a link to the item instead of the button.
 *
 * Same three gates, same order, same reasoning as the list page — see its header.
 * ONE NAMESPACE, LITERAL KEYS (test/i18n-coverage.test.ts check C).
 */
export default async function TestCaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireAdmin();
  // The module code is a LITERAL here, not the SYSTEM_TESTING_MODULE constant, and that is a pinned
  // convention: test/slice4-nav-gating.test.ts greps every sellable module's entry page for
  // `requireModule('<code>')`, so a constant would read as an unguarded page to the one guard whose
  // job is to notice that.
  const s = await requireModule('system_testing');

  const t = await getTranslations('admin.systemTesting');
  const { id } = await params;
  const sp = await searchParams;

  const found = await getTestCase(s, id);
  if (!found) notFound();
  const { testCase: c, runs } = found;
  const modules = listTestableModules(s);

  const outcomeLabel: Record<string, string> = {
    pass: t('outcomePass'),
    fail: t('outcomeFail'),
    blocked: t('outcomeBlocked'),
    partial: t('outcomePartial'),
    not_tested: t('outcomeNotTested'),
  };
  const outcomeVariant: Record<string, 'success' | 'danger' | 'warning' | 'default'> = {
    pass: 'success',
    fail: 'danger',
    blocked: 'warning',
    partial: 'warning',
    not_tested: 'default',
  };
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
  const moduleLabel = (code: string): string =>
    code === CROSS_MODULE_CODE ? t('crossModule') : (modules.find((m) => m.code === code)?.name ?? code);

  // The newest run is the FIRST row — `getTestCase` orders by run_no DESC, which is an invariant of the
  // data rather than a position in an unordered result.
  const latest = runs[0] ?? null;
  const ref = `TC-${String(c.caseNo).padStart(4, '0')}`;

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={`${ref} · ${c.title}`}
        description={t('detailDescription')}
        back={{ href: '/admin/system-testing', label: t('backToList') }}
        actions={
          <Badge variant={outcomeVariant[latest?.outcome ?? 'not_tested'] ?? 'default'}>
            {outcomeLabel[latest?.outcome ?? 'not_tested']}
          </Badge>
        }
      />

      <ErrorBanner message={sp.error} />

      <Card className="p-4">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">{t('colModule')}</dt>
            <dd>{moduleLabel(c.moduleCode)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('colType')}</dt>
            <dd>{typeLabel[c.testType] ?? c.testType}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('colPriority')}</dt>
            <dd>{priorityLabel[c.priority] ?? c.priority}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('colLastRun')}</dt>
            {/* A date from an INSTANT goes through todayInKualaLumpur (CLAUDE.md §8). */}
            <dd>{latest ? todayInKualaLumpur(latest.runAt) : t('never')}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">{t('fieldPrecondition')}</dt>
            <dd className="whitespace-pre-wrap">{c.precondition ?? t('none')}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">{t('fieldSteps')}</dt>
            <dd>
              {c.steps.length === 0 ? (
                <span className="text-muted-foreground">{t('noSteps')}</span>
              ) : (
                <ol className="list-decimal space-y-1 pl-5">
                  {c.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('fieldExpectedBehavior')}</dt>
            <dd className="whitespace-pre-wrap">{c.expectedBehavior ?? t('none')}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('fieldExpectedFunction')}</dt>
            <dd className="whitespace-pre-wrap">{c.expectedFunction ?? t('none')}</dd>
          </div>
        </dl>
      </Card>

      {/* Record a run. Separate from the edit form below on purpose: running a test is the daily action
          and editing the script is the rare one, so the two never share a submit button. */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('recordRun')} subtitle={t('recordRunNote')} />
        <form action={recordTestRunAction} className="space-y-4 p-4">
          <input type="hidden" name="caseId" value={c.id} />
          <label className="block max-w-xs">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('fieldOutcome')}</span>
            <select name="outcome" defaultValue="pass" className={inputCls} required>
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {outcomeLabel[o]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('fieldActualResult')}</span>
            <textarea name="actualResult" rows={3} className={inputCls} />
          </label>
          <button type="submit" className={btnPrimary}>
            {t('record')}
          </button>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('runHistory')} count={runs.length} subtitle={t('runHistoryNote')} />
        {runs.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t('noRuns')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {runs.map((r) => (
              <li key={r.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">#{r.runNo}</span>
                  <Badge variant={outcomeVariant[r.outcome] ?? 'default'}>{outcomeLabel[r.outcome]}</Badge>
                  <span className="text-xs text-muted-foreground">{todayInKualaLumpur(r.runAt)}</span>
                </div>
                {r.actualResult && <p className="whitespace-pre-wrap text-sm">{r.actualResult}</p>}
                {r.feedbackRequestId ? (
                  <Link href={`/feedback/${r.feedbackRequestId}`} className="text-sm text-primary hover:underline">
                    {t('viewRequest')}
                  </Link>
                ) : (
                  RAISEABLE_OUTCOMES.includes(r.outcome) && (
                    <form action={raiseRunAsFeedbackAction}>
                      <input type="hidden" name="caseId" value={c.id} />
                      <input type="hidden" name="runId" value={r.id} />
                      <button type="submit" className={btnGhost}>
                        {t('raise')}
                      </button>
                    </form>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Editing the script. Inside a <details> so it never competes with recording a run, and so the
          screen still needs no client JavaScript. The case NUMBER is not editable — runs cite it. */}
      <Card className="overflow-hidden">
        <details>
          <summary className="cursor-pointer border-b border-border px-4 py-3 text-sm font-medium">
            {t('editCase')}
          </summary>
          <form action={updateTestCaseAction} className="space-y-4 p-4">
            <input type="hidden" name="caseId" value={c.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('fieldModule')}</span>
                <select name="moduleCode" defaultValue={c.moduleCode} className={inputCls} required>
                  {modules.map((m) => (
                    <option key={m.code} value={m.code}>
                      {m.code === CROSS_MODULE_CODE ? t('crossModule') : m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('fieldTitle')}</span>
                <input name="title" defaultValue={c.title} className={inputCls} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('fieldTestType')}</span>
                <select name="testType" defaultValue={c.testType} className={inputCls}>
                  {TEST_TYPES.map((v) => (
                    <option key={v} value={v}>
                      {typeLabel[v]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('fieldPriority')}</span>
                <select name="priority" defaultValue={c.priority} className={inputCls}>
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
              <textarea name="precondition" rows={2} defaultValue={c.precondition ?? ''} className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('fieldSteps')}</span>
              <textarea name="steps" rows={6} defaultValue={c.steps.join('\n')} className={inputCls} />
              <span className="mt-1 block text-xs text-muted-foreground">{t('stepsHint')}</span>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('fieldExpectedBehavior')}
                </span>
                <textarea
                  name="expectedBehavior"
                  rows={3}
                  defaultValue={c.expectedBehavior ?? ''}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('fieldExpectedFunction')}
                </span>
                <textarea
                  name="expectedFunction"
                  rows={3}
                  defaultValue={c.expectedFunction ?? ''}
                  className={inputCls}
                />
              </label>
            </div>
            <button type="submit" className={btnPrimary}>
              {t('save')}
            </button>
          </form>
        </details>
      </Card>
    </div>
  );
}
