import 'server-only';
import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { listEmployeesDirectoryPage } from '@/core/read';
import { deriveEmploymentStatus } from '@/core/employment-status';
import { employmentPhotoIds } from '@/core/person-photo';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  ALL_ROW_CEILING,
  PAGE_SIZE_OPTIONS,
  keysetPageState,
  keysetPagerHrefs,
  pageHref,
  parseKeysetPageQuery,
  type KeysetHrefOver,
} from '@/lib/pagination';
import { DIRECTORY_FILTERS, type DirectoryParams } from './directory-params';
export { DIRECTORY_PARAMS, directoryParams, type DirectoryParams } from './directory-params';

/**
 * The People directory's list, as one renderable view (ADR 0181 Phase 4, list-only filters).
 *
 * The page renders it on first load and `POST /personnel/list` returns the same view for a filter, chip, page-size
 * or pager step, so a change refreshes only the list: no page or frame render and none of the page's other reads
 * (companies, departments). Every string is resolved here, on the server, with the request's own translations.
 * The view never carries more than the page already shows: the employee's name, work e-mail, code, department,
 * company, derived status, hire date and photo reference, for the rows the viewer's row security returns.
 */
const DIRECTORY_PATH = '/personnel';

export type DirectoryRowView = {
  employmentId: string;
  name: string;
  email: string;
  employeeCode: string | null;
  department: string | null;
  company: string;
  status: string;
  statusLabel: string;
  hiredOn: string;
  photoUrl: string | null;
};
export type DirectoryLinkView = { label: string; href: string | null };
export type DirectoryView = {
  /** The address this view answers, so the island can write it with history.pushState. */
  href: string;
  filters: Partial<Record<(typeof DIRECTORY_FILTERS)[number], string>>;
  headerCount: string;
  rows: DirectoryRowView[];
  emptyText: string | null;
  pager: {
    rangeText: string;
    /** The Atelier compact pager's counter, e.g. "26–50 / 1000+" (components/pager.tsx). */
    compactRange: string;
    previousPage: string;
    nextPage: string;
    rowsPerPage: string;
    size: string;
    sizeOptions: { value: string; label: string; href: string }[];
    first: DirectoryLinkView;
    prev: DirectoryLinkView;
    next: DirectoryLinkView;
    last: DirectoryLinkView;
    countExactly: DirectoryLinkView | null;
    truncatedText: string | null;
  };
};

export async function directoryView(session: SessionContext, scopeIds: string[], sp: DirectoryParams): Promise<DirectoryView> {
  const [t, tStatus, tPager] = await Promise.all([
    getTranslations('people.list'),
    getTranslations('people.employeeStatus'),
    getTranslations('pagination'),
  ]);
  const today = todayInKualaLumpur();
  const { q, company, dept, status, type } = sp;
  const pq = parseKeysetPageQuery(sp);
  const statusFilter = status === 'active' || status === 'terminated' ? status : undefined;
  const hasFilters = !!(q || company || dept || status || type);
  const { rows: employees, ...read } = await listEmployeesDirectoryPage(session, {
    companyIds: scopeIds,
    q,
    companyId: company || undefined,
    departmentId: dept || undefined,
    status: statusFilter,
    employmentType: type || undefined,
    limit: pq.limit,
    size: pq.size,
    after: pq.after,
    before: pq.before,
    last: pq.last,
    exactCount: pq.exactCount,
  });
  // One bulk row-secured existence read for the shown rows' photos (597c810a), never one request per row.
  const photoIds = await employmentPhotoIds(session, employees.map((e) => e.employmentId));
  const state = keysetPageState(pq, read, employees.map((e) => e.employmentId));
  const filters = { q, company, dept, status, type };
  const href = (over: KeysetHrefOver) =>
    pageHref(DIRECTORY_PATH, filters, {
      page: over.page || undefined,
      size: over.size ?? state.size,
      after: over.after,
      before: over.before,
      last: over.last ? 1 : undefined,
      count: over.count ?? (state.exactCount ? 'exact' : undefined),
    });
  const steps = keysetPagerHrefs(state, href);
  const total = state.total;
  const current = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, page: sp.page, size: sp.size, after: sp.after, before: sp.before, last: sp.last, count: sp.count }))
    if (value) current.set(key, value);
  return {
    href: current.toString() ? `${DIRECTORY_PATH}?${current}` : DIRECTORY_PATH,
    filters,
    headerCount: state.capped ? t('employeeCountCapped', { count: total }) : t('employeeCount', { count: total }),
    rows: employees.map((e) => {
      const st = deriveEmploymentStatus(e, today);
      const photo = photoIds.get(e.employmentId);
      return {
        employmentId: e.employmentId,
        name: e.name,
        email: e.email,
        employeeCode: e.employeeCode,
        department: e.department,
        company: e.company,
        status: st,
        statusLabel: tStatus(st),
        hiredOn: e.hiredOn,
        photoUrl: photo ? `/personnel/photo/${photo}` : null,
      };
    }),
    emptyText: employees.length ? null : q ? t('emptySearch', { q }) : hasFilters ? t('emptyFiltered') : t('emptyNoEmployees'),
    pager: {
      rangeText: state.from > 0
        ? state.capped
          ? tPager('rangeCapped', { from: state.from, to: state.to, total })
          : tPager('range', { from: state.from, to: state.to, total })
        : tPager('rangeEmpty', { total }),
      compactRange: state.from > 0 ? `${state.from}–${state.to} / ${total}${state.capped ? '+' : ''}` : tPager('rangeEmpty', { total }),
      previousPage: tPager('previousPage'),
      nextPage: tPager('nextPage'),
      rowsPerPage: tPager('rowsPerPage'),
      size: String(state.size),
      sizeOptions: [
        ...PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n), href: href({ page: 0, size: n }) })),
        { value: 'all', label: tPager('all'), href: href({ page: 0, size: 'all' }) },
      ],
      first: { label: tPager('first'), href: steps.first },
      prev: { label: tPager('previous'), href: steps.prev },
      next: { label: tPager('next'), href: steps.next },
      last: { label: tPager('last'), href: steps.last },
      countExactly: steps.countExactly ? { label: tPager('countExactly'), href: steps.countExactly } : null,
      truncatedText: state.truncated
        ? `${state.capped ? tPager('truncatedCapped', { shown: ALL_ROW_CEILING, total }) : tPager('truncated', { shown: ALL_ROW_CEILING, total })} ${tPager('truncatedHint')}`
        : null,
    },
  };
}
