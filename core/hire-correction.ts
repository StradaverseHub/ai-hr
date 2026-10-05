/**
 * c063eea9 — "Correct hire details" on the Hired movement event.
 *
 * THE FAULT. The Hired event is locked (`employment.hired` is not in core/movement.ts's
 * REVERSIBLE_EVENT_TYPES), and every later movement CARRIES the hire's department, position, business
 * unit, cost centre and location forward onto its own assignment version. So a data-entry mistake made at
 * hire could not be fixed once any later event existed: the hire could not be edited, and correcting the
 * later records by hand would have meant rolling back years of history.
 *
 * WHAT THIS DOES — and, as importantly, what it never does:
 *
 *   • It NEVER edits the original `employment.hired` event. `domain_event` is append-only and hash-chained
 *     (migration 0001 revokes UPDATE/DELETE from the app role). The correction is a NEW event,
 *     `employment.hire.corrected`, carrying the actor, a mandatory reason, each field's before/after ids and
 *     the ids of every row it superseded and inserted. No salary is touched and none is recorded, so the
 *     ADR-0030 redact-to-reference rule has nothing to redact.
 *
 *   • It NEVER overwrites a dated row. Each assignment / reporting-line version it changes is SUPERSEDED
 *     (`superseded_at`) and re-inserted over exactly the same date range with the corrected value. The
 *     overlap exclusion (0001 `assignment_no_overlap`) applies only to `superseded_at IS NULL` rows, so the
 *     superseded original stays in the table as evidence beside its replacement.
 *
 *   • It carries the correction forward ONLY where a later record INHERITED the wrong value. The walk
 *     starts at version 1 (the version in force on the hire date), which always takes the correction. A
 *     later version takes it only if the event that CREATED it recorded the field unchanged
 *     (`before[f] === after[f]`) AND it still holds the value its predecessor held — the second half is
 *     what keeps a history disturbed by a mid-chain rollback from having a deliberate value overwritten.
 *     The walk stops, per field, at the first version where the field was set explicitly; a later
 *     deliberate choice (a Transfer to a new department) is kept, and so is everything after it.
 *
 *   • Fields it does not own are IGNORED even if posted. Only the six below are read from the submission
 *     (`parseHireCorrectionForm` and `correctHireDetails` both read the allow-list and nothing else).
 *     Company, Group Join Date and Join Date have their own audited paths; Job Grade and Employment Type
 *     are out of scope (grade history is a flat-column replay that cannot yet be placed back at the hire
 *     date safely, and employment type drives the probation / contract steps).
 *
 * THE CHAIN IDENTITY. A replaced row gets a new id, but the events that created the ORIGINAL rows still
 * name the original ids (`aggregateId`). The correction event records `supersededId → replacementId` for
 * every row it replaces, and `originMapOf` reads that back, so (a) a second correction can still find the
 * event that created a replaced version, and (b) core/movement.ts's Roll Back can still find the live
 * incarnation of the row a later movement created (see `liveIncarnationOf`). Nothing is matched by date.
 *
 * Permission: hr_admin or super_admin (the movement gate), PLUS `app.is_admin_for` the company of every
 * version the correction touches — a version from before an Entity Transfer belongs to the company the
 * employee was in THEN, and RLS alone (which resolves through today's company) would not ask.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import {
  appUser,
  assignment,
  businessUnit,
  company,
  costCenter,
  department,
  domainEvent,
  employment,
  jobGrade,
  location,
  payslip,
  person,
  position,
  reportingLine,
} from '../db/schema';
import { labelUsableByCompany } from './system-labels';
import { lockEmploymentStatutoryOwnerTx, wouldCreateAdminCycle } from './org';
import { todayInKualaLumpur } from '../lib/hr-date';

/** The event this module appends. Loaded by core/movement.ts's projection (it projects no row of its own). */
export const HIRE_CORRECTED_EVENT = 'employment.hire.corrected';

/** The assignment-owned fields a hire correction may move, in display order. */
export const HIRE_CORRECTION_ASSIGNMENT_FIELDS = [
  'departmentId',
  'positionId',
  'businessUnitId',
  'costCenterId',
  'locationId',
] as const;
export type HireCorrectionAssignmentField = (typeof HIRE_CORRECTION_ASSIGNMENT_FIELDS)[number];

/** Every field a hire correction may move: the five assignment fields plus the reporting manager at hire. */
export const HIRE_CORRECTION_FIELDS = [...HIRE_CORRECTION_ASSIGNMENT_FIELDS, 'managerEmploymentId'] as const;
export type HireCorrectionField = (typeof HIRE_CORRECTION_FIELDS)[number];

/** `undefined` (absent) = leave alone; `null` = clear (not allowed for department, which is required). */
export type HireCorrectionChanges = Partial<Record<HireCorrectionField, string | null>>;

export class HireCorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HireCorrectionError';
  }
}

