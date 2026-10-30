import { withExitDateAuthorityTx } from './exit-date-authority';
import { isDatabaseError } from '../lib/db-error';
import { hasClosedPayrollCorrectionAuthorityTx, withClosedPayrollCorrectionAuthorityTx } from './closed-payroll-correction-authority';
import {assertWorkforceEmploymentTx} from './workforce-access';
/**
 * Employment History — Movement tab redesign (78853b97).
 *
 * ARCHITECTURE: Employment History is a read-model PROJECTION over the existing domain_event ledger
 * (db/events.ts, ADR-0006/0015) — NOT a new table. There is no dual-write, no backfill and no way for
 * the history and the audit log to disagree: every state-changing service already appends its event in
 * the same transaction, so recording is automatic for changes made from ANY screen, and pre-launch
 * events are visible on day one. This module classifies those events into movement rows at read time
 * (per-employee volumes are tiny; payload shapes are heterogeneous, so TypeScript mapping beats SQL).
 *
 * The write half is `createMovementEvent` — ONE dispatcher entry point for the New Event form that
 * delegates to the EXISTING writers (setEmploymentAssignment/Grade/Info, setCompensation,
 * terminateEmployment, setEmploymentBlacklist, setReportingLine), so downstream sync
 * (payroll, leave, attendance, directory, analytics) is inherent. It attaches an optional movement
 * classification tag (db/events.ts MovementTag) that records the INTENT (Promotion vs a plain edit);
 * untagged / historical events keep plain, factual fallback labels.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { todayInKualaLumpur } from '../lib/hr-date';
import {isCalendarDate} from '../lib/calendar-date';
import {MOVEMENT_FLAT_FIELDS,MOVEMENT_PENDING_COMPARISON_FIELDS,MOVEMENT_PENDING_INPUT_FIELDS,movementPendingFormValues,type MovementFlatField,type MovementPendingFormValues} from '../lib/movement-pending-input';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { lockLeaveDependencyConfigurationTx } from './leave-dependency-lock';
import { appendEvent, actorOf, type MovementTag } from '../db/events';
import {
  appUser,
  assignment,
  businessUnit,
  company,
  compensation,
  department,
  domainEvent,
  employment,
  jobGrade,
  location,
  movementEventType,
  person,
  position,
  reportingLine,
} from '../db/schema';
import {
  setEmploymentAssignment,
  setEmploymentBlacklist,
  setEmploymentGrade,
  setEmploymentInfo,
  setReportingLine,
  terminateEmploymentTx,
  reverseTerminationTx,
  transferEmploymentCompanyTx,
  lockEmploymentStatutoryOwnerTx,
  type EmploymentTypeValue,
  type TerminationType,
} from './org';
import { assertTerminationReasonOfferedTx, resolveTerminationReasonTx } from './termination-reason-catalog';
import {
  COMPARISON_KINDS,
  INTERCHANGEABLE_COMPARISON_KINDS,
  MOVEMENT_KINDS,
  isComparisonKind,
  type ComparisonKind,
  type MovementKind,
} from './movement-kinds';
import { lockMovementTypeCatalogueTx, resolveMovementEventTypeTx, resolveMovementEventTypeRows } from './movement-type';
// 1d58019a Step 2 (ADR-0166) — the per-type controls the writer enforces (offered reasons, Field Controls)
// and the movement's supporting documents. Both modules are leaves: neither imports this one.
import { assertTerminationReasonOfferedForTypeTx, movementFieldRulesTx } from './movement-type-controls';
import {
  MovementDocumentError,
  carryMovementAttachmentsTx,
  listMovementAttachmentsTx,
  movementAttachmentFieldsTx,
  readMovementAttachmentRowTx,
  saveMovementAttachmentsTx,
  validateMovementDocuments,
  type MovementAttachmentSummary,
  type MovementDocumentUpload,
} from './movement-attachments';
import { movementFieldRuleViolations, type MovementFieldRule, type MovementFieldRuleViolation } from '../lib/movement-field-rules';
// c063eea9 — the hire-details correction. It owns its event and the trace the Hired row wears; this module
// loads the event (it projects no row of its own) and follows its row replacements when rolling back.
import {
  HIRE_CORRECTED_EVENT,
  hireCorrectionTraceTx,
  liveIncarnationOf,
  type HireCorrectionTrace,
} from './hire-correction';
import {
  closedPeriodsTx,
  nextMonthStart,
  overlapsClosedPeriod,
  processedPeriodsTx,
  setCompensation,
  supersedeCompensation,
} from './comp';

/* 476f23ed — MOVEMENT_KINDS / COMPARISON_KINDS moved to core/movement-kinds.ts and are RE-EXPORTED here,
 * so every existing importer of core/movement is untouched. The move exists to break one import cycle:
 * core/movement-type.ts (the configurable catalogue) needs the built-in kind list, and this module needs
 * the catalogue to resolve a tenant's own event type — a leaf module both can import is the whole fix. */
export { COMPARISON_KINDS, INTERCHANGEABLE_COMPARISON_KINDS, MOVEMENT_KINDS, isComparisonKind };
/** 1d58019a Step 2 — re-exported so the server actions and the document route need one import. */
export { MovementDocumentError };
export type { MovementAttachmentSummary, MovementDocumentUpload };
export type { ComparisonKind, MovementKind };

/** Frozen resignation dates for the selected history event, independent of today's master. */
export type MovementRecordedResignation={source:{eventId:string;role:'intent'|'effect'};tenderResignationDate:MovementRecordedValue<string|null>;resignationDate:MovementRecordedValue<string|null>;lastWorkingDate:MovementRecordedValue<string|null>};
export function movementRecordedResignationOf(event:{id:string;eventType:string;payload:unknown}):MovementRecordedResignation|null{
  const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
  const payload=object(event.payload),tag=object(payload.movement);
  const intent=event.eventType==='employment.movement.scheduled'&&payload.type==='resignation';
  const effect=event.eventType==='employment.info.updated'&&tag.type==='resignation';
  if(!intent&&!effect)return null;
  const values=object(intent?payload.input:payload.after);
  const recorded=(key:string):MovementRecordedValue<string|null>=>Object.hasOwn(values,key)&&(values[key]===null||typeof values[key]==='string'&&isCalendarDate(values[key] as string))?{known:true,value:values[key] as string|null}:{known:false,value:null};
  return {source:{eventId:event.id,role:intent?'intent':'effect'},tenderResignationDate:recorded('tenderResignationDate'),resignationDate:recorded(intent?'resignationEffectiveDate':'resignationDate'),lastWorkingDate:intent?Object.hasOwn(payload,'endDate')&&(payload.endDate===null||typeof payload.endDate==='string'&&isCalendarDate(payload.endDate))?{known:true,value:payload.endDate as string|null}:{known:false,value:null}:recorded('lastWorkingDate')};
}

/** Recorded absence is distinct from a recorded blank/zero. Never hydrate these from live employment. */
export type MovementRecordedValue<T> = { known: true; value: T } | { known: false; value: null };
export type MovementRecordedExit = {
  source: {
    eventId: string;
    occurredAt: string;
  } & (
    | { eventType: 'employment.terminated'; role: 'effect' }
    | { eventType: 'employment.movement.scheduled'; role: 'intent' }
  );
  terminationReasonCode: MovementRecordedValue<string | null>;
  terminationNoticeDays: MovementRecordedValue<number | null>;
};

/** Pure projection of this row's primary event. A scheduled row continues to describe frozen intent
 * after application/reversal; its separate status describes the outcome. Do not substitute a companion
 * event or today's mutable exit columns. Unknown legacy/malformed values remain explicitly unknown.
 */
export function movementRecordedExitOf(event: {
  id: string; eventType: string; payload: unknown; occurredAt: Date;
}, behaviourOf?: (code: string) => string | null | undefined): MovementRecordedExit | null {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const payload = object(event.payload);
  let values: Record<string, unknown>;
  let source: MovementRecordedExit['source'];
  if (event.eventType === 'employment.terminated') {
    values = payload;
    source = { eventId: event.id, occurredAt: event.occurredAt.toISOString(), eventType: 'employment.terminated', role: 'effect' };
  } else if (
    event.eventType === 'employment.movement.scheduled' &&
    typeof payload.type === 'string' &&
    // 1d58019a Step 2 — a tenant's own Termination type schedules under ITS code; the catalogue decides.
    (payload.type === 'termination' || behaviourOf?.(payload.type) === 'termination')
  ) {
    values = object(payload.input);
    source = { eventId: event.id, occurredAt: event.occurredAt.toISOString(), eventType: 'employment.movement.scheduled', role: 'intent' };
  } else return null;
  const reason = values.terminationReasonCode;
  const notice = values.terminationNoticeDays;
  return {
    source,
    terminationReasonCode: Object.hasOwn(values, 'terminationReasonCode') &&
      (reason === null || typeof reason === 'string' && reason.trim() !== '')
      ? { known: true, value: reason as string | null } : { known: false, value: null },
    // A historical integer is a recorded fact, not a fresh notice-policy judgement. Never coerce text.
    terminationNoticeDays: Object.hasOwn(values, 'terminationNoticeDays') &&
      (notice === null || typeof notice === 'number' && Number.isSafeInteger(notice))
      ? { known: true, value: notice as number | null } : { known: false, value: null },
  };
}

/** One row of the Employment History list. `id` is the domain_event id, or the pseudo-id 'hired' when
 *  the Hired row is synthesized from employment.hiredOn (seed/legacy employments with no hired event —
 *  computed each render from the CURRENT hiredOn, so a hire-date correction can never leave a stale row). */
export type MovementHistoryRow = {
  id: string;
  /** A shipped kind, plus the display-only kinds 'hired' / 'blacklistCleared' / 'gradeChange', plus any
   *  unknown future kind recorded via employment.movement.recorded (the UI humanizes those). */
  kind: string;
  effectiveDate: string;
  /**
   * 941c9dac — the date the movement was KEYED, as opposed to the date it takes effect. Captured
   * automatically: it is `domain_event.occurred_at`, which HR cannot set and cannot edit, so the pair
   * "chosen effective date + captured entry date" the reporter asked for needs no new column and cannot
   * be back-dated. Null only for the synthesized Hired row, which projects from no event at all.
   */
  entryDate: string | null;
  /** 941c9dac — derived lifecycle (see MovementStatus). Never stored. */
  status: MovementStatus;
  endDate: string | null;
  remarks: string | null;
  /** 66a63bd6 — non-null once the movement has been rolled back. The row STAYS: a history that can be
   *  silently emptied stops being evidence, and payroll + statutory reporting both lean on it. */
  reversed: MovementReversal | null;
  /** Corrections are only offered where this module can actually replay the underlying writes; the UI
   *  reads these flags so the affordance and the service rule cannot drift apart. */
  canEdit: boolean;
  canReverse: boolean;
  /** The recorded command type; a voluntary termination may display as Resignation. */
  correctionKind?: string;
  /** A CLOSED payroll run relied on this movement's window. 646355e5 — corrections are allowed after HR
   *  acknowledges that closed payroll stays as issued; the screen asks for that confirmation. */
  payrollLocked: boolean;
  /** The closed 'YYYY-MM' periods behind `payrollLocked`, named in that confirmation. */
  payrollClosedPeriods: string[];
  /** A PROCESSED (not yet closed) run covered it. Correcting is allowed; payslips are never reprocessed
   *  automatically, so the UI must say so before HR commits. */
  payrollWarning: boolean;
  /**
   * r78c — the placement columns the reporter asked the history to show (Company, Division, Department,
   * Job Title, Basic), reconstructed AS OF this row's effective date, not read live. A row for a movement
   * recorded years ago must show what the employee's placement WAS then; reading today's columns would
   * make every row in the table identical and the history a lie.
   *
   * Reconstruction matches the detail view's After column exactly: the dated tables (assignment,
   * compensation) are resolved by effective date, and `division` — a flat, non-dated `employment` column —
   * is replayed from the ledger the same way the detail view replays job grade.
   *
   * `basic` puts a pay figure on the LIST for the first time. That is not a widening: movementHistory has
   * exactly one caller, the Personnel detail page, which is requireAdmin-gated and already renders the same
   * figure on the row's detail view (movementDetail.after.salary) and on the Basic Salary card.
   */
  company: string | null;
  division: string | null;
  department: string | null;
  jobTitle: string | null;
  basic: string | null;
  /**
   * e6a144d4 — three columns the LIST does not draw, added for the Employment History download
   * (lib/movement-export.ts). Additive only: the r78c eight-column table above is unchanged, and every
   * existing consumer of this row keeps reading exactly what it read before.
   *
   * `section` is the flat `employment.org_section` column replayed as-of, identical in shape and reasoning
   * to `division` above — the column holds only today's value, so an as-of read has to come from the ledger.
   *
   * `currency` / `basicAmount` are the two halves `basic` joins. The export needs the amount BARE: the
   * xlsx writer marks a cell numeric only when it parses as a plain number (lib/report-export.ts), so
   * "MYR 4500.00" lands as text an operator cannot sum. They are returned separately rather than re-split
   * downstream — a formatted string this function assembled is not a parseable source of truth (a null
   * compensation and a currency label containing a space both break the split).
   */
  section: string | null;
  currency: string | null;
  basicAmount: string | null;
  /**
   * c063eea9 — non-null on the HIRED row once its details have been corrected (core/hire-correction.ts):
   * who corrected it, when, why, and each corrected field's originally-recorded and corrected value. It is
   * NOT `reversed`: the Hired row stays live, keeps its place at the top of the history and is never
   * struck through — a correction of the hire is a fact about the hire, not an undoing of it. Null on every
   * other row.
   */
  hireCorrection: HireCorrectionTrace | null;
  /** Primary recorded exit values and effect/intent provenance. Optional for existing typed consumers;
   * canonical movementHistoryTx always supplies it, null for rows without a recorded exit event. */
  recordedExit?: MovementRecordedExit | null;
  recordedResignation?: MovementRecordedResignation | null;
};

/**
 * 941c9dac — the lifecycle of a movement, DERIVED at projection time. Deliberately NOT a stored column:
 * Employment History is a projection over the append-only ledger (see the module header), and a mutable
 * status column is exactly the thing that can drift out of step with the events it is supposed to
 * summarise. Every value here is a pure function of the events already in the ledger plus `today`:
 *
 *   • `applied`    — the movement has taken effect. Either it was dated today/in the past and applied on
 *                    save (the historical behaviour, and every pre-941c9dac movement), or it was scheduled
 *                    and the sweep has since appended its `employment.movement.applied` event.
 *   • `pending`    — recorded, dated in the FUTURE, not yet applied. It has written NOTHING: no dated row,
 *                    no flat column. The Employment tab still shows today's values.
 *   • `superseded` — recorded, never applied, and overtaken by a conflicting movement that has already
 *                    arrived (see supersededScheduledIds). It will never apply. The row STAYS visible —
 *                    "not silently ignored" is the whole point.
 *   • `reversed`   — rolled back (66a63bd6). Takes precedence over the other three.
 */
export type MovementStatus = 'applied' | 'pending' | 'superseded' | 'reversed';

/** 66a63bd6 — the visible trace a correction leaves on the movement it undid. */
export type MovementReversal = {
  at: Date;
  reason: string | null;
  /** true when the rollback was the first half of an EDIT (reverse + re-apply), false for a plain Rollback. */
  corrected: boolean;
  /**
   * bd89ccd8 — true when the movement was still PENDING when it was undone, i.e. it never applied and
   * never will. Derived, never stored: it is `scheduled && !appliedAt` read off the same projection that
   * decides the status. The screen calls that action Cancel rather than Roll Back, so the badge it leaves
   * has to say Cancelled — a confirmation promising "this event will never apply" followed by a row
   * labelled Reversed is the same mismatch between word and deed that 10fcf6df was about.
   */
  cancelled: boolean;
  /**
   * 10fcf6df — WHO rolled it back. The plan promises the movement stays in the history "together with who
   * did it and when"; `at` was already there, this is the other half. Resolved from the reversal event's
   * own actor (domain_event.actor_id → app_user → person), so it cannot be set by the caller and cannot
   * disagree with the audit trail. Null for a SYSTEM/import rollback or an actor whose person row is gone.
   */
  by: string | null;
};

/** Before/After comparison snapshot — ids resolved to labels at read time (stays correct after renames). */
export type MovementSnapshot = {
  company: string | null;
  businessUnit: string | null;
  department: string | null;
  position: string | null;
  grade: string | null;
  employmentType: string | null;
  manager: string | null;
  salary: string | null;
  /** Typed canonical salary for report comparisons; display salary remains unchanged. */
  salaryAmount?: string | null;
  currency?: string | null;
};

/**
 * 08913328 — the flat `employment` columns the comparison form can move (Division … Category). They are
 * NOT effective-dated, so unlike the MovementSnapshot fields they cannot be reconstructed as-of; their
 * before/after is read back from the movement's own `employment.info.updated` event payload.
 */
export {MOVEMENT_FLAT_FIELDS};
export type {MovementFlatField};

export type MovementFlatChange = { field: MovementFlatField; before: string | null; after: string | null };

/** The identity half of a history row (no correction affordances — the detail view never offers them). */
export type MovementRowSummary = Pick<
  MovementHistoryRow,
  'id' | 'kind' | 'effectiveDate' | 'entryDate' | 'status' | 'endDate' | 'remarks' | 'reversed'
>;

export type MovementIntentField = 'tenderResignationDate' | 'resignationEffectiveDate' | 'company' | 'businessUnit' | 'department' | 'position' | 'location' |
  'grade' | 'employmentType' | 'manager' | 'basicSalary' | 'currency' | 'payMode' | 'paymentTerm' | MovementFlatField;

/** Saved targets only: not an applied snapshot or an invented historical before-state. */
export type MovementPendingIntent = { values: { field: MovementIntentField; value: string | null }[] };

export type MovementDetail = {
  row: MovementRowSummary;
  recordedResignation?:MovementRecordedResignation|null;
  /** Full name of the user who recorded the change; null for SYSTEM/import writes and the synthesized row. */
  actorName: string | null;
  /** When the change was recorded; null for the synthesized Hired row. */
  occurredAt: Date | null;
  /** null = first record (the Hired row renders an After column only). */
  before: MovementSnapshot | null;
  after: MovementSnapshot;
  /** Pending comparison inputs, kept separate so Reports/ESS retain actual as-of semantics. */
  pendingIntent?: MovementPendingIntent | null;
  /** Flat, non-dated columns THIS movement actually moved. Empty when it moved none — the rows are only
   *  rendered when they carry real evidence, so a historical movement never shows today's value as if it
   *  had been part of the change. */
  flatChanges: MovementFlatChange[];
  /** c063eea9 — the Hired row's correction trace (see MovementHistoryRow). Null on every other row. */
  hireCorrection: HireCorrectionTrace | null;
};

/** Thrown when a New Event would change nothing — surfaced verbatim so remarks are never silently lost. */
export class MovementNoChangeError extends Error {
  constructor(message = 'This event would not change anything — there are no changes to record.') {
    super(message);
    this.name = 'MovementNoChangeError';
  }
}

/**
 * 1d58019a Step 2 (ADR-0166) — a movement does not meet its event type's Field Controls. `code` and `field`
 * are finite (the import turns them into a row code); the message is the sentence the New Event form shows.
 */
export class MovementFieldRuleError extends Error {
  readonly code: MovementFieldRuleViolation['code'];
  readonly field: string;
  constructor(v: MovementFieldRuleViolation) {
    const what = FIELD_RULE_NAMES[v.field] ?? v.field;
    super(
      v.code === 'field_not_included'
        ? `This event type does not change ${what}. Leave it as it is, or use another event type.`
        : v.code === 'field_not_editable'
          ? `${what.charAt(0).toUpperCase()}${what.slice(1)} cannot be edited for this event type. Leave it as it is.`
          : v.code === 'field_must_change'
            ? `This event type requires ${what} to change. Enter the new value.`
            : v.code === 'document_required'
              ? `Attach a supporting document for ${what}.`
              : `This event type does not take a supporting document for ${what}.`,
    );
    this.name = 'MovementFieldRuleError';
    this.code = v.code;
    this.field = v.field;
  }
}
/** English names for the service sentence; the screens and the import translate by field id instead. */
const FIELD_RULE_NAMES: Record<string, string> = {
  companyId: 'the company', businessUnitId: 'the business unit', departmentId: 'the department',
  positionId: 'the position', gradeId: 'the grade', employmentType: 'the employment type',
  locationId: 'the work location', managerEmploymentId: 'the reporting manager', basicSalary: 'the basic salary',
  currency: 'the currency', payMode: 'the pay mode', paymentTerm: 'the payment term', orgDivision: 'the division',
  employmentCategory: 'the category', orgRegion: 'the region', orgBranch: 'the branch', orgTeam: 'the team',
  orgSection: 'the section', orgLine: 'the line', orgBase: 'the base',
};

// The event-type allowlist the projection reads. compensation.updated (in-place correction) is
// deliberately EXCLUDED: amounts/remarks are reconstructed from the compensation row at read time, so
// corrections never diverge from the history.
const MOVEMENT_EVENT_TYPES = [
  'employment.hired',
  'assignment.transferred',
  // b7b22514 — the Entity Transfer's own leg. NOT `employment.company.changed`, which the pre-transaction
  // hire-time correction appends and which stays off this list on purpose (a mis-picked company corrected
  // on day one is not a career movement). Two acts, two event types; adding the other one here to make this
  // feature work would have retroactively turned every past correction into a movement.
  'employment.company.transferred',
  // b7b22514 — and its rollback. Projects NO row of its own (the reversal already shows on the original
  // row), but it MUST be loaded: the company as-of replay walks both types in sequence order, so a
  // transfer that was later rolled back stops governing the rows after it. Without this the replay would
  // keep reporting the destination company for an employment that has been moved back.
  'employment.company.transfer.reverted',
  'employment.assignment.changed',
  'employment.grade.changed',
  'compensation.set',
  'employment.info.updated',
  'employment-review.decided',
  'employment.terminated',
  'employment.blacklisted',
  'employment.blacklist.cleared',
  'reporting-line.set',
  'employment.movement.recorded',
  // 66a63bd6 — marks an EXISTING row as rolled back; it never projects a row of its own.
  'employment.movement.reversed',
  // 941c9dac — a FUTURE-dated movement's recorded INTENT. It owns the history row from the moment HR keys
  // it; the legs the sweep later writes are all tagged `secondary` under this event's groupId, so the
  // movement has exactly ONE line in the history whose STATUS moves Pending → Applied.
  'employment.movement.scheduled',
  // 941c9dac — the sweep's record that a scheduled movement took effect. Projects no row of its own; it
  // flips the scheduled row's derived status and carries the what-changed-from-what-to-what audit trail.
  'employment.movement.applied',
  // c063eea9 — a correction of the hire's details. Projects NO row of its own (like the reversal event):
  // it decorates the Hired row with its trace, and Roll Back reads its row replacements so a later
  // movement's rollback acts on the corrected row rather than on the superseded original.
  HIRE_CORRECTED_EVENT,
  'employment.information.corrected',
];

/* 30325fc1 — EXTENDED_PROBATION_FIELDS / RESIGNATION_FIELDS were DELETED here. They were the field groups
 * the projection used to INFER a movement kind from an untagged `employment.info.updated`: touching
 * extendedConfirmationDate meant "Probation Extension", touching lastWorkingDate meant "Resignation". That
 * inference is precisely the fault the reporter raised — an ordinary Employment Dates save minting a
 * movement of a type nobody chose — so the classification now comes from the movement tag alone (see the
 * block comment above the switch in projectRows). Do not reintroduce a field-group inference: it re-opens
 * this defect for every future field that happens to share a group. */

type RawEvent = {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: unknown;
  occurredAt: Date;
  sequence: number;
  actorId: string | null;
};

type ProjectedRow = Pick<MovementHistoryRow, 'id' | 'kind' | 'effectiveDate' | 'endDate' | 'remarks'> & {
  sequence: number;
  occurredAt: Date | null;
  /** MovementTag.groupId of the event this row projects — correlates the other legs of the same movement. */
  groupId: string | null;
  reversed: MovementReversal | null;
  /** 941c9dac — true when this row projects an `employment.movement.scheduled` event, i.e. it was keyed
   *  with a FUTURE effective date and deferred. False for every movement that applied on save. */
  scheduled: boolean;
  /** 941c9dac — when the sweep applied it (null while still pending / superseded). */
  appliedAt: Date | null;
  /** 941c9dac — the field names a SCHEDULED movement intends to move, computed from the real deltas at
   *  keying time and frozen into the scheduled event. Drives the same-field conflict test. Empty for
   *  movements that were never scheduled (they applied on save; nothing can overtake them). */
  fields: string[];
};

/** A movement kind the tag may legitimately name (guards a tampered/unknown tag from becoming a label). */
const isKnownKind = (v: string | undefined): v is MovementKind =>
  !!v && (MOVEMENT_KINDS as readonly string[]).includes(v);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tagOf = (e: RawEvent): MovementTag | null => (((e.payload ?? {}) as any).movement ?? null);

/**
 * The flat-column deltas an `employment.info.updated` event in this movement actually recorded. Reads the
 * event's own before/after diff (setEmploymentInfo writes both), so it stays truthful for a movement
 * recorded years ago — a live read of the column would show today's value on both sides.
 */
function flatChangesOf(groupEvents: RawEvent[]): MovementFlatChange[] {
  const out: MovementFlatChange[] = [];
  for (const e of groupEvents) {
    if (e.eventType !== 'employment.info.updated') continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (e.payload ?? {}) as Record<string, any>;
    const fields: string[] = Array.isArray(p.fields) ? p.fields : [];
    const before = (p.before ?? {}) as Record<string, unknown>;
    const after = (p.after ?? {}) as Record<string, unknown>;
    for (const f of MOVEMENT_FLAT_FIELDS) {
      if (!fields.includes(f)) continue;
      out.push({
        field: f,
        before: (before[f] as string | null) ?? null,
        after: (after[f] as string | null) ?? null,
      });
    }
  }
  return out;
}

/**
 * 941c9dac — the scheduled movements that will NEVER apply because a conflicting one overtook them.
 *
 * This is a PROJECTION-TIME decision, not a write-time one, and that is deliberate: two movements can
 * both be legitimately recorded on different days and only later turn out to conflict. Nothing is stamped
 * on the loser when the winner is keyed — the answer is recomputed from the ledger every read, so it stays
 * correct if either side is subsequently rolled back.
 *
 * A pending movement P loses to Q when ALL of:
 *   • Q has ARRIVED (its effective date is today or earlier) OR Q has already been applied. A Q still in
 *     the future and not yet applied cannot overtake anything — P will reach its own effective date first
 *     and apply normally, and until then nothing is decided. The `already applied` half matters because
 *     the answer must not depend on WHO IS LOOKING: once the sweep has put Q into effect, P is dead for
 *     everyone, including a screen rendered with an earlier notion of today.
 *   • Q moves at least one of the same FIELDS as P. Disjoint movements (a transfer and a raise) are both
 *     legitimate and both apply; only a genuine same-field conflict has a loser.
 *   • Q wins latest-effective-date-wins, ties broken by which was keyed later (ledger sequence). The tie
 *     break is the common real case: HR keys a future promotion, spots a wrong grade, and re-keys it for
 *     the SAME date. Two dated rows cannot both hold that day, so the earlier entry is the loser.
 *
 * P is only a candidate while it has not applied — once a movement has taken effect it is history, and
 * unwinding it is Cancel's job, not supersession's.
 */
function supersededScheduledIds(rows: ProjectedRow[], today: string): Set<string> {
  const out = new Set<string>();
  const live = rows.filter((r) => r.scheduled && !r.reversed);
  for (const p of live) {
    if (p.appliedAt) continue;
    for (const q of live) {
      if (q === p) continue;
      if (q.effectiveDate > today && !q.appliedAt) continue;
      if (!q.fields.some((f) => p.fields.includes(f))) continue;
      const qWins =
        q.effectiveDate > p.effectiveDate ||
        (q.effectiveDate === p.effectiveDate && q.sequence > p.sequence);
      if (qWins) {
        out.add(p.id);
        break;
      }
    }
  }
  return out;
}

/** 941c9dac — the derived lifecycle of one row (see MovementStatus). Reversal wins over everything: a
 *  rolled-back movement reads `reversed` whether it had applied or was still pending. */
function statusOfRow(r: ProjectedRow, superseded: Set<string>): MovementStatus {
  if (r.reversed) return 'reversed';
  // Never scheduled ⇒ it applied on save. That covers every movement recorded before 941c9dac and every
  // movement dated today or in the past, which the reporter explicitly wants applied immediately.
  if (!r.scheduled) return 'applied';
  if (r.appliedAt) return 'applied';
  if (superseded.has(r.id)) return 'superseded';
  return 'pending';
}

/** 'YYYY-MM-DD' minus one day, in pure UTC string math (no TZ drift). */
function dayBefore(d: string): string {
  const ms = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}

/**
 * The DATE an instant falls on, in the tenant's timezone — NOT in UTC.
 *
 * This feeds `entryDate`, the date HR keyed a movement, which sits beside `effectiveDate` on Employment
 * History. It used to be `d.toISOString().slice(0, 10)`, and toISOString() is UTC. Malaysia is UTC+8, so
 * between 00:00 and 08:00 local every movement was stamped with YESTERDAY's date — on the very item whose
 * subject is telling entry date and effective date apart (941c9dac, shipped r83).
 *
 * It survived three green gates because the suite only ever ran during the Malaysian working day, when
 * the UTC and local dates agree. It failed the moment a run happened at 01:46 local. A date derived from
 * an instant must go through the tenant timezone; only date-only ARITHMETIC (dayBefore above, and the
 * `${iso}T00:00:00Z` idiom elsewhere) may stay in UTC, because there the UTC-ness is the convention that
 * makes it exact rather than a bug.
 */
