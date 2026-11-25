/** Personnel import page catalogs (app/admin/personnel/import/page.tsx), read once per request.
 *
 * ADR 0181 / docs/SCALE-AND-RELEASE-RULES.md rule 2 (no per-company loops in a request): the page used to run four
 * System Label reads PER VISIBLE COMPANY to build its company-specific guidance (about 320 transactions per load on
 * a group of 300+ companies). Every catalog is now read once, in one read-only snapshot transaction, by the same
 * owners as before; the company-specific lists are partitioned in memory by the System Labels Criteria twin.
 *
 * Authorization and tenant isolation are unchanged: the same owner readers run under the same session identity and
 * row security, and the company list is still `listCompanies(..., {adminOnly:true})`. Nothing here widens a read. */
import { withTenant, type SessionContext } from '../db/client';
import { labelsInCompanyScope, type CompanyScopedLabel } from '../lib/system-label-scope';
import { listCompanies, listDepartments, listJobGrades } from './read';
import { listBusinessUnits, listCostCenters, listPositions } from './admin';
import { listAllProfileOptions } from './profile-options';
import { readPeopleGeneralTx } from './people-general';

export function readPersonnelImportCatalogs(ctx: SessionContext) {
  return withTenant(ctx, async tx => {
    // One transaction runs its statements in turn; awaiting each keeps the statement order fixed.
    const companies = await listCompanies(ctx, { adminOnly: true }, tx);
    // `usage: false`: this page never shows whether a department is in use, and the flag is a scan per department.
    const departments = await listDepartments(ctx, { usage: false }, tx);
    const positions = await listPositions(ctx, {}, tx);
    const costCenters = await listCostCenters(ctx, {}, tx);
    const businessUnits = await listBusinessUnits(ctx, {}, tx);
    const grades = await listJobGrades(ctx, {}, tx);
    const allProfileOptions = await listAllProfileOptions(ctx, { activeOnly: true }, tx);
    const nricPolicy = await readPeopleGeneralTx(tx);
    return { companies, departments, positions, costCenters, businessUnits, grades, allProfileOptions, nricPolicy };
  }, { readOnlySnapshot: true });
}
export type PersonnelImportCatalogs = Awaited<ReturnType<typeof readPersonnelImportCatalogs>>;

/** One company's share of each unfiltered System Label list, in the list's own SQL order.
 *
 * A label is available to company C exactly when it is Global or its saved Criteria name C: the SQL predicate
 * `visibleLabelIdsCondition` (core/system-labels.ts) that `listDepartments(ctx, {companyIds:[C]})` and its siblings
 * apply, and `labelsInCompanyScope` (lib/system-label-scope.ts) is its in-memory twin. The unfiltered rows carry
 * `isGlobal` and `assignedCompanyIds` (read by the same row security), and C is a company the same session can see,
 * so this equals the former per-company reads row for row (test/personnel-import-read-budget.test.ts). */
export function organisationLabelsForCompany<
  D extends CompanyScopedLabel, P extends CompanyScopedLabel, C extends CompanyScopedLabel, B extends CompanyScopedLabel,
>(catalogs: { departments: readonly D[]; positions: readonly P[]; costCenters: readonly C[]; businessUnits: readonly B[] }, companyId: string) {
  const only = new Set([companyId]);
  return {
    departments: labelsInCompanyScope(catalogs.departments, only),
    positions: labelsInCompanyScope(catalogs.positions, only),
    costCenters: labelsInCompanyScope(catalogs.costCenters, only),
    businessUnits: labelsInCompanyScope(catalogs.businessUnits, only),
  };
}
