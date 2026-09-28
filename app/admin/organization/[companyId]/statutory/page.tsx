import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listProfileOptions } from '@/core/profile-options';
import { packFor } from '@/localization/registry';
import { listCompanyBankProfiles } from '@/core/bank-profile';
import { listCompanyStatutoryAuthorities, listSignatoryCandidates } from '@/packs/payroll/service';
import { Card, ErrorBanner, PageHeader, pageWideCls } from '@/components/ui';
import { StatutorySetupScreen } from '@/components/statutory-setup-screen';
import {
  removeCompanyStatutoryAuthorityAction,
  setCompanyStatutoryAuthorityAction,
} from '../../../actions';

/**
 * Admin → Organization → one company → STATUTORY PAYMENT SETUP (item 15e5bd93 revision 2, r353).
 *
 * ── WHY THIS IS A ROUTE AND NOT A TAB ─────────────────────────────────────────────────────────────
 * r352 built the eight bodies as a rail plus a workspace INSIDE the company panel's Statutory tab. The
 * reporter contested it in writing: "Do not expand the statutory settings directly within the existing
 * Statutory tab… The preferred approach is a dedicated full-width screen." This is that screen, and the
 * Statutory tab now lists the bodies read-only and links here (components/company-panel.tsx).
 *
 * ⚠️ components/company-panel.tsx ARGUED AGAINST A ROUTE, AND THE ARGUMENT WAS ABOUT A DIFFERENT ROUTE.
 * Its r352 note refused `/admin/organization/<id>/<body>` — one route PER AUTHORITY — because it "would
 * put a page load between 'which body do I mean' and 'here are its fields'". That objection is intact and
 * this is not that: ONE route for the whole setup, showing every body at once, with no page load between
 * bodies at all. The note has been reworded where it stood so it cannot be read as forbidding this.
 *
 * ── THE SCOPE GUARD IS THE FIRST THING THIS PAGE DOES ─────────────────────────────────────────────
 * Mirrors app/admin/organization/[companyId]/page.tsx exactly, because a second door onto the same
 * company's data must not be an easier door. `listCompanies(..., { adminOnly: true })` applies the
 * database's own `app.is_admin_for`; a `companyId` in the address that is not in that set is NOT rendered
 * read-only and is NOT quietly coerced — it 404s, before any per-company read runs.
 *
 * The writes are independently refused by RLS, so this is defence in depth rather than the only lock —
 * but a screen that renders another company's bank accounts has already leaked them whether or not the
 * save would have failed. test/organization-list-detail.test.ts asserts the refusal for both routes.
 *
 * ⚠️ REGISTERED IN `lib/permissions.ts` UNDER screenKey 'organization', guard 'scopedAdmin'. A guarded
 * page on disk that is absent from the SCREENS matrix fails test/function-access.test.ts (reverse
 * completeness), and it is deliberately NOT a function-access right of its own: maintaining a company's
 * statutory payment setup is the same administrative capability as maintaining the company.
 *
 * ⚠️ ONE i18n NAMESPACE (`admin.organization`) — the same one the panel and the listing use, so a caption
 * shown on both the read-only rail and this screen can only ever be one string.
 */
export default async function CompanyStatutorySetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { s } = await scopedAdmin();
  const { companyId } = await params;
  const { error } = await searchParams;
  const t = await getTranslations('admin.organization');

  const companies = await listCompanies(s, { includeArchived: true, adminOnly: true });
  // THE REFUSAL. Out of the administrable set ⇒ this company does not exist as far as this screen is
  // concerned. Resolved before any per-company read runs.
  const c = companies.find((x) => x.id === companyId);
  if (!c) notFound();

  const [statutory, bankProfiles, authorities, signatories, stateOpts] = await Promise.all([
    // Rung 5c — company statutory rows come through the pack registry (ADR-0080 D1), not a direct import.
    // A non-MY company simply has no row.
    packFor('MY')?.companyStatutory.get(s, companyId) ?? null,
    listCompanyBankProfiles(s, companyId),
    // These are Payroll-PACK reads through the facade (the same import site the company detail page uses)
    // and are deliberately NOT module-gated: each body's card also carries the company's EPF / SOCSO /
    // LHDN filing number and its HRD Corp band (company_statutory_my — the COUNTRY axis, not Payroll), so
    // hiding the cards would take that identity away from a tenant without Payroll. r298's reasoning,
    // unchanged by the move to a route.
    listCompanyStatutoryAuthorities(s, companyId),
    listSignatoryCandidates(s),
    listProfileOptions(s, 'state', { activeOnly: true }),
  ]);

  const isMY = c.country === 'MY';

  return (
    <div className={pageWideCls}>
      {/**
       * Approved point 1: the company NAME in the heading, with its SSM and MyInvois numbers beside it.
       *
       * ⚠️ READ-ONLY HERE, AND EDITED ON THE STATUTORY TAB. Neither number is a body an employer pays a
       * contribution to and neither is in STATUTORY_AUTHORITIES, so neither gets a card (r226; the full
       * argument is in lib/statutory-authority-display.ts). What the reporter asked for is to be able to
       * CHECK them from this screen without going back, which is what printing them in the heading does.
       * The SSM number is also read by two statutory files we produce (localization/my/borang-8a.ts,
       * localization/my/socso-eis-file.ts), so it keeps one editor and one owner.
       *
       * An absent number prints nothing rather than an empty caption: `0.00`-style assertions about a
       * value nobody has entered are what §8 forbids, and "SSM —" reads as a number somebody deleted.
       */}
      <PageHeader
        title={t('statutoryScreenTitle')}
        description={[
          c.name,
          statutory?.ssmRegistrationNo ? `${t('ssmRegistrationNo')} ${statutory.ssmRegistrationNo}` : null,
          statutory?.myinvoisTin ? `${t('myinvoisTin')} ${statutory.myinvoisTin}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        // Approved point 5: Back returns to the company's STATUTORY tab, not to the company list and not
        // to the General tab. `?tab=statutory` is the panel's own linkable tab contract (65b22c00).
        back={{ href: `/admin/organization/${c.id}?tab=statutory`, label: t('backToStatutoryTab') }}
      />
      <ErrorBanner message={error} />

      <Card>
        {isMY ? (
          <StatutorySetupScreen
            companyId={c.id}
            filingCountry={c.country}
            statutory={statutory}
            statutoryAuthorities={authorities}
            bankProfiles={bankProfiles}
            // The authorised-signatory picker is COMPANY-scoped: the service refuses to newly appoint
            // anyone who is not an active employee of this company, so a tenant-wide list would only
            // offer choices that fail on save.
            signatories={signatories.filter((sg) => sg.companyId === companyId)}
            stateOptions={stateOpts.map((o) => ({ value: o.value, label: o.label }))}
            actions={{
              // The EXISTING per-body writers, passed by reference from a `'use server'` module and never
              // wrapped in a closure built here (the r123 hazard). They reach the same two services they
              // always did; what the forms add is `returnTo`, which is how the save knows to come back
              // here instead of to the company panel (app/admin/actions.ts fromStatutorySetupScreen).
              setStatutoryAuthority: setCompanyStatutoryAuthorityAction,
              removeStatutoryAuthority: removeCompanyStatutoryAuthorityAction,
            }}
          />
        ) : (
          <p className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
            {t('noStatutoryPack', { country: c.country })}
          </p>
        )}
      </Card>
    </div>
  );
}