const dateOf = (d: Date): string => todayInKualaLumpur(d);

/**
 * Classify the ledger into movement rows. Returns the employment row, the raw events (for the detail's
 * grade replay) and the sorted rows. Sort ascending by (effective date, Hired-first, occurredAt,
 * sequence) — the kind priority guarantees the Hired row renders first even among same-day rows (the
 * hire's own reporting-line.set carries a LOWER sequence than employment.hired, so sequence alone
 * would misorder them).
 */
type MovementProjectionInput = {
  employment: Pick<typeof employment.$inferSelect, 'id' | 'hiredOn' | 'gradeId' | 'companyId' | 'terminatedOn'>;
  events: RawEvent[];
  compRemarks: Map<string, string | null>;
  catalogue: (typeof movementEventType.$inferSelect)[];
  actorNames: Map<string, string>;
};
async function projectRows(tx: Tx, tenantId: string, employmentId: string, today = todayInKualaLumpur(), input?: MovementProjectionInput) {
  const [emp] = input ? [input.employment] : await tx
    .select({
      id: employment.id,
      hiredOn: employment.hiredOn,
      gradeId: employment.gradeId,
      companyId: employment.companyId,
      terminatedOn: employment.terminatedOn,
    })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp) throw new Error('Employment not found');

  const events: RawEvent[] = input ? input.events : await tx
    .select({
      id: domainEvent.id,
      eventType: domainEvent.eventType,
      aggregateId: domainEvent.aggregateId,
      payload: domainEvent.payload,
      occurredAt: domainEvent.occurredAt,
      sequence: domainEvent.sequence,
      actorId: domainEvent.actorId,
    })
    .from(domainEvent)
    .where(
      and(
        eq(domainEvent.tenantId, tenantId),
        eq(domainEvent.subjectEmploymentId, employmentId),
        inArray(domainEvent.eventType, MOVEMENT_EVENT_TYPES),
      ),
    )
    .orderBy(asc(domainEvent.sequence));

  // Remarks for salary rows live on the compensation row (ADR-0030 redact-to-reference) — resolve them
  // at read time so an in-place correction (compensation.updated) never diverges from the history.
  const compIds = events.filter((e) => e.eventType === 'compensation.set').map((e) => e.aggregateId);
  const compRows = !input && compIds.length
    ? await tx
        .select({ id: compensation.id, remarks: compensation.remarks })
        .from(compensation)
        .where(inArray(compensation.id, compIds))
    : [];
  const compRemarks = input?.compRemarks ?? new Map(compRows.map((r) => [r.id, r.remarks]));

  /**
   * 476f23ed — the tenant's OWN event-type codes. The projection's rule (30325fc1) is that a generic
   * writer's event needs a movement tag naming a kind this system recognises; a code the organisation
   * configured is exactly that. Read here, once, rather than through core/movement-type.ts, because this
   * function runs inside the caller's transaction and must not open a second one.
   *
   * A tenant with no configured types gets an empty set and the built-in list, i.e. today's behaviour.
   */
  const catalogue = input?.catalogue ?? await tx.select().from(movementEventType).where(eq(movementEventType.tenantId, tenantId));
  const tenantCodes = new Set(catalogue.map(r=>r.code));
  // Keep recorded codes for identity/projection, and resolve behavior separately for correction.
  // Reuse this existing catalogue read; inactive/custom history must not cause per-row queries.
  const resolvedTypes=resolveMovementEventTypeRows(tenantId,[...MOVEMENT_KINDS,...tenantCodes],catalogue);
  /** A kind the tag may legitimately name: a built-in, or one of this tenant's configured codes. */
  const knownKind = (v: string | undefined): v is string => !!v && (isKnownKind(v) || tenantCodes.has(v));

  // Older comparison tags did not freeze their entered day. A flat/grade primary can recover it
  // only from a uniquely dated companion in its own immutable group, never an unrelated later move.
  const groupDates = new Map<string, Set<string>>();
  for (const event of events) {
    const tag = tagOf(event), payload = event.payload;
    if (!tag?.groupId || !payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const dateKey = event.eventType === 'compensation.set' ? 'effectiveFrom'
      : event.eventType === 'reporting-line.set' ? 'validFrom'
      : ['assignment.transferred', 'employment.assignment.changed', 'employment.company.transferred'].includes(event.eventType)
        ? 'effectiveDate' : null;
    if (!dateKey || (event.eventType === 'reporting-line.set' && 'lineType' in payload && payload.lineType === 'delegate')) continue;
    const date: unknown = Reflect.get(payload, dateKey);
    if (typeof date !== 'string' || !isCalendarDate(date)) continue;
    const dates = groupDates.get(tag.groupId) ?? new Set<string>();
    dates.add(date); groupDates.set(tag.groupId, dates);
  }
  const comparisonEffectiveDate = (tag: MovementTag | null, occurrence: string): string => {
    if (typeof tag?.effectiveDate === 'string' && isCalendarDate(tag.effectiveDate)) return tag.effectiveDate;
    const dates = tag?.groupId ? groupDates.get(tag.groupId) : null;
    // Conflicting/missing legacy evidence is unknown: retain its historical occurrence fallback.
    return dates?.size === 1 ? dates.values().next().value ?? occurrence : occurrence;
  };

  let sawHiredEvent = false;
  const rows: ProjectedRow[] = [];
  /** 66a63bd6 — movement id → the rollback that undid it. Applied after the loop: the reversal event is
   *  always later in the ledger than the movement it refers to. */
  const reversals = new Map<string, MovementReversal>();
  /** 10fcf6df — movement id → the actor of its rollback, resolved to a NAME after the loop (one query). */
  const reversalActorIds = new Map<string, string | null>();
  /** 941c9dac — scheduled movement id → when the sweep applied it. Same after-the-loop application as
   *  `reversals`: the applied event is always later in the ledger than the scheduled event it refers to. */
  const applications = new Map<string, Date>();
  for (const e of events) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (e.payload ?? {}) as Record<string, any>;
    const mv = (p.movement ?? null) as MovementTag | null;
    // A movement submitted from the comparison form writes several legs (assignment, grade, flat org
    // columns, reporting line, pay). Exactly ONE carries the primary tag; every companion is marked
    // `secondary` so the history renders ONE row per movement. Checked once here rather than per case —
    // the grade half of a Promotion was the only companion before 08913328, now any leg can be one.
    if (mv?.secondary) continue;
    const occDate = dateOf(e.occurredAt);
    const base = {
      id: e.id,
      sequence: e.sequence,
      occurredAt: e.occurredAt,
      groupId: mv?.groupId ?? null,
      reversed: null as MovementReversal | null,
      scheduled: false,
      appliedAt: null as Date | null,
      fields: [] as string[],
    };
    /**
     * 30325fc1 — "movement records auto-generated without HR admin action".
     *
     * Employment History is a projection, so a movement row is never CREATED — it is DECIDED here. Five of
     * the event types below come from GENERIC WRITERS that any screen may drive (assignment, grade, pay,
     * employment info, reporting line). Each of them used to fall back to an invented kind when the event
     * carried no movement tag: an assignment change became `orgAssignmentChange`, a grade edit became
     * `gradeChange`, a pay write became `salaryAdjustment`, a reporting-line write became
     * `reportingLineChange`, and an `employment.info.updated` was classified by which FIELD GROUP it
     * touched (confirmationDate ⇒ Confirmation, and so on). Nobody chose any of those types, and the
     * reporter was right that the resulting rows are not movements.
     *
     * THE RULE NOW: a generic writer's event projects a movement row only if it carries a movement TAG.
     * The tag records HR's INTENT and is written by `createMovementEvent` (and by the two screens r78
     * rerouted through it). Untagged events are NOT deleted, hidden or changed — they stay in the ledger
     * and stay on the admin Audit trail (/admin/audit, core/read.ts auditEvents); they simply stop being
     * reported as career movements.
     *
     * The event types that are NOT generic writers keep projecting unconditionally, because each one IS a
     * deliberate act with its own effective date and its own screen: `employment.hired`,
     * `employment.terminated`, `employment.blacklisted`, `employment.blacklist.cleared`,
     * `employment-review.decided` (the probation approval workflow), `assignment.transferred`
     * (transferEmployee, the sole writer, and inherently a Transfer) and the two movement-native events
     * `employment.movement.recorded` / `.scheduled`.
     *
     * This DEPENDS ON r78 and does not reverse it: r78 (4d391ab7) walked every writer emitting a projected
     * event type and tagged the HR-initiated ones. That work is what makes "tagged" a trustworthy proxy for
     * "HR created this". Nothing here untags anything.
     */
    switch (e.eventType) {
      case 'employment.hired':
        sawHiredEvent = true;
        rows.push({ ...base, kind: 'hired', effectiveDate: p.hiredOn ?? occDate, endDate: null, remarks: null });
        break;
      case 'assignment.transferred':
        rows.push({
          ...base,
          kind: 'transfer',
          effectiveDate: p.effectiveDate ?? occDate,
          endDate: mv?.endDate ?? null,
          remarks: mv?.remarks ?? null,
        });
        break;
      case 'employment.company.transfer.reverted':
        // b7b22514 — loaded for the as-of replay only. Like `employment.movement.reversed`, it projects no
        // row: one movement keeps one line in the history, with its rollback shown ON that line.
        break;
      case 'employment.company.transferred':
        // b7b22514 — the Entity Transfer. TAG REQUIRED even though this writer is not generic: it has
        // exactly one caller, which always tags, so the check costs nothing and keeps "the tag decides"
        // (30325fc1) true without an exception anyone has to remember.
        if (!knownKind(mv?.type)) break;
        rows.push({
          ...base,
          kind: mv.type,
          effectiveDate: p.effectiveDate ?? occDate,
          endDate: mv?.endDate ?? null,
          remarks: mv?.remarks ?? null,
        });
        break;
      case 'employment.assignment.changed':
        // 30325fc1 — GENERIC WRITER, TAG REQUIRED (see the block comment above the switch).
        if (!knownKind(mv?.type)) break;
        rows.push({
          ...base,
          // Any known movement kind may own the assignment leg (a Salary Adjustment that also moves
          // department is one submit on the comparison form).
          kind: mv.type,
          effectiveDate: p.effectiveDate ?? occDate,
          endDate: mv?.endDate ?? null,
          remarks: mv?.remarks ?? null,
        });
        break;
      case 'employment.grade.changed':
        // 30325fc1 — GENERIC WRITER, TAG REQUIRED. r78c deleted the last untagged grade writer
        // (setEmploymentGradeAction, the Leave tab's one-field Job Grade save), so nothing an admin can
        // do today reaches here without a tag.
        if (!knownKind(mv?.type)) break;
        rows.push({
          ...base,
          kind: mv.type,
          effectiveDate: comparisonEffectiveDate(mv, occDate),
          endDate: mv?.endDate ?? null,
          remarks: mv?.remarks ?? null,
        });
        break;
      case 'compensation.set':
        // Initial salary at hire is part of Hired, not a movement (suppresses the every-new-hire
        // "Salary Adjustment" noise; applies to import and seed too).
        if (p.effectiveFrom === emp.hiredOn) break;
        // 30325fc1 — GENERIC WRITER, TAG REQUIRED. The Basic Salary card routes through the movement
        // recorder (r78), so a real pay movement always carries a tag; an import or a background
        // repricing does not, and is no longer announced as a Salary Adjustment nobody keyed.
        if (!knownKind(mv?.type)) break;
        rows.push({
          ...base,
          // A pay change may be the primary leg of any movement (a Promotion whose only delta is salary).
          kind: mv.type,
          effectiveDate: p.effectiveFrom ?? occDate,
          endDate: null,
          remarks: compRemarks.get(e.aggregateId) ?? null,
        });
        break;
      case 'employment.info.updated': {
        // 30325fc1 — GENERIC WRITER, TAG REQUIRED, and this is the writer the reporter actually hit.
        // The Employment Dates card (setEmploymentInfoAction) saves confirmationDate / tenderResignationDate
        // / lastWorkingDate with no movement tag. The classification used to be INFERRED from the field
        // group — confirmationDate ⇒ Confirmation, EXTENDED_PROBATION_FIELDS ⇒ Probation Extension,
        // RESIGNATION_FIELDS ⇒ Resignation — so an ordinary date edit minted a movement of a type nobody
        // chose. The inference is gone: only the tag decides.
        const kind = knownKind(mv?.type) ? mv.type : null;
        if (!kind) break;
        const after = (p.after ?? {}) as Record<string, unknown>;
        // 89ea527b — for the two date movements the row's Effective Date is the date the movement SET, read
        // back off the event's own after-diff (not the column), so a later correction cannot rewrite the
        // history of the earlier one. Falls back to the occurrence date if the diff is missing.
        const effectiveDate =
          kind === 'confirmation'
            ? ((after.confirmationDate as string | null) ?? occDate)
            : kind === 'resignation'
              ? (mv?.effectiveDate ?? (after.tenderResignationDate as string | null) ?? occDate)
              : kind === 'joinDateChange'
                ? ((after.joinDate as string | null) ?? occDate)
                : kind === 'groupJoinDateCorrection'
                  ? ((after.hiredOn as string | null) ?? occDate)
                  : kind==='probationExtension'&&typeof mv?.effectiveDate==='string'&&isCalendarDate(mv.effectiveDate)
                    ? mv.effectiveDate
                    : comparisonEffectiveDate(mv, occDate);
        const endDate =
          kind === 'probationExtension'
            ? ((after.extendedConfirmationDate as string | null) ?? mv?.endDate ?? null)
            : kind === 'resignation'
              ? ((after.lastWorkingDate as string | null) ?? mv?.endDate ?? null)
              : (mv?.endDate ?? null);
        rows.push({ ...base, kind, effectiveDate, endDate, remarks: mv?.remarks ?? null });
        break;
      }
      case 'employment-review.decided':
        // The real approval workflow (which deliberately does not write back through setEmploymentInfo).
        if (p.decision === 'confirm') {
          rows.push({ ...base, kind: 'confirmation', effectiveDate: occDate, endDate: null, remarks: null });
        } else if (p.decision === 'extend') {
          rows.push({ ...base, kind: 'probationExtension', effectiveDate: occDate, endDate: null, remarks: null });
        }
        break;
      case 'employment.terminated':
        // An accepted employee resignation terminates via terminateEmploymentTx with type 'voluntary' —
        // shown as Resignation, never as a generic Termination.
        // 1d58019a Step 2 (ADR-0166) — a termination recorded under one of the organisation's OWN Termination
        // types carries that code on its tag, and the row is that type (so history reads "Retrenchment" and
        // the row resolves back to the termination behaviour for correction). The built-in rule above is
        // unchanged for the built-in code and for untagged terminations.
        rows.push({
          ...base,
          kind:
            mv?.type && mv.type !== 'termination' && !isKnownKind(mv.type) && tenantCodes.has(mv.type) &&
            resolvedTypes.get(mv.type)?.behaviourKind === 'termination'
              ? mv.type
              : p.terminationType === 'voluntary' ? 'resignation' : 'termination',
          effectiveDate: p.terminationDate ?? occDate,
          // ae9350f2 — the Last Working Day, off the movement tag. Legacy/untagged terminations (the
          // resignation-approval path, imports) carry none and keep the historical null.
          endDate: mv?.endDate ?? null,
          remarks: p.terminationReason ?? null,
        });
        break;
      case 'employment.blacklisted':
        rows.push({
          ...base,
          kind: 'blacklist',
          effectiveDate: (p.after?.blacklistedAt as string | null) ?? occDate,
          endDate: null,
          remarks: (p.after?.reason as string | null) ?? null,
        });
        break;
      case 'employment.blacklist.cleared':
        rows.push({ ...base, kind: 'blacklistCleared', effectiveDate: occDate, endDate: null, remarks: null });
        break;
      case 'reporting-line.set':
        // Delegations are approver cover, not employment movement — structural lines only.
        if (p.lineType === 'delegate') break;
        // 30325fc1 — GENERIC WRITER, TAG REQUIRED. Direct Superior stays editable outside Movement (r78's
        // deliberate exemption: the CLEAR path emits `reporting-line.ended`, which is not a movement event
        // type, so routing only the SET path through Movement would leave no way to clear a superior).
        // That writer is now TAGGED at source instead — setDirectSuperiorAction passes a
        // `reportingLineChange` tag — so the row it has always produced is unchanged, and it is now backed
        // by a recorded intent rather than by a fallback label.
        if (!knownKind(mv?.type)) break;
        rows.push({
          ...base,
          kind: mv.type,
          effectiveDate: p.validFrom ?? occDate,
          endDate: null,
          remarks: null,
        });
        break;
      case 'employment.movement.recorded':
        // Record-only movements (Secondment / Acting Position today). Unknown future kinds pass through
        // and render via the UI's humanized fallback label — the set is extensible without data repair.
        rows.push({
          ...base,
          kind: String(p.type ?? 'secondment'),
          effectiveDate: p.effectiveDate ?? occDate,
          endDate: p.endDate ?? null,
          remarks: p.remarks ?? null,
        });
        break;
      case 'employment.movement.scheduled':
        // 941c9dac — a future-dated movement. This event IS the history row from the moment it is keyed;
        // it changed no state. When the sweep later applies it, every leg it writes is tagged `secondary`
        // under THIS event's groupId, so the movement never grows a second row — only its status moves.
        rows.push({
          ...base,
          scheduled: true,
          kind: knownKind(p.type) ? p.type : 'orgAssignmentChange',
          effectiveDate: String(p.effectiveDate ?? occDate),
          endDate: (p.endDate as string | null) ?? null,
          remarks: (p.remarks as string | null) ?? null,
          fields: Array.isArray(p.fields) ? (p.fields as string[]) : [],
        });
        break;

      case 'employment.movement.applied':
        // 941c9dac — the sweep's record that a scheduled movement took effect. Like the reversal event it
        // projects NO row of its own; it flips the scheduled row's derived status to `applied`.
        applications.set(String(p.scheduledId), e.occurredAt);
        break;

      case HIRE_CORRECTED_EVENT:
        // c063eea9 — no row: the trace is attached to the Hired row by the callers that render it.
        break;

      case 'employment.movement.reversed':
        // 66a63bd6 — marks the referenced row as rolled back. Deliberately projects NO row of its own:
        // one movement, one line in the history, with its correction shown on it.
        reversals.set(String(p.movementId), {
          at: e.occurredAt,
          reason: (p.reason as string | null) ?? null,
          corrected: p.corrected === true,
          // bd89ccd8 — filled in after the loop, from the row this reversal refers to: only the projection
          // knows whether that row had applied by then.
          cancelled: false,
          // 10fcf6df — resolved to a name after the loop, in ONE query for every reversal on the page.
          by: null,
        });
        reversalActorIds.set(String(p.movementId), e.actorId);
        break;
    }
  }

  // Seed/legacy employments have no employment.hired event — synthesize the Hired row from the CURRENT
  // hiredOn (matches the Employment tab's Hire Date; joinDate is a different column and is NOT used).
  if (!sawHiredEvent) {
    rows.push({
      id: 'hired',
      kind: 'hired',
      effectiveDate: emp.hiredOn,
      endDate: null,
      remarks: null,
      sequence: -1,
      occurredAt: null,
      groupId: null,
      reversed: null,
      scheduled: false,
      appliedAt: null,
      fields: [],
    });
  }

  // 10fcf6df — resolve every rollback's actor to a display name in ONE query (per-employee volumes are
  // tiny, and a reversal is rare, so this is usually skipped entirely).
  const actorIds = [...new Set([...reversalActorIds.values()].filter((v): v is string => !!v))];
  if (actorIds.length) {
    const names = input ? [] : await tx
      .select({ id: appUser.id, name: person.fullName })
      .from(appUser)
      .innerJoin(person, eq(person.id, appUser.personId))
      .where(inArray(appUser.id, actorIds));
    const byId = input?.actorNames ?? new Map(names.map((n) => [n.id, n.name]));
    for (const [movementId, actorId] of reversalActorIds) {
      const rev = reversals.get(movementId);
      if (rev && actorId) rev.by = byId.get(actorId) ?? null;
    }
  }

  for (const r of rows) {
    r.reversed = reversals.get(r.id) ?? null;
    r.appliedAt = applications.get(r.id) ?? null;
    // bd89ccd8 — a movement that was scheduled and never applied was CANCELLED, not rolled back. Both
    // facts are on the row, so the distinction costs nothing and keeps the badge honest.
    if (r.reversed) r.reversed.cancelled = r.scheduled && !r.appliedAt;
  }

  rows.sort((a, b) => {
    if (a.effectiveDate !== b.effectiveDate) return a.effectiveDate < b.effectiveDate ? -1 : 1;
    const ap = a.kind === 'hired' ? 0 : 1;
    const bp = b.kind === 'hired' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const at = a.occurredAt?.getTime() ?? 0;
    const bt = b.occurredAt?.getTime() ?? 0;
    if (at !== bt) return at - bt;
    return a.sequence - b.sequence;
  });

  const superseded = supersededScheduledIds(rows, today);
  const statusOf = (r: ProjectedRow): MovementStatus => statusOfRow(r, superseded);
  return { emp, events, rows, statusOf, today, resolvedTypes };
}

/** Batched canonical lifecycle projection for an already-authorized report snapshot. All database
 * reads are outside the employment loop; projectRows consumes the same preloaded facts as History.
 * No correction affordances, current compensation or employee names are exposed by this seam. */
export async function movementReportFactsTx(tx: Tx, tenantId: string, employmentIds: readonly string[], asOfDates: readonly string[] = []) {
  const ids = [...new Set(employmentIds)];
  if (ids.length > 10000) throw new Error('Movement report scope exceeds 10000 employments.');
  if (!ids.length) return [];
  const employments = await tx.select({id: employment.id, hiredOn: employment.hiredOn,
    gradeId: employment.gradeId, companyId: employment.companyId, terminatedOn: employment.terminatedOn})
    .from(employment).where(and(eq(employment.tenantId, tenantId), inArray(employment.id, ids)));
  const events = await tx.select({id: domainEvent.id, eventType: domainEvent.eventType,
    aggregateId: domainEvent.aggregateId, payload: domainEvent.payload, occurredAt: domainEvent.occurredAt,
    sequence: domainEvent.sequence, actorId: domainEvent.actorId, employmentId: domainEvent.subjectEmploymentId})
    .from(domainEvent).where(and(eq(domainEvent.tenantId, tenantId),
      inArray(domainEvent.subjectEmploymentId, ids), inArray(domainEvent.eventType, MOVEMENT_EVENT_TYPES)))
    .orderBy(asc(domainEvent.sequence)).limit(20001);
  if (events.length > 20000) throw new Error('Movement report history exceeds 20000 events. Narrow the scope.');
  const compRows = await tx.select({id: compensation.id, employmentId: compensation.employmentId,
    basicSalary: compensation.basicSalary, validFrom: compensation.validFrom, validTo: compensation.validTo,
    supersededAt: compensation.supersededAt, remarks: compensation.remarks})
    .from(compensation).where(inArray(compensation.employmentId, ids)).orderBy(asc(compensation.validFrom),asc(compensation.id)).limit(20001);
  if(compRows.length>20000)throw new Error('Movement report salary history exceeds 20000 revisions. Narrow the scope.');
  const compById=new Map(compRows.map(row=>[row.id,row]));
  const compByEmployment=new Map<string,typeof compRows>();
  for(const row of compRows){const group=compByEmployment.get(row.employmentId)??[];group.push(row);compByEmployment.set(row.employmentId,group);}
  const compRemarks = new Map(compRows.map(r => [r.id, r.remarks]));
  const catalogue = await tx.select().from(movementEventType).where(eq(movementEventType.tenantId, tenantId));
  const byEmployment = new Map<string, RawEvent[]>();
  for (const event of events) {
    if (!event.employmentId) continue;
    const group = byEmployment.get(event.employmentId) ?? [];
    group.push(event); byEmployment.set(event.employmentId, group);
  }
  const today = todayInKualaLumpur();
  const facts = [];
  for (const emp of employments) {
    const projected = await projectRows(tx, tenantId, emp.id, today, {employment: emp,
      events: byEmployment.get(emp.id) ?? [], compRemarks, catalogue, actorNames: new Map()});
    const eventsByGroup = new Map<string, RawEvent[]>();
    for (const event of projected.events) {
      const key = tagOf(event)?.groupId ?? event.id;
      const group = eventsByGroup.get(key) ?? []; group.push(event); eventsByGroup.set(key, group);
    }
    const groupOf=(row:ProjectedRow)=>eventsByGroup.get(row.groupId??row.id)??[];
    const informationCorrections=projected.events.filter(event=>event.eventType==='employment.information.corrected');
    const gradeEvents=projected.events.filter(event=>event.eventType==='employment.grade.changed'||event.eventType==='employment.information.corrected').map(event=>event.eventType==='employment.information.corrected'?{...event,payload:{before:(event.payload as {before:{gradeId:string|null}}).before.gradeId,after:(event.payload as {after:{gradeId:string|null}}).after.gradeId}}:event);
    const gradeRows=projected.rows.filter(row=>groupOf(row).some(event=>event.eventType==='employment.grade.changed'));
    // Unattributed legacy writes and compensating grade legs have no independently recorded effective
    // date. Do not substitute today's grade for an unprovable historical context.
    const attributedGrades=new Set(gradeRows.flatMap(row=>groupOf(row).map(event=>event.id)));
    const gradeKnown=gradeEvents.every(event=>event.eventType==='employment.information.corrected'||attributedGrades.has(event.id));
    const gradeBaseline=gradeEvents.length?((gradeEvents[0].payload??{}) as {before?:string|null}).before??null:emp.gradeId;
    const hireCorrections=projected.events.filter(event=>event.eventType===HIRE_CORRECTED_EVENT).map(event=>event.payload);
    const salaryChanged=(row:ProjectedRow)=>groupOf(row).some(event=>{
      if(event.eventType!=='compensation.set')return false;
      const current=compById.get(liveIncarnationOf(event.aggregateId,hireCorrections));
      if(!current||current.supersededAt)return false;
      const previous=(compByEmployment.get(emp.id)??[]).filter(candidate=>!candidate.supersededAt&&candidate.validFrom<current.validFrom&&candidate.validTo===current.validFrom).at(-1);
      return !!previous&&previous.basicSalary!==current.basicSalary;
    });
    facts.push({employmentId: emp.id, hireDate:emp.hiredOn,
      placements:[...new Set(asOfDates)].map(date=>{
        let gradeId=gradeBaseline;
        const datedGrades=gradeRows.filter(row=>projected.statusOf(row)==='applied').flatMap(row=>groupOf(row).filter(event=>event.eventType==='employment.grade.changed').map(event=>({date:row.effectiveDate,sequence:event.sequence,gradeId:((event.payload??{}) as {after?:string|null}).after??null})));
        for(const event of informationCorrections){const payload=event.payload as {effectiveOn:string;after:{gradeId:string|null}};datedGrades.push({date:payload.effectiveOn,sequence:event.sequence,gradeId:payload.after.gradeId});}
        for(const revision of datedGrades.sort((a,b)=>a.date.localeCompare(b.date)||a.sequence-b.sequence))if(revision.date<=date)gradeId=revision.gradeId;
        return {date,gradeId:gradeKnown?gradeId:null,gradeKnown};
      }),rows: projected.rows.map(row => ({
      id: row.id, kind: row.kind, behaviourKind: projected.resolvedTypes.get(row.kind)?.behaviourKind ?? row.kind,
      effectiveDate: row.effectiveDate, endDate: row.endDate, sequence: row.sequence,
      status: projected.statusOf(row), remarks: row.remarks, salaryChanged:salaryChanged(row),
      // References carry no salary values; consumers can resolve dated compensation through its owner.
      events: (eventsByGroup.get(row.groupId ?? row.id) ?? []).map(event => ({
        id: event.id, eventType: event.eventType, aggregateId: event.aggregateId,
        sequence: event.sequence, payload: event.payload,
      })),
    }))});
  }
  return facts;
}

/** The ledger events one movement is made of: every leg of a comparison-form submit (they share a
 *  groupId), or the single event a legacy / one-leg movement projects. Empty for the synthesized Hired row. */
const groupEventsOf = (events: RawEvent[], row: ProjectedRow): RawEvent[] =>
  row.groupId ? events.filter((e) => tagOf(e)?.groupId === row.groupId) : events.filter((e) => e.id === row.id);

/**
 * 66a63bd6 — the ledger events a correction knows how to undo. Everything else that can appear on the
 * history (the hire itself, a termination, a blacklist, an approved probation review) has its own
 * lifecycle flow with its own gates and downstream effects; rolling those back from here would be a
 * second, weaker copy of them.
 */
