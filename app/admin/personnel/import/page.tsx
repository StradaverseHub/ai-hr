import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies, listDepartments } from '@/core/read';
import { listCostCenters, listPositions } from '@/core/admin';
import { listProfileOptions } from '@/core/profile-options';
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
    states,
    countries,
    // The passport's Issuing Country is fed from the NATIONALITY catalog, not `country` — the Personnel
    // Passport card's picker reads that list, so the value the product stores there is a demonym
    // ("Malaysian", not "Malaysia"). Read here so the Reference sheet lists what `analyze()` accepts.
    nationalities,
    relationships,
    familyRelationships,
    importRuns,
  ] = await Promise.all([
    listCompanies(s),
    listDepartments(s),
    listPositions(s),
    listCostCenters(s),
    listProfileOptions(s, 'state', { activeOnly: true }),
    listProfileOptions(s, 'country', { activeOnly: true }),
    listProfileOptions(s, 'nationality', { activeOnly: true }),
    listProfileOptions(s, 'relationship', { activeOnly: true }),
    listProfileOptions(s, 'dependentRelationship', { activeOnly: true }),
    // cf43c909 — past runs. Read here (not inside the client island) so the history is server-rendered and
    // RLS-scoped; `commitImportAction` revalidates this path, so a finished import appears without a reload.
    listEmployeeImportRuns(s),
  ]);
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
          app/admin/personnel/import reads the namespace), so backLabel could be renamed IN PLACE — no
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
            companies={companies.map((c) => ({ id: c.id, name: c.name }))}
            defaultCompanyId={defaultCompanyId}
            reference={{
              // Sorted + de-duplicated: a shared label (62de487d) resolves for several companies and
              // would otherwise appear once per company in the reference list.
              departments: uniqSorted(departments.map((d) => d.name)),
              positions: uniqSorted(positions.map((p) => p.title)),
              costCenters: uniqSorted(costCenters.map((c) => c.code ?? c.name ?? '')),
              // Catalog order (sortOrder, then value) is kept rather than re-sorted: it is the order the
              // dropdowns on the Personnel screens show, and the sheet is a copy of those dropdowns.
              states: states.map((o) => o.value),
              countries: countries.map((o) => o.value),
              nationalities: nationalities.map((o) => o.value),
              relationships: relationships.map((o) => o.value),
              familyRelationships: familyRelationships.map((o) => o.value),
            }}
          />
          {/* cf43c909 — the record of what has been loaded. Always rendered, empty state included, so an
              admin who has never imported still learns that a history exists before they upload. */}
          <ImportHistory runs={importRuns} />
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
