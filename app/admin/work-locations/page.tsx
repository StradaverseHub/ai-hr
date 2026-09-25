import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listLocations, listUnmappedBranches } from '@/core/location';
import { listClockingLocations } from '@/packs/attendance/service';
import {
  Card,
  ErrorBanner,
  PageHeader,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { cn } from '@/lib/utils';
import { withWorkLocationsFrom } from '@/lib/return-to';
import {
  LOCATION_NEW_PAGE,
  LOCATIONS_LIST,
  UNLINKED_CLOCKING_PAGE,
  UUID_RE,
  locationEditPage,
  locationViewPage,
} from './location-fields';

/**
 * 639bf4a5 rev 2 (r338) — ATTENDANCE › LOCATIONS. A COMPANY LISTING, AND NOTHING ELSE.
 *
 * ⚠️ THIS ROUND REVERSES WHAT r336 SHIPPED, ON THE REPORTER'S INSTRUCTION. r336 moved this screen to
 * Administration › Organization as "Physical Work Location" and it went live; the reporter contested it
 * and asked for it back under Attendance, renamed **Locations**, listed by company, with Add / View /
 * Edit each on a screen of their own. That is their decision and it is approved. What follows records
 * what changed and what deliberately did not, so the next reader does not re-litigate either.
 *
 * WHAT MOVED: the NAV ROW ONLY (packs/attendance/index.ts ATTENDANCE_NAV, labelKey `locations`).
 * WHAT DID NOT:
 *   • the ROUTE. `/admin/work-locations` is unchanged. The reporter asked to rename the FUNCTION, not
 *     the address; moving it a second time in two days would churn every bookmark again and need the
 *     three `/admin/locations` redirect stubs re-pointed for nothing.
 *   • `screenKey: 'locations'` (lib/permissions.ts). It is a permission identity stored role configs
 *     may name, and renaming it would silently revoke every grant that does — r336 declined to rename
 *     it for exactly that reason and so does this round. Only `labelKey` and the nav PARENT follow.
 *   • the i18n namespace `admin.locations`, ~100 keys in six locales whose spelling no operator sees.
 *   • the drift ratchet. test/attendance-pack-drift.test.ts's allowlist is UNTOUCHED: it is about
 *     IMPORTS, not menus, and moving a nav row needs no surface claim. This file still reads the
 *     clocking register through the published facade (`packs/attendance/service`), never
 *     `core/clocking-location` — so the claim r336 removed stays removed. ADR-0080 allowlists only shrink.
 *
 * ⚠️ AND IT IS MODULE-GATED AGAIN, DELIBERATELY. `MODULE_OF_HREF` (components/sidebar.tsx) is built by
 * flatMap over the attendance pack's nav children, and `attendance` is BILLABLE, so returning the row to
 * that node re-gates this register behind the attendance entitlement — the 4509d2b8 Holidays precedent
 * in reverse. The tenant HAS attendance, so there is no live impact. The plan offered to keep it
 * un-gated and the reporter did not answer; their structure is built as they described it, and the
 * un-gating is a one-line change (a `['/admin/work-locations', …]`-shaped exemption) if they ask.
 *
 * ── WHAT THIS PAGE IS ──────────────────────────────────────────────────────────────────────────────
 * Company | Location | Status | Action, one block per company. EVERY company the caller administers
 * appears, whether or not it has a location — that is what makes the "Add" row useful, and it is the
 * reporter's own words.
 *
 * SCOPE IS THE QUERY, NOT THE UI. `listCompanies(s, { adminOnly: true })` applies the database's own
 * `app.is_admin_for` — the same predicate the company table's WITH CHECK uses — so every company listed
 * here is one this person can actually write a location for. app/admin/organization/page.tsx records the
 * rule this follows: *the filter IS the permission boundary*. Feedback ab77dc1f is the incident behind
 * it — a tenant-wide list disclosed how many companies the organisation has to someone whose access did
 * not otherwise reveal it. A listing showing every company to an admin scoped to two repeats it.
 * The company SWITCHER (getScopeIds) is deliberately NOT applied, for the reason the Organization
 * listing gives: this is a master-data screen, not an operational one (0f1802bf). It was applied before
 * this round, which is why the count on screen can now be larger than it was.
 *
 * ⚠️ A COMPANY CAN HAVE MORE THAN ONE LOCATION, AND EVERY ONE OF THEM RENDERS. The reporter's example
 * shows one per company; production on 2026-09-25 has 13 companies, 6 with a location and 8 locations
 * between them. So a company with two gets TWO LINES, `rowSpan`ned under one Company cell and one
 * Status cell: nothing is summarised as "+1 more" and nothing is hidden behind a count. Each line
 * carries its own View / Edit, and the company's Add sits on the last line of its block — because a
 * company that already has a location must still be able to gain a second, which the old per-company
 * create strip allowed and a listing offering Add only to empty companies would have taken away.
 *
 * ⚠️ STATUS IS A DERIVED WORD, NOT A COLUMN. `location` has no active/inactive flag; what the screens
 * have is archive / restore. So Status here means exactly "this company has at least one location that
 * is not archived", and `t('statusLegend')` SAYS SO on the page, under the table. Inventing a status
 * nobody can set would have been worse than having none.
 *
 * NO FORM, ABOVE OR BELOW. Add, View and Edit open ./new, ./[id] and ./[id]/edit; Save, Cancel and Back
 * all return here, carrying the listing's own query through `?from=` (lib/return-to.ts
 * `withWorkLocationsFrom` / `workLocationsReturnTo`, whitelisted by shape). This page posts NOTHING: it
 * renders links and a table, and zero form elements — asserted as a raw source scan in
 * test/clocking-location-shared.test.ts, which is why the opening angle bracket of that tag name is
 * deliberately absent from this comment as well as from the code.
 *
 * THE CLOCKING REGISTER LEFT THIS PAGE. Until r338 it led the screen: every clocking point in the
 * tenant, grouped under the location it links to. The points now render on the location's OWN screen
 * (./[id] read-only, ./[id]/edit with its controls), which is the "a site and its points stay
 * maintained in one place" half of the item. Points linked to NO location — the link has been optional
 * since f9afd1ce/0459 — would have become unreachable, so they keep a screen of their own
 * (./clocking/page.tsx) and this page links to it with a count rather than pretending they do not exist.
 */

export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; focus?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.locations');
  const { error, saved, focus: rawFocus } = await searchParams;
  // `?focus=` addresses a uuid; junk is dropped rather than rendered (lib/calendar-focus.ts idiom).
  const focus = rawFocus && UUID_RE.test(rawFocus) ? rawFocus : undefined;

  const companies = await listCompanies(s, { adminOnly: true });
  const companyIds = companies.map((c) => c.id);
  // Archived locations are INCLUDED: their history stays reachable, they render with their own badge,
  // and Restore lives on the location's Edit screen. They do not make a company Active.
  const locations = await listLocations(s, companyIds, { includeArchived: true });
  const byCompany = new Map<string, typeof locations>();
  for (const l of locations) {
    const arr = byCompany.get(l.companyId);
    if (arr) arr.push(l);
    else byCompany.set(l.companyId, [l]);
  }

  // 1fff489c — "fix it once instead of chasing it person by person": branches the live employees of a
  // company actually carry that no live location claims. Their Attendance tab can propose nothing until
  // one of them is mapped, so this is what makes the Add link on a row purposeful rather than decorative.
  const unmappedBranches = await listUnmappedBranches(s, companyIds);
  const unmappedByCompany = new Map<string, typeof unmappedBranches>();
  for (const u of unmappedBranches) {
    const arr = unmappedByCompany.get(u.companyId);
    if (arr) arr.push(u);
    else unmappedByCompany.set(u.companyId, [u]);
  }

  // The points that hang off no location the caller can see. Read through the pack's published facade —
  // the ratchet's rule, unchanged by the menu move. Tenant-catalog read (RLS lets every tenant member
  // through), but this admin-only route only ever renders it for an admin.
  const clockingLocations = await listClockingLocations(s, { includeArchived: true });
  const offRegister = clockingLocations.filter((cl) => !cl.locationId || cl.locationCode == null);

  /** This screen as the operator is standing on it, so every way out can come back to exactly here. */
  const here = (() => {
    const params = new URLSearchParams();
    if (saved) params.set('saved', saved);
    if (focus) params.set('focus', focus);
    const q = params.toString();
    return q ? `${LOCATIONS_LIST}?${q}` : LOCATIONS_LIST;
  })();
  const withFrom = (dest: string) => withWorkLocationsFrom(dest, here);

  const withLocation = companies.filter((c) => (byCompany.get(c.id) ?? []).some((l) => !l.archivedAt)).length;

  const statusPill = (active: boolean) => (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
        active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
      }`}
    >
      {active ? t('statusActive') : t('statusInactive')}
    </span>
  );

  const addLink = (companyId: string) => (
    <Link href={withFrom(`${LOCATION_NEW_PAGE}?companyId=${companyId}`)} className="text-primary hover:underline">
      {t('add')}
    </Link>
  );

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('pageTitle')}
        description={t('companySummary', { total: companies.length, withLocation })}
      />
      <ErrorBanner message={error} />

      {/* `saved=1` is what a successful Save returns with; a refusal never lands here. */}
      {!error && saved ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t('locationSaved')}
        </p>
      ) : null}

      <p className="px-1 text-sm text-muted-foreground">{t('pageDescription')}</p>

      <Card className="overflow-hidden">
        {companies.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('noCompanies')}</p>
        ) : (
          <div className={cn(tableWrapCls, 'rounded-none border-0')}>
            <table className="w-full text-sm">
              <thead className={cn(theadCls, 'border-b border-border bg-transparent')}>
                <tr>
                  <th className={thCls}>{t('colCompany')}</th>
                  <th className={thCls}>{t('colLocation')}</th>
                  <th className={thCls}>{t('colStatus')}</th>
                  <th className={cn(thCls, 'text-right')}>{t('colAction')}</th>
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {companies.map((c) => {
                  const rows = byCompany.get(c.id) ?? [];
                  const active = rows.some((l) => !l.archivedAt);
                  // A COMPANY WITH NO LOCATION IS STILL A ROW — the reporter's whole point. One line,
                  // an em dash where the location would be, Inactive, and the Add that gives it one.
                  if (rows.length === 0) {
                    return (
                      <tr key={c.id} id={`company-${c.id}`}>
                        <td className="px-3 py-2 font-medium">{c.name}</td>
                        <td className="px-3 py-2 text-muted-foreground">—</td>
                        <td className="px-3 py-2">{statusPill(false)}</td>
                        <td className="px-3 py-2 text-right">{addLink(c.id)}</td>
                      </tr>
                    );
                  }
                  return rows.map((l, i) => (
                    <tr
                      key={l.id}
                      id={`row-${l.id}`}
                      className={l.id === focus ? 'bg-muted/50' : undefined}
                    >
                      {/* rowSpan, so the company is named ONCE however many locations it has, and the
                          derived Status — a company-level word — is stated once beside it. */}
                      {i === 0 && (
                        <td className="px-3 py-2 align-top font-medium" rowSpan={rows.length}>
                          {c.name}
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <span className={l.archivedAt ? 'text-muted-foreground line-through' : undefined}>
                          {l.code} · {l.name}
                        </span>
                        {l.archivedAt && (
                          <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                            {t('statusArchived')}
                          </span>
                        )}
                      </td>
                      {i === 0 && (
                        <td className="px-3 py-2 align-top" rowSpan={rows.length}>
                          {statusPill(active)}
                        </td>
                      )}
                      <td className="px-3 py-2 text-right">
                        <span className="inline-flex items-center gap-2">
                          <Link href={withFrom(locationViewPage(l.id))} className="text-primary hover:underline">
                            {t('view')}
                          </Link>
                          <span className="text-muted-foreground">|</span>
                          <Link href={withFrom(locationEditPage(l.id))} className="text-primary hover:underline">
                            {t('edit')}
                          </Link>
                          {i === rows.length - 1 && (
                            <>
                              <span className="text-muted-foreground">|</span>
                              {addLink(c.id)}
                            </>
                          )}
                        </span>
                      </td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* The derived word, said out loud. Without this the screen would be asserting a status nobody
          can set and no column holds. */}
      <p className="px-1 text-xs text-muted-foreground">{t('statusLegend')}</p>

      {unmappedBranches.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">
            {t('unmappedBranchesHeading')}
          </div>
          <ul className="divide-y divide-border">
            {companies
              .filter((c) => (unmappedByCompany.get(c.id) ?? []).length > 0)
              .map((c) => (
                <li key={c.id} className="px-4 py-3">
                  <p className="text-sm font-medium">{c.name}</p>
                  <ul className="mt-1 space-y-0.5">
                    {(unmappedByCompany.get(c.id) ?? []).map((u) => (
                      <li key={u.branch} className="text-xs text-muted-foreground">
                        {t('unmappedBranchRow', { branch: u.branch, count: u.headcount })}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ul>
        </Card>
      )}

      {/* Not a summary of the clocking register — the register is on each location's own screen now.
          This is the ONE thing that would otherwise have nowhere to be: a point linked to no location
          (or to one this caller's RLS cannot reach) that would simply have vanished from the product. */}
      {offRegister.length > 0 && (
        <p className="px-1 text-sm">
          <Link href={UNLINKED_CLOCKING_PAGE} className="text-primary hover:underline">
            {t('offRegisterLink', { count: offRegister.length })}
          </Link>
        </p>
      )}
    </div>
  );
}
