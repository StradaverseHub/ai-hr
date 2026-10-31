'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, Card, PageHeader, inputCls, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { pmBands } from '@/packs/performance/onehr/model';
import { departmentSpread, formatOverallScore, formatSpreadPct, type DepartmentCycle, type DepartmentOrderedRow } from '@/packs/performance/onehr/department-view-model';

/**
 * WP-C (APR-022) — the HOD department view. Read-only: no form, no button and no server action. The only
 * links switch between the cycles the viewer heads someone in. Shape follows the source page: header, the
 * final rating spread, the finalized count, a search box, then Name · Department · Job title · Relationship ·
 * Overall rating in forest order (the service has already ordered the rows).
 */
export function DepartmentViewScreen({ cycles, cycle, rows }: { cycles: DepartmentCycle[]; cycle: DepartmentCycle; rows: DepartmentOrderedRow[] }) {
  const t = useTranslations('onehr.department');
  const [query, setQuery] = useState('');
  const spread = departmentSpread(rows);
  const cells = (r: DepartmentOrderedRow) => {
    const overall = r.finalized && r.overallBand && r.overallScore != null
      ? t('overall', { score: formatOverallScore(r.overallScore, r.mechanism), band: t(`bands.${r.overallBand}`) })
      : null;
    return { name: r.fullName, department: r.department || '-', jobTitle: r.jobTitle || '-', relationship: t(r.direct ? 'relationship.direct' : 'relationship.indirect'), overall };
  };
  const needle = query.trim().toLowerCase();
  // The source filters on the whole row's text, every cell included.
  const shown = rows.map((r) => ({ r, c: cells(r) })).filter(({ c }) => !needle || [c.name, c.department, c.jobTitle, c.relationship, c.overall ?? t('pending')].join(' ').toLowerCase().includes(needle));
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description', { cycle: cycle.name })} />
      {cycles.length > 1 && (
        <nav aria-label={t('cycle')} className="flex flex-wrap gap-2">
          {cycles.map((c) => (
            <Link key={c.id} href={`/performance/department?cycle=${encodeURIComponent(c.id)}`} aria-current={c.id === cycle.id ? 'page' : undefined}
              className={`inline-flex min-h-11 items-center rounded-md border px-3 text-sm ${c.id === cycle.id ? 'border-primary bg-primary/5 font-medium text-primary' : 'border-border hover:bg-muted'}`}>
              {c.name}
            </Link>
          ))}
        </nav>
      )}
      <Card className="space-y-3 p-5">
        <section aria-labelledby="department-spread" className="space-y-2">
          <h2 id="department-spread" className="font-semibold">{t('spreadTitle')}</h2>
          <ul className="space-y-2">
            {pmBands.map((b) => (
              <li key={b} data-band={b} className="grid grid-cols-[2.5rem_minmax(0,1fr)_6rem] items-center gap-3 text-sm">
                <span translate="no" className="font-medium">{b}</span>
                <span className="block h-2 overflow-hidden rounded bg-muted" aria-hidden="true"><span className="block h-full bg-primary" style={{ width: `${spread.pct[b]}%` }} /></span>
                <span className="text-right tabular-nums">{t('spreadRow', { count: spread.counts[b], pct: formatSpreadPct(spread.pct[b]) })}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t('finalizedCount', { finalized: spread.finalized, total: spread.total })}</p>
        </section>
      </Card>
      <label className="flex max-w-md flex-col gap-1 text-sm font-medium">
        {t('search')}
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchPlaceholder')} autoComplete="off" className={inputCls} />
      </label>
      <div className={tableWrapCls}>
        <table className="w-full text-sm">
          <caption className="sr-only">{t('title')}</caption>
          <thead className={theadCls}>
            <tr>{(['name', 'department', 'jobTitle', 'relationship', 'overall'] as const).map((k) => <th key={k} scope="col" className={thCls}>{t(`columns.${k}`)}</th>)}</tr>
          </thead>
          <tbody className={tbodyCls}>
            {shown.map(({ r, c }) => (
              <tr key={r.employmentId}>
                <td className="px-3 py-2 font-medium">{c.name}</td>
                <td className="px-3 py-2">{c.department}</td>
                <td className="px-3 py-2">{c.jobTitle}</td>
                <td className="px-3 py-2"><Badge variant={r.direct ? 'accent' : 'default'}>{c.relationship}</Badge></td>
                <td className="px-3 py-2">{c.overall ? <Badge variant="info" data-band={r.overallBand ?? undefined}>{c.overall}</Badge> : <span className="text-xs text-muted-foreground">{t('pending')}</span>}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={5} className="px-3 py-4 text-muted-foreground">{t('noMatch')}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
