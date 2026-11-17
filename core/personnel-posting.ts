/**
 * Personnel postings (ADR docs/adr/2026-11-15-probation-shared-automation.md, decision 4; migration 5741).
 *
 * A posting is a proposed Personnel Management change that a workflow (Probation first) creates. Personnel owns the
 * fact: the posting holds proposed values, and only approval writes the movement, through the same writer the New
 * Event form uses (createMovementEventTx). Personnel movements therefore need no pending state of their own.
 *
 * Authority (all enforced in the database functions, never by hiding a button):
 *  - create: the Probation owner path only (storage runner or the GBS holder releasing the outcome), for a case of
 *    that employment with a released outcome of the matching kind. createPersonnelPostingTx is for that path.
 *  - edit: anyone who may record movements for the employment; the correction stays on the posting, still pending.
 *  - approve: only members of the posting's approver group. Approval and the movement it applies are one
 *    transaction: if the movement writer refuses, nothing is approved. The approver also needs the movement writer's
 *    own authority (Personnel admin with workforce maintain for the company): approval never widens who may write.
 *
 * Reads are bounded and set-based under row security.
 */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {withScopedLifecycleTenant} from './module-gate';
import {createMovementEventTx,movementLedgerMarkerTx,movementRowsAfterSequenceTx} from './movement';
import type {ContractPostingApprovalOutcome} from '../packs/contracts/service';
import {movementNeedsEntitlementReprojection} from './movement-kinds';
import {
  isPersonnelPostingEvent,normalisePostingValues,postingCurrentValues,postingDisplayStatus,postingLabel,
  type PersonnelPostingDisplayStatus,type PersonnelPostingEvent,type PersonnelPostingSource,type PersonnelPostingStatus,type PersonnelPostingValues,
} from '../lib/personnel-posting';

export class PersonnelPostingError extends Error {
  constructor(public readonly code: 'forbidden' | 'invalid' | 'conflict' | 'not_found', message: string) { super(message); this.name = 'PersonnelPostingError'; }
}
export const MAX_LISTED_POSTINGS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PersonnelPosting = {
  id: string; number: number; label: string;
  companyId: string; employmentId: string; employeeName: string | null; employeeCode: string | null;
  source: PersonnelPostingSource; sourceRef: string; eventType: PersonnelPostingEvent;
  proposed: PersonnelPostingValues; edited: PersonnelPostingValues | null; applied: PersonnelPostingValues | null;
  /** The values in effect (applied, else the latest correction, else proposed). */
  current: PersonnelPostingValues;
  editedBy: { id: string; name: string | null } | null; editedAt: string | null;
  approverGroupId: string; approverGroupName: string | null;
  status: PersonnelPostingStatus; displayStatus: PersonnelPostingDisplayStatus;
  approvedBy: { id: string; name: string | null } | null; approvedAt: string | null;
  movementId: string | null; createdAt: string; revision: number;
  /** For the current user: a member of the approver group (the database decides again on approval). */
  canApprove: boolean;
  /** For the current user: may record movements for this employment, so may correct the posting. */
  canEdit: boolean;
};
type Row = {
  id: string; number: number; companyId: string; employmentId: string; employeeName: string | null; employeeCode: string | null;
  source: PersonnelPostingSource; sourceRef: string; eventType: PersonnelPostingEvent;
  proposed: PersonnelPostingValues; edited: PersonnelPostingValues | null; applied: PersonnelPostingValues | null;
  editedBy: string | null; editedAt: string | null; approverGroupId: string; status: PersonnelPostingStatus;
  approvedBy: string | null; approvedAt: string | null; movementId: string | null; createdAt: string; revision: number;
  canApprove: boolean; canEdit: boolean;
};

