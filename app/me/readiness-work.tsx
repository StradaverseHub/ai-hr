import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { myReadinessActions } from '@/core/readiness-actions';
import { Card, SectionHeader } from '@/components/ui';

/** Derived personal tasks, using the same action catalogue as the orchestrator. No case-table access. */
export async function MyReadinessWork({ session, employmentId }: { session: SessionContext; employmentId: string }) {
  const t = await getTranslations('controlTower.corrections');
  const gaps = await getTranslations('controlTower.readinessScreen.gap');
  let rows: Awaited<ReturnType<typeof myReadinessActions>>;
  try { rows = await myReadinessActions(session, employmentId); }
  catch { return <p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p>; }
  if (rows.length === 0) return null;
  return <Card id="record-tasks" className="overflow-hidden">
    <SectionHeader title={t('employeeTitle')} count={rows.length} />
    <p className="max-w-prose px-4 pb-3 text-sm text-muted-foreground">{t('employeeDescription')}</p>
    <ul className="divide-y divide-border">{rows.map(row => <li key={row.gap}
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
      <div><p className="text-sm font-medium">{gaps(row.gap)}</p>
        {row.type === 'review_submission' && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{t('waitingHelp')}</p>}
      </div>
      {/* A full navigation reinitializes the existing tab state for this on-page deep link. */}
      {row.type === 'submit_correction'
        ? <a href={`/me?tab=${row.tab}#section-request-${row.tab}`}
          className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-primary">{t('submit')}</a>
        : <span className="text-sm text-muted-foreground">{t(row.approver === 'group_admin' ? 'waitingGroup' : 'waiting')}</span>}
    </li>)}</ul>
    <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t('approvalNote')}</p>
  </Card>;
}
