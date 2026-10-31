import Link from 'next/link';
import { personnelReferenceOptions } from '@/lib/personnel-template-reference';
import {personnelImportBrowserKey} from '@/lib/personnel-import-browser-key';
import { getPeopleGeneral } from '@/core/people-general';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies, listDepartments, listJobGrades } from '@/core/read';
import { listCostCenters, listPositions, listBusinessUnits } from '@/core/admin';
import { listAllProfileOptions } from '@/core/profile-options';
import { personnelCatalogReferenceValues } from '@/lib/personnel-import-catalog';
import { listEmployeeImportRuns } from '@/core/import';
import { PageHeader } from '@/components/ui';
import { ImportWorkbench } from './import-workbench';
import { ImportHistory } from './import-history';

export default async function ImportPage() {
  const t = await getTranslations('people.import');
  const s = await requireAdmin();
  // d8471481 — the Excel template's Reference sheet is generated from these LIVE catalogs, the same
  // ones core/import's analyze() validates a row against. Reading them here (rather than
  // hand-maintaining a second list) is what makes "the value in the template is a value the importer
  // accepts" true by construction. Unscoped on purpose: a file may now span several companies.
  const [
    companies,
    departments,
    positions,
    costCenters,
    // Item 2983802f — the catalog-governed vocabularies the new columns write into. Read here for the
    // same reason as the catalogs above: the Reference sheet must list the values `analyze()` accepts,
    // and the only way to guarantee that is to generate it from the list `analyze()` reads.
    allProfileOptions,
    importRuns,
    nricPolicy,
  ] = await Promise.all([
    listCompanies(s,{adminOnly:true}),
    listDepartments(s),
    listPositions(s),
    listCostCenters(s),
    listAllProfileOptions(s,{activeOnly:true}),
    // cf43c909 — past runs. Read here (not inside the client island) so the history is server-rendered and
    // RLS-scoped; `commitImportAction` revalidates this path, so a finished import appears without a reload.
    listEmployeeImportRuns(s),
    getPeopleGeneral(s),
  ]);
  // Company-specific guidance uses the same visibility owners as full-import validation.
  // The Company cell can override Target company; preview is authoritative in that case.
  const grades=await listJobGrades(s);
  const organisationOptionsByCompany=Object.fromEntries(await Promise.all(companies.map(async co=>{
    const [ds,ps,cs,bs]=await Promise.all([listDepartments(s,{companyIds:[co.id]}),listPositions(s,{companyIds:[co.id]}),listCostCenters(s,{companyIds:[co.id]}),listBusinessUnits(s,{companyIds:[co.id]})]);
    return [co.id,{
      department:personnelReferenceOptions(ds.map(d=>({value:d.code,label:d.label?.trim()||d.description||d.code}))),
      position:personnelReferenceOptions(ps.map(p=>({value:p.code,label:p.label?.trim()||p.description||p.code}))),
      cost_center:personnelReferenceOptions(cs.map(c=>({value:c.code,label:c.label?.trim()||c.name||c.code}))),
      business_unit:personnelReferenceOptions(bs.map(b=>({value:b.code,label:b.label?.trim()||b.name||b.code}))),
      job_grade:personnelReferenceOptions(grades.map(g=>({value:g.code,label:g.name}))),
    }] as const;
  })));
  const organisationByCompany=Object.fromEntries(Object.entries(organisationOptionsByCompany).map(([id,fields])=>[id,Object.fromEntries(Object.entries(fields).map(([column,options])=>[column,uniqSorted(options.map(option=>option.value))]))]));
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  // Default to the active scope if it's a single company; otherwise the company with the most
  // departments — i.e. the operating entity people are actually hired into, not a holding shell.
  const deptCount = new Map<string, number>();
  for (const d of departments) deptCount.set(d.companyId, (deptCount.get(d.companyId) ?? 0) + 1);
  const operating = [...companies].sort(
    (a, b) => (deptCount.get(b.id) ?? 0) - (deptCount.get(a.id) ?? 0),
  )[0];
  const defaultCompanyId =
    scopeIds.length === 1 ? scopeIds[0] : (operating?.id ?? companies[0]?.id ?? '');

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* 4ea70bb7 — this back link names the same destination as the wizard's and the profile's, and all
          three now say Personnel Management. people.import is admin-only (nothing outside
          app/(app)/admin/personnel/import reads the namespace), so backLabel could be renamed IN PLACE — no
          second key needed here, unlike people.detail.backToPeople which the employee-facing profile
          shares. */}
      <PageHeader
        back={{ href: '/admin/personnel', label: t('backLabel') }}
        title={t('title')}
        description={t('description')}
      />
      {companies.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noCompanies')}</p>
      ) : (
        <>
          {/* Item 2983802f — the FIRST step is now "what are you importing?". The workbench renders the
              full 49-column importer (unchanged, and the default) or one of the four narrow section
              importers; both read the same live catalogs below. */}
          <ImportWorkbench
            key={personnelImportBrowserKey(s,companies.map(company=>company.id))}
            companies={companies.map((c) => ({ id: c.id, name: c.name }))}
            defaultCompanyId={defaultCompanyId}
            reference={{
              organisationByCompany,
              organisationOptionsByCompany,
              catalogOptions:Object.fromEntries(Object.entries(allProfileOptions).map(([category,options])=>[category,personnelReferenceOptions(options)])),
              allowDuplicatedNric:nricPolicy.allowDuplicatedNric,
              // Sorted + de-duplicated: a shared label (62de487d) resolves for several companies and
              // would otherwise appear once per company in the reference list.
              departments: uniqSorted(departments.map((d) => d.name)),
              positions: uniqSorted(positions.map((p) => p.title)),
              costCenters: uniqSorted(costCenters.map((c) => c.code ?? c.name ?? '')),
              // Catalog order (sortOrder, then value) is kept rather than re-sorted: it is the order the
              // catalogues use. Workbook cells select saved codes; readable labels stay beside them on Reference.
              states: personnelCatalogReferenceValues(allProfileOptions.state),
              countries: personnelCatalogReferenceValues(allProfileOptions.country),
              nationalities: personnelCatalogReferenceValues(allProfileOptions.nationality),
              relationships: personnelCatalogReferenceValues(allProfileOptions.relationship),
              familyRelationships: personnelCatalogReferenceValues(allProfileOptions.dependentRelationship),
              salutations:personnelCatalogReferenceValues(allProfileOptions.salutation),
              religions:personnelCatalogReferenceValues(allProfileOptions.religion),
              races:personnelCatalogReferenceValues(allProfileOptions.race),
              catalogs:Object.fromEntries(Object.entries(allProfileOptions).map(([category,options])=>[category,personnelCatalogReferenceValues(options)])),
            }}
          />
          {/* cf43c909 — the record of what has been loaded. Always rendered, empty state included, so an
              admin who has never imported still learns that a history exists before they upload. */}
          <ImportHistory runs={importRuns} />
          {/* c4055300 / ADR-0155 — the shared Import History: original file, before/after and Revert. */}
          <p className="text-sm"><Link href="/admin/personnel/import/history" className="text-primary underline">{t('importHistoryLink')}</Link></p>
        </>
      )}
    </div>
  );
}

function uniqSorted(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v && v.trim() !== ''))].sort((a, b) =>
    a.localeCompare(b),
  );
}
