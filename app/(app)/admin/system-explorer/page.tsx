import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin, requireModule } from '@/lib/authz';
import { describeTableRelationships, listSchemaTables, type ForeignKeyEdge } from '@/core/schema-explorer';
import { Card, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { Badge } from '@/components/ui/badge';

/**
 * System Analysis & Dependency Explorer (deec1691) — Admin surface.
 *
 * PLACEMENT IS THE ITEM. This lived under /operator, on the argument that the schema topology of a
 * multi-tenant product belongs to whoever builds it. The reporter overruled that for setup — there is
 * one tenant today, and the reference is wanted where setup happens. The information-disclosure
 * concern is not dropped, it moves onto the entitlement: `system_explorer` is a sellable module that
 * DEFAULTS OFF, so the first real customer is simply not sold it.
 *
 * THREE GATES, ONLY ONE OF WHICH IS A CONTROL:
 *   1. the sidebar row is hidden when the module is off  — cosmetic (ADR-0077 slice 4),
 *   2. `requireModule` redirects with an explanation      — a courtesy, and it FAILS OPEN by design,
 *   3. `core/schema-explorer.ts` throws ModuleNotEnabledError / NotAdminError — THE control.
 * Deleting 1 or 2 degrades the experience. Only 3 decides who gets an answer, which is why the test
 * that matters asserts the throw and not the missing menu row.
 *
 * `requireAdmin` FIRST so an unauthenticated or non-admin visitor is bounced before anything asks the
 * database a question, and so `test/function-access.test.ts` can see the guard this route is gated by
 * — a screen with no permission-matrix column is a screen Security & Permissions cannot describe.
 *
 * NO CLIENT JAVASCRIPT. The picker is a plain GET form and every related table is an ordinary link,
 * so navigating the graph is just URLs — which also means an admin can paste one to a colleague.
 *
 * ONE NAMESPACE, LITERAL KEYS. `test/i18n-coverage.test.ts` check C skips any file that opens two
 * namespaces, so a second `getTranslations` here would silently remove this screen from key coverage.
 */
export default async function SystemExplorerPage({
  searchParams,
}: {
  searchParams: Promise<{ table?: string }>;
}) {
  await requireAdmin();
  const s = await requireModule('system_explorer');

  const t = await getTranslations('admin.systemExplorer');
  const sp = await searchParams;
  const selected = sp.table?.trim() || '';

  const { tables, withheldTables } = await listSchemaTables(s);
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

  const href = (table: string) => `/admin/system-explorer?table=${encodeURIComponent(table)}`;

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
          {t('onDelete')}: {e.onDelete}
        </span>
      </li>
    );
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />

      <Card className="p-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="min-w-60 flex-1">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('recordType')}</span>
            <select name="table" defaultValue={selected} className={inputCls}>
              <option value="">{t('choose')}</option>
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
                <optgroup label={t('sharedSpine')}>
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
            {t('show')}
          </button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">{t('formNote', { count: tables.length })}</p>
        {/* Stated, not silently omitted: a map that looks complete and is not is worse than one that
            says where it stops. Rendered only when something is actually being held back. */}
        {withheldTables > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">{t('withheldNote', { count: withheldTables })}</p>
        )}
      </Card>

      {selected && !detail && (
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">{t('unknownTable', { table: selected })}</p>
        </Card>
      )}

      {detail && (
        <>
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-mono text-lg font-semibold">{detail.table}</h2>
              <Badge variant={detail.moduleName ? 'accent' : 'default'}>
                {detail.moduleName ?? t('sharedSpine')}
              </Badge>
            </div>
            {detail.note && <p className="mt-1 text-sm text-muted-foreground">{detail.note}</p>}
            <p className="mt-2 text-sm">
              <span className="text-muted-foreground">{t('primaryKey')}: </span>
              <span className="font-mono">
                {detail.primaryKey.length ? detail.primaryKey.join(', ') : t('none')}
              </span>
            </p>
            {detail.withheldEdges > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('withheldEdges', { count: detail.withheldEdges })}
              </p>
            )}
          </Card>

          {/* Parents first: what this record cannot exist without, then what cannot exist without it. */}
          <Card className="overflow-hidden">
            <SectionHeader title={t('references')} count={detail.references.length} />
            {detail.references.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">{t('noReferences')}</p>
            ) : (
              <ul className="divide-y divide-border">{detail.references.map((e) => edgeRow(e, 'to'))}</ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <SectionHeader title={t('referencedBy')} count={detail.referencedBy.length} />
            {detail.referencedBy.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">{t('noReferencedBy')}</p>
            ) : (
              <ul className="divide-y divide-border">{detail.referencedBy.map((e) => edgeRow(e, 'from'))}</ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
