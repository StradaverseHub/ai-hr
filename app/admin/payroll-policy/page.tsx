import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listPolicies, POLICY_TYPES, type PolicyRow } from '@/core/payroll-policy';
import { listPayComponents } from '@/core/pay-components';
import { CUT_OFF_PER_TYPES, PAYROLL_FREQUENCIES, cutOffWindowFor, payrollFrequencyOf, payrollScheduleFor } from '@/core/payroll-policy-config';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { settingsBack } from '@/app/payroll/setup/back';
import { Badge } from '@/components/ui/badge';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { copyPolicyAction, deletePolicyAction, setStatusAction } from './actions';
import { PolicyWizard, type WizardCutOff, type WizardPolicy } from './policy-wizard';

const PAGE = '/admin/payroll-policy';
// 2.1.4 — Monthly, Daily, Hourly and Custom-period are all selectable. Hourly persists its per-hour rate + the
// "only pull hours within shift schedule" toggle; the live end-to-end hourly payslip computation is a deferred
// follow-up (gated on the rate-storage decision). Custom-period persists a cut-off WINDOW (an anchor day for a
// non-calendar operational window) — recorded + validated now, but NOT yet applied to payroll calculation
// (deferred follow-up); statutory months stay calendar-bound by law.
const ENABLED_TYPES = new Set(['monthly', 'daily', 'hourly', 'custom_period']);
// Anchor-day bounds mirror core/payroll-policy-config.ts (1..28 — avoids the 29–31 month-length trap).
const ANCHOR_MIN = 1;
const ANCHOR_MAX = 28;
type SortKey = 'name' | 'type' | 'status' | 'updated';