export class HireCorrectionNoChangeError extends Error {
  constructor(message = 'Nothing to correct — every value is the same as the one already recorded at hire.') {
    super(message);
    this.name = 'HireCorrectionNoChangeError';
  }
}

export class HireCorrectionReasonRequiredError extends Error {
  constructor(message = 'A reason is required. Record why the hire details are being corrected.') {
    super(message);
    this.name = 'HireCorrectionReasonRequiredError';
  }
}

/**
 * Read the correction out of a submitted form. ONLY the six allow-listed names are read — a forged
 * `companyId`, `gradeId`, `employmentType`, `hiredOn`, `joinDate` or `basicSalary` is never looked at.
 * Absent = untouched; present-but-blank = clear. The form posts only the fields HR actually changed, so an
 * untouched field cannot overwrite a value someone else corrected after the form was rendered.
 */
export function parseHireCorrectionForm(formData: FormData): HireCorrectionChanges {
  const out: HireCorrectionChanges = {};
  for (const f of HIRE_CORRECTION_FIELDS) {
    const v = formData.get(f);
    if (v == null) continue;
    out[f] = String(v).trim() || null;
  }
  return out;
}

// ───────────────────────────── the chain ─────────────────────────────

type LedgerEvent = {
  id: string;
  eventType: string;
  aggregateId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  sequence: number;
  occurredAt: Date;
  actorId: string | null;
};

type AsgRow = typeof assignment.$inferSelect;
type RlRow = typeof reportingLine.$inferSelect;

/** The event types that create (or re-create) a version this module walks. */
const LEDGER_TYPES = [
  'employment.hired',
  'employment.assignment.changed',
  'assignment.transferred',
  'assignment.entity-backfilled',
  'reporting-line.set',
  HIRE_CORRECTED_EVENT,
];

/** One replaced row, as the correction event records it. */
type Replacement = {
  supersededId: string;
  replacementId: string;
  validFrom: string;
  validTo: string | null;
  companyId: string;
  fields: HireCorrectionAssignmentField[];
};

/**
 * replacementId → supersededId, for every row any hire correction has replaced (assignment and reporting
 * line alike — the ids are uuids, so one map serves both). Read from the ledger, never inferred from dates.
 */
export function originMapOf(correctionPayloads: unknown[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const raw of correctionPayloads) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (raw ?? {}) as any;
    for (const r of (Array.isArray(p.assignment) ? p.assignment : []) as Replacement[]) {
      if (r?.supersededId && r?.replacementId) m.set(r.replacementId, r.supersededId);
    }
    const rl = p.reportingLine;
    if (rl?.supersededId && rl?.replacementId) m.set(rl.replacementId, rl.supersededId);
  }
  return m;
}

/**
 * supersededId → replacementId, followed to the end: the row that NOW stands in for `id`. Used by Roll Back
 * (core/movement.ts reverseLegTx): a movement's event names the row it created, and if a hire correction
 * has since replaced that row, the rollback must act on the replacement or it silently does nothing.
 */
export function liveIncarnationOf(id: string, correctionPayloads: unknown[]): string {
  const forward = new Map<string, string>();
  for (const [replacement, superseded] of originMapOf(correctionPayloads)) forward.set(superseded, replacement);
  let cur = id;
  const seen = new Set<string>();
  while (forward.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = forward.get(cur)!;
  }
  return cur;
}

function rootOf(id: string, origin: Map<string, string>): string {
  let cur = id;
  const seen = new Set<string>();
  while (origin.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = origin.get(cur)!;
  }
  return cur;
}

const zeroLength = (r: { validFrom: string; validTo: string | null }) => r.validTo !== null && r.validTo <= r.validFrom;

/** The before/after pair the creating event recorded, or null when it recorded none for this field. */
function inheritedByEvent(origin: LedgerEvent | null, field: string): boolean {
  if (!origin) return false;
  const p = origin.payload ?? {};
  // A data-repair split (scripts/backfill-assignment-company.ts) copies EVERY dimension of the head it
  // splits, by construction — so each field of the tail was inherited.
  if (origin.eventType === 'assignment.entity-backfilled') return !!p.splitFromAssignmentId;
  let before: Record<string, unknown> | undefined;
  let after: Record<string, unknown> | undefined;
  if (origin.eventType === 'employment.assignment.changed') {
    before = p.before;
    after = p.after;
  } else if (origin.eventType === 'assignment.transferred') {
    // The legacy transfer writer recorded only department and location; for any other field the event
    // cannot prove inheritance, so the walk treats it as set there (the conservative answer).
    before = p.from;
    after = p.to;
  }
  if (!before || !after || !(field in before) || !(field in after)) return false;
  return ((before[field] as string | null) ?? null) === ((after[field] as string | null) ?? null);
}

type AsgVersion = {
  row: AsgRow;
  origin: LedgerEvent | null;
  /** The legal entity this version belongs to — `assignment.company_id`, else the resolver's fallback. */
  companyId: string;
  /** The movement kind (catalogue code) that created this version, from its event's tag. Null = untagged. */
  kind: string | null;
};

