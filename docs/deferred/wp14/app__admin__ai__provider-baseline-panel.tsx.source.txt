import { getFormatter, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { getAiProviderChangeView, type BaselineStatus, type BaselineTargetView } from '@/core/ai-provider-baseline';
import { PROVIDER_BASELINE_REQUEST_LIMIT } from '@/lib/ai/provider-baseline-suites';
import { Badge, Card, SectionHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { acceptProviderBaselineAction, runProviderBaselineAction, setActiveProviderAction } from './actions';

/** WP14 / R19 — AI management › Provider: every provider or model change waiting for its baseline holdout suites,
 * their per-suite result, acceptance of a failure with a reason, and activation once passed or accepted. Group
 * administrators only (the provider page already redirects everyone else). */
const tone: Record<BaselineStatus, 'default' | 'info' | 'success' | 'danger' | 'warning'> = {
  pending: 'default', evaluating: 'info', passed: 'success', failed: 'danger', accepted: 'warning',
};

export async function AiProviderBaselinePanel({ session }: { session: SessionContext }) {
  const t = await getTranslations('admin.ai.baseline');
  const f = await getFormatter();
  const view = await getAiProviderChangeView(session);
  const when = (iso: string) => f.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' });
  const row = (target: BaselineTargetView) => {
    const run = target.run, id = `ai-baseline-${target.key.replace(/[^a-z0-9_-]/gi, '-')}`;
    const mayContinue = run?.state === 'evaluating' && run.ownRun;
    const mayAccept = run !== null && (run.state === 'failed' || run.state === 'evaluating');
    return <li key={target.key} id={id} className="scroll-mt-4 space-y-3 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{t(`kinds.${target.kind}`)}</p>
          <p className="break-words text-sm font-medium">{t('target', { provider: target.label, model: target.model })}</p>
        </div>
        <Badge variant={tone[target.status]}>{t(`status.${target.status}`)}</Badge>
      </div>
      {run && <ul className="space-y-1 text-xs">{run.suites.map(suite => <li key={suite.id} className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t(`suites.${suite.id}`)}</span>
        <span className="text-muted-foreground">{t('suiteProgress', { passed: suite.passed, total: suite.total, failed: suite.failed })}</span>
        <Badge variant={tone[suite.state]}>{t(`status.${suite.state}`)}</Badge>
      </li>)}</ul>}
      {run && <p className="text-xs text-muted-foreground">{t('lastUpdated', { date: when(run.updatedAt) })}</p>}
      {run?.state === 'accepted' && run.acceptedReason && <p className="text-sm">{t('acceptedReason', { date: when(run.acceptedAt ?? run.updatedAt), reason: run.acceptedReason })}</p>}
      {run?.state === 'evaluating' && !run.ownRun && <p className="text-xs text-muted-foreground">{t('otherAdminRun')}</p>}
      {!target.activatable && <form action={runProviderBaselineAction} className="space-y-2">
        <input type="hidden" name="kind" value={target.kind} />
        <input type="hidden" name="provider" value={target.provider} />
        <input type="hidden" name="targetId" value={target.targetId ?? ''} />
        <input type="hidden" name="targetVersion" value={target.targetVersion ?? ''} />
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="consent" value="true" required className="size-4" />{t('consent')}</label>
        <button type="submit" className={btnGhost}>{t(mayContinue ? 'continue' : 'run')}</button>
      </form>}
      {mayAccept && <form action={acceptProviderBaselineAction} className="space-y-2 rounded-md border border-border p-3">
        <input type="hidden" name="runId" value={run!.id} />
        <p className="text-sm font-medium">{t('acceptTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('acceptHelp')}</p>
        <label className="block text-xs">{t('acceptReason')}
          <textarea name="reason" required minLength={10} maxLength={1000} rows={2} className={`${inputCls} mt-1`} />
        </label>
        <button type="submit" className={btnGhost}>{t('acceptButton')}</button>
      </form>}
      {target.activatable && target.kind === 'pending' && <form action={setActiveProviderAction}>
        <input type="hidden" name="provider" value={target.provider} />
        <input type="hidden" name="pendingVersion" value={target.targetVersion ?? ''} />
        <button type="submit" className={btnPrimary}>{t('activate')}</button>
      </form>}
      {target.kind === 'openrouter_candidate' && <p className="text-xs text-muted-foreground">{t('openRouterActivate')}</p>}
    </li>;
  };
  return <Card id="ai-provider-changes" className="scroll-mt-4 p-5">
    <SectionHeader title={t('title')} />
    <p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('intro')}</p>
    {view.active && !view.active.evaluated && <p role="status" className="mt-3 text-sm font-medium text-amber-700 dark:text-amber-300">
      {t('activeNotEvaluated', { provider: view.active.label, model: view.active.model })}
    </p>}
    {view.platform && <p role="status" className={`mt-3 text-sm ${view.platform.evaluated ? '' : 'font-medium text-amber-700 dark:text-amber-300'}`}>
      {t(view.platform.evaluated ? 'platformEvaluated' : 'platformNotEvaluated', { provider: view.platform.label, model: view.platform.model })}
    </p>}
    <p className="mt-2 text-xs text-muted-foreground">{t('batchNote', { count: PROVIDER_BASELINE_REQUEST_LIMIT })}</p>
    {view.targets.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">{t('none')}</p>
      : <ul className="mt-2 divide-y divide-border">{view.targets.map(row)}</ul>}
  </Card>;
}
