import { getTranslations } from 'next-intl/server';
import { Card, ErrorBanner, Field, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import type { SessionContext } from '@/db/client';
import { rewardSetupGrantAdministration } from '@/packs/rewards/access-policy';
import { rewardGroupRoleDirectory, wholeGroupRewardRoles } from '@/packs/rewards/group-roles';
import { saveRewardGroupRoleAction } from './group-role-actions';

export async function WholeGroupRoles({ session, error }: { session: SessionContext; error?: string }) {
  const [directory, { users }, t, roles] = await Promise.all([
    rewardGroupRoleDirectory(session),
    rewardSetupGrantAdministration(session),
    getTranslations('rewardsAccess.wholeGroup'),
    getTranslations('rewards.roles'),
  ]);
  const people = users.filter(user => user.active && user.id !== session.userId);

  return <Card id="whole-group-roles">
    <SectionHeader title={t('title')} />
    <div className="space-y-4 p-4">
      <ErrorBanner message={error} />
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <form action={saveRewardGroupRoleAction} className="grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="operation" value="grant" />
        <input type="hidden" name="revision" value="0" />
        <Field label={t('person')}>
          <select name="userId" className={inputCls} required defaultValue="">
            <option value="" disabled>—</option>
            {people.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </Field>
        <Field label={t('role')}>
          <select name="role" className={inputCls}>
            {wholeGroupRewardRoles.map(role => <option key={role} value={role}>{roles(role)}</option>)}
          </select>
        </Field>
        <Field label={t('reason')}>
          <input name="reason" className={inputCls} minLength={10} maxLength={2000} required />
        </Field>
        <button className={btnPrimary} type="submit">{t('grant')}</button>
      </form>
      {directory.map(row => (
        <div key={row.userId + ':' + row.role} className="space-y-2 border-t py-3">
          <p className="text-sm">{row.name} · {roles(row.role)} · {t('scope')} · {t(row.active ? row.eligible ? 'active' : 'suspended' : 'inactive')}</p>
          {row.userId !== session.userId && (row.active || row.eligible) &&
            <form action={saveRewardGroupRoleAction} className="flex items-end gap-2">
              <input type="hidden" name="userId" value={row.userId} />
              <input type="hidden" name="role" value={row.role} />
              <input type="hidden" name="revision" value={row.revision} />
              <input type="hidden" name="operation" value={row.active ? 'revoke' : 'grant'} />
              <Field label={t('reason')}>
                <input name="reason" className={inputCls} minLength={10} maxLength={2000} required />
              </Field>
              <button type="submit" className={btnPrimary}>{t(row.active ? 'revoke' : 'grant')}</button>
            </form>}
        </div>
      ))}
    </div>
  </Card>;
}
