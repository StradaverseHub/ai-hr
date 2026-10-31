import { internalSelected } from '@/lib/internal-auth/config';
import { listEmployeeActivationCandidates } from '@/core/employee-user-activation';
import { keycloakSelected } from '@/lib/identity/config';
import { listManualIdentityEnrollments } from '@/core/manual-identity';
import type { UserDirectoryRow } from './directory-model';
import { isGroupAdmin } from '@/lib/authz';
import { listUsers } from '@/core/admin';
import { listAssistantGrants } from '@/core/assistant-grant';
import { listPendingInvitations } from '@/core/auth';
import { adminCompanies, listCompanies, listEmployees } from '@/core/read';

import type { SessionContext } from '@/db/client';
export const ROLES = [
  'employee',
  'manager',
  'hr_admin',
  'super_admin',
  'payroll_partner',
  'performance_comp_partner',
  // ADR-0142 — OneHR performance partner: company-scoped OneHR administration without compensation.
  'performance_partner',
] as const;

export async function loadUsersData(s: SessionContext) {
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

  return { rows, groupAdmin, companies, roleOptions, assistantGranted, peopleOptions, pendingEmployees, manualEnrollments };
}
