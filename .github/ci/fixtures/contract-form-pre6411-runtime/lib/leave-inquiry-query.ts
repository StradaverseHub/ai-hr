import { parsePageQuery } from './pagination';
import { todayInKualaLumpur } from './hr-date';

export type InquiryParams = Record<string, string | string[] | undefined>;
export class InquiryQueryError extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function inquiryDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
/** Both screens and downloads parse the same contract. Malformed filters refuse, never broaden. */
export function parseInquiryQuery(sp: InquiryParams, kind: 'balances' | 'records') {
  const one = (key: string) => {
    const value = sp[key];
    if (Array.isArray(value)) throw new InquiryQueryError(`Repeated ${key}`);
    return value?.trim() || undefined;
  };
  const ids = (key: string) => {
    const raw = sp[key];
    const values = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    if (values.length > 100 || values.some(v => !uuid.test(v))) throw new InquiryQueryError(`Invalid ${key}`);
    return [...new Set(values)];
  };
  const emp = one('emp');
  if (emp && !uuid.test(emp)) throw new InquiryQueryError('Invalid employee');
  const typeIds = ids('type');
  const departmentIds = ids('department');
  const rawStatus = sp.status;
  const statuses = rawStatus == null ? [] : Array.isArray(rawStatus) ? rawStatus : [rawStatus];
  if (statuses.some(s => !['pending', 'approved', 'rejected', 'cancelled'].includes(s))) throw new InquiryQueryError('Invalid status');
  const asOf = one('asOf') ?? todayInKualaLumpur();
  const from = one('from'), to = one('to');
  if (![asOf, from, to].every(v => !v || inquiryDate(v)) || (from && to && from > to)) throw new InquiryQueryError('Invalid date range');
  const dateMode = one('dateMode') ?? 'leave';
  if (!['leave', 'applied'].includes(dateMode)) throw new InquiryQueryError('Invalid date mode');
  const sort = one('sort') ?? (kind === 'records' ? 'applied' : 'employeeCode');
  if (!(kind === 'records' ? ['employeeCode', 'name', 'applied', 'start', 'end', 'status'] : ['employeeCode', 'name', 'type']).includes(sort)) throw new InquiryQueryError('Invalid sort');
  const dir = one('dir') ?? (kind === 'records' ? 'desc' : 'asc');
  if (dir !== 'asc' && dir !== 'desc') throw new InquiryQueryError('Invalid direction');
  const size = one('size') ?? '50', page = one('page') ?? '0';
  if (!['25', '50', '100', '200', 'all'].includes(size) || !/^\d+$/.test(page)) throw new InquiryQueryError('Invalid page');
  const pq = parsePageQuery({ size, page });
  if (!Number.isSafeInteger(pq.offset)) throw new InquiryQueryError('Invalid page');
  const q = one('q');
  if (q && q.length > 200) throw new InquiryQueryError('Search is too long');
  const format = one('format') ?? 'csv';
  if (!['csv', 'xlsx'].includes(format)) throw new InquiryQueryError('Invalid format');
  return { emp, typeIds, departmentIds, statuses, asOf, from, to, dateMode, sort, dir, q, pq, format } as const;
}
export type InquiryQuery = ReturnType<typeof parseInquiryQuery>;
export function inquirySearchParams(sp: URLSearchParams): InquiryParams {
  return Object.fromEntries([...new Set(sp.keys())].map(key => [key, sp.getAll(key).length > 1 ? sp.getAll(key) : sp.get(key) ?? undefined]));
}

/** Exact paths only: scope forms cannot become an open redirect. */
export function inquiryScopeReturnPath(value: unknown): '/leave/employee-balances' | '/leave/employee-records' | undefined {
  return value === '/leave/employee-balances' || value === '/leave/employee-records' ? value : undefined;
}
