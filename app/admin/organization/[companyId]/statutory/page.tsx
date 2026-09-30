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
import { saveCompanyStatutoryTabAction } from '../../statutory-tab-actions';
import {
  removeCompanyStatutoryAuthorityAction,
  setCompanyStatutoryAuthorityAction,
} from '../../../actions';

/**
 * Admin → Organization → one company → STATUTORY PAYMENT SETUP (item 15e5bd93 revision 4, r370).
 *
 * ── WHY THIS IS A ROUTE AND NOT A TAB ─────────────────────────────────────────────────────────────
 * r352 built the eight bodies as a rail plus a workspace INSIDE the company panel's Statutory tab. The
 * reporter contested it in writing: "Do not expand the statutory settings directly within the existing
 * Statutory tab… The preferred approach is a dedicated full-width screen." This is that screen, and the
 * Statutory tab now lists the bodies read-only and links here (components/company-panel.tsx).
 *
 * ── AND WHY THE ROUTE PER BODY THAT SAT BESIDE IT IS GONE (r370) ──────────────────────────────────
 * r353 answered "dedicated screen" with eight always-visible cards, each read-only until its own Edit was
 * pressed; contested. r355 answered the reporter's own ASCII sketch with a TABLE of one row per body and
 * `./[authority]/page.tsx` holding one body at a time; the reporter called that page "an unnecessary
 * intermediate page". Revision 4 deletes it. Everything is on THIS route now — every body as a card,
 * every field open, one Save — and there is no second statutory route to guard, register or redirect to.
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
 * completeness), and it is deliberately not a function-access right of its own: maintaining a company's
 * statutory payment setup is the same administrative capability as maintaining the company.
 *
 * ⚠️ ONE i18n NAMESPACE (`admin.organization`) — the same one the panel and the listing use, so a caption
 * shown on more than one of them can only ever be one string.
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
   * FIVE READS. r355's list needed three because it held no form at all and the signatory picker and the
   * state catalogue belonged to the per-body route. Every body's editor is on this page now, so the two
   * reads come back with them — this is the only page that can use them.
   */
  const [statutory, bankProfiles, authorities, signatories, stateOpts] = await Promise.all([
    // Rung 5c — company statutory rows come through the pack registry (ADR-0080 D1), not a direct import.
    // A non-MY company simply has no row.
    packFor('MY')?.companyStatutory.get(s, companyId) ?? null,
    listCompanyBankProfiles(s, companyId),
    // A Payroll-PACK read through the facade (the same import site the company detail page uses), and
    // deliberately NOT module-gated: the identity card carries the company's EPF / SOCSO / LHDN filing
    // number and its HRD Corp rate (company_statutory_my — the COUNTRY axis, not Payroll), so hiding the
    // screen would take that identity away from a tenant without Payroll. r298's reasoning, unchanged.
    listCompanyStatutoryAuthorities(s, companyId),
    listSignatoryCandidates(s),
    listProfileOptions(s, 'state', { activeOnly: true }),
  ]);

  const isMY = c.country === 'MY';
  // Back and Cancel go to the same place — the company's STATUTORY tab, not the company list and not the
  // General tab. `?tab=statutory` is the panel's own linkable tab contract (65b22c00).
  const backHref = `/admin/organization/${c.id}?tab=statutory`;

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('statutoryScreenTitle')}
        description={c.name}
        back={{ href: backHref, label: t('backToStatutoryTab') }}
      />
      <ErrorBanner message={error} />

      {/**
       * ⚠️ `p-4` IS A FIX (defect D5). `Card` carries no padding of its own and this page used none, so
       * the first label of the first card sat ON the card's left border (measured x=265 with the border
       * at 265) and the last value on the right one. The company panel gets its inset from its tab
       * shell's `px-4 py-4`; this screen has no tab shell, so it says so here.
       */}
      <Card className="p-4">
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
            backHref={backHref}
            actions={{
              /**
               * Three server actions, each declared in a `'use server'` module and passed BY REFERENCE,
               * never wrapped in a closure built here (the r123 hazard, which
               * test/server-client-boundary.test.ts pins). `saveStatutoryScreen` is the one Save;
               * `setStatutoryAuthority` is each card form's own binding, which the save scope intercepts;
               * `removeStatutoryAuthority` is Clear, which is bucket (b) and still redirects.
               */
              saveStatutoryScreen: saveCompanyStatutoryTabAction,
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
