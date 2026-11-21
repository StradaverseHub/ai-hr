import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import { backgroundCheckTypes, CHECK_TYPE_DESCRIPTION_MAX, CHECK_TYPE_NAME_MAX, DEFAULT_CHECK_TYPES } from '@/packs/recruitment/service';
import { addDefaultBackgroundCheckTypesAction, deleteBackgroundCheckTypeAction, saveBackgroundCheckTypeAction } from '../actions';
import { klDateTime } from '../shared';

/**
 * Settings › Background checks (slice 12, administrators): the company's check types. A company with none is offered the six
 * defaults (added only when an administrator chooses to). A type in use can be disabled, not deleted. AI HR records checks run
 * outside it: there is no provider connection (D-043).
 */
export async function BackgroundCheckSettingsSection({ s, companyId, here }: { s: SessionContext; companyId: string; here: string }) {
  const [t, catalog, locale] = await Promise.all([getTranslations('recruitment.checks.settings'), backgroundCheckTypes(s, companyId), getLocale()]);
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('note')}</p>
      {catalog.defaultsOffered && (
        <section aria-labelledby="check-defaults-title" className="space-y-3 rounded-xl border border-dashed border-border p-4">
          <h2 id="check-defaults-title" className="text-sm font-semibold">{t('defaultsTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('defaultsNote')}</p>
          <ul className="flex flex-wrap gap-2 text-xs">
            {DEFAULT_CHECK_TYPES.map((d) => <li key={d.seedKey} className="rounded-full border border-border px-2 py-1">{t(`defaults.${d.seedKey}` as 'defaults.identity')}</li>)}
          </ul>
          <form action={addDefaultBackgroundCheckTypesAction}>
            {hidden('companyId', companyId)}{hidden('returnTo', here)}
            <button type="submit" className={btnPrimary}>{t('addDefaults')}</button>
          </form>
        </section>
      )}
      {catalog.types.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {catalog.types.map((type) => (
            <li key={type.id} className="space-y-2 px-4 py-3">
              <form action={saveBackgroundCheckTypeAction} className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto_auto] sm:items-end">
                {hidden('typeId', type.id)}{hidden('returnTo', here)}{hidden('enabledField', '1')}
                <Field label={t('name')}><Input name="name" defaultValue={type.name} maxLength={CHECK_TYPE_NAME_MAX} required /></Field>
                <Field label={t('description')}><Input name="description" defaultValue={type.description ?? ''} maxLength={CHECK_TYPE_DESCRIPTION_MAX} /></Field>
                <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={type.enabled} className="accent-primary" />{t('enabled')}</label>
                <button type="submit" className={btnGhost}>{t('save')}</button>
              </form>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{t('used', { n: type.used })}</span>
                <span>{t('changed', { by: type.updatedBy ?? t('unnamedUser'), at: klDateTime(locale, type.updatedAt) })}</span>
                {type.used === 0 ? (
                  <form action={deleteBackgroundCheckTypeAction}>
                    {hidden('typeId', type.id)}{hidden('returnTo', here)}
                    <button type="submit" className="text-destructive hover:underline">{t('delete')}</button>
                  </form>
                ) : <span>{t('inUseNote')}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form action={saveBackgroundCheckTypeAction} className="grid gap-3 rounded-xl border border-dashed border-border p-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
        {hidden('companyId', companyId)}{hidden('returnTo', here)}
        <Field label={t('newType')} required requiredAriaLabel={t('required')}><Input name="name" maxLength={CHECK_TYPE_NAME_MAX} required /></Field>
        <Field label={t('description')}><Input name="description" maxLength={CHECK_TYPE_DESCRIPTION_MAX} /></Field>
        <button type="submit" className={btnPrimary}>{t('addType')}</button>
      </form>
    </div>
  );
}
