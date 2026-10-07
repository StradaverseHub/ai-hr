/**
 * r404 (42e55e2b) · MY LEAVE › LEAVE DETAILS — the ONE read behind the page and its Excel file.
 *
 * ── WHOSE ROWS ───────────────────────────────────────────────────────────────────────────────────────────
 * The signed-in person's, and nobody else's, decided HERE and only here: `myEmployment(session)`. This
 * function takes no employment id, no person id and no employee code, and reads nothing off the address but
 * the As-at date and the leave-code search. That is the whole of the security design, and it has to be,
 * because RLS does NOT confine an HR administrator or a manager to their own rows — `employeeBalanceRows`
 * called with a colleague's id under an HR session returns the colleague's balances. A page that took
 * `?emp=` would hand any HR user anyone's figures under a strip reading "your own record".
 * test/r404-leave-details.test.ts drives this loader and the export route with `?emp=`, `?employmentId=`
 * and friends under an employee, a manager and an HR session, and asserts the session's own rows come back.
 *
 * ── WHICH FIGURES ─────────────────────────────────────────────────────────────────────────────────────────
 * HR's Employee Balances rows (app/leave/employee-balances/rows.ts) with `audience: 'self'` — the same
 * builder, the same two reads, the same date — so for one employee and one As-at date this page and HR's
 * screen print the same numbers. The self audience only narrows (hidden / ineligible / all-zero types out)
 * and blanks what the leave type's Employee Leave View hides; see `selfView` there.
 *
 * ── WHAT THE FILE HOLDS ───────────────────────────────────────────────────────────────────────────────────
 * Exactly the sixteen columns on screen, in screen order (`LEAVE_DETAILS_COLUMNS`, read by both), because
 * the reporter's plan says "the same columns and figures as the table on screen".
 *
 * Read-only, no DomainEvent: viewing or downloading one's own balance mutates nothing.
 */
import type { SessionContext } from '@/db/client';
import { myEmployment } from '@/core/read';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { LEAVE_FIGURE_LABEL_KEY, LEAVE_FIGURE_NS } from '@/lib/leave-figure-labels';
import { employeeBalanceRows, type SelfBalanceRow } from '../employee-balances/rows';

/**
 * THE SIXTEEN COLUMNS, in HR's order (the plan lists them; app/leave/employee-balances/page.tsx is the
 * reference). Each names the catalogue key HR's own screen reads for that heading, so the employee's
 * heading and HR's cannot drift apart, and the export resolves the very same list so the file's headings
 * are the screen's. `align` is the column's body alignment on screen and in the file.
 */
export const LEAVE_DETAILS_COLUMNS = [
  { id: 'leaveCode', ns: 'leave.inquiry', key: 'colLeaveCode', align: 'left' },
  { id: 'entitlementYear', ns: 'leave.inquiry', key: 'colEntitlementYear', align: 'left' },
  { id: 'fullEntitlement', ns: 'me.leaveBalanceTable', key: 'colFullEntitlement', align: 'right' },
  { id: 'ytdEntitled', ns: LEAVE_FIGURE_NS, key: LEAVE_FIGURE_LABEL_KEY.ytdEntitled, align: 'right' },
  { id: 'broughtForward', ns: 'leave.inquiry', key: 'colBroughtForward', align: 'right' },
  { id: 'taken', ns: 'me.leaveBalanceTable', key: 'colTaken', align: 'right' },
  { id: 'pending', ns: 'leave.inquiry', key: 'colPendingApproval', align: 'right' },
  { id: 'adjustment', ns: 'me.leaveBalanceTable', key: 'colAdjustment', align: 'right' },
  { id: 'share', ns: 'me.leaveBalanceTable', key: 'colShare', align: 'right' },
  { id: 'pendingShare', ns: 'me.leaveBalanceTable', key: 'colPendingShare', align: 'right' },
  { id: 'overutilized', ns: 'me.leaveBalanceTable', key: 'colOverutilized', align: 'right' },
  { id: 'forfeitedBf', ns: 'leave.inquiry', key: 'colForfeitedBf', align: 'right' },
  { id: 'balance', ns: 'me.leaveBalanceTable', key: 'colBalance', align: 'right' },
  { id: 'available', ns: LEAVE_FIGURE_NS, key: LEAVE_FIGURE_LABEL_KEY.available, align: 'right' },
  { id: 'date', ns: 'leave.inquiry', key: 'colDate', align: 'left' },
  { id: 'explanation', ns: 'leave.inquiry', key: 'colExplanation', align: 'left' },
] as const;

export type LeaveDetailsColumnId = (typeof LEAVE_DETAILS_COLUMNS)[number]['id'];

/** The figure columns, in order — the cells a row prints through `formatDays`. */
export const LEAVE_DETAILS_FIGURES = [
  'fullEntitlement',
  'ytdEntitled',
  'broughtForward',
  'taken',
  'pending',
  'adjustment',
  'share',
  'pendingShare',
  'overutilized',
  'forfeitedBf',
  'balance',
  'available',
] as const satisfies readonly (LeaveDetailsColumnId & keyof SelfBalanceRow)[];

const first = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined;

/**
 * The As-at date: HR's rule (`YYYY-MM-DD`, else today on the Kuala Lumpur clock) made one step stricter — the
 * string must also be a real calendar day, so `2026-02-30` falls back to today instead of reaching Postgres.
 * Page and export call this one function, so a download link can never resolve to another date.
 */
export function leaveDetailsAsOf(raw: unknown, today: string = todayInKualaLumpur()): string {
  const v = first(raw);
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return today;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : today;
}

/** The leave-code search: trimmed, at most 40 characters, absent when empty. */
export function leaveDetailsQuery(raw: unknown): string | undefined {
  const v = first(raw)?.trim();
  return v ? v.slice(0, 40) : undefined;
}

export type LeaveDetailsMe = NonNullable<Awaited<ReturnType<typeof myEmployment>>>;

export type LeaveDetailsData = {
  /** The signed-in person's own active employment; null ⇒ this login is linked to no employee. */
  me: LeaveDetailsMe | null;
  asOf: string;
  q: string | undefined;
  rows: SelfBalanceRow[];
};

/**
 * Load the page (or the file). `input` is the address's query string as an object; ONLY `asOf` and `q` are
 * read from it. Any other key — `emp`, `employmentId`, `personId`, `code` — is ignored by construction, not
 * by a check that could be forgotten.
 */
export async function loadLeaveDetails(
  session: SessionContext,
  input: Record<string, unknown>,
  locale: string,
): Promise<LeaveDetailsData> {
  const asOf = leaveDetailsAsOf(input.asOf);
  const q = leaveDetailsQuery(input.q);
  const me = await myEmployment(session);
  if (!me) return { me: null, asOf, q, rows: [] };
  const rows = await employeeBalanceRows(session, me.employmentId, asOf, locale, { q }, { audience: 'self' });
  return { me, asOf, q, rows };
}

/** The download's address for the view on screen: the date and the search, and nothing that names a person. */
export function leaveDetailsExportHref(asOf: string, q: string | undefined): string {
  const p = new URLSearchParams({ asOf });
  if (q) p.set('q', q);
  return `/leave/details/export?${p.toString()}`;
}

/** `LeaveDetails_<EmployeeNo>_<AsAtDate>`, ASCII-safe: the code is the session's own, never a parameter. */
export function leaveDetailsFilename(employeeCode: string | null | undefined, asOf: string): string {
  const code = (employeeCode ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'employee';
  return `LeaveDetails_${code}_${asOf}`;
}
