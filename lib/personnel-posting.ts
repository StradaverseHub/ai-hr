/**
 * Personnel postings: pure shapes shared by the service (core/personnel-posting.ts), the queue page and the movement
 * page (ADR docs/adr/2026-11-15-probation-shared-automation.md, decision 4; migration 5741).
 *
 * A posting carries a fixed allowlist of values. The database checks the same allowlist
 * (app.personnel_posting_values_ok); this module lets forms and tests refuse early with readable text.
 */
export const PERSONNEL_POSTING_EVENTS = ['confirmation', 'probationExtension'] as const;
export type PersonnelPostingEvent = (typeof PERSONNEL_POSTING_EVENTS)[number];
export const PERSONNEL_POSTING_SOURCES = ['probation'] as const;
export type PersonnelPostingSource = (typeof PERSONNEL_POSTING_SOURCES)[number];
export type PersonnelPostingStatus = 'pending' | 'approved';
/** What the queue shows: a pending posting that someone corrected reads "Edited · waiting for approval". */
export type PersonnelPostingDisplayStatus = 'pending' | 'edited' | 'approved';

export type PersonnelPostingValues = { effectiveDate: string; endDate?: string | null; remarks?: string | null };
export const PERSONNEL_POSTING_REMARKS_MAX = 200;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar day written yyyy-mm-dd (no Date parsing: the string is the date). */
export function isPostingDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DAY.exec(value);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days;
}

export const isPersonnelPostingEvent = (value: unknown): value is PersonnelPostingEvent =>
  typeof value === 'string' && (PERSONNEL_POSTING_EVENTS as readonly string[]).includes(value);

/** The allowlisted, normalised values for one event type, or the reason they are refused. */
export function normalisePostingValues(event: PersonnelPostingEvent, raw: Record<string, unknown>):
  { ok: true; values: PersonnelPostingValues } | { ok: false; problem: 'effectiveDate' | 'endDate' | 'remarks' | 'fields' } {
  const allowed = new Set(['effectiveDate', 'endDate', 'remarks']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return { ok: false, problem: 'fields' };
  const effectiveDate = typeof raw.effectiveDate === 'string' ? raw.effectiveDate.trim() : raw.effectiveDate;
  if (!isPostingDay(effectiveDate)) return { ok: false, problem: 'effectiveDate' };
  const remarksRaw = raw.remarks;
  if (remarksRaw != null && typeof remarksRaw !== 'string') return { ok: false, problem: 'remarks' };
  const remarks = typeof remarksRaw === 'string' ? remarksRaw.trim() || null : null;
  if (remarks && remarks.length > PERSONNEL_POSTING_REMARKS_MAX) return { ok: false, problem: 'remarks' };
  const values: PersonnelPostingValues = { effectiveDate };
  if (event === 'probationExtension') {
    const endDate = typeof raw.endDate === 'string' ? raw.endDate.trim() : raw.endDate;
    if (!isPostingDay(endDate)) return { ok: false, problem: 'endDate' };
    values.endDate = endDate;
  } else if (raw.endDate != null && raw.endDate !== '') return { ok: false, problem: 'endDate' };
  if (remarks) values.remarks = remarks;
  return { ok: true, values };
}

/** "PP-1043": the number people quote. */
export const postingLabel = (number: number) => `PP-${number}`;

export type PostingChangedField = { field: 'effectiveDate' | 'endDate' | 'remarks'; before: string | null; after: string | null };
/** Which allowlisted fields differ between two value sets, in a stable order. */
export function postingValueChanges(before: PersonnelPostingValues, after: PersonnelPostingValues): PostingChangedField[] {
  return (['effectiveDate', 'endDate', 'remarks'] as const).flatMap((field) => {
    const a = before[field] ?? null, b = after[field] ?? null;
    return a === b ? [] : [{ field, before: a, after: b }];
  });
}

export function postingDisplayStatus(row: { status: PersonnelPostingStatus; edited: PersonnelPostingValues | null }): PersonnelPostingDisplayStatus {
  return row.status === 'approved' ? 'approved' : row.edited ? 'edited' : 'pending';
}

/** The values in effect: what approval applied, else the latest correction, else what the workflow proposed. */
export function postingCurrentValues(row: { proposed: PersonnelPostingValues; edited: PersonnelPostingValues | null; applied: PersonnelPostingValues | null }): PersonnelPostingValues {
  return row.applied ?? row.edited ?? row.proposed;
}
