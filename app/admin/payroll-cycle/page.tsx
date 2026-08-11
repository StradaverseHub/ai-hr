import { Fragment } from 'react';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listPayrollCycles, PAYROLL_CYCLE_RUN_TYPES } from '@/core/payroll-cycle';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { copyCycleAction, deleteCycleAction, seedCatalogAction, setActiveAction, upsertCycleAction } from './actions';

const PAGE = '/admin/payroll-cycle';

/**
 * Configurable Payroll Cycle master (ADR-0069). A company-scoped catalog of the friendly cycle names the
 * Payroll Process wizard's "Payroll Cycle" dropdown offers. Each row maps to one fixed behavioural run
 * type (shown read-only, with a plain-language hint). requireAdmin (via scopedAdmin) gates the page; RLS
 * (can_admin_payroll_for) is the real backstop.
 */
export default async function PayrollCyclePage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; error?: string; edit?: string; copy?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payrollCycleConfig');
  const { company: companyParam, error, edit, copy } = await searchParams;

  const all = await listCompanies(s);
  const companies = all.filter((c) => scopeIds.includes(c.id));
  const companyId = companyParam && companies.some((c) => c.id === companyParam) ? companyParam : companies[0]?.id ?? '';

  const cycles = companyId ? await listPayrollCycles(s, companyId) : [];
  const editing = edit ? cycles.find((c) => c.id === edit) ?? null : null;
  const copying = copy ? cycles.find((c) => c.id === copy) ?? null : null;
  // The OTHER companies a cycle can be copied into (everything the admin manages except the current one).
  const otherCompanies = companies.filter((c) => c.id !== companyId);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      {error && <ErrorBanner message={error} />}

      {/* Company selector — cycles are company-scoped, so pick which company's list to manage. */}
      <Card>
        <form method="GET" className="flex flex-wrap items-end gap-3 p-4">
          <Field label={t('company')}>
            <select name="company" defaultValue={companyId} className={inputCls}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <button className={btnPrimary} type="submit">
            {t('view')}
          </button>
        </form>
      </Card>

      {companyId && (
        <>
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 pr-4">
              <SectionHeader title={t('catalogTitle')} count={cycles.length} />
              {cycles.length === 0 && (
                <form action={seedCatalogAction}>
                  <input type="hidden" name="companyId" value={companyId} />
                  <button className={btnPrimary}>{t('seedDefaults')}</button>
                </form>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('colName')}</th>
                    {/* 4157a498 — the short code an import file's "Payroll Cycle" column names. */}
                    <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                    <th className="px-4 py-2 font-medium">{t('colRunType')}</th>
                    <th className="px-4 py-2 font-medium">{t('colBehaviour')}</th>
                    <th className="px-4 py-2 font-medium">{t('colRemarks')}</th>
                    <th className="px-4 py-2 text-center font-medium">{t('colSort')}</th>
                    <th className="px-4 py-2 text-center font-medium">{t('colStatus')}</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {cycles.map((c) => {
                    const active = c.archivedAt == null;
                    return (
                      <Fragment key={c.id}>
                      <tr className={editing?.id === c.id || copying?.id === c.id ? 'bg-primary/5' : undefined}>
                        <td className="px-4 py-2.5 font-medium">{c.name}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{c.code ?? '—'}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          <span title={t(`runTypeHint.${c.runType}`)}>{t(`runType.${c.runType}`)}</span>
                        </td>
                        <td className="max-w-xs px-4 py-2.5 text-muted-foreground">
                          {c.description ? (
                            <span className="line-clamp-2 whitespace-pre-line" title={c.description}>
                              {c.description}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{c.remarks ?? '—'}</td>
                        <td className="px-4 py-2.5 text-center tabular-nums">{c.sortOrder}</td>
                        <td className="px-4 py-2.5 text-center">
                          <Badge variant={active ? 'success' : 'default'}>{active ? t('active') : t('inactive')}</Badge>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-3">
                            <a href={`${PAGE}?company=${companyId}&edit=${c.id}`} className="text-xs font-medium text-primary hover:underline">
                              {t('edit')}
                            </a>
                            {otherCompanies.length > 0 && (
                              <a
                                href={
                                  copying?.id === c.id
                                    ? `${PAGE}?company=${companyId}`
                                    : `${PAGE}?company=${companyId}&copy=${c.id}`
                                }
                                className="text-xs font-medium text-primary hover:underline"
                              >
                                {t('copy')}
                              </a>
                            )}
                            <form action={setActiveAction}>
                              <input type="hidden" name="companyId" value={companyId} />
                              <input type="hidden" name="id" value={c.id} />
                              <input type="hidden" name="active" value={active ? 'false' : 'true'} />
                              <button className="text-xs font-medium text-muted-foreground hover:text-foreground">
                                {active ? t('deactivate') : t('activate')}
                              </button>
                            </form>
                            <form action={deleteCycleAction}>
                              <input type="hidden" name="companyId" value={companyId} />
                              <input type="hidden" name="id" value={c.id} />
                              <ConfirmSubmit
                                title={t('deleteTitle')}
                                description={t('deleteDescription', { name: c.name })}
                                confirmLabel={t('delete')}
                                size="sm"
                              >
                                {t('delete')}
                              </ConfirmSubmit>
                            </form>
                          </div>
                        </td>
                      </tr>
                      {copying?.id === c.id && otherCompanies.length > 0 && (
                        <tr className="bg-muted/30">
                          <td colSpan={8} className="px-4 py-4">
                            <form action={copyCycleAction} className="space-y-3">
                              <input type="hidden" name="companyId" value={companyId} />
                              <input type="hidden" name="id" value={c.id} />
                              <div>
                                <p className="text-sm font-medium">{t('copyTitle', { name: c.name })}</p>
                                <p className="mt-0.5 text-xs text-muted-foreground">{t('copyDescription')}</p>
                              </div>
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {otherCompanies.map((oc) => (
                                  <label key={oc.id} className="flex items-center gap-2 text-sm">
                                    <input type="checkbox" name="companyIds" value={oc.id} defaultChecked className="size-4 rounded" />
                                    <span>{oc.name}</span>
                                  </label>
                                ))}
                              </div>
                              <div className="flex items-center gap-3">
                                <button className={btnPrimary}>{t('copyConfirm')}</button>
                                <a
                                  href={`${PAGE}?company=${companyId}`}
                                  className="text-sm font-medium text-muted-foreground hover:text-foreground"
                                >
                                  {t('cancelEdit')}
                                </a>
                              </div>
                            </form>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                  {cycles.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                        {t('empty')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <SectionHeader title={editing ? t('editTitle', { name: editing.name }) : t('addTitle')} />
            {/* key forces the uncontrolled form to re-init its defaults when the edit target changes */}
            <form key={editing?.id ?? 'new'} action={upsertCycleAction} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
              <input type="hidden" name="companyId" value={companyId} />
              {editing && <input type="hidden" name="id" value={editing.id} />}
              <Field label={t('colName')}>
                <input name="name" required defaultValue={editing?.name ?? ''} placeholder={t('namePlaceholder')} className={inputCls} />
              </Field>
              <Field label={t('colCode')}>
                <input
                  name="code"
                  defaultValue={editing?.code ?? ''}
                  placeholder={t('codePlaceholder')}
                  maxLength={16}
                  className={inputCls}
                />
              </Field>
              <Field label={t('colRunType')}>
                <select name="runType" defaultValue={editing?.runType ?? 'regular'} className={inputCls}>
                  {PAYROLL_CYCLE_RUN_TYPES.map((rt) => (
                    <option key={rt} value={rt}>
                      {t(`runType.${rt}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('colSort')}>
                <input name="sortOrder" type="number" min={0} defaultValue={editing?.sortOrder ?? 0} className={inputCls} />
              </Field>
              <Field label={t('colRemarks')}>
                <input name="remarks" defaultValue={editing?.remarks ?? ''} placeholder={t('remarksPlaceholder')} className={inputCls} />
              </Field>
              <div className="sm:col-span-3">
                <Field label={t('colBehaviour')}>
                  <textarea
                    name="description"
                    rows={2}
                    defaultValue={editing?.description ?? ''}
                    placeholder={t('behaviourPlaceholder')}
                    className={inputCls}
                  />
                </Field>
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-3">{t('runTypeHelp')}</p>
              {/* 4157a498 — say what the code is FOR, or nobody fills it in and every import file fails. */}
              <p className="text-xs text-muted-foreground sm:col-span-3">{t('codeHelp')}</p>
              <div className="flex items-center gap-3 sm:col-span-3">
                <button className={btnPrimary}>{editing ? t('saveChanges') : t('addCycle')}</button>
                {editing && (
                  <a href={`${PAGE}?company=${companyId}`} className="text-sm font-medium text-muted-foreground hover:text-foreground">
                    {t('cancelEdit')}
                  </a>
                )}
              </div>
            </form>
          </Card>
        </>
      )}
    </div>
  );
}
