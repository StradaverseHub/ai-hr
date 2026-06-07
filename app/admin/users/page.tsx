import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listUsers } from '@/core/admin';
import { adminCompanies, listCompanies } from '@/core/read';
import { Card, ErrorBanner, RoleTag, SectionHeader, btnGhost, inputCls } from '@/components/ui';
import { assignRoleAction, revokeRoleAction } from '../actions';

const ROLES = ['employee', 'manager', 'hr_admin', 'super_admin'] as const;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
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
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Users &amp; roles</h1>
        <span className="text-sm text-muted-foreground">{users.length} users</span>
      </div>
      <ErrorBanner message={error} />

      <div className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
        New logins are provisioned via <span className="font-medium">WorkOS</span> (SSO / invite) in a later
        slice. Here you manage roles for existing users. Company scope applies to{' '}
        <span className="font-medium">HR Admin</span> grants — that company <em>and its sub-companies</em>;
        other roles are group-wide.
      </div>

      <Card>
        <SectionHeader title="Users" count={users.length} />
        <ul className="divide-y divide-border">
          {users.map((u) => (
            <li key={u.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="font-medium text-foreground">{u.name ?? u.workosUserId}</div>
                <div className="truncate text-xs text-muted-foreground">{u.email ?? '—'}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {u.roles.map((r) => (
                  <span key={r.id} className="inline-flex items-center gap-1">
                    <RoleTag role={r.role} />
                    {r.companyId && (
                      <span
                        className="text-[10px] text-muted-foreground"
                        title={`Scoped to ${r.company} and its sub-companies`}
                      >
                        · {r.company}
                      </span>
                    )}
                    {(groupAdmin || (r.role === 'hr_admin' && r.companyId)) && (
                      <form action={revokeRoleAction} className="inline">
                        <input type="hidden" name="roleAssignmentId" value={r.id} />
                        <button
                          type="submit"
                          title="Revoke role"
                          className="text-muted-foreground transition-colors hover:text-red-500"
                        >
                          ×
                        </button>
                      </form>
                    )}
                  </span>
                ))}
                {u.roles.length === 0 && <span className="text-xs text-muted-foreground">no roles</span>}
                <form action={assignRoleAction} className="inline-flex items-center gap-2">
                  <input type="hidden" name="appUserId" value={u.id} />
                  <select
                    name="role"
                    className={`${inputCls} py-1`}
                    defaultValue={groupAdmin ? 'employee' : 'hr_admin'}
                  >
                    {roleOptions.map((r) => (
                      <option key={r} value={r}>
                        {r.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                  <select
                    name="companyId"
                    className={`${inputCls} py-1`}
                    defaultValue=""
                    title="Company scope (HR Admin only)"
                  >
                    {groupAdmin && <option value="">Group-wide</option>}
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className={btnGhost}>
                    Add role
                  </button>
                </form>
              </div>
            </li>
          ))}
          {users.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">No users yet.</li>
          )}
        </ul>
      </Card>
    </div>
  );
}