const REVERSIBLE_EVENT_TYPES = new Set([
  // b7b22514 — the Entity Transfer's company leg. reverseLegTx knows how to undo it (put the company back,
  // under the same last-write-wins rule the flat columns get), so it belongs here — and MUST: this set is
  // an allowlist, and an unlisted leg makes the WHOLE movement uncorrectable. A company move with no way
  // to roll it back would be the one comparison movement HR could not take back.
  'employment.company.transferred',
  'assignment.transferred',
  'employment.assignment.changed',
  'employment.grade.changed',
  'compensation.set',
  'employment.info.updated',
  'reporting-line.set',
  'employment.movement.recorded',
  // 941c9dac — the scheduling event itself is always "undoable" because it changed nothing. Listing it
  // here is what makes a PENDING movement cancellable (its group is this event alone) and keeps an
  // APPLIED scheduled movement correctable (its group is this event PLUS the legs the sweep wrote, and
  // every one of those was already reversible).
  'employment.movement.scheduled',
  // 646355e5 — an APPLIED termination is correctable too (approved plan). Its inverse is
  // reverseTerminationTx, which restores exactly the columns, assignment version and reporting lines the
  // forward write changed, and refuses when the termination date has since been changed elsewhere.
  'employment.terminated',
]);

/**
 * Legs that changed employment/pay STATE — as opposed to the record-only Secondment / Acting Position,
 * which touch nothing and therefore need neither the payroll guard nor the in-place-edit rule.
 *
 * 941c9dac — `employment.movement.scheduled` is excluded for exactly the same reason, and that exclusion
 * is what resolves the in-place-edit interaction (see editMovementEvent). Because a scheduled event is
 * not state-changing, a PENDING movement contributes nothing to latestStateChangingSpanEnd — so keying a
 * future-dated movement does NOT freeze editing of the movement that is genuinely latest in force today.
 */
const STATE_CHANGING_EVENT_TYPES = new Set(
  [...REVERSIBLE_EVENT_TYPES].filter(
    (t) => t !== 'employment.movement.recorded' && t !== 'employment.movement.scheduled',
  ),
);

/**
 * 3ced1040 — the LIFECYCLE dates an `employment.info.updated` leg may carry and still be undone from
 * Employment History. Only the confirmation pair, and only because Confirmation is now a comparison kind:
 * a Confirmation that could not be rolled back would be the ONE comparison movement with no way to
 * correct a mistake, which is the opposite of what "behave like Promotion" asked for.
 *
 * `finalConfirmationDate` is here because setEmploymentInfo DERIVES it on the same save and so lists it in
 * the event's own `fields`; it is never restored directly — putting the confirmation date back re-derives
 * it, which is also what keeps it consistent with an extended probation date this movement never touched.
 *
 * Resignation has its own scoped reversible family below. Probation extension and the two
 * join dates are moved by kinds that are NOT comparison kinds, they derive from one another, and each is
 * maintained on its own screen with its own gates.
 */
const REVERSIBLE_INFO_DATE_FIELDS: readonly string[] = ['confirmationDate', 'finalConfirmationDate'];

/**
 * b7b22514 — dates that are reversible ONLY on the movement kind that owns them.
 *
 * The current-company Join Date rides on the Entity Transfer's info leg beside the flat columns, and
 * reverseLegTx restores it there — so without it allowed, `infoLegIsFlatOnly` sees a date it does not
 * recognise and quietly makes every Entity Transfer uncorrectable. That is this list's failure mode: not
 * an error, an absent button.
 *
 * BUT IT MUST NOT BE ALLOWED KIND-BLIND. `joinDate` is also what the EXISTING `joinDateChange` movement
 * writes (case 'joinDateChange' calls the same setEmploymentInfo, producing the same
 * `employment.info.updated` with `joinDate` in its fields). Naming it unconditionally above therefore
 * made a movement this item never touched roll-back-able for the first time — precisely what the comment
 * on REVERSIBLE_INFO_DATE_FIELDS says is deliberately out of scope: "the two join dates are moved by
 * kinds that are NOT comparison kinds ... each is maintained on its own screen with its own gates."
 * Widening a correction gate is not a side effect an Entity Transfer gets to have.
 */
const KIND_SCOPED_INFO_DATE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  resignation: ['tenderResignationDate','resignationDate','lastWorkingDate'],
  entityTransfer: ['joinDate'],
  // 646355e5 — the exit-dates leg applyTerminationTx writes beside the termination itself.
  termination: ['lastWorkingDate','tenderResignationDate'],
};

/** A flat-column leg is undone field by field, and since 3ced1040 so is the confirmation date a
 *  Confirmation movement writes alongside it. Any OTHER lifecycle date on the leg puts the whole movement
 *  out of correction's reach (see REVERSIBLE_INFO_DATE_FIELDS) — unless this movement's own kind claims
 *  it (see KIND_SCOPED_INFO_DATE_FIELDS). */
function infoLegIsFlatOnly(e: RawEvent, kind: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fields: string[] = Array.isArray((e.payload as any)?.fields) ? (e.payload as any).fields : [];
  const kindScoped = KIND_SCOPED_INFO_DATE_FIELDS[kind] ?? [];
  return fields.every(
    (f) =>
      (MOVEMENT_FLAT_FIELDS as readonly string[]).includes(f) ||
      REVERSIBLE_INFO_DATE_FIELDS.includes(f) ||
      kindScoped.includes(f),
  );
}

/** Presentation of a voluntary exit does not change the writer that owns its inverse. */
function recordedMovementKind(row: ProjectedRow, group: RawEvent[]): string {
  return row.kind === 'resignation' && group.some(event => event.eventType === 'employment.terminated')
    ? 'termination' : row.kind;
}

type Correctability = { canReverse: boolean; canEdit: boolean; stateChanging: boolean };

/** Whether this movement can be rolled back, and whether it can be corrected in place. `isLatest` is the
 *  in-place rule: an edit replays through the SAME writers, and those act on the OPEN dated row, so a
 *  state-changing movement can only be corrected while it is still the most recent one. */
function correctabilityOf(row: ProjectedRow, group: RawEvent[], isLatest: boolean, behaviour:string|null): Correctability {
  const stateChanging = group.some((e) => STATE_CHANGING_EVENT_TYPES.has(e.eventType));
  if (!group.length || !behaviour) return { canReverse: false, canEdit: false, stateChanging };
  // 1d58019a Step 2 (ADR-0166) — a Termination row must BE a termination in the ledger: its own
  // employment.terminated leg, or the scheduled intent. Since a tenant's own type may carry the Termination
  // behaviour, a type re-pointed around the service after use (the service locks a used type's behaviour)
  // would otherwise make, say, a recorded Secondment correctable as an exit. Such a row stays visible and
  // gets no correction authority, exactly as an unresolvable behaviour gets none.
  if (behaviour === 'termination' && !group.some((e) => e.eventType === 'employment.terminated' || e.eventType === 'employment.movement.scheduled')) {
    return { canReverse: false, canEdit: false, stateChanging };
  }
  const supported = group.every(
    (e) =>
      REVERSIBLE_EVENT_TYPES.has(e.eventType) &&
      (e.eventType !== 'employment.info.updated' || infoLegIsFlatOnly(e, behaviour)),
  );
  const canReverse = supported && !row.reversed;
  const canEdit = canReverse && (!stateChanging || ((isComparisonKind(behaviour) || behaviour==='resignation' || behaviour==='termination') && isLatest));
  return { canReverse, canEdit, stateChanging };
}

/** The end of the sequence span of the LAST non-reversed, state-changing movement — the only one an edit
 *  may replay in place. -1 when there is none. */
function latestStateChangingSpanEnd(events: RawEvent[], rows: ProjectedRow[]): number {
  let end = -1;
  for (const r of rows) {
    const g = groupEventsOf(events, r);
    if (r.reversed || !g.some((e) => STATE_CHANGING_EVENT_TYPES.has(e.eventType))) continue;
    end = Math.max(end, ...g.map((e) => e.sequence));
  }
  return end;
}

/**
 * r78c — the value of a flat (non-effective-dated) `employment` column as of an event, replayed from the
 * `employment.info.updated` before/after diffs. Same shape and same reasoning as gradeIdAtSequence: the
 * column itself holds only TODAY's value, so an as-of read has to come from the ledger. Events that did
 * not write this field are skipped, so an unrelated Employment Dates save never disturbs the replay.
 * Falls back to the earliest recorded `before`, then to the current column (an employment whose division
 * was never edited has held the same value throughout).
 */
function flatValueAtSequence(
  infoEvents: RawEvent[],
  field: MovementFlatField,
  bound: number,
  currentValue: string | null,
): string | null {
  let v: string | null | undefined;
  let firstBefore: string | null | undefined;
  for (const e of infoEvents) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (e.payload ?? {}) as Record<string, any>;
    const fields: string[] = Array.isArray(p.fields) ? p.fields : [];
    if (!fields.includes(field)) continue;
    if (firstBefore === undefined) firstBefore = ((p.before ?? {})[field] as string | null) ?? null;
    if (e.sequence <= bound) v = ((p.after ?? {})[field] as string | null) ?? null;
  }
  if (v !== undefined) return v;
  if (firstBefore !== undefined) return firstBefore;
  return currentValue;
}

/**
 * b7b22514 — the legal entity in force just before/at an event, replayed from
 * `employment.company.transferred` the way `gradeIdAtSequence` replays job grade and for the identical
 * reason: `employment.company_id` is a FLAT column with no dated history, so as-of reconstruction can only
 * come from the ledger.
 *
 * BEFORE THIS, EVERY HISTORY ROW SHOWED TODAY'S COMPANY. That was true while nothing could change it —
 * placementColumnsTx said so in as many words. The moment a company can move, a live read makes the whole
 * Company column a lie in the one case it finally matters: an employee who transferred in March would show
 * the NEW entity against their 2019 promotion, and the transfer row itself would show the same name on both
 * sides of a grid whose entire purpose is to name the two.
 *
 * `bound` is the row's sequence; `inclusive` includes the bound event itself (the After side). An
 * employment that never transferred has no events here and falls through to the current id — byte-identical
 * to the old behaviour for every existing record.
 */
const isCompanyReplayEvent = (e: RawEvent): boolean =>
  e.eventType === 'employment.information.corrected' ||
  e.eventType === 'employment.company.transferred' ||
  e.eventType === 'employment.company.transfer.reverted';

function companyIdAtSequence(
  companyEvents: RawEvent[],
  bound: number,
  inclusive: boolean,
  currentCompanyId: string,
): string {
  let c: string | undefined;
  for (const e of companyEvents) {
    if (inclusive ? e.sequence <= bound : e.sequence < bound) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c = (((e.payload ?? {}) as any).after?.companyId as string | undefined) ?? c;
    }
  }
  if (c !== undefined) return c;
  // Before the FIRST transfer the employee was in that transfer's `before` company — the same
  // walk-back-off-the-earliest-event rule the grade replay uses.
  const first = companyEvents[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const beforeId = first ? (((first.payload ?? {}) as any).before?.companyId as string | undefined) : undefined;
  return beforeId ?? currentCompanyId;
}

/** Legal-entity id → name, for every company this employment has ever been in (one query, not one per row). */
async function companyNamesTx(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await tx
    .select({ id: company.id, name: company.legalName })
    .from(company)
    .where(inArray(company.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The company ids an employment has ever held: today's, plus both sides of every transfer it recorded. */
function companyIdsInPlay(companyEvents: RawEvent[], currentCompanyId: string): string[] {
  const ids = [currentCompanyId];
  for (const e of companyEvents) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (e.payload ?? {}) as any;
    if (p.before?.companyId) ids.push(p.before.companyId as string);
    if (p.after?.companyId) ids.push(p.after.companyId as string);
  }
  return ids;
}

/**
 * r78c — the placement columns every history row shows (Company, Division, Department, Job Title, Basic),
 * loaded ONCE for the whole employment and resolved per row in memory. Deliberately not per-row queries:
 * the history is rendered whole, and one round trip per row per column is how a timeline screen becomes a
 * slow one.
 *
 * b7b22514 — COMPANY IS NOW REPLAYED, not read live. It used to be the one column with no dated history
 * ("an employment holds one company_id"), so every row showed the current legal name. Entity Transfer makes
 * that false: the column is still flat, but the ledger now records its moves, so it is reconstructed from
 * the events exactly as `division` already is (companyIdAtSequence). Employments that never transferred are
 * unaffected — no events, so the replay returns the current id.
 */
async function placementColumnsTx(tx: Tx, employmentId: string, companyId: string, events: RawEvent[]) {
  const companyEvents = events.filter(isCompanyReplayEvent);
  const companyNames = await companyNamesTx(tx, companyIdsInPlay(companyEvents, companyId));

  const asgRows = await tx
    .select({
      validFrom: assignment.validFrom,
      validTo: assignment.validTo,
      department: department.name,
      position: position.title,
    })
    .from(assignment)
    .leftJoin(department, eq(department.id, assignment.departmentId))
    .leftJoin(position, eq(position.id, assignment.positionId))
    .where(and(eq(assignment.employmentId, employmentId), isNull(assignment.supersededAt)))
    .orderBy(asc(assignment.validFrom));

  const compRows = await tx
    .select({
      validFrom: compensation.validFrom,
      validTo: compensation.validTo,
      basicSalary: compensation.basicSalary,
      currency: compensation.currency,
    })
    .from(compensation)
    .where(and(eq(compensation.employmentId, employmentId), isNull(compensation.supersededAt)))
    .orderBy(asc(compensation.validFrom));

  const [empRow] = await tx
    .select({ orgDivision: employment.orgDivision, orgSection: employment.orgSection })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);

  const infoEvents = events.filter((e) => e.eventType === 'employment.info.updated');

  return (asOf: string, seqBound: number) => {
    const asg = asgRows.filter((a) => a.validFrom <= asOf && (a.validTo == null || a.validTo > asOf)).pop() ?? null;
    const comp = compRows.filter((c) => c.validFrom <= asOf && (c.validTo == null || c.validTo > asOf)).pop() ?? null;
    return {
      company: companyNames.get(companyIdAtSequence(companyEvents, seqBound, true, companyId)) ?? null,
      division: flatValueAtSequence(infoEvents, 'orgDivision', seqBound, empRow?.orgDivision ?? null),
      // e6a144d4 — the same flat-column replay as `division` one line up; `orgSection` is already in
      // MOVEMENT_FLAT_FIELDS, so a movement that moved Section has the before/after in its own event.
      section: flatValueAtSequence(infoEvents, 'orgSection', seqBound, empRow?.orgSection ?? null),
      department: asg?.department ?? null,
      jobTitle: asg?.position ?? null,
      basic: comp ? `${comp.currency} ${comp.basicSalary}` : null,
      // e6a144d4 — the two halves of `basic`, unjoined. See MovementHistoryRow: the export needs the
      // amount bare or the spreadsheet cell is text.
      currency: comp?.currency ?? null,
      basicAmount: comp?.basicSalary ?? null,
    };
  };
}

/** Minimal promotion fact for authorized workflow consumers. Uses the same reversal,
 * scheduling and custom-event classification as Employment History; never returns pay. */
export async function lastAppliedPromotionOnTx(tx: Tx, tenantId: string, employmentId: string): Promise<{known:boolean;date:string|null}> {
  const [access] = await tx.execute<{allowed:boolean}>(sql`select app.can_see_employment(${employmentId}::uuid) as allowed`);
  if (!access?.allowed) return {known:false,date:null};
  const {rows,statusOf} = await projectRows(tx,tenantId,employmentId);
  const custom = await tx.select({code:movementEventType.code}).from(movementEventType)
    .where(and(eq(movementEventType.tenantId,tenantId),eq(movementEventType.behaviourKind,'promotion')));
  const kinds = new Set(['promotion',...custom.map(r=>r.code)]);
  const dates = rows.filter(r=>kinds.has(r.kind)&&statusOf(r)==='applied').map(r=>r.effectiveDate).sort();
  return {known:true,date:dates.at(-1)??null};
}

/** Minimal canonical facts for a real, tenant-bound maintenance worker. A scheduled
 * intent remains pending even after its date arrives if application failed. Advisory
 * review decisions are not effective employment changes and cannot trigger letters. */
export type MovementAutomationFact={
 movementId:string;kind:'confirmation'|'promotion';effectiveDate:string;status:MovementStatus;
 sourceEventId:string|null;sourceSequence:number|null;
};
export async function movementAutomationFactsTx(tx:Tx,input:{tenantId:string;companyId:string;employmentId:string;today?:string}):Promise<MovementAutomationFact[]>{
 const [authority]=await tx.execute<{ok:boolean}>(sql`select app.current_tenant_id()=${input.tenantId}::uuid and app.current_user_id() is null and app.access_workforce_storage_owner() as ok`);
 if(authority?.ok!==true)throw Error('Movement automation facts require a tenant-bound maintenance connection.');
 if(input.today&&!isCalendarDate(input.today))throw Error('Invalid movement automation date.');
 const [subject]=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.id,input.employmentId),eq(employment.tenantId,input.tenantId),eq(employment.companyId,input.companyId)));
 if(!subject)return [];
 const {rows,events,statusOf,resolvedTypes}=await projectRows(tx,input.tenantId,input.employmentId,input.today);
 const eventById=new Map(events.map(event=>[event.id,event])),applications=new Map<string,RawEvent>();
 for(const event of events){if(event.eventType!=='employment.movement.applied'||!event.payload||typeof event.payload!=='object'||Array.isArray(event.payload))continue;const scheduledId=Reflect.get(event.payload,'scheduledId');if(typeof scheduledId==='string')applications.set(scheduledId,event);}
 return rows.flatMap(row=>{
  const kind=resolvedTypes.get(row.kind)?.behaviourKind,recorded=eventById.get(row.id);
  if((kind!=='confirmation'&&kind!=='promotion')||!recorded||recorded.eventType==='employment-review.decided')return [];
  const source=row.scheduled?applications.get(row.id):recorded;
  return [{movementId:row.id,kind,effectiveDate:row.effectiveDate,status:statusOf(row),sourceEventId:source?.id??null,sourceSequence:source?.sequence??null}];
 });
}

/** The Employment History list — a Hired-first, date-ascending projection over the event ledger. */
export function movementHistory(ctx: SessionContext, employmentId: string): Promise<MovementHistoryRow[]> {
  return withTenant(ctx, tx => movementHistoryTx(tx, ctx, employmentId));
}

/** Explicit owner read seam for a caller-held scoped report snapshot. */
export async function movementHistoryTx(tx: Tx, ctx: SessionContext, employmentId: string): Promise<MovementHistoryRow[]> {
    const { emp, events, rows, statusOf, resolvedTypes } = await projectRows(tx, ctx.tenantId, employmentId);
    // 66a63bd6 — the two payroll period sets come from core/comp.ts, so the per-row affordance runs the
    // SAME rule the service refuses on (the Basic Salary card's precedent).
    const closed = await closedPeriodsTx(tx, employmentId);
    const processed = await processedPeriodsTx(tx, employmentId);
    const placementAt = await placementColumnsTx(tx, employmentId, emp.companyId, events);
    // c063eea9 — one trace, resolved once, worn by the Hired row only.
    const hireTrace = await hireCorrectionTraceTx(
      tx,
      events.filter((e) => e.eventType === HIRE_CORRECTED_EVENT),
    );
    const eventsById = new Map(events.map(event => [event.id, event]));
    return rows.map((r) => {
      const primaryEvent = eventsById.get(r.id);
      const g = groupEventsOf(events, r);
      const spanEnd = g.length ? Math.max(...g.map((e) => e.sequence)) : -1;
      const status = statusOf(r);
      // 646355e5 — older events are editable too: the correction steps back over the later movements and
      // replays them (editMovementEvent). The service names any later event that blocks the replay.
      const c = correctabilityOf(r, g, true, resolvedTypes.get(recordedMovementKind(r, g))?.behaviourKind??null);
      // 941c9dac — a SUPERSEDED movement is terminal: it never applied and never will, so there is
      // nothing to cancel and nothing to replay. Editing one would also be a trap — the values HR typed
      // are precisely the ones another movement has already overridden.
      const terminal = status === 'superseded';
      // The window a correction disturbs runs from the effective date forward: undoing a raise changes
      // every period after it, not just the one it started in.
      const exitDates=r.kind==='resignation'?resignationFinancialDates(g):[];
      const financial=c.stateChanging&&(r.kind!=='resignation'||exitDates.length>0);
      const payrollFrom=[r.effectiveDate,...exitDates].sort()[0];
      const closedPeriods = financial ? closed.filter((period) => overlapsClosedPeriod([period], payrollFrom, null)).sort() : [];
      const locked = closedPeriods.length > 0;
      return {
        id: r.id,
        kind: r.kind,
        effectiveDate: r.effectiveDate,
        entryDate: r.occurredAt ? dateOf(r.occurredAt) : null,
        status,
        endDate: r.endDate,
        remarks: r.remarks,
        reversed: r.reversed,
        correctionKind:recordedMovementKind(r,g),
        canEdit: c.canEdit && !terminal,
        canReverse: c.canReverse && !terminal,
        payrollLocked: locked,
        payrollClosedPeriods: closedPeriods,
        payrollWarning: financial && !locked && overlapsClosedPeriod(processed, payrollFrom, null),
        // The flat-column replay bounds on the WHOLE group's last sequence, exactly as the detail view's
        // After column does — the leg that wrote Division can carry a higher sequence than the leg that
        // owns the row, and bounding on the row's own event alone would show the pre-movement value.
        ...placementAt(r.effectiveDate, spanEnd === -1 ? r.sequence : spanEnd),
        hireCorrection: r.kind === 'hired' ? hireTrace : null,
        recordedExit: primaryEvent ? movementRecordedExitOf(primaryEvent, (code) => resolvedTypes.get(code)?.behaviourKind) : null,
        recordedResignation:primaryEvent?movementRecordedResignationOf(primaryEvent):null,
      };
    });
  }

/** The grade in force just before/at an event, replayed from employment.grade.changed events (gradeId is
 *  a flat column, so as-of reconstruction must come from the ledger). `bound` is the row's sequence;
 *  `inclusive` includes the bound event itself (the After side). */
function gradeIdAtSequence(
  gradeEvents: RawEvent[],
  bound: number,
  inclusive: boolean,
  currentGradeId: string | null,
): string | null {
  let g: string | null | undefined;
  for (const e of gradeEvents) {
    if (inclusive ? e.sequence <= bound : e.sequence < bound) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      g = ((e.payload ?? {}) as any).after ?? null;
    }
  }
  if (g !== undefined) return g;
  const first = gradeEvents[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return first ? (((first.payload ?? {}) as any).before ?? null) : currentGradeId;
}

/** Reconstruct the employee's state as of `asOf` (assignment version, reporting line, compensation) with
 *  every id resolved to its CURRENT label — no stored snapshots, so renames never stale the view. */
async function snapshotAt(
  tx: Tx,
  emp: { id: string; gradeId: string | null; companyId: string },
  asOf: string,
  gradeEvents: RawEvent[],
  seqBound: number,
  inclusive: boolean,
  /**
   * b7b22514 — the employment's `employment.company.transferred` events. Threaded in exactly as
   * `gradeEvents` is, and for the same reason: `company_id` is flat, so the Before column can only know
   * which entity the employee was in by replaying the ledger. THIS IS WHAT MAKES AN ENTITY TRANSFER'S ROW
   * NAME BOTH COMPANIES — without it the grid reads the live column twice and shows the destination on both
   * sides, which is a Before/After view of a company move that omits the company move.
   */
  companyEvents: RawEvent[] = [],
): Promise<MovementSnapshot> {
  const companyNames = await companyNamesTx(tx, companyIdsInPlay(companyEvents, emp.companyId));
  const companyName =
    companyNames.get(companyIdAtSequence(companyEvents, seqBound, inclusive, emp.companyId)) ?? null;

  const asgRows = await tx
    .select({
      validFrom: assignment.validFrom,
      validTo: assignment.validTo,
      employmentType: assignment.employmentType,
      department: department.name,
      position: position.title,
      businessUnit: businessUnit.name,
    })
    .from(assignment)
    .leftJoin(department, eq(department.id, assignment.departmentId))
    .leftJoin(position, eq(position.id, assignment.positionId))
    .leftJoin(businessUnit, eq(businessUnit.id, assignment.businessUnitId))
    .where(and(eq(assignment.employmentId, emp.id), isNull(assignment.supersededAt)))
    .orderBy(asc(assignment.validFrom));
  const asg =
    asgRows.filter((a) => a.validFrom <= asOf && (a.validTo == null || a.validTo > asOf)).pop() ?? null;

  const rlRows = await tx
    .select({
      validFrom: reportingLine.validFrom,
      validTo: reportingLine.validTo,
      managerEmploymentId: reportingLine.managerEmploymentId,
    })
    .from(reportingLine)
    .where(
      and(
        eq(reportingLine.subordinateEmploymentId, emp.id),
        eq(reportingLine.lineType, 'administrative'),
        isNull(reportingLine.supersededAt),
      ),
    )
    .orderBy(asc(reportingLine.validFrom));
  const rl = rlRows.filter((r) => r.validFrom <= asOf && (r.validTo == null || r.validTo > asOf)).pop() ?? null;
  let managerName: string | null = null;
  if (rl) {
    const [m] = await tx
      .select({ name: person.fullName })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(employment.id, rl.managerEmploymentId))
      .limit(1);
    managerName = m?.name ?? null;
  }

  const compAll = await tx
    .select({
      validFrom: compensation.validFrom,
      validTo: compensation.validTo,
      basicSalary: compensation.basicSalary,
      currency: compensation.currency,
    })
    .from(compensation)
    .where(and(eq(compensation.employmentId, emp.id), isNull(compensation.supersededAt)))
    .orderBy(asc(compensation.validFrom));
  const comp = compAll.filter((c) => c.validFrom <= asOf && (c.validTo == null || c.validTo > asOf)).pop() ?? null;

  const gradeId = gradeIdAtSequence(gradeEvents, seqBound, inclusive, emp.gradeId);
  let gradeName: string | null = null;
  if (gradeId) {
    const [g] = await tx.select({ name: jobGrade.name }).from(jobGrade).where(eq(jobGrade.id, gradeId)).limit(1);
    gradeName = g?.name ?? null;
  }

  return {
    company: companyName,
    businessUnit: asg?.businessUnit ?? null,
    department: asg?.department ?? null,
    position: asg?.position ?? null,
    grade: gradeName,
    employmentType: asg?.employmentType ?? null,
    manager: managerName,
    salary: comp ? `${comp.currency} ${comp.basicSalary}` : null,
    salaryAmount: comp?.basicSalary ?? null,
    currency: comp?.currency ?? null,
  };
}

/** Resolve only explicitly saved comparison targets under the caller's existing tenant/RLS.
 * No dispatcher, rehearsal, current-state substitution or write is involved in viewing intent. */
async function pendingIntentTx(tx: Tx, tenantId: string, event: RawEvent): Promise<MovementPendingIntent | null> {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || !('input' in payload)) return null;
  const input = payload.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const values: MovementPendingIntent['values'] = [];
  const reference = async (key: string, field: MovementIntentField, read: (id: string) => Promise<string | null>) => {
    if (!(key in input)) return;
    const id = Reflect.get(input, key);
    if (id === null) values.push({field, value: null});
    else if (typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      values.push({field, value: await read(id)});
    }
  };
  await reference('companyId', 'company', async id => {
    const [row] = await tx.select({name: company.legalName}).from(company).where(and(eq(company.tenantId, tenantId), eq(company.id, id))).limit(1);
    return row?.name ?? null;
  });
  await reference('businessUnitId', 'businessUnit', async id => {
    const [row] = await tx.select({name: businessUnit.name}).from(businessUnit).where(and(eq(businessUnit.tenantId, tenantId), eq(businessUnit.id, id))).limit(1);
    return row?.name ?? null;
  });
  await reference('departmentId', 'department', async id => {
    const [row] = await tx.select({name: department.name}).from(department).where(and(eq(department.tenantId, tenantId), eq(department.id, id))).limit(1);
    return row?.name ?? null;
  });
  await reference('positionId', 'position', async id => {
    const [row] = await tx.select({name: position.title}).from(position).where(and(eq(position.tenantId, tenantId), eq(position.id, id))).limit(1);
    return row?.name ?? null;
  });
  await reference('locationId', 'location', async id => {
    const [row] = await tx.select({name: location.name}).from(location).where(and(eq(location.tenantId, tenantId), eq(location.id, id))).limit(1);
    return row?.name ?? null;
  });
  await reference('gradeId', 'grade', async id => {
    const [row] = await tx.select({name: jobGrade.name}).from(jobGrade).where(and(eq(jobGrade.tenantId, tenantId), eq(jobGrade.id, id))).limit(1);
    return row?.name ?? null;
  });
  await reference('managerEmploymentId', 'manager', async id => {
    const [row] = await tx.select({name: person.fullName}).from(employment).innerJoin(person, eq(person.id, employment.personId))
      .where(and(eq(employment.tenantId, tenantId), eq(person.tenantId, tenantId), eq(employment.id, id))).limit(1);
    return row?.name ?? null;
  });
  for (const field of ['tenderResignationDate','resignationEffectiveDate','employmentType', 'basicSalary', 'currency', 'payMode', 'paymentTerm', ...MOVEMENT_FLAT_FIELDS] as const) {
    if (!(field in input)) continue; // Omitted is not a clear and not today's value.
    const value: unknown = Reflect.get(input, field);
    if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      values.push({field, value: value === null ? null : String(value)});
    }
  }
  return values.length ? {values} : null;
}

/**
 * Detail view for one history row: event information plus a side-by-side Before/After comparison built
 * by as-of reconstruction at the effective date. Hired renders After only (before = null → the UI shows
 * a "first record" placeholder). Returns null when the id matches no row for this employment.
 */
export function movementDetail(
  ctx: SessionContext,
  employmentId: string,
  movementId: string,
): Promise<MovementDetail | null> {
  return withTenant(ctx, tx => movementDetailTx(tx, ctx, employmentId, movementId));
}

