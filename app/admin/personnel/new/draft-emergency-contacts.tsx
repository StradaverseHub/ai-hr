'use client';

/**
 * Board 2c1b2fba — EMERGENCY CONTACT ON A DRAFT, the Profile tab's register.
 *
 * The SAME list the activated record keeps (app/admin/personnel/[employmentId]/page.tsx `emergencyFields`
 * and `emergencyContactPanel`): the same seven fields, read from the same Personnel field descriptors
 * (`profile.emergency_contact.*`, so the captions are the record's), the same relationship catalog, the
 * same priority choices and the same table columns. What differs is only where the list lives: in the
 * draft's own blob (`EmployeeDraftData.emergencyContacts`) until Activate writes each contact through
 * `addEmergencyContact` — the record's writer — after the person exists.
 *
 * ONE PRIMARY, AS ON THE RECORD: choosing Primary on one contact demotes any other Primary to Secondary in
 * this screen's state, which is what `core/emergency-contacts.ts` does to the record. `missingByTab` still
 * names a list with two Primaries (a hand-edited blob), and the server re-runs that rule.
 *
 * NOTHING HERE VALIDATES BEYOND WHAT A DRAFT ALLOWS: a contact saved without a name is listed as still
 * needed (`missingByTab` → `emergencyContacts`), never refused by Save draft.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Card, SectionHeader, inputCls } from '@/components/ui';
import { PersonnelField } from '@/components/personnel-field';
import { ProfileOptionSelectControlled } from '@/components/profile-option-select';
import { personnelControl, personnelFormChoices, personnelInput } from '@/lib/personnel-form-contract';
import type { EmployeeDraftEmergencyContact } from '@/lib/employee-draft-schema';
import { RegisterDialog, RegisterRowActions, newRowKey, type RegisterEditing } from './draft-register';

type Opt = { value: string; label: string };

/** The record's rule, applied to the list as it will be stored: a contact saved as Primary demotes every
 *  OTHER Primary to Secondary. Exported for the screen test. */
export function withSinglePrimary(list: EmployeeDraftEmergencyContact[], at: number): EmployeeDraftEmergencyContact[] {
  if ((list[at]?.priority ?? '').trim() !== 'primary') return list;
  return list.map((c, i) => (i !== at && (c.priority ?? '').trim() === 'primary' ? { ...c, priority: 'secondary' } : c));
}

