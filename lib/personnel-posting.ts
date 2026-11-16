/**
 * Personnel postings: pure shapes shared by the service (core/personnel-posting.ts), the queue page and the movement
 * page (ADR docs/adr/2026-11-15-probation-shared-automation.md, decision 4; migration 5741).
 *
 * A posting carries a fixed allowlist of values. The database checks the same allowlist
 * (app.personnel_posting_values_ok); this module lets forms and tests refuse early with readable text.
 */
export const PROBATION_PERSONNEL_POSTING_EVENTS = ['confirmation', 'probationExtension'] as const;
export const OFFBOARDING_PERSONNEL_POSTING_EVENTS = ['transfer', 'promotion', 'increment', 'confirmation', 'salaryAdjustment', 'employmentTypeChange', 'termination'] as const;
export const PERSONNEL_POSTING_EVENTS = [...PROBATION_PERSONNEL_POSTING_EVENTS, ...OFFBOARDING_PERSONNEL_POSTING_EVENTS] as const;
export type PersonnelPostingEvent = (typeof PERSONNEL_POSTING_EVENTS)[number];
export const PERSONNEL_POSTING_SOURCES = ['probation', 'offboarding'] as const;
export type PersonnelPostingSource = (typeof PERSONNEL_POSTING_SOURCES)[number];
export type PersonnelPostingStatus = 'pending' | 'approved' | 'rejected';
/** What the queue shows: a pending posting that someone corrected reads "Edited · waiting for approval". */
export type PersonnelPostingDisplayStatus = 'pending' | 'edited' | 'approved' | 'rejected';

export type PersonnelPostingValues = {
  effectiveDate: string; endDate?: string | null; remarks?: string | null;
  positionId?: string; position?: string; gradeId?: string; jobGrade?: string; basicSalary?: string;
  exitReason?: string; resignationDate?: string;
};
export const PERSONNEL_POSTING_REMARKS_MAX = 200;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar day written yyyy-mm-dd (no Date parsing: the string is the date). */
export function isPostingDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DAY.exec(value);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days;
}

export const isPersonnelPostingEvent = (value: unknown): value is PersonnelPostingEvent =>
  typeof value === 'string' && (PERSONNEL_POSTING_EVENTS as readonly string[]).includes(value);

/** The allowlisted, normalised values for one event type, or the reason they are refused. */
export function normalisePostingValues(event: PersonnelPostingEvent, raw: Record<string, unknown>, source: PersonnelPostingSource = 'probation'):
  { ok: true; values: PersonnelPostingValues } | { ok: false; problem: 'effectiveDate' | 'endDate' | 'remarks' | 'fields' } {
  if (source === 'offboarding') return normaliseOffboardingPostingValues(event, raw);
  if (!(PROBATION_PERSONNEL_POSTING_EVENTS as readonly string[]).includes(event)) return {ok:false,problem:'fields'};
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
  return row.status === 'approved' || row.status === 'rejected' ? row.status : row.edited ? 'edited' : 'pending';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Money stays decimal text until the existing movement writer's bounded conversion. */
export function postingSalary(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction=''] = value.split('.');
  if (BigInt(whole)*100n + BigInt(fraction.padEnd(2,'0')) <= 0n) return null;
  return whole+'.'+fraction.padEnd(2,'0');
}
/** Offboarding has its own allowlist; Probation's three-field schema remains unchanged. */
export function normaliseOffboardingPostingValues(event: PersonnelPostingEvent, raw: Record<string, unknown>):
  {ok:true;values:PersonnelPostingValues}|{ok:false;problem:'effectiveDate'|'endDate'|'remarks'|'fields'} {
  if (!(OFFBOARDING_PERSONNEL_POSTING_EVENTS as readonly string[]).includes(event)) return {ok:false,problem:'fields'};
  const allowed = new Set(['effectiveDate','remarks','positionId','position','gradeId','jobGrade','basicSalary','exitReason','resignationDate']);
  if (Object.keys(raw).some(k=>!allowed.has(k))) return {ok:false,problem:'fields'};
  if (!isPostingDay(raw.effectiveDate)) return {ok:false,problem:'effectiveDate'};
  const values:PersonnelPostingValues={effectiveDate:raw.effectiveDate};
  if (raw.remarks != null && (typeof raw.remarks !== 'string' || raw.remarks.length>200)) return {ok:false,problem:'remarks'};
  if (typeof raw.remarks==='string'&&raw.remarks.trim()) values.remarks=raw.remarks.trim();
  if (event==='termination') {
    if (Object.keys(raw).some(k=>['positionId','position','gradeId','jobGrade','basicSalary'].includes(k))) return {ok:false,problem:'fields'};
    if (typeof raw.exitReason!=='string'||!raw.exitReason.trim()||raw.exitReason.length>200||!isPostingDay(raw.resignationDate)) return {ok:false,problem:'fields'};
    values.exitReason=raw.exitReason.trim();values.resignationDate=raw.resignationDate;return {ok:true,values};
  }
  if ('exitReason' in raw || 'resignationDate' in raw) return {ok:false,problem:'fields'};
  for (const [id,label] of [['positionId','position'],['gradeId','jobGrade']] as const) {
    if (raw[id]!==undefined) {
      if(typeof raw[id]!=='string'||!UUID.test(raw[id])||typeof raw[label]!=='string'||!raw[label].trim()||raw[label].length>200)return {ok:false,problem:'fields'};
      values[id]=raw[id];values[label]=raw[label].trim();
    } else if (raw[label]!==undefined) return {ok:false,problem:'fields'};
  }
  if(raw.basicSalary!==undefined){const salary=postingSalary(raw.basicSalary);if(!salary)return {ok:false,problem:'fields'};values.basicSalary=salary;}
  if (['promotion','transfer','increment','salaryAdjustment'].includes(event)&&!values.positionId&&!values.gradeId&&!values.basicSalary) return {ok:false,problem:'fields'};
  return {ok:true,values};
}

/** The values in effect: what approval applied, else the latest correction, else what the workflow proposed. */
export function postingCurrentValues(row: { proposed: PersonnelPostingValues; edited: PersonnelPostingValues | null; applied: PersonnelPostingValues | null }): PersonnelPostingValues {
  return row.applied ?? row.edited ?? row.proposed;
}