/**
 * 1d58019a Step 2 (ADR-0166) — the supporting documents of one movement, for its detail view.
 *
 * WHO MAY READ THEM is Employment History's own audience, checked three ways: the caller is an admin (the
 * history is an admin screen), holds workforce view of this employee (the same scope check every workforce
 * read uses), and the movement is one this employee's projected history shows. The table's read policy adds
 * the pay rule: a document filed against Basic Salary, Currency, Pay Mode or Payment Term is returned only to
 * a caller who could read the salary itself (the compensation read predicate). Never throws for "not
 * yours": an unknown or invisible movement simply has no documents.
 */
export async function movementAttachments(
  ctx: SessionContext,
  employmentId: string,
  movementId: string,
): Promise<MovementAttachmentSummary[]> {
  assertMovementAdmin(ctx, 'view movement documents');
  return withTenant(ctx, async (tx) => {
    await assertWorkforceEmploymentTx(tx, ctx, employmentId, 'view');
    const { rows } = await projectRows(tx, ctx.tenantId, employmentId);
    const row = rows.find((r) => r.id === movementId);
    if (!row?.groupId) return [];
    return (await listMovementAttachmentsTx(tx, ctx.tenantId, employmentId, [row.groupId])).map(
      ({ movementGroupId: _group, ...summary }) => summary,
    );
  });
}

/** One document's bytes, under the same three checks as movementAttachments. Refuses with one message
 *  whether the document does not exist or the caller may not see it, so the refusal discloses nothing. */
export async function readMovementAttachment(ctx: SessionContext, employmentId: string, attachmentId: string) {
  assertMovementAdmin(ctx, 'view movement documents');
  return withTenant(ctx, async (tx) => {
    await assertWorkforceEmploymentTx(tx, ctx, employmentId, 'view');
    const file = await readMovementAttachmentRowTx(tx, ctx.tenantId, employmentId, attachmentId);
    if (!file) throw new MovementDocumentError('Document not found.');
    const { rows } = await projectRows(tx, ctx.tenantId, employmentId);
    if (!rows.some((r) => r.groupId === file.movementGroupId)) throw new MovementDocumentError('Document not found.');
    return { fileName: file.fileName, mimeType: file.mimeType, content: file.content };
  });
}

/** Edit reads recorded picker values under current RLS. Applied movements use their original legs;
 * pending movements use saved intent. Never hydrate an omitted value from today's mutable profile. */
export function movementPendingEditInput(ctx:SessionContext,employmentId:string,movementId:string):Promise<{values?:MovementPendingFormValues;unavailable:boolean}|null>{
  assertMovementAdmin(ctx,'correct a movement');
  return withTenant(ctx,async tx=>{
    const {emp,events,rows,statusOf,resolvedTypes}=await projectRows(tx,ctx.tenantId,employmentId);
    const [scope]=await tx.execute<{ok:boolean}>(sql`select app.is_admin_for(${emp.companyId}::uuid) as ok`);
    if(!scope?.ok)return {unavailable:true};
    const row=rows.find(r=>r.id===movementId);
    if(row && statusOf(row)==='applied'){
      const base=await movementCorrectionBaseTx(tx,ctx,employmentId,movementId);
      return base?.input?{values:movementPendingFormValues(base.input),unavailable:false}:{unavailable:true};
    }
    if(!row?.scheduled||statusOf(row)!=='pending')return null;
    const event=events.find(e=>e.id===row.id),payload=event?.payload;
    const input=payload&&typeof payload==='object'&&'input' in payload?payload.input:undefined;
    if(!event||!input||typeof input!=='object'||Array.isArray(input))return {unavailable:true};
    const values=movementPendingFormValues(input),display=await pendingIntentTx(tx,ctx.tenantId,event);
    const refs={companyId:'company',departmentId:'department',positionId:'position',businessUnitId:'businessUnit',locationId:'location',gradeId:'grade',managerEmploymentId:'manager'} as const;
    for(const [key,field]of Object.entries(refs)){
      const value=Reflect.get(values,key);
      if(value!=null&&!display?.values.some(v=>v.field===field&&v.value!==null))return {unavailable:true};
    }
    if(values.companyId){
      const [destination]=await tx.execute<{ok:boolean}>(sql`select app.is_admin_for(${values.companyId}::uuid) as ok`);
      if(!destination?.ok)return {unavailable:true};
    }
    return {values,unavailable:false};
  },{readOnlySnapshot:true});
}

/** Explicit owner read seam for a caller-held scoped report snapshot. */
export async function movementDetailTx(tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  movementId: string,
): Promise<MovementDetail | null> {
    const { emp, events, rows, statusOf } = await projectRows(tx, ctx.tenantId, employmentId);
    const row = rows.find((r) => r.id === movementId);
    if (!row) return null;
    const gradeEvents = events.filter((e) => e.eventType === 'employment.grade.changed'||e.eventType==='employment.information.corrected').map(e=>e.eventType==='employment.information.corrected'?{...e,payload:{before:(e.payload as {before: {gradeId:string|null}}).before.gradeId,after:(e.payload as {after: {gradeId:string|null}}).after.gradeId}}:e);
    // b7b22514 — the company moves this employment recorded (and any that were rolled back), for the
    // as-of replay in snapshotAt.
    const companyEvents = events.filter(isCompanyReplayEvent);

    let actorName: string | null = null;
    const ev = events.find((e) => e.id === row.id);
    if (ev?.actorId) {
      const [a] = await tx
        .select({ name: person.fullName })
        .from(appUser)
        .innerJoin(person, eq(person.id, appUser.personId))
        .where(eq(appUser.id, ev.actorId))
        .limit(1);
      actorName = a?.name ?? null;
    }

    // Every leg of a comparison-form movement shares a groupId. The grade replay must bound on the
    // WHOLE group, not just the primary event: the grade leg can carry a higher sequence than the leg
    // that owns the row, and bounding on the primary alone would drop the grade change from the After
    // column. A legacy/single-leg row has no group, so both bounds collapse to its own sequence.
    const group = row.groupId ? events.filter((e) => tagOf(e)?.groupId === row.groupId) : [];
    const seqs = group.length ? group.map((e) => e.sequence) : [row.sequence];
    const afterBound = Math.max(...seqs);
    const beforeBound = Math.min(...seqs);

    const after = await snapshotAt(tx, emp, row.effectiveDate, gradeEvents, afterBound, true, companyEvents);
    const before =
      row.kind === 'hired'
        ? null
        : await snapshotAt(tx, emp, dayBefore(row.effectiveDate), gradeEvents, beforeBound, false, companyEvents);

    return {
      row: {
        id: row.id,
        kind: row.kind,
        effectiveDate: row.effectiveDate,
        entryDate: row.occurredAt ? dateOf(row.occurredAt) : null,
        status: statusOf(row),
        endDate: row.endDate,
        remarks: row.remarks,
        reversed: row.reversed,
      },
      actorName,
      recordedResignation:ev?movementRecordedResignationOf(ev):null,
      occurredAt: row.occurredAt,
      before,
      after,
      pendingIntent: row.scheduled && statusOf(row) === 'pending' && ev
        ? await pendingIntentTx(tx, ctx.tenantId, ev)
        : null,
      flatChanges: flatChangesOf(group.length ? group : events.filter((e) => e.id === row.id)),
      hireCorrection:
        row.kind === 'hired'
          ? await hireCorrectionTraceTx(tx, events.filter((e) => e.eventType === HIRE_CORRECTED_EVENT))
          : null,
    };
  }

/**
 * 08913328 — the employee's CURRENT employment + pay values, as raw ids. This is the read behind the left
 * (read-only) column of the redesigned New Event comparison screen, and the baseline the dispatcher diffs
 * the submitted right column against. Ids, not labels: the form already holds the option lists, and the
 * dispatcher must compare like for like.
 */
export type MovementCurrentState = {
  companyName: string | null;
  /** b7b22514 — the raw id, because Entity Transfer is the one kind that DIFFS this field. `companyName`
   *  stays for the read-only left column every other kind renders; the dispatcher compares ids. */
  companyId: string;
  /** b7b22514 — the current legal entity's join date, diffed by Entity Transfer (whose effective date
   *  becomes its new value). NOT `hired_on`: that is the group anchor and no movement here touches it. */
  joinDate: string | null;
  departmentId: string | null;
  positionId: string | null;
  businessUnitId: string | null;
  locationId: string | null;
  employmentType: string | null;
  gradeId: string | null;
  managerEmploymentId: string | null;
  basicSalary: string | null;
  currency: string | null;
  payMode: string | null;
  paymentTerm: string | null;
  /** 3ced1040 — the date a Confirmation movement moves. Read like every other current value so the delta
   *  rule covers it: re-confirming on the date already stored is a no-op, not a second history row. */
  confirmationDate: string | null;
} & Record<MovementFlatField, string | null>;

async function currentStateTx(tx: Tx, employmentId: string): Promise<MovementCurrentState> {
  const [emp] = await tx
    .select({
      gradeId: employment.gradeId,
      companyName: company.legalName,
      companyId: employment.companyId,
      joinDate: employment.joinDate,
      confirmationDate: employment.confirmationDate,
      orgDivision: employment.orgDivision,
      orgRegion: employment.orgRegion,
      orgBranch: employment.orgBranch,
      orgTeam: employment.orgTeam,
      orgSection: employment.orgSection,
      orgLine: employment.orgLine,
      orgBase: employment.orgBase,
      employmentCategory: employment.employmentCategory,
    })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp) throw new Error('Employment not found');

  // The OPEN rows (validTo null) — the values a movement supersedes, which is what the writers compare
  // against too. An as-of read at the effective date would disagree with them for a back-dated movement.
  const [asg] = await tx
    .select({
      departmentId: assignment.departmentId,
      positionId: assignment.positionId,
      businessUnitId: assignment.businessUnitId,
      locationId: assignment.locationId,
      employmentType: assignment.employmentType,
    })
    .from(assignment)
    .where(
      and(
        eq(assignment.employmentId, employmentId),
        isNull(assignment.validTo),
        isNull(assignment.supersededAt),
      ),
    )
    .limit(1);

  const [rl] = await tx
    .select({ managerEmploymentId: reportingLine.managerEmploymentId })
    .from(reportingLine)
    .where(
      and(
        eq(reportingLine.subordinateEmploymentId, employmentId),
        eq(reportingLine.lineType, 'administrative'),
        isNull(reportingLine.validTo),
        isNull(reportingLine.supersededAt),
      ),
    )
    .limit(1);

  const [comp] = await tx
    .select({
      basicSalary: compensation.basicSalary,
      currency: compensation.currency,
      payMode: compensation.payMode,
      paymentTerm: compensation.paymentTerm,
    })
    .from(compensation)
    .where(
      and(
        eq(compensation.employmentId, employmentId),
        isNull(compensation.validTo),
        isNull(compensation.supersededAt),
      ),
    )
    .limit(1);

  return {
    companyName: emp.companyName,
    companyId: emp.companyId,
    joinDate: emp.joinDate,
    departmentId: asg?.departmentId ?? null,
    positionId: asg?.positionId ?? null,
    businessUnitId: asg?.businessUnitId ?? null,
    locationId: asg?.locationId ?? null,
    employmentType: asg?.employmentType ?? null,
    gradeId: emp.gradeId,
    managerEmploymentId: rl?.managerEmploymentId ?? null,
    basicSalary: comp?.basicSalary ?? null,
    currency: comp?.currency ?? null,
    payMode: comp?.payMode ?? null,
    paymentTerm: comp?.paymentTerm ?? null,
    confirmationDate: emp.confirmationDate,
    orgDivision: emp.orgDivision,
    employmentCategory: emp.employmentCategory,
    orgRegion: emp.orgRegion,
    orgBranch: emp.orgBranch,
    orgTeam: emp.orgTeam,
    orgSection: emp.orgSection,
    orgLine: emp.orgLine,
    orgBase: emp.orgBase,
  };
}

export function movementCurrentState(
  ctx: SessionContext,
  employmentId: string,
): Promise<MovementCurrentState> {
  return withTenant(ctx, (tx) => movementCurrentStateTx(tx, employmentId));
}

/** Same canonical state read inside a caller-owned movement transaction. */
export function movementCurrentStateTx(tx:Tx,employmentId:string):Promise<MovementCurrentState>{
  return currentStateTx(tx,employmentId);
}

export type CreateMovementInput = {
  employmentId: string;
  /**
   * 476f23ed — WIDENED from MovementKind to string. The submitted type may be one of the ORGANISATION's
   * own catalogue codes (Movement Settings), which by definition cannot be enumerated at compile time.
   *
   * The check did not disappear, it moved to where it can actually be made: `resolveInputType` resolves
   * this against the tenant's catalogue inside the request, refuses an unknown or switched-off code, and
   * REPLACES this field with the built-in behaviour kind before any writer sees it. So every branch below
   * still reasons about a built-in kind — it is just resolved at runtime instead of asserted by the type,
   * because "is this a type this tenant configured" is a question only the database can answer.
   */
  kind: string;
  effectiveDate: string;
  endDate?: string | null;
  remarks?: string | null;
  /**
   * b7b22514 — the DESTINATION legal entity. Honoured by the `entityTransfer` kind and IGNORED by every
   * other one, deliberately and in the service rather than in the form: `company_id` is the field that
   * re-homes statutory registration, payroll policy, approval routing and every company-scoped org label,
   * so a forged field posted alongside a Promotion must move nothing. The form only renders the control
   * for Entity Transfer; this is what makes that a rule instead of a convention.
   */
  companyId?: string | null;
  /** Assignment-side fields — empty/absent means "keep current" (mapped to the writers' carry-forward). */
  departmentId?: string | null;
  positionId?: string | null;
  businessUnitId?: string | null;
  locationId?: string | null;
  /** Promotion/Demotion: the new grade ('' / null clears). undefined = grade side untouched. */
  gradeId?: string | null;
  employmentType?: EmploymentTypeValue;
  managerEmploymentId?: string | null;
  basicSalary?: number;
  /** 08913328 — the rest of the pay structure the comparison form can move (see core/comp.ts). */
  currency?: string;
  payMode?: string;
  paymentTerm?: string;
  /**
   * ae9350f2 — `terminationType` is GONE from this input. It is now DERIVED from the reason code below, and
   * an input the dispatcher silently ignores is worse than an absent one — it is a control that saves
   * successfully and does nothing. The enum itself is untouched: core/org.ts still accepts it directly for
   * the resignation-approval path and the importers, which have no reason code to derive from.
   *
   * ae9350f2 — Termination: the coded exit reason (core/termination-reason.ts). MANDATORY for the
   * `termination` kind and the single thing HR picks — it DERIVES `terminationType`, so the coded reason
   * and the turnover classification can never contradict each other.
   */
  terminationReasonCode?: string | null;
  /** ae9350f2 — Termination: notice actually served, in days. Optional. */
  terminationNoticeDays?: number | null;
  /**
   * ae9350f2 — Termination: the date the employee tendered their resignation. Mandatory when the reason is
   * `resignation`, per the reporter's rules. Written to `employment.tender_resignation_date` — the same
   * column the `resignation` movement kind writes, so the two paths agree on where that date lives.
   */
  resignationDate?: string | null;
  /** Resignation's explicit tendered date; old scheduled inputs retain their original effective-date meaning. */
  tenderResignationDate?: string | null;
  /** Actual Employment resignation date. Distinct from the historical termination resignationDate input. */
  resignationEffectiveDate?: string | null;
  /** Blacklist kind: true (default) sets the blacklist, false clears it — the old card's two actions. */
  blacklisted?: boolean;
  /**
   * 476f23ed — the CATALOGUE CODE this movement was recorded as, when it differs from `kind`.
   *
   * `kind` is the BEHAVIOUR (a built-in MovementKind); `typeCode` is what the organisation calls it. For a
   * built-in type the two are the same and this stays undefined. For a tenant's own type — "Redeployment"
   * mapped onto `transfer` — the ledger records the code, so Employment History shows the type HR chose
   * while every writer, guard and rollback path runs the built-in behaviour unchanged.
   *
   * Set by createMovementEvent / editMovementEvent from the catalogue. It is NOT read from a form: a
   * forged field cannot make a movement claim a type this tenant never configured.
   */
  typeCode?: string;
  /**
   * 1d58019a Step 2 (ADR-0166) — supporting documents, one per comparison field, for a type whose Field
   * Controls enable them. Validated and stored in the same transaction as the movement; never part of the
   * scheduled intent (scheduledInputOf ignores it). The movement import never supplies any.
   */
  documents?: MovementDocumentUpload[];
} & Partial<Record<MovementFlatField, string | null>>;

/** 941c9dac — one field a movement moved, resolved to raw values. The audit record the reporter asked
 *  for ("what changed, from what to what") is a list of these, stored on the applied event. */
export type MovementChange = { field: string; before: string | null; after: string | null };

/**
 * 941c9dac — the DELTA computation, lifted out of applyComparisonMovementTx unchanged so that scheduling
 * and applying cannot drift apart. It answers two questions from one pass: which legs must be written,
 * and which FIELD NAMES the movement moves (the input to the same-field conflict test).
 *
 * Deliberately re-run at APPLY time rather than trusting what was computed at keying time: between the
 * two, months can pass and the employee's actual values can move. The stored field list is only ever used
 * for conflict detection; the values written are always diffed against the state that is real on the day.
 */
function movementDeltas(p: CreateMovementInput, cur: MovementCurrentState) {
  // undefined = the form did not carry the field (untouched); otherwise '' means an explicit clear.
  // A value equal to the current one collapses back to undefined — that IS the no-op rule.
  const delta = (v: string | null | undefined, curVal: string | null): string | null | undefined => {
    if (v === undefined) return undefined;
    const next = v === null ? null : v.trim() || null;
    return next === curVal ? undefined : next;
  };

  /**
   * b7b22514 — the ENTITY-TRANSFER deltas. Both are gated on the kind, not merely defaulted by it: on any
   * other kind a submitted companyId is dropped here and never reaches a writer, so the one field that can
   * re-home an employee's legal entity cannot ride in on a Promotion.
   *
   * The join date is not a form field. Like Confirmation's date it IS the movement's effective date, so the
   * history row's Effective Date column and `employment.join_date` can never disagree — and unlike today,
   * where the schema comment calls the auto-sync a documented follow-up, HR no longer has to remember to
   * type it. `hired_on` is not in this function at all: group service is what survives the move.
   */
  const isEntityTransfer = p.kind === 'entityTransfer';
  const dCompany = isEntityTransfer ? delta(p.companyId, cur.companyId) : undefined;
  const dJoinDate = isEntityTransfer ? delta(p.effectiveDate, cur.joinDate) : undefined;

  const dDept = delta(p.departmentId, cur.departmentId);
  const dPos = delta(p.positionId, cur.positionId);
  const dBu = delta(p.businessUnitId, cur.businessUnitId);
  const dLoc = delta(p.locationId, cur.locationId);
  const dType = p.employmentType && p.employmentType !== cur.employmentType ? p.employmentType : undefined;
  const dGrade = delta(p.gradeId, cur.gradeId);
  const dManager = delta(p.managerEmploymentId, cur.managerEmploymentId);

  // Department is NOT NULL on the assignment — an empty submission means "unchanged", never "clear".
  if (dDept === null) throw new Error('Department is required.');
  // b7b22514 — an Entity Transfer with no destination is not a no-op, it is an unanswered question. Refused
  // by name rather than left to the nothingChanged guard below, whose message ("there are no changes to
  // record") would be true and useless. `dCompany === null` is an explicitly cleared select.
  if (isEntityTransfer && (!p.companyId || dCompany === null)) {
    throw new Error('Select the company this employee is transferring to.');
  }

  const flat: Partial<Record<MovementFlatField, string | null>> = {};
  for (const f of MOVEMENT_FLAT_FIELDS) {
    const d = delta(p[f], cur[f]);
    if (d !== undefined) flat[f] = d;
  }

  const dSalary =
    p.basicSalary !== undefined && Number(p.basicSalary) !== Number(cur.basicSalary ?? NaN)
      ? p.basicSalary
      : undefined;
  const dCurrency = delta(p.currency, cur.currency);
  const dPayMode = delta(p.payMode, cur.payMode);
  const dPaymentTerm = delta(p.paymentTerm, cur.paymentTerm);

  /**
   * 3ced1040 — the CONFIRMATION delta. The confirmation date is not a field on the form: it IS the
   * movement's effective date, so the delta is that date against the one already stored.
   *
   * Counting it as a delta rather than exempting Confirmation from the nothingChanged guard is the
   * deliberate choice the plan asked to pin. The reporter requires confirming WITHOUT a salary
   * adjustment, and this gives them that — the confirmation is itself the change, so the movement saves
   * with an empty right-hand column — while keeping the guard's real job: re-submitting the same
   * confirmation date on an already-confirmed employee still changes nothing and is still refused.
   */
  const dConfirmation = p.kind === 'confirmation' ? delta(p.effectiveDate, cur.confirmationDate) : undefined;

  const assignmentChanged =
    dDept !== undefined || dPos !== undefined || dBu !== undefined || dLoc !== undefined || !!dType;
  const gradeChanged = dGrade !== undefined;
  const flatChanged = Object.keys(flat).length > 0;
  const managerChanged = dManager != null; // clearing the superior is the Employment tab's job, not a movement
  // An employee with no salary record yet has null currency / pay mode / payment term, so the form's
  // defaults would read as deltas and demand a salary the movement was never about. Structure-only
  // changes therefore need an existing record; setting the FIRST one stays the Basic Salary screen's job.
  const hasComp = cur.basicSalary != null;
  const compChanged =
    dSalary !== undefined ||
    (hasComp && (dCurrency !== undefined || dPayMode !== undefined || dPaymentTerm !== undefined));

  const confirmationChanged = dConfirmation !== undefined;
  // b7b22514 — the company move is a change in its own right: an Entity Transfer that moves ONLY the
  // company (same department, same pay — the common case for a group restructure) must save. The join date
  // deliberately does NOT count on its own: it is derived from the effective date, so on its own it would
  // let a re-submitted transfer to the same company slip past the no-op guard.
  const companyChanged = dCompany !== undefined;
  const joinDateChanged = dJoinDate !== undefined;

  const nothingChanged =
    !assignmentChanged && !gradeChanged && !flatChanged && !managerChanged && !compChanged &&
    !confirmationChanged && !companyChanged;
  if (dSalary !== undefined && (!Number.isFinite(dSalary) || dSalary < 0)) {
    throw new Error('A valid basic salary amount is required.');
  }

  // The before/after audit list, and (as its field names) the conflict key. Salary is included by name so
  // two future-dated raises on the same day resolve against each other.
  const changes: MovementChange[] = [];
  const add = (field: string, before: string | null, after: string | null | undefined) => {
    if (after === undefined) return;
    changes.push({ field, before, after });
  };
  // b7b22514 — FIRST in the list, and both ids are recorded: this pair IS the audit answer to "which entity
  // did they leave and which did they join", read back years later without depending on today's column.
  add('companyId', cur.companyId, dCompany);
  add('joinDate', cur.joinDate, dJoinDate);
  add('departmentId', cur.departmentId, dDept);
  add('positionId', cur.positionId, dPos);
  add('businessUnitId', cur.businessUnitId, dBu);
  add('locationId', cur.locationId, dLoc);
  add('employmentType', cur.employmentType, dType);
  add('gradeId', cur.gradeId, dGrade);
  if (managerChanged) add('managerEmploymentId', cur.managerEmploymentId, dManager);
  for (const f of MOVEMENT_FLAT_FIELDS) add(f, cur[f], flat[f]);
  if (dSalary !== undefined) add('basicSalary', cur.basicSalary, String(dSalary));
  if (hasComp) {
    add('currency', cur.currency, dCurrency);
    add('payMode', cur.payMode, dPayMode);
    add('paymentTerm', cur.paymentTerm, dPaymentTerm);
  }
  // Named in `fields` too, so two pending confirmations of the same employee resolve against each other
  // through supersededScheduledIds exactly as two pending raises do.
  add('confirmationDate', cur.confirmationDate, dConfirmation);

  return {
    cur,
    dCompany, dJoinDate,
    dDept, dPos, dBu, dLoc, dType, dGrade, dManager, flat,
    dSalary, dCurrency, dPayMode, dPaymentTerm, dConfirmation,
    assignmentChanged, gradeChanged, flatChanged, managerChanged, compChanged, hasComp,
    confirmationChanged, companyChanged, joinDateChanged,
    nothingChanged,
    changes,
    fields: changes.map((c) => c.field),
  };
}

/**
 * 1d58019a Step 2 (ADR-0166) — the event type's FIELD CONTROLS and supporting documents, for one comparison
 * movement about to be written (a new one, or a correction being re-recorded).
 *
 * `p.kind` is the resolved behaviour and `p.typeCode` the catalogue code whose controls apply. "Changed" is
 * the writer's own delta rule (movementDeltas against `baseline`, the state the write itself will diff
 * against), so Required to Change means exactly "the after value differs from the current value", and a
 * field the form did not post is never mistaken for a change. `carriedFields` are fields a correction
 * already has documents for (copied forward from the movement it corrects).
 *
 * A type with NO stored controls and no documents returns before computing anything: today's behaviour,
 * byte for byte. Returns the validated documents for the caller to store once the write has its group id.
 */
async function assertMovementFieldRulesTx(
  tx: Tx,
  ctx: SessionContext,
  p: CreateMovementInput,
  carriedFields: readonly string[],
  baseline: () => Promise<MovementCurrentState>,
) {
  const documents = validateMovementDocuments(p.documents);
  const { configured, rules } = await movementFieldRulesTx(tx, ctx.tenantId, p.typeCode ?? p.kind, p.kind);
  if (!configured && !documents.length) return documents;
  const changed = new Set(movementDeltas(p, await baseline()).changes.map((c) => c.field));
  const supplied = new Set<string>([...documents.map((d) => d.field), ...carriedFields]);
  const violations = movementFieldRuleViolations(rules, changed, supplied);
  if (violations.length) throw new MovementFieldRuleError(violations[0]);
  return documents;
}

/** The fields the movement being corrected has documents for that its (new) type still accepts documents
 *  for — copied to the corrected movement, and counted towards "required". */
async function correctionDocumentFieldsTx(tx: Tx, ctx: SessionContext, p: CreateMovementInput, fromGroupId: string | null) {
  if (!fromGroupId || !isComparisonKind(p.kind)) return [];
  const { rules } = await movementFieldRulesTx(tx, ctx.tenantId, p.typeCode ?? p.kind, p.kind);
  const enabled = new Set<string>(rules.filter((r: MovementFieldRule) => r.document !== 'none').map((r) => r.field));
  return (await movementAttachmentFieldsTx(tx, ctx.tenantId, p.employmentId, fromGroupId)).filter((f) => enabled.has(f));
}

/** Store a correction's documents: the carried copies, then any newly uploaded. */
async function storeCorrectionDocumentsTx(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  fromGroupId: string | null,
  toGroupId: string,
  carriedFields: readonly string[],
  documents: Awaited<ReturnType<typeof assertMovementFieldRulesTx>>,
) {
  if (fromGroupId) await carryMovementAttachmentsTx(tx, ctx, employmentId, fromGroupId, toGroupId, carriedFields);
  if (documents.length) await saveMovementAttachmentsTx(tx, ctx, employmentId, toGroupId, documents);
}

/**
 * The comparison-form writer. HR submits the WHOLE right column, so the deltas — never the submitted
 * values — decide what is written: a field left at its current value must not produce an assignment
 * version, a compensation revision or a history row that says nothing happened.
 *
 * Every leg runs in ONE transaction (each writer's `outerTx`), so a movement that moves department, grade,
 * division and salary either lands whole or not at all. The FIRST leg with a real delta carries the
 * primary movement tag and owns the history row; the rest are tagged `secondary` and share its `groupId`,
 * which is how the detail view finds the flat-column before/after and the full sequence span.
 *
 * 941c9dac — `opts` is how the scheduled-movement sweep re-uses this writer verbatim. It passes the
 * SCHEDULED event's groupId and `allSecondary`, so every leg becomes a companion of the scheduled event
 * that is already on the history: the movement keeps exactly ONE row, whose status simply moves from
 * Pending to Applied. Without `allSecondary` the first leg would take the primary tag and the employee
 * would sprout a second, duplicate history row on the morning the movement took effect.
 */
