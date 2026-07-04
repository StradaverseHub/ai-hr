'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from './ui';
import { EditableRow } from './editable-row';

type Action = (fd: FormData) => void | Promise<void>;

/** One catalog row for the System Labels page. `fields` includes the new wide `description` field so the
 *  inline editor can edit it; `sub` shows the description (or a fallback) in the collapsed row. */
export type LabelRow = {
  id: string;
  display: string;
  sub?: string | null;
  fields: { name: string; label: string; value: string; options?: { value: string; label: string }[]; wide?: boolean }[];
  inUse: boolean;
  archived: boolean;
};

function SubHeader({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

const badgeMuted =
  'rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground';

/**
 * System Labels — the relocated org-catalog CRUD surface (moved off the Organization page). One legal entity
 * as an expandable panel holding its four catalogs: Departments, Positions, Cost Centers, Business Units.
 * Each supports the new optional description field on both the inline editor (via EditableRow's wide field)
 * and the add-form. Company/legal/bank details stay on the Organization page — this is only the labels.
 */
export function SystemLabelsPanel({
  company,
  departments,
  positions,
  costCenters,
  businessUnits,
  buOptions,
  actions,
}: {
  company: { id: string; name: string; country: string; archivedAt: Date | null };
  departments: LabelRow[];
  positions: LabelRow[];
  costCenters: LabelRow[];
  businessUnits: LabelRow[];
  buOptions: { value: string; label: string }[];
  actions: {
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
    createBusinessUnit: Action;
    updateBusinessUnit: Action;
    archiveBusinessUnit: Action;
  };
}) {
  const t = useTranslations('admin.systemLabels');
  const to = useTranslations('admin.organization');
  const [expanded, setExpanded] = useState(false);
  const c = company;
  // Active (non-archived) BUs only for the department add-form dropdown.
  const activeBuOptions = buOptions.filter((o) => o.value !== '');

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
          <span className={badgeMuted}>{c.country}</span>
          {c.archivedAt && <span className={badgeMuted}>{to('archived')}</span>}
        </button>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {t('countSummary', {
            dept: departments.length,
            pos: positions.length,
            cc: costCenters.length,
            bu: businessUnits.length,
          })}
        </span>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-border/60 bg-muted/20 px-4 py-4">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {/* Departments */}
            <div className="rounded-lg bg-background p-3">
              <SubHeader>{to('departmentsCount', { count: departments.length })}</SubHeader>
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
                  <li className="py-2 text-xs text-muted-foreground">{to('noneYet')}</li>
                )}
              </ul>
              <form action={actions.createDepartment} className="mt-2 flex flex-wrap items-end gap-2">
                <input type="hidden" name="companyId" value={c.id} />
                <Field label={to('newDepartment')}>
                  <input name="name" required placeholder={to('departmentPlaceholder')} className={inputCls} />
                </Field>
                <Field label={to('fieldBusinessUnit')}>
                  <select name="businessUnitId" defaultValue="" className={inputCls}>
                    <option value="">{to('businessUnitNone')}</option>
                    {activeBuOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('fieldDescription')}>
                  <input name="description" placeholder={t('descriptionPlaceholder')} className={`${inputCls} w-56`} />
                </Field>
                <Button type="submit" size="sm" variant="outline">
                  {to('add')}
                </Button>
              </form>
            </div>

            {/* Positions */}
            <div className="rounded-lg bg-background p-3">
              <SubHeader>{to('positionsCount', { count: positions.length })}</SubHeader>
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
                {positions.length === 0 && <li className="py-2 text-xs text-muted-foreground">{to('noneYet')}</li>}
              </ul>
              <form action={actions.createPosition} className="mt-2 flex flex-wrap items-end gap-2">
                <input type="hidden" name="companyId" value={c.id} />
                <Field label={to('newPosition')}>
                  <input name="title" required placeholder={to('positionPlaceholder')} className={inputCls} />
                </Field>
                <Field label={to('fieldJobFamily')}>
                  <input name="jobFamily" className={`${inputCls} w-32`} />
                </Field>
                <Field label={t('fieldDescription')}>
                  <input name="description" placeholder={t('descriptionPlaceholder')} className={`${inputCls} w-56`} />
                </Field>
                <Button type="submit" size="sm" variant="outline">
                  {to('add')}
                </Button>
              </form>
            </div>

            {/* Cost centers */}
            <div className="rounded-lg bg-background p-3">
              <SubHeader>{to('costCentersCount', { count: costCenters.length })}</SubHeader>
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
                  <li className="py-2 text-xs text-muted-foreground">{to('noneYet')}</li>
                )}
              </ul>
              <form action={actions.createCostCenter} className="mt-2 flex flex-wrap items-end gap-2">
                <input type="hidden" name="companyId" value={c.id} />
                <Field label={to('fieldCode')}>
                  <input name="code" required placeholder={to('costCenterCodePlaceholder')} className={`${inputCls} w-20`} />
                </Field>
                <Field label={to('fieldName')}>
                  <input name="name" required placeholder={to('costCenterNamePlaceholder')} className={inputCls} />
                </Field>
                <Field label={t('fieldDescription')}>
                  <input name="description" placeholder={t('descriptionPlaceholder')} className={`${inputCls} w-56`} />
                </Field>
                <Button type="submit" size="sm" variant="outline">
                  {to('add')}
                </Button>
              </form>
            </div>
          </div>

          {/* Business units — flat catalog (ADR-0068); departments link to a BU. */}
          <div className="rounded-lg bg-background p-3">
            <SubHeader>{to('businessUnitsCount', { count: businessUnits.length })}</SubHeader>
            <ul className="mt-1 divide-y divide-border/60">
              {businessUnits.map((bu) => (
                <EditableRow
                  key={bu.id}
                  id={bu.id}
                  display={bu.display}
                  sub={bu.sub}
                  fields={bu.fields}
                  inUse={bu.inUse}
                  archived={bu.archived}
                  updateAction={actions.updateBusinessUnit}
                  archiveAction={actions.archiveBusinessUnit}
                />
              ))}
              {businessUnits.length === 0 && (
                <li className="py-2 text-xs text-muted-foreground">{to('noneYet')}</li>
              )}
            </ul>
            <form action={actions.createBusinessUnit} className="mt-2 flex flex-wrap items-end gap-2">
              <input type="hidden" name="companyId" value={c.id} />
              <Field label={to('fieldCode')}>
                <input name="code" required placeholder={to('businessUnitCodePlaceholder')} className={`${inputCls} w-20`} />
              </Field>
              <Field label={to('fieldName')}>
                <input name="name" required placeholder={to('businessUnitNamePlaceholder')} className={inputCls} />
              </Field>
              <Field label={t('fieldDescription')}>
                <input name="description" placeholder={t('descriptionPlaceholder')} className={`${inputCls} w-56`} />
              </Field>
              <Button type="submit" size="sm" variant="outline">
                {to('add')}
              </Button>
            </form>
          </div>
        </div>
      )}
    </li>
  );
}
