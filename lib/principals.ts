import { client } from '../db/client';

export type Principal = { userId: string; name: string; roles: string[] };

/** DEV-ONLY: list selectable identities for the dev identity switcher (admin → manager → staff).
 *  Hidden in production, EXCEPT in an explicitly opted-in gated demo (ALLOW_DEMO_SESSION=true), where
 *  testers need the "act as" switcher to exercise each role. Mirrors the getSession demo exception. */
export async function listPrincipals(): Promise<Principal[]> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SESSION !== 'true') return [];
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
