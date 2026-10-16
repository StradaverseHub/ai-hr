/** Authorized inquiry selection/count/page contract. Leave calculations remain in the Leave owner. */
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { isAdmin } from '../lib/authz-model';
import { InquiryQueryError, type InquiryQuery } from '../lib/leave-inquiry-query';
import { adminCompanies, listEmployees, adminCompaniesTx, listEmployeesTx, leaveBalanceInquiryMembershipTx, listLeaveRequestsPageTx } from './read';

const authorizedContexts = new WeakMap<object, { actor: SessionContext; snapshot: LeaveInquiryContext }>();
export type LeaveInquiryContext = { companies: Awaited<ReturnType<typeof adminCompanies>>; companyIds: string[]; employees: Awaited<ReturnType<typeof listEmployees>>; selected: Awaited<ReturnType<typeof listEmployees>>[number] | undefined };
export function leaveInquiryContext(ctx: SessionContext, selectedCompanyIds: string[], query: InquiryQuery): Promise<LeaveInquiryContext> {
  return withTenant(ctx, tx => leaveInquiryContextTx(tx, ctx, selectedCompanyIds, query));
}
async function leaveInquiryContextTx(tx: Tx, ctx: SessionContext, selectedCompanyIds: string[], query: InquiryQuery): Promise<LeaveInquiryContext> {
  if (!isAdmin(ctx)) throw new InquiryQueryError('Forbidden');
  const companies = (await adminCompaniesTx(tx)).filter(c => selectedCompanyIds.includes(c.id));
  const companyIds = companies.map(c => c.id);
  // Empty company fences must never reach legacy optional-scope reads, where [] means no restriction.
  const employees = companyIds.length ? await listEmployeesTx(tx, companyIds) : [];
  const selected = query.emp ? employees.find(e => e.employmentId === query.emp) : undefined;
  if (query.emp && !selected) throw new InquiryQueryError('Employee is unavailable in the selected companies');
  const result = { companies, companyIds, employees, selected };
  authorizedContexts.set(result, { actor: ctx, snapshot: structuredClone(result) });
  return result;
}
function authorizedScope(ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery): LeaveInquiryContext {
  const verified = authorizedContexts.get(scope);
  if (!verified || verified.actor !== ctx || !isAdmin(ctx) || verified.snapshot.selected?.employmentId !== query.emp) throw new InquiryQueryError('Forbidden');
  return verified.snapshot;
}
/** One explicit snapshot owns authorization, membership and every canonical hydration read in a file. */
export function leaveInquirySnapshot<T>(ctx: SessionContext, companyIds: string[], query: InquiryQuery, read: (tx: Tx, scope: LeaveInquiryContext) => Promise<T>): Promise<T> {
  return withTenant(ctx, async tx => read(tx, await leaveInquiryContextTx(tx, ctx, companyIds, query)), { readOnlySnapshot: true });
}
export function leaveInquiryRecordsPage(ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery, window: { limit: number; offset: number } = query.pq) {
  return withTenant(ctx, tx => leaveInquiryRecordsPageTx(tx, ctx, scope, query, window));
}
export async function leaveInquiryRecordsPageTx(tx: Tx, ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery, window: { limit: number; offset: number } = query.pq) {
  scope = authorizedScope(ctx, scope, query);
  checkWindow(window);
  if (!scope.companyIds.length) return { rows: [], total: 0 };
  return listLeaveRequestsPageTx(tx, ctx, {
    companyIds: scope.companyIds, employmentIds: scope.selected ? [scope.selected.employmentId] : undefined,
    leaveTypeIds: query.typeIds, statuses: query.statuses, q: query.q, departmentIds: query.departmentIds,
    ...(query.dateMode === 'applied' ? { appliedFrom: query.from, appliedTo: query.to, appliedTimezone: 'Asia/Kuala_Lumpur' as const } : { from: query.from, to: query.to }),
    sort: query.sort, dir: query.dir, limit: window.limit, offset: window.offset,
  });
}
function checkWindow(window: { limit: number; offset: number }) {
  if (!Number.isSafeInteger(window.limit) || window.limit < 1 || window.limit > 2000 || !Number.isSafeInteger(window.offset) || window.offset < 0 || !Number.isSafeInteger(window.offset + window.limit)) throw new InquiryQueryError('Invalid page');
}
export function leaveInquiryBalancePairs(ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery, locale: string, window: { limit: number; offset: number } = query.pq) {
  return withTenant(ctx, tx => leaveInquiryBalancePairsTx(tx, ctx, scope, query, locale, window));
}
/** Globally order lightweight pairs before slicing, retaining only the requested ordered prefix. */
export async function leaveInquiryBalancePairsTx(tx: Tx, ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery, locale: string, window: { limit: number; offset: number } = query.pq) {
  scope = authorizedScope(ctx, scope, query);
  checkWindow(window);
  const cmp = (a: string, b: string) => a.localeCompare(b, locale, { sensitivity: 'base' });
  const direction = query.dir === 'desc' ? -1 : 1;
  const employees = (scope.selected ? [scope.selected] : scope.employees).filter(e => !query.departmentIds.length || (e.departmentId != null && query.departmentIds.includes(e.departmentId)));
  type Pair = { employee: typeof employees[number]; leaveTypeId: string; code: string; leaveType: string };
  const rank = (a: Pair, b: Pair) => {
    const primary = query.sort === 'type' ? cmp(a.code || a.leaveType, b.code || b.leaveType) : query.sort === 'name' ? cmp(a.employee.name, b.employee.name) : cmp(a.employee.employeeCode ?? '', b.employee.employeeCode ?? '');
    return direction * primary || cmp(a.employee.employeeCode ?? '', b.employee.employeeCode ?? '') || cmp(a.employee.name, b.employee.name) || a.employee.employmentId.localeCompare(b.employee.employmentId) || cmp(a.code || a.leaveType, b.code || b.leaveType) || a.leaveTypeId.localeCompare(b.leaveTypeId);
  };
  // Max heap: the least useful retained pair is at the root. No balances are hydrated here.
  const prefix: Pair[] = [], keep = window.offset + window.limit;
  const retain = (pair: Pair) => {
    if (prefix.length < keep) {
      prefix.push(pair); let i = prefix.length - 1;
      while (i > 0) { const parent = Math.floor((i - 1) / 2); if (rank(prefix[i], prefix[parent]) <= 0) break; [prefix[i], prefix[parent]] = [prefix[parent], prefix[i]]; i = parent; }
    } else if (rank(pair, prefix[0]) < 0) {
      prefix[0] = pair; let i = 0;
      for (;;) { const left = 2 * i + 1, right = left + 1; if (left >= prefix.length) break; const child = right < prefix.length && rank(prefix[right], prefix[left]) > 0 ? right : left; if (rank(prefix[child], prefix[i]) <= 0) break; [prefix[i], prefix[child]] = [prefix[child], prefix[i]]; i = child; }
    }
  };
  let total = 0;
  const needle = query.q?.toLocaleLowerCase(locale);
  for (let start = 0; start < employees.length; start += 100) {
    const chunk = employees.slice(start, start + 100);
    const membership = await leaveBalanceInquiryMembershipTx(tx, ctx, chunk.map(e => e.employmentId), query.asOf, locale);
    const byId = new Map(chunk.map(e => [e.employmentId, e]));
    for (const pair of membership) {
      const employee = byId.get(pair.employmentId);
      if (!employee || query.typeIds.length && !query.typeIds.includes(pair.leaveTypeId) || needle && ![employee.name, employee.employeeCode ?? '', pair.code, pair.leaveType].some(v => v.toLocaleLowerCase(locale).includes(needle))) continue;
      total++; retain({ employee, ...pair });
    }
  }
  return { rows: prefix.sort(rank).slice(window.offset), total };
}
/** Collect a complete filtered file inside the caller's explicit read-only snapshot. */
export const LEAVE_INQUIRY_EXPORT_LIMIT = 10_000;
export async function collectInquiryExport<T>(read: (window: { limit: number; offset: number }) => Promise<{ rows: T[]; total: number }>): Promise<T[]> {
  const first = await read({ limit: 200, offset: 0 });
  if (first.total > LEAVE_INQUIRY_EXPORT_LIMIT) throw new InquiryQueryError('Export exceeds 10,000 rows. Narrow the filters and try again.');
  const rows = [...first.rows];
  for (let offset = first.rows.length; offset < first.total; offset += 200) {
    const next = await read({ limit: 200, offset });
    if (next.total !== first.total || !next.rows.length) throw new InquiryQueryError('Results changed during export. Try again.');
    rows.push(...next.rows);
  }
  if (rows.length !== first.total) throw new InquiryQueryError('Results changed during export. Try again.');
  return rows;
}
