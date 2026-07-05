import { client } from '../db/client';

export type Principal = { userId: string; name: string; roles: string[] };

/** DEV-ONLY: list selectable identities for the dev identity switcher (admin → manager → staff).
 *  Hidden in production (ADR-0072: real WorkOS auth replaces the dev shim; the switcher only exists on
 *  developers' own machines). Mirrors the getSession() NODE_ENV !== 'production' dev-path predicate. */
export async function listPrincipals(): Promise<Principal[]> {
  if (process.env.NODE_ENV === 'production') return [];
  const rows = await client<{ user_id: string; name: string; roles: string[] }[]>`
    select user_id, name, roles from app.dev_principals()
    order by case
      when 'hr_admin' = any(roles) then 0
      when 'manager' = any(roles) then 1
      else 2
    end, name
  `;
  return rows.map((r) => ({ userId: r.user_id, name: r.name, roles: r.roles }));
}
