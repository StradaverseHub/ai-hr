/**
 * Claims module (ADR-0021) — claim-type catalog + effective-dated budget policy. Admin-managed (RLS
 * admin-write); every state change appends a DomainEvent. The lifecycle (submit/decide) + payout live in
 * later slices of this file.
 */
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  claimAttachment,
  claimPolicy,
  claimRequest,
  claimType,
  company,
  employeeStatutoryMy,
  employment,
  payrollBatch,
  payrollInput,
  person,
} from '../db/schema';
import { toCsv } from '../lib/csv';
import { assertCanDecide } from './approvals';

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'reimbursements';

const today = (): string => new Date().toISOString().slice(0, 10);
const num = (v: string | null): number | null => (v == null ? null : Number(v));

export type ClaimTypeRow = {
  id: string;
  code: string;
  name: string;
  defaultTaxable: boolean;
  requiresReceipt: boolean;
  archivedAt: string | null;
  policy: { annualBudget: number | null; perClaimCap: number | null; validFrom: string } | null;
};

/** The active policy (latest effective version ≤ asOf) for a claim type, or null. Pure read in the caller tx. */
export async function getActiveClaimPolicy(
  tx: Tx,
  claimTypeId: string,
  asOf: string,
): Promise<{ annualBudget: number | null; perClaimCap: number | null; validFrom: string } | null> {
  const [row] = await tx
    .select()
    .from(claimPolicy)
    .where(
      and(
        eq(claimPolicy.claimTypeId, claimTypeId),
        lte(claimPolicy.validFrom, asOf),
        or(isNull(claimPolicy.validTo), sql`${claimPolicy.validTo} > ${asOf}`),
      ),
    )
    .orderBy(desc(claimPolicy.validFrom))
    .limit(1);
  return row ? { annualBudget: num(row.annualBudget), perClaimCap: num(row.perClaimCap), validFrom: row.validFrom } : null;
}

/** All non-archived claim types with their active policy — the admin catalog. */
export async function listClaimTypes(ctx: SessionContext, p?: { asOf?: string }): Promise<ClaimTypeRow[]> {
  const asOf = p?.asOf ?? today();
  return withTenant(ctx, async (tx) => {
    const types = await tx
      .select()
      .from(claimType)
      .where(isNull(claimType.archivedAt))
      .orderBy(claimType.code);
    return Promise.all(
      types.map(async (t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        defaultTaxable: t.defaultTaxable,
        requiresReceipt: t.requiresReceipt,
        archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
        policy: await getActiveClaimPolicy(tx, t.id, asOf),
      })),
    );
  });
}

export async function createClaimType(
  ctx: SessionContext,
  p: { code: string; name: string; defaultTaxable: boolean; requiresReceipt: boolean },
): Promise<{ id: string }> {
  const code = p.code.trim().toUpperCase();
  if (!code) throw new Error('Claim type code is required');
  if (!p.name.trim()) throw new Error('Claim type name is required');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(claimType)
      .values({ tenantId: ctx.tenantId, code, name: p.name.trim(), defaultTaxable: p.defaultTaxable, requiresReceipt: p.requiresReceipt })
      .returning({ id: claimType.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-type',
      aggregateId: row.id,
      eventType: 'claim-type.created',
      actor: actorOf(ctx),
      payload: { code, name: p.name.trim(), defaultTaxable: p.defaultTaxable, requiresReceipt: p.requiresReceipt },
    });
    return { id: row.id };
  });
}

export async function updateClaimType(
  ctx: SessionContext,
  p: { id: string; name: string; defaultTaxable: boolean; requiresReceipt: boolean },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(claimType)
      .set({ name: p.name.trim(), defaultTaxable: p.defaultTaxable, requiresReceipt: p.requiresReceipt })
      .where(eq(claimType.id, p.id))
      .returning({ id: claimType.id });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-type',
      aggregateId: p.id,
      eventType: 'claim-type.updated',
      actor: actorOf(ctx),
      payload: { name: p.name.trim(), defaultTaxable: p.defaultTaxable, requiresReceipt: p.requiresReceipt },
    });
  });
}

