import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listUsers } from '@/core/admin';
import { listPendingInvitations } from '@/core/auth';
import { adminCompanies, listCompanies } from '@/core/read';
import { Avatar, Card, ErrorBanner, PageHeader, RoleTag, SectionHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { assignRoleAction, inviteUserAction, revokeInvitationAction, revokeRoleAction } from '../actions';

const ROLES = [
  'employee',
  'manager',
  'hr_admin',
  'super_admin',
  'payroll_partner',
  'performance_comp_partner',
] as const;

// Roles that carry a company scope (ADR-0049) — hr_admin + the two job-function partners. These
// render the company-scope chip on a grant and may be scoped via the company <select>.
const SCOPABLE_ROLES = new Set<string>(['hr_admin', 'payroll_partner', 'performance_comp_partner']);

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
  const [users, companies, invitations] = await Promise.all([
    listUsers(s),
    groupAdmin ? listCompanies(s) : adminCompanies(s),
    groupAdmin ? listPendingInvitations(s) : Promise.resolve([]),
  ]);
  const roleOptions = groupAdmin ? ROLES : (['hr_admin'] as const);
  const companyName = (id: string | null) => companies.find((c) => c.id === id)?.name ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div data-tour="admin-intro">
        <PageHeader
          title={t('title')}
          actions={<span className="text-sm text-muted-foreground">{t('userCount', { count: users.length })}</span>}
        />
      </div>
      <ErrorBanner message={error} />

      <div
        data-tour="admin-provisioning"
        className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground"
      >
        {t.rich('provisioningNote', {
          strong: (chunks) => <span className="font-medium">{chunks}</span>,
          em: (chunks) => <em>{chunks}</em>,
        })}
      </div>

      {/* ADR-0072 — invitation-only account creation. Group admins invite by email + role; there is no
          open self sign-up. Company-scoped delegated admins manage roles but not the login itself. */}
      {groupAdmin && (
        <Card>
          <SectionHeader title={t('inviteTitle')} />
          <div className="px-4 py-3">
            <p className="mb-3 text-xs text-muted-foreground">{t('inviteHint')}</p>
            <form action={inviteUserAction} className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-56 flex-1 flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{t('inviteEmail')}</span>
                <input type="email" name="email" required placeholder="name@company.com" className={inputCls} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{t('inviteRole')}</span>
                <select name="role" defaultValue="employee" className={`${inputCls} w-44`}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`role.${r}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{t('inviteScope')}</span>
                <select name="companyId" defaultValue="" className={`${inputCls} w-44`}>
                  <option value="">{t('groupWide')}</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={btnPrimary}>
                {t('inviteSubmit')}
              </button>
            </form>
          </div>
        </Card>
      )}

      {groupAdmin && invitations.length > 0 && (
        <Card>
          <SectionHeader title={t('pendingInvitations')} count={invitations.length} />
          <ul className="divide-y divide-border">
            {invitations.map((inv) => (
              <li key={inv.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{inv.email}</div>
                  <div className="text-xs text-muted-foreground">
                    {t(`role.${inv.role}`)}
                    {inv.companyId ? ` · ${companyName(inv.companyId) ?? ''}` : ` · ${t('groupWide')}`}
                  </div>
                </div>
                <form action={revokeInvitationAction}>
                  <input type="hidden" name="invitationId" value={inv.id} />
                  <button type="submit" className={btnGhost}>
                    {t('revokeInvitation')}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card data-tour="admin-users">
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
                    <RoleTag role={r.role} label={t(`role.${r.role}`)} />
                    {r.companyId && SCOPABLE_ROLES.has(r.role) && (
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
                <form data-tour="admin-assign" action={assignRoleAction} className="inline-flex items-center gap-2">
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
