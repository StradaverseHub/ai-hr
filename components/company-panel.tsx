'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from './ui';
import { ConfirmSubmit } from './ui/confirm-submit';
import { EditableRow } from './editable-row';

type Action = (fd: FormData) => void | Promise<void>;

export type PanelCompany = {
  id: string;
  name: string;
  country: string;
  currency: string;
  registrationNo: string | null;
  archivedAt: Date | null;
  inUse: boolean;
  parentId: string | null;
};
export type PanelStatutory = {
  epfEmployerNo: string | null;
  socsoEmployerCode: string | null;
  lhdnEmployerNo: string | null;
  myinvoisTin: string | null;
  ssmRegistrationNo: string | null;
  hrdfStatus: 'not_registered' | 'mandatory' | 'optional' | null;
} | null;
export type ChildRow = {
  id: string;
  display: string;
  sub?: string | null;
  fields: { name: string; label: string; value: string }[];
  inUse: boolean;
  archived: boolean;
};

const badge = {
  amber:
    'rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  emerald:
    'rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  muted:
    'rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
};

function SubHeader({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

/** One legal entity as an expandable panel: details, group parent, statutory identity, and its
 *  departments / positions / cost centers — everything "inside the company", per the mental
 *  model. The tables stay split underneath (children are 1:N; statutory identity lives in the
 *  country pack per ADR-0008); only the editing surface is unified. */
export function CompanyPanel({
  company,
  companies,
  statutory,
  departments,
  positions,
  costCenters,
  actions,
}: {
  company: PanelCompany;
  companies: { id: string; name: string }[];
  statutory: PanelStatutory;
  departments: ChildRow[];
  positions: ChildRow[];
  costCenters: ChildRow[];
  actions: {
    updateCompany: Action;
    archiveCompany: Action;
    deleteCompany: Action;
    setParent: Action;
    setStatutory: Action;
    createDepartment: Action;
    updateDepartment: Action;
    archiveDepartment: Action;
    deleteDepartment: Action;
    createPosition: Action;
    updatePosition: Action;
    archivePosition: Action;
    deletePosition: Action;
    createCostCenter: Action;
    updateCostCenter: Action;
    archiveCostCenter: Action;
    deleteCostCenter: Action;
  };
}) {
  const t = useTranslations('admin.organization');
  const [expanded, setExpanded] = useState(false);
  const c = company;
  const isMY = c.country === 'MY';
  // Readiness for the monthly filings: the three agency identifiers reports key on.
  const statMissing = isMY
    ? [statutory?.epfEmployerNo, statutory?.socsoEmployerCode, statutory?.lhdnEmployerNo].filter((v) => !v).length
    : 0;

  return (
    <li className={c.archivedAt ? 'opacity-60' : ''}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <svg
            viewBox="0 0 20 20"
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden
          >
            <path d="M7.5 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="truncate text-sm font-medium text-foreground">{c.name}</span>
          {c.registrationNo && <span className="text-xs text-muted-foreground">{c.registrationNo}</span>}
          <span className={badge.muted}>{c.country}</span>
          {c.archivedAt && <span className={badge.muted}>{t('archived')}</span>}
        </button>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {t('countSummary', {
              dept: departments.length,
              pos: positions.length,
              cc: costCenters.length,
            })}
          </span>
          {isMY &&
            (statMissing === 0 ? (
              <span className={badge.emerald}>{t('statutoryComplete')}</span>
            ) : (
              <span className={badge.amber}>{t('statutoryPartial', { ready: 3 - statMissing, total: 3 })}</span>
            ))}
        </div>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-border/60 bg-muted/20 px-4 py-4">
          {/* Company details + group parent */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <form action={actions.updateCompany} className="space-y-2.5 rounded-lg bg-background p-3">
              <SubHeader>{t('details')}</SubHeader>
              <input type="hidden" name="id" value={c.id} />
              <Field label={t('legalName')}>
                <input name="legalName" required defaultValue={c.name} className={inputCls} />
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label={t('regNo')}>
                  <input name="registrationNo" defaultValue={c.registrationNo ?? ''} className={inputCls} />
                </Field>
                <Field label={t('country')}>
                  <input name="country" defaultValue={c.country} pattern="[A-Za-z]{2}" maxLength={2} title={t('countryHint')} className={`${inputCls} uppercase`} />
                </Field>
                <Field label={t('currency')}>
                  <input name="currency" defaultValue={c.currency} pattern="[A-Za-z]{3}" maxLength={3} title={t('currencyHint')} className={`${inputCls} uppercase`} />
                </Field>
              </div>
              <div className="flex items-center gap-1.5">
                <Button type="submit" size="sm">
                  {t('saveDetails')}
                </Button>
              </div>
            </form>

            <div className="space-y-3">
              <form action={actions.setParent} className="space-y-2.5 rounded-lg bg-background p-3">
                <SubHeader>{t('groupParent')}</SubHeader>
                <input type="hidden" name="companyId" value={c.id} />
                <Field label={t('parentCompany')}>
                  <select name="parentCompanyId" defaultValue={c.parentId ?? ''} className={inputCls}>
                    <option value="">{t('noneGroupRoot')}</option>
                    {companies
                      .filter((o) => o.id !== c.id)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Button type="submit" size="sm" variant="outline">
                  {t('setParent')}
                </Button>
              </form>

              <div className="flex items-center gap-1.5 rounded-lg bg-background p-3">
                {c.archivedAt ? (
                  <form action={actions.archiveCompany}>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="archived" value="false" />
                    <Button type="submit" size="sm" variant="ghost">
                      {t('unarchive')}
                    </Button>
                  </form>
                ) : c.inUse ? (
                  <form action={actions.archiveCompany}>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="archived" value="true" />
                    <Button type="submit" size="sm" variant="ghost">
                      {t('archiveCompany')}
                    </Button>
                  </form>
                ) : (
                  <form action={actions.deleteCompany}>
                    <input type="hidden" name="id" value={c.id} />
                    <ConfirmSubmit
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      title={t('deleteCompanyTitle')}
                      description={t('deleteCompanyDescription')}
                      confirmLabel={t('delete')}
                    >
                      {t('deleteCompany')}
                    </ConfirmSubmit>
                  </form>
                )}
                <span className="text-xs text-muted-foreground">
                  {c.inUse ? t('inUseArchiveInstead') : t('notReferenced')}
                </span>
              </div>
            </div>
          </div>

          {/* Statutory identity — country-pack section (ADR-0008) */}
          {isMY ? (
            <form action={actions.setStatutory} className="space-y-2.5 rounded-lg bg-background p-3">
              <SubHeader>{t('statutoryIdentityMY')}</SubHeader>
              <input type="hidden" name="companyId" value={c.id} />
              <input type="hidden" name="country" value="MY" />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Field label={t('epfEmployerNo')}>
                  <input name="epfEmployerNo" defaultValue={statutory?.epfEmployerNo ?? ''} className={inputCls} />
                </Field>
                <Field label={t('socsoEmployerCode')}>
                  <input
                    name="socsoEmployerCode"
                    defaultValue={statutory?.socsoEmployerCode ?? ''}
                    className={inputCls}
                  />
                </Field>
                <Field label={t('lhdnENumber')}>
                  <input name="lhdnEmployerNo" defaultValue={statutory?.lhdnEmployerNo ?? ''} className={inputCls} />
                </Field>
                <Field label={t('myinvoisTin')}>
                  <input name="myinvoisTin" defaultValue={statutory?.myinvoisTin ?? ''} className={inputCls} />
                </Field>
                <Field label={t('ssmRegistrationNo')}>
                  <input
                    name="ssmRegistrationNo"
                    defaultValue={statutory?.ssmRegistrationNo ?? ''}
                    className={inputCls}
                  />
                </Field>
                <Field label={t('hrdfStatusLabel')}>
                  <select
                    name="hrdfStatus"
                    defaultValue={statutory?.hrdfStatus ?? 'not_registered'}
                    className={inputCls}
                  >
                    <option value="not_registered">{t('hrdfNotRegistered')}</option>
                    <option value="mandatory">{t('hrdfMandatory')}</option>
                    <option value="optional">{t('hrdfOptional')}</option>
                  </select>
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('statutoryFilingsHint')}
              </p>
              <p className="text-xs text-muted-foreground">{t('hrdfHint')}</p>
              <Button type="submit" size="sm">
                {t('saveStatutoryIdentity')}
              </Button>
            </form>
          ) : (
            <p className="rounded-lg bg-background p-3 text-xs text-muted-foreground">
              {t('noStatutoryPack', { country: c.country })}
            </p>
          )}

          {/* Children: departments / positions / cost centers — scoped to this company */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="rounded-lg bg-background p-3">
              <SubHeader>{t('departmentsCount', { count: departments.length })}</SubHeader>
              <ul className="mt-1 divide-y divide-border/60">
                {departments.map((d) => (
                  <EditableRow
                    key={d.id}
                    id={d.id}
                    display={d.display}
                    sub={d.sub}
                    fields={d.fields}
                    inUse={d.inUse}
                    archived={d.archived}
                    updateAction={actions.updateDepartment}
                    archiveAction={actions.archiveDepartment}
                    deleteAction={actions.deleteDepartment}
                  />
                ))}
                {departments.length === 0 && (
                  <li className="py-2 text-xs text-muted-foreground">{t('noneYet')}</li>
                )}
              </ul>
              <form action={actions.createDepartment} className="mt-2 flex items-end gap-2">
                <input type="hidden" name="companyId" value={c.id} />
                <Field label={t('newDepartment')}>
                  <input name="name" required placeholder={t('departmentPlaceholder')} className={inputCls} />
                </Field>
                <Button type="submit" size="sm" variant="outline">
                  {t('add')}
                </Button>
              </form>
            </div>

            <div className="rounded-lg bg-background p-3">
              <SubHeader>{t('positionsCount', { count: positions.length })}</SubHeader>
              <ul className="mt-1 divide-y divide-border/60">
                {positions.map((p) => (
                  <EditableRow
                    key={p.id}
                    id={p.id}
                    display={p.display}
                    sub={p.sub}
                    fields={p.fields}
                    inUse={p.inUse}
                    archived={p.archived}
                    updateAction={actions.updatePosition}
                    archiveAction={actions.archivePosition}
                    deleteAction={actions.deletePosition}
                  />
                ))}
                {positions.length === 0 && <li className="py-2 text-xs text-muted-foreground">{t('noneYet')}</li>}
              </ul>
              <form action={actions.createPosition} className="mt-2 flex items-end gap-2">
                <input type="hidden" name="companyId" value={c.id} />
                <Field label={t('newPosition')}>
                  <input name="title" required placeholder={t('positionPlaceholder')} className={inputCls} />
                </Field>
                <Button type="submit" size="sm" variant="outline">
                  {t('add')}
                </Button>
              </form>
            </div>

            <div className="rounded-lg bg-background p-3">
              <SubHeader>{t('costCentersCount', { count: costCenters.length })}</SubHeader>
              <ul className="mt-1 divide-y divide-border/60">
                {costCenters.map((cc) => (
                  <EditableRow
                    key={cc.id}
                    id={cc.id}
                    display={cc.display}
                    sub={cc.sub}
                    fields={cc.fields}
                    inUse={cc.inUse}
                    archived={cc.archived}
                    updateAction={actions.updateCostCenter}
                    archiveAction={actions.archiveCostCenter}
                    deleteAction={actions.deleteCostCenter}
                  />
                ))}
                {costCenters.length === 0 && (
                  <li className="py-2 text-xs text-muted-foreground">{t('noneYet')}</li>
                )}
              </ul>
              <form action={actions.createCostCenter} className="mt-2 space-y-2">
                <input type="hidden" name="companyId" value={c.id} />
                <div className="flex items-end gap-2">
                  <Field label={t('fieldCode')}>
                    <input name="code" required placeholder={t('costCenterCodePlaceholder')} className={`${inputCls} w-20`} />
                  </Field>
                  <Field label={t('fieldName')}>
                    <input name="name" required placeholder={t('costCenterNamePlaceholder')} className={inputCls} />
                  </Field>
                  <Button type="submit" size="sm" variant="outline">
                    {t('add')}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