export async function archiveClaimType(ctx: SessionContext, id: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(claimType)
      .set({ archivedAt: new Date() })
      .where(and(eq(claimType.id, id), isNull(claimType.archivedAt)))
      .returning({ id: claimType.id });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-type',
      aggregateId: id,
      eventType: 'claim-type.archived',
      actor: actorOf(ctx),
    });
  });
}

/**
 * Set the budget policy for a claim type, effective-dated (CLOSE the open version + INSERT a new one — never
 * UPDATE business columns in place). NULL budget/cap = unlimited / no cap.
 */
export async function setClaimPolicy(
  ctx: SessionContext,
  p: { claimTypeId: string; annualBudget: number | null; perClaimCap: number | null; effectiveFrom: string },
): Promise<{ id: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveFrom)) throw new Error('effectiveFrom must be YYYY-MM-DD');
  if (p.annualBudget != null && p.annualBudget < 0) throw new Error('Annual budget must be ≥ 0');
  if (p.perClaimCap != null && p.perClaimCap < 0) throw new Error('Per-claim cap must be ≥ 0');
  return withTenant(ctx, async (tx) => {
    // Close any currently-open policy for this type (half-open validity).
    await tx
      .update(claimPolicy)
      .set({ validTo: p.effectiveFrom })
      .where(and(eq(claimPolicy.claimTypeId, p.claimTypeId), isNull(claimPolicy.validTo)));
    const [row] = await tx
      .insert(claimPolicy)
      .values({
        tenantId: ctx.tenantId,
        claimTypeId: p.claimTypeId,
        annualBudget: p.annualBudget == null ? null : p.annualBudget.toFixed(2),
        perClaimCap: p.perClaimCap == null ? null : p.perClaimCap.toFixed(2),
        validFrom: p.effectiveFrom,
      })
      .returning({ id: claimPolicy.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-policy',
      aggregateId: row.id,
      eventType: 'claim-policy.set',
      actor: actorOf(ctx),
      payload: { claimTypeId: p.claimTypeId, annualBudget: p.annualBudget, perClaimCap: p.perClaimCap, effectiveFrom: p.effectiveFrom },
    });
    return { id: row.id };
  });
}

// ─────────────────────────────── Lifecycle (ADR-0021 §2) ───────────────────────────────
// submit → pending → (approve | reject) ; approved → paid ; pending → cancelled. The service enforces the
// state machine + the self-approval ban (assertCanDecide) on top of the RLS visibility scope.

export class ClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimError';
  }
}

const yearOf = (d: string): number => Number(d.slice(0, 4));

/** Sum of a claim type's amounts for an employment in a calendar year (by incurred_on), over the given
 *  statuses — used for budget enforcement. */
async function claimedInYear(
  tx: Tx,
  employmentId: string,
  claimTypeId: string,
  year: number,
  statuses: ('pending' | 'approved' | 'paid')[],
  excludeId?: string,
): Promise<number> {
  const conds = [
    eq(claimRequest.employmentId, employmentId),
    eq(claimRequest.claimTypeId, claimTypeId),
    sql`extract(year from ${claimRequest.incurredOn}) = ${year}`,
    inArray(claimRequest.status, statuses),
  ];
  if (excludeId) conds.push(sql`${claimRequest.id} <> ${excludeId}`);
  const [row] = await tx.select({ s: sql<string>`coalesce(sum(${claimRequest.amount}), 0)` }).from(claimRequest).where(and(...conds));
  return Number(row?.s ?? 0);
}

/** Submit a claim (employee, for their own employment — RLS enforces). Validates per-claim cap + annual
 *  budget (committed = pending+approved+paid). `taxable` defaults from the claim type. */
