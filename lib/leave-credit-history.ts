/**
 * r389 bc3e203d · LEAVE CREDIT HISTORY — the employee's own Leave Credit requests, what each one asked for,
 * what happened to it, and what has happened to the credit it minted since.
 *
 * PURE: no database, no clock, no translator. The page (app/leave/credit/page.tsx), its export
 * (app/leave/credit/export/route.ts) and the client island (components/leave/leave-credit-history.tsx) all
 * read the SAME filter, sort and count functions from here, so "the file downloads what you are looking at"
 * is a property of one function rather than a promise between three files.
 *
 * ── ONE ROW PER DATE WORKED, NOT PER REQUEST ─────────────────────────────────────────────────────────────
 * A Leave Credit request may carry several dates worked, and each date mints its OWN credit on approval
 * (core/replacement-request.ts decideReplacementLeaveRequest: one `toil_accrual` per line). The credit's
 * status, expiry and usage therefore belong to the LINE, while the approval status belongs to the request.
 * So the table is one row per line, and a row's Approval Status is its request's. Cancel withdraws the whole
 * request (the approval is per request), which the confirmation says in words, naming every date.
 *
 * ── NOTHING HERE IS RECALCULATED ─────────────────────────────────────────────────────────────────────────
 * Credit days, the expiry date and the credit status are the stored facts (the line's `days`, the credit's
 * `expires_on` and `status`). "Used" is the sum of the `toil.consumed` events for the credit less the
 * `toil.restored` events; "Remaining" is what is left of the credit while it is Available and zero once it
 * has expired, been paid out or been reversed. A paid-out credit is shown in DAYS: no money figure is read
 * by the core read that feeds this module, so none can reach the page.
 */

/** The five names the HR Leave Credit screen uses, in its order (core/toil.ts `LeaveCreditStatus`). */
export const LEAVE_CREDIT_STATUSES = ['available', 'used', 'expired', 'paid_out', 'reversed'] as const;
export type LeaveCreditStatusKey = (typeof LEAVE_CREDIT_STATUSES)[number];

/**
 * `toil_accrual_status` → the name on screen. The SAME mapping core/toil.ts `listLeaveCreditMovements` uses
 * for HR (`statusOf`); test/r389-leave-credit-history.test.ts drives every enum value through it, so a sixth
 * register status cannot arrive without a name.
 */
export const CREDIT_STATUS_OF_ACCRUAL = {
  active: 'available',
  taken: 'used',
  lapsed: 'expired',
  converted_to_pay: 'paid_out',
  reversed: 'reversed',
} as const satisfies Record<string, LeaveCreditStatusKey>;
export type AccrualStatus = keyof typeof CREDIT_STATUS_OF_ACCRUAL;

/** The label key under `admin.leaveCredit.status` — the HR screen's own catalogue entries, reused. */
export const CREDIT_STATUS_LABEL_KEY: Record<LeaveCreditStatusKey, string> = {
  available: 'status.available',
  used: 'status.used',
  expired: 'status.expired',
  paid_out: 'status.paidOut',
  reversed: 'status.reversed',
};

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const APPROVAL_TABS = ['all', ...APPROVAL_STATUSES] as const;
export type ApprovalTab = (typeof APPROVAL_TABS)[number];

/** Day Type options, in the order the request screen's reporter listed them on this item. */
export const CREDIT_DAY_TYPES = ['workday', 'rest_day', 'off_day', 'holiday'] as const;
export type CreditDayType = (typeof CREDIT_DAY_TYPES)[number];
/** The label key under `replacementRequest.dayKind` — the request and approver screens' own names. */
export const DAY_TYPE_LABEL_KEY: Record<CreditDayType, string> = {
  workday: 'dayKind.workday',
  rest_day: 'dayKind.restDay',
  off_day: 'dayKind.offDay',
  holiday: 'dayKind.holiday',
};

/** Rows per page, as the reporter described them. The first is the default. */
export const CREDIT_HISTORY_PAGE_SIZES = [10, 20, 50] as const;
export type CreditHistoryPageSize = (typeof CREDIT_HISTORY_PAGE_SIZES)[number];

/** An Available credit shows "N days left" when it expires within this many days (inclusive). */
export const EXPIRY_HINT_DAYS = 30;

/** One leave application that drew on a credit: named by its dates and leave type, never by a reference. */
export type CreditUsage = {
  leaveRequestId: string;
  startDate: string;
  endDate: string;
  leaveTypeId: string;
  /** consumed − restored for this application on this credit; only applications with something left are listed. */
  days: number;
};