type HirePlan = {
  emp: { id: string; hiredOn: string; joinDate: string | null; companyId: string; gradeId: string | null; terminatedOn: string | null };
  chain: AsgVersion[];
  /** Per assignment field: how many versions, from version 1, take a correction of it (always ≥ 1). */
  span: Record<HireCorrectionAssignmentField, number>;
  /** The version a correction of each field stops at (it was set explicitly there), or null. */
  stop: Record<HireCorrectionAssignmentField, AsgVersion | null>;
  /** The hire date the chain starts on (version 1's valid_from). */
  anchor: string;
  /** The administrative reporting line in force on the anchor date, if any. */
  rlV1: RlRow | null;
  /** The first administrative line that starts after the anchor (it was set explicitly, so the walk stops). */
  rlNext: { row: RlRow; kind: string | null } | null;
  hiredEvent: LedgerEvent | null;
  corrections: LedgerEvent[];
};

const tagType = (e: LedgerEvent | null): string | null => {
  const t = e?.payload?.movement?.type;
  return typeof t === 'string' && t ? t : null;
};

async function loadPlanTx(tx: Tx, tenantId: string, employmentId: string): Promise<HirePlan> {
  const [emp] = await tx
    .select({
      id: employment.id,
      hiredOn: employment.hiredOn,
      joinDate: employment.joinDate,
      companyId: employment.companyId,
      gradeId: employment.gradeId,
      terminatedOn: employment.terminatedOn,
    })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp) throw new Error('Employment not found');

  const events: LedgerEvent[] = await tx
    .select({
      id: domainEvent.id,
      eventType: domainEvent.eventType,
      aggregateId: domainEvent.aggregateId,
      payload: domainEvent.payload,
      sequence: domainEvent.sequence,
      occurredAt: domainEvent.occurredAt,
      actorId: domainEvent.actorId,
    })
    .from(domainEvent)
    .where(
      and(
        eq(domainEvent.tenantId, tenantId),
        eq(domainEvent.subjectEmploymentId, employmentId),
        inArray(domainEvent.eventType, LEDGER_TYPES),
      ),
    )
    .orderBy(asc(domainEvent.sequence));

  const corrections = events.filter((e) => e.eventType === HIRE_CORRECTED_EVENT);
  const origin = originMapOf(corrections.map((e) => e.payload));
  const creatorOf = new Map<string, LedgerEvent>();
  for (const e of events) {
    if (
      e.eventType === 'employment.assignment.changed' ||
      e.eventType === 'assignment.transferred' ||
      e.eventType === 'reporting-line.set' ||
      (e.eventType === 'assignment.entity-backfilled' && e.payload?.splitFromAssignmentId)
    ) {
      creatorOf.set(e.aggregateId, e);
    }
  }

  // ── assignment chain ──
  const allAsg = await tx.select().from(assignment).where(eq(assignment.employmentId, employmentId));
  const asgById = new Map(allAsg.map((r) => [r.id, r]));
  const rootCreated = (r: AsgRow) => (asgById.get(rootOf(r.id, origin)) ?? r).createdAt.getTime();
  const live = allAsg
    .filter((r) => !r.supersededAt)
    .sort((a, b) => {
      if (a.validFrom !== b.validFrom) return a.validFrom < b.validFrom ? -1 : 1;
      // A zero-length version on a date sorts before the version that replaced it the same day.
      const az = zeroLength(a) ? 0 : 1;
      const bz = zeroLength(b) ? 0 : 1;
      if (az !== bz) return az - bz;
      return rootCreated(a) - rootCreated(b);
    });
  // Version 1 is the first version that covers a day. A zero-length row BEFORE it is dead history — the
  // pre-transaction company correction leaves one on the hire date when it re-homes the hire.
  const v1Index = live.findIndex((r) => !zeroLength(r));
  if (v1Index < 0) throw new HireCorrectionError('This employee has no organisation assignment to correct.');
  const chain: AsgVersion[] = live.slice(v1Index).map((row) => {
    const o = creatorOf.get(rootOf(row.id, origin)) ?? null;
    return { row, origin: o, companyId: row.companyId ?? emp.companyId, kind: tagType(o) };
  });

  const span = {} as Record<HireCorrectionAssignmentField, number>;
  const stop = {} as Record<HireCorrectionAssignmentField, AsgVersion | null>;
  for (const f of HIRE_CORRECTION_ASSIGNMENT_FIELDS) {
    let n = 1;
    while (n < chain.length) {
      const v = chain[n];
      const prev = chain[n - 1];
      const inherited =
        inheritedByEvent(v.origin, f) && ((v.row[f] as string | null) ?? null) === ((prev.row[f] as string | null) ?? null);
      if (!inherited) break;
      n++;
    }
    span[f] = n;
    stop[f] = n < chain.length ? chain[n] : null;
  }

  const anchor = chain[0].row.validFrom;

  // ── reporting line at hire ──
  const lines = await tx
    .select()
    .from(reportingLine)
    .where(
      and(
        eq(reportingLine.subordinateEmploymentId, employmentId),
        eq(reportingLine.lineType, 'administrative'),
        isNull(reportingLine.supersededAt),
      ),
    )
    .orderBy(asc(reportingLine.validFrom));
  const covering = lines.filter((l) => l.validFrom <= anchor && (l.validTo === null || l.validTo > anchor));
  const rlV1 = covering.length ? covering[covering.length - 1] : null;
  const nextRow = lines.find((l) => l.validFrom > anchor && l.id !== rlV1?.id && !zeroLength(l)) ?? null;
  const rlNext = nextRow ? { row: nextRow, kind: tagType(creatorOf.get(rootOf(nextRow.id, origin)) ?? null) } : null;

  return {
    emp,
    chain,
    span,
    stop,
    anchor,
    rlV1,
    rlNext,
    hiredEvent: events.find((e) => e.eventType === 'employment.hired') ?? null,
    corrections,
  };
}

