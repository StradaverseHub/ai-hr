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
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { todayInKualaLumpur } from '../lib/hr-date';
import { withTenant, type SessionContext, type Tx } from '../db/client';
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
  terminateEmployment,
  type EmploymentTypeValue,
  type TerminationType,
} from './org';
import {
  closedPeriodsTx,
  overlapsClosedPeriod,
  processedPeriodsTx,
  setCompensation,
  supersedeCompensation,
} from './comp';

/** The movement kinds HR can CREATE from the New Event form (this round's scoped event set). Rehire and
 *  Custom Event are deliberately excluded (future enhancements per the approved plan). */
export const MOVEMENT_KINDS = [
  'transfer',
  'promotion',
  'demotion',
  'increment',
  'confirmation',
  'probationExtension',
  'secondment',
  'actingPosition',
  'resignation',
  'termination',
  'blacklist',
  'salaryAdjustment',
  'orgAssignmentChange',
  'reportingLineChange',
  'employmentTypeChange',
  // 89ea527b — the two employment-date movements. Both follow the `confirmation` precedent: the movement's
  // EFFECTIVE DATE *is* the new value of the date it sets, so the history row's Effective Date column and the
  // stored column can never disagree. They are the ONLY writers of employment.hired_on / employment.join_date
  // after creation (setEmploymentInfo ignores both fields without the matching tag).
  'joinDateChange',
  'groupJoinDateCorrection',
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

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
  /** A CLOSED payroll run relied on this movement's window — corrections are refused until it is reopened. */
  payrollLocked: boolean;
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
  /** true when the rollback was the first half of an EDIT (reverse + re-apply), false for a plain Delete. */
  corrected: boolean;
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
};

/**
 * 08913328 — the flat `employment` columns the comparison form can move (Division … Category). They are
 * NOT effective-dated, so unlike the MovementSnapshot fields they cannot be reconstructed as-of; their
 * before/after is read back from the movement's own `employment.info.updated` event payload.
 */
export const MOVEMENT_FLAT_FIELDS = [
  'orgDivision',
  'employmentCategory',
  'orgRegion',
  'orgBranch',
  'orgTeam',
  'orgSection',
  'orgLine',
  'orgBase',
] as const;
export type MovementFlatField = (typeof MOVEMENT_FLAT_FIELDS)[number];

export type MovementFlatChange = { field: MovementFlatField; before: string | null; after: string | null };

/** The identity half of a history row (no correction affordances — the detail view never offers them). */
export type MovementRowSummary = Pick<
  MovementHistoryRow,
  'id' | 'kind' | 'effectiveDate' | 'entryDate' | 'status' | 'endDate' | 'remarks' | 'reversed'
>;

export type MovementDetail = {
  row: MovementRowSummary;
  /** Full name of the user who recorded the change; null for SYSTEM/import writes and the synthesized row. */
  actorName: string | null;
  /** When the change was recorded; null for the synthesized Hired row. */
  occurredAt: Date | null;
  /** null = first record (the Hired row renders an After column only). */
  before: MovementSnapshot | null;
  after: MovementSnapshot;
  /** Flat, non-dated columns THIS movement actually moved. Empty when it moved none — the rows are only
   *  rendered when they carry real evidence, so a historical movement never shows today's value as if it
   *  had been part of the change. */
  flatChanges: MovementFlatChange[];
};

/** Thrown when a New Event would change nothing — surfaced verbatim so remarks are never silently lost. */
export class MovementNoChangeError extends Error {
  constructor(message = 'This event would not change anything — there are no changes to record.') {
    super(message);
    this.name = 'MovementNoChangeError';
  }
}

// The event-type allowlist the projection reads. compensation.updated (in-place correction) is
// deliberately EXCLUDED: amounts/remarks are reconstructed from the compensation row at read time, so
// corrections never diverge from the history.
const MOVEMENT_EVENT_TYPES = [
  'employment.hired',
  'assignment.transferred',
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
];