export type CreditFacts = {
  accrualId: string;
  status: LeaveCreditStatusKey;
  expiresOn: string;
  daysCredited: number;
  /** Σ toil.consumed − Σ toil.restored for this credit. */
  used: number;
  /** What is left while Available; 0 once used up, expired, paid out or reversed. */
  remaining: number;
  /** The expiry sweep's settlement: days only, never an amount. */
  settled: { kind: 'expired' | 'paid_out'; days: number; on: string } | null;
  /** Kuala Lumpur calendar day of an HR reversal. */
  reversedOn: string | null;
  usage: CreditUsage[];
};

/** One date worked, as the history reads it. Plain data: it crosses to the client island as is. */
export type CreditHistoryLine = {
  lineId: string;
  requestId: string;
  /** The request's short reference — the first eight characters of its id, upper-cased. */
  requestRef: string;
  workedDate: string;
  dayType: CreditDayType | null;
  fromTime: string | null;
  toTime: string | null;
  hours: number | null;
  /** The line's credit days as stored (projected at submission; re-derived and stored again at approval). */
  days: number | null;
  submittedOn: string;
  approvalStatus: ApprovalStatus;
  /** Kuala Lumpur day and time of the decision, or of the employee's cancellation. */
  decidedOn: string | null;
  decidedTime: string | null;
  decisionNote: string | null;
  reason: string | null;
  /** The attendance snapshot stored with the line (ordinary-day lines only). */
  shiftEnd: string | null;
  actualClockOut: string | null;
  eligibleMinutes: number | null;
  /** Present only on an approved line whose credit was minted. */
  credit: CreditFacts | null;
};

export type CreditHistoryFilters = {
  tab: ApprovalTab;
  creditStatus: LeaveCreditStatusKey | null;
  dayType: CreditDayType | null;
  year: number | null;
  from: string | null;
  to: string | null;
};