/** The value of a field on the hire (version 1 / the line in force at hire). */
function hireValueOf(plan: HirePlan, f: HireCorrectionField): string | null {
  if (f === 'managerEmploymentId') return plan.rlV1?.managerEmploymentId ?? null;
  return (plan.chain[0].row[f] as string | null) ?? null;
}

/** Per field, the value first recorded at hire: the earliest correction's `before`, else today's hire value. */
function originalValuesOf(plan: HirePlan): Record<HireCorrectionField, string | null> {
  const out = {} as Record<HireCorrectionField, string | null>;
  for (const f of HIRE_CORRECTION_FIELDS) out[f] = hireValueOf(plan, f);
  const seen = new Set<string>();
  for (const e of plan.corrections) {
    for (const c of (Array.isArray(e.payload?.changes) ? e.payload.changes : []) as { field: string; before: string | null }[]) {
      if (seen.has(c.field) || !(HIRE_CORRECTION_FIELDS as readonly string[]).includes(c.field)) continue;
      seen.add(c.field);
      out[c.field as HireCorrectionField] = c.before ?? null;
    }
  }
  return out;
}

// ───────────────────────────── labels ─────────────────────────────

type LabelIds = Partial<Record<HireCorrectionField, (string | null | undefined)[]>>;

/** id → display label, per field, in one round trip per kind. Archived labels still resolve (history). */
async function labelsTx(tx: Tx, ids: LabelIds): Promise<Record<HireCorrectionField, Map<string, string>>> {
  const want = (f: HireCorrectionField) => [...new Set((ids[f] ?? []).filter((v): v is string => !!v))];
  const out = {} as Record<HireCorrectionField, Map<string, string>>;
  for (const f of HIRE_CORRECTION_FIELDS) out[f] = new Map();
  const d = want('departmentId');
  if (d.length)
    for (const r of await tx.select({ id: department.id, n: department.name }).from(department).where(inArray(department.id, d)))
      out.departmentId.set(r.id, r.n);
  const p = want('positionId');
  if (p.length)
    for (const r of await tx.select({ id: position.id, n: position.title }).from(position).where(inArray(position.id, p)))
      out.positionId.set(r.id, r.n);
  const bu = want('businessUnitId');
  if (bu.length)
    for (const r of await tx.select({ id: businessUnit.id, n: businessUnit.name }).from(businessUnit).where(inArray(businessUnit.id, bu)))
      out.businessUnitId.set(r.id, r.n);
  const cc = want('costCenterId');
  if (cc.length)
    for (const r of await tx
      .select({ id: costCenter.id, code: costCenter.code, n: costCenter.name })
      .from(costCenter)
      .where(inArray(costCenter.id, cc)))
      out.costCenterId.set(r.id, `${r.code} — ${r.n}`);
  const loc = want('locationId');
  if (loc.length)
    for (const r of await tx
      .select({ id: location.id, code: location.code, n: location.name })
      .from(location)
      .where(inArray(location.id, loc)))
      out.locationId.set(r.id, `${r.n} (${r.code})`);
  const m = want('managerEmploymentId');
  if (m.length)
    for (const r of await tx
      .select({ id: employment.id, n: person.fullName })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(inArray(employment.id, m)))
      out.managerEmploymentId.set(r.id, r.n);
  return out;
}

// ───────────────────────────── the trace on the Hired row ─────────────────────────────

/** What the Hired row shows once its details have been corrected. Labels, resolved at read time. */
export type HireCorrectionTrace = {
  /** When the LATEST correction was recorded. */
  at: Date;
  /** Who recorded the latest correction (null for a SYSTEM actor or a person row that is gone). */
  by: string | null;
  reason: string | null;
  /** How many corrections the hire has had. */
  count: number;
  /** Each field ever corrected: what the hire originally recorded, and what it holds after the corrections. */
  fields: { field: HireCorrectionField; original: string | null; corrected: string | null }[];
};