async function applyComparisonMovementTx(
  tx: Tx,
  ctx: SessionContext,
  p: CreateMovementInput,
  kind: ComparisonKind,
  opts?: { groupId?: string; allSecondary?: boolean },
) {
  // Acquire the person owner before any info/assignment leg can lock employment.
  await lockEmploymentStatutoryOwnerTx(tx,p.employmentId);
  const remarks = p.remarks?.trim() || null;
  const endDate = p.endDate?.trim() || null;
  const groupId = opts?.groupId ?? randomUUID();

  {
    const cur = await currentStateTx(tx, p.employmentId);
    const d = movementDeltas(p, cur);
    const {
      dCompany, dJoinDate,
      dDept, dPos, dBu, dLoc, dType, dGrade, dManager, flat,
      dSalary, dCurrency, dPayMode, dPaymentTerm, dConfirmation,
      assignmentChanged, gradeChanged, flatChanged, compChanged, confirmationChanged,
      companyChanged, joinDateChanged,
    } = d;

    if (d.nothingChanged) {
      throw new MovementNoChangeError();
    }

    // 941c9dac — seeded TRUE by the sweep, which makes EVERY leg secondary because the scheduled event
    // already owns the history row (see the `opts` note in the doc comment).
    let primaryTaken = opts?.allSecondary === true;
    /** Primary for the first leg with a real delta, `secondary` for every leg after it. */
    const tag = (opts: { withRemarks: boolean }): MovementTag => {
      // 476f23ed — the TAG carries the catalogue code (what the organisation calls this event); `kind`
      // carries the behaviour that just ran. They are identical for every built-in type.
      const t: MovementTag = { type: p.typeCode ?? kind, groupId, effectiveDate: p.effectiveDate };
      // ADR-0030 redact-to-reference: comp events never carry remark text — it lives on the comp row.
      if (opts.withRemarks) {
        t.remarks = remarks;
        t.endDate = endDate;
      }
      if (primaryTaken) t.secondary = true;
      primaryTaken = true;
      return t;
    };

    // 3ced1040 — the flat org columns and the CONFIRMATION DATE share one leg, because they share one
    // writer. Confirmation is a comparison kind now, and the date it sets rides on the same
    // setEmploymentInfo call rather than a second one: two calls would be two `employment.info.updated`
    // events for one movement, and the rollback would have to undo them in the right order to be correct.
    // setEmploymentInfo re-derives finalConfirmationDate from it, which is what flips the derived
    // Employee Status from Probation to Confirmed — there is no status column to write.
    const infoLeg = async () => {
      if (!flatChanged && !confirmationChanged && !joinDateChanged) return;
      await setEmploymentInfo(
        ctx,
        {
          employmentId: p.employmentId,
          ...flat,
          ...(confirmationChanged ? { confirmationDate: dConfirmation } : {}),
          // b7b22514 — the Entity Transfer's new current-company Join Date rides on the SAME
          // setEmploymentInfo call as the flat columns, for the reason Confirmation's date does: two calls
          // would be two `employment.info.updated` events for one movement, and the rollback would have to
          // undo them in the right order to be correct. setEmploymentInfo's gate accepts the entityTransfer
          // tag, so this column keeps exactly one writer.
          ...(joinDateChanged ? { joinDate: dJoinDate } : {}),
          movement: tag({ withRemarks: true }),
        },
        tx,
      );
    };

    /**
     * 3ced1040 — a CONFIRMATION runs its info leg FIRST, so that leg (and not whichever other one happens
     * to come first) takes the primary tag and owns the history row.
     *
     * Keep Confirmation's historical primary identity: the info leg owns the confirmation date.
     * Every comparison leg now also freezes the entered effective day in its movement tag, so a grade
     * or flat-column primary no longer substitutes the day HR keyed a backdated movement. The leg
     * ordering and primary/secondary grouping remain unchanged.
     */
    if (confirmationChanged) await infoLeg();

    /**
     * b7b22514 — THE COMPANY LEG RUNS FIRST, and the ordering carries two separate loads.
     *
     * It owns the HISTORY ROW. The primary tag goes to the first leg with a real delta, and for an Entity
     * Transfer that has to be this one: its event is the only one carrying both company ids, and it is the
     * only effective-dated leg of a company-only transfer (a restructure that moves nobody's department
     * writes no assignment version at all, so any other ordering would leave the movement with no row).
     *
     * And it makes every later leg resolve against the DESTINATION. setEmploymentAssignment,
     * setEmploymentGrade and setReportingLine all read `employment.company_id` for their own guards; with
     * the flip already applied in this transaction they validate against the company the employee is
     * moving TO, without any of them learning that a company move exists.
     *
     * What travels to the guard is the DELTAS, not the result. The leg resolves the carry-forwards from the
     * open assignment and reporting line itself, so a field this form cannot move — cost centre — is still
     * checked against the destination. That is the case a caller-assembled placement would have quietly
     * dropped, and it is the one most likely to dangle.
     */
    if (companyChanged && dCompany) {
      await transferEmploymentCompanyTx(tx, ctx, {
        employmentId: p.employmentId,
        newCompanyId: dCompany,
        effectiveDate: p.effectiveDate,
        placement: {
          departmentId: dDept,
          positionId: dPos,
          businessUnitId: dBu,
          locationId: dLoc,
          managerEmploymentId: dManager,
        },
        // 3c88d593 — the type delta travels with the company leg now, because that leg writes the
        // assignment version (see below).
        ...(dType ? { employmentType: dType } : {}),
        movement: tag({ withRemarks: true }),
      });
    }

    /**
     * 3c88d593 — `&& !companyChanged`, and it is not a narrowing: the leg still runs, one call earlier.
     *
     * transferEmploymentCompanyTx now writes the assignment version itself, because the legal entity is
     * an effective-dated dimension OF that version (migration 0440) and there is no way to record a
     * company move without writing one. It is handed the same deltas as this call — department, position,
     * business unit, location, and since this item the employment type — so the version it writes is the
     * version this branch would have written, plus the company.
     *
     * Leaving both to run would close the version the transfer just opened and open a second one on the
     * SAME date, leaving a zero-length row and projecting a movement that moved twice. So on an Entity
     * Transfer the entity leg owns the assignment, and every other kind is untouched.
     */
    if (assignmentChanged && !companyChanged) {
      // ONE assignment writer for every comparison kind, Transfer included. transferEmployee is NOT used
      // here even though Transfer is its historical path: it silently drops business_unit_id on the new
      // version (it predates the column), so a Transfer submitted from a form that also shows Business Unit
      // would wipe it. setEmploymentAssignment carries every dimension forward and, since 08913328, owns
      // Work Location too — so one CLOSE+INSERT covers the whole assignment leg with no zero-length row.
      await setEmploymentAssignment(
        ctx,
        {
          employmentId: p.employmentId,
          effectiveDate: p.effectiveDate,
          departmentId: dDept ?? undefined,
          positionId: dPos,
          businessUnitId: dBu,
          locationId: dLoc,
          employmentType: dType,
          movement: tag({ withRemarks: true }),
        },
        tx,
      );
    }

    if (gradeChanged) {
      await setEmploymentGrade(
        ctx,
        { employmentId: p.employmentId, gradeId: dGrade ?? null, movement: tag({ withRemarks: true }) },
        tx,
      );
    }

    // Every other kind keeps the info leg where it always was — after grade, before the reporting line.
    if (!confirmationChanged) await infoLeg();

    // `dManager != null` rather than the equivalent `managerChanged` flag purely so TypeScript keeps the
    // narrowing to a non-null string through the call below (the flag is computed in movementDeltas, so
    // control-flow analysis cannot tie the two together).
    if (dManager != null) {
      await setReportingLine(
        ctx,
        {
          subordinateEmploymentId: p.employmentId,
          managerEmploymentId: dManager,
          lineType: 'administrative',
          validFrom: p.effectiveDate,
          movement: tag({ withRemarks: true }),
        },
        tx,
      );
    }

    if (compChanged) {
      const basicSalary = dSalary ?? Number(cur.basicSalary ?? NaN);
      if (!Number.isFinite(basicSalary)) throw new Error('A valid basic salary amount is required.');
      await setCompensation(
        ctx,
        {
          employmentId: p.employmentId,
          basicSalary,
          ...(dCurrency ? { currency: dCurrency } : {}),
          ...(dPayMode ? { payMode: dPayMode } : {}),
          ...(dPaymentTerm ? { paymentTerm: dPaymentTerm } : {}),
          ...(remarks ? { remarks } : {}),
          // 646355e5 — an acknowledged correction never re-dates a salary into closed months.
          effectiveFrom: hasClosedPayrollCorrectionAuthorityTx(tx, p.employmentId)
            ? await salaryStartAfterClosedPayrollTx(tx, p.employmentId, p.effectiveDate)
            : p.effectiveDate,
          movement: tag({ withRemarks: false }),
        },
        tx,
      );
    }

    // 941c9dac — the change list travels back to the sweep, which stores it on the applied event as the
    // permanent "what changed, from what to what" record of the automatic application.
    return { employmentId: p.employmentId, changes: d.changes, groupId };
  }
}

/**
 * 941c9dac — the fields of the submitted right column, frozen onto the scheduled event so the sweep can
 * replay EXACTLY what HR typed months later. `undefined` (the form did not offer the field) is dropped
 * rather than stored as null, because JSON has no `undefined`: round-tripping it as null would turn
 * "leave the Work Location alone" into "clear the Work Location" on the morning the movement applies.
 */
function scheduledInputOf(p: CreateMovementInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of MOVEMENT_PENDING_COMPARISON_FIELDS) {
    const v = (p as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * 941c9dac — record a FUTURE-dated movement as an INTENT and write nothing else.
 *
 * This is the whole fix. Previously every kind went straight to the writers, which CLOSE the open dated
 * row and INSERT a new one carrying the movement's effective date — leaving the NEW row open. Since the
 * Employment tab (and the ESS profile, the directory, the org chart and analytics) all resolve "current"
 * as the OPEN row rather than as-of today, a promotion keyed today and effective next month became
 * current the instant it was saved. Deferring the WRITE fixes every one of those readers at once, which
 * changing the reads could not have done: the flat `employment` columns (job grade, Division … Category)
 * are not effective-dated at all, so there is no as-of read to switch them to.
 *
 * The deltas are computed and validated HERE, at keying time, so HR finds out immediately that the
 * movement is a no-op or that the department is missing — not silently, months later, inside a cron job.
 * The field list they produce is frozen onto the event as the conflict key; the VALUES are recomputed
 * against live state when the movement actually applies.
 */
async function scheduleMovementTx(
  tx: Tx,
  ctx: SessionContext,
  p: CreateMovementInput,
  kind: ComparisonKind,
  admission?: { baseline?: MovementCurrentState; capture?: (baseline: MovementCurrentState) => void },
) {
  // Always reread the real subject under current RLS. Only the canonical rollback rehearsal below can
  // supply a verified predecessor state for a future sequence; ordinary New Event/Edit use live state.
  const live = await currentStateTx(tx, p.employmentId);
  const cur = admission?.baseline ?? live;
  const d = movementDeltas(p, cur);
  if (d.nothingChanged) throw new MovementNoChangeError();
  admission?.capture?.({...cur});

  const remarks = p.remarks?.trim() || null;
  const endDate = p.endDate?.trim() || null;
  const groupId = randomUUID();
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'employment',
    aggregateId: p.employmentId,
    eventType: 'employment.movement.scheduled',
    actor: actorOf(ctx),
    subjectEmploymentId: p.employmentId,
    payload: {
      // 476f23ed — the catalogue code, so a pending movement reads on the history as the type HR chose.
      // The sweep resolves it back to a behaviour kind when it applies (applyDueMovementsTx).
      type: p.typeCode ?? kind,
      effectiveDate: p.effectiveDate,
      endDate,
      remarks,
      /** The conflict key — the fields this movement intends to move (see supersededScheduledIds). */
      fields: d.fields,
      /** What HR typed, replayed verbatim by the sweep on the effective date. */
      input: scheduledInputOf(p),
      // The tag is what makes this event the OWNER of the history row: the sweep's legs share this
      // groupId and are all `secondary`, so the movement keeps exactly one line in the history.
      movement: { type: p.typeCode ?? kind, groupId, remarks, endDate } satisfies MovementTag,
    },
  });
  return { employmentId: p.employmentId, scheduled: true as const, effectiveDate: p.effectiveDate, groupId };
}

// Resignation information is a lifecycle effect, not a termination or final-pay command.
const RESIGNATION_INFO_FIELDS=['tenderResignationDate','resignationDate','lastWorkingDate'] as const;
function resignationFinancialDates(group:RawEvent[]):string[]{return group.flatMap(event=>{const payload=event.payload as {before?:Record<string,string|null>;after?:Record<string,string|null>};return ['resignationDate','lastWorkingDate'].flatMap(field=>payload?.before?.[field]===payload?.after?.[field]?[]:[payload?.before?.[field],payload?.after?.[field]]).filter((date):date is string=>!!date);});}
async function resignationValuesTx(tx:Tx,p:CreateMovementInput){
  await lockEmploymentStatutoryOwnerTx(tx,p.employmentId);
  const [before]=await tx.select({hiredOn:employment.hiredOn,tenderResignationDate:employment.tenderResignationDate,resignationDate:employment.resignationDate,lastWorkingDate:employment.lastWorkingDate}).from(employment).where(eq(employment.id,p.employmentId)).for('update');
  if(!before)throw new Error('Employment not found.');
  if(!isCalendarDate(p.effectiveDate)||p.effectiveDate<before.hiredOn)throw new Error('A valid effective date on or after the hire date is required.');
  const value=(raw:string|null|undefined,current:string|null)=>raw===undefined?current:raw?.trim()||null;
  const next={tenderResignationDate:value(p.tenderResignationDate,p.effectiveDate),resignationDate:value(p.resignationEffectiveDate,before.resignationDate),lastWorkingDate:value(p.endDate,before.lastWorkingDate)};
  for(const date of Object.values(next))if(date!==null&&(!isCalendarDate(date)||date<before.hiredOn))throw new Error('Resignation dates must be valid dates on or after the hire date.');
  if(next.tenderResignationDate&&next.resignationDate&&next.tenderResignationDate>next.resignationDate||next.resignationDate&&next.lastWorkingDate&&next.resignationDate>next.lastWorkingDate||next.tenderResignationDate&&next.lastWorkingDate&&next.tenderResignationDate>next.lastWorkingDate)throw new Error('Resignation dates must follow tender date, resignation date, then last working date.');
  const changes=RESIGNATION_INFO_FIELDS.filter(field=>before[field]!==next[field]).map(field=>({field,before:before[field],after:next[field]}));
  const thresholds=changes.filter(change=>change.field!=='tenderResignationDate');
  const from=[p.effectiveDate,...thresholds.flatMap(change=>[change.before,change.after]).filter((date):date is string=>!!date)].sort()[0];
  // 646355e5 — an acknowledged correction owns this window (closed-payroll-correction-authority).
  if(thresholds.length&&!hasClosedPayrollCorrectionAuthorityTx(tx,p.employmentId)&&overlapsClosedPeriod(await closedPeriodsTx(tx,p.employmentId),from,null))throw new Error('A closed payroll run relied on this movement. Reopen that payroll before correcting the event.');
  return {before,next,changes};
}
async function applyResignationMovementTx(tx:Tx,ctx:SessionContext,p:CreateMovementInput,opts?:{groupId?:string;allSecondary?:boolean}){
  const {next,changes}=await resignationValuesTx(tx,p);if(!changes.length)throw new MovementNoChangeError();
  // Changing exit thresholds can affect any later closed payroll period. Apply and reverse share
  // the existing Movement guard; no final-pay, assignment-end or encashment owner is invoked here.
  const groupId=opts?.groupId??randomUUID();
  await withExitDateAuthorityTx(tx,p.employmentId,()=>setEmploymentInfo(ctx,{employmentId:p.employmentId,...next,movement:{type:'resignation',groupId,effectiveDate:p.effectiveDate,endDate:next.lastWorkingDate,remarks:p.remarks?.trim()||null,secondary:opts?.allSecondary}},tx));
  return {employmentId:p.employmentId,groupId,changes};
}
async function recordResignationMovementTx(tx:Tx,ctx:SessionContext,p:CreateMovementInput){
  const {next,changes}=await resignationValuesTx(tx,p);
  if(!changes.length)throw new MovementNoChangeError();
  if(p.effectiveDate<=todayInKualaLumpur())return applyResignationMovementTx(tx,ctx,p);
  const groupId=randomUUID();
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:p.employmentId,eventType:'employment.movement.scheduled',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,payload:{type:'resignation',effectiveDate:p.effectiveDate,endDate:next.lastWorkingDate,remarks:p.remarks?.trim()||null,fields:RESIGNATION_INFO_FIELDS,input:{tenderResignationDate:next.tenderResignationDate,resignationEffectiveDate:next.resignationDate},movement:{type:'resignation',groupId,effectiveDate:p.effectiveDate,endDate:next.lastWorkingDate,remarks:p.remarks?.trim()||null}}});
  return {employmentId:p.employmentId,scheduled:true as const,effectiveDate:p.effectiveDate};
}

// ───────────── Termination — ae9350f2 ─────────────
//
// Termination is NOT greenfield: `termination` has been a MOVEMENT_KIND since 78853b97 and the projection
// has rendered Termination/Resignation rows off `employment.terminated` for as long. What this item adds is
// the structured exit — a coded reason, a last working day, notice, a tendered-resignation date — and the
// three properties the reporter asked for and which the old one-line path did not have:
//
//   1. EXACTLY ONE Employment History row. The termination writes TWO legs (the termination itself and the
//      exit dates), and an `employment.info.updated` carrying `lastWorkingDate` used to project a
//      RESIGNATION row of its own off the field-group inference. That is defect 4d391ab7 in miniature — a
//      companion writer giving one movement two lines — so the second leg is tagged `secondary` under the
//      first's groupId. 30325fc1 has since removed the inference as well, but the `secondary` tag stays:
//      it is what makes the leg a companion rather than a movement of its own, and it is also what a
//      rollback follows to undo both legs together.
//   2. A FUTURE-DATED TERMINATION MUST NOT END EMPLOYMENT TODAY. Before this item every termination went
//      straight to terminateEmploymentTx, which CLOSES the open assignment version and the open reporting
//      lines at the termination date. The dates themselves were right, but every reader that resolves
//      "current" as the OPEN row (`isNull(validTo)`) — the Employment tab, the org chart, the directory,
//      movementCurrentState — lost the employee's department, position and manager the INSTANT a future
//      termination was keyed. That is 941c9dac's fault with the sign flipped, and it gets 941c9dac's fix:
//      a future-dated termination records `employment.movement.scheduled` and NOTHING else, and
//      scripts/review-sweep.ts applies it on the morning of its effective date under the same
//      apply-once guarantee (migration 0329's partial unique index on payload->>'scheduledId').
//   3. THE VALIDATION RULES the reporter listed, all of them cheap and all of them here rather than later.
//
// No status column is written or read. Employee Status is DERIVED (migration 0331, core/employment-status.ts)
// from least(resignationDate, lastWorkingDate, terminatedOn) vs today — so recording the DATES is what moves
// the employee to Resigned on the effective date, and to Active — Serving Notice before it. 0331's header
// names this item as the writer of that seam; this is it.

/**
 * The conflict key of a scheduled Termination (see supersededScheduledIds). Deliberately its own pair of
 * names rather than any comparison-kind field: a pending transfer and a pending termination are not in
 * conflict, but two pending terminations are, and the later-dated one must win.
 */
const TERMINATION_FIELDS = ['terminatedOn', 'lastWorkingDate'] as const;

/** The validated, resolved shape of a Termination — computed once and used by both the write and the schedule. */
type TerminationPlan = {
  /** 1d58019a Step 2 — the catalogue code recorded on the ledger: 'termination', or one of the
   *  organisation's own Termination types. The behaviour is the same either way. */
  typeCode: string;
  effectiveDate: string;
  lastWorkingDate: string;
  reasonCode: string;
  terminationType: TerminationType;
  noticeDays: number | null;
  /** The tendered-resignation date, when the reason is a resignation. */
  resignationDate: string | null;
  remarks: string | null;
  /**
   * 'YYYY-MM' payroll periods that have already been PROCESSED or CLOSED past the termination date. A
   * FLAG, never a refusal: the approved plan says a backdated termination whose period a completed run
   * already covered is surfaced rather than silently adjusted, because reprocessing a closed run from an
   * HR screen is exactly the silent-correction this module refuses everywhere else.
   */
  payrollFlaggedPeriods: string[];
};

const isIsoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Validate a Termination against the reporter's rules and resolve it into a TerminationPlan.
 *
 * `mode` is the one real difference between keying a termination and the sweep applying one months later:
 *  • 'create' — the full rule set, including the two that only make sense at keying time (this employee is
 *    not already leaving, and no future movement is scheduled to land after they have gone).
 *  • 'apply'  — the sweep. The shape and date rules still hold, but the two keying-time rules do not: the
 *    movement being applied IS the pending termination, and a conflicting movement keyed since is resolved
 *    by supersession (projection-time), not by refusing the application forever. If somebody terminated the
 *    employee by hand in the meantime the movement has nothing left to do, which is a MovementNoChangeError
 *    — the sweep records it as applied-with-no-changes so it leaves the due set instead of retrying nightly.
 */
async function planTerminationTx(
  tx: Tx,
  ctx: SessionContext,
  p: CreateMovementInput,
  mode: 'create' | 'apply',
  excludeMovementId?: string,
): Promise<TerminationPlan> {
  const { emp, rows, statusOf, resolvedTypes } = await projectRows(tx, ctx.tenantId, p.employmentId);
  // 1d58019a Step 2 — "is this row a termination" is a question for the catalogue, not for the code: a
  // pending Retrenchment is a pending termination and must block a second exit exactly as one would.
  const isTerminationRow = (r: ProjectedRow) => resolvedTypes.get(r.kind)?.behaviourKind === 'termination';

  if (!isIsoDate(p.effectiveDate)) throw new Error('A valid termination date (YYYY-MM-DD) is required.');

  // Rule: "Termination date cannot be earlier than joining date."
  if (p.effectiveDate < emp.hiredOn) {
    throw new Error('Termination date cannot be earlier than the hire date.');
  }

  // The reporter's mandatory field. `endDate` is the Last Working Day — the same slot the `resignation`
  // kind already uses for it, so Employment History's End Date column means one thing on both.
  const lastWorkingDate = p.endDate?.trim() || null;
  if (!isIsoDate(lastWorkingDate)) throw new Error('A last working day (YYYY-MM-DD) is required.');
  if (lastWorkingDate > p.effectiveDate) {
    throw new Error('Last working day cannot be later than the termination date.');
  }
  if (lastWorkingDate < emp.hiredOn) {
    throw new Error('Last working day cannot be earlier than the hire date.');
  }

  const reasonCode = p.terminationReasonCode?.trim() || null;
  if (!reasonCode) throw new Error('A termination reason is required.');
  // 1d58019a — the TENANT's catalogue (built-ins plus its own reasons; switched-off ones still resolve so a
  // pending termination applies and a correction keeps its reason). A NEW one is refused at the call site.
  const reason = await resolveTerminationReasonTx(tx, ctx.tenantId, reasonCode);
  if (!reason) throw new Error('Unknown termination reason.');
  const terminationType: TerminationType = reason.terminationType;

  // "Resignation Date — mandatory for resignation cases."
  const resignationDate = p.resignationDate?.trim() || null;
  if (reasonCode === 'resignation') {
    if (!isIsoDate(resignationDate)) throw new Error('A resignation date (YYYY-MM-DD) is required for a resignation.');
    if (resignationDate > lastWorkingDate) {
      throw new Error('Resignation date cannot be later than the last working day.');
    }
    if (resignationDate < emp.hiredOn) {
      throw new Error('Resignation date cannot be earlier than the hire date.');
    }
  } else if (resignationDate !== null && !isIsoDate(resignationDate)) {
    throw new Error('A valid resignation date (YYYY-MM-DD) is required.');
  }

  const rawNotice = p.terminationNoticeDays;
  let noticeDays: number | null = null;
  if (rawNotice !== undefined && rawNotice !== null && String(rawNotice) !== '') {
    const n = Number(rawNotice);
    if (!Number.isInteger(n) || n < 0) throw new Error('Notice period must be a whole number of days.');
    noticeDays = n;
  }

  // "Employee cannot have duplicate termination movement" / "cannot submit resignation if already terminated".
  const pendingTermination = rows.find(
    (r) =>
      r.id !== excludeMovementId &&
      isTerminationRow(r) &&
      r.scheduled &&
      statusOf(r) === 'pending',
  );
  if (mode === 'create') {
    if (emp.terminatedOn) {
      throw new Error('This employee is already terminated. Roll back the existing termination before recording another.');
    }
    if (pendingTermination) {
      throw new Error(
        `A termination is already recorded for ${pendingTermination.effectiveDate}. Cancel or correct it before recording another.`,
      );
    }
    // "Termination effective date must not overlap with future approved movements." A movement scheduled to
    // take effect on or after the day the employee leaves would apply to somebody who is no longer there —
    // and the sweep would apply it, because supersession only resolves SAME-FIELD conflicts and a transfer
    // shares no field with a termination.
    const clashing = rows.find(
      (r) =>
        r.id !== excludeMovementId &&
        r.scheduled &&
        !isTerminationRow(r) &&
        statusOf(r) === 'pending' &&
        r.effectiveDate >= p.effectiveDate,
    );
    if (clashing) {
      throw new Error(
        `A movement is already scheduled for ${clashing.effectiveDate}, on or after this termination date. Cancel that movement first.`,
      );
    }
  } else if (emp.terminatedOn) {
    // The sweep arriving to find the employee already terminated by hand — applied-with-no-changes.
    throw new MovementNoChangeError('This employee has already been terminated, so the scheduled termination has nothing to apply.');
  }

  // "Pending payroll cycle must be checked before termination." FLAG, not refuse (see the field comment).
  const processed = await processedPeriodsTx(tx, p.employmentId);
  const payrollFlaggedPeriods = processed.filter((period) => overlapsClosedPeriod([period], p.effectiveDate, null));

  return {
    typeCode: p.typeCode ?? 'termination',
    effectiveDate: p.effectiveDate,
    lastWorkingDate,
    reasonCode,
    terminationType,
    noticeDays,
    resignationDate,
    remarks: p.remarks?.trim() || null,
    payrollFlaggedPeriods,
  };
}

/**
 * The Termination writer. Two legs in ONE transaction, sharing one groupId, so Employment History shows
 * exactly ONE row (see the section header — leg 2 would otherwise project its own "Resignation" line).
 *
 * `opts` mirrors applyComparisonMovementTx: the sweep passes the SCHEDULED event's groupId and
 * `allSecondary`, so both legs become companions of the row that is already on the history and the movement
 * never grows a second line on the morning it takes effect.
 */
async function applyTerminationTx(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  plan: TerminationPlan,
  opts?: { groupId?: string; allSecondary?: boolean },
) {
  const groupId = opts?.groupId ?? randomUUID();
  let primaryTaken = opts?.allSecondary === true;
  const tag = (): MovementTag => {
    const t: MovementTag = {
      // 1d58019a Step 2 — the CODE HR chose ('termination' or one of the organisation's own Termination types).
      type: plan.typeCode,
      groupId,
      remarks: plan.remarks,
      endDate: plan.lastWorkingDate,
    };
    if (primaryTaken) t.secondary = true;
    primaryTaken = true;
    return t;
  };

  // Leg 1 — PRIMARY. terminateEmploymentTx sets terminated_on + the classification, CLOSES the open
  // assignment version at the termination date and ENDS this employment's open administrative reporting
  // lines in both directions (ADR-0052). That is the reporter's "remove from the current position holder
  // list, the reporting hierarchy and the supervisor listing" — already built, and reached here rather than
  // reimplemented. Nothing is deleted: every closed row keeps its window, so history and reporting are intact.
  await terminateEmploymentTx(tx, ctx, {
    employmentId,
    terminationDate: plan.effectiveDate,
    terminationReason: plan.remarks ?? undefined,
    terminationReasonCode: plan.reasonCode,
    terminationNoticeDays: plan.noticeDays,
    movement: tag(),
  });

  // Leg 2 — SECONDARY. The exit dates. lastWorkingDate is what flips Employee Status to Resigned on the
  // day the person actually stops working when that precedes the termination date
  // (deriveEmploymentStatus reads the EARLIEST of the three end dates).
  await withExitDateAuthorityTx(tx,employmentId,()=>setEmploymentInfo(
    ctx,
    {
      employmentId,
      lastWorkingDate: plan.lastWorkingDate,
      ...(plan.resignationDate ? { tenderResignationDate: plan.resignationDate } : {}),
      movement: tag(),
    },
    tx,
  ));

  const changes: MovementChange[] = [
    { field: 'terminatedOn', before: null, after: plan.effectiveDate },
    { field: 'lastWorkingDate', before: null, after: plan.lastWorkingDate },
    { field: 'terminationReasonCode', before: null, after: plan.reasonCode },
  ];
  return { employmentId, groupId, changes, payrollFlaggedPeriods: plan.payrollFlaggedPeriods };
}

/**
 * ae9350f2 + 941c9dac — record a FUTURE-dated termination as an INTENT and write nothing else.
 *
 * See the section header for why this matters more for a termination than for any other kind: the writer
 * closes the open assignment and reporting-line rows, so keying a termination for next month used to blank
 * the employee's department, position and manager on every "current" screen today.
 */
async function scheduleTerminationTx(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  plan: TerminationPlan,
) {
  const groupId = randomUUID();
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'employment',
    aggregateId: employmentId,
    eventType: 'employment.movement.scheduled',
    actor: actorOf(ctx),
    subjectEmploymentId: employmentId,
    payload: {
      // 1d58019a Step 2 — the catalogue code; the sweep resolves it back to the termination behaviour.
      type: plan.typeCode,
      effectiveDate: plan.effectiveDate,
      endDate: plan.lastWorkingDate,
      remarks: plan.remarks,
      fields: [...TERMINATION_FIELDS],
      /** What HR keyed, replayed verbatim by the sweep on the effective date. */
      input: {
        terminationReasonCode: plan.reasonCode,
        terminationNoticeDays: plan.noticeDays,
        resignationDate: plan.resignationDate,
      },
      movement: {
        type: plan.typeCode,
        groupId,
        remarks: plan.remarks,
        endDate: plan.lastWorkingDate,
      } satisfies MovementTag,
    },
  });
  return {
    employmentId,
    scheduled: true as const,
    effectiveDate: plan.effectiveDate,
    payrollFlaggedPeriods: plan.payrollFlaggedPeriods,
  };
}