export type CreditHistoryQuery = {
  filters: CreditHistoryFilters;
  page: number;
  size: CreditHistoryPageSize;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const isIn = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * Read the address. Every value is NARROWED, never passed through: an unknown tab is All, an unknown status
 * or day type is no filter, a malformed date is no bound — so a hand-edited link cannot start filtering on a
 * value the form would never have produced.
 */
export function parseCreditHistoryQuery(sp: Record<string, string | string[] | undefined>): CreditHistoryQuery {
  const tabRaw = one(sp.tab);
  const creditRaw = one(sp.credit);
  const dayRaw = one(sp.day);
  const yearRaw = Number(one(sp.year));
  const fromRaw = one(sp.from);
  const toRaw = one(sp.to);
  const sizeRaw = Number(one(sp.size));
  const pageRaw = Number(one(sp.page));
  return {
    filters: {
      tab: isIn(APPROVAL_TABS, tabRaw) ? tabRaw : 'all',
      creditStatus: isIn(LEAVE_CREDIT_STATUSES, creditRaw) ? creditRaw : null,
      dayType: isIn(CREDIT_DAY_TYPES, dayRaw) ? dayRaw : null,
      year: Number.isInteger(yearRaw) && yearRaw >= 1900 && yearRaw <= 9999 ? yearRaw : null,
      from: fromRaw && ISO.test(fromRaw) ? fromRaw : null,
      to: toRaw && ISO.test(toRaw) ? toRaw : null,
    },
    page: Number.isSafeInteger(pageRaw) && pageRaw > 0 ? pageRaw : 0,
    size: (CREDIT_HISTORY_PAGE_SIZES as readonly number[]).includes(sizeRaw) ? (sizeRaw as CreditHistoryPageSize) : CREDIT_HISTORY_PAGE_SIZES[0],
  };
}

/**
 * "Choosing a Credit Status switches the tab to Approved" (bc3e203d). Only an approved request has a credit,
 * so any other tab with a Credit Status chosen is empty by definition. Used by the filter form when it is
 * applied; the tab links themselves still go where they say.
 */
export function tabAfterApply(currentTab: ApprovalTab, creditStatus: string | null | undefined): ApprovalTab {
  return creditStatus ? 'approved' : currentTab;
}

/** Newest date worked first; within one date, the newer request first; then a stable tiebreak. */
export function compareCreditHistoryLines(a: CreditHistoryLine, b: CreditHistoryLine): number {
  if (a.workedDate !== b.workedDate) return b.workedDate.localeCompare(a.workedDate);
  if (a.submittedOn !== b.submittedOn) return b.submittedOn.localeCompare(a.submittedOn);
  if (a.requestId !== b.requestId) return b.requestId.localeCompare(a.requestId);
  return a.lineId.localeCompare(b.lineId);
}

/** Every filter EXCEPT the tab. The tab counts are taken over this set. */
function matchesFilters(l: CreditHistoryLine, f: CreditHistoryFilters): boolean {
  if (f.creditStatus && l.credit?.status !== f.creditStatus) return false;
  if (f.dayType && l.dayType !== f.dayType) return false;
  if (f.year != null && Number(l.workedDate.slice(0, 4)) !== f.year) return false;
  if (f.from && l.workedDate < f.from) return false;
  if (f.to && l.workedDate > f.to) return false;
  return true;
}

export type CreditHistoryResult = {
  /** The tab's rows, newest date worked first. */
  rows: CreditHistoryLine[];
  /** One count per tab, each over the FILTERED set (so the badges always add up to what you can reach). */
  counts: Record<ApprovalTab, number>;
};

export function applyCreditHistoryFilters(lines: readonly CreditHistoryLine[], f: CreditHistoryFilters): CreditHistoryResult {
  const filtered = lines.filter((l) => matchesFilters(l, f));
  const counts = { all: filtered.length, pending: 0, approved: 0, rejected: 0, cancelled: 0 } as Record<ApprovalTab, number>;
  for (const l of filtered) counts[l.approvalStatus] += 1;
  const rows = (f.tab === 'all' ? filtered : filtered.filter((l) => l.approvalStatus === f.tab)).sort(compareCreditHistoryLines);
  return { rows, counts };
}

/** Is any filter (other than the tab) narrowing the list? */
export function isFiltered(f: CreditHistoryFilters): boolean {
  return f.creditStatus != null || f.dayType != null || f.year != null || f.from != null || f.to != null;
}

/** The query string for this view, with overrides. Only non-default values are written. */
export function creditHistoryParams(
  q: { filters: CreditHistoryFilters; page?: number; size?: CreditHistoryPageSize },
  over: Partial<CreditHistoryFilters> & { page?: number; size?: CreditHistoryPageSize } = {},
): URLSearchParams {
  const f = { ...q.filters, ...over };
  const size = over.size ?? q.size ?? CREDIT_HISTORY_PAGE_SIZES[0];
  const page = over.page ?? q.page ?? 0;
  const out = new URLSearchParams();
  if (f.tab !== 'all') out.set('tab', f.tab);
  if (f.creditStatus) out.set('credit', f.creditStatus);
  if (f.dayType) out.set('day', f.dayType);
  if (f.year != null) out.set('year', String(f.year));
  if (f.from) out.set('from', f.from);
  if (f.to) out.set('to', f.to);
  if (size !== CREDIT_HISTORY_PAGE_SIZES[0]) out.set('size', String(size));
  if (page > 0) out.set('page', String(page));
  return out;
}

/** Whole days from `today` to `expiresOn` (both ISO calendar days; negative once past). */
export function daysUntil(expiresOn: string, today: string): number {
  return Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/**
 * The orange "N days left" under an Expiry Date: only on an AVAILABLE credit, only from today up to
 * EXPIRY_HINT_DAYS ahead. `today` comes from `todayInKualaLumpur()` on the server, never the browser clock.
 */
export function expiryHintDays(line: Pick<CreditHistoryLine, 'credit'>, today: string): number | null {
  if (!line.credit || line.credit.status !== 'available') return null;
  const n = daysUntil(line.credit.expiresOn, today);
  return n >= 0 && n <= EXPIRY_HINT_DAYS ? n : null;
}

/** The years with a date worked, newest first — the Year filter offers nothing that would be empty. */
export function creditHistoryYears(lines: readonly CreditHistoryLine[]): number[] {
  return [...new Set(lines.map((l) => Number(l.workedDate.slice(0, 4))))].sort((a, b) => b - a);
}

/** `YYYY-MM-DD` → `DD/MM/YYYY`, day first, as the export and the reporter's sketch read. */
export function dmy(iso: string | null | undefined): string {
  if (!iso || !ISO.test(iso)) return '';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/** `18:30:00` → `18:30`. A time column comes back with seconds. */
export function hhmm(v: string | null | undefined): string {
  return v ? v.slice(0, 5) : '';
}

/** The short request reference other request screens show: the id's first eight characters, upper-cased. */
export function requestRefOf(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

/** Hours to one decimal, as the extended-hours cell prints them ("4.0"). */
export function hoursLabel(h: number | null | undefined): string {
  return h == null || !Number.isFinite(h) ? '' : (Math.round(h * 10) / 10).toFixed(1);
}
