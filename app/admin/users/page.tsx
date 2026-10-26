import { internalSelected } from '@/lib/internal-auth/config';
import { listEmployeeActivationCandidates } from '@/core/employee-user-activation';
import { keycloakSelected } from '@/lib/identity/config';
import { listManualIdentityEnrollments } from '@/core/manual-identity';
import { manualIdentityErrorCodes } from '@/lib/identity/manual-model';
import { ManualAccountSetup } from './manual-setup';
import { AccountTargetFields } from './account-target-fields';
import { UsersDirectory } from './users-directory';
import type { UserDirectoryRow } from './directory-model';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { listUsers } from '@/core/admin';
import { listAssistantGrants } from '@/core/assistant-grant';
import { listPendingInvitations } from '@/core/auth';
import { adminCompanies, listCompanies, listEmployees } from '@/core/read';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { FunctionAccessGrid } from '@/components/function-access-grid';
import Link from 'next/link';
import { type Role, type ScreenEntry } from '@/lib/permissions';
import { inviteUserAction } from '../actions';

const ROLES = [
  'employee',
  'manager',
  'hr_admin',
  'super_admin',
  'payroll_partner',
  'performance_comp_partner',
] as const;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; archived?: string; manualError?:string; manualSuccess?:string; activate?:string }>;
}) {
  const t = await getTranslations('admin.users');
  const accessT=await getTranslations('accessConfiguration');
  // Registry column labels use complete keys across nav, admin and installed modules.
  const tAll = await getTranslations();
  const s = await requireAdmin();
  const { error, archived, manualError, manualSuccess, activate } = await searchParams;
  const setupError=manualIdentityErrorCodes.find(code=>code===manualError);
  const includeArchived = archived === '1';
  const groupAdmin = isGroupAdmin(s);
  // Group admins grant any role for any company (or group-wide); delegated admins may only appoint
  // a scoped hr_admin within the subtree they administer (RLS enforces this regardless of the UI).
  //
  // KNOWN LIMITATION, deliberate: listPendingInvitations is group-admin-only, so a delegated
  // company-scoped admin sees the users list with no invitation rows. Archive is group-admin-only
  // anyway (the 0016 app_user WITH CHECK), so a delegated admin's view of this screen is read-only.
  // Widening invitation visibility is a new authz surface and out of scope here.
  const [userList, assistantGrants, companies, invitations, employees, manualEnrollments, activationCandidates] = await Promise.all([
    listUsers(s, { includeArchived: true }),
    // ADR-0082 §2.8 — who currently holds an assistant grant. One read for the page, not one per row.
    listAssistantGrants(s),
    groupAdmin ? listCompanies(s) : adminCompanies(s),
    groupAdmin ? listPendingInvitations(s) : Promise.resolve([]),
    groupAdmin ? listEmployees(s) : Promise.resolve([]),
    groupAdmin && (keycloakSelected() || internalSelected()) ? listManualIdentityEnrollments(s) : Promise.resolve([]),
    groupAdmin ? listEmployeeActivationCandidates(s) : Promise.resolve([]),
  ]);
  const { users: allUsers } = userList;
  const users = allUsers;
  // LIVE grants only. listAssistantGrants deliberately returns every grant EVER, revoked rows included
  // ("who could ask the assistant last March" is the reason revocation is a stamp rather than a delete),
  // so filtering on revokedAt is load-bearing: without it a revoked user reads as still granted and the
  // button would offer to revoke them a second time. A set keeps the per-row check O(1).
  const assistantGranted = new Set(assistantGrants.filter((g) => g.revokedAt == null).map((g) => g.appUserId));
  const roleOptions = groupAdmin ? ROLES : (['hr_admin'] as const);
  const companyName = (id: string | null) => companies.find((c) => c.id === id)?.name ?? null;

  // The invite form binds an invitation to a PERSON, so offer one option per person (a person with
  // two employments appears once).
  const peopleOptions = [
    ...new Map(
      [...employees,...activationCandidates.map(p=>({personId:p.id,name:p.name,employeeCode:p.code}))]
        .filter((e) => e.personId)
        .map((e) => [e.personId as string, { id: e.personId as string, name: e.name, code: e.employeeCode }]),
    ).values(),
  ].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  const rows: UserDirectoryRow[] = users.map((u) => ({
    key: `user:${u.id}`,
    personId: u.personId,
    // Archived covers BOTH causes; the cause line below distinguishes them.
    status: u.archivedAt || u.blockedByTermination ? 'archived' : manualEnrollments.some(e=>e.app_user_id===u.id) ? 'preparing' : 'active',
    name: u.name,
    email: u.email,
    appUserId: u.id,
    loginSuffix: u.name ? null : (u.workosUserId ?? '').slice(-6),
    roles: u.roles,
    invitationId: null,
    invitedRole: null,
    invitedCompanyId: null,
    manuallyArchived: Boolean(u.archivedAt),
    hasEmployment: u.hasEmployment,
  }));
  const peopleWithLogin = new Set(allUsers.map(u => u.personId).filter(Boolean));
  const invitationPeople = new Set(invitations.map(inv => inv.personId).filter(Boolean));
  const setupPeople = new Set(manualEnrollments.map(e => e.person_id));
  const pendingEmployees = activationCandidates.filter(p => !peopleWithLogin.has(p.id) && !invitationPeople.has(p.id) && !setupPeople.has(p.id));
  const selectedPerson = pendingEmployees.find(p => p.id === activate);
  for (const inv of invitations) {
    // Retained/archived logins suppress a fresh activation entry even when hidden by the toggle.
    if (inv.personId && peopleWithLogin.has(inv.personId)) continue;
    const key = `invitation:${inv.id}`;
    rows.push({
      key,
      personId: inv.personId,
      status: 'invited',
      name: activationCandidates.find(p => p.id === inv.personId)?.name ?? null,
      email: inv.email,
      appUserId: null,
      loginSuffix: null,
      roles: [],
      invitationId: inv.id,
      invitedRole: inv.role,
      invitedCompanyId: inv.companyId,
      manuallyArchived: false,
      hasEmployment: activationCandidates.find(p=>p.id===inv.personId)?.hasEmployment,
    });
  }

  for (const p of activationCandidates) {
    if (peopleWithLogin.has(p.id) || invitationPeople.has(p.id)) continue;
    rows.push({ key: `person:${p.id}`, personId: p.id, status: setupPeople.has(p.id) ? 'preparing' : 'pending',
      name: p.name, email: p.email, appUserId: null, loginSuffix: null, roles: [],
      invitationId: null, invitedRole: null, invitedCompanyId: null, manuallyArchived: false, hasEmployment: p.hasEmployment });
  }

  // Registry labels include nav, admin.users and module namespaces. Resolve their complete keys.
  const screenLabel = (screen: ScreenEntry): string => tAll(screen.labelKey);
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
      <Link href="/admin/users/access" className={btnGhost}>{accessT('title')}</Link>
      <ErrorBanner message={setupError?t(`manual.errors.${setupError}`):undefined}/>
      {['created','cancelled'].includes(manualSuccess??'')&&<p role="status" className="rounded-lg border border-border p-4 text-sm">{t(`manual.success.${manualSuccess as 'created'|'cancelled'}`)}</p>}

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

      {groupAdmin&&<ManualAccountSetup available={keycloakSelected() || internalSelected()} people={peopleOptions} companies={companies}
        roles={ROLES.map(value=>({value,label:t(`role.${value}`)}))} pending={manualEnrollments} selectedPerson={selectedPerson}/>}

      {/* Email invitations remain alongside administrator-attested manual setup. Group admins invite a named person with or without employment by
          email + role; there is no open self sign-up. Company-scoped delegated admins manage roles
          but not the login itself. */}
      {groupAdmin && (
        <Card>
          <div id="invite-user"><SectionHeader title={t('inviteTitle')} /></div>
          <div className="px-4 py-3">
            <p className="mb-3 text-xs text-muted-foreground">{t('inviteHint')}</p>
            <form action={inviteUserAction} className="grid gap-4 sm:grid-cols-2">
              <AccountTargetFields idPrefix="invite" people={peopleOptions} companies={companies} roles={ROLES.map(value=>({value,label:t(`role.${value}`)}))} selectedPerson={selectedPerson}>
              <label className="flex min-w-56 flex-1 flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{t('inviteEmail')}</span>
                <input type="email" name="email" required defaultValue={selectedPerson?.email ?? ''} placeholder="name@company.com" className={inputCls} />
              </label>
              </AccountTargetFields>
              <button type="submit" className={`${btnPrimary} w-fit`}>
                {t('inviteSubmit')}
              </button>
            </form>
          </div>
        </Card>
      )}

      <UsersDirectory rows={rows} groupAdmin={groupAdmin} includeArchived={includeArchived} companies={companies} roleOptions={[...roleOptions]} assistantGrantedIds={rows.flatMap(row=>row.appUserId&&assistantGranted.has(row.appUserId)?[row.appUserId]:[])}/>

    </div>
  );
}
