import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import {
  headcountSummary,
  masterDataExport,
  newHires,
  terminations,
  turnoverRate,
} from '@/core/analytics';
import { Card, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';

const isDate = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('analytics');
  const sp = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const from = isDate(sp.from) ? sp.from : `${today.slice(0, 4)}-01-01`;
  const to = isDate(sp.to) ? sp.to : today;

  const [hc, hires, terms, turnover] = await Promise.all([
    headcountSummary(s, scopeIds, { asOf: to }),
    newHires(s, scopeIds, { from, to }),
    terminations(s, scopeIds, { from, to }),
    turnoverRate(s, scopeIds, { from, to }),
  ]);
  const masterCount = (await masterDataExport(s, scopeIds, { includeComp: false })).length;

  const exportHref = (report: string, extra = '') =>
    `/analytics/export?report=${report}&from=${from}&to=${to}${extra}`;
  const ExportLink = ({ href, label }: { href: string; label: string }) => (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      ↓ {label}
    </a>
  );

  const tiles: [string, string | number][] = [
    ['activeHeadcount', hc.total],
    ['turnoverRate', `${turnover.turnoverPct}%`],
    ['newHires', hires.length],
    ['terminations', terms.length],
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />

      {/* Period filter */}
      <Card>
        <form className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-4">
          <Field label={t('from')}>
            <input name="from" type="date" defaultValue={from} className={inputCls} />
          </Field>
          <Field label={t('to')}>
            <input name="to" type="date" defaultValue={to} className={inputCls} />
          </Field>
          <div className="flex items-center gap-2">
            <button className={btnPrimary}>{t('apply')}</button>
            <Link href="/analytics" className="text-sm text-muted-foreground hover:text-foreground">
              {t('reset')}
            </Link>
          </div>
        </form>
      </Card>

      {/* Headline metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map(([key, v]) => (
          <div key={key} className="rounded-[1.25rem] border border-border bg-card p-4 shadow-[var(--shadow-card)]">
            <div className="text-xs text-muted-foreground">{t(key)}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      {/* Headcount by department */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('headcountByDept')} count={hc.total} />
        <div className="divide-y divide-border">
          {hc.byDepartment.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noData')}</div>
          )}
          {hc.byDepartment.map((r) => (
            <div key={r.name} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span>{r.name}</span>
              <span className="font-medium tabular-nums">{r.count}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Turnover detail */}
      <Card>
        <SectionHeader title={t('turnoverTitle')} />
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
          {(
            [
              ['turnoverRate', `${turnover.turnoverPct}%`],
              ['leavers', turnover.leavers],
              ['headcountStart', turnover.headcountStart],
              ['headcountEnd', turnover.headcountEnd],
            ] as const
          ).map(([key, v]) => (
            <div key={key} className="bg-card p-4">
              <div className="text-xs text-muted-foreground">{t(key)}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{v}</div>
            </div>
          ))}
        </div>
        <p className="px-4 pb-4 pt-3 text-xs text-muted-foreground">{t('turnoverFormula')}</p>
      </Card>

      {/* New hires */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 pr-4">
          <SectionHeader title={t('newHiresTitle')} count={hires.length} />
          <ExportLink href={exportHref('new-hires')} label={t('exportCsv')} />
        </div>
        <Table
          head={[t('colName'), t('colCompany'), t('colDepartment'), t('colHiredOn')]}
          rows={hires.map((r) => [r.name, r.company, r.department ?? '—', r.hiredOn])}
          empty={t('noData')}
        />
      </Card>

      {/* Terminations */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 pr-4">
          <SectionHeader title={t('terminationsTitle')} count={terms.length} />
          <ExportLink href={exportHref('terminations')} label={t('exportCsv')} />
        </div>
        <Table
          head={[t('colName'), t('colDepartment'), t('colTerminatedOn'), t('colType'), t('colReason')]}
          rows={terms.map((r) => [
            r.name,
            r.department ?? '—',
            r.terminatedOn ?? '—',
            r.terminationType ? t(`term_${r.terminationType}`) : '—',
            r.terminationReason ?? '—',
          ])}
          empty={t('noData')}
        />
      </Card>

      {/* Master-data export */}
      <Card>
        <SectionHeader title={t('masterDataTitle')} count={masterCount} />
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">{t('masterDataDesc')}</p>
          <div className="flex flex-wrap gap-2">
            <ExportLink href={exportHref('master-data')} label={t('exportWithoutComp')} />
            <ExportLink href={exportHref('master-data', '&comp=1')} label={t('exportWithComp')} />
            <ExportLink href={exportHref('master-data', '&all=1&comp=1')} label={t('exportAll')} />
          </div>
        </div>
      </Card>
    </div>
  );
}

function Table({
  head,
  rows,
  empty,
}: {
  head: string[];
  rows: (string | number)[][];
  empty: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="px-4 py-2.5 tabular-nums">
                  {c}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={head.length} className="px-4 py-8 text-center text-muted-foreground">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
