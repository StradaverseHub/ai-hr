import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { getSession } from '@/lib/session';
import { FEEDBACK_LIST_LIMIT, feedbackBoardCounts, listFeedback, type FeedbackRow } from '@/core/feedback';
import { feedbackBoardOpen } from '@/app/feedback/board';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { DEFAULT_FEEDBACK_SORT, parseFeedbackSort } from '@/lib/feedback-sort';
import { submitFeedbackAction } from './actions';
import { BulkTable } from './bulk-table';
import { FeedbackKanban } from './kanban';
import { FEEDBACK_BOARD_STATUSES, feedbackStatusTone, type FeedbackBoardStatus } from '@/lib/feedback-release';
import { flipFeedbackSort } from '@/lib/feedback-sort';

const CATEGORIES = ['issue', 'enhancement', 'new_function'] as const;
// Dashboard chip order; statuses with a zero count are hidden. Includes every feedbackStatusEnum value
// so the chips sum to the "All" total and any ?status= filter is honoured (e.g. ?status=rejected).
// `blocked` sits next to approved deliberately: it IS approved work, just not startable yet. Placing it
// after `approved` keeps the board reading in lifecycle order rather than alphabetically.
const BOARD_STATUSES = FEEDBACK_BOARD_STATUSES;
const statusTone = feedbackStatusTone;

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    toast?: string;
    toastKey?: string;
    count?: string;
    action?: string;
    skipped?: string;
    status?: string;
    sort?: string;
    view?: string;
  }>;
}) {
  const s = await getSession();
  if (!feedbackBoardOpen(s)) notFound();
  const t = await getTranslations('feedback');
  const { error, toast, toastKey, count, action, skipped, status, sort, view } = await searchParams;
  const activeStatus = (BOARD_STATUSES as readonly string[]).includes(status ?? '')
    ? (status as FeedbackBoardStatus)
    : undefined;
  // e14334ef — the board's order rides in the address so the heading link can flip it and the link is
  // shareable. Anything unrecognised falls back to newest-touched-first rather than erroring.
  const activeSort = parseFeedbackSort(sort);
  // The filter and the order COMPOSE. Clicking a status chip must not silently throw away an order the
  // reporter chose — they pick "oldest first" precisely to chase stale items, and doing that within one
  // status is the obvious next move. The default drops out of the address entirely, the same rule
  // ClientPager applies to page 0, so the bare board stays a bare link.
  const activeView = view === 'kanban' ? 'kanban' : 'list';
  const boardHref = (st?: FeedbackBoardStatus, v = activeView, order = activeSort) => {
    const p = new URLSearchParams();
    if (st) p.set('status', st);
    if (order !== DEFAULT_FEEDBACK_SORT) p.set('sort', order);
    if (v === 'kanban') p.set('view', v);
    const qs = p.toString();
    return qs ? `/feedback?${qs}` : '/feedback';
  };

  // Structured (localized) toast — e.g. the bulk-review result, rendered through t() with an ICU plural
  // and a per-action verb key. Falls back to the literal ?toast= used by the single-item actions.
  const VERB_KEYS: Record<string, string> = {
    approve: 'bulkVerb_approve',
    cancel: 'bulkVerb_cancel',
    contest: 'bulkVerb_contest',
    restore: 'bulkVerb_restore',
  };
  const toastMessage =
    toastKey === 'bulkResult' && action && action in VERB_KEYS
      ? t('bulkResult', {
          count: Number(count ?? 0),
          action: t(VERB_KEYS[action]),
          skipped: Number(skipped ?? 0),
        })
      : (toast ?? null);

  const [counts, rows] = await Promise.all([
    feedbackBoardCounts(s),
    listFeedback(s, { status: activeStatus, sort: activeSort }),
  ]);
  const countOf = (st: string) => counts.find((c) => c.status === st)?.count ?? 0;
  const total = counts.reduce((a, c) => a + c.count, 0);

  // e14334ef — SAY when the cut bites. listFeedback returns at most FEEDBACK_LIST_LIMIT rows while the
  // chips above come from feedbackBoardCounts, which is uncapped: on production that paints "All 517"
  // over a list of 200. Harmless while the order was fixed; not harmless now that the heading flips it,
  // because oldest-first does not reverse the list you were reading, it swaps in a largely disjoint set
  // (the 200 stalest instead of the 200 freshest). ClientPager's own truncation notice cannot cover this
  // — its ceiling is 2000 and its total is derived from the array it was handed, which is the cut one.
  const scopedTotal = activeStatus ? countOf(activeStatus) : total;
  const truncated = rows.length >= FEEDBACK_LIST_LIMIT && scopedTotal > rows.length;

  const chipBase = 'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition';

  return (
    <div className={`mx-auto w-full min-w-0 space-y-6 ${activeView === 'kanban' ? 'max-w-none' : 'max-w-5xl'}`}>
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ErrorBanner message={error} />
      {toastMessage && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {toastMessage}
        </div>
      )}

      {/* Dashboard — status board doubling as a filter (no DB query needed to see the queue). */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeader title={t('boardTitle')} />
          <nav aria-label={t('viewLabel')} className="inline-flex gap-1 rounded-lg bg-muted p-1">
            {(['list', 'kanban'] as const).map(v => (
              <Link key={v} href={boardHref(activeStatus, v)} aria-current={activeView === v ? 'page' : undefined}
                className={`rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary ${activeView === v ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                {t(v === 'list' ? 'viewList' : 'viewKanban')}
              </Link>
            ))}
          </nav>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href={boardHref()}
            className={`${chipBase} ${!activeStatus ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
          >
            {t('boardAll')} <span className="font-semibold">{total}</span>
          </Link>
          {BOARD_STATUSES.filter((st) => countOf(st) > 0).map((st) => (
            <Link
              key={st}
              href={boardHref(st)}
              className={`${chipBase} ${statusTone(st)} ${activeStatus === st ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : ''}`}
            >
              {t(st === 'deployed' ? 'releaseUnverified' : `status_${st}`)} <span className="font-semibold">{countOf(st)}</span>
            </Link>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <details>
        <summary className="cursor-pointer rounded text-sm font-semibold focus-visible:outline-2 focus-visible:outline-primary">{t('logTitle')}</summary>
        <p className="px-1 pt-2 text-xs text-muted-foreground">{t('logIntro')}</p>
        <form action={submitFeedbackAction} className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label={t('category')}>
            <select name="category" defaultValue="issue" className={inputCls} required>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`category_${c}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('titleLabel')}>
            <input name="title" required className={inputCls} placeholder={t('titlePlaceholder')} />
          </Field>
          <div className="md:col-span-2">
            <Field label={t('description')}>
              <textarea name="description" required rows={3} className={inputCls} placeholder={t('descriptionPlaceholder')} />
            </Field>
          </div>
          <Field label={t('expectedBehavior')}>
            <textarea name="expectedBehavior" rows={2} className={inputCls} placeholder={t('expectedBehaviorPlaceholder')} />
          </Field>
          <Field label={t('expectedFunction')}>
            <textarea name="expectedFunction" rows={2} className={inputCls} placeholder={t('expectedFunctionPlaceholder')} />
          </Field>
          <div className="md:col-span-2">
            <Field label={t('attachments')}>
              <input type="file" name="attachments" multiple className={inputCls} accept="image/*,.pdf,.doc,.docx,.txt" />
            </Field>
            <p className="mt-1 px-1 text-xs text-muted-foreground">{t('attachmentsHint')}</p>
          </div>
          <div className="md:col-span-2">
            <Button type="submit" size="sm">
              {t('submit')}
            </Button>
          </div>
        </form>
        </details>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 p-4">
          <SectionHeader title={activeStatus ? t(activeStatus === 'deployed' ? 'releaseUnverified' : `status_${activeStatus}`) : t('listTitle')} count={rows.length} />
          <Link href={boardHref(activeStatus, activeView, flipFeedbackSort(activeSort))} className="rounded text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-primary">
            {t(activeSort === 'updated_asc' ? 'sortNewestFirst' : 'sortOldestFirst')}
          </Link>
        </div>
        {activeView === 'kanban' && <p className="px-4 pb-4 text-xs text-muted-foreground">{t('kanbanHint')}</p>}
        {truncated && (
          <p className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            {t('listTruncated', { shown: rows.length, total: scopedTotal })}
          </p>
        )}
        {activeView === 'kanban' ? (
          <FeedbackKanban rows={rows} status={activeStatus} counts={counts} sort={activeSort} />
        ) : rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <BulkTable rows={rows as FeedbackRow[]} status={activeStatus} sort={activeSort} />
        )}
      </Card>
    </div>
  );
}
