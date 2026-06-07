import { redirect } from 'next/navigation';
import type { SessionContext } from '../db/client';
import { getSession } from './session';

const ADMIN_ROLES = new Set(['hr_admin', 'super_admin']);

export function isAdmin(s: SessionContext): boolean {
  return !!s.roles?.some((r) => ADMIN_ROLES.has(r));
}

/** Group-level admin: super_admin (any scope) or a group-wide hr_admin. Mirrors app.is_group_admin(). */
export function isGroupAdmin(s: SessionContext): boolean {
  return !!s.grants?.some((g) => g.role === 'super_admin' || (g.role === 'hr_admin' && g.companyId == null));
}

/** Resolve the session, redirecting non-admins away from admin-only routes. */
export async function requireAdmin(): Promise<SessionContext> {
  const s = await getSession();
  if (!isAdmin(s)) redirect('/');
  return s;
}
