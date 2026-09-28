import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { packFor } from '@/localization/registry';
import { listCompanyBankProfiles } from '@/core/bank-profile';
import { listCompanyStatutoryAuthorities } from '@/packs/payroll/service';
import { Card, ErrorBanner, PageHeader, pageWideCls } from '@/components/ui';
import { StatutorySetupScreen } from '@/components/statutory-setup-screen';

/**
 * Admin → Organization → one company → STATUTORY PAYMENT SETUP, THE LIST (item 15e5bd93 revision 3, r355).
 *
 * ── WHY THIS IS A ROUTE AND NOT A TAB ─────────────────────────────────────────────────────────────
 * r352 built the eight bodies as a rail plus a workspace INSIDE the company panel's Statutory tab. The
 * reporter contested it in writing: "Do not expand the statutory settings directly within the existing
 * Statutory tab… The preferred approach is a dedicated full-width screen." This is that screen, and the
 * Statutory tab now lists the bodies read-only and links here (components/company-panel.tsx).
 *
 * ── AND WHY THERE IS NOW A ROUTE PER BODY BESIDE IT (r355) ────────────────────────────────────────
 * r353 answered "dedicated screen" with eight always-visible cards on THIS page, each read-only until its
 * own Edit was pressed. The reporter contested that too and drew the layout themselves: a table of one row
 * per body, and "Selecting Edit → EPF opens a screen containing ONLY the EPF fields, with Cancel / Save."
 * So this page holds the identity card and the table — NO fields and NO writers — and
 * `./[authority]/page.tsx` holds one body at a time. The comment in components/company-panel.tsx that once
 * argued against a per-authority route has been reworded there; the objection it raised was about a route
 * per authority ON THE TAB, and the reporter has since asked for exactly this.
 *
 * ── THE SCOPE GUARD IS THE FIRST THING THIS PAGE DOES ─────────────────────────────────────────────
 * Mirrors app/admin/organization/[companyId]/page.tsx exactly, because a second door onto the same
 * company's data must not be an easier door. `listCompanies(..., { adminOnly: true })` applies the
 * database's own `app.is_admin_for`; a `companyId` in the address that is not in that set is NOT rendered
 * read-only and is NOT quietly coerced — it 404s, before any per-company read runs.
 *
 * The writes are independently refused by RLS, so this is defence in depth rather than the only lock —
 * but a screen that renders another company's bank accounts has already leaked them whether or not the
 * save would have failed. test/organization-list-detail.test.ts asserts the refusal for all three routes.
 *
 * ⚠️ REGISTERED IN `lib/permissions.ts` UNDER screenKey 'organization', guard 'scopedAdmin', AND SO IS THE
 * PER-BODY ROUTE. A guarded page on disk that is absent from the SCREENS matrix fails
 * test/function-access.test.ts (reverse completeness), and neither is a function-access right of its own:
 * maintaining a company's statutory payment setup is the same administrative capability as maintaining the
 * company.
 *
 * ⚠️ ONE i18n NAMESPACE (`admin.organization`) — the same one the panel, the listing and the per-body screen
 * use, so a caption shown on more than one of them can only ever be one string.
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

  /**
   * ⚠️ THREE READS, NOT FIVE. r353's version of this page also fetched `listSignatoryCandidates` and the
   * state catalogue, because the eight editors were mounted here. They are not: this page has no form at
   * all, so the two reads move to the per-body route, which is the only place that can use them.
   */
  const [statutory, bankProfiles, authorities] = await Promise.all([
    // Rung 5c — company statutory rows come through the pack registry (ADR-0080 D1), not a direct import.
    // A non-MY company simply has no row.
    packFor('MY')?.companyStatutory.get(s, companyId) ?? null,
    listCompanyBankProfiles(s, companyId),
    // A Payroll-PACK read through the facade (the same import site the company detail page uses), and
    // deliberately NOT module-gated: the identity card carries the company's EPF / SOCSO / LHDN filing
    // number and its HRD Corp band (company_statutory_my — the COUNTRY axis, not Payroll), so hiding the
    // screen would take that identity away from a tenant without Payroll. r298's reasoning, unchanged.
    listCompanyStatutoryAuthorities(s, companyId),
  ]);

  const isMY = c.country === 'MY';

  return (
    <div className={pageWideCls}>
      {/**
       * The heading is the screen's name and the COMPANY's name, and nothing else. r353 also printed the SSM
       * and MyInvois numbers here; revision 3 moves them into the identity card at the top of the screen
       * body, with the four filing identifiers beside them, which is what the reporter drew.
       */}
      <PageHeader
        title={t('statutoryScreenTitle')}
        description={c.name}
        // Back returns to the company's STATUTORY tab, not to the company list and not to the General tab.
        // `?tab=statutory` is the panel's own linkable tab contract (65b22c00).
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
