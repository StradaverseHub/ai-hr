'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';

type PersonOption = { id: string; name: string | null; code?: string | null };
/** Both enrollment methods share the same explicit target and grant choices. */
export function AccountTargetFields({ people, companies, roles, selectedPerson, idPrefix, children }: {
  people: PersonOption[];
  companies: { id: string; name: string }[];
  roles: { value: string; label: string }[];
  selectedPerson?: PersonOption;
  idPrefix: 'manual' | 'invite';
  children?: ReactNode;
}) {
  const t = useTranslations('admin.users.accountTarget');
  const [kind, setKind] = useState('existing');
  return <>
    {selectedPerson ? <>
      <input type="hidden" name="accountType" value="existing" />
      <Field label={t('existing')}><input type="hidden" name="personId" value={selectedPerson.id} />
        <span className="py-2 text-sm">{selectedPerson.name}</span>
        <a href={idPrefix === 'manual' ? '/admin/users/create' : '/admin/users/invite'} className="text-xs underline">{t('chooseAnother')}</a>
      </Field>
    </> : <>
      <fieldset className="space-y-2 sm:col-span-2" aria-describedby={`${idPrefix}-target-help`}>
        <legend className="mb-2 text-sm font-medium">{t('title')}</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="accountType" value="existing" checked={kind === 'existing'} onChange={() => setKind('existing')} />{t('existing')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="accountType" value="standalone" checked={kind === 'standalone'} onChange={() => setKind('standalone')} />{t('standalone')}</label>
        </div>
        <p id={`${idPrefix}-target-help`} className="text-xs text-muted-foreground">{t(kind === 'standalone' ? 'standaloneHelp' : 'existingHelp')}</p>
      </fieldset>
      {kind === 'standalone' ? <Field label={t('fullName')}><input name="fullName" required maxLength={200} autoComplete="name" className={inputCls} /></Field> :
        <Field label={t('person')}><select name="personId" required defaultValue="" className={inputCls}>
          <option value="" disabled>{t('choosePerson')}</option>
          {people.map(p => <option key={p.id} value={p.id}>{p.name}{p.code ? ` · ${p.code}` : ''}</option>)}
        </select></Field>}
    </>}
    {children}
    <Field label={t('role')}><select key={kind} name="role" required defaultValue={kind === 'standalone' ? '' : 'employee'} className={inputCls}>
      <option value="" disabled>{t('chooseRole')}</option>
      {roles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
    </select></Field>
    <Field label={t('scope')}><select key={kind} name="companyId" required={kind==='standalone'} defaultValue={kind==='standalone'?'':'group'} className={inputCls}>
      <option value="" disabled>{t('chooseScope')}</option>
      <option value="group">{t('groupWide')}</option>
      {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select></Field>
  </>;
}
