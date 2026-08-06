import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { companyTree, listCompanies } from '@/core/read';
import { listProfileOptions } from '@/core/profile-options';
import { packFor } from '@/localization/registry';
import { listCompanyBankProfiles } from '@/core/bank-profile';
import { listCompanyStatutoryAuthorities, listSignatoryCandidates } from '@/core/statutory-authority';
import { listPayrollCycles } from '@/core/payroll-cycle';
import { ErrorBanner, PageHeader, pageWideCls } from '@/components/ui';
import { CompanyPanel } from '@/components/company-panel';
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
  searchParams: Promise<{ error?: string }>;
}) {
  const { s } = await scopedAdmin();
  const { companyId } = await params;
  const { error } = await searchParams;
  const t = await getTranslations('admin.organization');

  const [companies, tree] = await Promise.all([
    listCompanies(s, { includeArchived: true, adminOnly: true }),
    companyTree(s),
  ]);
  // THE REFUSAL. Out of the administrable set ⇒ this company does not exist as far as this screen is
  // concerned. Resolved before any per-company read runs, so an out-of-scope id never even hits them.
  const c = companies.find((x) => x.id === companyId);
  if (!c) notFound();

  const [statutory, bankProfiles, authorities, signatories, stateOpts, cycles] = await Promise.all([
    // Rung 5c — company statutory rows come through the pack registry (ADR-0080 D1), not a direct
    // import. A non-MY company simply has no row, exactly as the grouped listing resolved it before.
    packFor('MY')?.companyStatutory.get(s, companyId) ?? null,
    listCompanyBankProfiles(s, companyId),
    listCompanyStatutoryAuthorities(s, companyId),
    listSignatoryCandidates(s),
    // Enhance Company General Tab (bc5d4891): the tenant-wide profile-option catalog backs the
    // Contact-Information State pick-list. 94ae7e1f — Country uses the shared ISO list (lib/countries).
    listProfileOptions(s, 'state', { activeOnly: true }),
    // Organization Module (361e3b15): THIS company's ACTIVE cycles, so the General-tab picker lists its
    // own cycles with the saved default pre-selected (and can flag a default that is no longer active).
    listPayrollCycles(s, companyId, { activeOnly: true }),
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
        statutory={statutory}
        bankProfiles={bankProfiles}
        statutoryAuthorities={authorities}
        signatories={signatories.filter((sg) => sg.companyId === companyId)}
        stateOptions={stateOpts.map((o) => ({ value: o.value, label: o.label }))}
        activeCycleNames={cycles.map((r) => r.name)}
        // This IS the maintenance screen — the panel opens rather than making the reader click a
        // disclosure row that has nothing left to disclose.
        defaultExpanded
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
        }}
      />
    </div>
  );
}
