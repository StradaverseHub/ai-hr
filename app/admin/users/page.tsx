import { getSession } from '@/lib/session';
import { listUsers } from '@/core/admin';
import { Card, ErrorBanner, RoleTag, SectionHeader, btnGhost, inputCls } from '@/components/ui';
import { assignRoleAction, revokeRoleAction } from '../actions';

const ROLES = ['employee', 'manager', 'hr_admin', 'super_admin'] as const;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await getSession();
  const { error } = await searchParams;
  const users = await listUsers(s);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Users &amp; roles</h1>
        <span className="text-sm text-zinc-500">{users.length} users</span>
      </div>
      <ErrorBanner message={error} />

      <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
        New logins are provisioned via <span className="font-medium">WorkOS</span> (SSO / invite) in a later
        slice. Here you manage roles for existing users.
      </div>

      <Card>
        <SectionHeader title="Users" count={users.length} />
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {users.map((u) => (
            <li key={u.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="font-medium text-zinc-900 dark:text-zinc-100">{u.name ?? u.workosUserId}</div>
                <div className="truncate text-xs text-zinc-500">{u.email ?? '—'}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {u.roles.map((r) => (
                  <span key={r.id} className="inline-flex items-center gap-1">
                    <RoleTag role={r.role} />
                    <form action={revokeRoleAction} className="inline">
                      <input type="hidden" name="roleAssignmentId" value={r.id} />
                      <button
                        type="submit"
                        title="Revoke role"
                        className="text-zinc-400 transition-colors hover:text-red-500"
                      >
                        ×
                      </button>
                    </form>
                  </span>
                ))}
                {u.roles.length === 0 && <span className="text-xs text-zinc-400">no roles</span>}
                <form action={assignRoleAction} className="inline-flex items-center gap-2">
                  <input type="hidden" name="appUserId" value={u.id} />
                  <select name="role" className={`${inputCls} py-1`} defaultValue="employee">
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r.replace(/_/g, ' ')}
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
            <li className="px-4 py-6 text-center text-sm text-zinc-500">No users yet.</li>
          )}
        </ul>
      </Card>
    </div>
  );
}