/**
 * Build the Hired row's trace from the correction events (ledger order). Called by core/movement.ts with
 * the events its projection already loaded, inside its own transaction. Null when there were none.
 */
export async function hireCorrectionTraceTx(
  tx: Tx,
  corrections: { payload: unknown; occurredAt: Date; actorId: string | null }[],
): Promise<HireCorrectionTrace | null> {
  if (!corrections.length) return null;
  const firstBefore = new Map<HireCorrectionField, string | null>();
  const lastAfter = new Map<HireCorrectionField, string | null>();
  for (const e of corrections) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const changes = (((e.payload ?? {}) as any).changes ?? []) as { field: string; before: string | null; after: string | null }[];
    for (const c of changes) {
      if (!(HIRE_CORRECTION_FIELDS as readonly string[]).includes(c.field)) continue;
      const f = c.field as HireCorrectionField;
      if (!firstBefore.has(f)) firstBefore.set(f, c.before ?? null);
      lastAfter.set(f, c.after ?? null);
    }
  }
  const ids: LabelIds = {};
  for (const f of HIRE_CORRECTION_FIELDS) ids[f] = [firstBefore.get(f), lastAfter.get(f)];
  const labels = await labelsTx(tx, ids);
  const latest = corrections[corrections.length - 1];
  let by: string | null = null;
  if (latest.actorId) {
    const [a] = await tx
      .select({ name: person.fullName })
      .from(appUser)
      .innerJoin(person, eq(person.id, appUser.personId))
      .where(eq(appUser.id, latest.actorId))
      .limit(1);
    by = a?.name ?? null;
  }
  const label = (f: HireCorrectionField, id: string | null | undefined) => (id ? (labels[f].get(id) ?? null) : null);
  return {
    at: latest.occurredAt,
    by,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reason: ((((latest.payload ?? {}) as any).reason as string | null) ?? null),
    count: corrections.length,
    fields: HIRE_CORRECTION_FIELDS.filter((f) => firstBefore.has(f)).map((f) => ({
      field: f,
      original: label(f, firstBefore.get(f)),
      corrected: label(f, lastAfter.get(f)),
    })),
  };
}

// ───────────────────────────── the form's read ─────────────────────────────

/** A later record a correction of one field would also change, or the one it stops at. */
export type HireCorrectionLaterRecord = { kind: string | null; effectiveDate: string };

export type HireCorrectionFieldView = {
  field: HireCorrectionField;
  /** What the hire holds today (the select's starting value). */
  currentId: string | null;
  currentLabel: string | null;
  /** What the hire ORIGINALLY recorded — before any hire correction. Equal to current when never corrected. */
  originalId: string | null;
  originalLabel: string | null;
  /** Later records that inherited this field and would take the correction, in date order. */
  carriesInto: HireCorrectionLaterRecord[];
  /** The later record where this field was set explicitly — the correction stops before it. */
  stoppedBy: HireCorrectionLaterRecord | null;
  /** True when the employee's CURRENT record still holds the hire value, so it changes too. */
  reachesCurrent: boolean;
};

export type HireCorrectionView = {
  /** The date the hire chain starts on (version 1's valid_from — the Hired row's date). */
  hiredOn: string;
  /** The legal entity of version 1: the company every correctable label must be usable by. */
  companyId: string;
  companyName: string | null;
  /** Read-only context the form points elsewhere for. */
  groupJoinDate: string;
  joinDate: string | null;
  gradeName: string | null;
  employmentType: string | null;
  /** True once any payslip exists for this employment (decides which Company pointer applies). */
  hasPayslips: boolean;
  fields: HireCorrectionFieldView[];
  /** Every company a correction of some field would reach (version 1 plus inherited later versions). */
  reachedCompanyIds: string[];
};

