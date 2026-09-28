import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { companyTree, listCompanies } from '@/core/read';
import { listProfileOptions } from '@/core/profile-options';
import { packFor } from '@/localization/registry';
import { listCompanyBankProfiles } from '@/core/bank-profile';
import { listCompanyStatutoryAuthorities, listSignatoryCandidates } from '@/packs/payroll/service';
import { listPayrollCycles } from '@/packs/payroll/service';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { Card, ErrorBanner, PageHeader, pageWideCls } from '@/components/ui';
import { CompanyPanel } from '@/components/company-panel';
import { isCompanyPanelTab } from '@/lib/company-panel-tabs';
// 7d2df42a — the duplicate-code warning's data, from the administrable read already taken below.
import { companyCodeHolders } from '@/lib/company-code';
import { resolveGroupTree } from '../group-tree';
import {
  archiveCompanyAction,
  deleteCompanyAction,
  removeCompanyBankProfileAction,
  removeCompanyLogoAction,
  removeCompanyStatutoryAuthorityAction,
  setCompanyBankProfileAction,
  setCompanyStatutoryAuthorityAction,
  setCompanyLogoAction,
  setCompanyParentAction,
  setCompanyStatutoryAction,
  saveCompanyGeneralTabAction,
  updateCompanyAction,
  updateCompanyDefaultCycleAction,
} from '../../actions';

/**
 * Admin → Organization → ONE COMPANY: the maintenance screen (item defd4644).
 *
 * The company panel used to expand in place inside the listing, which meant every company's full
 * editable panel — the whole company array, the state catalog and twelve server-action references,
 * per row — was serialised to the client at once. Editing now opens a page, so exactly ONE panel is
 * built and the reads below are per-company instead of tenant-wide + N payroll-cycle queries.
 *
 * ── THE SCOPE GUARD IS THE FIRST THING THIS PAGE DOES ─────────────────────────────────────────────
 * `listCompanies(..., { adminOnly: true })` applies the database's own `app.is_admin_for`. A
 * `companyId` in the address that is not in that set is NOT rendered read-only and is NOT quietly
 * coerced to something else — it 404s. Selection lives in the URL precisely so this server-side check
 * runs on it; hand-typing another company's id must be a refusal, and test/organization-list-detail
 * asserts the refusal, not just the happy path.
 *
 * The panel's own writes are independently refused by RLS, so this guard is defence in depth rather
 * than the only lock — but a screen that renders another company's bank accounts has already leaked
 * them whether or not the save would have failed.
 *
 * ⚠️ ONE i18n NAMESPACE (`admin.organization`) — see the note on the listing page.
 */