export async function submitClaim(
  ctx: SessionContext,
  p: { employmentId: string; claimTypeId: string; amount: number; incurredOn: string; description?: string | null; hasReceipt?: boolean },
): Promise<{ id: string }> {
  if (!(p.amount > 0)) throw new ClaimError('Amount must be greater than zero');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.incurredOn)) throw new ClaimError('Incurred date must be YYYY-MM-DD');
  return withTenant(ctx, async (tx) => {
    const [ct] = await tx.select().from(claimType).where(and(eq(claimType.id, p.claimTypeId), isNull(claimType.archivedAt))).limit(1);
    if (!ct) throw new ClaimError('Unknown or archived claim type');
    if (ct.requiresReceipt && !p.hasReceipt) throw new ClaimError('A receipt is required for this claim type');
    const policy = await getActiveClaimPolicy(tx, p.claimTypeId, p.incurredOn);
    if (policy?.perClaimCap != null && p.amount > policy.perClaimCap) {
      throw new ClaimError(`Amount exceeds the per-claim cap (RM ${policy.perClaimCap.toLocaleString('en-MY')})`);
    }
    if (policy?.annualBudget != null) {
      const committed = await claimedInYear(tx, p.employmentId, p.claimTypeId, yearOf(p.incurredOn), ['pending', 'approved', 'paid']);
      if (committed + p.amount > policy.annualBudget) {
        throw new ClaimError(`This would exceed the annual budget (RM ${policy.annualBudget.toLocaleString('en-MY')})`);
      }
    }
    const [row] = await tx
      .insert(claimRequest)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        claimTypeId: p.claimTypeId,
        amount: p.amount.toFixed(2),
        incurredOn: p.incurredOn,
        description: p.description ?? null,
        taxable: ct.defaultTaxable,
      })
      .returning({ id: claimRequest.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-request',
      aggregateId: row.id,
      eventType: 'claim-request.submitted',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { claimTypeId: p.claimTypeId, amount: p.amount, incurredOn: p.incurredOn, taxable: ct.defaultTaxable },
    });
    return { id: row.id };
  });
}

/** Approve or reject a pending claim. assertCanDecide bans self-approval + requires admin/active manager.
 *  On approve, the decider may confirm/override `taxable`, and the annual budget is re-checked. */
export async function decideClaim(
  ctx: SessionContext,
  p: { claimRequestId: string; decision: 'approve' | 'reject'; taxable?: boolean; deciderEmploymentId?: string | null },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [claim] = await tx.select().from(claimRequest).where(eq(claimRequest.id, p.claimRequestId)).limit(1);
    if (!claim) throw new ClaimError('Claim not found');
    if (claim.status !== 'pending') throw new ClaimError('Only a pending claim can be decided');
    await assertCanDecide(tx, ctx, claim.employmentId, 'claim');

    if (p.decision === 'approve') {
      const taxable = p.taxable ?? claim.taxable;
      const policy = await getActiveClaimPolicy(tx, claim.claimTypeId, claim.incurredOn);
      if (policy?.annualBudget != null) {
        const others = await claimedInYear(tx, claim.employmentId, claim.claimTypeId, yearOf(claim.incurredOn), ['approved', 'paid'], claim.id);
        if (others + Number(claim.amount) > policy.annualBudget) {
          throw new ClaimError(`Approving this would exceed the annual budget (RM ${policy.annualBudget.toLocaleString('en-MY')})`);
        }
      }
      await tx
        .update(claimRequest)
        .set({ status: 'approved', taxable, decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: new Date() })
        .where(eq(claimRequest.id, claim.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: claim.id,
        eventType: 'claim-request.approved',
        actor: actorOf(ctx),
        subjectEmploymentId: claim.employmentId,
        payload: { amount: Number(claim.amount), taxable, payoutMethod: taxable ? 'payroll' : 'reimbursement' },
      });
    } else {
      await tx
        .update(claimRequest)
        .set({ status: 'rejected', decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: new Date() })
        .where(eq(claimRequest.id, claim.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: claim.id,
        eventType: 'claim-request.rejected',
        actor: actorOf(ctx),
        subjectEmploymentId: claim.employmentId,
      });
    }
  });
}