/**
 * 476f23ed — resolve a submitted event type through the tenant's CATALOGUE, returning the input with
 * `kind` set to the BEHAVIOUR that must run and `typeCode` set to what the organisation calls it.
 *
 * Every write path into this module goes through here, so there is exactly one place that decides what a
 * submitted type means. Three rules, all of them the reason this function exists rather than an inline
 * `MOVEMENT_KINDS.includes`:
 *   • an unknown code is refused — a forged form field cannot invent an event type;
 *   • a type the organisation switched OFF is refused for a NEW movement (`allowInactive: false`) and
 *     allowed for a correction, because a movement already recorded under a since-retired type must stay
 *     correctable;
 *   • the behaviour is never taken from the submission. It comes from the catalogue row, which
 *     core/movement-type.ts will only ever point at a built-in kind — and, for a tenant's own type, only
 *     at one of the consequence-free kinds. That is what stops a renamed type from acting like a
 *     Termination.
 */
async function resolveInputTypeTx<T extends CreateMovementInput>(
  tx: Tx,
  ctx: SessionContext,
  p: T,
  verb: 'record' | 'correct',
  opts?: { allowInactive?: boolean },
): Promise<T> {
  // 1d58019a Step 2 — hold the catalogue's SHARED lock for the rest of this movement write. A type's behaviour
  // is locked once used, and the settings writer checks "used" under the EXCLUSIVE lock: without this, a
  // re-point could commit between this resolution and the write that makes the type used.
  await lockMovementTypeCatalogueTx(tx, ctx.tenantId);
  const resolved = await resolveMovementEventTypeTx(tx, ctx.tenantId, p.kind);
  if (!resolved) throw new Error('Unknown movement event type.');
  if (!resolved.active && !opts?.allowInactive) {
    throw new Error(
      `That movement event type has been switched off in Movement Settings, so it cannot be used to ${verb} a movement.`,
    );
  }
  return { ...p, kind: resolved.behaviourKind, typeCode: resolved.code };
}

/**
 * The single New Event entry point. Delegates every kind to the existing audited writer, so effective-
 * date semantics deliberately MATCH those writers (e.g. setEmploymentAssignment rejects dates before the
 * current record's validFrom — the error is surfaced verbatim). Admin-gated as defence-in-depth over
 * each writer's own gate/RLS.
 *
 * 08913328 — the COMPARISON kinds branch off to applyComparisonMovement (the Current/After screen);
 * what follows is the lifecycle set, which has no meaningful before/after grid. Effective dating is
 * still the writers': `assignment` and `compensation` are dated, so a future-dated movement leaves an
 * earlier payroll period alone; the flat `employment` columns are not dated and apply on save (a
 * scheduling engine remains out of scope).
 *
 * Secondment / Acting Position are RECORD-ONLY: they append `employment.movement.recorded` and change no
 * state. NOTE (ADR-0015): subject-scoped events are readable by the employee themselves — like the
 * existing termination reason, movement remarks are staff-visible by design.
 */
export function createMovementEvent(ctx: SessionContext, rawInput: CreateMovementInput) {
  return withTenant(ctx,tx=>createMovementEventTx(tx,ctx,rawInput));
}

/** Canonical dispatcher in a caller-owned transaction; every writer/ledger leg shares this Tx. */
export async function createMovementEventTx(tx:Tx,ctx:SessionContext,rawInput:CreateMovementInput){
  rawInput = { ...rawInput };
  await assertWorkforceEmploymentTx(tx,ctx,rawInput.employmentId,'maintain');
  // The tenant catalogue resolves custom codes to their actual effect. Own configuration before
  // that resolution and before current-state planning, not merely when the termination leg writes.
  await lockLeaveDependencyConfigurationTx(tx, ctx.tenantId);
  return dispatchMovementEventTx(tx,ctx,rawInput);
}

/** Private admission data never comes from a form or caller-supplied baseline. */
async function dispatchMovementEventTx(tx:Tx,ctx:SessionContext,rawInput:CreateMovementInput,futureAdmission?:{baseline?:MovementCurrentState;capture?:(baseline:MovementCurrentState)=>void;expectedBehaviour?:string},correction?:{fromGroupId:string|null}){
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new Error('Only an admin can record a movement.');
  }
  // 476f23ed — resolve the submitted event type through the tenant's CATALOGUE before anything else. A
  // built-in kind resolves to itself; one of the organisation's own types resolves to the behaviour it was
  // mapped to, and its code travels on as `typeCode` so the ledger records what HR chose. A type that was
  // switched off is refused here rather than silently applied — that is the whole point of switching it off.
  const p = await resolveInputTypeTx(tx, ctx, rawInput, 'record');
  if(futureAdmission?.expectedBehaviour!==undefined&&p.kind!==futureAdmission.expectedBehaviour)throw new Error('preview_stale_revalidate');
  const execute=async()=>{
  if (p.kind !== 'blacklist' && !/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveDate ?? '')) {
    throw new Error('A valid effective date (YYYY-MM-DD) is required.');
  }
  // 08913328 — the comparison kinds all go through ONE diff-driven writer; only genuine deltas are
  // written, so an untouched field can never fabricate an assignment version or a history row.
  if (isComparisonKind(p.kind)) {
    if (p.kind === 'employmentTypeChange' && !p.employmentType) {
      throw new Error('Select the new employment type.');
    }
    // b7b22514 — refused HERE as well as inside movementDeltas, because this is the message HR reads on a
    // FUTURE-dated transfer: scheduleMovementTx and applyComparisonMovementTx both diff, but only one of
    // them runs, and a destination missing at keying time must not be discovered by the sweep in July.
    if (p.kind === 'entityTransfer' && !p.companyId) {
      throw new Error('Select the company this employee is transferring to.');
    }
    // 941c9dac — the effective-date fork. A movement dated TODAY OR IN THE PAST applies immediately on
    // save (the reporter specified this explicitly: it must not wait for the next sweep). A movement
    // dated in the FUTURE is recorded as a pending intent and applies on the morning of its date.
    const today = todayInKualaLumpur();
    // 1d58019a Step 2 (ADR-0166) — the type's Field Controls and its supporting documents, checked HERE, in
    // the writer every create path shares (the New Event form, the import, the rehearsal), against the same
    // baseline the write below diffs against. The sweep and an older correction's replay do not come through
    // here: a rule never re-judges a movement already recorded.
    const future = p.effectiveDate > today;
    const carriedFields = correction ? await correctionDocumentFieldsTx(tx, ctx, p, correction.fromGroupId) : [];
    const documents = await assertMovementFieldRulesTx(tx, ctx, p, carriedFields, () =>
      future && futureAdmission?.baseline ? Promise.resolve(futureAdmission.baseline) : currentStateTx(tx, p.employmentId),
    );
    const written = future
      ? await scheduleMovementTx(tx, ctx, p, p.kind as ComparisonKind, futureAdmission)
      : await applyComparisonMovementTx(tx, ctx, p, p.kind);
    if (correction) await storeCorrectionDocumentsTx(tx, ctx, p.employmentId, correction.fromGroupId, written.groupId, carriedFields, documents);
    else if (documents.length) await saveMovementAttachmentsTx(tx, ctx, p.employmentId, written.groupId, documents);
    return written;
  }
  // Only comparison types take supporting documents (Field Controls are per comparison field).
  if (p.documents?.length) throw new MovementDocumentError('This event type does not take supporting documents.');

  const remarks = p.remarks?.trim() || null;
  const endDate = p.endDate?.trim() || null;

  // 3ced1040 — the `confirmation` case that stood here is GONE, not moved. It wrote the date through
  // setEmploymentInfo and nothing else; Confirmation is a comparison kind now, so this switch is never
  // reached for it and leaving the case behind would be a second writer that only a future refactor
  // would discover was dead. The two remaining date movements below keep their cases: neither is a
  // comparison kind, because each moves exactly one date and a Current/After grid would just restate it.
  switch (p.kind) {
    // 89ea527b — Join Date Change: the employee's commencement date with the CURRENT employing company moves
    // (internal company transfer, rehire into another group company, restructure). The effective date IS the
    // new Join Date. The Group Join Date is deliberately untouched — group service continues across the move,
    // which is the whole point of keeping the two dates apart.
    case 'joinDateChange':
      return setEmploymentInfo(ctx, {
        employmentId: p.employmentId,
        joinDate: p.effectiveDate,
        movement: { type: 'joinDateChange', remarks, groupId: randomUUID() },
      },tx);

    // 89ea527b — Group Join Date Correction: the authorized historical-data correction of the master service
    // date. This is the ONLY route to hired_on after creation, and it MOVES LEAVE ENTITLEMENT (service bands
    // read hired_on), so it is deliberately its own event type rather than a field on another movement — an
    // entitlement change should never be a side effect of a transfer someone recorded for another reason.
    case 'groupJoinDateCorrection':
      return setEmploymentInfo(ctx, {
        employmentId: p.employmentId,
        hiredOn: p.effectiveDate,
        movement: { type: 'groupJoinDateCorrection', remarks, groupId: randomUUID() },
      },tx);

    case 'probationExtension':
      if(!isCalendarDate(p.effectiveDate))throw new Error('A valid effective date (YYYY-MM-DD) is required.');
      if (!endDate) throw new Error('An extended confirmation (new probation end) date is required.');
      return setEmploymentInfo(ctx, {
        employmentId: p.employmentId,
        extendedConfirmationDate: endDate,
        movement: { type: 'probationExtension', remarks, endDate, effectiveDate:p.effectiveDate, groupId: randomUUID() },
      },tx);

    case 'resignation':
      return recordResignationMovementTx(tx,ctx,p);

    // ae9350f2 — Termination. Validated once, then either applied now or scheduled for its effective date;
    // see the "Termination" section above for why a future-dated one must not write anything today.
    case 'termination': {
        const plan = await planTerminationTx(tx, ctx, p, 'create');
        await assertTerminationReasonOfferedTx(tx, ctx.tenantId, plan.reasonCode);
        // 1d58019a Step 2 — and the reasons THIS Termination type offers (no list = every active reason).
        await assertTerminationReasonOfferedForTypeTx(tx, ctx.tenantId, plan.typeCode, plan.reasonCode);
        return plan.effectiveDate > todayInKualaLumpur()
          ? scheduleTerminationTx(tx, ctx, p.employmentId, plan)
          : applyTerminationTx(tx, ctx, p.employmentId, plan);
      }

    case 'blacklist':
      return setEmploymentBlacklist(ctx, {
        employmentId: p.employmentId,
        blacklisted: p.blacklisted ?? true,
        reason: remarks,
      },tx);

    case 'secondment':
    case 'actingPosition': {
        const [emp] = await tx
          .select({ id: employment.id })
          .from(employment)
          .where(eq(employment.id, p.employmentId))
          .limit(1);
        if (!emp) throw new Error('Employment not found');
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'employment',
          aggregateId: p.employmentId,
          eventType: 'employment.movement.recorded',
          actor: actorOf(ctx),
          subjectEmploymentId: p.employmentId,
          payload: { type: p.typeCode ?? p.kind, effectiveDate: p.effectiveDate, endDate, remarks },
        });
        return { employmentId: p.employmentId };
      }
  }
  };
  const result=await execute();
  if(!result)throw new Error('Unsupported movement event type.');
  return {...result,behaviourKind:p.kind};
}

/** A single ordered create function; no caller can pass a comparison baseline or replay token. */
export type MovementSequenceCreate = (input: CreateMovementInput) => ReturnType<typeof createMovementEventTx>;
const MOVEMENT_SEQUENCE_MAX = 20;
const sequenceInputKey = (input: CreateMovementInput) => JSON.stringify(Object.entries(input).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)));

/**
 * Rehearse at most twenty events for ONE employee, ALWAYS rolling the nested savepoint back. The caller
 * may advance scheduled intents and required leave effects only through canonical owners on shadowTx.
 * The returned replay function lives only inside this same outer transaction/context. It accepts only
 * the exact immutable inputs, once and in order; failed rehearsal never returns it. Only this owner
 * captures future comparison baselines, and they affect admission/conflict fields, never current masters.
 */
export async function rehearseMovementSequenceTx<T>(tx:Tx,ctx:SessionContext,prepare:(shadowTx:Tx,create:MovementSequenceCreate)=>Promise<T>){
  // Acquire in the OUTER transaction so rehearsal rollback cannot release dependency ownership
  // before the bounded replay. Access precedes configuration, including the callback's source reads.
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  await lockLeaveDependencyConfigurationTx(tx, ctx.tenantId);
  const contextKey=()=>JSON.stringify({tenantId:ctx.tenantId,userId:ctx.userId,roles:ctx.roles,grants:ctx.grants});
  const originalContext=contextKey();
  const transactionIdentity=()=>tx.execute<{id:string;session:string}>(sql`select pg_current_xact_id()::text as id, concat_ws('|',current_setting('app.tenant_id',true),current_setting('app.user_id',true),current_setting('app.roles',true),current_setting('app.grants',true)) as session`);
  const [transaction]=await transactionIdentity();
  const plans:{input:CreateMovementInput;key:string;baseline?:MovementCurrentState;behaviour:string}[]=[];
  let subject:string|undefined,previousDate:string|undefined,preparing=false,inFlight=false,failed=false;
  class RehearsalRollback extends Error{constructor(readonly value:T){super('movement_sequence_rehearsal_rollback');}}
  let value:T;
  try{
    await tx.transaction(async shadowTx=>{
      preparing=true;
      const create:MovementSequenceCreate=async input=>{
        if(!preparing)throw new Error('movement_sequence_not_available');
        if(inFlight||failed){failed=true;throw new Error('movement_sequence_not_available');}
        inFlight=true;
        try{
          if(plans.length>=MOVEMENT_SEQUENCE_MAX)throw new Error('too_many_employee_rows');
          if(subject!==undefined&&input.employmentId!==subject)throw new Error('movement_sequence_employee_changed');
          if(previousDate!==undefined&&input.effectiveDate<previousDate)throw new Error('movement_sequence_order_changed');
          const frozen=Object.freeze({...input});let baseline:MovementCurrentState|undefined;
          const result=await dispatchMovementEventTx(shadowTx,ctx,frozen,{capture:current=>{baseline=Object.freeze({...current});}});
          plans.push({input:frozen,key:sequenceInputKey(frozen),baseline,behaviour:result.behaviourKind});subject=frozen.employmentId;previousDate=frozen.effectiveDate;
          return result;
        }catch(error){failed=true;throw error;}finally{inFlight=false;}
      };
      try{
        const prepared=await prepare(shadowTx,create);
        if(failed||inFlight)throw new Error('movement_sequence_rehearsal_failed');
        throw new RehearsalRollback(prepared);
      }finally{preparing=false;}
    });
    throw new Error('movement_rehearsal_did_not_rollback');
  }catch(error){if(!(error instanceof RehearsalRollback))throw error;value=error.value;}
  let next=0,replaying=false,replayFailed=false;
  const replay:MovementSequenceCreate=async input=>{
    if(replaying||replayFailed||next>=plans.length)throw new Error('movement_sequence_not_available');
    replaying=true;
    try{
      const plan=plans[next];
      if(sequenceInputKey(input)!==plan.key)throw new Error('movement_sequence_input_changed');
      if(contextKey()!==originalContext)throw new Error('movement_sequence_context_changed');
      const [current]=await transactionIdentity();
      if(!transaction||current?.id!==transaction.id)throw new Error('movement_sequence_transaction_ended');
      if(current.session!==transaction.session)throw new Error('movement_sequence_context_changed');
      next++; // Once only, even if the writer refuses; caller must abort the outer employee transaction.
      return await dispatchMovementEventTx(tx,ctx,plan.input,{baseline:plan.baseline,expectedBehaviour:plan.behaviour});
    }catch(error){replayFailed=true;throw error;}finally{replaying=false;}
  };
  return {value,replay};
}

// ───────────── Scheduled application — 941c9dac ─────────────

/** What one employment's due-movement pass did. `noop` counts movements that arrived to find their
 *  values already in place — they still get an applied event, so they never retry. */
export type ApplyDueResult = {
  applied: number;
  noop: number;
  /**
   * 9e2a89e9 — the LATEST effective date among the movements this pass actually applied, or null when it
   * applied none. The sweep hands it to the entitlement recalc so a future-dated promotion's history row
   * reads the date it took effect rather than the morning the cron happened to run — which on a job that
   * has not run for a few days are different dates.
   *
   * The MAXIMUM, computed, never "the last row of the loop": several movements can come due together and
   * the one whose date the correction belongs to is the most recent of them.
   */
  appliedEffectiveDate: string | null;
};

/**
 * 941c9dac — apply every PENDING movement of one employment whose effective date has arrived.
 *
 * APPLY-ONCE IS A PROPERTY OF THE DATA, NOT OF THE SCHEDULER. Nothing here counts runs or remembers that
 * it fired. A movement is due iff the ledger says it is: `employment.movement.scheduled` with no
 * `employment.movement.applied` and no `employment.movement.reversed` referring to it, and not superseded
 * by a conflicting arrival. Applying appends the applied event, which removes it from that set forever.
 * So running this twice on the same morning — or five times, or after a crash halfway through — converges
 * on the same state, because the second pass simply finds nothing due. Migration 0329 backs that with a
 * partial UNIQUE INDEX on (tenant_id, payload->>'scheduledId') for applied events, so even two concurrent
 * sweeps cannot both write the application: the loser gets a unique violation and its transaction rolls
 * back whole, legs included.
 *
 * Movements are applied oldest-effective-date first so a backlog (a sweep that did not run for days)
 * lands in the order HR intended.
 */
export async function applyDueMovementsTx(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  today: string,
): Promise<ApplyDueResult> {
  await assertWorkforceEmploymentTx(tx,ctx,employmentId,'maintain');
  await lockLeaveDependencyConfigurationTx(tx, ctx.tenantId);
  const { events, rows, statusOf } = await projectRows(tx, ctx.tenantId, employmentId, today);
  const due = rows
    .filter((r) => r.scheduled && r.effectiveDate <= today && statusOf(r) === 'pending')
    .sort((a, b) =>
      a.effectiveDate === b.effectiveDate ? a.sequence - b.sequence : a.effectiveDate < b.effectiveDate ? -1 : 1,
    );

  let applied = 0;
  let noop = 0;
  let appliedEffectiveDate: string | null = null;
  for (const r of due) {
    const ev = events.find((e) => e.id === r.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = (ev?.payload ?? {}) as Record<string, any>;
    // Without the groupId the legs could not be tied back to this row and the movement would sprout a
    // duplicate history line. Refuse rather than corrupt the history.
    if (!r.groupId) continue;
    // ae9350f2 — Termination is the one scheduled kind that is not a comparison kind. It has its own
    // writer (two legs, no Current/After deltas), so it is dispatched explicitly rather than being let
    // through the comparison path, which would compute deltas for fields a termination never moves.
    // 476f23ed — the scheduled event records the CATALOGUE CODE, which may be one of the organisation's
    // own types. Resolve it back to the behaviour that must run; the code travels on as `typeCode` so the
    // legs the sweep writes stay tagged with the type HR chose. A code that no longer resolves (deleted
    // around the in-use guard) is skipped rather than applied as something else.
    const resolved = await resolveMovementEventTypeTx(tx, ctx.tenantId, r.kind);
    if (!resolved) continue;
    const behaviourKind = resolved.behaviourKind;
    const isTermination = behaviourKind === 'termination';
    const isResignation = behaviourKind === 'resignation';
    if (!isTermination && !isResignation && !isComparisonKind(behaviourKind)) continue;

    const input: CreateMovementInput = {
      ...(payload.input ?? {}),
      employmentId,
      kind: behaviourKind,
      typeCode: resolved.code,
      effectiveDate: r.effectiveDate,
      endDate: r.endDate,
      remarks: r.remarks,
    };

    let changes: MovementChange[] = [];
    try {
      const res = isResignation
        ? await applyResignationMovementTx(tx,ctx,input,{groupId:r.groupId,allSecondary:true})
        : isTermination
        ? await applyTerminationTx(
            tx,
            ctx,
            employmentId,
            await planTerminationTx(tx, ctx, input, 'apply', r.id),
            { groupId: r.groupId, allSecondary: true },
          )
        : await applyComparisonMovementTx(tx, ctx, input, behaviourKind as ComparisonKind, {
            groupId: r.groupId,
            allSecondary: true,
          });
      changes = res.changes;
      applied += 1;
      // ISO dates compare lexicographically; this is the maximum, not the loop's last iteration.
      if (appliedEffectiveDate == null || r.effectiveDate > appliedEffectiveDate) {
        appliedEffectiveDate = r.effectiveDate;
      }
    } catch (e) {
      // The movement arrived to find its values already in place (someone made the same change by hand in
      // the meantime). That is a legitimate outcome, not a failure: record it as applied-with-no-changes
      // so it leaves the due set instead of being retried every morning forever. Any OTHER error is a real
      // problem — rethrow so this employment's transaction rolls back whole and the sweep reports it.
      if (!(e instanceof MovementNoChangeError)) throw e;
      noop += 1;
    }

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: employmentId,
      eventType: 'employment.movement.applied',
      actor: actorOf(ctx),
      subjectEmploymentId: employmentId,
      payload: {
        scheduledId: r.id,
        kind: r.kind,
        effectiveDate: r.effectiveDate,
        /** The day the sweep actually ran it — equal to the effective date on a healthy schedule, later
         *  when the job had not run for a while. Both are worth keeping; only one is inferable. */
        appliedOn: today,
        /** The permanent record of what changed, from what to what. */
        changes,
      },
    });
  }
  return { applied, noop, appliedEffectiveDate };
}

// ───────────── Corrections: Edit + Rollback — 66a63bd6, renamed by 10fcf6df ─────────────
//
// The reporter's answer to decision item 9064cffb picked option (a): a correction is recorded as a VISIBLE
// REVERSAL, never a hard delete. Employment History is a projection over the append-only domain_event ledger
// (ADR-0006 / ADR-0015), so there is nothing here to DELETE — a rollback is a COMPENSATING write, and the
// corrected movement keeps its line in the history, marked reversed.
//
// Undo rules, one per substrate:
//   • the dated tables (assignment, compensation, reporting_line) — supersede the version the movement
//     inserted and extend its predecessor back over the vacated window, so the timeline stays contiguous
//     even when the corrected movement sits in the middle of the chain;
//   • the flat `employment` columns (job grade, Division … Category) — last-write-wins, so they are restored
//     ONLY while the current value is still the one this movement wrote. If a later movement has since moved
//     them, removing this one changes nothing: that IS the replay result, and it is what stops an earlier
//     correction from clobbering a later movement.
//
// Every compensating write is tagged `secondary` — the same mechanism the comparison form already uses to
// keep companion legs off the history — so a rollback never grows a second, contradictory row, while the
// grade / flat-column replays the detail view depends on stay complete in the ledger.

/** Thrown when a correction is asked of a movement this module cannot replay (see REVERSIBLE_EVENT_TYPES). */
export class MovementNotCorrectableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MovementNotCorrectableError';
  }
}

/**
 * bd89ccd8 — a rollback or correction arrived with no reason.
 *
 * THE FIELD WAS ALWAYS THERE AND ALWAYS OPTIONAL, and the measurement is what settles it: of the eleven
 * rollbacks performed on production, TEN recorded no reason at all. `employment.movement.reversed` already
 * carries who and when; without the why it is a record that something was undone by someone, which is not
 * an audit trail — and an audit control nobody fills in is not a control.
 *
 * ENFORCED IN THE SERVICE, not only in the dialog, because the dialog is not the only caller and a UI-only
 * requirement is a suggestion. A CORRECTION is held to the same rule for the same reason: an Edit IS a
 * rollback (reverseMovementTx with `corrected: true`), it appends the identical event with the identical
 * nullable field, and requiring the reason on one but not the other would leave the control routable
 * around by clicking the other button.
 */
export class MovementReasonRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MovementReasonRequiredError';
  }
}

/**
 * 646355e5 — a correction would change a movement that a CLOSED payroll run relied on, and the caller has
 * not confirmed that closed payroll stays as issued. Correcting is allowed (the approved plan); doing it
 * without that explicit acknowledgement is not. `periods` are the closed 'YYYY-MM' months involved.
 */
export class MovementClosedPayrollAcknowledgementError extends Error {
  constructor(readonly periods: string[]) {
    super(
      `Payroll for ${periods.join(', ')} is already closed. Confirm that the closed payroll, released payslips and statutory submissions will not change, then save the correction again.`,
    );
    this.name = 'MovementClosedPayrollAcknowledgementError';
  }
}

function assertMovementAdmin(ctx: SessionContext, what: string): void {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new Error(`Only an admin can ${what}.`);
  }
}

/**
 * 3ced1040 — a correction may re-classify a movement inside its family, never across it (see
 * INTERCHANGEABLE_COMPARISON_KINDS). Confirmation is a comparison kind but its own family of one: turning
 * a Transfer into a Confirmation would move the employee off probation as a side effect of a re-label, and
 * turning a Confirmation into a Transfer would silently drop the date the event exists to record. Same
 * posture, and the same message, as the termination guard.
 *
 * `from` is the row's CATALOGUE CODE and `to` the resolved behaviour kind, which is fine here precisely
 * because Confirmation is not a configurable behaviour: no tenant type can carry it, so its code is always
 * the built-in one.
 */
const crossesConfirmation = (from: string, to: string): boolean =>
  (from === 'confirmation') !== (to === 'confirmation');

/**
 * b7b22514 — the same rule for Entity Transfer, and it needs its own line rather than a widened
 * `crossesConfirmation` because the two exclusions are unrelated facts that happen to share a shape:
 * Confirmation completes probation, Entity Transfer moves a legal entity, and a future third exclusion
 * should read as a third sentence, not as a growing boolean nobody can parse.
 *
 * BOTH DIRECTIONS ARE FAULTS, which is why it is an inequality and not a one-way check. Correcting a plain
 * Transfer INTO an Entity Transfer has no destination company to move to — the form that recorded it never
 * asked for one — so it would either refuse deep inside the writer or, worse, save a company move with no
 * company. Correcting an Entity Transfer OUT of it silently drops the company move the event exists to
 * record, leaving the employee in the destination with a history row that no longer says how they got
 * there. Same posture and same message as the Confirmation and Termination guards beside it.
 */
const crossesEntityTransfer = (from: string, to: string): boolean =>
  (from === 'entityTransfer') !== (to === 'entityTransfer');

/** Undo ONE leg of a movement. `tag` marks every compensating write as a companion of the rollback, so the
 *  projection keeps rendering exactly one row per movement. */
/** 646355e5 — the first day after the last closed payroll month overlapping [from, to), or null. */
async function firstOpenDayAfterClosedTx(tx: Tx, employmentId: string, from: string, to: string | null): Promise<string | null> {
  const closed = (await closedPeriodsTx(tx, employmentId)).filter((period) => overlapsClosedPeriod([period], from, to)).sort();
  return closed.length ? nextMonthStart(closed[closed.length - 1]) : null;
}

/** 646355e5 — where a corrected salary starts: its own date, or the first day after closed months. */
async function salaryStartAfterClosedPayrollTx(tx: Tx, employmentId: string, effectiveDate: string): Promise<string> {
  const firstOpen = await firstOpenDayAfterClosedTx(tx, employmentId, effectiveDate, null);
  return firstOpen && firstOpen > effectiveDate ? firstOpen : effectiveDate;
}

/**
 * 646355e5 — undo a movement's salary record when closed payroll relied on it. The record keeps the
 * closed months it paid (it is shortened, never removed); the previous salary is restored from the first
 * open day for the rest of the window. Returns false when no closed month overlaps (the ordinary undo runs).
 */
async function undoSalaryAfterClosedPayrollTx(tx: Tx, ctx: SessionContext, employmentId: string, id: string, tag: MovementTag): Promise<boolean> {
  const [rec] = await tx.select().from(compensation).where(eq(compensation.id, id)).limit(1);
  const firstOpen = await firstOpenDayAfterClosedTx(tx, employmentId, rec.validFrom, rec.validTo);
  if (!firstOpen) return false;
  if (rec.validTo !== null && rec.validTo <= firstOpen) return true; // paid entirely in closed months
  const [prev] = await tx
    .select()
    .from(compensation)
    .where(and(eq(compensation.employmentId, employmentId), isNull(compensation.supersededAt), eq(compensation.validTo, rec.validFrom)))
    .orderBy(desc(compensation.validFrom))
    .limit(1);
  await tx.update(compensation).set({ validTo: firstOpen }).where(eq(compensation.id, rec.id));
  if (!prev) return true;
  const [restored] = await tx
    .insert(compensation)
    .values({
      tenantId: prev.tenantId,
      employmentId,
      basicSalary: prev.basicSalary,
      currency: prev.currency,
      monthlyAllowance: prev.monthlyAllowance,
      payMode: prev.payMode,
      paymentTerm: prev.paymentTerm,
      rateAmount: prev.rateAmount,
      remarks: prev.remarks,
      validFrom: firstOpen,
      validTo: rec.validTo,
    })
    .returning({ id: compensation.id });
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'compensation',
    aggregateId: restored.id,
    eventType: 'compensation.set',
    actor: actorOf(ctx),
    subjectEmploymentId: employmentId,
    // Same redact-to-reference shape as setCompensation: amounts live on the row, never in the ledger.
    payload: {
      employmentId,
      effectiveFrom: firstOpen,
      fieldsChanged: ['basicSalary'],
      restoredFrom: prev.id,
      shortenedRecord: rec.id,
      movement: { type: tag.type, groupId: tag.groupId, secondary: true },
    },
  });
  return true;
}

/** 646355e5 — one later movement to put back after an older one is corrected. */
type ReplayStep = { movementId: string; label: string; effectiveDate: string; sequence: number; behaviour: string; input: CreateMovementInput };

