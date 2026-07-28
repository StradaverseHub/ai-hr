import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { isOperator } from '@/lib/authz';
import { isDemoDeployment } from '@/lib/demo-mode';
import { describeTableRelationships, listSchemaTables, type ForeignKeyEdge } from '@/core/schema-explorer';
import { Card, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { Badge } from '@/components/ui/badge';

/**
 * Record relationship explorer (deec1691) — operator plane.
 *
 * SITS UNDER /operator, NOT under /admin or System Settings, and that is the whole point of the item
 * rather than a layout preference. The request asked for it on a customer's System Settings screen;
 * what it displays is the schema topology of a multi-tenant product, which belongs to whoever builds
 * the product and not to the companies using it. Gated in-page on the same two conditions as the
 * console itself (see app/operator/page.tsx for why the demo build is excluded), with
 * core/schema-explorer.ts refusing again at the service.
 *
 * NO CLIENT JAVASCRIPT. The picker is a plain GET form and every related table is an ordinary link,
 * so navigating the graph is just URLs — which also means an operator can paste one to a colleague.
 */
export default async function SchemaExplorerPage({
  searchParams,
}: {
  searchParams: Promise<{ table?: string }>;
}) {
  const s = await getSession();
  if (!isOperator(s) || isDemoDeployment()) redirect('/');

  const t = await getTranslations('operator');
  const sp = await searchParams;
  const selected = sp.table?.trim() || '';

  const tables = await listSchemaTables(s);
  const detail = selected ? await describeTableRelationships(s, selected) : null;

  // Grouped for the picker: one optgroup per owning module, the unowned spine last. Sorting the
  // groups by label keeps the list stable as packs come and go; the spine is pinned to the end
  // because it is the fallback bucket, not a module.
  const byModule = new Map<string, string[]>();
  for (const row of tables) {
    const key = row.moduleName ?? '';
    const list = byModule.get(key);
    if (list) list.push(row.table);
    else byModule.set(key, [row.table]);
  }
  const moduleGroups = [...byModule.entries()]
    .filter(([label]) => label !== '')
    .sort((a, b) => a[0].localeCompare(b[0]));
  const spineTables = byModule.get('') ?? [];

  const href = (table: string) => `/operator/schema?table=${encodeURIComponent(table)}`;

  /** One FK row. `side` picks which end is the interesting one — the other end is the current table. */
  const edgeRow = (e: ForeignKeyEdge, side: 'from' | 'to') => {
    const other = side === 'from' ? e.fromTable : e.toTable;
    const localCols = side === 'from' ? e.toColumns : e.fromColumns;
    const otherCols = side === 'from' ? e.fromColumns : e.toColumns;
    return (
      <li key={e.constraint} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2">
        <div className="min-w-0">
          <Link href={href(other)} className="font-mono text-sm text-primary hover:underline">
            {other}
          </Link>
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            {otherCols.join(', ')} → {localCols.join(', ')}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {t('explorer.onDelete')}: {e.onDelete}
        </span>
      </li>
    );
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={t('explorer.title')}
        description={t('explorer.description')}
        back={{ href: '/operator', label: t('title') }}
      />

      <Card className="p-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="min-w-60 flex-1">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('explorer.recordType')}
            </span>
            <select name="table" defaultValue={selected} className={inputCls}>
              <option value="">{t('explorer.choose')}</option>
              {moduleGroups.map(([label, names]) => (
                <optgroup key={label} label={label}>
                  {names.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </optgroup>
              ))}
              {spineTables.length > 0 && (
                <optgroup label={t('explorer.sharedSpine')}>
                  {spineTables.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <button type="submit" className={btnPrimary}>
            {t('explorer.show')}
          </button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">{t('explorer.formNote', { count: tables.length })}</p>
      </Card>

      {selected && !detail && (
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">{t('explorer.unknownTable', { table: selected })}</p>
        </Card>
      )}

      {detail && (
        <>
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-mono text-lg font-semibold">{detail.table}</h2>
              <Badge variant={detail.moduleName ? 'accent' : 'default'}>
                {detail.moduleName ?? t('explorer.sharedSpine')}
              </Badge>
            </div>
            {detail.note && <p className="mt-1 text-sm text-muted-foreground">{detail.note}</p>}
            <p className="mt-2 text-sm">
              <span className="text-muted-foreground">{t('explorer.primaryKey')}: </span>
              <span className="font-mono">
                {detail.primaryKey.length ? detail.primaryKey.join(', ') : t('explorer.none')}
              </span>
            </p>
          </Card>

          {/* Parents first: what this record cannot exist without, then what cannot exist without it. */}
          <Card className="overflow-hidden">
            <SectionHeader title={t('explorer.references')} count={detail.references.length} />
            {detail.references.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">{t('explorer.noReferences')}</p>
            ) : (
              <ul className="divide-y divide-border">{detail.references.map((e) => edgeRow(e, 'to'))}</ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <SectionHeader title={t('explorer.referencedBy')} count={detail.referencedBy.length} />
            {detail.referencedBy.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">{t('explorer.noReferencedBy')}</p>
            ) : (
              <ul className="divide-y divide-border">{detail.referencedBy.map((e) => edgeRow(e, 'from'))}</ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