function mapDatabaseError(e: unknown): never {
  if (e instanceof PersonnelPostingError) throw e;
  const state = pgSqlState(e);
  if (state === '42501') throw new PersonnelPostingError('forbidden', 'You cannot do this with this posting.');
  if (state === '40001') throw new PersonnelPostingError('conflict', 'This posting changed or was already approved. Reload the page and try again.');
  if (state === '22023' || state === '23514') throw new PersonnelPostingError('invalid', 'The posting details are incomplete or not allowed.');
  throw e;
}
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e) { mapDatabaseError(e); }
}

const selectRows = (where: ReturnType<typeof sql>, limit: number, offset = 0) => sql`
  select p.id, p.number, p.company_id as "companyId", p.employment_id as "employmentId",
    per.full_name as "employeeName", e.employee_code as "employeeCode",
    p.source, p.source_ref as "sourceRef", p.event_type as "eventType", p.proposed, p.edited, p.applied,
    p.edited_by as "editedBy", to_char(p.edited_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "editedAt", p.approver_group_id as "approverGroupId", p.status,
    p.approved_by as "approvedBy", to_char(p.approved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "approvedAt", p.movement_id as "movementId",
    to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt", p.revision,
    coalesce(app.personnel_posting_approver(p.approver_group_id), false) as "canApprove",
    coalesce(app.access_workforce_employment(p.employment_id, 'workforce.maintain'), false) as "canEdit"
  from personnel_posting p
  left join employment e on e.id = p.employment_id and e.tenant_id = p.tenant_id
  left join person per on per.id = e.person_id and per.tenant_id = e.tenant_id
  where p.tenant_id = app.current_tenant_id() and ${where}
  order by p.created_at desc, p.number desc
  limit ${limit} offset ${offset}`;

/** One bound PostgreSQL array literal (drizzle expands a JS array into a parameter list, not an array). */
const pgArray = (values: readonly string[]) => '{' + values.map((v) => '"' + v.replace(/[\\"]/g, (c) => '\\' + c) + '"').join(',') + '}';
/** Names and group labels for a bounded page of rows, in two set-based reads. */
async function present(tx: Tx, rows: Row[]): Promise<PersonnelPosting[]> {
  const users = [...new Set(rows.flatMap((r) => [r.editedBy, r.approvedBy]).filter((id): id is string => !!id))];
  const groups = [...new Set(rows.map((r) => r.approverGroupId))];
  const people: { userId: string; fullName: string | null }[] = users.length
    ? [...await tx.execute<{ userId: string; fullName: string | null }>(sql`select user_id as "userId", full_name as "fullName" from app.personnel_posting_people(${pgArray(users)}::uuid[])`)] : [];
  const groupNames: { groupId: string; groupName: string | null }[] = groups.length
    ? [...await tx.execute<{ groupId: string; groupName: string | null }>(sql`select group_id as "groupId", group_name as "groupName" from app.personnel_posting_groups(${pgArray(groups)}::text[])`)] : [];
  const name = new Map(people.map((p) => [p.userId, p.fullName]));
  const group = new Map(groupNames.map((g) => [g.groupId, g.groupName]));
  return rows.map((r) => ({
    id: r.id, number: r.number, label: postingLabel(r.number), companyId: r.companyId, employmentId: r.employmentId,
    employeeName: r.employeeName, employeeCode: r.employeeCode, source: r.source, sourceRef: r.sourceRef, eventType: r.eventType,
    proposed: r.proposed, edited: r.edited, applied: r.applied, current: postingCurrentValues(r),
    editedBy: r.editedBy ? { id: r.editedBy, name: name.get(r.editedBy) ?? null } : null, editedAt: r.editedAt,
    approverGroupId: r.approverGroupId, approverGroupName: group.get(r.approverGroupId) ?? null,
    status: r.status, displayStatus: postingDisplayStatus(r),
    approvedBy: r.approvedBy ? { id: r.approvedBy, name: name.get(r.approvedBy) ?? null } : null, approvedAt: r.approvedAt,
    movementId: r.movementId, createdAt: r.createdAt, revision: r.revision, canApprove: r.canApprove, canEdit: r.canEdit,
  }));
}

export type PersonnelPostingFilters = { source?:PersonnelPostingSource; status?: 'pending' | 'approved' | 'all'; employmentId?: string; limit?: number; offset?: number };
export type PersonnelPostingPage = { rows: PersonnelPosting[]; offset: number; limit: number; hasMore: boolean };

/** The queue: postings the user may read (row security), newest first, one bounded page. */
export async function listPersonnelPostings(ctx: SessionContext, filters: PersonnelPostingFilters = {}): Promise<PersonnelPostingPage> {
  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 50), 1), MAX_LISTED_POSTINGS);
  const offset = Math.min(Math.max(Math.trunc(filters.offset ?? 0), 0), 100000);
  const status = filters.status ?? 'all';
  if (!['pending', 'approved', 'all'].includes(status)) throw new PersonnelPostingError('invalid', 'Unknown posting status.');
  if (filters.employmentId !== undefined && !UUID.test(filters.employmentId)) throw new PersonnelPostingError('invalid', 'Unknown employee.');
  return withScopedLifecycleTenant(ctx, async (tx) => {
    const source=filters.source??'probation';
    if(!['probation','contract_staff'].includes(source))throw new PersonnelPostingError('invalid','Unknown posting source.');
    const where = sql`p.source=${source} and (${status}::text = 'all' or p.status = ${status}::text) and (${filters.employmentId ?? null}::uuid is null or p.employment_id = ${filters.employmentId ?? null}::uuid)`;
    const rows = await tx.execute<Row>(selectRows(where, limit + 1, offset));
    return { rows: await present(tx, [...rows].slice(0, limit)), offset, limit, hasMore: rows.length > limit };
  });
}