/**
 * 646355e5 — the later applied movements an older correction steps back over, with the values each one
 * set, read from its own recorded legs (never from today's master data). Refuses — naming the event —
 * when a later movement cannot be replayed exactly (a kind with its own lifecycle, a company move, or a
 * corrected date that would land after it), so nothing is half-corrected.
 */
async function laterReplayPlanTx(
  tx: Tx,
  events: RawEvent[],
  rows: ProjectedRow[],
  statusOf: Awaited<ReturnType<typeof projectRows>>['statusOf'],
  resolvedTypes: Awaited<ReturnType<typeof projectRows>>['resolvedTypes'],
  target: ProjectedRow,
  targetSpanEnd: number,
  correctedDate: string,
): Promise<ReplayStep[]> {
  const steps: ReplayStep[] = [];
  for (const r of rows) {
    if (r.id === target.id || r.reversed || r.scheduled && statusOf(r) !== 'applied') continue;
    const g = groupEventsOf(events, r);
    if (!g.some((e) => STATE_CHANGING_EVENT_TYPES.has(e.eventType))) continue;
    const end = Math.max(...g.map((e) => e.sequence));
    if (end <= targetSpanEnd) continue;
    const behaviour = resolvedTypes.get(recordedMovementKind(r, g))?.behaviourKind ?? null;
    const label = resolvedTypes.get(r.kind)?.label || r.kind;
    const when = r.effectiveDate;
    const replayable =
      behaviour !== null &&
      (isComparisonKind(behaviour) || behaviour === 'resignation') &&
      behaviour !== 'entityTransfer' &&
      correctabilityOf(r, g, true, behaviour).canReverse &&
      !g.some((e) => e.eventType === 'employment.company.transferred');
    if (!replayable) {
      throw new MovementNotCorrectableError(
        `The later ${label} event on ${when} cannot be re-applied automatically. Roll it back first, then correct this event.`,
      );
    }
    if (correctedDate > when) {
      throw new MovementNotCorrectableError(
        `The corrected effective date ${correctedDate} falls after the later ${label} event on ${when}. Keep the date before it, or roll the later event back first.`,
      );
    }
    steps.push({ movementId: r.id, label, effectiveDate: when, sequence: r.sequence, behaviour, input: await replayInputOfTx(tx, r, g, behaviour) });
  }
  return steps.sort((a, b) => (a.effectiveDate === b.effectiveDate ? a.sequence - b.sequence : a.effectiveDate < b.effectiveDate ? -1 : 1));
}

/** The movement input one applied movement represents, rebuilt from its legs' recorded after-values. */
async function replayInputOfTx(tx: Tx, r: ProjectedRow, g: RawEvent[], behaviour: string): Promise<CreateMovementInput> {
  const input: CreateMovementInput & Record<string, unknown> = {
    employmentId: '',
    kind: behaviour,
    typeCode: r.kind,
    effectiveDate: r.effectiveDate,
    endDate: r.endDate,
    remarks: r.remarks,
  };
  for (const e of [...g].sort((a, b) => a.sequence - b.sequence)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (e.payload ?? {}) as Record<string, any>;
    switch (e.eventType) {
      case 'employment.assignment.changed':
        for (const f of ['departmentId', 'positionId', 'businessUnitId', 'locationId', 'employmentType'] as const) {
          if (p.after && f in p.after && p.after[f] !== (p.before ?? {})[f]) input[f] = p.after[f];
        }
        break;
      case 'assignment.transferred':
        if (p.to?.departmentId !== p.from?.departmentId) input.departmentId = p.to?.departmentId ?? null;
        if (p.to?.locationId !== p.from?.locationId) input.locationId = p.to?.locationId ?? null;
        break;
      case 'employment.grade.changed':
        input.gradeId = p.after ?? null;
        break;
      case 'reporting-line.set':
        input.managerEmploymentId = p.managerEmploymentId ?? null;
        break;
      case 'compensation.set': {
        const [row] = await tx
          .select({ basicSalary: compensation.basicSalary, currency: compensation.currency, payMode: compensation.payMode, paymentTerm: compensation.paymentTerm })
          .from(compensation)
          .where(eq(compensation.id, e.aggregateId))
          .limit(1);
        if (!row) throw new MovementNotCorrectableError('A later salary change can no longer be read. Roll it back first, then correct this event.');
        input.basicSalary = Number(row.basicSalary);
        input.currency = row.currency;
        input.payMode = row.payMode;
        input.paymentTerm = row.paymentTerm;
        break;
      }
      case 'employment.info.updated': {
        const fields: string[] = Array.isArray(p.fields) ? p.fields : [];
        for (const f of fields) {
          if ((MOVEMENT_FLAT_FIELDS as readonly string[]).includes(f)) input[f] = p.after?.[f] ?? null;
          if (f === 'tenderResignationDate') input.tenderResignationDate = p.after?.[f] ?? null;
          if (f === 'resignationDate') input.resignationEffectiveDate = p.after?.[f] ?? null;
          if (f === 'lastWorkingDate' && behaviour === 'resignation') input.endDate = p.after?.[f] ?? null;
        }
        break;
      }
    }
  }
  return input;
}

/** Re-apply the stepped-back movements, oldest first, through the writers that recorded them. A later
 *  movement that would no longer change anything, or that a writer now refuses, aborts the correction. */
async function replayLaterMovementsTx(tx: Tx, ctx: SessionContext, employmentId: string, steps: ReplayStep[]) {
  for (const step of steps) {
    const input = { ...step.input, employmentId };
    try {
      if (step.behaviour === 'resignation') await applyResignationMovementTx(tx, ctx, input);
      else await applyComparisonMovementTx(tx, ctx, input, step.behaviour as ComparisonKind);
    } catch (e) {
      if (e instanceof MovementNoChangeError) {
        throw new MovementNotCorrectableError(
          `After this correction, the later ${step.label} event on ${step.effectiveDate} would no longer change anything. Roll it back first, then correct this event.`,
        );
      }
      if (e instanceof Error && !isDatabaseError(e)) {
        throw new MovementNotCorrectableError(`The later ${step.label} event on ${step.effectiveDate} conflicts with this correction: ${e.message}`);
      }
      throw e;
    }
  }
}

async function reverseLegTx(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  e: RawEvent,
  tag: MovementTag,
  /**
   * c063eea9 — the payloads of this employment's `employment.hire.corrected` events. A hire correction
   * that carried a value forward SUPERSEDED the dated row this movement created and re-inserted it with
   * a new id, so `e.aggregateId` can name a row that is no longer live. `liveIncarnationOf` follows the
   * correction's own recorded replacements to the row that stands in for it now; without this the
   * rollback found a superseded row, returned early, and left the movement's version in force.
   */
  hireCorrections: unknown[] = [],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (e.payload ?? {}) as Record<string, any>;
  switch (e.eventType) {
    case 'assignment.transferred':
    case 'employment.assignment.changed': {
      const [row] = await tx
        .select()
        .from(assignment)
        .where(
          and(
            eq(assignment.id, liveIncarnationOf(e.aggregateId, hireCorrections)),
            eq(assignment.employmentId, employmentId),
          ),
        )
        .limit(1);
      if (!row || row.supersededAt) return;
      const [prev] = await tx
        .select({ id: assignment.id })
        .from(assignment)
        .where(
          and(
            eq(assignment.employmentId, employmentId),
            isNull(assignment.supersededAt),
            eq(assignment.validTo, row.validFrom),
          ),
        )
        // A movement dated on the day the previous version started leaves a zero-length row, so two
        // versions can share this validTo. The LATEST one is the immediate predecessor.
        .orderBy(desc(assignment.validFrom))
        .limit(1);
      // Without a predecessor the employee would be left with no assignment covering the window — refuse
      // rather than roll back into a state the rest of the system cannot represent.
      if (!prev) {
        throw new MovementNotCorrectableError('There is no earlier organisation assignment to roll back to.');
      }
      await tx.update(assignment).set({ supersededAt: new Date() }).where(eq(assignment.id, row.id));
      await tx.update(assignment).set({ validTo: row.validTo }).where(eq(assignment.id, prev.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'assignment',
        aggregateId: row.id,
        eventType: 'employment.assignment.superseded',
        actor: actorOf(ctx),
        subjectEmploymentId: employmentId,
        payload: { employmentId, restoredAssignmentId: prev.id, effectiveDate: row.validFrom, reversalOf: e.id },
      });
      return;
    }

    /**
     * b7b22514 — undo an Entity Transfer's company move.
     *
     * LAST-WRITE-WINS, exactly as the flat columns below: the company is put back only while the stored
     * value is still the one THIS movement wrote. If a later transfer has since moved the employee on
     * again, that transfer owns the column and rolling this one back must not reach past it — the same
     * rule, for the same reason, as `employment.info.updated`'s per-field check.
     *
     * The reversal restores the company-scoped defaults to null rather than to their pre-transfer values,
     * and that is deliberate: the transfer cleared them because they pointed at the OLD company, and their
     * old values are exactly what the employee is going back to — but they are resolved per-company at
     * render, so null re-resolves correctly and a restored stale id would not. changeEmploymentCompany
     * nulls them on the same reasoning.
     *
     * NOT re-checked for cross-company coherence. Going back is going back to a state that was coherent
     * when it was left, and the assignment / reporting-line legs of the same movement are reversed by their
     * own cases in this switch, from their own stored before-values, inside this transaction.
     *
     * The compensating event is UNTAGGED, like `employment.assignment.superseded` and
     * `reporting-line.reverted` beside it. A movement tag would put it in the reversed movement's own
     * group, and REVERSIBLE_EVENT_TYPES is an allowlist over the whole group — so the movement would
     * become uncorrectable BY BEING CORRECTED. The as-of replay does not need a tag; it walks sequences.
     */
    case 'employment.company.transferred': {
      const before = (p.before ?? {}) as Record<string, unknown>;
      const after = (p.after ?? {}) as Record<string, unknown>;
      const restoreTo = (before.companyId as string | undefined) ?? null;
      if (!restoreTo) return;
      const [emp] = await tx
        .select({ companyId: employment.companyId })
        .from(employment)
        .where(eq(employment.id, employmentId))
        .limit(1);
      if (!emp || emp.companyId !== (after.companyId as string | undefined)) return;
      // The actor must administer the company the employee is going BACK to — the same WITH CHECK the
      // forward move trips, asked in advance so the rollback fails with a sentence rather than an RLS error.
      const adminRes = await tx.execute(sql`select app.is_admin_for(${restoreTo}::uuid) as ok`);
      if (!(adminRes as unknown as { ok: boolean }[])[0]?.ok) {
        throw new MovementNotCorrectableError(
          'You can only roll this transfer back if you manage the company the employee came from.',
        );
      }
      await tx
        .update(employment)
        .set({ companyId: restoreTo, payrollPolicyId: null, costAllocation: null })
        .where(eq(employment.id, employmentId));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'employment',
        aggregateId: employmentId,
        eventType: 'employment.company.transfer.reverted',
        actor: actorOf(ctx),
        subjectEmploymentId: employmentId,
        payload: {
          employmentId,
          before: { companyId: after.companyId ?? null },
          after: { companyId: restoreTo },
          reversalOf: e.id,
        },
      });
      return;
    }

    case 'employment.grade.changed': {
      const [emp] = await tx
        .select({ gradeId: employment.gradeId })
        .from(employment)
        .where(eq(employment.id, employmentId))
        .limit(1);
      if (!emp || (emp.gradeId ?? null) !== ((p.after as string | null) ?? null)) return;
      await setEmploymentGrade(ctx, { employmentId, gradeId: (p.before as string | null) ?? null, movement: tag }, tx);
      return;
    }

    case 'compensation.set': {
      const [row] = await tx
        .select({ id: compensation.id, supersededAt: compensation.supersededAt })
        .from(compensation)
        .where(and(eq(compensation.id, e.aggregateId), eq(compensation.employmentId, employmentId)))
        .limit(1);
      if (!row || row.supersededAt) return;
      // 646355e5 — behind an acknowledged closed payroll the record those months were paid on is never
      // removed (migration 0277 guard). The undo starts on the first day after the closed months instead.
      if (hasClosedPayrollCorrectionAuthorityTx(tx, employmentId) && (await undoSalaryAfterClosedPayrollTx(tx, ctx, employmentId, row.id, tag))) return;
      // The Basic Salary card's own writer: it reopens the previous salary window and re-runs the
      // closed-payroll refusal as a backstop under the guard this module already applied.
      await supersedeCompensation(ctx, { compensationId: row.id, employmentId }, tx);
      return;
    }

    case 'employment.info.updated': {
      const fields: string[] = Array.isArray(p.fields) ? p.fields : [];
      const before = (p.before ?? {}) as Record<string, string | null>;
      const after = (p.after ?? {}) as Record<string, string | null>;
      const [cur] = await tx
        .select({
          orgDivision: employment.orgDivision,
          employmentCategory: employment.employmentCategory,
          orgRegion: employment.orgRegion,
          orgBranch: employment.orgBranch,
          orgTeam: employment.orgTeam,
          orgSection: employment.orgSection,
          orgLine: employment.orgLine,
          orgBase: employment.orgBase,
          confirmationDate: employment.confirmationDate,
          // b7b22514 — read so the join-date restore below can apply the same last-write-wins test the
          // flat columns get: put it back only while the stored value is still the one this movement wrote.
          joinDate: employment.joinDate,
          tenderResignationDate: employment.tenderResignationDate,
          resignationDate: employment.resignationDate,
          lastWorkingDate: employment.lastWorkingDate,
        })
        .from(employment)
        .where(eq(employment.id, employmentId))
        .limit(1);
      if (!cur) return;
      const restore: Partial<Record<MovementFlatField | 'confirmationDate' | 'joinDate' | 'tenderResignationDate' | 'resignationDate' | 'lastWorkingDate', string | null>> = {};
      for (const f of MOVEMENT_FLAT_FIELDS) {
        if (!fields.includes(f)) continue;
        if ((cur[f] ?? null) !== (after[f] ?? null)) continue; // a later movement owns this column now
        restore[f] = before[f] ?? null;
      }
      // 3ced1040 — the confirmation date a Confirmation movement wrote, undone on exactly the same
      // last-write-wins rule as the flat columns above: restore it only while the stored value is still
      // the one THIS movement put there. Clearing it back to null is the normal case (the employee was on
      // probation before), and setEmploymentInfo re-derives finalConfirmationDate from the result, so the
      // employee returns to Probation without this module ever touching a status.
      if (fields.includes('confirmationDate') && (cur.confirmationDate ?? null) === (after.confirmationDate ?? null)) {
        restore.confirmationDate = before.confirmationDate ?? null;
      }
      // b7b22514 — the current-company Join Date an Entity Transfer moved, undone on the identical
      // last-write-wins rule. Without this the company would roll back and the join date would not, leaving
      // the employee in the company they started in but dated from the transfer that no longer exists.
      // setEmploymentInfo accepts it back under this movement's own tag (the reversal carries the same
      // type), so the column still has exactly one writer.
      if (fields.includes('joinDate') && (cur.joinDate ?? null) === (after.joinDate ?? null)) {
        restore.joinDate = before.joinDate ?? null;
      }
      for(const field of ['tenderResignationDate','resignationDate','lastWorkingDate'] as const) {
        if(fields.includes(field)&&(cur[field]??null)===(after[field]??null))restore[field]=before[field]??null;
      }
      if (Object.keys(restore).length) {
        await withExitDateAuthorityTx(tx,employmentId,()=>setEmploymentInfo(ctx, { employmentId, ...restore, movement: tag }, tx));
      }
      return;
    }

    case 'reporting-line.set': {
      const [row] = await tx
        .select()
        .from(reportingLine)
        .where(
          and(
            eq(reportingLine.id, liveIncarnationOf(e.aggregateId, hireCorrections)),
            eq(reportingLine.subordinateEmploymentId, employmentId),
          ),
        )
        .limit(1);
      if (!row || row.supersededAt) return;
      await tx.update(reportingLine).set({ supersededAt: new Date() }).where(eq(reportingLine.id, row.id));
      const [prev] = await tx
        .select({ id: reportingLine.id })
        .from(reportingLine)
        .where(
          and(
            eq(reportingLine.subordinateEmploymentId, employmentId),
            eq(reportingLine.lineType, row.lineType),
            isNull(reportingLine.supersededAt),
            eq(reportingLine.validTo, row.validFrom),
          ),
        )
        .orderBy(desc(reportingLine.validFrom))
        .limit(1);
      if (prev) await tx.update(reportingLine).set({ validTo: row.validTo }).where(eq(reportingLine.id, prev.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'reporting-line',
        aggregateId: row.id,
        eventType: 'reporting-line.reverted',
        actor: actorOf(ctx),
        subjectEmploymentId: employmentId,
        payload: {
          subordinateEmploymentId: employmentId,
          restoredReportingLineId: prev?.id ?? null,
          reversalOf: e.id,
        },
      });
      return;
    }

    case 'employment.terminated': {
      // 646355e5 — undo the termination leg; its exit-dates leg (a higher sequence) was undone first.
      await reverseTerminationTx(tx, ctx, {
        employmentId,
        terminationDate: String(p.terminationDate),
        terminatedAt: e.occurredAt,
        movement: tag,
        reversalOf: e.id,
      });
      return;
    }

    case 'employment.movement.recorded':
      // Record-only (Secondment / Acting Position): it changed no state, so the reversal event alone is
      // the whole rollback.
      return;

    case 'employment.movement.scheduled':
      // 941c9dac — the scheduling event never wrote anything itself. Cancelling a PENDING movement is
      // therefore the reversal event alone, and that is also what stops the sweep picking it up (the
      // sweep skips any scheduled movement carrying a reversal). Cancelling an APPLIED one still undoes
      // real state — through the legs the sweep wrote, which are separate members of this same group and
      // are reversed by the cases above from their own stored before-values.
      return;
  }
}

/** ac6645ec — read-only: why this movement cannot be rolled back right now (null when it can). Runs the
 *  very guards the rollback applies, so an import revert's preview and its commit cannot disagree. */
export async function movementReversalBlockerTx(tx: Tx, ctx: SessionContext, employmentId: string, movementId: string): Promise<string|null> {
  try { await reversalGuardTx(tx, ctx, employmentId, movementId); return null; }
  catch (error) { if (error instanceof Error && !('query' in error) && !('cause' in error) && error.name !== 'DrizzleQueryError') return error.message; throw error; }
}

/** ac6645ec — the ledger position before an import records one movement; with movementRowsAfterSequenceTx
 *  it captures exactly the history rows (movement ids) that movement created. */
export async function movementLedgerMarkerTx(tx: Tx, ctx: SessionContext, employmentId: string): Promise<number> {
  const [row] = await tx.select({ max: sql<string|null>`max(${domainEvent.sequence})` }).from(domainEvent).where(and(eq(domainEvent.tenantId, ctx.tenantId), eq(domainEvent.subjectEmploymentId, employmentId)));
  return Number(row?.max ?? 0);
}
export async function movementRowsAfterSequenceTx(tx: Tx, ctx: SessionContext, employmentId: string, afterSequence: number) {
  const { rows } = await projectRows(tx, ctx.tenantId, employmentId);
  return rows.filter((r) => r.sequence > afterSequence).map((r) => ({ id: r.id, kind: r.kind, effectiveDate: r.effectiveDate, scheduled: r.scheduled }));
}

/** ac6645ec — a whole-import revert rolls each movement back through the one rollback body, with its reason. */
export async function reverseMovementForImportTx(tx: Tx, ctx: SessionContext, employmentId: string, movementId: string, reason: string, opts?: { acknowledgeClosedPayroll?: boolean }) {
  assertMovementAdmin(ctx, 'roll back a movement');
  if (!reason.trim()) throw new MovementReasonRequiredError('A reason is required. Record why this movement event is being rolled back.');
  await assertWorkforceEmploymentTx(tx, ctx, employmentId, 'maintain');
  await lockLeaveDependencyConfigurationTx(tx, ctx.tenantId);
  // 646355e5 slice C — an import Delete row behind closed payroll enters the same authority as the Roll Back
  // dialog, and only when the import's confirmation box was ticked. A whole-import revert never passes it.
  const run = () => reverseMovementTx(tx, ctx, employmentId, movementId, reason.trim(), false);
  if (opts?.acknowledgeClosedPayroll === true) await withClosedPayrollCorrectionAuthorityTx(tx, employmentId, run);
  else await run();
}

/**
 * 646355e5 slice C — read-only: the movement as recorded, for an import Update to overlay only the cells HR
 * filled in. Values come from the movement's own legs (replayInputOfTx), never from today's master data, so a
 * blank cell keeps the event's value rather than clearing it. `input` is null when this module cannot rebuild
 * the movement's values (the caller refuses the row); `kind` is the catalogue code, as a form would post it.
 */
export async function movementCorrectionBaseTx(tx: Tx, ctx: SessionContext, employmentId: string, movementId: string) {
  const { events, rows, statusOf, resolvedTypes } = await projectRows(tx, ctx.tenantId, employmentId);
  const row = rows.find((r) => r.id === movementId);
  if (!row) return null;
  const g = groupEventsOf(events, row);
  const recordedKind = recordedMovementKind(row, g);
  const behaviour = resolvedTypes.get(recordedKind)?.behaviourKind ?? null;
  const status = statusOf(row);
  const plain: CreateMovementInput = { employmentId, kind: recordedKind, effectiveDate: row.effectiveDate, endDate: row.endDate, remarks: row.remarks };
  let input: CreateMovementInput | null = null;
  if (behaviour && row.kind !== 'hired' && !row.reversed && status !== 'superseded') {
    // A pending movement wrote nothing: its values are the saved intent, read exactly as the Edit retains them.
    if (row.scheduled && status === 'pending') {
      const saved = (events.find((e) => e.id === row.id)?.payload as { input?: unknown } | undefined)?.input;
      const retained: Record<string, unknown> = {};
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const key of MOVEMENT_PENDING_INPUT_FIELDS) {
        const value: unknown = Reflect.get(saved, key);
        if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) retained[key] = value;
      }
      input = { ...retained, ...plain } as CreateMovementInput;
    } else if (behaviour === 'secondment' || behaviour === 'actingPosition') input = plain;
    else if (isComparisonKind(behaviour) || behaviour === 'resignation') {
      const { typeCode: _code, ...replayed } = await replayInputOfTx(tx, row, g, behaviour);
      input = { ...replayed, employmentId, kind: recordedKind };
      const moved = g.find((e) => e.eventType === 'employment.company.transferred');
      const to = (moved?.payload as { after?: { companyId?: string } } | undefined)?.after?.companyId;
      if (to) input.companyId = to;
    } else if (behaviour === 'termination') {
      const leg = g.find((e) => e.eventType === 'employment.terminated')?.payload as { terminationReasonCode?: string | null; terminationNoticeDays?: number | null } | undefined;
      const info = g.find((e) => e.eventType === 'employment.info.updated')?.payload as { after?: { tenderResignationDate?: string | null } } | undefined;
      if (leg) input = { ...plain, terminationReasonCode: leg.terminationReasonCode ?? null, terminationNoticeDays: leg.terminationNoticeDays ?? null, resignationDate: info?.after?.tenderResignationDate ?? null };
    }
  }
  // `recorded` is the bare movement (type, dates, remarks) for kinds whose effect IS their date (Join Date
  // Change, Probation Extension …); an import revert re-records a deleted movement from `input ?? recorded`.
  return { id: row.id, kind: recordedKind, displayKind:row.kind, behaviour, effectiveDate: row.effectiveDate, status, reversed: !!row.reversed, scheduled: row.scheduled, input, recorded: plain };
}

/** The rollback guards, shared by the rollback and by read-only eligibility checks. */
async function reversalGuardTx(tx: Tx, ctx: SessionContext, employmentId: string, movementId: string) {
  const { events, rows, statusOf, resolvedTypes } = await projectRows(tx, ctx.tenantId, employmentId);
  const row = rows.find((r) => r.id === movementId);
  if (!row) throw new Error('Movement event not found.');
  if (row.reversed) throw new Error('This movement event has already been rolled back.');
  // 941c9dac — a superseded movement never took effect and never will; there is nothing to undo. The
  // service refuses it as well as the UI hiding it, so the affordance and the rule cannot drift apart
  // (the same posture as the payroll-lock guard below).
  if (statusOf(row) === 'superseded') {
    throw new MovementNotCorrectableError(
      'This movement was overtaken by a later one and never took effect, so there is nothing to roll back.',
    );
  }
  const group = groupEventsOf(events, row);
  const c = correctabilityOf(row, group, false, resolvedTypes.get(recordedMovementKind(row, group))?.behaviourKind??null);
  if (!c.canReverse) {
    throw new MovementNotCorrectableError(
      'This event type cannot be rolled back from Employment History — use the screen that records it.',
    );
  }
  // Information-only corrections are independent audited decisions. An earlier rollback must not undo them.
  const protectedFields=new Set<string>();
  for(const event of group){
    if(event.eventType==='employment.grade.changed')protectedFields.add('gradeId');
    if(event.eventType==='employment.company.transferred'){protectedFields.add('companyId');protectedFields.add('joinDate');}
    if(event.eventType==='assignment.transferred'){protectedFields.add('employmentType');protectedFields.add('companyId');}
    if(event.eventType==='employment.info.updated')for(const field of ((event.payload??{}) as {fields?:string[]}).fields??[])protectedFields.add(field);
  }
  if(events.some(event=>event.eventType==='employment.information.corrected'&&event.sequence>row.sequence&&(((event.payload??{}) as {fields?:string[]}).fields??[]).some(field=>protectedFields.has(field)))){
    throw new MovementNotCorrectableError('A later information-only correction protects these details. Review the correction history before changing this movement.');
  }
  const exitDates=row.kind==='resignation'?resignationFinancialDates(group):[];
  let closedPayrollPeriods: string[] = [];
  if (c.stateChanging&&(row.kind!=='resignation'||exitDates.length>0)) {
    const closed = await closedPeriodsTx(tx, employmentId);
    const from=[row.effectiveDate,...exitDates].sort()[0];
    // 646355e5 — a closed run no longer blocks the correction; it requires the caller's explicit
    // acknowledgement, which only the service entry points grant (closed-payroll-correction-authority).
    closedPayrollPeriods = closed.filter((period) => overlapsClosedPeriod([period], from, null)).sort();
    if (closedPayrollPeriods.length && !hasClosedPayrollCorrectionAuthorityTx(tx, employmentId)) {
      throw new MovementClosedPayrollAcknowledgementError(closedPayrollPeriods);
    }
  }
  return { events, row, group, closedPayrollPeriods };
}

/**
 * 646355e5 — before an acknowledged correction behind closed payroll changes anything, retain the issued
 * payslip document metadata through the ADR-0163 owner. Same readiness rule: a payslip whose original
 * metadata can no longer be verified refuses the correction rather than stamping today's master as issued.
 * Payroll transactions and canonical payslip amounts are never touched here.
 */
async function preserveClosedPayrollDocumentsTx(tx: Tx, employmentId: string): Promise<number> {
  const [ready] = await tx.execute<{ ready: boolean }>(sql`select app.information_payroll_ready(${employmentId}::uuid) as ready`);
  if (!ready?.ready) {
    throw new MovementNotCorrectableError(
      'Original historical information cannot be verified after intervening changes. Ask the payroll administrator to reconcile the historical document evidence before correcting this event.',
    );
  }
  const [preserved] = await tx.execute<{ count: number }>(sql`select app.preserve_information_payroll(${employmentId}::uuid) as count`);
  return Number(preserved?.count ?? 0);
}

/** The shared rollback body. `corrected` distinguishes the first half of an Edit from a plain Rollback —
 *  both leave the same visible trace, and the history says which one happened. */
async function reverseMovementTx(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  movementId: string,
  reason: string | null,
  corrected: boolean,
  /** 646355e5 — set when this rollback only steps back so an earlier movement can be corrected; the
   *  movement is replayed right after, and the history links the two. */
  opts?: { replayOf?: string; additionalClosedPayrollPeriods?: string[] },
): Promise<void> {
  const { events, row, group, closedPayrollPeriods:sourceClosedPeriods } = await reversalGuardTx(tx, ctx, employmentId, movementId);
  const closedPayrollPeriods = [...new Set([...sourceClosedPeriods,...(opts?.additionalClosedPayrollPeriods ?? [])])].sort();
  if(closedPayrollPeriods.length && !hasClosedPayrollCorrectionAuthorityTx(tx,employmentId)) throw new MovementClosedPayrollAcknowledgementError(closedPayrollPeriods);
  const snapshotCount = closedPayrollPeriods.length ? await preserveClosedPayrollDocumentsTx(tx, employmentId) : null;
  // Undo the newest leg first: within one movement a later leg can sit on top of an earlier one.
  const tag: MovementTag = { type: row.kind, groupId: randomUUID(), secondary: true };
  const hireCorrections = events.filter((x) => x.eventType === HIRE_CORRECTED_EVENT).map((x) => x.payload);
  for (const e of [...group].sort((a, b) => b.sequence - a.sequence)) {
    await reverseLegTx(tx, ctx, employmentId, e, tag, hireCorrections);
  }
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'employment',
    aggregateId: employmentId,
    eventType: 'employment.movement.reversed',
    actor: actorOf(ctx),
    subjectEmploymentId: employmentId,
    payload: {
      movementId, kind: row.kind, effectiveDate: row.effectiveDate, reason, corrected,
      ...(opts?.replayOf ? { replayOf: opts.replayOf } : {}),
      // 646355e5 — the audit trail of an acknowledged correction behind closed payroll, and the business
      // day the leave owner treats as the correction boundary (assertInformationLeavePeriodTx).
      ...(closedPayrollPeriods.length
        ? { closedPayrollPeriods, closedPayrollAcknowledged: true, closedPayrollCorrectedOn: todayInKualaLumpur(), snapshotCount }
        : {}),
    },
  });
}

