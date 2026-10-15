/** Authorized inquiry selection/count/page contract. Leave calculations remain in the Leave owner. */
import type { SessionContext } from '../db/client';
import { isAdmin } from '../lib/authz';
import { InquiryQueryError, type InquiryQuery } from '../lib/leave-inquiry-query';
import { adminCompanies, listEmployees, leaveBalanceInquiryMembership, listLeaveRequestsPage } from './read';

const authorizedContexts = new WeakMap<object, { actor: SessionContext; snapshot: LeaveInquiryContext }>();

export type LeaveInquiryContext = { companies: Awaited<ReturnType<typeof adminCompanies>>; companyIds: string[]; employees: Awaited<ReturnType<typeof listEmployees>>; selected: Awaited<ReturnType<typeof listEmployees>>[number] | undefined };
export async function leaveInquiryContext(ctx: SessionContext, selectedCompanyIds: string[], query: InquiryQuery): Promise<LeaveInquiryContext> {
  if (!isAdmin(ctx)) throw new InquiryQueryError('Forbidden');
  const companies = (await adminCompanies(ctx)).filter(c => selectedCompanyIds.includes(c.id));
  const companyIds = companies.map(c => c.id);
  // Empty company fences must never reach legacy optional-scope reads, where [] means no restriction.
  const employees = companyIds.length ? await listEmployees(ctx, companyIds) : [];
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
export async function leaveInquiryRecordsPage(ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery, window: { limit: number; offset: number } = query.pq) {
  scope = authorizedScope(ctx, scope, query);
  if (!Number.isSafeInteger(window.limit) || window.limit < 1 || window.limit > 2000 || !Number.isSafeInteger(window.offset) || window.offset < 0) throw new InquiryQueryError('Invalid page');
  if (!scope.companyIds.length) return { rows: [], total: 0 };
  return listLeaveRequestsPage(ctx, {
    companyIds: scope.companyIds, employmentIds: scope.selected ? [scope.selected.employmentId] : undefined,
    leaveTypeIds: query.typeIds, statuses: query.statuses, q: query.q,
    ...(query.dateMode === 'applied' ? { appliedFrom: query.from, appliedTo: query.to, appliedTimezone: 'Asia/Kuala_Lumpur' as const } : { from: query.from, to: query.to }),
    sort: query.sort, dir: query.dir, limit: window.limit, offset: window.offset,
  });
}
/** Select lightweight membership, retain only the requested page. No workforce balance materialization. */
export async function leaveInquiryBalancePairs(ctx: SessionContext, scope: LeaveInquiryContext, query: InquiryQuery, locale: string, window: { limit: number; offset: number } = query.pq) {
  scope = authorizedScope(ctx, scope, query);
  if (!Number.isSafeInteger(window.limit) || window.limit < 1 || window.limit > 2000 || !Number.isSafeInteger(window.offset) || window.offset < 0) throw new InquiryQueryError('Invalid page');
  const cmp = (a: string, b: string) => a.localeCompare(b, locale, { sensitivity: 'base' });
  const direction = query.dir === 'desc' ? -1 : 1;
  const employees = (scope.selected ? [scope.selected] : scope.employees).filter(e => !query.departmentIds.length || (e.departmentId != null && query.departmentIds.includes(e.departmentId)));
  employees.sort((a, b) => direction * (query.sort === 'name' ? cmp(a.name, b.name) : cmp(a.employeeCode ?? '', b.employeeCode ?? '')) || cmp(a.name, b.name) || a.employmentId.localeCompare(b.employmentId));
  type Pair = { employee: typeof employees[number]; leaveTypeId: string; code: string; leaveType: string };
  const rows: Pair[] = [];
  let total = 0;
  const needle = query.q?.toLocaleLowerCase(locale);
  // Type ordering is within employee, so employee/type pages are deterministic with immutable ties.
  for (let start = 0; start < employees.length; start += 100) {
    const chunk = employees.slice(start, start + 100);
    const membership = await leaveBalanceInquiryMembership(ctx, chunk.map(e => e.employmentId), query.asOf, locale);
    const byEmployee = new Map<string, typeof membership>();
    for (const pair of membership) {
      const group = byEmployee.get(pair.employmentId) ?? [];
      group.push(pair); byEmployee.set(pair.employmentId, group);
    }
    for (const employee of chunk) {
      const pairs = (byEmployee.get(employee.employmentId) ?? []).filter(p => (!query.typeIds.length || query.typeIds.includes(p.leaveTypeId)) && (!needle || [employee.name, employee.employeeCode ?? '', p.code, p.leaveType].some(v => v.toLocaleLowerCase(locale).includes(needle))));
      pairs.sort((a, b) => (query.sort === 'type' ? direction : 1) * cmp(a.code || a.leaveType, b.code || b.leaveType) || a.leaveTypeId.localeCompare(b.leaveTypeId));
      for (const pair of pairs) {
        if (total >= window.offset && rows.length < window.limit) rows.push({ employee, ...pair });
        total++;
      }
    }
  }
  return { rows, total };
}
/** Export complete filtered results in bounded reads; refuse a partial file. */
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
