import type {SQL} from 'drizzle-orm';
import type {SessionContext} from '@/db/client';
import {listCompanies, listDepartments, readPersonnelOverviewTx} from '@/core/read';
import {personnelPrivateCriteriaFrom, personnelPrivateCriteriaSql} from '@/core/personnel-private-search';
import {employeeListColumnsFrom, LIST_PREFERENCES_SQL} from '@/core/employee-list-prefs';
import {administratorPhotoRowsSql, employmentPhotoIdsTx} from '@/core/person-photo';
import {listConfigs} from '@/core/employee-id-config';
import type {WorkforcePageRead} from '@/lib/workforce-authz';
import {sql} from 'drizzle-orm';
import type {PageQuery} from '@/lib/pagination';
import {readPersonnelDraftList} from './draft-list-read';
import {draftListScope, headcountFilters, type PersonnelListQuery} from './list-query';

/** The reader's saved Personnel columns, selected in the gate's bounds statement (see below). */
export const personnelPageExtra = (session: SessionContext): SQL => session.userId ? LIST_PREFERENCES_SQL : sql`null::jsonb`;

/** Everything the Personnel screen reads, inside the ONE read-only snapshot its Workforce gate opens.
 *
 * It used to open nine or ten separate transactions per render (Workforce scope, maintenance scope, the
 * overview, companies, departments, drafts, saved columns, Employee ID rules and photos), each paying its
 * own BEGIN, session settings and COMMIT — about fifty statements and up to ten pooled connections for one
 * page. Every read below is the same owner it was; the access and preference values ride in the snapshot's
 * bounds statement, and the private-search criteria and administrator photos in the overview statement. */
export async function readPersonnelPageTx(access: WorkforcePageRead, p: {
  query: PersonnelListQuery; page: PageQuery; isAdmin: boolean;
  overviewInput: (scopeIds: string[]) => Parameters<typeof readPersonnelOverviewTx>[2];
}) {
  const {s: session, tx, snapshot, scopeIds} = access;
  const {query, page, isAdmin} = p;
  const maintainIds = new Set(access.maintainIds);
  const canCreate = isAdmin && maintainIds.size > 0;
  const criteria = query.filters.privateSearch ? personnelPrivateCriteriaSql(query.filters.privateSearch, scopeIds) : null;
  const overview = await readPersonnelOverviewTx(tx, session, p.overviewInput(scopeIds), headcountFilters(query), snapshot, {
    attach: criteria ? {criteria} : undefined,
    pagePhotos: ids => administratorPhotoRowsSql(session, ids),
  });
  const workforceIds = new Set(access.companyIds);
  const companies = (await listCompanies(session, {}, tx)).filter(row => workforceIds.has(row.id));
  const departments = scopeIds.length ? await listDepartments(session, {companyIds: scopeIds, usage: false}, tx) : [];
  // b1b1879d — drafts follow the TOP-BAR company scope exactly as the employees do.
  const drafts = isAdmin
    ? await readPersonnelDraftList(session, draftListScope(scopeIds, access.allowedCount), query, page.offset === 0, tx)
    : {rows: [], count: 0};
  const idConfigs = canCreate ? await listConfigs(session, scopeIds, tx) : [];
  const employees = query.draftOnly ? [] : overview.employees.rows;
  // 597c810a — photos for the page's own rows only, after the rows are known.
  const photoIds = overview.pagePhotos ?? await employmentPhotoIdsTx(tx, session, employees.map(e => e.employmentId));
  return {
    session, scopeIds, maintainIds, canCreate, overview,
    privateCriteria: criteria ? personnelPrivateCriteriaFrom(overview.attached.criteria) : null,
    companies, departments, drafts, savedColumns: employeeListColumnsFrom(access.extra), idConfigs, photoIds,
  };
}
