import type {SessionContext} from '@/db/client';
import {listCompanies, listDepartments, readPersonnelOverviewTx} from '@/core/read';
import {withPersonnelOverviewRead} from '@/core/personnel-read-bounds';
import {personnelPageAccessFrom, personnelPageAccessSql} from '@/core/workforce-access';
import {personnelPrivateCriteriaFrom, personnelPrivateCriteriaSql} from '@/core/personnel-private-search';
import {employeeListColumnsFrom, LIST_PREFERENCES_SQL} from '@/core/employee-list-prefs';
import {administratorPhotoRowsSql, employmentPhotoIdsTx} from '@/core/person-photo';
import {listConfigs} from '@/core/employee-id-config';
import {getScopeIds} from '@/lib/scope';
import {sql} from 'drizzle-orm';
import type {PageQuery} from '@/lib/pagination';
import {readPersonnelDraftList} from './draft-list-read';
import {draftListScope, headcountFilters, type PersonnelListQuery} from './list-query';

/** Everything the Personnel screen reads, in ONE read-only snapshot on one connection.
 *
 * It used to open nine or ten separate transactions per render (Workforce scope, maintenance scope, the
 * overview, companies, departments, drafts, saved columns, Employee ID rules and photos), each paying its
 * own BEGIN, session settings and COMMIT — about fifty statements and up to ten pooled connections for one
 * page. Every read below is the same owner it was; the access and preference values ride in the snapshot's
 * bounds statement, and the private-search criteria and administrator photos in the overview statement.
 * Returns null when the reader may not open Personnel (the caller redirects). */
export function readPersonnelPage(session: SessionContext, p: {
  query: PersonnelListQuery; page: PageQuery; isAdmin: boolean;
  overviewInput: (scopeIds: string[]) => Parameters<typeof readPersonnelOverviewTx>[2];
}) {
  const {query, page, isAdmin} = p;
  const extra = sql`jsonb_build_object('access', ${personnelPageAccessSql}, 'columns', ${session.userId ? LIST_PREFERENCES_SQL : sql`null::jsonb`})`;
  return withPersonnelOverviewRead(session, async (tx, snapshot) => {
    const {access: rawAccess, columns} = snapshot.extra as {access: unknown; columns: unknown};
    const access = personnelPageAccessFrom(rawAccess);
    if (!access.canOpen) return null;
    const scopeIds = await getScopeIds(access.companyIds);
    const maintainIds = new Set(access.maintainIds);
    const canCreate = isAdmin && maintainIds.size > 0;
    const criteria = query.filters.privateSearch ? personnelPrivateCriteriaSql(query.filters.privateSearch, scopeIds) : null;
    const overview = await readPersonnelOverviewTx(tx, session, p.overviewInput(scopeIds), headcountFilters(query), snapshot, {
      attach: criteria ? {criteria} : undefined,
      pagePhotos: ids => administratorPhotoRowsSql(session, ids),
    });
    const workforceIds = new Set(access.companyIds);
    const companies = (await listCompanies(session, {}, tx)).filter(row => workforceIds.has(row.id));
    const departments = scopeIds.length ? await listDepartments(session, {companyIds: scopeIds}, tx) : [];
    // b1b1879d — drafts follow the TOP-BAR company scope exactly as the employees do.
    const drafts = isAdmin
      ? await readPersonnelDraftList(session, draftListScope(scopeIds, access.companyIds.length), query, page.offset === 0, tx)
      : {rows: [], count: 0};
    const idConfigs = canCreate ? await listConfigs(session, scopeIds, tx) : [];
    const employees = query.draftOnly ? [] : overview.employees.rows;
    // 597c810a — photos for the page's own rows only, after the rows are known.
    const photoIds = overview.pagePhotos ?? await employmentPhotoIdsTx(tx, session, employees.map(e => e.employmentId));
    return {
      scopeIds, allowedCount: access.companyIds.length, companyIds: access.companyIds, maintainIds, canCreate,
      overview, privateCriteria: criteria ? personnelPrivateCriteriaFrom(overview.attached.criteria) : null,
      companies, departments, drafts, savedColumns: employeeListColumnsFrom(columns), idConfigs, photoIds,
    };
  }, {extra});
}