export default async function CompanyMaintenancePage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ error?: string; tab?: string }>;
}) {
  const { s } = await scopedAdmin();
  const { companyId } = await params;
  const { error, tab } = await searchParams;
  const t = await getTranslations('admin.organization');

  const [companies, tree] = await Promise.all([
    listCompanies(s, { includeArchived: true, adminOnly: true }),
    companyTree(s),
  ]);
  // THE REFUSAL. Out of the administrable set ⇒ this company does not exist as far as this screen is
  // concerned. Resolved before any per-company read runs, so an out-of-scope id never even hits them.
  const c = companies.find((x) => x.id === companyId);
  if (!c) notFound();

  /**
   * r298 (board ceb1c560) — THE DEFAULT PAYROLL CYCLE IS A PAYROLL SECTION, AND A TENANT WITHOUT PAYROLL
   * DOES NOT GET IT. Organization is a CORE screen; the cycle catalogue is the Payroll pack's
   * (core/payroll-cycle.ts). So the READ is skipped, not merely its render: this unconditional read is one
   * of the two things core/module-gate.ts names as stopping core/payroll-cycle.ts from being bound.
   *
   * Tenant-wide (no companyId), for the reason core/module-gate.ts's COMPANY SCOPE paragraph gives: the
   * rail, the route guard and the service gate all ask tenant-wide, so a company-scoped-only grant reads
   * OFF here too rather than in two places of three. The QUIET form because this is a display decision.
   *
   * `null` is the section's absence, not an empty list: `[]` still draws the form (disabled, with its
   * "no active cycles" warning), which would tell a customer who never bought Payroll to go and set one up.
   */
  const payrollOn = isModuleEnabledOrFalse(s, 'payroll');

  const [statutory, bankProfiles, authorities, signatories, stateOpts, cycles] = await Promise.all([
    // Rung 5c — company statutory rows come through the pack registry (ADR-0080 D1), not a direct
    // import. A non-MY company simply has no row, exactly as the grouped listing resolved it before.
    packFor('MY')?.companyStatutory.get(s, companyId) ?? null,
    listCompanyBankProfiles(s, companyId),
    // r298 — these two ARE Payroll-pack reads (core/statutory-authority.ts) and are deliberately NOT gated
    // by the payroll check below. Each statutory body's card on the Statutory tab also carries the
    // company's EPF / SOCSO / LHDN filing numbers and its HRD Corp band (company_statutory_my, the COUNTRY
    // axis, not Payroll) and saves both halves with one button; hiding the card would take that identity
    // away from a tenant without Payroll while the header badge still counted it. Splitting the card is
    // its own change.
    listCompanyStatutoryAuthorities(s, companyId),
    listSignatoryCandidates(s),
    // Enhance Company General Tab (bc5d4891): the tenant-wide profile-option catalog backs the
    // Contact-Information State pick-list. 94ae7e1f — Country uses the shared ISO list (lib/countries).
    listProfileOptions(s, 'state', { activeOnly: true }),
    // Organization Module (361e3b15): THIS company's ACTIVE cycles, so the General-tab picker lists its
    // own cycles with the saved default pre-selected (and can flag a default that is no longer active).
    payrollOn ? listPayrollCycles(s, companyId, { activeOnly: true }) : null,
  ]);

  // The group hierarchy still comes from the separate companyTree read — listCompanies does not carry
  // parentCompanyId, and the parent picker on this page is where the hierarchy is SET.
  const { parentBy } = resolveGroupTree(companies, tree);

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={c.name}
        description={[c.registrationNo, c.country].filter(Boolean).join(' · ')}
        back={{ href: '/admin/organization', label: t('backToCompanies') }}
      />
      <ErrorBanner message={error} />

      {/* 3783fd87 — THE WHITE CARD THE REST OF THE MODULE ALREADY HAS. The listing wraps each of its
          sections in a <Card>; this screen put the panel straight onto the page, whose ground is
          `--background` (#f5f6fa). So the one screen the reporter spends the most time on was the one
          screen with no card at all — grey page, grey tab shell, grey blocks — which is the "excessive
          grey background" of the request. The Card is the wrapper, not a new component: everything
          inside it is unchanged except its own greys (see components/company-panel.tsx). */}
      <Card>
      <CompanyPanel
        company={{
          id: c.id,
          name: c.name,
          country: c.country,
          currency: c.currency,
          registrationNo: c.registrationNo,
          companyLabel: c.companyLabel,
          industry: c.industry,
          website: c.website,
          businessType: c.businessType,
          addressLine1: c.addressLine1,
          addressLine2: c.addressLine2,
          addressLine3: c.addressLine3,
          city: c.city,
          state: c.state,
          addressCountry: c.addressCountry,
          postcode: c.postcode,
          phone: c.phone,
          fax: c.fax,
          archivedAt: c.archivedAt,
          inUse: c.inUse,
          parentId: parentBy.get(c.id) ?? null,
          hasLogo: c.hasLogo,
          defaultPayrollCycle: c.defaultPayrollCycle,
        }}
        // The parent picker offers only companies this admin can administer — the same set the listing
        // shows. Re-parenting into a company you cannot administer is refused by the service anyway;
        // not offering it keeps the screen from disclosing that the company exists.
        companies={companies}
        // 7d2df42a — the codes already in use, for the warning under the Company Code field. Derived from
        // the SAME `adminOnly` read above (no second query, no second source), and `companyCodeHolders`
        // drops the archived ones: a code recycled from a company retired years ago is not a collision
        // worth a warning, and an archived company's name is not shipped to the browser for one either.
        codesInUse={companyCodeHolders(companies)}
        statutory={statutory}
        bankProfiles={bankProfiles}
        statutoryAuthorities={authorities}
        signatories={signatories.filter((sg) => sg.companyId === companyId)}
        stateOptions={stateOpts.map((o) => ({ value: o.value, label: o.label }))}
        activeCycleNames={cycles ? cycles.map((r) => r.name) : null}
        // 65b22c00 — the tab a save came from, VALIDATED against the closed list here rather than
        // trusted: `?tab=` is reader-supplied, and an unrecognised value simply opens General. It is
        // this half that makes "stay on the screen" mean the screen they were actually on; without it
        // every statutory and bank save would land back on the General tab.
        initialTab={isCompanyPanelTab(tab) ? tab : undefined}
        // 3c2f55d7 — `defaultExpanded` is gone, not defaulted: the panel no longer folds at all. This
        // was its only caller and it always passed the prop, so the flag could only ever have one
        // value; the same reasoning now applies to the three folds that were INSIDE the panel.
        actions={{
          updateCompany: updateCompanyAction,
          archiveCompany: archiveCompanyAction,
          deleteCompany: deleteCompanyAction,
          setParent: setCompanyParentAction,
          setStatutory: setCompanyStatutoryAction,
          setBankProfile: setCompanyBankProfileAction,
          removeBankProfile: removeCompanyBankProfileAction,
          setStatutoryAuthority: setCompanyStatutoryAuthorityAction,
          removeStatutoryAuthority: removeCompanyStatutoryAuthorityAction,
          setCompanyLogo: setCompanyLogoAction,
          removeCompanyLogo: removeCompanyLogoAction,
          updateCompanyDefaultCycle: updateCompanyDefaultCycleAction,
          // 65b22c00 — the General tab's ONE Save. A server action handed to a client island as a prop
          // is the r123 hazard, and this is the shape that is safe: the action is declared in a
          // `'use server'` module and passed by reference, never wrapped in a closure built here.
          saveGeneralTab: saveCompanyGeneralTabAction,
          // 15e5bd93 rev 2 (r353) — `saveStatutoryTab` STOOD HERE. The reporter contested r352's in-tab
          // statutory redesign, so the bodies moved to /admin/organization/[companyId]/statutory with a
          // Save on each card, the consolidated statutory action is retired, and the registrations card on
          // the Statutory tab has its own Save button again (components/company-panel.tsx).
        }}
      />
      </Card>
    </div>
  );
}
