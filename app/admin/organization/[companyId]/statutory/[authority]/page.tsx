import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listProfileOptions } from '@/core/profile-options';
import { packFor } from '@/localization/registry';
import { listCompanyBankProfiles } from '@/core/bank-profile';
import { listCompanyStatutoryAuthorities, listSignatoryCandidates } from '@/packs/payroll/service';
import { isStatutoryAuthority } from '@/lib/statutory-authorities';
import { Card, ErrorBanner, PageHeader, pageWideCls } from '@/components/ui';
import { StatutoryBodyScreen } from '@/components/statutory-body-screen';
import {
  removeCompanyStatutoryAuthorityAction,
  setCompanyStatutoryAuthorityAction,
} from '../../../../actions';

/**
 * Admin → Organization → one company → Statutory Payment Setup → ONE BODY (item 15e5bd93 revision 3, r355).
 *
 * ── WHY THIS ROUTE EXISTS, AND WHY THE COMMENT THAT ONCE FORBADE IT DOES NOT APPLY ────────────────
 * r352 argued in components/company-panel.tsx against `/admin/organization/<id>/<body>` on the grounds that
 * it "would put a page load between 'which body do I mean' and 'here are its fields'". r353 quoted that
 * argument as still binding and built eight always-visible cards on the list screen instead. THE REPORTER
 * CONTESTED THAT AND DREW THE OPPOSITE: their own sketch is a table of one row per body where "Selecting
 * Edit → EPF opens a screen containing ONLY the EPF fields, with Cancel / Save", and the approved plan's
 * words are "View and Edit open a screen for that one body alone. Editing EPF shows EPF and nothing else."
 * The page load between the list and the fields is the thing they asked for. That comment has been reworded
 * where it stands so it cannot be read as forbidding this.
 *
 * ── TWO VALIDATED INPUTS, BOTH FROM THE ADDRESS, NEITHER ECHOED ───────────────────────────────────
 *  1. `companyId` — the same refusal the list route and the company detail page run: out of
 *     `listCompanies(..., { adminOnly: true })` ⇒ `notFound()`, before any per-company read. A third door
 *     onto one company's bank accounts and statutory identifiers must not be an easier door.
 *  2. `authority` — validated through `isStatutoryAuthority`, the SAME controlled set the service validates
 *     against (core/statutory-authority.ts) and the same one the list draws its rows from. An unknown body
 *     404s and the posted string is NEVER rendered, never put in a message argument and never built into a
 *     link: `authority_<key>` is resolved from the catalogue only after the value is known to be in the set,
 *     so a crafted path cannot reach a MISSING_MESSAGE, a reflected string or a broken address.
 *
 * `mode` is the third reader-supplied value and it is a CLOSED LIST of two: `edit` gets the form, anything
 * else — absent, misspelt, crafted — gets the read-only view. A wrong mode therefore degrades to the SAFER
 * of the two shapes rather than to an error page, and nothing about it is echoed either.
 *
 * ⚠️ REGISTERED IN `lib/permissions.ts` UNDER screenKey 'organization' — FIFTH ROUTE. A guarded page on disk
 * with no SCREENS column fails test/function-access.test.ts (reverse completeness), which is the trap r353
 * recorded for the list route and which this route walks into identically. It is deliberately not a
 * function-access right of its own: editing one body's payment setup is the same administrative capability
 * as maintaining the company.
 *
 * ⚠️ ONE i18n NAMESPACE (`admin.organization`), the same one the list and the panel use.
 */
export default async function CompanyStatutoryBodyPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string; authority: string }>;
  searchParams: Promise<{ mode?: string; error?: string }>;
}) {
  const { s } = await scopedAdmin();
  const { companyId, authority } = await params;
  const { mode: rawMode, error } = await searchParams;
  const t = await getTranslations('admin.organization');

  // THE AUTHORITY REFUSAL, first and before any read: an unknown body is not a body of this company with no
  // configuration, it is not a body at all.
  if (!isStatutoryAuthority(authority)) notFound();
  // THE CLOSED LIST. Two shapes; anything that is not the word `edit` is the read-only one.
  const mode = rawMode === 'edit' ? 'edit' : 'view';

  const companies = await listCompanies(s, { includeArchived: true, adminOnly: true });
  // THE COMPANY REFUSAL. Out of the administrable set ⇒ this company does not exist as far as this screen
  // is concerned.
  const c = companies.find((x) => x.id === companyId);
  if (!c) notFound();

  const [statutory, bankProfiles, authorities, signatories, stateOpts] = await Promise.all([
    // Rung 5c — company statutory rows come through the pack registry (ADR-0080 D1), not a direct import.
    packFor('MY')?.companyStatutory.get(s, companyId) ?? null,
    listCompanyBankProfiles(s, companyId),
    // Payroll-PACK reads through the facade, deliberately NOT module-gated — r298's reasoning, unchanged by
    // the split into two routes: this screen also carries the body's filing number and HRD Corp band, which
    // are `company_statutory_my` (the COUNTRY axis, not Payroll).
    listCompanyStatutoryAuthorities(s, companyId),
    listSignatoryCandidates(s),
    listProfileOptions(s, 'state', { activeOnly: true }),
  ]);

  const isMY = c.country === 'MY';
  const row = authorities.find((r) => r.authority === authority) ?? null;
  const listHref = `/admin/organization/${c.id}/statutory`;

  return (
    <div className={pageWideCls}>
      {/**
       * The heading is the BODY, because this screen is one body. Its name and purpose come from the same two
       * catalogue entries the list row and the panel row use (`authority_<key>` / `authorityDesc_<key>`), so
       * the three surfaces cannot call one body three different things. Both are resolved only after
       * `isStatutoryAuthority` has accepted the value.
       */}
      <PageHeader
        title={t(`authority_${authority}` as never)}
        description={[t(`authorityDesc_${authority}` as never), c.name].join(' · ')}
        // Back returns to the LIST, which is the reporter's own instruction: "Either way, Back returns you
        // to the list."
        back={{ href: listHref, label: t('backToStatutorySetup') }}
      />
      <ErrorBanner message={error} />

      <Card>
        {isMY ? (
          <StatutoryBodyScreen
            mode={mode}
            authority={authority}
            companyId={c.id}
            filingCountry={c.country}
            statutory={statutory}
            row={row}
            bankProfiles={bankProfiles}
            // The authorised-signatory picker is COMPANY-scoped: the service refuses to newly appoint anyone
            // who is not an active employee of this company, so a tenant-wide list would only offer choices
            // that fail on save.
            signatories={signatories.filter((sg) => sg.companyId === companyId)}
            stateOptions={stateOpts.map((o) => ({ value: o.value, label: o.label }))}
            actions={{
              // The EXISTING per-body writers, passed by reference from a `'use server'` module and never
              // wrapped in a closure built here (the r123 hazard). They reach the same two services they
              // always did; what the forms add is `returnTo`, which is how a save knows to return to the
              // LIST and a refusal knows to come back here (app/admin/actions.ts
              // `fromStatutorySetupScreen`, app/admin/_redirects.ts `failStatutoryBody`).
              setStatutoryAuthority: setCompanyStatutoryAuthorityAction,
              removeStatutoryAuthority: removeCompanyStatutoryAuthorityAction,
            }}
          />
        ) : (
          // The same sentence the list shows, for the same reason: this route is valid, the PACK is not
          // installed. A 404 here would say the address is wrong, which it is not.
          <p className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
            {t('noStatutoryPack', { country: c.country })}
          </p>
        )}
      </Card>
    </div>
  );
}
