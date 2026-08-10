import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui';
import { listBatches } from '@/core/payroll';
import { scopedAdmin } from '@/lib/scope';

/**
 * "Which draft run are you adjusting?" — the one chooser shared by the two Transactions screens that
 * 7076f8af relocated (the draft adjustment panel and the pay-component CSV import).
 *
 * Both of those functions have always been keyed to a BATCH: the seven bridges write payroll_input rows on
 * a specific draft, and `importBatchComponents` refuses a non-draft batch outright. On the run screen the
 * batch was implicit in the address. Under Transactions it is not, so it has to be asked for — and asked
 * for the same way twice, or the two screens would drift into two different ideas of what a draft is.
 *
 * DRAFT ONLY, and that is not a nicety: every action behind both screens refuses a processed or closed run
 * in the service. Offering one would be offering a button that can only fail. In practice this list is very
 * short — a fresh run creates and calculates in one pass, so a draft exists mainly after a Reset.
 *
 * RESOLUTION IS THE SECURITY BOUNDARY, not the list. `scopedAdmin` bounds the read to this administrator's
 * active company scope and RLS bounds it to the tenant, and the caller re-resolves the chosen id through
 * this same function before rendering anything for it — so an id typed into the address bar for another
 * tenant's run resolves to nothing, exactly as if it did not exist.
 */
export async function draftRunsInScope() {
  const { s, scopeIds } = await scopedAdmin();
  const batches = await listBatches(s, scopeIds);
  return batches.filter((b) => b.status === 'draft');
}

export type DraftRunRow = Awaited<ReturnType<typeof draftRunsInScope>>[number];

/** The chosen draft, or null when the id is absent, unknown, or outside this admin's scope. */
export function resolveDraftRun(drafts: readonly DraftRunRow[], batchId: string | undefined): DraftRunRow | null {
  if (!batchId) return null;
  return drafts.find((b) => b.id === batchId) ?? null;
}

/** The run chooser itself: one row per draft, or an honest empty state when there are none. */
export async function DraftRunPicker({
  drafts,
  basePath,
  selectedId,
}: {
  drafts: readonly DraftRunRow[];
  /** The screen the chooser links back into, carrying `?batchId=`. */
  basePath: string;
  selectedId?: string;
}) {
  const t = await getTranslations('payroll.transactions');

  if (drafts.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-base font-semibold">{t('draftPicker.noneTitle')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('draftPicker.noneBody')}</p>
        <Link href="/payroll" className="mt-3 inline-flex text-sm font-medium text-primary hover:underline">
          {t('draftPicker.openRuns')}
        </Link>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-4 py-3 text-sm font-medium">{t('draftPicker.title')}</div>
      <ul className="divide-y divide-border">
        {drafts.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
            <span className="font-medium text-foreground">{b.company}</span>
            <span className="tabular-nums text-muted-foreground">{b.payPeriod}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{b.runType}</span>
            {b.id === selectedId ? (
              <span className="ml-auto text-xs font-medium text-muted-foreground">{t('draftPicker.selected')}</span>
            ) : (
              <Link
                href={`${basePath}?batchId=${b.id}`}
                className="ml-auto text-sm font-medium text-primary hover:underline"
              >
                {t('draftPicker.choose')}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
