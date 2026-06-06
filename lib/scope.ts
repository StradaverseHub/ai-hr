import { cookies } from 'next/headers';
import type { SessionContext } from '../db/client';
import { allowedCompanies } from '../core/read';
import { getSession } from './session';

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

/** The session plus the active company-context scope — what every page filters its lists by. */
export async function scopedSession(): Promise<{ s: SessionContext; scopeIds: string[] }> {
  const s = await getSession();
  const allowed = await allowedCompanies(s);
  const scopeIds = await getScopeIds(allowed.map((c) => c.id));
  return { s, scopeIds };
}