/** Cancel a pending claim (the claimant or an admin). */
export async function cancelClaim(ctx: SessionContext, claimRequestId: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [claim] = await tx
      .select({ id: claimRequest.id, status: claimRequest.status, employmentId: claimRequest.employmentId, personId: employment.personId })
      .from(claimRequest)
      .innerJoin(employment, eq(employment.id, claimRequest.employmentId))
      .where(eq(claimRequest.id, claimRequestId))
      .limit(1);
    if (!claim) throw new ClaimError('Claim not found');
    if (claim.status !== 'pending') throw new ClaimError('Only a pending claim can be cancelled');
    const isAdmin = (ctx.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');
    const isOwner = ctx.personId != null && claim.personId === ctx.personId;
    if (!isAdmin && !isOwner) throw new ClaimError('Only the claimant or an admin can cancel this claim');
    await tx.update(claimRequest).set({ status: 'cancelled' }).where(eq(claimRequest.id, claim.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-request',
      aggregateId: claim.id,
      eventType: 'claim-request.cancelled',
      actor: actorOf(ctx),
      subjectEmploymentId: claim.employmentId,
    });
  });
}

/** Attach a receipt to a claim (denormalizes employment_id from the claim for RLS). */
export async function addClaimAttachment(
  ctx: SessionContext,
  p: { claimRequestId: string; fileName: string; mimeType: string; content: Buffer },
): Promise<{ id: string }> {
  if (p.content.byteLength === 0) throw new ClaimError('Empty file');
  if (p.content.byteLength > 10 * 1024 * 1024) throw new ClaimError('File exceeds 10 MB');
  return withTenant(ctx, async (tx) => {
    const [claim] = await tx
      .select({ id: claimRequest.id, employmentId: claimRequest.employmentId, status: claimRequest.status })
      .from(claimRequest)
      .where(eq(claimRequest.id, p.claimRequestId))
      .limit(1);
    if (!claim) throw new ClaimError('Claim not found');
    if (claim.status !== 'pending') throw new ClaimError('Receipts can only be added while the claim is pending');
    const [row] = await tx
      .insert(claimAttachment)
      .values({
        tenantId: ctx.tenantId,
        claimRequestId: claim.id,
        employmentId: claim.employmentId,
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.content.byteLength,
        uploadedByUserId: ctx.userId ?? null,
      })
      .returning({ id: claimAttachment.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-request',
      aggregateId: claim.id,
      eventType: 'claim-request.receipt-added',
      actor: actorOf(ctx),
      subjectEmploymentId: claim.employmentId,
      payload: { fileName: p.fileName, sizeBytes: p.content.byteLength },
    });
    return { id: row.id };
  });
}

/** Read a receipt's bytes for download (RLS scopes visibility to the claim). */
export async function getClaimAttachment(
  ctx: SessionContext,
  attachmentId: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string } | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ content: claimAttachment.content, fileName: claimAttachment.fileName, mimeType: claimAttachment.mimeType })
      .from(claimAttachment)
      .where(eq(claimAttachment.id, attachmentId))
      .limit(1);
    return row ? { content: row.content, fileName: row.fileName, mimeType: row.mimeType } : null;
  });
}

// ─────────────────────────────── Reads (UI) ───────────────────────────────

export type ClaimRow = {
  id: string;
  typeCode: string;
  typeName: string;
  amount: number;
  incurredOn: string;
  description: string | null;
  taxable: boolean;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  paidAt: string | null;
  claimantName?: string;
  personId: string | null;
  attachments: { id: string; fileName: string; sizeBytes: number }[];
};

