import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import { cn } from '@/lib/utils';
import { poolSettings, POOL_DESCRIPTION_MAX, POOL_NAME_MAX, POOL_SHARING, type PoolSettings, type PoolSettingsRow } from '@/packs/recruitment/service';
import { deletePoolAction, savePoolAction } from '../actions';
import { klDateTime, selectCls } from '../shared';

type T = Awaited<ReturnType<typeof getTranslations<'recruitment.pools.settings'>>>;

/**
 * Settings › Talent pools (slice 13, administrators): the company's custom pools and sub-pools (two levels), each with a
 * description and sharing — all recruiters, or only listed users (a sub-pool follows its pool, D-050). Deleting a pool removes
 * its memberships, never the candidates; a pool with sub-pools is deleted after them. The public pool (slice 4) is unchanged.
 */
export async function PoolSettingsSection({ s, companyId, here }: { s: SessionContext; companyId: string; here: string }) {
  const [t, settings, locale] = await Promise.all([getTranslations('recruitment.pools.settings'), poolSettings(s, companyId), getLocale()]);
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('note')}</p>
      {settings.pools.length === 0 && <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p>}
      <ul className="space-y-4">
        {settings.pools.map((pool) => (
          <li key={pool.id} className="space-y-3 rounded-xl border border-border bg-card p-4">
            <PoolForm pool={pool} settings={settings} here={here} t={t} locale={locale} topLevel />
            {pool.children.length > 0 && (
              <ul className="space-y-3 border-l-2 border-border pl-4" aria-label={t('subPools', { pool: pool.name })}>
                {pool.children.map((sub) => (
                  <li key={sub.id} className="space-y-2 rounded-lg border border-border p-3">
                    <PoolForm pool={sub} settings={settings} here={here} t={t} locale={locale} parentName={pool.name} />
                  </li>
                ))}
              </ul>
            )}
            <form action={savePoolAction} className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
              {hidden('companyId', companyId)}{hidden('parentId', pool.id)}{hidden('returnTo', here)}
              <Field label={t('subPoolName')} required requiredAriaLabel={t('required')}><Input name="name" maxLength={POOL_NAME_MAX} required /></Field>
              <Field label={t('description')}><Input name="description" maxLength={POOL_DESCRIPTION_MAX} /></Field>
              <button type="submit" className={btnGhost}>{t('addSubPool')}</button>
            </form>
          </li>
        ))}
      </ul>
      <form action={savePoolAction} className="space-y-3 rounded-xl border border-dashed border-border p-4">
        {hidden('companyId', companyId)}{hidden('parentId', '')}{hidden('returnTo', here)}
        <h2 className="text-sm font-semibold">{t('newPool')}</h2>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <Field label={t('name')} required requiredAriaLabel={t('required')}><Input name="name" maxLength={POOL_NAME_MAX} required /></Field>
          <Field label={t('description')}><Input name="description" maxLength={POOL_DESCRIPTION_MAX} /></Field>
        </div>
        <SharingFields settings={settings} t={t} sharing="all_recruiters" shared={[]} idPrefix="new" />
        <button type="submit" className={btnPrimary}>{t('addPool')}</button>
      </form>
    </div>
  );
}

function SharingFields({ settings, t, sharing, shared, idPrefix }: { settings: PoolSettings; t: T; sharing: string; shared: string[]; idPrefix: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium text-muted-foreground">{t('sharing')}</legend>
        {POOL_SHARING.map((v) => (
          <label key={v} className="flex items-center gap-2 text-sm">
            <input type="radio" name="sharing" value={v} defaultChecked={sharing === v} className="accent-primary" />{t(`sharingOptions.${v}`)}
          </label>
        ))}
      </fieldset>
      <Field label={t('listedUsers')}>
        <select id={`${idPrefix}-users`} name="sharedUserIds" multiple defaultValue={shared} size={Math.min(6, Math.max(3, settings.users.length))} className={cn(selectCls, 'h-auto')}>
          {settings.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <span className="text-xs text-muted-foreground">{t('listedHint')}</span>
      </Field>
    </div>
  );
}

function PoolForm({ pool, settings, here, t, locale, topLevel = false, parentName }: {
  pool: PoolSettingsRow & { children?: PoolSettingsRow[] }; settings: PoolSettings; here: string; t: T; locale: string; topLevel?: boolean; parentName?: string;
}) {
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const children = pool.children?.length ?? 0;
  return (
    <>
      <form action={savePoolAction} className="space-y-3">
        {hidden('poolId', pool.id)}{hidden('returnTo', here)}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
          <Field label={topLevel ? t('name') : t('subPoolLabel')}><Input name="name" defaultValue={pool.name} maxLength={POOL_NAME_MAX} required /></Field>
          <Field label={t('description')}><Input name="description" defaultValue={pool.description ?? ''} maxLength={POOL_DESCRIPTION_MAX} /></Field>
          {!topLevel && <button type="submit" className={btnGhost}>{t('save')}</button>}
        </div>
        {topLevel ? (
          <>
            <SharingFields settings={settings} t={t} sharing={pool.sharing} shared={pool.sharedWith.map((u) => u.id)} idPrefix={pool.id} />
            <button type="submit" className={btnGhost}>{t('save')}</button>
          </>
        ) : <p className="text-xs text-muted-foreground">{t('subPoolSharing', { pool: parentName ?? '' })}</p>}
      </form>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{t('members', { n: pool.members })}</span>
        {topLevel && <span>{t(`sharingOptions.${pool.sharing}`)}{pool.sharing === 'listed_users' && pool.sharedWith.length > 0
          ? `: ${pool.sharedWith.map((u) => u.name ?? t('unnamedUser')).join(', ')}` : ''}</span>}
        <span>{t('changed', { by: pool.updatedBy ?? t('unnamedUser'), at: klDateTime(locale, pool.updatedAt) })}</span>
        {children > 0 ? <span>{t('hasSubpools')}</span> : (
          <form action={deletePoolAction}>
            {hidden('poolId', pool.id)}{hidden('returnTo', here)}
            <button type="submit" className="text-destructive hover:underline">{t('delete')}</button>
          </form>
        )}
      </div>
    </>
  );
}
