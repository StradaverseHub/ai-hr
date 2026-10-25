import Link from 'next/link';
import type { ReactNode } from 'react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui';
import { OwnLeavePreparedReview } from '@/lib/assistant-actions/own-leave-contract';

/** SOURCE-ONLY representative display; not mounted on an application route. The caller must obtain
 * its public card from a freshly authorized store read. This component has no submission handler,
 * form action, model tool, hidden business arguments, local persistence or private-content props. */
export async function OwnLeaveReviewCard({ review: value }: { review: unknown }) {
  const t = await getTranslations('ownLeaveReview');
  const f = await getFormatter();
  const parsed = OwnLeavePreparedReview.safeParse(value);
  if (!parsed.success) return <p role="alert" className="text-sm text-destructive">{t('unavailable')}</p>;
  const r = parsed.data;
  const titleId = `own-leave-review-${r.actionId}`;
  const n = (number: number) => f.number(number, { maximumFractionDigits: 20 });
  const field = (label: string, content: ReactNode) => <div className="min-w-0">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="mt-1 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{content}</dd>
  </div>;
  return <section aria-labelledby={titleId} className="min-w-0">
    <Card className="space-y-4 p-5">
      <header className="space-y-1">
        <h2 id={titleId} className="text-base font-semibold">{t('title')}</h2>
        <p className="text-xs text-muted-foreground">{t('estimateNote')}</p>
      </header>
      <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        {field(t('company'), r.companyName)}
        {r.employeeCode !== null && field(t('employeeCode'), r.employeeCode)}
        {field(t('leaveType'), r.leaveTypeName)}
        {field(t('date'), f.dateTime(new Date(`${r.date}T12:00:00Z`), { dateStyle: 'full', timeZone: 'Asia/Kuala_Lumpur' }))}
        {field(t('duration'), t('fullDay'))}
        {field(t('deduction'), n(r.deductionDays))}
        {r.availableBalance !== null && field(t('available'), n(r.availableBalance))}
        {r.estimatedAvailableAfter !== null && field(t('after'), n(r.estimatedAvailableAfter))}
        {field(t('approval'), t('approvalUnknown'))}
      </dl>
      {(r.humanText.reason !== undefined || r.humanText.employeeRemark !== undefined) && <dl className="space-y-3 border-t border-border pt-4">
        {r.humanText.reason !== undefined && field(t('reason'), r.humanText.reason)}
        {r.humanText.employeeRemark !== undefined && field(t('remark'), r.humanText.employeeRemark)}
      </dl>}
      {r.holidayWarnings.map(warning => <p key={`${warning.country}:${warning.state ?? ''}:${warning.year}`}
        className="rounded-md border border-amber-600/30 px-3 py-2 text-sm">
        {t('holidayWarning', { place: [warning.country, warning.state].filter(Boolean).join(' · '),
          year: warning.year, loaded: warning.loaded, required: warning.required })}
      </p>)}
      <footer className="space-y-3 border-t border-border pt-4">
        <p className="text-xs text-muted-foreground">{t('expires', { when: f.dateTime(new Date(r.expiresAt),
          { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }) })}</p>
        <Link href={`/leave?apply=1&start=${encodeURIComponent(r.date)}`}
          className="inline-flex min-h-11 max-w-full items-center rounded-md border border-input px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t('openForm')}
        </Link>
        <p className="max-w-prose text-xs text-muted-foreground">{t('formNote')}</p>
      </footer>
    </Card>
  </section>;
}