/**
 * Rollback. The movement stops applying and everything it changed goes back to what it was immediately
 * before — but the row STAYS in Employment History, marked reversed, with who did it, when and why. That
 * is the approved shape (9064cffb option a): an employment history that can be silently emptied is no
 * longer evidence, and payroll and statutory reporting both lean on it.
 *
 * 10fcf6df — the screen called this Delete until r88. It never deleted anything: the reporter reasonably
 * expected a deletion to leave the employee's details alone, saw them change, and read that as the record
 * being removed without being undone. The affordance is now labelled Roll Back, which is what it does.
 *
 * bd89ccd8 — and the REASON is now compulsory here rather than optional in the dialog (see
 * MovementReasonRequiredError). This is also the path that CANCELS a pending movement: the scheduling
 * event wrote nothing, so its reversal is the reversal event alone and the sweep then skips it. One
 * reversal path, two labels on the screen — a second writer would grow its own copy of the closed-payroll
 * and superseded guards, which is the bug this shape exists to avoid.
 */
export async function reverseMovementEvent(
  ctx: SessionContext,
  p: { employmentId: string; movementId: string; reason?: string | null; acknowledgeClosedPayroll?: boolean },
) {
  assertMovementAdmin(ctx, 'roll back a movement');
  const reason = p.reason?.trim() || null;
  if (!reason) {
    throw new MovementReasonRequiredError('A reason is required. Record why this movement event is being rolled back.');
  }
  return withTenant(ctx, async (tx) => {
    await assertWorkforceEmploymentTx(tx,ctx,p.employmentId,'maintain');
    await lockLeaveDependencyConfigurationTx(tx, ctx.tenantId);
    const run = () => reverseMovementTx(tx, ctx, p.employmentId, p.movementId, reason, false);
    if (p.acknowledgeClosedPayroll === true) await withClosedPayrollCorrectionAuthorityTx(tx, p.employmentId, run);
    else await run();
    return { employmentId: p.employmentId };
  });
}

export type EditMovementInput = CreateMovementInput & {
  movementId: string;
  /** Free-text "reason for the change" (audit-trail requirement 4). bd89ccd8 — MANDATORY since a
   *  correction is a rollback wearing another name; still typed optional so the field can be absent from
   *  the call and refused by the service rather than by the type. */
  reason?: string | null;
  /** 646355e5 — HR confirmed that closed payroll stays as issued. Required only when a closed run relied on
   *  the movement; refused with MovementClosedPayrollAcknowledgementError otherwise. */
  acknowledgeClosedPayroll?: boolean;
};

/**
 * Edit. A correction is a REPLAY, not an in-place patch of the ledger: the movement is rolled back exactly
 * as Delete does it, then re-applied through the SAME writer the New Event comparison form uses — so the
 * corrected movement inherits every guard (label/company coherence, business-unit carry-forward, pay-mode
 * period boundary) instead of a second writer growing its own copy of those bugs.
 *
 * Two rules the shape forces:
 *  • Replaying an UNCHANGED movement is a no-op — nothing is written, not the rollback and not the
 *    re-apply, when the submitted values, dates and remarks all match what is already recorded.
 *  • Only the most recent state-changing movement can be corrected in place, because the re-apply runs
 *    through writers that act on the OPEN dated row. Correcting an older one means rolling back the later
 *    movements first; the message says so rather than silently appending the replay at the end of the chain.
 */
export async function editMovementEvent(ctx: SessionContext, rawEdit: EditMovementInput) {
  assertMovementAdmin(ctx, 'correct a movement');
  return withTenant(ctx, (tx) => editMovementEventTx(tx, ctx, rawEdit));
}

/** 646355e5 slice C — the same correction in a caller-owned transaction (a Movement import Update row). */
export async function editMovementEventTx(outerTx: Tx, ctx: SessionContext, rawEdit: EditMovementInput) {
  assertMovementAdmin(ctx, 'correct a movement');
  // 476f23ed — same catalogue resolution as createMovementEvent, and for the same reason: a correction
  // replays through the same writers, so it has to arrive carrying the same behaviour kind + code pair.
  // An INACTIVE type is allowed here — a movement already recorded under a type since switched off must
  // still be correctable, or switching a type off would strand its history.
  rawEdit = { ...rawEdit };
  return (async (tx: Tx) => {
    await assertWorkforceEmploymentTx(tx,ctx,rawEdit.employmentId,'maintain');
    await lockLeaveDependencyConfigurationTx(tx, ctx.tenantId);
    await lockEmploymentStatutoryOwnerTx(tx, rawEdit.employmentId);
    const resolved = await resolveInputTypeTx(tx, ctx, rawEdit, 'correct', { allowInactive: true });
    const p = resolved.kind === 'blacklist' ? {...resolved,effectiveDate:todayInKualaLumpur()} : resolved;
    if (!isCalendarDate(p.effectiveDate ?? '')) {
      throw new Error('A valid effective date (YYYY-MM-DD) is required.');
    }
    const reason = p.reason?.trim() || null;
    // bd89ccd8 — same rule as a plain rollback, because a correction performs one. Checked before anything
    // is written, alongside the effective-date format, so a half-applied rollback can never commit behind a
    // missing-reason message.
    if (!reason) {
      throw new MovementReasonRequiredError('A reason is required. Record why this movement event is being corrected.');
    }
    const remarks = p.remarks?.trim() || null;
    const endDate = p.endDate?.trim() || null;

    let replay: ReplayStep[] = [];
    let previousBehaviourKind: string | null = null;
    let targetClosedPeriods: string[] = [];
    const correct = async () => {
      const { events, rows, statusOf, today, resolvedTypes } = await projectRows(tx, ctx.tenantId, p.employmentId);
      const row = rows.find((r) => r.id === p.movementId);
      if (!row) throw new Error('Movement event not found.');
      if (row.reversed) throw new Error('This movement event has already been rolled back.');
      if (!resolvedTypes.get(row.kind)) throw new MovementNotCorrectableError('This event type cannot be edited from Employment History — use the screen that records it.');
      const status = statusOf(row);
      // 1d58019a Step 2 — what the RECORDED movement does, from the catalogue. `row.kind` is its code, which
      // for one of the organisation's own Termination types is not the string 'termination'.
      const rowBehaviour = resolvedTypes.get(recordedMovementKind(row, groupEventsOf(events, row)))?.behaviourKind ?? null;
      previousBehaviourKind = rowBehaviour;
      if (p.documents?.length && !isComparisonKind(p.kind)) {
        throw new MovementDocumentError('This event type does not take supporting documents.');
      }
      // A new type/date can reach closed months the ORIGINAL movement never touched. Preserve
      // the issued baseline before the first inverse, even when the original was record-only.
      if (isComparisonKind(p.kind) || ['resignation','termination','joinDateChange','groupJoinDateCorrection'].includes(p.kind)) {
        const proposedFrom = [p.effectiveDate!, ...(['resignation','termination'].includes(p.kind) ? [p.endDate,p.resignationEffectiveDate].filter((date):date is string => !!date) : [])].sort()[0];
        targetClosedPeriods = (await closedPeriodsTx(tx,p.employmentId)).filter(period => overlapsClosedPeriod([period],proposedFrom,null)).sort();
        if (targetClosedPeriods.length) {
          if (!hasClosedPayrollCorrectionAuthorityTx(tx,p.employmentId)) throw new MovementClosedPayrollAcknowledgementError(targetClosedPeriods);
          await preserveClosedPayrollDocumentsTx(tx,p.employmentId);
        }
      }
      // Revision 2: changing a behaviour is an inverse followed by a NEW validated movement,
      // never a relabel of the old ledger row. The private dispatcher owns destination permissions,
      // required fields, company/date rules, scheduling and document controls. Any failure rolls the
      // inverse back as part of this transaction (including when called by an import).
      const interchangeable = rowBehaviour !== null && isComparisonKind(rowBehaviour) && isComparisonKind(p.kind)
        && !crossesConfirmation(rowBehaviour, p.kind) && !crossesEntityTransfer(rowBehaviour, p.kind);
      if (rowBehaviour !== p.kind && !interchangeable) {
        const sourceGroup = groupEventsOf(events, row);
        const eligibility = correctabilityOf(row, sourceGroup, true, rowBehaviour);
        if (status === 'superseded' || !eligibility.canReverse) {
          throw new MovementNotCorrectableError('This event cannot be replaced safely from Movement. Review its recorded history before changing the event type.');
        }
        if (status === 'applied' && (eligibility.stateChanging || !['secondment', 'actingPosition'].includes(p.kind))) {
          const spanEnd = Math.max(...sourceGroup.map(event => event.sequence));
          replay = await laterReplayPlanTx(tx, events, rows, statusOf, resolvedTypes, row, spanEnd, p.effectiveDate!);
          for (const later of [...replay].reverse()) {
            await reverseMovementTx(tx, ctx, p.employmentId, later.movementId, reason, true, {replayOf:p.movementId});
          }
        }
        await reverseMovementTx(tx, ctx, p.employmentId, p.movementId, reason, true, {additionalClosedPayrollPeriods:targetClosedPeriods});
        // Judge the replacement against the state AFTER its inverse, not the mistaken exit.
        const [dates] = await tx.select({hiredOn:employment.hiredOn,terminatedOn:employment.terminatedOn,lastWorkingDate:employment.lastWorkingDate,resignationDate:employment.resignationDate}).from(employment).where(eq(employment.id,p.employmentId));
        if (!dates) throw new Error('Employment not found.');
        if (!['groupJoinDateCorrection','blacklist'].includes(p.kind) && p.effectiveDate! < dates.hiredOn) throw new Error('The replacement event cannot be dated before the employee joined.');
        const remainingExit = [dates.terminatedOn,dates.lastWorkingDate,dates.resignationDate].filter((date):date is string => !!date).sort()[0];
        if (remainingExit && p.effectiveDate! > remainingExit && (isComparisonKind(p.kind) || ['secondment','actingPosition'].includes(p.kind))) throw new MovementNotCorrectableError('The replacement event falls after another recorded exit. Review that event first.');
        const beforeSequence = Math.max(...events.map(event => event.sequence));
        const result = await dispatchMovementEventTx(tx, ctx, {
          ...rawEdit, kind:p.typeCode ?? p.kind,
          remarks:rawEdit.remarks === undefined ? row.remarks : rawEdit.remarks,
          // A replacement has its own required fields; never inherit an unrelated exit/end date.
        }, undefined, {fromGroupId:row.groupId});
        const replaced = await projectRows(tx, ctx.tenantId, p.employmentId);
        const replacement = replaced.rows.filter(item => item.sequence > beforeSequence && recordedMovementKind(item, groupEventsOf(replaced.events,item)) === (p.typeCode ?? p.kind) && !item.reversed)
          .sort((a,b) => b.sequence-a.sequence)[0];
        if (!replacement) throw new MovementNotCorrectableError('The replacement movement could not be verified. No correction was saved.');
        await appendEvent(tx, {
          tenantId:ctx.tenantId, aggregateType:'employment', aggregateId:p.employmentId,
          eventType:'employment.movement.corrected', actor:actorOf(ctx), subjectEmploymentId:p.employmentId,
          payload:{movementId:p.movementId,replacementMovementId:replacement.id,fromType:recordedMovementKind(row, sourceGroup),toType:p.typeCode ?? p.kind,reason},
        });
        return result;
      }

      /** A corrected termination's reason must be one its (possibly re-chosen) type offers — checked only
       *  when the reason or the type changes, so correcting the dates of an older exit never re-judges it. */
      const assertCorrectedReasonTx = async (plan: TerminationPlan, recordedReason: unknown) => {
        if (plan.reasonCode !== recordedReason || plan.typeCode !== row.kind) {
          await assertTerminationReasonOfferedForTypeTx(tx, ctx.tenantId, plan.typeCode, plan.reasonCode);
        }
      };

      /**
       * 941c9dac — correcting a movement that has not taken effect yet.
       *
       * THIS IS THE IN-PLACE-EDIT INTERACTION, RESOLVED. The existing rule (only the most recent
       * state-changing movement may be corrected in place) exists because a correction REPLAYS through
       * writers that act on the OPEN dated row — replaying an older one would append its result on top of
       * the chain instead of in its place. A PENDING movement is outside that rule entirely, because it has
       * written nothing: no dated row, no flat column, nothing for a later movement to sit on top of. So it
       * is always correctable, whatever else has happened since, and correcting it is not a reverse-and-
       * replay at all — it is cancelling one intent and recording another.
       *
       * The converse half matters just as much and is handled in STATE_CHANGING_EVENT_TYPES: because a
       * scheduled event is not state-changing, a pending movement does not count towards
       * latestStateChangingSpanEnd. Keying a future-dated promotion therefore does NOT freeze editing of
       * the movement that is genuinely latest in force today — "latest movement" and "latest APPLIED
       * movement" diverge, and the in-place rule correctly follows the applied one.
       */
      if (row.scheduled && status === 'pending') {
        // A partial correction retains only explicitly saved inputs. Submitted null/value wins;
        // undefined is omission, not permission to replace a future target with today's baseline.
        const payload=events.find(e=>e.id===row.id)?.payload;
        const saved=payload&&typeof payload==='object'&&'input' in payload?payload.input:undefined;
        const retained:Record<string,unknown>={};
        if(saved&&typeof saved==='object'&&!Array.isArray(saved))for(const key of MOVEMENT_PENDING_INPUT_FIELDS){
          const value:unknown=Reflect.get(saved,key);
          if(value===null||typeof value==='string'||typeof value==='number'&&Number.isFinite(value))retained[key]=value;
        }
        const corrected={...retained,...Object.fromEntries(Object.entries(p).filter(([,value])=>value!==undefined)),
          remarks:rawEdit.remarks===undefined?row.remarks:remarks,endDate:rawEdit.endDate===undefined?row.endDate:endDate} as typeof p;
        if(rowBehaviour==='resignation'||p.kind==='resignation'){
          if(rowBehaviour!=='resignation'||p.kind!=='resignation')throw new MovementNotCorrectableError('A correction cannot turn this movement into that event type.');
          await reverseMovementTx(tx,ctx,p.employmentId,p.movementId,reason,true,{additionalClosedPayrollPeriods:targetClosedPeriods});
          return recordResignationMovementTx(tx,ctx,corrected);
        }
        // ae9350f2 — a pending TERMINATION is correctable on exactly the same reasoning, and it has to be:
        // scheduling made `canEdit` true for it (a scheduled event is not state-changing), so without this
        // branch the Edit button would render and the service would refuse it — an affordance that lies.
        // Only termination→termination: turning a pending exit into a transfer, or a transfer into an exit,
        // is recording a different movement, not correcting this one.
        if (rowBehaviour === 'termination' || p.kind === 'termination') {
          if (rowBehaviour !== 'termination' || p.kind !== 'termination') {
            throw new MovementNotCorrectableError('A correction cannot turn this movement into that event type.');
          }
          await reverseMovementTx(tx, ctx, p.employmentId, p.movementId, reason, true, {additionalClosedPayrollPeriods:targetClosedPeriods});
          // Planned AFTER the rollback, so the duplicate-termination rule sees the movement being corrected
          // as already reversed rather than as a second termination competing with itself.
          const plan = await planTerminationTx(tx, ctx, corrected, 'create');
          await assertCorrectedReasonTx(plan, retained.terminationReasonCode);
          return plan.effectiveDate > today
            ? scheduleTerminationTx(tx, ctx, p.employmentId, plan)
            : applyTerminationTx(tx, ctx, p.employmentId, plan);
        }
        if (
          !isComparisonKind(p.kind) ||
          crossesConfirmation(row.kind, p.kind) ||
          crossesEntityTransfer(row.kind, p.kind)
        ) {
          throw new MovementNotCorrectableError('A correction cannot turn this movement into that event type.');
        }
        if (p.kind === 'employmentTypeChange' && !corrected.employmentType) {
          throw new Error('Select the new employment type.');
        }
        await reverseMovementTx(tx, ctx, p.employmentId, p.movementId, reason, true, {additionalClosedPayrollPeriods:targetClosedPeriods});
        // 1d58019a Step 2 — the corrected intent meets its type's Field Controls (against today's values: a
        // pending movement wrote nothing), and keeps the documents it already had.
        const carried = await correctionDocumentFieldsTx(tx, ctx, corrected, row.groupId);
        const pendingDocuments = await assertMovementFieldRulesTx(tx, ctx, corrected, carried, () => currentStateTx(tx, p.employmentId));
        // A correction may also move the date INTO the past — in which case the movement stops being a
        // schedule and applies at once, exactly as keying it fresh with that date would.
        const rewritten = p.effectiveDate > today
          ? await scheduleMovementTx(tx, ctx, corrected, p.kind)
          : await applyComparisonMovementTx(tx, ctx, corrected, p.kind);
        await storeCorrectionDocumentsTx(tx, ctx, p.employmentId, row.groupId, rewritten.groupId, carried, pendingDocuments);
        return rewritten;
      }
      if (status === 'superseded') {
        throw new MovementNotCorrectableError(
          'This movement was overtaken by a later one and never took effect, so there is nothing to correct.',
        );
      }

      const group = groupEventsOf(events, row);
      const spanEnd = group.length ? Math.max(...group.map((e) => e.sequence)) : -1;
      let isLatest = spanEnd === latestStateChangingSpanEnd(events, rows);
      let c = correctabilityOf(row, group, isLatest, resolvedTypes.get(recordedMovementKind(row, group))?.behaviourKind??null);
      // 646355e5 — an OLDER event is corrected by stepping back to it: every later applied movement is
      // rolled back (newest first), this one is corrected as the latest, and the later ones are replayed
      // afterwards in effective-date order from their own recorded values (replayLaterMovementsTx).
      if (!c.canEdit && c.canReverse && c.stateChanging && !isLatest) {
        const asLatest = correctabilityOf(row, group, true, resolvedTypes.get(recordedMovementKind(row, groupEventsOf(events, row)))?.behaviourKind ?? null);
        if (asLatest.canEdit) {
          replay = await laterReplayPlanTx(tx, events, rows, statusOf, resolvedTypes, row, spanEnd, p.effectiveDate!);
          for (const later of [...replay].reverse()) {
            await reverseMovementTx(tx, ctx, p.employmentId, later.movementId, reason, true, { replayOf: p.movementId });
          }
          isLatest = true;
          c = asLatest;
        }
      }
      if (!c.canEdit) {
        throw new MovementNotCorrectableError(
          c.canReverse && c.stateChanging && !isLatest
            ? 'Only the most recent movement can be edited. Roll back the later movements first, then correct this one.'
            : 'This event type cannot be edited from Employment History — use the screen that records it.',
        );
      }

      // 646355e5 — an APPLIED termination: roll it back, then record the corrected one through the same
      // planner and writer the New Event form uses (duplicate-exit and date rules included).
      if (rowBehaviour === 'termination' || p.kind === 'termination') {
        if (rowBehaviour !== 'termination' || p.kind !== 'termination') {
          throw new MovementNotCorrectableError('A correction cannot turn this movement into that event type.');
        }
        const recordedReason = (group.find((e) => e.eventType === 'employment.terminated')?.payload as { terminationReasonCode?: unknown } | undefined)?.terminationReasonCode;
        await reverseMovementTx(tx, ctx, p.employmentId, p.movementId, reason, true, {additionalClosedPayrollPeriods:targetClosedPeriods});
        const plan = await planTerminationTx(tx, ctx, { ...p, remarks: rawEdit.remarks === undefined ? row.remarks : remarks, endDate: rawEdit.endDate === undefined ? row.endDate : endDate }, 'create');
        await assertCorrectedReasonTx(plan, recordedReason);
        return plan.effectiveDate > today
          ? scheduleTerminationTx(tx, ctx, p.employmentId, plan)
          : applyTerminationTx(tx, ctx, p.employmentId, plan);
      }

      if(rowBehaviour==='resignation'||p.kind==='resignation'){
        if(rowBehaviour!=='resignation'||p.kind!=='resignation')throw new MovementNotCorrectableError('A correction cannot turn this movement into that event type.');
        const original=groupEventsOf(events,row).filter(event=>event.eventType==='employment.info.updated').sort((a,b)=>b.sequence-a.sequence)[0];
        const originalAfter=(original?.payload as {after?:Record<string,unknown>})?.after;
        const submitted={...p,endDate:p.endDate===undefined?row.endDate:p.endDate,remarks:rawEdit.remarks===undefined?row.remarks:p.remarks,tenderResignationDate:p.tenderResignationDate===undefined?originalAfter?.tenderResignationDate as string|null|undefined:p.tenderResignationDate,resignationEffectiveDate:p.resignationEffectiveDate===undefined?originalAfter?.resignationDate as string|null|undefined:p.resignationEffectiveDate};
        if(submitted.effectiveDate===row.effectiveDate&&(submitted.endDate?.trim()||null)===row.endDate&&(submitted.remarks?.trim()||null)===row.remarks&&(submitted.tenderResignationDate??null)===(originalAfter?.tenderResignationDate??null)&&(submitted.resignationEffectiveDate??null)===(originalAfter?.resignationDate??null))throw new MovementNoChangeError();
        await reverseMovementTx(tx,ctx,p.employmentId,p.movementId,reason,true,{additionalClosedPayrollPeriods:targetClosedPeriods});
        return recordResignationMovementTx(tx,ctx,submitted);
      }

      // The unchanged-replay no-op, checked BEFORE anything is written — against the same date/remark fields
      // the history shows and the same current values the comparison form pre-filled from.
      // 476f23ed — compare the CATALOGUE CODE, not the behaviour. `row.kind` is what the projection read off
      // the ledger (the code HR chose); `p.kind` has already been resolved to the built-in behaviour by
      // resolveInputType. For a built-in type the two are equal, but for one of the organisation's own types
      // ('regional_assignment' → secondment) comparing them would ALWAYS differ, so an unchanged re-save
      // would slip past this guard and append a spurious reverse + re-record pair to the history.
      const submittedCode = p.typeCode ?? p.kind;
      const datesUnchanged =
        submittedCode === row.kind &&
        p.effectiveDate === row.effectiveDate &&
        endDate === row.endDate &&
        remarks === row.remarks;

      if (!c.stateChanging) {
        // Record-only movement: the rollback has nothing to undo, so the correction is the reversal plus a
        // fresh record carrying the fixed dates / remarks.
        if (datesUnchanged) throw new MovementNoChangeError();
        await reverseMovementTx(tx, ctx, p.employmentId, p.movementId, reason, true, {additionalClosedPayrollPeriods:targetClosedPeriods});
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'employment',
          aggregateId: p.employmentId,
          eventType: 'employment.movement.recorded',
          actor: actorOf(ctx),
          subjectEmploymentId: p.employmentId,
          // 476f23ed — record the CATALOGUE CODE, exactly as createMovementEvent does. The projection reads
          // this field straight back as the history row's kind, so writing the behaviour here would silently
          // re-label a corrected "Regional Assignment" as a plain Secondment.
          payload: {
            type: submittedCode,
            effectiveDate: p.effectiveDate,
            endDate,
            remarks,
            correctionOf: p.movementId,
          },
        });
        return { employmentId: p.employmentId };
      }

      if (
        !isComparisonKind(p.kind) ||
        crossesConfirmation(row.kind, p.kind) ||
        crossesEntityTransfer(row.kind, p.kind)
      ) {
        throw new MovementNotCorrectableError('A correction cannot turn this movement into that event type.');
      }
      if (p.kind === 'employmentTypeChange' && !p.employmentType) {
        throw new Error('Select the new employment type.');
      }
      const cur = await currentStateTx(tx, p.employmentId);
      // Same `undefined = untouched, '' = explicit clear` reading as the dispatcher's delta rule, so the
      // no-op test and the write agree on what "unchanged" means.
      const same = (v: string | null | undefined, curVal: string | null) =>
        v === undefined || (v === null ? null : v.trim() || null) === curVal;
      const valuesUnchanged =
        // b7b22514 — the destination company is part of what a correction can move. Without this line an Edit
        // that changed ONLY the company (the fix for "we transferred them to the wrong entity") would read as
        // an unchanged replay and be refused as a no-op.
        same(p.companyId, cur.companyId) &&
        same(p.departmentId, cur.departmentId) &&
        same(p.positionId, cur.positionId) &&
        same(p.businessUnitId, cur.businessUnitId) &&
        same(p.locationId, cur.locationId) &&
        same(p.gradeId, cur.gradeId) &&
        same(p.managerEmploymentId, cur.managerEmploymentId) &&
        same(p.currency, cur.currency) &&
        same(p.payMode, cur.payMode) &&
        same(p.paymentTerm, cur.paymentTerm) &&
        (!p.employmentType || p.employmentType === cur.employmentType) &&
        (p.basicSalary === undefined || Number(p.basicSalary) === Number(cur.basicSalary ?? NaN)) &&
        MOVEMENT_FLAT_FIELDS.every((f) => same(p[f], cur[f]));
      // 3ced1040 — a Confirmation's own field, the confirmation date, needs no line here: it IS the
      // effective date, so `datesUnchanged` already covers every way it can move.
      if (datesUnchanged && valuesUnchanged) throw new MovementNoChangeError();

      await reverseMovementTx(tx, ctx, p.employmentId, p.movementId, reason, true, {additionalClosedPayrollPeriods:targetClosedPeriods});
      // 1d58019a Step 2 — the corrected movement meets its type's Field Controls, judged against the state
      // the rollback just restored (the same baseline the re-apply diffs against), and keeps its documents.
      const carried = await correctionDocumentFieldsTx(tx, ctx, p, row.groupId);
      const correctedDocuments = await assertMovementFieldRulesTx(tx, ctx, { ...p, remarks, endDate }, carried, () => currentStateTx(tx, p.employmentId));
      try {
        const rewritten = await applyComparisonMovementTx(tx, ctx, { ...p, remarks, endDate }, p.kind);
        await storeCorrectionDocumentsTx(tx, ctx, p.employmentId, row.groupId, rewritten.groupId, carried, correctedDocuments);
        return rewritten;
      } catch (e) {
        // The corrected movement would now change nothing at all — that is a Delete, not an Edit, and the
        // half-applied rollback must not commit behind a message about "no changes to record".
        if (e instanceof MovementNoChangeError) {
          throw new MovementNoChangeError(
            // Revision 2 names removal from active history Delete; the ledger remains append-only.
            'The corrected event would leave nothing changed — use Delete to undo the movement instead.',
          );
        }
        throw e;
      }
    };
    // 646355e5 — the acknowledgement covers the rollback AND the replay: the replay writers refuse a closed
    // window on their own (resignation dates, salary supersede), and the corrected values are the point.
    const correctAndReplay = async () => {
      const corrected = await correct();
      await replayLaterMovementsTx(tx, ctx, p.employmentId, replay);
      return corrected;
    };
    const result = rawEdit.acknowledgeClosedPayroll === true
      ? await withClosedPayrollCorrectionAuthorityTx(tx, p.employmentId, correctAndReplay)
      : await correctAndReplay();
    return {...result,behaviourKind:p.kind,previousBehaviourKind,replayed:replay.length};
  })(outerTx);
}

export type ResignationInformation = Record<typeof RESIGNATION_INFO_FIELDS[number],{
  value:string|null;
  source:{kind:'movement';movementId:string;effectiveDate:string}|{kind:'legacy'}|{kind:'empty'};
}>;
/** View-only current owner effects with per-field provenance. Pending/reversed rows never win.
 * Untagged imported/history values stay visible as legacy; no event is fabricated for them. */
export function resignationInformation(ctx:SessionContext,employmentId:string):Promise<ResignationInformation>{
  return withTenant(ctx,async tx=>{
    await assertWorkforceEmploymentTx(tx,ctx,employmentId,'view');
    const [current]=await tx.select({tenderResignationDate:employment.tenderResignationDate,resignationDate:employment.resignationDate,lastWorkingDate:employment.lastWorkingDate}).from(employment).where(eq(employment.id,employmentId));
    if(!current)throw new Error('Employment not found.');
    const {events,rows,statusOf}=await projectRows(tx,ctx.tenantId,employmentId);
    const eventOwners=new Map<string,ProjectedRow>();
    for(const movement of rows)for(const event of groupEventsOf(events,movement))eventOwners.set(event.id,movement);
    return Object.fromEntries(RESIGNATION_INFO_FIELDS.map(field=>{
      const value=current[field];
      const latest=[...events].reverse().find(event=>{
        if(event.eventType!=='employment.info.updated')return false;
        const payload=event.payload as {fields?:unknown};if(!Array.isArray(payload?.fields)||!payload.fields.includes(field))return false;
        const source=eventOwners.get(event.id),tag=tagOf(event);
        // A compensating companion restores the prior ledger owner; reversed effects do not own today.
        if(tag?.secondary&&!source)return false;
        return !source||statusOf(source)==='applied';
      });
      const source=latest?eventOwners.get(latest.id):undefined;
      const after=(latest?.payload as {after?:Record<string,unknown>})?.after;
      const owner=source&&after?.[field]===value?source:undefined;
      return [field,{value,source:owner?{kind:'movement',movementId:owner.id,effectiveDate:owner.effectiveDate}:value?{kind:'legacy'}:{kind:'empty'}}];
    })) as ResignationInformation;
  });
}