function rowSelect() {
  return {
    id: claimRequest.id,
    typeCode: claimType.code,
    typeName: claimType.name,
    amount: claimRequest.amount,
    incurredOn: claimRequest.incurredOn,
    description: claimRequest.description,
    taxable: claimRequest.taxable,
    status: claimRequest.status,
    createdAt: claimRequest.createdAt,
    decidedAt: claimRequest.decidedAt,
    paidAt: claimRequest.paidAt,
    employmentId: claimRequest.employmentId,
    claimantName: person.fullName,
    personId: employment.personId,
  };
}

async function attachmentsByClaim(tx: Tx, claimIds: string[]) {
  if (claimIds.length === 0) return new Map<string, { id: string; fileName: string; sizeBytes: number }[]>();
  const atts = await tx
    .select({ id: claimAttachment.id, claimRequestId: claimAttachment.claimRequestId, fileName: claimAttachment.fileName, sizeBytes: claimAttachment.sizeBytes })
    .from(claimAttachment)
    .where(inArray(claimAttachment.claimRequestId, claimIds));
  const m = new Map<string, { id: string; fileName: string; sizeBytes: number }[]>();
  for (const a of atts) {
    const arr = m.get(a.claimRequestId) ?? [];
    arr.push({ id: a.id, fileName: a.fileName, sizeBytes: a.sizeBytes });
    m.set(a.claimRequestId, arr);
  }
  return m;
}

type RawClaimRow = {
  id: string;
  typeCode: string;
  typeName: string;
  amount: string;
  incurredOn: string;
  description: string | null;
  taxable: boolean;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  paidAt: Date | null;
  employmentId: string;
  claimantName: string;
  personId: string | null;
};

const toRow = (r: RawClaimRow, atts: Map<string, ClaimRow['attachments']>): ClaimRow => ({
  id: r.id,
  typeCode: r.typeCode,
  typeName: r.typeName,
  amount: Number(r.amount),
  incurredOn: r.incurredOn,
  description: r.description,
  taxable: r.taxable,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
  paidAt: r.paidAt ? r.paidAt.toISOString() : null,
  claimantName: r.claimantName,
  personId: r.personId,
  attachments: atts.get(r.id) ?? [],
});

/** A single employment's claims (newest first) — "my claims". */
export async function listClaimsForEmployment(ctx: SessionContext, employmentId: string): Promise<ClaimRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select(rowSelect())
      .from(claimRequest)
      .innerJoin(claimType, eq(claimType.id, claimRequest.claimTypeId))
      .innerJoin(employment, eq(employment.id, claimRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(claimRequest.employmentId, employmentId))
      .orderBy(desc(claimRequest.createdAt));
    const atts = await attachmentsByClaim(tx, rows.map((r) => r.id));
    return rows.map((r) => toRow(r, atts));
  });
}

/** Pending claims the caller may decide (RLS scopes: manager → reports, admin → all) — the approvals inbox. */
export async function listPendingClaims(ctx: SessionContext): Promise<ClaimRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select(rowSelect())
      .from(claimRequest)
      .innerJoin(claimType, eq(claimType.id, claimRequest.claimTypeId))
      .innerJoin(employment, eq(employment.id, claimRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(claimRequest.status, 'pending'))
      .orderBy(desc(claimRequest.createdAt));
    const atts = await attachmentsByClaim(tx, rows.map((r) => r.id));
    return rows.map((r) => toRow(r, atts));
  });
}

// ──────────────────────────── Payout (ADR-0021 §3, Slice 5) ────────────────────────────
//
// Two routes, chosen by the `taxable` flag confirmed at approval:
//   • taxable     → folded into the payslip's taxable allowance base (PCB/EPF/SOCSO/EIS) via
//                   payroll_input.claim_allowance. `prefillClaimsForBatch` queues approved-taxable
//                   claims onto a draft batch; generatePayslips marks them paid when it processes.
//   • non-taxable → paid off-cycle as a reimbursement (`markReimbursementsPaid` + bank CSV export).

