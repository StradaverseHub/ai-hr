import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { companyTree, listCompanies } from '@/core/read';
import { listProfileOptions } from '@/core/profile-options';
import { packFor } from '@/localization/registry';
import { listAllCompanyBankProfiles } from '@/core/bank-profile';
// R46 orgbank (84719377) — per-authority statutory payment configuration + the company-scoped signatory
// candidates. Both are RLS-scoped listers, grouped by company here like the bank profiles.
import { listAllCompanyStatutoryAuthorities, listSignatoryCandidates } from '@/core/statutory-authority';
// Organization Module — Automatic Payroll Cycle Assignment (361e3b15): the Add-company Default Payroll Cycle
// picker lists the standard catalog names, and each company's General tab pre-selects its saved default from
// that company's ACTIVE cycles.
import { DEFAULT_PAYROLL_CYCLES, listPayrollCycles } from '@/core/payroll-cycle';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import {
  CompanyPanel,
  type PanelBankProfile,
  type PanelSignatory,
  type PanelStatutoryAuthority,
} from '@/components/company-panel';
import { OrganizationList } from '@/components/organization-list';
import { CompaniesCardHeader } from '@/components/add-company';
import {
  archiveCompanyAction,
  createCompanyAction,
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
} from '../actions';

type TreeNode = { id: string; name: string; country: string; parentId: string | null };

function CompanyTree({
  nodes,
  parentId = null,
  depth = 0,
}: {
  nodes: TreeNode[];
  parentId?: string | null;
  depth?: number;
}) {
  const children = nodes.filter((n) => n.parentId === parentId);
  if (children.length === 0) return null;
  return (
    <ul className={depth === 0 ? 'space-y-0.5' : 'ml-3 space-y-0.5 border-l border-border pl-3'}>
      {children.map((n) => (
        <li key={n.id}>
          <span className="text-sm font-medium text-foreground">{n.name}</span>{' '}
          <span className="text-xs text-muted-foreground">{n.country}</span>
          <CompanyTree nodes={nodes} parentId={n.id} depth={depth + 1} />
        </li>
      ))}
    </ul>
  );
}