/** One posting the user may read, or null. */
export function personnelPosting(ctx: SessionContext, id: string): Promise<PersonnelPosting | null> {
  if (!UUID.test(id)) return Promise.resolve(null);
  return withTenant(ctx, (tx) => personnelPostingTx(tx, id));
}
export async function personnelPostingTx(tx: Tx, id: string): Promise<PersonnelPosting | null> {
  if (!UUID.test(id)) return null;
  const rows = await tx.execute<Row>(selectRows(sql`p.id = ${id}::uuid`, 1));
  return rows.length ? (await present(tx, [...rows]))[0] : null;
}

/** Postings for one source record (for the owning workflow, e.g. the Probation case), oldest first. Bounded. */
export async function personnelPostingsForSourceTx(tx: Tx, source: PersonnelPostingSource, sourceRef: string): Promise<{ id: string; number: number; eventType: PersonnelPostingEvent; status: PersonnelPostingStatus; current: PersonnelPostingValues; movementId: string | null }[]> {
  if (!UUID.test(sourceRef)) return [];
  const rows = await tx.execute<{ id: string; number: number; eventType: PersonnelPostingEvent; status: PersonnelPostingStatus; proposed: PersonnelPostingValues; edited: PersonnelPostingValues | null; applied: PersonnelPostingValues | null; movementId: string | null }>(sql`
    select id, number, event_type as "eventType", status, proposed, edited, applied, movement_id as "movementId"
    from personnel_posting where tenant_id = app.current_tenant_id() and source = ${source} and source_ref = ${sourceRef}::uuid
    order by created_at, number limit 50`);
  return rows.map((r) => ({ id: r.id, number: r.number, eventType: r.eventType, status: r.status, current: postingCurrentValues(r), movementId: r.movementId }));
}