export function hireCorrectionView(ctx: SessionContext, employmentId: string): Promise<HireCorrectionView> {
  return withTenant(ctx, async (tx) => {
    const plan = await loadPlanTx(tx, ctx.tenantId, employmentId);
    const original = originalValuesOf(plan);
    const ids: LabelIds = {};
    for (const f of HIRE_CORRECTION_FIELDS) ids[f] = [hireValueOf(plan, f), original[f]];
    const labels = await labelsTx(tx, ids);
    const label = (f: HireCorrectionField, id: string | null) => (id ? (labels[f].get(id) ?? null) : null);

    const fields: HireCorrectionFieldView[] = HIRE_CORRECTION_FIELDS.map((f) => {
      const currentId = hireValueOf(plan, f);
      if (f === 'managerEmploymentId') {
        const rl = plan.rlV1;
        return {
          field: f,
          currentId,
          currentLabel: label(f, currentId),
          originalId: original[f],
          originalLabel: label(f, original[f]),
          carriesInto: [],
          stoppedBy: plan.rlNext ? { kind: plan.rlNext.kind, effectiveDate: plan.rlNext.row.validFrom } : null,
          reachesCurrent: rl ? rl.validTo === null : !plan.rlNext && !plan.emp.terminatedOn,
        };
      }
      const n = plan.span[f];
      return {
        field: f,
        currentId,
        currentLabel: label(f, currentId),
        originalId: original[f],
        originalLabel: label(f, original[f]),
        carriesInto: plan.chain
          .slice(1, n)
          .filter((v) => !zeroLength(v.row))
          .map((v) => ({ kind: v.kind, effectiveDate: v.row.validFrom })),
        stoppedBy: plan.stop[f] ? { kind: plan.stop[f]!.kind, effectiveDate: plan.stop[f]!.row.validFrom } : null,
        reachesCurrent: plan.chain[n - 1].row.validTo === null,
      };
    });

    const v1 = plan.chain[0];
    const [co] = await tx.select({ name: company.legalName }).from(company).where(eq(company.id, v1.companyId)).limit(1);
    // Job Grade at hire: the hire event's own value where it recorded one (read-only on this form).
    const hireGradeId: string | null =
      plan.hiredEvent && plan.hiredEvent.payload && 'gradeId' in plan.hiredEvent.payload
        ? ((plan.hiredEvent.payload.gradeId as string | null) ?? null)
        : plan.emp.gradeId;
    let gradeName: string | null = null;
    if (hireGradeId) {
      const [g] = await tx.select({ name: jobGrade.name }).from(jobGrade).where(eq(jobGrade.id, hireGradeId)).limit(1);
      gradeName = g?.name ?? null;
    }
    const [ps] = await tx.select({ id: payslip.id }).from(payslip).where(eq(payslip.employmentId, employmentId)).limit(1);
    const maxSpan = Math.max(...HIRE_CORRECTION_ASSIGNMENT_FIELDS.map((f) => plan.span[f]));
    return {
      hiredOn: plan.anchor,
      companyId: v1.companyId,
      companyName: co?.name ?? null,
      groupJoinDate: plan.emp.hiredOn,
      joinDate: plan.emp.joinDate,
      gradeName,
      employmentType: v1.row.employmentType,
      hasPayslips: !!ps,
      fields,
      reachedCompanyIds: [...new Set(plan.chain.slice(0, maxSpan).map((v) => v.companyId))],
    };
  });
}

// ───────────────────────────── the write ─────────────────────────────

const FIELD_NAME: Record<HireCorrectionField, string> = {
  departmentId: 'Department',
  positionId: 'Position',
  businessUnitId: 'Business Unit',
  costCenterId: 'Cost Centre',
  locationId: 'Location',
  managerEmploymentId: 'Reporting manager',
};

async function companyNameTx(tx: Tx, companyId: string): Promise<string> {
  const [c] = await tx.select({ name: company.legalName }).from(company).where(eq(company.id, companyId)).limit(1);
  return c?.name ?? 'that company';
}

/** Is `value` a live label of this field that `companyId` may use? Same rules the assignment writers apply. */
async function labelValidForCompany(
  tx: Tx,
  tenantId: string,
  f: HireCorrectionAssignmentField,
  value: string,
  companyId: string,
): Promise<boolean> {
  if (f === 'locationId') {
    // Location is company-owned master data, not a shared System Label — the direct same-company check.
    const [loc] = await tx
      .select({ companyId: location.companyId, archivedAt: location.archivedAt })
      .from(location)
      .where(eq(location.id, value))
      .limit(1);
    return !!loc && !loc.archivedAt && loc.companyId === companyId;
  }
  const spec = {
    departmentId: { table: department, kind: 'department' as const },
    positionId: { table: position, kind: 'position' as const },
    businessUnitId: { table: businessUnit, kind: 'business_unit' as const },
    costCenterId: { table: costCenter, kind: 'cost_center' as const },
  }[f];
  const [row] = await tx
    .select({ archivedAt: spec.table.archivedAt })
    .from(spec.table)
    .where(eq(spec.table.id, value))
    .limit(1);
  if (!row || row.archivedAt) return false;
  return labelUsableByCompany(tx, tenantId, spec.kind, value, companyId);
}

export type CorrectHireDetailsInput = {
  employmentId: string;
  /** Loosely typed ON PURPOSE: only the allow-listed fields are ever read from it (see the module header). */
  changes: HireCorrectionChanges & Record<string, unknown>;
  reason?: string | null;
};

export type CorrectHireDetailsResult = {
  employmentId: string;
  /** The hire date the correction applies from (version 1's valid_from). */
  hiredOn: string;
  changes: { field: HireCorrectionField; before: string | null; after: string | null }[];
  /** Fields whose value on the employee's CURRENT record changed. */
  currentRecordChanged: HireCorrectionField[];
  /** How many assignment versions were superseded and re-inserted. */
  assignmentVersions: number;
};

/**
 * Correct the hire's department / position / business unit / cost centre / location and reporting manager.
 * One transaction: every refusal is raised before anything is written, and the event is appended last.
 */
