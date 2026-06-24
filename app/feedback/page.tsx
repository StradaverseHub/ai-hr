import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { listFeedback, type FeedbackRow } from '@/core/feedback';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { submitFeedbackAction } from './actions';

const CATEGORIES = ['issue', 'enhancement', 'new_function'] as const;

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
      return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await getSession();
  const t = await getTranslations('feedback');
  const { error } = await searchParams;
  const rows: FeedbackRow[] = await listFeedback(s);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ErrorBanner message={error} />

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
        <SectionHeader title={t('listTitle')} count={rows.length} />
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colTitle')}</th>
                <th className="px-4 py-2 font-medium">{t('colCategory')}</th>
                <th className="px-4 py-2 font-medium">{t('colReporter')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-muted/40">
                  <td className="px-4 py-2.5 font-medium">
                    <Link href={`/feedback/${r.id}`} className="underline-offset-2 hover:text-primary hover:underline">
                      {r.title}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{t(`category_${r.category}`)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{r.reporter}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusTone(r.status)}`}>
                      {t(`status_${r.status}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