/**
 * Queue approved, taxable, not-yet-scheduled claims for an employee's company onto a DRAFT payroll
 * batch: sum per employment into payroll_input.claim_allowance and stamp each claim's payrollBatchId
 * so generatePayslips folds the amount into the taxable allowance line (and marks the claims paid on
 * processing). Idempotent — already-linked claims are excluded, so re-running adds only new approvals.
 * Mirrors prefillOvertimeFromAttendance (preserves any existing manual input on the row).
 */
export async function prefillClaimsForBatch(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<{ applied: number; claims: number; total: number }> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ id: payrollBatch.id, companyId: payrollBatch.companyId, status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new ClaimError('Payroll batch not found');
    if (batch.status !== 'draft') throw new ClaimError('Claims can only be prefilled onto a draft batch');

    // Approved + taxable + unscheduled claims for employees of this batch's company.
    const due = await tx
      .select({ id: claimRequest.id, employmentId: claimRequest.employmentId, amount: claimRequest.amount })
      .from(claimRequest)
      .innerJoin(employment, eq(employment.id, claimRequest.employmentId))
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          eq(claimRequest.status, 'approved'),
          eq(claimRequest.taxable, true),
          isNull(claimRequest.payrollBatchId),
        ),
      );
    if (due.length === 0) return { applied: 0, claims: 0, total: 0 };

    // Sum per employment, and remember which claim ids belong to each.
    const sumByEmp = new Map<string, { cents: number; ids: string[] }>();
    for (const c of due) {
      const acc = sumByEmp.get(c.employmentId) ?? { cents: 0, ids: [] };
      acc.cents += Math.round(Number(c.amount) * 100);
      acc.ids.push(c.id);
      sumByEmp.set(c.employmentId, acc);
    }

    // Existing inputs: claim_allowance accumulates on top of any prior prefill for this batch.
    const existing = await tx
      .select({ id: payrollInput.id, employmentId: payrollInput.employmentId, claimAllowance: payrollInput.claimAllowance })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, p.batchId));
    const existingBy = new Map(existing.map((r) => [r.employmentId, r]));

    let total = 0;
    for (const [employmentId, { cents }] of sumByEmp) {
      const amount = cents / 100;
      total += cents;
      const prior = existingBy.get(employmentId);
      if (prior) {
        const next = round2Cents(Math.round(Number(prior.claimAllowance) * 100) + cents);
        await tx
          .update(payrollInput)
          .set({ claimAllowance: next, updatedAt: sql`now()` })
          .where(eq(payrollInput.id, prior.id));
      } else {
        await tx.insert(payrollInput).values({
          tenantId: ctx.tenantId,
          batchId: p.batchId,
          employmentId,
          claimAllowance: amount.toFixed(2),
        });
      }
    }

    // Stamp the claims onto the batch (reservation) — a deliberate state change, so each gets an event.
    const allIds = [...sumByEmp.values()].flatMap((v) => v.ids);
    await tx
      .update(claimRequest)
      .set({ payrollBatchId: p.batchId })
      .where(inArray(claimRequest.id, allIds));
    for (const c of due) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: c.id,
        eventType: 'claim-request.queued-for-payroll',
        actor: actorOf(ctx),
        subjectEmploymentId: c.employmentId,
        payload: { batchId: p.batchId, amount: Number(c.amount) },
      });
    }
    return { applied: sumByEmp.size, claims: due.length, total: total / 100 };
  });
}

const round2Cents = (cents: number): string => (cents / 100).toFixed(2);

export type ReimbursementRow = {
  id: string;
  claimant: string;
  employeeCode: string | null;
  typeCode: string;
  typeName: string;
  amount: number;
  incurredOn: string;
  bankName: string | null;
  bankAccountNo: string | null;
};

