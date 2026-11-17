import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import { tagCatalog } from '@/packs/recruitment/service';
import { saveTagAction, saveTagGroupAction } from '../actions';

/**
 * Settings › Tags (slice 5, administrators): tag groups and manual tags. A name is unique within its group. A disabled
 * tag stays on the candidates who carry it but is no longer offered. There are no inferred ("smart") tags.
 */
export async function TagSettingsSection({ s, companyId, here }: { s: SessionContext; companyId: string; here: string }) {
  const [t, catalog] = await Promise.all([getTranslations('recruitment.settings.tags'), tagCatalog(s, companyId)]);
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t('note')}</p>
      {catalog.groups.length === 0 && <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p>}
      {catalog.groups.map((g) => (
        <section key={g.id} className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label={g.name}>
          <form action={saveTagGroupAction} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            {hidden('groupId', g.id)}{hidden('returnTo', here)}
            <Field label={t('groupName')}><Input name="name" defaultValue={g.name} maxLength={60} required /></Field>
            <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={g.enabled} />{t('enabled')}</label>
            <button type="submit" className={btnGhost}>{t('save')}</button>
          </form>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {g.tags.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">{t('noTags')}</li>}
            {g.tags.map((tag) => (
              <li key={tag.id} className="px-3 py-2">
                <form action={saveTagAction} className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center">
                  {hidden('tagId', tag.id)}{hidden('returnTo', here)}
                  <Input name="name" defaultValue={tag.name} maxLength={60} required aria-label={t('tagName')} />
                  <span className="text-xs text-muted-foreground">{t('used', { n: tag.used })}</span>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={tag.enabled} />{t('enabled')}</label>
                  <button type="submit" className={btnGhost}>{t('save')}</button>
                </form>
              </li>
            ))}
          </ul>
          <form action={saveTagAction} className="flex flex-wrap items-end gap-2">
            {hidden('groupId', g.id)}{hidden('returnTo', here)}
            <Field label={t('newTag')} className="min-w-56"><Input name="name" maxLength={60} required /></Field>
            <button type="submit" className={btnGhost}>{t('addTag')}</button>
          </form>
        </section>
      ))}
      <form action={saveTagGroupAction} className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-border p-4">
        {hidden('companyId', companyId)}{hidden('returnTo', here)}
        <Field label={t('newGroup')} className="min-w-56"><Input name="name" maxLength={60} required /></Field>
        <button type="submit" className={btnPrimary}>{t('addGroup')}</button>
      </form>
    </div>
  );
}
