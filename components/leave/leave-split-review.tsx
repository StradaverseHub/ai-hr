import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { leaveSplitReview } from '@/packs/leave/service';
import { Card, EmployeeCode, SectionHeader } from '@/components/ui';
import { Pager } from '@/components/pager';
import { pageState, type PageQuery } from '@/lib/pagination';
import { formatDate } from '@/lib/utils';

export async function LeaveSplitReview({ session, query }: { session: SessionContext; query: PageQuery }) {
  const t = await getTranslations('leaveSplitReview');
  const result = await leaveSplitReview(session, query);
  return (
    <Card>
      <SectionHeader title={t('title')} subtitle={t('description')} />
      <p className="mb-4 text-sm text-muted-foreground">{t('uncertainty')}</p>
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
                  <span className="font-mono">{row.requestId.slice(0, 8)}</span>
                  <div className="mt-1 whitespace-nowrap text-xs text-muted-foreground">{formatDate(row.startDate)} – {formatDate(row.endDate)}</div>
                </td>
                <td className="p-3"><ul className="space-y-1">{row.differences.map(field => <li key={field}>{t(`fields.${field}`)}</li>)}</ul></td>
                <td className="p-3">
                  <div>{t(`charging.${row.charging}`)}</div>
                  <p className="mt-1 text-xs text-muted-foreground">{row.rootRequestId ? t('root', { reference: row.rootRequestId.slice(0, 8) }) : t('unresolved')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('candidate')}</p>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <Pager state={pageState(query, result.total, result.rows.length)} basePath="/admin/leave-config/balance-health" />
    </Card>
  );
}
