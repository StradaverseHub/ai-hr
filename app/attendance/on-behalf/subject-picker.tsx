import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Button, Card, inputCls } from '@/components/ui';
import { searchAttendanceOnBehalfSubjects, type AttendanceOnBehalfPurpose, type AttendanceOnBehalfSubject } from '@/packs/attendance/service';

/** 96a54ed2 — the first page of both on-behalf functions: search by Employee ID or name among only the people the
 *  caller may act for (one bounded set-based read per page). A plain GET form; nothing is chosen until a link. */
export async function OnBehalfSubjectPicker({ s, purpose, basePath, query, page, hrefFor }: {
  s: SessionContext; purpose: AttendanceOnBehalfPurpose; basePath: string; query: string; page: number; hrefFor: (employmentId: string) => string;
}) {
  const t = await getTranslations('attendanceOnBehalf');
  const result = await searchAttendanceOnBehalfSubjects(s, { purpose, query, page });
  const pageHref = (next: number) => `${basePath}?${new URLSearchParams({ q: query, page: String(next) }).toString()}`;
  return (
    <Card className="space-y-4 p-5">
      <form method="get" action={basePath} role="search" className="flex flex-wrap items-end gap-2">
        <label className="block min-w-64 flex-1 text-sm">{t('searchLabel')}
          <input name="q" defaultValue={query} maxLength={100} placeholder={t('searchPlaceholder')} className={`${inputCls} mt-1 w-full`} />
        </label>
        <Button type="submit" className="min-h-11">{t('search')}</Button>
      </form>
      {result.rows.length ? (
        <ul className="divide-y divide-border" aria-label={t('results')}>
          {result.rows.map((row: AttendanceOnBehalfSubject) => (
            <li key={row.employmentId} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
              <div>
                <p className="font-medium">{row.name}</p>
                <p className="text-xs text-muted-foreground">{[row.employeeCode, row.company, row.department].filter(Boolean).join(' · ')}</p>
              </div>
              <Link href={hrefFor(row.employmentId)} className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-primary">{t('choose')}</Link>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted-foreground">{t('noResults')}</p>}
      {(page > 0 || result.more) && (
        <nav className="flex gap-3 text-sm" aria-label={t('results')}>
          {page > 0 && <Link className="inline-flex min-h-11 items-center text-primary underline" href={pageHref(page - 1)}>{t('previous')}</Link>}
          {result.more && <Link className="inline-flex min-h-11 items-center text-primary underline" href={pageHref(page + 1)}>{t('next')}</Link>}
        </nav>
      )}
    </Card>
  );
}

/** The chosen person, with a way back to the search. */
export async function OnBehalfSubjectCard({ subject, changeHref }: { subject: AttendanceOnBehalfSubject; changeHref: string }) {
  const t = await getTranslations('attendanceOnBehalf');
  return (
    <Card className="flex flex-wrap items-start justify-between gap-3 p-5">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        {([['employeeName', subject.name], ['employeeId', subject.employeeCode ?? '—'], ['company', subject.company], ['department', subject.department ?? '—']] as const).map(([key, value]) => (
          <div key={key}><dt className="text-xs text-muted-foreground">{t(key)}</dt><dd className="font-medium">{value}</dd></div>
        ))}
      </dl>
      <Link href={changeHref} className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-primary">{t('changeEmployee')}</Link>
    </Card>
  );
}

export const parseOnBehalfPage = (raw: string | undefined) => { const value = Number(raw ?? 0); return Number.isInteger(value) && value >= 0 && value <= 400 ? value : 0; };
export const parseOnBehalfQuery = (raw: string | undefined) => typeof raw === 'string' ? raw.slice(0, 100) : '';