export default async function OrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s } = await scopedAdmin();
  const { error } = await searchParams;
  const t = await getTranslations('admin.organization');
  // The tree stays unscoped (it needs every node to draw the group); the company panels follow
  // the active company context. Org catalogs (departments/positions/cost-centers/business-units) moved to
  // Settings → System Labels, so this page no longer fetches them.
  const [companies, tree, statutory, bankProfiles, authorities, signatories, stateOpts] = await Promise.all([
    listCompanies(s, { includeArchived: true }),
    companyTree(s),
    // Rung 5c — company statutory rows come through the pack registry (ADR-0080 D1), not a direct import.
    packFor('MY')?.companyStatutory.list(s) ?? [],
    listAllCompanyBankProfiles(s),
    listAllCompanyStatutoryAuthorities(s),
    listSignatoryCandidates(s),
    // Enhance Company General Tab (bc5d4891): reuse the tenant-wide profile-option catalog for the
    // Contact-Information State pick-list (same source the Personnel profile dropdowns read). 94ae7e1f — the
    // Country picker now uses the complete shared ISO list (lib/countries) instead of a curated catalog.
    listProfileOptions(s, 'state', { activeOnly: true }),
  ]);
  const stateOptions = stateOpts.map((o) => ({ value: o.value, label: o.label }));
  const statBy = new Map(statutory.map((r) => [r.companyId, r]));
  const bankBy = new Map<string, PanelBankProfile[]>();
  for (const bp of bankProfiles) {
    const list = bankBy.get(bp.companyId) ?? [];
    list.push({
      id: bp.id,
      bank: bp.bank,
      corporateId: bp.corporateId,
      debitAccountNo: bp.debitAccountNo,
      orgName: bp.orgName,
      txnType: bp.txnType,
      accountLabel: bp.accountLabel,
      accountName: bp.accountName,
      accountType: bp.accountType,
      branch: bp.branch,
      swiftCode: bp.swiftCode,
      currency: bp.currency,
      isPrimary: bp.isPrimary,
    });
    bankBy.set(bp.companyId, list);
  }
  const authorityBy = new Map<string, PanelStatutoryAuthority[]>();
  for (const a of authorities) {
    const list = authorityBy.get(a.companyId) ?? [];
    list.push({
      id: a.id,
      authority: a.authority,
      accountNo: a.accountNo,
      bankProfileId: a.bankProfileId,
      addressLine1: a.addressLine1,
      addressLine2: a.addressLine2,
      addressLine3: a.addressLine3,
      city: a.city,
      state: a.state,
      postcode: a.postcode,
      country: a.country,
      phone: a.phone,
      email: a.email,
      signatoryPersonId: a.signatoryPersonId,
    });
    authorityBy.set(a.companyId, list);
  }
  const signatoryBy = new Map<string, PanelSignatory[]>();
  for (const sg of signatories) {
    const list = signatoryBy.get(sg.companyId) ?? [];
    list.push({ personId: sg.personId, name: sg.name });
    signatoryBy.set(sg.companyId, list);
  }
  // Feedback efece4ce — the active Malaysian companies with NO statutory record at all. Payroll resolves a
  // missing row to hrdf_status = 'not_registered' and charges nothing, so a company can sit for months
  // producing zero HRDF with nothing anywhere saying it was never registered. Finding them previously meant
  // opening every company panel one at a time. Archived companies run no payroll; non-MY companies have no
  // MY statutory row by design — neither is a gap. Derived from the two lists already fetched, no new query.
  const missingStatutory = companies.filter(
    (c) => !c.archivedAt && c.country === 'MY' && !statBy.has(c.id),
  );
  const parentBy = new Map(tree.map((n) => [n.id, n.parentId]));
  // Organization Module (361e3b15): each company's ACTIVE payroll cycle names, so its General-tab picker lists
  // that company's own cycles with the saved default pre-selected (and can flag a saved default that is no
  // longer active). Read per company (tenant-scoped by RLS); the org admin's company list is small.
  const cycleNameLists = await Promise.all(
    companies.map((c) => listPayrollCycles(s, c.id, { activeOnly: true })),
  );
  const activeCycleNamesBy = new Map<string, string[]>();
  companies.forEach((c, i) => activeCycleNamesBy.set(c.id, cycleNameLists[i].map((r) => r.name)));
  // substrate: read-only, no event. The Companies management card is a tenant-wide master:
  // it renders every company regardless of the company-switcher scope (getScopeIds), unlike
  // operational screens which stay scoped. The switcher is intentionally ignored on this screen.

  const actions = {
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
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
      />
      <ErrorBanner message={error} />

      {/* Group structure is collapsed by default (native details/summary keeps this a server
          component — no client JS/state). Reuses SectionHeader's border/padding classes; the
          Show/Hide affordance toggles via the group-open CSS variant. CompanyTree stays
          server-rendered inside so navigation/rendering of the hierarchy is unchanged. */}
      <Card data-tour="people-org-tree">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between border-b border-border px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <span>
              {t('groupStructure')}
              <span className="ml-2 text-muted-foreground">({companies.length})</span>
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              <span className="group-open:hidden">{t('showGroupStructure')}</span>
              <span className="hidden group-open:inline">{t('hideGroupStructure')}</span>
            </span>
          </summary>
          <div className="px-4 py-3">
            {tree.length > 0 ? (
              <CompanyTree nodes={tree} />
            ) : (
              <p className="text-sm text-muted-foreground">{t('noCompaniesYet')}</p>
            )}
          </div>
        </details>
      </Card>

      {/* Feedback efece4ce — statutory-registration gaps, listed BEFORE the company grid so they are read
          rather than scrolled past. Read-only: which rate each company should carry is the operator's call,
          not something to guess on their behalf, so this names the companies and links nowhere else. */}
      {missingStatutory.length > 0 && (
        <Card>
          <SectionHeader title={t('statutoryMissingTitle')} count={missingStatutory.length} />
          <div className="px-4 py-3">
            <p className="text-xs text-muted-foreground">{t('statutoryMissingHint')}</p>
            <ul className="mt-2 space-y-1">
              {missingStatutory.map((c) => (
                <li key={c.id} className="text-sm text-foreground">
                  {c.name}
                  {c.registrationNo ? (
                    <span className="ml-2 text-xs text-muted-foreground">{c.registrationNo}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      <Card data-tour="people-org-companies">
        <CompaniesCardHeader
          title={t('companies')}
          count={companies.length}
          createAction={createCompanyAction}
          cycleOptions={DEFAULT_PAYROLL_CYCLES.map((c) => c.name)}
        />
        {companies.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noCompaniesYet')}</p>
        ) : (
          <OrganizationList
            items={companies.map((c) => ({
              id: c.id,
              name: c.name,
              registrationNo: c.registrationNo,
              node: (
                <CompanyPanel
                  key={c.id}
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
                    // Organization Module (361e3b15): the company's saved default payroll cycle name.
                    defaultPayrollCycle: c.defaultPayrollCycle,
                  }}
                  companies={companies}
                  statutory={statBy.get(c.id) ?? null}
                  bankProfiles={bankBy.get(c.id) ?? []}
                  statutoryAuthorities={authorityBy.get(c.id) ?? []}
                  signatories={signatoryBy.get(c.id) ?? []}
                  stateOptions={stateOptions}
                  activeCycleNames={activeCycleNamesBy.get(c.id) ?? []}
                  actions={actions}
                />
              ),
            }))}
          />
        )}
      </Card>
    </div>
  );
}
