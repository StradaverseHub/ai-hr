import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { listPayComponents } from '@/core/pay-components';
import type { PayRule, PayRuleKind } from '@/core/pay-rule';
import { Card, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { settingsBack } from '@/app/payroll/setup/back';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { DownloadCsv } from '@/components/download-csv';
import { archiveComponentAction, deleteComponentAction, seedCatalogAction } from './actions';

const PAGE = '/admin/pay-components';
type Status = 'active' | 'inactive' | 'all';

/** Input Type is DERIVED from the pay-rule kind — this column stays read-only; 61bf109d made the
 *  underlying field editable on the maintenance form (the "Input Type" selector in pay-rule-editor.tsx).
 *  null / 'fixed' ⇒ fixed amount, matching the kernel's legacy fixed-amount behaviour. */
const inputTypeOf = (rule: unknown): PayRuleKind => (rule as PayRule | null)?.kind ?? 'fixed';

/**
 * Pay Items (feedback 911b2886) — LIST-ONLY page. The Create / Edit maintenance form moved to dedicated
 * full-page routes (./new and ./[code], sharing component-form.tsx — the attendance-rule precedent), so
 * this page is purely for browsing and managing the catalog: toolbar (create, search, status filter,
 * export) + table with Edit / Activate / Deactivate / Delete row actions. Deactivated pay codes are
 * listed under the status filter and can be REACTIVATED (feedback 4994a48f, unchanged).
 */
export default async function PayComponentsPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; new?: string; q?: string; status?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payComponents');
  const sp = await searchParams;
  // Back-compat: the pre-split UI minted ?new=1 / ?edit=CODE links (bookmarks, browser history) — send
  // them to the dedicated maintenance routes instead of rendering an inline form here.
  if (sp.new === '1') redirect(`${PAGE}/new`);
  if (sp.edit) redirect(`${PAGE}/${encodeURIComponent(sp.edit)}`);
  // includeArchived is LOAD-BEARING: the page does its own Active/Inactive/All filtering. Without it a
  // deactivated row would vanish from the list with no UI path back to reactivate it.
  const components = await listPayComponents(s, { includeArchived: true });
  const q = (sp.q ?? '').trim();
  const status: Status = sp.status === 'inactive' || sp.status === 'all' ? sp.status : 'active';

  const needle = q.toLowerCase();
  const rows = components.filter((c) => {
    const okQ = !needle || [c.code, c.name, c.label ?? ''].some((v) => v.toLowerCase().includes(needle));
    const okStatus = status === 'all' || (status === 'inactive' ? c.archivedAt != null : c.archivedAt == null);
    return okQ && okStatus;
  });

  const qs = (st: Status) => `${PAGE}?status=${st}${q ? `&q=${encodeURIComponent(q)}` : ''}`;

  // Export semantics (deliberate): the FULL catalog — every row including deactivated, with ALL
  // configuration columns — IGNORING the current search and status filter. A payroll administrator
  // exporting a master configuration table means the whole table, not what happens to be on screen.
  const exportColumns = [
    { key: 'code', label: t('colCode') },
    { key: 'name', label: t('colName') },
    { key: 'label', label: t('colLabel') },
    { key: 'kind', label: t('colKind') },
    { key: 'inputType', label: t('colInputType') },
    { key: 'status', label: t('colStatus') },
    { key: 'epf', label: 'EPF' },
    { key: 'socso', label: 'SOCSO/EIS' },
    { key: 'pcb', label: 'PCB' },
    { key: 'hrdf', label: 'HRDF' },
    { key: 'prorates', label: t('colProrates') },
    { key: 'eaFormLine', label: t('colEaLine') },
    { key: 'rounding', label: t('colRounding') },
    { key: 'ruleKind', label: t('colRuleKind') },
  ];
  const exportRows = components.map((c) => ({
    code: c.code,
    name: c.name,
    label: c.label ?? '',
    kind: t(`kind_${c.kind}`),
    inputType: t(`inputType_${inputTypeOf(c.rule)}`),
    status: c.archivedAt ? t('statusInactive') : t('statusActive'),
    epf: String(c.includedInEpf),
    socso: String(c.includedInSocsoEis),
    pcb: String(c.includedInPcb),
    hrdf: String(c.includedInHrdfBase),
    prorates: String(c.prorates),
    eaFormLine: c.eaFormLine ?? '',
    rounding: c.roundingMethod,
    ruleKind: (c.rule as PayRule | null)?.kind ?? '',
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} back={await settingsBack()} />

      <p className="rounded-[1.25rem] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
        {t('previewNotice')}
      </p>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 pr-4">
          <SectionHeader title={t('catalogTitle')} count={rows.length} />
          {components.length === 0 && (
            <form action={seedCatalogAction}>
              <button className={btnPrimary}>{t('seedDefaults')}</button>
            </form>
          )}
        </div>

        {/* Toolbar — create (primary, opens the dedicated maintenance screen), search, status filter, export. */}
        <div className="flex flex-wrap items-center gap-3 px-4 pb-3">
          <Link href={`${PAGE}/new`} className={btnPrimary}>
            {t('createNew')}
          </Link>
          <form action={PAGE} method="get" className="flex items-center gap-2">
            <input type="hidden" name="status" value={status} />
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              className={`${inputCls} w-56`}
            />
          </form>
          <nav className="flex items-center gap-1 rounded-lg border border-border p-1 text-xs font-medium">
            {(['active', 'inactive', 'all'] as const).map((st) => (
              <Link
                key={st}
                href={qs(st)}
                className={`rounded-md px-2.5 py-1 transition-colors ${
                  status === st ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {t(st === 'active' ? 'statusActive' : st === 'inactive' ? 'statusInactive' : 'statusAll')}
              </Link>
            ))}
          </nav>
          <div className="ml-auto">
            <DownloadCsv columns={exportColumns} rows={exportRows} filename="pay-items.csv" />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                <th className="px-4 py-2 font-medium">{t('colLabel')}</th>
                <th className="px-4 py-2 font-medium">{t('colName')}</th>
                <th className="px-4 py-2 font-medium">{t('colKind')}</th>
                <th className="px-4 py-2 font-medium">{t('colInputType')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2.5 font-mono text-xs">{c.code}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{c.label ?? '—'}</td>
                  <td className="px-4 py-2.5">{c.name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {t(`kind_${c.kind}`)}
                    {c.isNonPayable && (
                      <span className="ml-1.5 inline-block rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground" title={t('recordOnlyNote')}>
                        {t('recordOnlyBadge')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{t(`inputType_${inputTypeOf(c.rule)}`)}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        c.archivedAt
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      }`}
                    >
                      {c.archivedAt ? t('statusInactive') : t('statusActive')}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-3">
                      <Link href={`${PAGE}/${encodeURIComponent(c.code)}`} className="text-xs font-medium text-primary hover:underline">
                        {t('edit')}
                      </Link>
                      {c.archivedAt ? (
                        <form action={archiveComponentAction}>
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="archived" value="false" />
                          <button className="text-xs font-medium text-primary hover:underline">{t('activate')}</button>
                        </form>
                      ) : (
                        <form action={archiveComponentAction}>
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="archived" value="true" />
                          <ConfirmSubmit
                            variant="outline"
                            title={t('archiveTitle')}
                            description={t('archiveDescription', { code: c.code })}
                            confirmLabel={t('deactivate')}
                            size="sm"
                          >
                            {t('deactivate')}
                          </ConfirmSubmit>
                        </form>
                      )}
                      <form action={deleteComponentAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <ConfirmSubmit
                          title={t('deleteTitle')}
                          description={t('deleteDescription', { code: c.code })}
                          confirmLabel={t('delete')}
                          size="sm"
                        >
                          {t('delete')}
                        </ConfirmSubmit>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">{t('empty')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
