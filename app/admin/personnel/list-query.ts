/**
 * ONE reading of the Personnel listing's query string (feedback 579255c3), shared by the screen
 * (page.tsx) and the Excel export (export/route.ts).
 *
 * Point 9 is "the export should respect the selected filters", and the only way to guarantee that is for
 * the file and the table to be produced from the same parse of the same params. Two hand-rolled readings
 * of `?company=&dept=&bucket=` is how an export quietly ships the unfiltered list.
 *
 * Server-only module (it imports a type from core/read); no 'use client' component may import it.
 *
 * ── WHY `bucket` IS A NEW PARAM AND NOT MORE MEANINGS FOR `status` ──────────────────────────────────
 * `status` has always carried a LIFECYCLE query — `active` = terminated_on is null, `terminated` = set,
 * plus `draft` for the unfinished records. The headcount cards ask a DIFFERENT question: the DERIVED
 * Employee Status (core/employment-status.ts), where somebody serving notice is not terminated and is
 * also not Active. One param cannot mean both, and overloading it would make the cards disagree with the
 * Status badge on the very rows they counted — 510f4bd1's lesson in r185.
 *
 * So the cards and the Filter's Status field both write `bucket`, on the derived vocabulary. `status` is
 * still HONOURED so an old bookmark or a saved link keeps narrowing exactly as it did, but nothing in the
 * UI writes it any more.
 */
import type { EmployeeListFilters } from '@/core/read';
import type { EmploymentStatus } from '@/core/employment-status';

/** The derived Employee Status buckets a reader can narrow to. `withhold` is absent because nothing
 *  populates payrollHoldAt, so no row can ever be in it (see core/employment-status-sql.ts). */
export const EMPLOYEE_STATUS_BUCKETS = [
  'active',
  'probation',
  'active_serving_notice',
  'resigned',
  'blacklisted',
] as const;

/** The one bucket that is NOT an employment: an unfinished Create New Employee record. */
export const DRAFT_BUCKET = 'draft';

export type PersonnelSearchParams = {
  error?: string;
  q?: string;
  page?: string;
  size?: string;
  company?: string;
  dept?: string;
  /** LEGACY lifecycle narrowing (active | terminated | draft). Honoured, never written. */
  status?: string;
  type?: string;
  /** Derived Employee Status bucket, or 'draft'. Written by the cards and the Filter's Status field. */
  bucket?: string;
  /** Explicit column list for the export, comma-separated (lib/employee-columns.columnsFromParam). */
  cols?: string;
};

const isBucket = (v: string | undefined): v is EmploymentStatus =>
  !!v && (EMPLOYEE_STATUS_BUCKETS as readonly string[]).includes(v);

export type PersonnelListQuery = {
  q?: string;
  company?: string;
  dept?: string;
  type?: string;
  /** The legacy lifecycle narrowing, once validated. */
  legacyStatus?: 'active' | 'terminated';
  /** The chosen derived bucket, if it is one an employment can be in. */
  bucket?: EmploymentStatus;
  /** True when the reader asked for the unfinished records ALONE — from either param. */
  draftOnly: boolean;
  /** True when any narrowing at all is applied (drives the empty state's wording). */
  hasFilters: boolean;
  /** Everything listEmployeesPage / countEmployeesByStatus need, minus the session's company scope. */
  filters: Omit<EmployeeListFilters, 'companyIds'>;
};

/**
 * Parse the screen's search params once. `scopeIds` is deliberately NOT taken here: the session's company
 * scope is a SECURITY fence resolved from the session, and mixing it into "what the reader asked to see"
 * is the conflation 8ec63139 called out on the leave read.
 */
export function parsePersonnelListQuery(sp: PersonnelSearchParams): PersonnelListQuery {
  const q = sp.q?.trim() || undefined;
  const company = sp.company || undefined;
  const dept = sp.dept || undefined;
  const type = sp.type || undefined;
  const legacyStatus = sp.status === 'active' || sp.status === 'terminated' ? sp.status : undefined;
  const bucket = isBucket(sp.bucket) ? sp.bucket : undefined;
  const draftOnly = sp.bucket === DRAFT_BUCKET || sp.status === DRAFT_BUCKET;
  return {
    q,
    company,
    dept,
    type,
    legacyStatus,
    bucket,
    draftOnly,
    hasFilters: !!(q || company || dept || type || sp.status || sp.bucket),
    filters: {
      q,
      companyId: company,
      departmentId: dept,
      status: legacyStatus,
      employmentType: type,
      employmentStatuses: bucket ? [bucket] : undefined,
    },
  };
}

/**
 * The SAME query with the bucket narrowing removed — what the headcount cards are counted over.
 *
 * The cards are a FACET of the current view, not of the whole database: narrow to one company and the
 * five figures describe that company, so "Total" always equals the sum of the buckets beneath it and
 * clicking a card cannot produce a row count that contradicts the number on the card. What they never
 * follow is the bucket itself — cards that re-counted themselves would all read 0 but one.
 */
export function headcountFilters(query: PersonnelListQuery): Omit<EmployeeListFilters, 'companyIds'> {
  return { ...query.filters, employmentStatuses: undefined };
}

/**
 * Whether an unfinished draft record survives the current narrowing (feedback 06f0cb8f, preserved here).
 *
 * A draft is not an employment: it has no assignment, so no department and no employment type, and no
 * lifecycle dates. Each of those filters therefore HIDES every draft rather than pretending to match one,
 * while Company and the search box genuinely apply. ONE predicate, used by both the rows and the Draft
 * card, so the card can never promise records the table then refuses to show.
 */
export function draftMatchesQuery(
  d: {
    companyId: string | null;
    label: string | null;
    reservedEmployeeCode: string | null;
    companyName: string | null;
  },
  query: PersonnelListQuery,
): boolean {
  if (query.dept || query.type || query.legacyStatus) return false;
  if (query.bucket) return false; // a derived employment bucket can never contain a draft
  if (query.company && d.companyId !== query.company) return false;
  if (query.q) {
    const needle = query.q.trim().toLowerCase();
    const hay = `${d.label ?? ''} ${d.reservedEmployeeCode ?? ''} ${d.companyName ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/**
 * Which drafts the Personnel screen and its export are about, from the top-bar company scope (b1b1879d).
 *
 * THE REPORTED FAULT. Choosing Stradaverse at the top of the screen narrowed the employees but not the
 * drafts: the list, the Draft card and the Excel file all carried CHIN HIN's, Demo's and XYZ's drafts beside
 * Stradaverse's employees. The Filter panel's Company field already worked (`draftMatchesQuery` above); it
 * was the top-bar scope that drafts never received. ONE function, used by page.tsx and export/route.ts, so
 * the file and the screen cannot be scoped two ways.
 *
 * `allowedCount` is how many companies the reader may scope to at all (lib/scope.ts `scopedSession`). The
 * scope is NARROWED when it selects fewer than that. A draft with no company yet belongs to no one company,
 * so it appears only on the un-narrowed, every-company view — never under one company's name.
 */
export function draftListScope(
  scopeIds: readonly string[],
  allowedCount: number,
): { companyIds: readonly string[]; includeWithoutCompany: boolean } {
  // Distinct, because the scope cookie is a comma list a reader can repeat an id in: "A,A" is one company
  // selected, not two, and must not read as the whole of a two-company tenant.
  const selected = new Set(scopeIds).size;
  return { companyIds: scopeIds, includeWithoutCompany: selected > 0 && selected >= allowedCount };
}