export default async function PayrollPolicyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string; edit?: string; new?: string; q?: string; type?: string; status?: string; sort?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payrollPolicy');
  const { error, edit, new: newParam, q, type, status, sort } = await searchParams;

  const all = await listCompanies(s);
  const companies = all.filter((c) => scopeIds.includes(c.id));
  const policies = await listPolicies(s, scopeIds);
  // f3148da1 Step 4 — pay components offered as the "convert OT excess to pay item" target (earnings only).
  const payComponents = (await listPayComponents(s)).filter((c) => c.kind === 'allowance');

  // Search / filter / sort (the catalog is small — applied in-page over the server-rendered list).
  const sortKey: SortKey = (['name', 'type', 'status', 'updated'] as const).includes(sort as SortKey) ? (sort as SortKey) : 'name';
  const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? '—';
  let rows = policies.filter((p) => {
    // 61d77e82 — search also matches the Policy Code.
    if (q && !`${p.name} ${p.code ?? ''} ${p.description ?? ''}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (type && p.policyType !== type) return false;
    if (status && p.status !== status) return false;
    return true;
  });
  rows = [...rows].sort((a, b) => {
    if (sortKey === 'type') return a.policyType.localeCompare(b.policyType);
    if (sortKey === 'status') return a.status.localeCompare(b.status);
    if (sortKey === 'updated') return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    return a.name.localeCompare(b.name);
  });

  const editing: PolicyRow | null = edit ? policies.find((p) => p.id === edit) ?? null : null;
  // 61d77e82 — the field-level prefill (cut-off window, per-type/per-frequency anchors, proration/OT/leave/
  // rounding groups) now lives inside <PolicyWizard>, which derives it from editing.config. The page keeps only
  // the values the wizard's Review step needs as read-only props: the stored frequency, the raw cut-off config,
  // and the derived From/To + schedule previews.
  const editingCutOff = editing?.config?.cutOff;
  const editingFrequency = payrollFrequencyOf(editing?.config ?? null);
  // From/To preview: for the CURRENT month, the window each transaction type's saved cut-off resolves to
  // (derived, not stored). Read-only — it reflects the LAST SAVED config.
  const previewPeriod = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  const cutOffPreview = (['salary', ...CUT_OFF_PER_TYPES] as const).map((type) => ({
    type,
    window: cutOffWindowFor(type, editing?.config ?? null, null, previewPeriod),
  }));
  // The GENERATED cut-off periods for the saved frequency (monthly ⇒ 1 cycle; weekly/biweekly ⇒ tiled cycles).
  const schedulePreview = payrollScheduleFor(editing?.config ?? null, null, previewPeriod);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} back={await settingsBack()} />
      {error && <ErrorBanner message={error} />}

      <p className="rounded-[1.25rem] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
        {t('previewNotice')}
      </p>

      {companies.length === 0 ? (
        <Card>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('emptyScope')}</p>
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 pr-4">
              <SectionHeader title={t('catalogTitle')} count={rows.length} />
              {/* 61d77e82 — Create New Policy launches the guided setup wizard below. */}
              <Link href={`${PAGE}?new=1`} className={btnPrimary}>
                {t('createNewPolicy')}
              </Link>
            </div>

            {/* Search / filter / sort — a GET form so the controls are server-driven (no client state). */}
            <form method="get" className="flex flex-wrap items-end gap-2 px-4 pt-3">
              <input
                name="q"
                defaultValue={q ?? ''}
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchLabel')}
                className={`${inputCls} w-48`}
              />
              <select name="type" defaultValue={type ?? ''} aria-label={t('filterType')} className={`${inputCls} w-auto`}>
                <option value="">{t('filterTypeAll')}</option>
                {POLICY_TYPES.map((ty) => (
                  <option key={ty} value={ty}>{t(`types.${ty}`)}</option>
                ))}
              </select>
              <select name="status" defaultValue={status ?? ''} aria-label={t('filterStatus')} className={`${inputCls} w-auto`}>
                <option value="">{t('filterStatusAll')}</option>
                <option value="active">{t('status.active')}</option>
                <option value="inactive">{t('status.inactive')}</option>
                <option value="draft">{t('status.draft')}</option>
              </select>
              <select name="sort" defaultValue={sortKey} aria-label={t('sortLabel')} className={`${inputCls} w-auto`}>
                <option value="name">{t('sortName')}</option>
                <option value="type">{t('sortType')}</option>
                <option value="status">{t('sortStatus')}</option>
                <option value="updated">{t('sortUpdated')}</option>
              </select>
              <button className={btnPrimary}>{t('apply')}</button>
            </form>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('colName')}</th>
                    <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                    <th className="px-4 py-2 font-medium">{t('colType')}</th>
                    <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                    <th className="px-4 py-2 text-center font-medium">{t('colAssigned')}</th>
                    <th className="px-4 py-2 font-medium">{t('colUpdated')}</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((p) => (
                    <tr key={p.id} className={editing?.id === p.id ? 'bg-primary/5' : undefined}>
                      <td className="px-4 py-2.5 font-medium">
                        {p.name}
                        {p.code && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{p.code}</span>}
                        {p.description && <span className="ml-2 text-xs text-muted-foreground">{p.description}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{companyName(p.companyId)}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{t(`types.${p.policyType}`)}</td>
                      <td className="px-4 py-2.5">
                        <Badge variant={p.status === 'active' ? 'success' : p.status === 'draft' ? 'warning' : 'default'}>{t(`status.${p.status}`)}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-center tabular-nums">{p.assignedCount}</td>
                      <td className="px-4 py-2.5 text-muted-foreground tabular-nums">{new Date(p.updatedAt).toISOString().slice(0, 10)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-3">
                          <Link href={`${PAGE}?edit=${p.id}`} className="text-xs font-medium text-primary hover:underline">
                            {t('edit')}
                          </Link>
                          {/* 2.1.2 — Copy: duplicate the policy (type + rate + config) under a "(copy)" name. */}
                          <form action={copyPolicyAction}>
                            <input type="hidden" name="id" value={p.id} />
                            <input type="hidden" name="name" value={`${p.name} ${t('copySuffix')}`} />
                            <button className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
                              {t('copy')}
                            </button>
                          </form>
                          <form action={setStatusAction}>
                            <input type="hidden" name="id" value={p.id} />
                            <input type="hidden" name="status" value={p.status === 'active' ? 'inactive' : 'active'} />
                            <button className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
                              {p.status === 'active' ? t('deactivate') : t('activate')}
                            </button>
                          </form>
                          <form action={deletePolicyAction}>
                            <input type="hidden" name="id" value={p.id} />
                            <ConfirmSubmit
                              title={t('deleteTitle')}
                              description={t('deleteDescription', { name: p.name })}
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

          {(editing || newParam) && (
            <PolicyWizard
              mode={editing ? 'edit' : 'create'}
              editing={
                editing
                  ? {
                      id: editing.id,
                      name: editing.name,
                      code: editing.code,
                      description: editing.description,
                      policyType: editing.policyType,
                      status: editing.status,
                      payRule: editing.payRule as WizardPolicy['payRule'],
                      config: (editing.config ?? null) as WizardPolicy['config'],
                    }
                  : null
              }
              companies={companies.map((c) => ({ id: c.id, name: c.name }))}
              payComponents={payComponents.map((c) => ({ id: c.id, name: c.name, code: c.code }))}
              policyTypes={POLICY_TYPES}
              enabledTypes={[...ENABLED_TYPES]}
              cutOffPerTypes={CUT_OFF_PER_TYPES}
              payrollFrequencies={PAYROLL_FREQUENCIES}
              editingFrequency={editingFrequency}
              editingCutOff={(editingCutOff ?? null) as WizardCutOff}
              cutOffPreview={cutOffPreview.map((r) => ({ type: r.type, start: r.window.start, end: r.window.end }))}
              schedulePreview={{ frequency: schedulePreview.frequency, periods: schedulePreview.periods.map((p) => ({ seq: p.seq, start: p.start, end: p.end })) }}
              previewPeriod={previewPeriod}
              anchorMin={ANCHOR_MIN}
              anchorMax={ANCHOR_MAX}
              cancelHref={PAGE}
            />
          )}
        </>
      )}
    </div>
  );
}
