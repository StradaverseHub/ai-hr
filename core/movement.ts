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
 * delegates to the EXISTING writers (transferEmployee, setEmploymentAssignment/Grade/Info,
 * setCompensation, terminateEmployment, setEmploymentBlacklist, setReportingLine), so downstream sync
 * (payroll, leave, attendance, directory, analytics) is inherent. It attaches an optional movement
 * classification tag (db/events.ts MovementTag) that records the INTENT (Promotion vs a plain edit);
 * untagged / historical events keep plain, factual fallback labels.
 */
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
  transferEmployee,
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

export type MovementDetail = {
  row: MovementHistoryRow;
  /** Full name of the user who recorded the change; null for SYSTEM/import writes and the synthesized row. */
  actorName: string | null;
  /** When the change was recorded; null for the synthesized Hired row. */
  occurredAt: Date | null;
  /** null = first record (the Hired row renders an After column only). */
  before: MovementSnapshot | null;
  after: MovementSnapshot;
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

const ASSIGNMENT_TAGGED_KINDS = ['promotion', 'demotion', 'employmentTypeChange', 'orgAssignmentChange'];
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

type ProjectedRow = MovementHistoryRow & { sequence: number; occurredAt: Date | null };

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
    const occDate = dateOf(e.occurredAt);
    const base = { id: e.id, sequence: e.sequence, occurredAt: e.occurredAt };
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
          kind: mv?.type && ASSIGNMENT_TAGGED_KINDS.includes(mv.type) ? mv.type : 'orgAssignmentChange',
          effectiveDate: p.effectiveDate ?? occDate,
          endDate: mv?.endDate ?? null,
          remarks: mv?.remarks ?? null,
        });
        break;
      case 'employment.grade.changed':
        // The grade half of a paired Promotion/Demotion is tagged `secondary` by the dispatcher so the
        // history renders ONE row per movement; untagged legacy edits keep a factual Grade Change label.
        if (mv?.secondary) break;
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
          kind: mv?.type === 'increment' ? 'increment' : 'salaryAdjustment',
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
          kind: 'reportingLineChange',
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

    const after = await snapshotAt(tx, emp, row.effectiveDate, gradeEvents, row.sequence, true);
    const before =
      row.kind === 'hired'
        ? null
        : await snapshotAt(tx, emp, dayBefore(row.effectiveDate), gradeEvents, row.sequence, false);

    return {
      row: { id: row.id, kind: row.kind, effectiveDate: row.effectiveDate, endDate: row.endDate, remarks: row.remarks },
      actorName,
      occurredAt: row.occurredAt,
      before,
      after,
    };
  });
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
  terminationType?: TerminationType;
  /** Blacklist kind: true (default) sets the blacklist, false clears it — the old card's two actions. */
  blacklisted?: boolean;
};

/**
 * The single New Event entry point. Delegates every kind to the existing audited writer, so effective-
 * date semantics deliberately MATCH those writers (e.g. setEmploymentAssignment rejects dates before the
 * current record's validFrom — the error is surfaced verbatim; future-dated saves apply on save, no
 * scheduling engine this round). Admin-gated as defence-in-depth over each writer's own gate/RLS.
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
  const remarks = p.remarks?.trim() || null;
  const endDate = p.endDate?.trim() || null;
  // '' / null on a picker = keep current (the writers' undefined carry-forward semantics).
  const keep = (v: string | null | undefined): string | undefined => (v ? v : undefined);

  switch (p.kind) {
    case 'transfer':
      // transferEmployee — NOT setEmploymentAssignment — so location and cost centre are preserved
      // (setEmploymentAssignment hard-carries them; transfer may also SET a new location).
      return transferEmployee(ctx, {
        employmentId: p.employmentId,
        effectiveDate: p.effectiveDate,
        departmentId: keep(p.departmentId),
        positionId: keep(p.positionId),
        locationId: keep(p.locationId),
        movement: { type: 'transfer', remarks, endDate },
      });

    case 'promotion':
    case 'demotion':
      // ONE withTenant transaction: assignment (tag primary) + grade (tag secondary) commit or roll
      // back together. Grade-only movements fall back to the grade event carrying the primary tag.
      return withTenant(ctx, async (tx) => {
        const a = await setEmploymentAssignment(
          ctx,
          {
            employmentId: p.employmentId,
            effectiveDate: p.effectiveDate,
            departmentId: keep(p.departmentId),
            positionId: keep(p.positionId),
            businessUnitId: keep(p.businessUnitId),
            movement: { type: p.kind, remarks, endDate },
          },
          tx,
        );
        const g =
          p.gradeId !== undefined
            ? await setEmploymentGrade(
                ctx,
                {
                  employmentId: p.employmentId,
                  gradeId: p.gradeId || null,
                  movement: { type: p.kind, remarks, endDate, secondary: a.changed },
                },
                tx,
              )
            : { changed: false as const };
        if (!a.changed && !g.changed) throw new MovementNoChangeError();
        return { employmentId: p.employmentId };
      });

    case 'orgAssignmentChange':
    case 'employmentTypeChange': {
      if (p.kind === 'employmentTypeChange' && !p.employmentType) {
        throw new Error('Select the new employment type.');
      }
      const r = await setEmploymentAssignment(ctx, {
        employmentId: p.employmentId,
        effectiveDate: p.effectiveDate,
        departmentId: keep(p.departmentId),
        positionId: keep(p.positionId),
        businessUnitId: keep(p.businessUnitId),
        employmentType: p.kind === 'employmentTypeChange' ? p.employmentType : undefined,
        movement: { type: p.kind, remarks, endDate },
      });
      if (!r.changed) throw new MovementNoChangeError();
      return { employmentId: p.employmentId };
    }

    case 'increment':
    case 'salaryAdjustment': {
      if (typeof p.basicSalary !== 'number' || !Number.isFinite(p.basicSalary) || p.basicSalary < 0) {
        throw new Error('A valid basic salary amount is required.');
      }
      // Remarks ride on the compensation row (ADR-0030); the tag itself carries only the type.
      return setCompensation(ctx, {
        employmentId: p.employmentId,
        basicSalary: p.basicSalary,
        remarks: remarks ?? undefined,
        effectiveFrom: p.effectiveDate,
        movement: { type: p.kind },
      });
    }

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

    case 'reportingLineChange':
      if (!p.managerEmploymentId) throw new Error('Select the new reporting manager.');
      return setReportingLine(ctx, {
        subordinateEmploymentId: p.employmentId,
        managerEmploymentId: p.managerEmploymentId,
        lineType: 'administrative',
        validFrom: p.effectiveDate,
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
