import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listAllowancePolicies, listCompanies, listDepartments } from '@/core/read';
import { listSupportedBatchComponents } from '@/core/pay-components';
import { listBusinessUnits } from '@/core/admin';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import {
  archiveAllowancePolicyAction,
  createAllowancePolicyAction,
  setAllowanceStatusAction,
  updateAllowancePolicyAction,
} from './actions';

const PAGE = '/admin/attendance-allowance';

export default async function AttendanceAllowancePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string; edit?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('attendanceAllowance');
  const { error, edit } = await searchParams;

  const allCompanies = await listCompanies(s);
  const companies = allCompanies.filter((c) => scopeIds.includes(c.id));
  const policies = await listAllowancePolicies(s, { companyIds: scopeIds, includeArchived: false });
  const components = await listSupportedBatchComponents(s);
  const departments = await listDepartments(s, { companyIds: scopeIds });
  const businessUnits = await listBusinessUnits(s, { companyIds: scopeIds });

  const editing = edit ? policies.find((p) => p.id === edit) ?? null : null;
  const editCriteria = editing?.criteria ?? {};
  const editScope = editing?.scope ?? {};
  const num = (v: number | undefined) => (v === undefined || v === null ? '' : String(v));

  const CRITERIA_KEYS = ['minAttendanceDays', 'maxAbsentDays', 'maxLateCount', 'maxTotalLeaveDays'] as const;

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('title')} description={t('description')} />
      {error && <ErrorBanner message={error} />}

      <p className="rounded-[1.25rem] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
        {t('scopeNotice')}
      </p>

      {companies.length === 0 ? (
        <Card>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('emptyScope')}</p>
        </Card>
      ) : (
        <>
          {/* Catalog */}
          <Card className="overflow-hidden">
            <SectionHeader title={t('catalogTitle')} count={policies.length} />
            {policies.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                      <th className="px-4 py-2">{t('fields.code')}</th>
                      <th className="px-4 py-2">{t('fields.name')}</th>
                      <th className="px-4 py-2">{t('fields.company')}</th>
                      <th className="px-4 py-2">{t('fields.amount')}</th>
                      <th className="px-4 py-2">{t('fields.payComponent')}</th>
                      <th className="px-4 py-2">{t('fields.status')}</th>
                      <th className="px-4 py-2 text-right">{t('actions.title')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {policies.map((p) => (
                      <tr key={p.id} className="border-b border-border/60">
                        <td className="px-4 py-2 font-mono text-xs">{p.code}</td>
                        <td className="px-4 py-2">{p.name}</td>
                        <td className="px-4 py-2 text-muted-foreground">{p.companyName}</td>
                        <td className="px-4 py-2">RM {Number(p.amount).toFixed(2)}</td>
                        <td className="px-4 py-2 text-muted-foreground">{p.payComponentCode ?? '—'}</td>
                        <td className="px-4 py-2">
                          <Badge variant={p.status === 'active' ? 'success' : 'default'}>
                            {t(`status.${p.status}`)}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center justify-end gap-2">
                            <a href={`${PAGE}?edit=${p.id}`} className="text-xs text-primary hover:underline">
                              {t('actions.edit')}
                            </a>
                            <form action={setAllowanceStatusAction} className="inline">
                              <input type="hidden" name="id" value={p.id} />
                              <input type="hidden" name="status" value={p.status === 'active' ? 'inactive' : 'active'} />
                              <button type="submit" className="text-xs text-muted-foreground hover:underline">
                                {p.status === 'active' ? t('actions.deactivate') : t('actions.activate')}
                              </button>
                            </form>
                            <form action={archiveAllowancePolicyAction} className="inline">
                              <input type="hidden" name="id" value={p.id} />
                              <ConfirmSubmit
                                size="sm"
                                variant="ghost"
                                title={t('actions.archiveConfirmTitle')}
                                description={t('actions.archiveConfirmBody')}
                                confirmLabel={t('actions.archive')}
                              >
                                {t('actions.archive')}
                              </ConfirmSubmit>
                            </form>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Create / edit form */}
          {/* af7a8eb4 — capped locally: the LIST above uses the full window, but this two-column form
              reads worse stretched across it. Same width the whole page carried before. */}
          <Card className="max-w-5xl">
            <SectionHeader title={editing ? t('form.editTitle') : t('form.createTitle')} />
            <form
              action={editing ? updateAllowancePolicyAction : createAllowancePolicyAction}
              className="space-y-4 px-4 py-4"
            >
              {editing && <input type="hidden" name="id" value={editing.id} />}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('fields.company')}>
                  {editing ? (
                    <>
                      <input type="hidden" name="companyId" value={editing.companyId} />
                      <input className={inputCls} value={editing.companyName} disabled />
                    </>
                  ) : (
                    <select name="companyId" className={inputCls} required defaultValue="">
                      <option value="" disabled>
                        {t('form.selectCompany')}
                      </option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label={t('fields.method')}>
                  <select className={inputCls} disabled defaultValue="monthly">
                    <option value="monthly">{t('method.monthly')}</option>
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">{t('form.dailyComingSoon')}</p>
                </Field>
                <Field label={t('fields.code')}>
                  <input name="code" className={inputCls} required defaultValue={editing?.code ?? ''} />
                </Field>
                <Field label={t('fields.name')}>
                  <input name="name" className={inputCls} required defaultValue={editing?.name ?? ''} />
                </Field>
                <Field label={t('fields.amount')}>
                  <input
                    name="amount"
                    type="number"
                    step="0.01"
                    min="0"
                    className={inputCls}
                    required
                    defaultValue={editing ? Number(editing.amount).toFixed(2) : ''}
                  />
                </Field>
                <Field label={t('fields.effectiveFrom')}>
                  <input
                    name="effectiveFrom"
                    type="date"
                    className={inputCls}
                    required
                    defaultValue={editing?.effectiveFrom ?? ''}
                  />
                </Field>
                <Field label={t('fields.payComponent')}>
                  <select name="payComponentId" className={inputCls} required defaultValue={editing?.payComponentId ?? ''}>
                    <option value="" disabled>
                      {t('form.selectComponent')}
                    </option>
                    {components.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.code})
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              {/* Criteria */}
              <div className="rounded-[1rem] border border-border p-4">
                <p className="mb-3 text-sm font-medium">{t('form.criteriaTitle')}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {CRITERIA_KEYS.map((key) => (
                    <Field key={key} label={t(`criteria.${key}`)}>
                      <input
                        name={key}
                        type="number"
                        min="0"
                        step="1"
                        className={inputCls}
                        placeholder={t('form.noLimit')}
                        defaultValue={num((editCriteria as Record<string, number | undefined>)[key])}
                      />
                    </Field>
                  ))}
                </div>
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="requirePerfectAttendance"
                    defaultChecked={editCriteria.requirePerfectAttendance === true}
                  />
                  {t('criteria.requirePerfectAttendance')}
                </label>
              </div>

              {/* Scope */}
              <div className="rounded-[1rem] border border-border p-4">
                <p className="mb-1 text-sm font-medium">{t('form.scopeTitle')}</p>
                <p className="mb-3 text-xs text-muted-foreground">{t('form.scopeHint')}</p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <ScopeList
                    label={t('fields.departments')}
                    name="departmentIds"
                    items={departments.map((d) => ({ id: d.id, label: d.name }))}
                    selected={editScope.departmentIds ?? []}
                    emptyLabel={t('form.noDepartments')}
                  />
                  <ScopeList
                    label={t('fields.businessUnits')}
                    name="businessUnitIds"
                    items={businessUnits.map((u) => ({ id: u.id, label: `${u.name} (${u.code})` }))}
                    selected={editScope.businessUnitIds ?? []}
                    emptyLabel={t('form.noBusinessUnits')}
                  />
                  <ScopeList
                    label={t('fields.companies')}
                    name="companyIds"
                    items={companies.map((c) => ({ id: c.id, label: c.name }))}
                    selected={editScope.companyIds ?? []}
                    emptyLabel={t('form.noCompanies')}
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button type="submit" className={btnPrimary}>
                  {editing ? t('form.save') : t('form.create')}
                </button>
                {editing && (
                  <a href={PAGE} className="text-sm text-muted-foreground hover:underline">
                    {t('form.cancel')}
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

function ScopeList({
  label,
  name,
  items,
  selected,
  emptyLabel,
}: {
  label: string;
  name: string;
  items: { id: string; label: string }[];
  selected: string[];
  emptyLabel: string;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">{label}</p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {items.map((it) => (
            <label key={it.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name={name} value={it.id} defaultChecked={selected.includes(it.id)} />
              <span className="truncate">{it.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