const EXTENDED_PROBATION_FIELDS = ['extendedProbationValue', 'extendedProbationUnit', 'extendedConfirmationDate'];
const RESIGNATION_FIELDS = ['tenderResignationDate', 'lastWorkingDate'];

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
async function projectRows(tx: Tx, tenantId: string, employmentId: string, today = todayInKualaLumpur()) {
  const [emp] = await tx
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

  const events: RawEvent[] = await tx
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
  const compRows = compIds.length
    ? await tx
        .select({ id: compensation.id, remarks: compensation.remarks })
        .from(compensation)
        .where(inArray(compensation.id, compIds))
    : [];
  const compRemarks = new Map(compRows.map((r) => [r.id, r.remarks]));

  let sawHiredEvent = false;
  const rows: ProjectedRow[] = [];
  /** 66a63bd6 — movement id → the rollback that undid it. Applied after the loop: the reversal event is
   *  always later in the ledger than the movement it refers to. */
  const reversals = new Map<string, MovementReversal>();
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
      case 'employment.assignment.changed':
        rows.push({
          ...base,
          // Any known movement kind may now own the assignment leg (a Salary Adjustment that also moves
          // department is one submit on the comparison form); an unknown/legacy tag keeps the factual label.
          kind: isKnownKind(mv?.type) ? mv.type : 'orgAssignmentChange',
          effectiveDate: p.effectiveDate ?? occDate,
          endDate: mv?.endDate ?? null,
          remarks: mv?.remarks ?? null,
        });
        break;
      case 'employment.grade.changed':
        // Untagged legacy grade edits keep a factual Grade Change label (companion legs already skipped above).
        rows.push({
          ...base,
          kind: mv?.type ?? 'gradeChange',
          effectiveDate: occDate,
          endDate: mv?.endDate ?? null,
          remarks: mv?.remarks ?? null,
        });
        break;
      case 'compensation.set':
        // Initial salary at hire is part of Hired, not a movement (suppresses the every-new-hire
        // "Salary Adjustment" noise; applies to import and seed too).
        if (p.effectiveFrom === emp.hiredOn) break;
        rows.push({
          ...base,
          // A pay change may be the primary leg of any movement (a Promotion whose only delta is salary);
          // untagged / legacy comp writes keep the factual Salary Adjustment label.
          kind: isKnownKind(mv?.type) ? mv.type : 'salaryAdjustment',
          effectiveDate: p.effectiveFrom ?? occDate,
          endDate: null,
          remarks: compRemarks.get(e.aggregateId) ?? null,
        });
        break;
      case 'employment.info.updated': {
        // Classify by the movement tag when present, else by the written field group. First-match
        // priority (confirmation → probation extension → resignation) is deterministic and read-time
        // tunable; events touching none of these stay off the history (still on the Others tab).
        const fields: string[] = Array.isArray(p.fields) ? p.fields : [];
        const kind = mv?.type
          ? mv.type
          : fields.includes('confirmationDate')
            ? 'confirmation'
            : fields.some((f) => EXTENDED_PROBATION_FIELDS.includes(f))
              ? 'probationExtension'
              : fields.some((f) => RESIGNATION_FIELDS.includes(f))
                ? 'resignation'
                : null;
        if (!kind) break;
        const after = (p.after ?? {}) as Record<string, unknown>;
        // 89ea527b — for the two date movements the row's Effective Date is the date the movement SET, read
        // back off the event's own after-diff (not the column), so a later correction cannot rewrite the
        // history of the earlier one. Falls back to the occurrence date if the diff is missing.
        const effectiveDate =
          kind === 'confirmation'
            ? ((after.confirmationDate as string | null) ?? occDate)
            : kind === 'resignation'
              ? ((after.tenderResignationDate as string | null) ?? occDate)
              : kind === 'joinDateChange'
                ? ((after.joinDate as string | null) ?? occDate)
                : kind === 'groupJoinDateCorrection'
                  ? ((after.hiredOn as string | null) ?? occDate)
                  : occDate;
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
        rows.push({
          ...base,
          kind: p.terminationType === 'voluntary' ? 'resignation' : 'termination',
          effectiveDate: p.terminationDate ?? occDate,
          endDate: null,
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
        rows.push({
          ...base,
          kind: isKnownKind(mv?.type) ? mv.type : 'reportingLineChange',
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
          kind: isKnownKind(p.type) ? p.type : 'orgAssignmentChange',
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

      case 'employment.movement.reversed':
        // 66a63bd6 — marks the referenced row as rolled back. Deliberately projects NO row of its own:
        // one movement, one line in the history, with its correction shown on it.
        reversals.set(String(p.movementId), {
          at: e.occurredAt,
          reason: (p.reason as string | null) ?? null,
          corrected: p.corrected === true,
        });
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

  for (const r of rows) {
    r.reversed = reversals.get(r.id) ?? null;
    r.appliedAt = applications.get(r.id) ?? null;
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
  return { emp, events, rows, statusOf, today };
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

/** A flat-column leg is undone field by field. A leg that also moved a LIFECYCLE date (confirmation,
 *  resignation, probation) is out of scope: those derive from one another (finalConfirmationDate) and are
 *  maintained on their own screens. */
function infoLegIsFlatOnly(e: RawEvent): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fields: string[] = Array.isArray((e.payload as any)?.fields) ? (e.payload as any).fields : [];
  return fields.every((f) => (MOVEMENT_FLAT_FIELDS as readonly string[]).includes(f));
}

type Correctability = { canReverse: boolean; canEdit: boolean; stateChanging: boolean };

/** Whether this movement can be rolled back, and whether it can be corrected in place. `isLatest` is the
 *  in-place rule: an edit replays through the SAME writers, and those act on the OPEN dated row, so a
 *  state-changing movement can only be corrected while it is still the most recent one. */
function correctabilityOf(row: ProjectedRow, group: RawEvent[], isLatest: boolean): Correctability {
  const stateChanging = group.some((e) => STATE_CHANGING_EVENT_TYPES.has(e.eventType));
  if (!group.length) return { canReverse: false, canEdit: false, stateChanging };
  const supported = group.every(
    (e) =>
      REVERSIBLE_EVENT_TYPES.has(e.eventType) &&
      (e.eventType !== 'employment.info.updated' || infoLegIsFlatOnly(e)),
  );
  const canReverse = supported && !row.reversed;
  const canEdit = canReverse && (!stateChanging || (isComparisonKind(row.kind) && isLatest));
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
 * r78c — the placement columns every history row shows (Company, Division, Department, Job Title, Basic),
 * loaded ONCE for the whole employment and resolved per row in memory. Deliberately not per-row queries:
 * the history is rendered whole, and one round trip per row per column is how a timeline screen becomes a
 * slow one.
 *
 * Company has no dated history (an employment holds one company_id; changeEmploymentCompany flips it),
 * so every row shows the current legal name — the same value the detail view's comparison grid shows.
 */
async function placementColumnsTx(tx: Tx, employmentId: string, companyId: string, events: RawEvent[]) {
  const [co] = await tx
    .select({ name: company.legalName })
    .from(company)
    .where(eq(company.id, companyId))
    .limit(1);

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
    .select({ orgDivision: employment.orgDivision })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);

  const infoEvents = events.filter((e) => e.eventType === 'employment.info.updated');

  return (asOf: string, seqBound: number) => {
    const asg = asgRows.filter((a) => a.validFrom <= asOf && (a.validTo == null || a.validTo > asOf)).pop() ?? null;
    const comp = compRows.filter((c) => c.validFrom <= asOf && (c.validTo == null || c.validTo > asOf)).pop() ?? null;
    return {
      company: co?.name ?? null,
      division: flatValueAtSequence(infoEvents, 'orgDivision', seqBound, empRow?.orgDivision ?? null),
      department: asg?.department ?? null,
      jobTitle: asg?.position ?? null,
      basic: comp ? `${comp.currency} ${comp.basicSalary}` : null,
    };
  };
}

/** The Employment History list — a Hired-first, date-ascending projection over the event ledger. */
export function movementHistory(ctx: SessionContext, employmentId: string): Promise<MovementHistoryRow[]> {
  return withTenant(ctx, async (tx) => {
    const { emp, events, rows, statusOf } = await projectRows(tx, ctx.tenantId, employmentId);
    // 66a63bd6 — the two payroll period sets come from core/comp.ts, so the per-row affordance runs the
    // SAME rule the service refuses on (the Basic Salary card's precedent).
    const closed = await closedPeriodsTx(tx, employmentId);
    const processed = await processedPeriodsTx(tx, employmentId);
    const latest = latestStateChangingSpanEnd(events, rows);
    const placementAt = await placementColumnsTx(tx, employmentId, emp.companyId, events);
    return rows.map((r) => {
      const g = groupEventsOf(events, r);
      const spanEnd = g.length ? Math.max(...g.map((e) => e.sequence)) : -1;
      const status = statusOf(r);
      const c = correctabilityOf(r, g, spanEnd === latest);
      // 941c9dac — a SUPERSEDED movement is terminal: it never applied and never will, so there is
      // nothing to cancel and nothing to replay. Editing one would also be a trap — the values HR typed
      // are precisely the ones another movement has already overridden.
      const terminal = status === 'superseded';
      // The window a correction disturbs runs from the effective date forward: undoing a raise changes
      // every period after it, not just the one it started in.
      const locked = c.stateChanging && overlapsClosedPeriod(closed, r.effectiveDate, null);
      return {
        id: r.id,
        kind: r.kind,
        effectiveDate: r.effectiveDate,
        entryDate: r.occurredAt ? dateOf(r.occurredAt) : null,
        status,
        endDate: r.endDate,
        remarks: r.remarks,
        reversed: r.reversed,
        canEdit: c.canEdit && !locked && !terminal,
        canReverse: c.canReverse && !locked && !terminal,
        payrollLocked: locked,
        payrollWarning: c.stateChanging && !locked && overlapsClosedPeriod(processed, r.effectiveDate, null),
        // The flat-column replay bounds on the WHOLE group's last sequence, exactly as the detail view's
        // After column does — the leg that wrote Division can carry a higher sequence than the leg that
        // owns the row, and bounding on the row's own event alone would show the pre-movement value.
        ...placementAt(r.effectiveDate, spanEnd === -1 ? r.sequence : spanEnd),
      };
    });
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
): Promise<MovementSnapshot> {
  const [co] = await tx
    .select({ name: company.legalName })
    .from(company)
    .where(eq(company.id, emp.companyId))
    .limit(1);

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
    company: co?.name ?? null,
    businessUnit: asg?.businessUnit ?? null,
    department: asg?.department ?? null,
    position: asg?.position ?? null,
    grade: gradeName,
    employmentType: asg?.employmentType ?? null,
    manager: managerName,
    salary: comp ? `${comp.currency} ${comp.basicSalary}` : null,
  };
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
  return withTenant(ctx, async (tx) => {
    const { emp, events, rows, statusOf } = await projectRows(tx, ctx.tenantId, employmentId);
    const row = rows.find((r) => r.id === movementId);
    if (!row) return null;
    const gradeEvents = events.filter((e) => e.eventType === 'employment.grade.changed');

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

    const after = await snapshotAt(tx, emp, row.effectiveDate, gradeEvents, afterBound, true);
    const before =
      row.kind === 'hired'
        ? null
        : await snapshotAt(tx, emp, dayBefore(row.effectiveDate), gradeEvents, beforeBound, false);

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
      occurredAt: row.occurredAt,
      before,
      after,
      flatChanges: flatChangesOf(group.length ? group : events.filter((e) => e.id === row.id)),
    };
  });
}

/**
 * 08913328 — the employee's CURRENT employment + pay values, as raw ids. This is the read behind the left
 * (read-only) column of the redesigned New Event comparison screen, and the baseline the dispatcher diffs
 * the submitted right column against. Ids, not labels: the form already holds the option lists, and the
 * dispatcher must compare like for like.
 */
export type MovementCurrentState = {
  companyName: string | null;
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
} & Record<MovementFlatField, string | null>;

async function currentStateTx(tx: Tx, employmentId: string): Promise<MovementCurrentState> {
  const [emp] = await tx
    .select({
      gradeId: employment.gradeId,
      companyName: company.legalName,
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
  return withTenant(ctx, (tx) => currentStateTx(tx, employmentId));
}

export type CreateMovementInput = {
  employmentId: string;
  kind: MovementKind;
  effectiveDate: string;
  endDate?: string | null;
  remarks?: string | null;
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
  terminationType?: TerminationType;
  /** Blacklist kind: true (default) sets the blacklist, false clears it — the old card's two actions. */
  blacklisted?: boolean;
} & Partial<Record<MovementFlatField, string | null>>;

/**
 * 08913328 — the kinds that record a CHANGE to the employee's employment/pay data, and therefore render as
 * the side-by-side comparison screen. The rest (Confirmation, Probation Extension, Resignation,
 * Termination, Blacklist, Secondment, Acting Position) are lifecycle events with their own dedicated
 * inputs — a Current/After grid would be meaningless for them.
 */
export const COMPARISON_KINDS = [
  'transfer',
  'promotion',
  'demotion',
  'increment',
  'salaryAdjustment',
  'orgAssignmentChange',
  'employmentTypeChange',
  'reportingLineChange',
] as const;
export type ComparisonKind = (typeof COMPARISON_KINDS)[number];
export const isComparisonKind = (k: string): k is ComparisonKind =>
  (COMPARISON_KINDS as readonly string[]).includes(k);

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

  const dDept = delta(p.departmentId, cur.departmentId);
  const dPos = delta(p.positionId, cur.positionId);
  const dBu = delta(p.businessUnitId, cur.businessUnitId);
  const dLoc = delta(p.locationId, cur.locationId);
  const dType = p.employmentType && p.employmentType !== cur.employmentType ? p.employmentType : undefined;
  const dGrade = delta(p.gradeId, cur.gradeId);
  const dManager = delta(p.managerEmploymentId, cur.managerEmploymentId);

  // Department is NOT NULL on the assignment — an empty submission means "unchanged", never "clear".
  if (dDept === null) throw new Error('Department is required.');

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

  const nothingChanged =
    !assignmentChanged && !gradeChanged && !flatChanged && !managerChanged && !compChanged;
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

  return {
    cur,
    dDept, dPos, dBu, dLoc, dType, dGrade, dManager, flat,
    dSalary, dCurrency, dPayMode, dPaymentTerm,
    assignmentChanged, gradeChanged, flatChanged, managerChanged, compChanged, hasComp,
    nothingChanged,
    changes,
    fields: changes.map((c) => c.field),
  };
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
  const remarks = p.remarks?.trim() || null;
  const endDate = p.endDate?.trim() || null;
  const groupId = opts?.groupId ?? randomUUID();

  {
    const cur = await currentStateTx(tx, p.employmentId);
    const d = movementDeltas(p, cur);
    const {
      dDept, dPos, dBu, dLoc, dType, dGrade, dManager, flat,
      dSalary, dCurrency, dPayMode, dPaymentTerm,
      assignmentChanged, gradeChanged, flatChanged, compChanged,
    } = d;

    if (d.nothingChanged) {
      throw new MovementNoChangeError();
    }

    // 941c9dac — seeded TRUE by the sweep, which makes EVERY leg secondary because the scheduled event
    // already owns the history row (see the `opts` note in the doc comment).
    let primaryTaken = opts?.allSecondary === true;
    /** Primary for the first leg with a real delta, `secondary` for every leg after it. */
    const tag = (opts: { withRemarks: boolean }): MovementTag => {
      const t: MovementTag = { type: kind, groupId };
      // ADR-0030 redact-to-reference: comp events never carry remark text — it lives on the comp row.
      if (opts.withRemarks) {
        t.remarks = remarks;
        t.endDate = endDate;
      }
      if (primaryTaken) t.secondary = true;
      primaryTaken = true;
      return t;
    };

    if (assignmentChanged) {
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

    if (flatChanged) {
      await setEmploymentInfo(
        ctx,
        { employmentId: p.employmentId, ...flat, movement: tag({ withRemarks: true }) },
        tx,
      );
    }

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
          effectiveFrom: p.effectiveDate,
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

const applyComparisonMovement = (ctx: SessionContext, p: CreateMovementInput, kind: ComparisonKind) =>
  withTenant(ctx, (tx) => applyComparisonMovementTx(tx, ctx, p, kind));

/**
 * 941c9dac — the fields of the submitted right column, frozen onto the scheduled event so the sweep can
 * replay EXACTLY what HR typed months later. `undefined` (the form did not offer the field) is dropped
 * rather than stored as null, because JSON has no `undefined`: round-tripping it as null would turn
 * "leave the Work Location alone" into "clear the Work Location" on the morning the movement applies.
 */
function scheduledInputOf(p: CreateMovementInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = [
    'departmentId', 'positionId', 'businessUnitId', 'locationId', 'gradeId',
    'employmentType', 'managerEmploymentId', 'basicSalary', 'currency', 'payMode', 'paymentTerm',
    ...MOVEMENT_FLAT_FIELDS,
  ] as const;
  for (const k of keys) {
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
) {
  const cur = await currentStateTx(tx, p.employmentId);
  const d = movementDeltas(p, cur);
  if (d.nothingChanged) throw new MovementNoChangeError();

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
      type: kind,
      effectiveDate: p.effectiveDate,
      endDate,
      remarks,
      /** The conflict key — the fields this movement intends to move (see supersededScheduledIds). */
      fields: d.fields,
      /** What HR typed, replayed verbatim by the sweep on the effective date. */
      input: scheduledInputOf(p),
      // The tag is what makes this event the OWNER of the history row: the sweep's legs share this
      // groupId and are all `secondary`, so the movement keeps exactly one line in the history.
      movement: { type: kind, groupId, remarks, endDate } satisfies MovementTag,
    },
  });
  return { employmentId: p.employmentId, scheduled: true as const, effectiveDate: p.effectiveDate };
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
export async function createMovementEvent(ctx: SessionContext, p: CreateMovementInput) {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new Error('Only an admin can record a movement.');
  }
  if (!(MOVEMENT_KINDS as readonly string[]).includes(p.kind)) {
    throw new Error('Unknown movement event type.');
  }
  if (p.kind !== 'blacklist' && !/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveDate ?? '')) {
    throw new Error('A valid effective date (YYYY-MM-DD) is required.');
  }
  // 08913328 — the comparison kinds all go through ONE diff-driven writer; only genuine deltas are
  // written, so an untouched field can never fabricate an assignment version or a history row.
  if (isComparisonKind(p.kind)) {
    if (p.kind === 'employmentTypeChange' && !p.employmentType) {
      throw new Error('Select the new employment type.');
    }
    // 941c9dac — the effective-date fork. A movement dated TODAY OR IN THE PAST applies immediately on
    // save (the reporter specified this explicitly: it must not wait for the next sweep). A movement
    // dated in the FUTURE is recorded as a pending intent and applies on the morning of its date.
    const today = todayInKualaLumpur();
    if (p.effectiveDate > today) {
      return withTenant(ctx, (tx) => scheduleMovementTx(tx, ctx, p, p.kind as ComparisonKind));
    }
    return applyComparisonMovement(ctx, p, p.kind);
  }

  const remarks = p.remarks?.trim() || null;
  const endDate = p.endDate?.trim() || null;

  switch (p.kind) {
    case 'confirmation':
      return setEmploymentInfo(ctx, {
        employmentId: p.employmentId,
        confirmationDate: p.effectiveDate,
        movement: { type: 'confirmation', remarks, groupId: randomUUID() },
      });

    // 89ea527b — Join Date Change: the employee's commencement date with the CURRENT employing company moves
    // (internal company transfer, rehire into another group company, restructure). The effective date IS the
    // new Join Date. The Group Join Date is deliberately untouched — group service continues across the move,
    // which is the whole point of keeping the two dates apart.
    case 'joinDateChange':
      return setEmploymentInfo(ctx, {
        employmentId: p.employmentId,
        joinDate: p.effectiveDate,
        movement: { type: 'joinDateChange', remarks, groupId: randomUUID() },
      });

    // 89ea527b — Group Join Date Correction: the authorized historical-data correction of the master service
    // date. This is the ONLY route to hired_on after creation, and it MOVES LEAVE ENTITLEMENT (service bands
    // read hired_on), so it is deliberately its own event type rather than a field on another movement — an
    // entitlement change should never be a side effect of a transfer someone recorded for another reason.
    case 'groupJoinDateCorrection':
      return setEmploymentInfo(ctx, {
        employmentId: p.employmentId,
        hiredOn: p.effectiveDate,
        movement: { type: 'groupJoinDateCorrection', remarks, groupId: randomUUID() },
      });

    case 'probationExtension':
      if (!endDate) throw new Error('An extended confirmation (new probation end) date is required.');
      return setEmploymentInfo(ctx, {
        employmentId: p.employmentId,
        extendedConfirmationDate: endDate,
        movement: { type: 'probationExtension', remarks, endDate, groupId: randomUUID() },
      });

    case 'resignation':
      return setEmploymentInfo(ctx, {
        employmentId: p.employmentId,
        tenderResignationDate: p.effectiveDate,
        ...(endDate ? { lastWorkingDate: endDate } : {}),
        movement: { type: 'resignation', remarks, endDate, groupId: randomUUID() },
      });

    case 'termination':
      return terminateEmployment(ctx, {
        employmentId: p.employmentId,
        terminationDate: p.effectiveDate,
        terminationType: p.terminationType,
        terminationReason: remarks ?? undefined,
      });

    case 'blacklist':
      return setEmploymentBlacklist(ctx, {
        employmentId: p.employmentId,
        blacklisted: p.blacklisted ?? true,
        reason: remarks,
      });

    case 'secondment':
    case 'actingPosition':
      return withTenant(ctx, async (tx) => {
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
          payload: { type: p.kind, effectiveDate: p.effectiveDate, endDate, remarks },
        });
        return { employmentId: p.employmentId };
      });
  }
}

// ───────────── Scheduled application — 941c9dac ─────────────

/** What one employment's due-movement pass did. `noop` counts movements that arrived to find their
 *  values already in place — they still get an applied event, so they never retry. */
export type ApplyDueResult = { applied: number; noop: number };

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
  const { events, rows, statusOf } = await projectRows(tx, ctx.tenantId, employmentId, today);
  const due = rows
    .filter((r) => r.scheduled && r.effectiveDate <= today && statusOf(r) === 'pending')
    .sort((a, b) =>
      a.effectiveDate === b.effectiveDate ? a.sequence - b.sequence : a.effectiveDate < b.effectiveDate ? -1 : 1,
    );

  let applied = 0;
  let noop = 0;
  for (const r of due) {
    const ev = events.find((e) => e.id === r.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = (ev?.payload ?? {}) as Record<string, any>;
    // Without the groupId the legs could not be tied back to this row and the movement would sprout a
    // duplicate history line. Refuse rather than corrupt the history.
    if (!r.groupId || !isComparisonKind(r.kind)) continue;

    const input: CreateMovementInput = {
      ...(payload.input ?? {}),
      employmentId,
      kind: r.kind,
      effectiveDate: r.effectiveDate,
      endDate: r.endDate,
      remarks: r.remarks,
    };

    let changes: MovementChange[] = [];
    try {
      const res = await applyComparisonMovementTx(tx, ctx, input, r.kind, {
        groupId: r.groupId,
        allSecondary: true,
      });
      changes = res.changes;
      applied += 1;
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
  return { applied, noop };
}

// ───────────── Corrections: Edit + Delete (Rollback) — 66a63bd6 ─────────────
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

function assertMovementAdmin(ctx: SessionContext, what: string): void {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new Error(`Only an admin can ${what}.`);
  }
}

/** Undo ONE leg of a movement. `tag` marks every compensating write as a companion of the rollback, so the
 *  projection keeps rendering exactly one row per movement. */
async function reverseLegTx(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  e: RawEvent,
  tag: MovementTag,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (e.payload ?? {}) as Record<string, any>;
  switch (e.eventType) {
    case 'assignment.transferred':
    case 'employment.assignment.changed': {
      const [row] = await tx
        .select()
        .from(assignment)
        .where(and(eq(assignment.id, e.aggregateId), eq(assignment.employmentId, employmentId)))
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
        })
        .from(employment)
        .where(eq(employment.id, employmentId))
        .limit(1);
      if (!cur) return;
      const restore: Partial<Record<MovementFlatField, string | null>> = {};
      for (const f of MOVEMENT_FLAT_FIELDS) {
        if (!fields.includes(f)) continue;
        if ((cur[f] ?? null) !== (after[f] ?? null)) continue; // a later movement owns this column now
        restore[f] = before[f] ?? null;
      }
      if (Object.keys(restore).length) {
        await setEmploymentInfo(ctx, { employmentId, ...restore, movement: tag }, tx);
      }
      return;
    }

    case 'reporting-line.set': {
      const [row] = await tx
        .select()
        .from(reportingLine)
        .where(and(eq(reportingLine.id, e.aggregateId), eq(reportingLine.subordinateEmploymentId, employmentId)))
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

/** The shared rollback body. `corrected` distinguishes the first half of an Edit from a plain Delete — both
 *  leave the same visible trace, and the history says which one happened. */
async function reverseMovementTx(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  movementId: string,
  reason: string | null,
  corrected: boolean,
): Promise<void> {
  const { events, rows, statusOf } = await projectRows(tx, ctx.tenantId, employmentId);
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
  const c = correctabilityOf(row, group, false);
  if (!c.canReverse) {
    throw new MovementNotCorrectableError(
      'This event type cannot be rolled back from Employment History — use the screen that records it.',
    );
  }
  if (c.stateChanging) {
    const closed = await closedPeriodsTx(tx, employmentId);
    if (overlapsClosedPeriod(closed, row.effectiveDate, null)) {
      throw new Error('A closed payroll run relied on this movement. Reopen that payroll before correcting the event.');
    }
  }
  // Undo the newest leg first: within one movement a later leg can sit on top of an earlier one.
  const tag: MovementTag = { type: row.kind, groupId: randomUUID(), secondary: true };
  for (const e of [...group].sort((a, b) => b.sequence - a.sequence)) {
    await reverseLegTx(tx, ctx, employmentId, e, tag);
  }
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'employment',
    aggregateId: employmentId,
    eventType: 'employment.movement.reversed',
    actor: actorOf(ctx),
    subjectEmploymentId: employmentId,
    payload: { movementId, kind: row.kind, effectiveDate: row.effectiveDate, reason, corrected },
  });
}

/**
 * Delete (Rollback). The movement stops applying and everything it changed goes back to what it was
 * immediately before — but the row STAYS in Employment History, marked reversed, with who did it, when and
 * why. That is the approved shape (9064cffb option a): an employment history that can be silently emptied
 * is no longer evidence, and payroll and statutory reporting both lean on it.
 */
export async function reverseMovementEvent(
  ctx: SessionContext,
  p: { employmentId: string; movementId: string; reason?: string | null },
) {
  assertMovementAdmin(ctx, 'roll back a movement');
  return withTenant(ctx, async (tx) => {
    await reverseMovementTx(tx, ctx, p.employmentId, p.movementId, p.reason?.trim() || null, false);
    return { employmentId: p.employmentId };
  });
}

export type EditMovementInput = CreateMovementInput & {
  movementId: string;
  /** Free-text "reason for the change" (audit-trail requirement 4 — optional but recommended). */
  reason?: string | null;
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
export async function editMovementEvent(ctx: SessionContext, p: EditMovementInput) {
  assertMovementAdmin(ctx, 'correct a movement');
  if (!(MOVEMENT_KINDS as readonly string[]).includes(p.kind)) {
    throw new Error('Unknown movement event type.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveDate ?? '')) {
    throw new Error('A valid effective date (YYYY-MM-DD) is required.');
  }
  const reason = p.reason?.trim() || null;
  const remarks = p.remarks?.trim() || null;
  const endDate = p.endDate?.trim() || null;

  return withTenant(ctx, async (tx) => {
    const { events, rows, statusOf, today } = await projectRows(tx, ctx.tenantId, p.employmentId);
    const row = rows.find((r) => r.id === p.movementId);
    if (!row) throw new Error('Movement event not found.');
    if (row.reversed) throw new Error('This movement event has already been rolled back.');
    const status = statusOf(row);

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
      if (!isComparisonKind(p.kind)) {
        throw new MovementNotCorrectableError('A correction cannot turn this movement into that event type.');
      }
      if (p.kind === 'employmentTypeChange' && !p.employmentType) {
        throw new Error('Select the new employment type.');
      }
      await reverseMovementTx(tx, ctx, p.employmentId, p.movementId, reason, true);
      const corrected = { ...p, remarks, endDate };
      // A correction may also move the date INTO the past — in which case the movement stops being a
      // schedule and applies at once, exactly as keying it fresh with that date would.
      return p.effectiveDate > today
        ? scheduleMovementTx(tx, ctx, corrected, p.kind)
        : applyComparisonMovementTx(tx, ctx, corrected, p.kind);
    }
    if (status === 'superseded') {
      throw new MovementNotCorrectableError(
        'This movement was overtaken by a later one and never took effect, so there is nothing to correct.',
      );
    }

    const group = groupEventsOf(events, row);
    const spanEnd = group.length ? Math.max(...group.map((e) => e.sequence)) : -1;
    const isLatest = spanEnd === latestStateChangingSpanEnd(events, rows);
    const c = correctabilityOf(row, group, isLatest);
    if (!c.canEdit) {
      throw new MovementNotCorrectableError(
        c.canReverse && c.stateChanging && !isLatest
          ? 'Only the most recent movement can be edited. Roll back the later movements first, then correct this one.'
          : 'This event type cannot be edited from Employment History — use the screen that records it.',
      );
    }

    // The unchanged-replay no-op, checked BEFORE anything is written — against the same date/remark fields
    // the history shows and the same current values the comparison form pre-filled from.
    const datesUnchanged =
      p.kind === row.kind &&
      p.effectiveDate === row.effectiveDate &&
      endDate === row.endDate &&
      remarks === row.remarks;

    if (!c.stateChanging) {
      // Record-only movement: the rollback has nothing to undo, so the correction is the reversal plus a
      // fresh record carrying the fixed dates / remarks.
      if (datesUnchanged) throw new MovementNoChangeError();
      await reverseMovementTx(tx, ctx, p.employmentId, p.movementId, reason, true);
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'employment',
        aggregateId: p.employmentId,
        eventType: 'employment.movement.recorded',
        actor: actorOf(ctx),
        subjectEmploymentId: p.employmentId,
        payload: { type: p.kind, effectiveDate: p.effectiveDate, endDate, remarks, correctionOf: p.movementId },
      });
      return { employmentId: p.employmentId };
    }

    if (!isComparisonKind(p.kind)) {
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
    if (datesUnchanged && valuesUnchanged) throw new MovementNoChangeError();

    await reverseMovementTx(tx, ctx, p.employmentId, p.movementId, reason, true);
    try {
      return await applyComparisonMovementTx(tx, ctx, { ...p, remarks, endDate }, p.kind);
    } catch (e) {
      // The corrected movement would now change nothing at all — that is a Delete, not an Edit, and the
      // half-applied rollback must not commit behind a message about "no changes to record".
      if (e instanceof MovementNoChangeError) {
        throw new MovementNoChangeError(
          'The corrected event would leave nothing changed — use Delete to roll the movement back instead.',
        );
      }
      throw e;
    }
  });
}