export async function correctHireDetails(
  ctx: SessionContext,
  input: CorrectHireDetailsInput,
): Promise<CorrectHireDetailsResult> {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new Error('Only an admin can correct hire details.');
  }
  const reason = input.reason?.trim() || null;
  if (!reason) throw new HireCorrectionReasonRequiredError();

  // The allow-list is the only reader of `changes`. Anything else on the object is never looked at.
  const requested: HireCorrectionChanges = {};
  for (const f of HIRE_CORRECTION_FIELDS) {
    const v = input.changes[f];
    if (v === undefined) continue;
    requested[f] = v === null ? null : String(v).trim() || null;
  }
  if (requested.departmentId === null) throw new HireCorrectionError('Department is required.');

  return withTenant(ctx, async (tx) => {
    // Same lock order as every movement writer: the person's statutory owner, then the employment row.
    // Holding the employment row for the whole correction serialises two corrections of one hire.
    await lockEmploymentStatutoryOwnerTx(tx, input.employmentId);
    const [locked] = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(eq(employment.id, input.employmentId))
      .limit(1)
      .for('no key update');
    if (!locked) throw new Error('Employment not found');

    const plan = await loadPlanTx(tx, ctx.tenantId, input.employmentId);

    // The effective change set: a requested value equal to the hire's own value is not a change.
    const changes: { field: HireCorrectionField; before: string | null; after: string | null }[] = [];
    for (const f of HIRE_CORRECTION_FIELDS) {
      if (!(f in requested)) continue;
      const before = hireValueOf(plan, f);
      const after = requested[f] ?? null;
      if (after === before) continue;
      changes.push({ field: f, before, after });
    }
    if (!changes.length) throw new HireCorrectionNoChangeError();
    const changed = new Map(changes.map((c) => [c.field, c.after]));

    // ── which assignment versions take which fields ──
    const perVersion: { v: AsgVersion; fields: HireCorrectionAssignmentField[] }[] = [];
    plan.chain.forEach((v, i) => {
      const fields = HIRE_CORRECTION_ASSIGNMENT_FIELDS.filter((f) => changed.has(f) && i < plan.span[f]);
      if (fields.length) perVersion.push({ v, fields });
    });

    // ── validate every new label against the company of EVERY version it lands on ──
    for (const { v, fields } of perVersion) {
      for (const f of fields) {
        const value = changed.get(f) ?? null;
        if (value === null) continue;
        if (!(await labelValidForCompany(tx, ctx.tenantId, f, value, v.companyId))) {
          const co = await companyNameTx(tx, v.companyId);
          throw new HireCorrectionError(
            v === plan.chain[0]
              ? `The selected ${FIELD_NAME[f]} is not a valid option for ${co}, the company the employee was hired into.`
              : `The selected ${FIELD_NAME[f]} is not a valid option for ${co}, the company on the record from ${v.row.validFrom} that carried the hire value forward. Choose a ${FIELD_NAME[f]} that company can use.`,
          );
        }
      }
    }

    // ── reporting manager at hire ──
    let rlPlan: { supersede: RlRow | null; insert: { from: string; to: string | null; manager: string } | null } | null = null;
    if (changed.has('managerEmploymentId')) {
      const manager = changed.get('managerEmploymentId') ?? null;
      const from = plan.rlV1?.validFrom ?? plan.anchor;
      let to: string | null;
      if (plan.rlV1) {
        to = plan.rlV1.validTo;
      } else {
        // No manager was recorded at hire: the new line runs until the first line someone set later, or
        // until the employment ended, whichever comes first — never over a later deliberate choice.
        const ends = [plan.rlNext?.row.validFrom, plan.emp.terminatedOn].filter((d): d is string => !!d);
        to = ends.length ? ends.sort()[0] : null;
        if (to !== null && to <= from) {
          throw new HireCorrectionError('A reporting manager at hire cannot be added here — a later reporting line already starts on the hire date.');
        }
      }
      if (manager) {
        if (manager === input.employmentId) throw new HireCorrectionError('An employee cannot report to themselves.');
        const [m] = await tx.select({ id: employment.id }).from(employment).where(eq(employment.id, manager)).limit(1);
        if (!m) throw new HireCorrectionError('The selected reporting manager could not be found.');
        // The SAME cycle rule setReportingLine applies, asked at the start of the range and, for a range
        // that is still running, today as well (the chain above the manager may have moved since hire).
        const today = todayInKualaLumpur();
        const checkDates = [from];
        if (from < today && (to === null || to > today)) checkDates.push(today);
        for (const d of checkDates) {
          if (await wouldCreateAdminCycle(tx, input.employmentId, manager, d)) {
            throw new HireCorrectionError(
              'This reporting manager would create a reporting cycle (they report, directly or indirectly, to this employee).',
            );
          }
        }
      }
      rlPlan = { supersede: plan.rlV1, insert: manager ? { from, to, manager } : null };
    }

    // ── permission: the actor must administer the company of every record the correction touches ──
    const companies = new Set<string>(perVersion.map((x) => x.v.companyId));
    if (rlPlan) companies.add(plan.chain[0].companyId);
    for (const c of companies) {
      const res = await tx.execute(sql`select app.is_admin_for(${c}::uuid) as ok`);
      if (!(res as unknown as { ok: boolean }[])[0]?.ok) {
        const co = await companyNameTx(tx, c);
        throw new HireCorrectionError(
          `You can only correct these hire details if you manage ${co}, the company on a record this correction changes.`,
        );
      }
    }

    // ── writes ──
    const now = new Date();
    const replaced: Replacement[] = [];
    for (const { v, fields } of perVersion) {
      const done = await tx
        .update(assignment)
        .set({ supersededAt: now })
        .where(and(eq(assignment.id, v.row.id), isNull(assignment.supersededAt)))
        .returning({ id: assignment.id });
      if (done.length !== 1) throw new HireCorrectionError('The hire record changed while it was being corrected. Reload and try again.');
      const next: Partial<Record<HireCorrectionAssignmentField, string | null>> = {};
      for (const f of fields) next[f] = changed.get(f) ?? null;
      const [ins] = await tx
        .insert(assignment)
        .values({
          tenantId: v.row.tenantId,
          employmentId: v.row.employmentId,
          departmentId: (next.departmentId ?? v.row.departmentId) as string,
          positionId: 'positionId' in next ? (next.positionId ?? null) : v.row.positionId,
          businessUnitId: 'businessUnitId' in next ? (next.businessUnitId ?? null) : v.row.businessUnitId,
          costCenterId: 'costCenterId' in next ? (next.costCenterId ?? null) : v.row.costCenterId,
          locationId: 'locationId' in next ? (next.locationId ?? null) : v.row.locationId,
          companyId: v.row.companyId,
          employmentType: v.row.employmentType,
          validFrom: v.row.validFrom,
          validTo: v.row.validTo,
        })
        .returning({ id: assignment.id });
      replaced.push({
        supersededId: v.row.id,
        replacementId: ins.id,
        validFrom: v.row.validFrom,
        validTo: v.row.validTo,
        companyId: v.companyId,
        fields,
      });
    }

    let rlRecord: { supersededId: string | null; replacementId: string | null; validFrom: string; validTo: string | null } | null = null;
    if (rlPlan) {
      if (rlPlan.supersede) {
        const done = await tx
          .update(reportingLine)
          .set({ supersededAt: now })
          .where(and(eq(reportingLine.id, rlPlan.supersede.id), isNull(reportingLine.supersededAt)))
          .returning({ id: reportingLine.id });
        if (done.length !== 1) throw new HireCorrectionError('The hire record changed while it was being corrected. Reload and try again.');
      }
      let replacementId: string | null = null;
      if (rlPlan.insert) {
        const [ins] = await tx
          .insert(reportingLine)
          .values({
            tenantId: ctx.tenantId,
            subordinateEmploymentId: input.employmentId,
            managerEmploymentId: rlPlan.insert.manager,
            lineType: 'administrative',
            validFrom: rlPlan.insert.from,
            validTo: rlPlan.insert.to,
          })
          .returning({ id: reportingLine.id });
        replacementId = ins.id;
      }
      rlRecord = {
        supersededId: rlPlan.supersede?.id ?? null,
        replacementId,
        validFrom: rlPlan.insert?.from ?? rlPlan.supersede!.validFrom,
        validTo: rlPlan.insert ? rlPlan.insert.to : rlPlan.supersede!.validTo,
      };
    }

    const openRow = plan.chain.find((v) => v.row.validTo === null) ?? null;
    const currentRecordChanged: HireCorrectionField[] = [];
    for (const r of replaced) {
      if (openRow && r.supersededId === openRow.row.id) currentRecordChanged.push(...r.fields);
    }
    if (rlRecord && (rlRecord.validTo === null)) currentRecordChanged.push('managerEmploymentId');
    if (rlRecord && rlRecord.validTo === null && rlRecord.replacementId === null && plan.rlV1?.validTo === null) {
      // cleared an open line: the current record changed too (already pushed above)
    }

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: input.employmentId,
      eventType: HIRE_CORRECTED_EVENT,
      actor: actorOf(ctx),
      subjectEmploymentId: input.employmentId,
      payload: {
        employmentId: input.employmentId,
        // The original hire event is NEVER edited; it is referenced. Null for a seeded/legacy employment
        // that never had one (its Hired row is synthesised by the projection).
        hiredEventId: plan.hiredEvent?.id ?? null,
        hiredOn: plan.anchor,
        reason,
        changes,
        assignment: replaced,
        reportingLine: rlRecord,
        currentRecordChanged,
      },
    });

    return {
      employmentId: input.employmentId,
      hiredOn: plan.anchor,
      changes,
      currentRecordChanged,
      assignmentVersions: replaced.length,
    };
  });
}
