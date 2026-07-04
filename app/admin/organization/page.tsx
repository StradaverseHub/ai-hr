import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { companyTree, listCompanies } from '@/core/read';
import { listCompanyStatutoryMY } from '@/localization/my/company-statutory';
import { listAllCompanyBankProfiles } from '@/core/bank-profile';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { CompanyPanel, type PanelBankProfile } from '@/components/company-panel';
import {
  archiveCompanyAction,
  createCompanyAction,
  deleteCompanyAction,
  removeCompanyBankProfileAction,
  setCompanyBankProfileAction,
  setCompanyParentAction,
  setCompanyStatutoryAction,
  updateCompanyAction,
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
  const { s, scopeIds } = await scopedAdmin();
  const { error } = await searchParams;
  const t = await getTranslations('admin.organization');
  // The tree stays unscoped (it needs every node to draw the group); the company panels follow
  // the active company context. Org catalogs (departments/positions/cost-centers/business-units) moved to
  // Settings → System Labels, so this page no longer fetches them.
  const [companies, tree, statutory, bankProfiles] = await Promise.all([
    listCompanies(s, { includeArchived: true }),
    companyTree(s),
    listCompanyStatutoryMY(s),
    listAllCompanyBankProfiles(s),
  ]);
  const statBy = new Map(statutory.map((r) => [r.companyId, r]));
  const bankBy = new Map<string, PanelBankProfile[]>();
  for (const bp of bankProfiles) {
    const list = bankBy.get(bp.companyId) ?? [];
    list.push({ id: bp.id, bank: bp.bank, corporateId: bp.corporateId, debitAccountNo: bp.debitAccountNo, orgName: bp.orgName, txnType: bp.txnType });
    bankBy.set(bp.companyId, list);
  }
  const parentBy = new Map(tree.map((n) => [n.id, n.parentId]));
  const scoped = scopeIds.length ? companies.filter((c) => scopeIds.includes(c.id)) : companies;

  const actions = {
    updateCompany: updateCompanyAction,
    archiveCompany: archiveCompanyAction,
    deleteCompany: deleteCompanyAction,
    setParent: setCompanyParentAction,
    setStatutory: setCompanyStatutoryAction,
    setBankProfile: setCompanyBankProfileAction,
    removeBankProfile: removeCompanyBankProfileAction,
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
      />
      <ErrorBanner message={error} />

      <Card data-tour="people-org-tree">
        <SectionHeader title={t('groupStructure')} count={companies.length} />
        <div className="px-4 py-3">
          {tree.length > 0 ? (
            <CompanyTree nodes={tree} />
          ) : (
            <p className="text-sm text-muted-foreground">{t('noCompaniesYet')}</p>
          )}
        </div>
      </Card>

      <Card data-tour="people-org-companies">
        <SectionHeader title={t('companies')} count={scoped.length} />
        <ul className="divide-y divide-border">
          {scoped.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noCompaniesInScope')}</li>
          )}
          {scoped.map((c) => (
            <CompanyPanel
              key={c.id}
              company={{
                id: c.id,
                name: c.name,
                country: c.country,
                currency: c.currency,
                registrationNo: c.registrationNo,
                archivedAt: c.archivedAt,
                inUse: c.inUse,
                parentId: parentBy.get(c.id) ?? null,
              }}
              companies={companies}
              statutory={statBy.get(c.id) ?? null}
              bankProfiles={bankBy.get(c.id) ?? []}
              actions={actions}
            />
          ))}
        </ul>
        <form
          action={createCompanyAction}
          data-tour="people-org-add"
          className="grid grid-cols-1 gap-3 border-t border-border p-4 sm:grid-cols-4"
        >
          <input name="legalName" required placeholder={t('legalName')} className={`${inputCls} sm:col-span-2`} />
          <input name="country" defaultValue="MY" placeholder={t('country')} pattern="[A-Za-z]{2}" maxLength={2} title={t('countryHint')} className={`${inputCls} uppercase`} />
          <input name="currency" defaultValue="MYR" placeholder={t('currency')} pattern="[A-Za-z]{3}" maxLength={3} title={t('currencyHint')} className={`${inputCls} uppercase`} />
          <div className="sm:col-span-4">
            <button className={btnPrimary}>{t('addCompany')}</button>
          </div>
        </form>
      </Card>
    </div>
  );
}
