import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { feedbackStatusCounts, listFeedback, type FeedbackRow } from '@/core/feedback';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import type { FeedbackCategory, FeedbackStatus } from '@/db/schema';
import { submitFeedbackAction } from './actions';
import { BulkTable } from './bulk-table';

const CATEGORIES = ['issue', 'enhancement', 'new_function'] as const;
// Dashboard chip order; statuses with a zero count are hidden. Includes every feedbackStatusEnum value
// so the chips sum to the "All" total and any ?status= filter is honoured (e.g. ?status=rejected).
const BOARD_STATUSES = ['open', 'planned', 'contested', 'approved', 'building', 'done', 'deployed', 'rejected', 'cancelled'] as const;

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
  }>;
}) {
  const s = await getSession();
  const t = await getTranslations('feedback');
  const { error, toast, toastKey, count, action, skipped, status } = await searchParams;
  const activeStatus = (BOARD_STATUSES as readonly string[]).includes(status ?? '')
    ? (status as FeedbackStatus)
    : undefined;

  // Structured (localized) toast — e.g. the bulk-review result, rendered through t() with an ICU plural
  // and a per-action verb key. Falls back to the literal ?toast= used by the single-item actions.
  const VERB_KEYS: Record<string, string> = {
    approve: 'bulkVerb_approve',
    cancel: 'bulkVerb_cancel',
    contest: 'bulkVerb_contest',
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
    listFeedback(s, { status: activeStatus }),
  ]);
  const countOf = (st: string) => counts.find((c) => c.status === st)?.count ?? 0;
  const total = counts.reduce((a, c) => a + c.count, 0);

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
            href="/feedback"
            className={`${chipBase} ${!activeStatus ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
          >
            {t('boardAll')} <span className="font-semibold">{total}</span>
          </Link>
          {BOARD_STATUSES.filter((st) => countOf(st) > 0).map((st) => (
            <Link
              key={st}
              href={`/feedback?status=${st}`}
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
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <BulkTable rows={rows as FeedbackRow[]} />
        )}
      </Card>
    </div>
  );
}
