import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listUsers } from '@/core/admin';
import { adminCompanies, listCompanies } from '@/core/read';
import { Avatar, Card, ErrorBanner, PageHeader, RoleTag, SectionHeader, btnGhost, inputCls } from '@/components/ui';
import { assignRoleAction, revokeRoleAction } from '../actions';

const ROLES = ['employee', 'manager', 'hr_admin', 'super_admin'] as const;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const t = await getTranslations('admin.users');
  const s = await requireAdmin();
  const { error } = await searchParams;
  const groupAdmin = isGroupAdmin(s);
  // Group admins grant any role for any company (or group-wide); delegated admins may only appoint
  // a scoped hr_admin within the subtree they administer (RLS enforces this regardless of the UI).
  const [users, companies] = await Promise.all([
    listUsers(s),
    groupAdmin ? listCompanies(s) : adminCompanies(s),
  ]);
  const roleOptions = groupAdmin ? ROLES : (['hr_admin'] as const);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('title')}
        actions={<span className="text-sm text-muted-foreground">{t('userCount', { count: users.length })}</span>}
      />
      <ErrorBanner message={error} />

      <div className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
        {t.rich('provisioningNote', {
          strong: (chunks) => <span className="font-medium">{chunks}</span>,
          em: (chunks) => <em>{chunks}</em>,
        })}
      </div>

      <Card>
        <SectionHeader title={t('sectionUsers')} count={users.length} />
        <ul className="divide-y divide-border">
          {users.map((u) => (
            <li key={u.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar name={u.name ?? u.email ?? 'User'} />
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{u.name ?? u.workosUserId}</div>
                  <div className="truncate text-xs text-muted-foreground">{u.email ?? '—'}</div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {u.roles.map((r) => (
                  <span key={r.id} className="inline-flex items-center gap-1">
                    <RoleTag role={r.role} />
                    {r.companyId && (
                      <span
                        className="text-[10px] text-muted-foreground"
                        title={t('scopedTo', { company: r.company ?? '' })}
                      >
                        · {r.company}
                      </span>
                    )}
                    {(groupAdmin || (r.role === 'hr_admin' && r.companyId)) && (
                      <form action={revokeRoleAction} className="inline">
                        <input type="hidden" name="roleAssignmentId" value={r.id} />
                        <button
                          type="submit"
                          title={t('revokeRole')}
                          className="text-muted-foreground transition-colors hover:text-red-500"
                        >
                          ×
                        </button>
                      </form>
                    )}
                  </span>
                ))}
                {u.roles.length === 0 && <span className="text-xs text-muted-foreground">{t('noRoles')}</span>}
                <form action={assignRoleAction} className="inline-flex items-center gap-2">
                  <input type="hidden" name="appUserId" value={u.id} />
                  <select
                    name="role"
                    className={`${inputCls} py-1`}
                    defaultValue={groupAdmin ? 'employee' : 'hr_admin'}
                  >
                    {roleOptions.map((r) => (
                      <option key={r} value={r}>
                        {t(`role.${r}`)}
                      </option>
                    ))}
                  </select>
                  <select
                    name="companyId"
                    className={`${inputCls} py-1`}
                    defaultValue=""
                    title={t('companyScopeHint')}
                  >
                    {groupAdmin && <option value="">{t('groupWide')}</option>}
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className={btnGhost}>
                    {t('addRole')}
                  </button>
                </form>
              </div>
            </li>
          ))}
          {users.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</li>
          )}
        </ul>
      </Card>
    </div>
  );
}