function values(event: PersonnelPostingEvent, raw: Record<string, unknown>,source:PersonnelPostingSource='probation'): PersonnelPostingValues {
  const checked = normalisePostingValues(event, raw,source);
  if (!checked.ok) {
    throw new PersonnelPostingError('invalid', checked.problem === 'effectiveDate' ? 'Enter a valid effective date.'
      : checked.problem === 'endDate' ? (event === 'probationExtension' ? 'Enter the new probation end date.' : 'A Confirmation has no end date.')
      : checked.problem === 'remarks' ? 'Remarks can be at most 200 characters.' : 'The posting details are not allowed.');
  }
  return checked.values;
}

export type CreatePersonnelPostingInput = {
  source: PersonnelPostingSource;
  /** The source record, e.g. the Probation case id. */
  sourceRef: string;
  employmentId: string;
  eventType: PersonnelPostingEvent;
  proposed: PersonnelPostingValues;
  /** The assignment group that approves (Probation settings, "Who approves Personnel postings"). */
  approverGroupId: string;
  /** Stable per source record and event (e.g. the outcome id): repeating it returns the same posting. */
  idempotencyKey: string;
};

/**
 * For the owning workflow's own transaction (lane D: inside the Probation outcome effect). The database refuses any
 * caller that is not the Probation owner path, and any case without a released outcome of the matching kind.
 */
export async function createPersonnelPostingTx(tx: Tx, input: CreatePersonnelPostingInput): Promise<{ id: string; number: number }> {
  if (input.source !== 'probation' || !isPersonnelPostingEvent(input.eventType) || !UUID.test(input.sourceRef) || !UUID.test(input.employmentId))
    throw new PersonnelPostingError('invalid', 'The posting is incomplete.');
  const proposed = values(input.eventType, input.proposed as Record<string, unknown>);
  return guarded(async () => {
    const [row] = await tx.execute<{ id: string }>(sql`select app.personnel_posting_create(${input.source}, ${input.sourceRef}::uuid, ${input.employmentId}::uuid,
      ${input.eventType}, ${JSON.stringify(proposed)}::jsonb, ${input.approverGroupId}, ${input.idempotencyKey}) as id`);
    const [numbered] = await tx.execute<{ number: number }>(sql`select number from personnel_posting where tenant_id = app.current_tenant_id() and id = ${row.id}::uuid`);
    return { id: row.id, number: numbered?.number ?? 0 };
  });
}

/** Correct a pending posting. It stays pending ("Edited · waiting for approval"); no movement is written. */
export function editPersonnelPosting(ctx: SessionContext, input: { id: string; revision: number; values: Record<string, unknown> }): Promise<{ revision: number }> {
  if (!UUID.test(input.id) || !Number.isInteger(input.revision)) return Promise.reject(new PersonnelPostingError('not_found', 'Posting not found.'));
  return withTenant(ctx, (tx) => guarded(async () => {
    const posting = await personnelPostingTx(tx, input.id);
    if (!posting) throw new PersonnelPostingError('not_found', 'Posting not found.');
    const next = values(posting.eventType, input.values,posting.source);
    const [row] = await tx.execute<{ revision: number }>(sql`select app.personnel_posting_edit(${input.id}::uuid, ${input.revision}, ${JSON.stringify(next)}::jsonb) as revision`);
    return { revision: row.revision };
  }));
}

export type ApprovedPersonnelPosting = { id: string; movementId: string; employmentId: string; eventType: PersonnelPostingEvent; values: PersonnelPostingValues; behaviourKind: string; alreadyApproved?:boolean; gradeBefore?: { gradeId: string | null } };

/**
 * Approve in the caller's transaction: authorise and mark approved (database), apply the change through the movement
 * writer, bind the movement it recorded. Any failure rolls the whole transaction back, so the posting stays pending.
 * `values` are the approver's own corrections from the movement page ("Save event and approve"); absent means the
 * posting's current values.
 */
