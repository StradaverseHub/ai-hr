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
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
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
import { setCompensation } from './comp';

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
  endDate: string | null;
  remarks: string | null;
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

export type MovementDetail = {
  row: MovementHistoryRow;
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
  constructor() {
    super('This event would not change anything — there are no changes to record.');
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

type ProjectedRow = MovementHistoryRow & {
  sequence: number;
  occurredAt: Date | null;
  /** MovementTag.groupId of the event this row projects — correlates the other legs of the same movement. */
  groupId: string | null;
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

/** 'YYYY-MM-DD' minus one day, in pure UTC string math (no TZ drift). */
function dayBefore(d: string): string {
  const ms = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}

const dateOf = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Classify the ledger into movement rows. Returns the employment row, the raw events (for the detail's
 * grade replay) and the sorted rows. Sort ascending by (effective date, Hired-first, occurredAt,
 * sequence) — the kind priority guarantees the Hired row renders first even among same-day rows (the
 * hire's own reporting-line.set carries a LOWER sequence than employment.hired, so sequence alone
 * would misorder them).
 */
async function projectRows(tx: Tx, tenantId: string, employmentId: string) {
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
    const base = { id: e.id, sequence: e.sequence, occurredAt: e.occurredAt, groupId: mv?.groupId ?? null };
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
        const effectiveDate =
          kind === 'confirmation'
            ? ((after.confirmationDate as string | null) ?? occDate)
            : kind === 'resignation'
              ? ((after.tenderResignationDate as string | null) ?? occDate)
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
    });
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

  return { emp, events, rows };
}

/** The Employment History list — a Hired-first, date-ascending projection over the event ledger. */
export function movementHistory(ctx: SessionContext, employmentId: string): Promise<MovementHistoryRow[]> {
  return withTenant(ctx, async (tx) => {
    const { rows } = await projectRows(tx, ctx.tenantId, employmentId);
    return rows.map(({ id, kind, effectiveDate, endDate, remarks }) => ({ id, kind, effectiveDate, endDate, remarks }));
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
    const { emp, events, rows } = await projectRows(tx, ctx.tenantId, employmentId);
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
      row: { id: row.id, kind: row.kind, effectiveDate: row.effectiveDate, endDate: row.endDate, remarks: row.remarks },
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

/**
 * The comparison-form writer. HR submits the WHOLE right column, so the deltas — never the submitted
 * values — decide what is written: a field left at its current value must not produce an assignment
 * version, a compensation revision or a history row that says nothing happened.
 *
 * Every leg runs in ONE transaction (each writer's `outerTx`), so a movement that moves department, grade,
 * division and salary either lands whole or not at all. The FIRST leg with a real delta carries the
 * primary movement tag and owns the history row; the rest are tagged `secondary` and share its `groupId`,
 * which is how the detail view finds the flat-column before/after and the full sequence span.
 */
async function applyComparisonMovement(ctx: SessionContext, p: CreateMovementInput, kind: ComparisonKind) {
  const remarks = p.remarks?.trim() || null;
  const endDate = p.endDate?.trim() || null;
  const groupId = randomUUID();

  return withTenant(ctx, async (tx) => {
    const cur = await currentStateTx(tx, p.employmentId);
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

    if (!assignmentChanged && !gradeChanged && !flatChanged && !managerChanged && !compChanged) {
      throw new MovementNoChangeError();
    }
    if (dSalary !== undefined && (!Number.isFinite(dSalary) || dSalary < 0)) {
      throw new Error('A valid basic salary amount is required.');
    }

    let primaryTaken = false;
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

    if (managerChanged) {
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

    return { employmentId: p.employmentId };
  });
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
    return applyComparisonMovement(ctx, p, p.kind);
  }

  const remarks = p.remarks?.trim() || null;
  const endDate = p.endDate?.trim() || null;

  switch (p.kind) {
    case 'confirmation':
      return setEmploymentInfo(ctx, {
        employmentId: p.employmentId,
        confirmationDate: p.effectiveDate,
        movement: { type: 'confirmation', remarks },
      });

    case 'probationExtension':
      if (!endDate) throw new Error('An extended confirmation (new probation end) date is required.');
      return setEmploymentInfo(ctx, {
        employmentId: p.employmentId,
        extendedConfirmationDate: endDate,
        movement: { type: 'probationExtension', remarks, endDate },
      });

    case 'resignation':
      return setEmploymentInfo(ctx, {
        employmentId: p.employmentId,
        tenderResignationDate: p.effectiveDate,
        ...(endDate ? { lastWorkingDate: endDate } : {}),
        movement: { type: 'resignation', remarks, endDate },
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
