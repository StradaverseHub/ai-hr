'use client';

/**
 * Board 2c1b2fba — PAYROLL › PAY ITEMS ON A DRAFT.
 *
 * The activated record's Pay items section (app/admin/personnel/[employmentId]/page.tsx
 * `payComponentDialogForm` / `payComponentsCard`): the same seven fields from the same Personnel field
 * descriptors (`payroll.pay_items.*`), the same READY catalogue for the draft's company, MYR only, and the
 * same three-way prorate (follow the component / yes / no). Held in the draft's blob
 * (`EmployeeDraftData.payItems`) until Activate writes each line through `setEmploymentPayComponent`, the
 * record's writer, after the employment exists.
 *
 * SHOWN ONLY WHERE THE RECORD SHOWS IT: the wizard renders this only when Payroll is on for the draft's
 * company AND the ready catalogue is not empty (the record's `payComponentsCard` gate).
 *
 * DATES: a new line starts on the Group Join Date and may not start before it. The date boxes carry no
 * `min` of their own (the Personnel form audit refuses a control that overrides its descriptor's
 * metadata); `missingByTab` (`payItemGap`) names a line that starts too early, has no amount above zero or
 * overlaps another line for the same item, and keeps Activate off. Nothing is refused by Save draft. The amount is the string HR typed: it is parsed once,
 * by the writer, at Activate.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card, SectionHeader, inputCls } from '@/components/ui';
import { PersonnelField } from '@/components/personnel-field';
import { personnelControl, personnelInput } from '@/lib/personnel-form-contract';
import type { EmployeeDraftPayItem } from '@/lib/employee-draft-schema';
import { RegisterDialog, RegisterRowActions, newRowKey, type RegisterEditing } from './draft-register';

export type DraftPayComponentOption = { id: string; code: string; name: string };

export function DraftPayItems({
  title,
  items,
  onChange,
  components,
  groupJoinDate,
}: {
  /** `people.wizard.sections.payItems`, pinned equal to `people.detail.payComponentsTitle`. */
  title: string;
  items: EmployeeDraftPayItem[];
  /** Receives the WHOLE list — replaced, never merged. */
  onChange: (next: EmployeeDraftPayItem[]) => void;
  /** READY pay components for the draft's company (`listPayComponents({ readyOnly, companyId })`). */
  components: DraftPayComponentOption[];
  /** The draft's Group Join Date: the default and the earliest start of a line. */
  groupJoinDate: string;
}) {
  const t = useTranslations('people');
  const [editing, setEditing] = useState<RegisterEditing<EmployeeDraftPayItem> | null>(null);
  const componentLabel = (id: string) => {
    const c = components.find((o) => o.id === id);
    return c ? `${c.code} — ${c.name}` : id;
  };
  const prorateLabel = (p: boolean | undefined) =>
    p === true ? t('detail.prorateYes') : p === false ? t('detail.prorateNo') : t('detail.prorateInherit');

  const commit = () => {
    if (!editing) return;
    const next = [...items];
    if (editing.at === null) next.push(editing.draft);
    else next[editing.at] = editing.draft;
    onChange(next);
    setEditing(null);
  };
  const patch = (p: Partial<EmployeeDraftPayItem>) =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...p } } : e));
  const it = editing?.draft;
  const storedComponent = (it?.componentId ?? '').trim();
  const offCatalogue = storedComponent !== '' && !components.some((c) => c.id === storedComponent);

  return (
    <Card id="section-pay-components" className="overflow-hidden" data-draft-pay-items>
      <SectionHeader title={title} count={items.length} />
      <section className="border-t border-border">
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
          <Button
            type="button"
            size="sm"
            onClick={() =>
              setEditing({
                at: null,
                readOnly: false,
                // The record's dialog opens on the first catalogue item, MYR, follow-the-component and the
                // Group Join Date; so does this one.
                draft: { key: newRowKey(items.length), componentId: components[0]?.id ?? '', currency: 'MYR', effectiveFrom: groupJoinDate },
              })
            }
          >
            {t('detail.payComponentAdd')}
          </Button>
        </div>
        {items.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">{t('detail.payComponentNone')}</p>
        ) : (
          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t('detail.payComponent')}</th>
                  <th className="py-2 pr-3 font-medium">{t('detail.colCurrency')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('detail.payComponentAmount')}</th>
                  <th className="py-2 pr-3 font-medium">{t('detail.colStart')}</th>
                  <th className="py-2 pr-3 font-medium">{t('detail.colEnd')}</th>
                  <th className="py-2 pr-3 font-medium">{t('detail.colProrate')}</th>
                  <th className="py-2 pr-3 font-medium">{t('detail.colRemarks')}</th>
                  <th className="py-2 text-right font-medium">{t('detail.emergency.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((m, at) => (
                  <tr key={m.key ?? at} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3">{(m.componentId ?? '').trim() ? componentLabel(m.componentId!) : '—'}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{m.currency || 'MYR'}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-right font-medium tabular-nums">{m.amount || '—'}</td>
                    <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{m.effectiveFrom || groupJoinDate || '—'}</td>
                    <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{m.effectiveTo || '—'}</td>
                    <td className="py-2 pr-3">{prorateLabel(m.prorate)}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{m.remarks || '—'}</td>
                    <td className="py-2">
                      <RegisterRowActions
                        labels={{
                          view: t('detail.emergency.view'),
                          edit: t('detail.emergency.edit'),
                          delete: t('detail.emergency.delete'),
                          confirm: t('detail.emergency.delete'),
                          yes: t('wizard.yes'),
                          no: t('wizard.no'),
                        }}
                        onView={() => setEditing({ at, readOnly: true, draft: m })}
                        onEdit={() => setEditing({ at, readOnly: false, draft: m })}
                        onDelete={() => onChange(items.filter((_, i) => i !== at))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="px-4 pb-4 pt-2 text-xs text-muted-foreground">{t('wizard.hints.payItems')}</p>
      <RegisterDialog
        editing={editing}
        title={editing?.at === null ? t('detail.payComponentAddTitle') : t('detail.payComponentsTitle')}
        closeLabel={t('wizard.close')}
        cancelLabel={t('wizard.cancel')}
        commitLabel={editing?.at === null ? t('detail.payComponentSave') : t('detail.emergency.save')}
        onClose={() => setEditing(null)}
        onCommit={commit}
      >
        {it && (
          <>
            <PersonnelField fieldId="payroll.pay_items.componentname" mode="draft">
              <select {...personnelControl('payroll.pay_items.componentname', 'draft')} className={inputCls}
                value={it.componentId ?? ''} onChange={(e) => patch({ componentId: e.target.value })}>
                {offCatalogue && <option value={storedComponent}>{storedComponent} {t('detail.optionLegacySuffix')}</option>}
                {components.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                ))}
              </select>
            </PersonnelField>
            <PersonnelField fieldId="payroll.pay_items.amount" mode="draft">
              <input {...personnelInput('payroll.pay_items.amount', 'draft')} className={inputCls}
                value={it.amount ?? ''} onChange={(e) => patch({ amount: e.target.value })} />
            </PersonnelField>
            <PersonnelField fieldId="payroll.pay_items.currency" mode="draft">
              <select {...personnelControl('payroll.pay_items.currency', 'draft')} className={inputCls}
                value="MYR" onChange={() => patch({ currency: 'MYR' })}>
                <option value="MYR">MYR</option>
              </select>
            </PersonnelField>
            <PersonnelField fieldId="payroll.pay_items.prorate" mode="draft">
              <select {...personnelControl('payroll.pay_items.prorate', 'draft')} className={inputCls}
                value={it.prorate === true ? 'yes' : it.prorate === false ? 'no' : 'inherit'}
                onChange={(e) => patch({ prorate: e.target.value === 'yes' ? true : e.target.value === 'no' ? false : undefined })}>
                <option value="inherit">{t('detail.prorateInherit')}</option>
                <option value="yes">{t('detail.prorateYes')}</option>
                <option value="no">{t('detail.prorateNo')}</option>
              </select>
            </PersonnelField>
            <PersonnelField fieldId="payroll.pay_items.validfrom" mode="draft">
              <input {...personnelInput('payroll.pay_items.validfrom', 'draft')} className={inputCls}
                value={it.effectiveFrom ?? ''} onChange={(e) => patch({ effectiveFrom: e.target.value })} />
            </PersonnelField>
            <PersonnelField fieldId="payroll.pay_items.validto" mode="draft">
              <input {...personnelInput('payroll.pay_items.validto', 'draft')} className={inputCls}
                value={it.effectiveTo ?? ''} onChange={(e) => patch({ effectiveTo: e.target.value })} />
            </PersonnelField>
            <div className="sm:col-span-2">
              <PersonnelField fieldId="payroll.pay_items.remarks" mode="draft">
                <input {...personnelInput('payroll.pay_items.remarks', 'draft')} className={inputCls}
                  placeholder={t('detail.payComponentRemarksPlaceholder')}
                  value={it.remarks ?? ''} onChange={(e) => patch({ remarks: e.target.value })} />
              </PersonnelField>
            </div>
          </>
        )}
      </RegisterDialog>
    </Card>
  );
}