/** Approved, NON-taxable claims awaiting an off-cycle reimbursement payout (RLS-scoped to the caller). */
export async function listReimbursementsDue(ctx: SessionContext): Promise<ReimbursementRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: claimRequest.id,
        claimant: person.fullName,
        employeeCode: employment.employeeCode,
        typeCode: claimType.code,
        typeName: claimType.name,
        amount: claimRequest.amount,
        incurredOn: claimRequest.incurredOn,
        bankName: employeeStatutoryMy.bankName,
        bankAccountNo: employeeStatutoryMy.bankAccountNo,
      })
      .from(claimRequest)
      .innerJoin(claimType, eq(claimType.id, claimRequest.claimTypeId))
      .innerJoin(employment, eq(employment.id, claimRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(and(eq(claimRequest.status, 'approved'), eq(claimRequest.taxable, false)))
      .orderBy(person.fullName);
    return rows.map((r) => ({
      id: r.id,
      claimant: r.claimant,
      employeeCode: r.employeeCode,
      typeCode: r.typeCode,
      typeName: r.typeName,
      amount: Number(r.amount),
      incurredOn: r.incurredOn,
      bankName: r.bankName,
      bankAccountNo: r.bankAccountNo,
    }));
  });
}

/**
 * Bank-upload CSV for the non-taxable reimbursements due — a plain, neutral file (employee, bank,
 * account, amount), deliberately NOT a byte-exact giro/IBG format (mirrors paymentSummaryForBatch).
 * Read-only: building the file does not mark anything paid — that's an explicit `markReimbursementsPaid`.
 */
export async function reimbursementCsv(
  ctx: SessionContext,
): Promise<{ content: string; filename: string; payeeCount: number; total: number; missingBank: number }> {
  const due = await listReimbursementsDue(ctx);
  const header = ['No', 'Employee', 'Employee Code', 'Claim Type', 'Incurred On', 'Bank', 'Account No', 'Amount (RM)'];
  const body = due.map((r, i) => [
    i + 1,
    r.claimant,
    r.employeeCode ?? '',
    r.typeCode,
    r.incurredOn,
    r.bankName ?? '',
    r.bankAccountNo ?? '',
    r.amount.toFixed(2),
  ]);
  const content = toCsv([header, ...body]);
  const total = due.reduce((sum, r) => sum + Math.round(r.amount * 100), 0) / 100;
  const missingBank = due.filter((r) => !r.bankName || !r.bankAccountNo).length;
  return { content, filename: `reimbursements_${slugify(today())}.csv`, payeeCount: due.length, total, missingBank };
}

/** Mark approved non-taxable claims as reimbursed (off-cycle payout confirmed). Appends a paid event per claim. */
export async function markReimbursementsPaid(
  ctx: SessionContext,
  p: { claimIds: string[]; payoutRef?: string | null },
): Promise<{ paid: number }> {
  if (p.claimIds.length === 0) return { paid: 0 };
  return withTenant(ctx, async (tx) => {
    // RLS already scopes visibility; only flip ones that are genuinely approved + non-taxable.
    const paid = await tx
      .update(claimRequest)
      .set({ status: 'paid', paidAt: new Date(), payoutRef: p.payoutRef ?? 'reimbursement' })
      .where(
        and(
          inArray(claimRequest.id, p.claimIds),
          eq(claimRequest.status, 'approved'),
          eq(claimRequest.taxable, false),
        ),
      )
      .returning({ id: claimRequest.id, employmentId: claimRequest.employmentId, amount: claimRequest.amount });
    for (const c of paid) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: c.id,
        eventType: 'claim-request.paid',
        actor: actorOf(ctx),
        subjectEmploymentId: c.employmentId,
        payload: { via: 'reimbursement', amount: Number(c.amount), payoutRef: p.payoutRef ?? 'reimbursement' },
      });
    }
    return { paid: paid.length };
  });
}