export function DraftEmergencyContacts({
  title,
  contacts,
  onChange,
  relationshipOptions,
}: {
  /** `people.wizard.sections.emergencyContact`, pinned equal to the record's `people.detail.emergencyTitle`. */
  title: string;
  contacts: EmployeeDraftEmergencyContact[];
  /** Receives the WHOLE list — a list is replaced, never merged (the `setFamily` rule). */
  onChange: (next: EmployeeDraftEmergencyContact[]) => void;
  /** The `relationship` catalog, active options only, as the record's dialog reads it. */
  relationshipOptions: Opt[];
}) {
  const t = useTranslations('people');
  const tRoot = useTranslations();
  const [editing, setEditing] = useState<RegisterEditing<EmployeeDraftEmergencyContact> | null>(null);

  // Static literal keys per priority (the record's `emergencyPriorityLabel`), never a computed key.
  const priorityLabel = (p: string) => {
    switch (p) {
      case 'primary': return t('detail.emergency.priorityPrimary');
      case 'secondary': return t('detail.emergency.prioritySecondary');
      case 'other': return t('detail.emergency.priorityOther');
      default: return p || '—';
    }
  };
  const relationshipLabel = (v: string) => relationshipOptions.find((o) => o.value === v)?.label ?? v;

  const commit = () => {
    if (!editing) return;
    const next = [...contacts];
    const at = editing.at === null ? next.length : editing.at;
    next[at] = editing.draft;
    onChange(withSinglePrimary(next, at));
    setEditing(null);
  };
  const patch = (p: Partial<EmployeeDraftEmergencyContact>) =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...p } } : e));
  const taCls = `${inputCls.replace('h-9', 'min-h-16')} py-2`;
  const c = editing?.draft;

  return (
    <Card id="section-emergency-contact" className="overflow-hidden" data-draft-emergency-contacts>
      <SectionHeader title={title} count={contacts.length} />
      <section className="border-t border-border">
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
          <Button
            type="button"
            size="sm"
            onClick={() => setEditing({ at: null, readOnly: false, draft: { key: newRowKey(contacts.length), priority: 'other' } })}
          >
            {t('detail.emergency.add')}
          </Button>
        </div>
        {contacts.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">{t('detail.emergency.none')}</p>
        ) : (
          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t('detail.emergency.name')}</th>
                  <th className="py-2 pr-3 font-medium">{t('detail.emergency.relationship')}</th>
                  <th className="py-2 pr-3 font-medium">{t('detail.emergency.mobilePhone')}</th>
                  <th className="py-2 pr-3 font-medium">{t('detail.emergency.homePhone')}</th>
                  <th className="py-2 pr-3 font-medium">{t('detail.emergency.priority')}</th>
                  <th className="py-2 text-right font-medium">{t('detail.emergency.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((m, at) => (
                  <tr key={m.key ?? at} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3 font-medium">{(m.fullName ?? '').trim() || <span className="text-muted-foreground">—</span>}</td>
                    <td className="py-2 pr-3">{(m.relationship ?? '').trim() ? relationshipLabel(m.relationship!) : '—'}</td>
                    <td className="whitespace-nowrap py-2 pr-3">{m.mobilePhone || '—'}</td>
                    <td className="whitespace-nowrap py-2 pr-3">{m.homePhone || '—'}</td>
                    <td className="py-2 pr-3">
                      {m.priority === 'primary' ? (
                        <Badge variant="success">{t('detail.emergency.priorityPrimary')}</Badge>
                      ) : (
                        priorityLabel(m.priority ?? '')
                      )}
                    </td>
                    <td className="py-2">
                      <RegisterRowActions
                        labels={{
                          view: t('detail.emergency.view'),
                          edit: t('detail.emergency.edit'),
                          delete: t('detail.emergency.delete'),
                          confirm: t('detail.emergency.deleteConfirmTitle'),
                          yes: t('wizard.yes'),
                          no: t('wizard.no'),
                        }}
                        onView={() => setEditing({ at, readOnly: true, draft: m })}
                        onEdit={() => setEditing({ at, readOnly: false, draft: m })}
                        onDelete={() => onChange(contacts.filter((_, i) => i !== at))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <RegisterDialog
        editing={editing}
        title={
          editing?.readOnly
            ? t('detail.emergency.viewTitle')
            : editing?.at === null
              ? t('detail.emergency.addTitle')
              : t('detail.emergency.editTitle')
        }
        closeLabel={t('wizard.close')}
        cancelLabel={t('wizard.cancel')}
        commitLabel={editing?.at === null ? t('detail.emergency.add') : t('detail.emergency.save')}
        onClose={() => setEditing(null)}
        onCommit={commit}
      >
        {c && (
          <>
            <PersonnelField fieldId="profile.emergency_contact.fullname" mode="draft">
              <input {...personnelInput('profile.emergency_contact.fullname', 'draft')} className={inputCls}
                value={c.fullName ?? ''} onChange={(e) => patch({ fullName: e.target.value })} />
            </PersonnelField>
            <PersonnelField fieldId="profile.emergency_contact.relationship" mode="draft">
              <ProfileOptionSelectControlled
                personnelFieldId={"profile.emergency_contact.relationship"}
                value={c.relationship}
                options={relationshipOptions}
                placeholder={t('detail.optionNotSet')}
                legacySuffix={t('detail.optionLegacySuffix')}
                onChange={(relationship) => patch({ relationship })}
              />
            </PersonnelField>
            <PersonnelField fieldId="profile.emergency_contact.mobilephone" mode="draft">
              <input {...personnelInput('profile.emergency_contact.mobilephone', 'draft')} className={inputCls}
                value={c.mobilePhone ?? ''} onChange={(e) => patch({ mobilePhone: e.target.value })} />
            </PersonnelField>
            <PersonnelField fieldId="profile.emergency_contact.homephone" mode="draft">
              <input {...personnelInput('profile.emergency_contact.homephone', 'draft')} className={inputCls}
                value={c.homePhone ?? ''} onChange={(e) => patch({ homePhone: e.target.value })} />
            </PersonnelField>
            <PersonnelField fieldId="profile.emergency_contact.priority" mode="draft">
              <select {...personnelControl('profile.emergency_contact.priority', 'draft')} className={inputCls}
                value={c.priority || 'other'} onChange={(e) => patch({ priority: e.target.value })}>
                {personnelFormChoices('profile.emergency_contact.priority').map(({ value, labelKey }) => (
                  <option key={value} value={value}>{tRoot(labelKey)}</option>
                ))}
              </select>
            </PersonnelField>
            <div className="sm:col-span-2">
              <PersonnelField fieldId="profile.emergency_contact.address" mode="draft">
                <textarea {...personnelControl('profile.emergency_contact.address', 'draft')} rows={3} className={taCls}
                  value={c.address ?? ''} onChange={(e) => patch({ address: e.target.value })} />
              </PersonnelField>
            </div>
            <div className="sm:col-span-2">
              <PersonnelField fieldId="profile.emergency_contact.remarks" mode="draft">
                <textarea {...personnelControl('profile.emergency_contact.remarks', 'draft')} rows={2} className={taCls}
                  value={c.remarks ?? ''} onChange={(e) => patch({ remarks: e.target.value })} />
              </PersonnelField>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">{t('detail.emergency.primaryHint')}</p>
          </>
        )}
      </RegisterDialog>
    </Card>
  );
}
