export type UserDirectoryRow = {
  key: string;
  status: 'active' | 'invited' | 'archived' | 'preparing' | 'pending';
  personId: string | null;
  name: string | null;
  email: string | null;
  appUserId: string | null;
  loginSuffix: string | null;
  roles: { id: string; role: string; companyId: string | null; company: string | null }[];
  invitationId: string | null;
  invitedRole: string | null;
  invitedCompanyId: string | null;
  manuallyArchived: boolean;
  hasEmployment?: boolean;
  /** Employee ID: the current employment's employee code(s); absent for logins without employment. */
  employeeCode?: string | null;
  /** Board 0735d1b7: the open invitation's email, from account_email_delivery (one read for the page). */
  invitationSentAt?: string | null;
  invitationDelivery?: 'pending' | 'sent' | 'failed' | 'skipped' | null;
};
export type DirectoryGroupBy = 'none' | 'status' | 'role' | 'company' | 'type';
export const directoryType = (u: UserDirectoryRow) => !u.personId ? 'unlinked' : u.hasEmployment === false ? 'standalone' : 'employee';
/** Board 0735d1b7 — User Type. Internal: the login (or the person waiting for one) is linked to a Personnel Profile
 * that holds at least one employment, in any state, so a former employee stays Internal. External: a standalone
 * person without employment, or a login linked to no person. Worked out from the existing rows; never stored. */
export type UserType = 'internal' | 'external';
export const userType = (u: UserDirectoryRow): UserType => u.personId && u.hasEmployment !== false ? 'internal' : 'external';
/** Invitation grants are displayed as requested access, never as active grants. */
export const directoryGrants = (u: UserDirectoryRow) => u.status === 'invited' && u.invitedRole
  ? [{ id: u.invitationId ?? u.key, role: u.invitedRole, companyId: u.invitedCompanyId, company: null }]
  : u.roles;
