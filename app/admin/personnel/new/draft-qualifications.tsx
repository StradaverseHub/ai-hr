'use client';

/**
 * Board 2c1b2fba — THE QUALIFICATION TAB ON A DRAFT.
 *
 * The activated record's register (app/admin/personnel/[employmentId]/page.tsx `qualificationFields` /
 * `qualificationPanel`): the same nine fields from the same Personnel field descriptors
 * (`qualification.academic_and_professional_qualifications.*`), the level from the same
 * `qualificationLevel` catalog with the same legacy-value tolerance, the same table. It lives in the
 * draft's blob (`EmployeeDraftData.qualifications`) until Activate writes each record through
 * `addQualification`, the record's own writer.
 *
 * OPTIONAL, AND AT MOST ONE HIGHEST — the record's rule. Saving a record ticked Highest clears the tick on
 * every other record in this screen's state, as `core/qualifications.ts` moves the marker on the record.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Card, SectionHeader, inputCls } from '@/components/ui';
import { PersonnelField } from '@/components/personnel-field';
import { personnelControl, personnelFormLabel, personnelInput } from '@/lib/personnel-form-contract';
import type { EmployeeDraftQualification } from '@/lib/employee-draft-schema';
import { RegisterDialog, RegisterRowActions, newRowKey, type RegisterEditing } from './draft-register';

type Opt = { value: string; label: string };

/** At most one Highest: the record just saved keeps its tick, every other loses it. Exported for the test. */
export function withSingleHighest(list: EmployeeDraftQualification[], at: number): EmployeeDraftQualification[] {
  if (list[at]?.isHighest !== true) return list;
  return list.map((q, i) => (i !== at && q.isHighest ? { ...q, isHighest: false } : q));
}

