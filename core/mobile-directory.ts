/**
 * The staff directory in the app (lib/mobile-api/v2/directory.ts). COMPOSITION ONLY, over the owners the web's own
 * People directory reads, in one tenant transaction (one snapshot):
 *
 *   scope    allowedCompanies — what lib/scope.ts scopedSession hands app/personnel/page.tsx as `scopeIds` when no
 *            company-switcher cookie narrows it (the app has no switcher)
 *   rows     listEmployeesPage(ctx, {companyIds, q, status:'active', limit, offset}) — the web list's own read, its
 *            search, its `active` filter (not terminated) and its order (name ascending); RLS decides visibility
 *   phone    person.phone of exactly the rows listed, read under the same RLS: the value app/personnel/[employmentId]
 *            (employeeDetail, the same employment ⋈ person ⋈ company join) prints to the same viewer
 *
 * DISCLOSURE. The listing row also carries the employee ID, lifecycle dates, grade, cost centre and reporting line;
 * none of them is copied into the answer. Nothing here decides who may see whom.
 *
 * Kept free of 'server-only' (core/mobile-command-receipt.ts says why the mobile core stays reachable).
 */
import { and, inArray, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { employment, person } from '../db/schema';
import { allowedCompanies, listEmployeesPage } from './read';
import type { DirectoryPageV2 } from '../lib/mobile-api/v2/directory';

export type DirectoryQuery = { q?: string; offset: number; limit: number };

export function staffDirectoryPageV2(ctx: SessionContext, p: DirectoryQuery): Promise<DirectoryPageV2> {
  return withTenant(ctx, async (tx) => {
    const scopeIds = (await allowedCompanies(ctx, tx)).map((c) => c.id);
    const { rows, total } = await listEmployeesPage(ctx, { companyIds: scopeIds, q: p.q || undefined, status: 'active', limit: p.limit, offset: p.offset }, undefined, tx);
    const ids = rows.map((r) => r.employmentId);
    const phones = new Map<string, string | null>();
    if (ids.length) {
      const found = await tx.select({ employmentId: employment.id, phone: person.phone }).from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(and(eq(employment.tenantId, ctx.tenantId), inArray(employment.id, ids)));
      for (const f of found) phones.set(f.employmentId, f.phone ?? null);
    }
    const blank = (v: string | null | undefined) => (v && v.trim() ? v : null);
    return {
      enabled: true, total, offset: p.offset, limit: p.limit,
      items: rows.map((r) => ({
        employmentId: r.employmentId, name: r.name, position: blank(r.position), department: blank(r.department), company: r.company,
        email: blank(r.email), phone: blank(phones.get(r.employmentId)),
      })),
    };
  });
}
