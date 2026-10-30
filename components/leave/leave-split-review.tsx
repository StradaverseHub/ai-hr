import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { leaveSplitReview } from '@/packs/leave/service';
import { Card, EmployeeCode, SectionHeader } from '@/components/ui';
import { Pager } from '@/components/pager';
import { pageState, type PageQuery } from '@/lib/pagination';

export async function LeaveSplitReview({ session, query, companyIds }: { session: SessionContext; query: PageQuery; companyIds: readonly string[] }) {
  const [t, locale] = await Promise.all([getTranslations('leaveSplitReview'), getLocale()]);
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' });
  const date = (value: string) => format.format(new Date(`${value}T00:00:00Z`));
  const recordHref = (employmentId: string, requestId: string) => `/leave/employee-records?${new URLSearchParams({ emp: employmentId, q: requestId.slice(0, 8) })}`;
  const result = await leaveSplitReview(session, { ...query, companyIds });
  return (
    <Card>
      <SectionHeader title={t('title')} subtitle={t('description')} />
      <p className="mb-4 text-sm text-muted-foreground">{t('uncertainty')}</p>
      <Pager state={pageState(query, result.total, result.rows.length)} basePath="/admin/leave-config/balance-health" />
      {result.rows.length === 0 ? <p className="py-4 text-sm text-muted-foreground">{t('empty')}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b text-muted-foreground">
              <th scope="col" className="p-3">{t('employee')}</th>
              <th scope="col" className="p-3">{t('leave')}</th>
              <th scope="col" className="p-3">{t('differences')}</th>
              <th scope="col" className="p-3">{t('evidence')}</th>
            </tr></thead>
            <tbody>{result.rows.map(row => (
              <tr key={row.requestId} className="border-b align-top last:border-0">
                <td className="p-3"><div>{row.employee}</div><EmployeeCode code={row.employeeNo} /></td>
                <td className="p-3">
                  <Link href={recordHref(row.employmentId, row.requestId)} className="font-mono underline underline-offset-2">{row.requestId.slice(0, 8)}</Link>
                  <div className="mt-1 whitespace-nowrap text-xs text-muted-foreground">{date(row.startDate)} – {date(row.endDate)}</div>
                </td>
                <td className="p-3"><ul className="space-y-1">{row.differences.map(field => <li key={field}>{t(`fields.${field}`)}</li>)}</ul></td>
                <td className="p-3">
                  <div>{t(`charging.${row.charging}`)}</div>
                  <p className="mt-1 text-xs text-muted-foreground">{row.rootRequestId ? <Link href={recordHref(row.employmentId, row.rootRequestId)} className="underline underline-offset-2">{t('root', { reference: row.rootReference ?? row.rootRequestId.slice(0, 8) })}</Link> : t('unresolved')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('candidate')}</p>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