export async function approvePersonnelPostingTx(tx: Tx, ctx: SessionContext, input: { id: string; revision: number; values?: Record<string, unknown>;eventType?:PersonnelPostingEvent }): Promise<ApprovedPersonnelPosting|ContractPostingApprovalOutcome> {
  if (!UUID.test(input.id) || !Number.isInteger(input.revision)) throw new PersonnelPostingError('not_found', 'Posting not found.');
  // Resolve the Contract facade only when approving a posting, keeping this broad Personnel
  // module free of eager private Contract service dependencies. The native owners still authorize it.
  const {readContractSharedPostingTx,requestContractSharedPostingApprovalTx}=await import('../packs/contracts/service');
  const contract=await readContractSharedPostingTx(tx,input.id);
  if(contract){
    if(input.eventType&&input.eventType!==contract.eventType)throw new PersonnelPostingError('invalid','The Contract posting event type is fixed.');
    return requestContractSharedPostingApprovalTx(tx,input);
  }
  let corrected: PersonnelPostingValues | null = null;
  if (input.values) {
    const posting = await personnelPostingTx(tx, input.id);
    if (!posting) throw new PersonnelPostingError('not_found', 'Posting not found.');
    corrected = values(posting.eventType, input.values);
  }
  const [approved] = await guarded(() => tx.execute<{ data: { id: string; number: number; employmentId: string; eventType: PersonnelPostingEvent; values: PersonnelPostingValues } }>(
    sql`select app.personnel_posting_approve(${input.id}::uuid, ${input.revision}, ${corrected ? JSON.stringify(corrected) : null}::jsonb) as data`));
  const {employmentId, eventType, values: applied, number} = approved.data;
  if(eventType==='contractRenewal'||eventType==='contractConversion')throw new PersonnelPostingError('invalid','The source-bound Contract posting is unavailable.');
  const marker = await movementLedgerMarkerTx(tx, ctx, employmentId);
  const result = await createMovementEventTx(tx, ctx, {
    employmentId, kind: eventType, effectiveDate: applied.effectiveDate,
    ...(eventType === 'probationExtension' ? { endDate: applied.endDate ?? null } : {}),
    remarks: applied.remarks ?? `Personnel posting ${postingLabel(number)}`,
  }, { captureGradeBefore: true });
  const recorded = (await movementRowsAfterSequenceTx(tx, ctx, employmentId, marker)).filter((row) => UUID.test(row.id));
  const movement = recorded.find((row) => row.kind === eventType) ?? recorded[0];
  if (!movement) throw new PersonnelPostingError('invalid', 'The event could not be recorded, so the posting was not approved.');
  await guarded(() => tx.execute(sql`select app.personnel_posting_record_movement(${input.id}::uuid, ${movement.id})`));
  return { id: input.id, movementId: movement.id, employmentId, eventType, values: applied, behaviourKind: result.behaviourKind,
    ...('gradeBefore' in result && result.gradeBefore ? { gradeBefore: result.gradeBefore as { gradeId: string | null } } : {}) };
}

/** Approve (Approve on the queue, or "Save event and approve" on the movement page), then refresh leave entitlement. */
export async function approvePersonnelPosting(ctx: SessionContext, input: { id: string; revision: number; values?: Record<string, unknown>;eventType?:PersonnelPostingEvent }): Promise<ApprovedPersonnelPosting|ContractPostingApprovalOutcome> {
  const approved = await withTenant(ctx, (tx) => approvePersonnelPostingTx(tx, ctx, input));
  if('applicationState' in approved)return approved;
  // Same follow-up as the New Event form: best-effort and idempotent, never fails the approval that committed.
  if (movementNeedsEntitlementReprojection(approved.behaviourKind)) {
    try {
      const {reprojectEntitlementForEmployment} = await import('../packs/leave/service');
      await reprojectEntitlementForEmployment(ctx, { employmentId: approved.employmentId, trigger: 'movement_recorded', gradeBefore: approved.gradeBefore, changeEffectiveOn: approved.values.effectiveDate });
    } catch { /* re-runs on the next profile trigger or policy edit */ }
  }
  return approved;
}
