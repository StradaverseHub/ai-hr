import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { FEEDBACK_LIST_LIMIT, feedbackStatusCounts, listFeedback, type FeedbackRow } from '@/core/feedback';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { DEFAULT_FEEDBACK_SORT, parseFeedbackSort } from '@/lib/feedback-sort';
import type { FeedbackCategory, FeedbackStatus } from '@/db/schema';
import { submitFeedbackAction } from './actions';
import { BulkTable } from './bulk-table';

const CATEGORIES = ['issue', 'enhancement', 'new_function'] as const;
// Dashboard chip order; statuses with a zero count are hidden. Includes every feedbackStatusEnum value
// so the chips sum to the "All" total and any ?status= filter is honoured (e.g. ?status=rejected).
// `blocked` sits next to approved deliberately: it IS approved work, just not startable yet. Placing it
// after `approved` keeps the board reading in lifecycle order rather than alphabetically.
const BOARD_STATUSES = ['open', 'planned', 'contested', 'approved', 'blocked', 'building', 'done', 'deployed', 'rejected', 'cancelled'] as const;

export function statusTone(status: string): string {
  switch (status) {
    case 'open':
      return 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400';
    case 'planned':
      return 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400';
    case 'contested':
      return 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400';
    case 'approved':
    case 'building':
      return 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400';
    // Amber, not indigo: blocked reads as "needs you", which is the same signal `open` carries, rather
    // than as a shade of in-progress work that needs nothing from the reporter.
    case 'blocked':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300';
    case 'done':
    case 'deployed':
      return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400';
    case 'rejected':
      return 'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

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
  }>;
}) {
  const s = await getSession();
  const t = await getTranslations('feedback');
  const { error, toast, toastKey, count, action, skipped, status, sort } = await searchParams;
  const activeStatus = (BOARD_STATUSES as readonly string[]).includes(status ?? '')
    ? (status as FeedbackStatus)
    : undefined;
  // e14334ef — the board's order rides in the address so the heading link can flip it and the link is
  // shareable. Anything unrecognised falls back to newest-touched-first rather than erroring.
  const activeSort = parseFeedbackSort(sort);
  // The filter and the order COMPOSE. Clicking a status chip must not silently throw away an order the
  // reporter chose — they pick "oldest first" precisely to chase stale items, and doing that within one
  // status is the obvious next move. The default drops out of the address entirely, the same rule
  // ClientPager applies to page 0, so the bare board stays a bare link.
  const boardHref = (st?: FeedbackStatus) => {
    const p = new URLSearchParams();
    if (st) p.set('status', st);
    if (activeSort !== DEFAULT_FEEDBACK_SORT) p.set('sort', activeSort);
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
    feedbackStatusCounts(s),
    listFeedback(s, { status: activeStatus, sort: activeSort }),
  ]);
  const countOf = (st: string) => counts.find((c) => c.status === st)?.count ?? 0;
  const total = counts.reduce((a, c) => a + c.count, 0);

  // e14334ef — SAY when the cut bites. listFeedback returns at most FEEDBACK_LIST_LIMIT rows while the
  // chips above come from feedbackStatusCounts, which is uncapped: on production that paints "All 517"
  // over a list of 200. Harmless while the order was fixed; not harmless now that the heading flips it,
  // because oldest-first does not reverse the list you were reading, it swaps in a largely disjoint set
  // (the 200 stalest instead of the 200 freshest). ClientPager's own truncation notice cannot cover this
  // — its ceiling is 2000 and its total is derived from the array it was handed, which is the cut one.
  const scopedTotal = activeStatus ? countOf(activeStatus) : total;
  const truncated = rows.length >= FEEDBACK_LIST_LIMIT && scopedTotal > rows.length;

  const chipBase = 'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition';

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ErrorBanner message={error} />
      {toastMessage && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {toastMessage}
        </div>
      )}

      {/* Dashboard — status board doubling as a filter (no DB query needed to see the queue). */}
      <Card className="p-4">
        <SectionHeader title={t('boardTitle')} />
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
              {t(`status_${st}`)} <span className="font-semibold">{countOf(st)}</span>
            </Link>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <SectionHeader title={t('logTitle')} />
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
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={activeStatus ? t(`status_${activeStatus}`) : t('listTitle')} count={rows.length} />
        {truncated && (
          <p className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            {t('listTruncated', { shown: rows.length, total: scopedTotal })}
          </p>
        )}
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <BulkTable rows={rows as FeedbackRow[]} status={activeStatus} sort={activeSort} />
        )}
      </Card>
    </div>
  );
}
