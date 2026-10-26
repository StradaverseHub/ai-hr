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
};
export type DirectoryGroupBy = 'none' | 'status' | 'role' | 'company' | 'type';
export const directoryType = (u: UserDirectoryRow) => !u.personId ? 'unlinked' : u.hasEmployment === false ? 'standalone' : 'employee';
/** Invitation grants are displayed as requested access, never as active grants. */
export const directoryGrants = (u: UserDirectoryRow) => u.status === 'invited' && u.invitedRole
  ? [{ id: u.invitationId ?? u.key, role: u.invitedRole, companyId: u.invitedCompanyId, company: null }]
  : u.roles;
