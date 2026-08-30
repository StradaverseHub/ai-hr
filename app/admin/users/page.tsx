import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listUsers } from '@/core/admin';
import { listAssistantGrants } from '@/core/assistant-grant';
import { listPendingInvitations } from '@/core/auth';
import { adminCompanies, listCompanies, listEmployees } from '@/core/read';
import { Avatar, Card, ErrorBanner, PageHeader, RoleTag, SectionHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { FunctionAccessGrid } from '@/components/function-access-grid';
import { type Role, type ScreenEntry } from '@/lib/permissions';
import { archiveUserAction, assignRoleAction, inviteUserAction, revokeInvitationAction, revokeRoleAction, setAssistantGrantAction } from '../actions';

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

/**
 * One merged lifecycle row per human (0279). An app_user row and a still-pending invitation for the
 * SAME address are the same person, so they de-duplicate on the lowercased email with the app_user
 * winning — without that key, archive-then-reinvite renders the same human twice with contradictory
 * statuses.
 */
type Row = {
  key: string;
  status: 'active' | 'invited' | 'archived';
  name: string | null;
  email: string | null;
  /** app_user id — null on an invitation-only row (no login exists yet). */
  appUserId: string | null;
  /** Short form of the WorkOS id, shown when no person is linked. */
  workosUserId: string | null;
  roles: {
    id: string;
    role: string;
    companyId: string | null;
    company: string | null;
  }[];
  /** Invitation id — set only on an invited row, so Revoke targets it. */
  invitationId: string | null;
  invitedRole: string | null;
  invitedCompanyId: string | null;
  /** Manually archived ⇒ Restore is offered. Blocked by termination ⇒ it is not (clear the dates). */
  manuallyArchived: boolean;
};

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; archived?: string }>;
}) {
  const t = await getTranslations('admin.users');
  // Second namespace for the access-grid column labels that map 1:1 to a top-level nav entry. Having two
  // getTranslations scopes makes this a multi-namespace file, which the i18n static-key coverage check
  // (test C) skips ENTIRELY — static keys included. So every key this page renders, new ones included,
  // is pinned by function-access.test.ts instead; a typo here would otherwise ship fully green.
  const tNav = await getTranslations('nav');
  const s = await requireAdmin();
  const { error, archived } = await searchParams;
  const includeArchived = archived === '1';
  const groupAdmin = isGroupAdmin(s);
  // Group admins grant any role for any company (or group-wide); delegated admins may only appoint
  // a scoped hr_admin within the subtree they administer (RLS enforces this regardless of the UI).
  //
  // KNOWN LIMITATION, deliberate: listPendingInvitations is group-admin-only, so a delegated
  // company-scoped admin sees the users list with no invitation rows. Archive is group-admin-only
  // anyway (the 0016 app_user WITH CHECK), so a delegated admin's view of this screen is read-only.
  // Widening invitation visibility is a new authz surface and out of scope here.
  const [userList, assistantGrants, companies, invitations, employees] = await Promise.all([
    listUsers(s, { includeArchived }),
    // ADR-0082 §2.8 — who currently holds an assistant grant. One read for the page, not one per row.
    listAssistantGrants(s),
    groupAdmin ? listCompanies(s) : adminCompanies(s),
    groupAdmin ? listPendingInvitations(s) : Promise.resolve([]),
    groupAdmin ? listEmployees(s) : Promise.resolve([]),
  ]);
  const { users, hiddenCount } = userList;
  // LIVE grants only. listAssistantGrants deliberately returns every grant EVER, revoked rows included
  // ("who could ask the assistant last March" is the reason revocation is a stamp rather than a delete),
  // so filtering on revokedAt is load-bearing: without it a revoked user reads as still granted and the
  // button would offer to revoke them a second time. A set keeps the per-row check O(1).
  const assistantGranted = new Set(assistantGrants.filter((g) => g.revokedAt == null).map((g) => g.appUserId));
  const roleOptions = groupAdmin ? ROLES : (['hr_admin'] as const);
  const companyName = (id: string | null) => companies.find((c) => c.id === id)?.name ?? null;

  // The invite form binds an invitation to a PERSON, so offer one option per person (an employee with
  // two employments appears once).
  const peopleOptions = [
    ...new Map(
      employees
        .filter((e) => e.personId)
        .map((e) => [e.personId as string, { id: e.personId as string, name: e.name, code: e.employeeCode }]),
    ).values(),
  ].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  const rows: Row[] = users.map((u) => ({
    key: (u.email ?? `id:${u.id}`).toLowerCase(),
    // Archived covers BOTH causes; the cause line below distinguishes them.
    status: u.archivedAt || u.blockedByTermination ? 'archived' : 'active',
    name: u.name,
    email: u.email,
    appUserId: u.id,
    workosUserId: u.workosUserId,
    roles: u.roles,
    invitationId: null,
    invitedRole: null,
    invitedCompanyId: null,
    manuallyArchived: Boolean(u.archivedAt),
  }));
  const seen = new Set(rows.map((r) => r.key));
  for (const inv of invitations) {
    const key = inv.email.toLowerCase();
    if (seen.has(key)) continue; // the real login wins over a pending invitation for the same address
    seen.add(key);
    rows.push({
      key,
      status: 'invited',
      name: null,
      email: inv.email,
      appUserId: null,
      workosUserId: null,
      roles: [],
      invitationId: inv.id,
      invitedRole: inv.role,
      invitedCompanyId: inv.companyId,
      manuallyArchived: false,
    });
  }

  // Column label: a `nav.*` labelKey resolves against the nav namespace; an `admin.users.screen.*`
  // labelKey against this page's own namespace. Both are static keys pinned by function-access.test.ts.
  const screenLabel = (screen: ScreenEntry): string =>
    screen.labelKey.startsWith('nav.')
      ? tNav(screen.labelKey.slice('nav.'.length))
      : t(screen.labelKey.slice('admin.users.'.length));
  const scopeNoteFor = (screen: ScreenEntry): string | null =>
    screen.hasScopeNote ? t(`scope.${screen.screenKey}`) : null;
  const roleLabelFor = (role: Role): string => t(`role.${role}`);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div data-tour="admin-intro">
        <PageHeader
          title={t('title')}
          actions={<span className="text-sm text-muted-foreground">{t('userCount', { count: rows.length })}</span>}
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

      <Card data-tour="admin-function-access">
        <SectionHeader title={t('sectionFunctionAccess')} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('functionAccessCaption')}</p>
        <div className="p-4 pt-3">
          <FunctionAccessGrid
            roleLabel={roleLabelFor}
            screenLabel={screenLabel}
            scopeNote={scopeNoteFor}
            labels={{
              accessible: t('accessible'),
              notAccessible: t('notAccessible'),
              screenColumn: t('screenColumn'),
            }}
          />
        </div>
      </Card>

      {/* ADR-0072 — invitation-only account creation. Group admins invite an EXISTING employee by
          email + role; there is no open self sign-up. Company-scoped delegated admins manage roles
          but not the login itself. */}
      {groupAdmin && (
        <Card>
          <SectionHeader title={t('inviteTitle')} />
          <div className="px-4 py-3">
            <p className="mb-3 text-xs text-muted-foreground">{t('inviteHint')}</p>
            <form action={inviteUserAction} className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{t('invitePerson')}</span>
                <select name="personId" required defaultValue="" className={`${inputCls} w-56`}>
                  <option value="" disabled>
                    {t('invitePersonPlaceholder')}
                  </option>
                  {peopleOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code ? `${p.name} · ${p.code}` : p.name}
                    </option>
                  ))}
                </select>
              </label>
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

      <Card data-tour="admin-users">
        <SectionHeader title={t('sectionUsers')} count={rows.length} />
        {/* This count and userCount in the page header both EXCLUDE hidden rows, so the toggle carries
            the hidden count — the default view never silently omits a set. */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          <span className="text-xs text-muted-foreground">
            {hiddenCount > 0 ? t('archivedCount', { count: hiddenCount }) : ''}
          </span>
          <a href={includeArchived ? '/admin/users' : '/admin/users?archived=1'} className={btnGhost}>
            {includeArchived ? t('hideArchived') : t('showArchived')}
          </a>
        </div>
        <ul className="divide-y divide-border">
          {rows.map((u) => (
            <li key={u.key} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar name={u.name ?? u.email ?? 'User'} />
                <div className="min-w-0">
                  <div className="font-medium text-foreground">
                    {/* No person linked → an unlinked/external login. Deliberately NOT falling back to
                        the invitation email: a PDPA-erased person must not be re-identified here. */}
                    {u.name ?? (u.appUserId ? t('unlinkedLogin', { id: (u.workosUserId ?? '').slice(-6) }) : u.email)}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{u.email ?? '—'}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="sr-only">{t('statusColumn')}: </span>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        u.status === 'active'
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : u.status === 'invited'
                            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                            : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {t(`status.${u.status}`)}
                    </span>
                    {u.status === 'archived' && (
                      <span className="text-[10px] text-muted-foreground">
                        {u.manuallyArchived ? t('archivedCauseManual') : t('archivedCauseLeft')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {u.status === 'invited' && u.invitedRole && (
                  <span className="text-xs text-muted-foreground">
                    {t(`role.${u.invitedRole}`)}
                    {u.invitedCompanyId
                      ? ` · ${companyName(u.invitedCompanyId) ?? ''}`
                      : ` · ${t('groupWide')}`}
                  </span>
                )}
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
                    {u.status !== 'archived' && (groupAdmin || (r.role === 'hr_admin' && r.companyId)) && (
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
                {u.status === 'active' && u.roles.length === 0 && (
                  <span className="text-xs text-muted-foreground">{t('noRoles')}</span>
                )}

                {/* Invited rows keep the existing Revoke. */}
                {u.status === 'invited' && u.invitationId && (
                  <form action={revokeInvitationAction}>
                    <input type="hidden" name="invitationId" value={u.invitationId} />
                    <button type="submit" className={btnGhost}>
                      {t('revokeInvitation')}
                    </button>
                  </form>
                )}

                {/* Archived rows hide the role editor — permissions are kept on file untouched so a
                    Restore puts the user back exactly as they were. */}
                {u.status === 'active' && u.appUserId && (
                  <form data-tour="admin-assign" action={assignRoleAction} className="inline-flex items-center gap-2">
                    <input type="hidden" name="appUserId" value={u.appUserId} />
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
                )}

                {/* ADR-0082 §2.8 — the assistant is a per-user grant ON TOP of the billable module, and
                    both gates fail closed. Offered only to group admins and only for a row that has a
                    real login: an invitation with no app_user cannot hold a grant. */}
                {groupAdmin && u.appUserId && (
                  <form action={setAssistantGrantAction} className="inline">
                    <input type="hidden" name="appUserId" value={u.appUserId} />
                    <input type="hidden" name="granted" value={assistantGranted.has(u.appUserId) ? 'false' : 'true'} />
                    <button type="submit" className={btnGhost}>
                      {assistantGranted.has(u.appUserId) ? t('assistantRevoke') : t('assistantGrant')}
                    </button>
                  </form>
                )}

                {/* Archive / Restore — group admins only (RLS is the backstop). Restore is offered ONLY
                    for a manual archive: a row blocked by termination is unwound by clearing the end
                    dates on the employment record, which restores access by itself. */}
                {groupAdmin && u.appUserId && (u.status === 'active' || u.manuallyArchived) && (
                  <form action={archiveUserAction} className="inline">
                    <input type="hidden" name="appUserId" value={u.appUserId} />
                    <input type="hidden" name="archived" value={u.manuallyArchived ? 'false' : 'true'} />
                    <button type="submit" className={btnGhost}>
                      {u.manuallyArchived ? t('restore') : t('archive')}
                    </button>
                  </form>
                )}
              </div>
            </li>
          ))}
          {rows.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</li>
          )}
        </ul>
      </Card>
    </div>
  );
}
