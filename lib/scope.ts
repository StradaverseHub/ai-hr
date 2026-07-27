import { cookies } from 'next/headers';
import type { SessionContext } from '../db/client';
import { allowedCompanies, listCompanies } from '../core/read';
import { getSession } from './session';
import { requireAdmin } from './authz';

/**
 * The active company context (Odoo-style multi-company switcher). Returns the selected company ids
 * intersected with what the user is allowed to scope to; defaults to ALL allowed companies. This is
 * a UX filter layered on top of RLS — it never widens access, only narrows the view.
 */
export async function getScopeIds(allowedIds: string[]): Promise<string[]> {
  const raw = (await cookies()).get('company_scope')?.value;
  if (!raw) return allowedIds;
  const allowed = new Set(allowedIds);
  const scoped = raw.split(',').filter((id) => id && allowed.has(id));
  return scoped.length ? scoped : allowedIds;
}

/**
 * The session plus the active company-context scope — what every page filters its lists by.
 *
 * `allowedCount` is the number of companies this user may reach AT ALL, as distinct from the
 * `scopeIds` subset they currently have selected. Returned because a caller showing "N of M" has no
 * other honest source for M: `listCompanies` is scoped to the TENANT, not to the user, so using it
 * told someone who can only reach 2 companies that they were seeing "2 of 8" (feedback ab77dc1f) —
 * implying six were being withheld, and incidentally disclosing how many companies the organisation
 * has to a user whose access does not otherwise reveal that.
 *
 * Additive, so the 17 existing callers destructuring `{ s, scopeIds }` are unaffected.
 */
export async function scopedSession(): Promise<{ s: SessionContext; scopeIds: string[]; allowedCount: number }> {
  const s = await getSession();
  const allowed = await allowedCompanies(s);
  const scopeIds = await getScopeIds(allowed.map((c) => c.id));
  return { s, scopeIds, allowedCount: allowed.length };
}

/** Admin-gated variant: redirects non-admins, then returns the session + active company scope. */
export async function scopedAdmin(): Promise<{ s: SessionContext; scopeIds: string[] }> {
  const s = await requireAdmin();
  const allowed = await allowedCompanies(s);
  const scopeIds = await getScopeIds(allowed.map((c) => c.id));
  return { s, scopeIds };
}

/**
 * The ISO country of the active company context — which country pack the country-admin screens mount
 * (ADR-0080 D4). Resolves the first in-scope company's `company.country`, defaulting to 'MY' when the
 * scope yields nothing (the guard then resolves the MY pack, matching today's MY-only reality). This
 * is what moves the config-route gate from "route exists" to "the acting company's pack declares the
 * section": a company in another country resolves that country's pack (or none → the route 404s).
 */
export async function actingCompanyCountry(): Promise<string> {
  const { s, scopeIds } = await scopedSession();
  const companies = await listCompanies(s);
  const inScope = companies.filter((c) => scopeIds.includes(c.id));
  return (inScope[0]?.country ?? companies[0]?.country ?? 'MY').toUpperCase();
}