export function DraftQualifications({
  title,
  qualifications,
  onChange,
  levelOptions,
}: {
  /** `people.wizard.sections.qualification`, pinned equal to `people.detail.qualification.title`. */
  title: string;
  qualifications: EmployeeDraftQualification[];
  /** Receives the WHOLE list — replaced, never merged. */
  onChange: (next: EmployeeDraftQualification[]) => void;
  /** The `qualificationLevel` catalog, active options only, as the record's dialog reads it. */
  levelOptions: Opt[];
}) {
  const t = useTranslations('people');
  const tRoot = useTranslations();
  const [editing, setEditing] = useState<RegisterEditing<EmployeeDraftQualification> | null>(null);
  const label = (id: string) => personnelFormLabel(id, (key, fallback) => (tRoot.has(key) ? tRoot(key) : fallback));
  const levelLabel = (v: string) => levelOptions.find((o) => o.value === v)?.label ?? v;
  // The record's `qualificationOptionsFor`: a stored level no longer in the active catalog still renders.
  const optionsFor = (q: EmployeeDraftQualification) => {
    const cur = (q.qualification ?? '').trim();
    return cur && !levelOptions.some((o) => o.value === cur)
      ? [...levelOptions, { value: cur, label: `${cur} ${t('detail.optionLegacySuffix')}` }]
      : levelOptions;
  };

  const commit = () => {
    if (!editing) return;
    const next = [...qualifications];
    const at = editing.at === null ? next.length : editing.at;
    next[at] = editing.draft;
    onChange(withSingleHighest(next, at));
    setEditing(null);
  };
  const patch = (p: Partial<EmployeeDraftQualification>) =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...p } } : e));
  const text = (name: 'institute' | 'major' | 'result' | 'fromYm' | 'toYm' | 'graduationDate', fieldId: string, placeholder?: string) => {
    const q = editing!.draft;
    return (
      <PersonnelField fieldId={fieldId} mode="draft">
        <input {...personnelInput(fieldId, 'draft')} className={inputCls} placeholder={placeholder}
          value={q[name] ?? ''} onChange={(e) => patch({ [name]: e.target.value })} />
      </PersonnelField>
    );
  };
  const q = editing?.draft;

  return (
    <Card id="section-qualification" className="overflow-hidden" data-draft-qualifications>
      <SectionHeader title={title} count={qualifications.length} />
      <section className="border-t border-border">
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
          <Button type="button" size="sm"
            onClick={() => setEditing({ at: null, readOnly: false, draft: { key: newRowKey(qualifications.length) } })}>
            {t('detail.qualification.add')}
          </Button>
        </div>
        {qualifications.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">{t('detail.qualification.none')}</p>
        ) : (
          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t('detail.qualification.level')}</th>
                  <th className="py-2 pr-3 font-medium">{t('detail.qualification.institute')}</th>
                  <th className="py-2 pr-3 font-medium">{t('detail.qualification.major')}</th>
                  <th className="py-2 pr-3 font-medium">{t('detail.qualification.graduationDate')}</th>
                  <th className="py-2 pr-3 font-medium">{t('detail.qualification.highestColumn')}</th>
                  <th className="py-2 text-right font-medium">{t('detail.qualification.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {qualifications.map((m, at) => (
                  <tr key={m.key ?? at} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3 font-medium">{(m.qualification ?? '').trim() ? levelLabel(m.qualification!) : <span className="text-muted-foreground">—</span>}</td>
                    <td className="py-2 pr-3">{m.institute || '—'}</td>
                    <td className="py-2 pr-3">{m.major || '—'}</td>
                    <td className="whitespace-nowrap py-2 pr-3">{m.graduationDate || '—'}</td>
                    <td className="py-2 pr-3">{m.isHighest ? <Badge variant="success">{t('detail.qualification.highestBadge')}</Badge> : '—'}</td>
                    <td className="py-2">
                      <RegisterRowActions
                        labels={{
                          view: t('detail.qualification.view'),
                          edit: t('detail.qualification.edit'),
                          delete: t('detail.qualification.delete'),
                          confirm: t('detail.qualification.deleteConfirmTitle'),
                          yes: t('wizard.yes'),
                          no: t('wizard.no'),
                        }}
                        onView={() => setEditing({ at, readOnly: true, draft: m })}
                        onEdit={() => setEditing({ at, readOnly: false, draft: m })}
                        onDelete={() => onChange(qualifications.filter((_, i) => i !== at))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="px-4 pb-4 pt-2 text-xs text-muted-foreground">{t('detail.qualification.hint')}</p>
      <RegisterDialog
        editing={editing}
        title={
          editing?.readOnly
            ? t('detail.qualification.viewTitle')
            : editing?.at === null
              ? t('detail.qualification.addTitle')
              : t('detail.qualification.editTitle')
        }
        closeLabel={t('wizard.close')}
        cancelLabel={t('wizard.cancel')}
        commitLabel={editing?.at === null ? t('detail.qualification.add') : t('detail.qualification.save')}
        onClose={() => setEditing(null)}
        onCommit={commit}
      >
        {q && (
          <>
            <PersonnelField fieldId={'qualification.academic_and_professional_qualifications.level'} mode="draft">
              <select {...personnelControl('qualification.academic_and_professional_qualifications.level', 'draft')} className={inputCls}
                value={q.qualification ?? ''} onChange={(e) => patch({ qualification: e.target.value })}>
                <option value="">{t('detail.qualification.levelPlaceholder')}</option>
                {optionsFor(q).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </PersonnelField>
            {text('institute', 'qualification.academic_and_professional_qualifications.institute')}
            {text('fromYm', 'qualification.academic_and_professional_qualifications.fromym')}
            {text('toYm', 'qualification.academic_and_professional_qualifications.toym')}
            {text('graduationDate', 'qualification.academic_and_professional_qualifications.graduationdate')}
            {text('major', 'qualification.academic_and_professional_qualifications.major')}
            {text('result', 'qualification.academic_and_professional_qualifications.result', t('detail.qualification.resultPlaceholder'))}
            <div className="sm:col-span-2">
              <PersonnelField fieldId={'qualification.academic_and_professional_qualifications.description'} mode="draft">
                <textarea {...personnelControl('qualification.academic_and_professional_qualifications.description', 'draft')} rows={2}
                  className={`${inputCls.replace('h-9', 'min-h-16')} py-2`}
                  value={q.description ?? ''} onChange={(e) => patch({ description: e.target.value })} />
              </PersonnelField>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 self-end pb-1 sm:col-span-2">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input {...personnelInput('qualification.academic_and_professional_qualifications.highest', 'draft')} checked={q.isHighest === true}
                  onChange={(e) => patch({ isHighest: e.target.checked })} />
                {label('qualification.academic_and_professional_qualifications.highest')}
              </label>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">{t('detail.qualification.highestHint')}</p>
          </>
        )}
      </RegisterDialog>
    </Card>
  );
}
