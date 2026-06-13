/**
 * Compensation — generic, jurisdiction-neutral, effective-dated (ADR-0008 #5).
 * Salary is comp *history*: a change CLOSE + INSERTs a new version. Amounts are tenant data.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { compensation, tenantCounter } from '../db/schema';

const money = (n: number | string): string => (typeof n === 'number' ? n.toFixed(2) : String(n));

export async function setCompensation(
  ctx: SessionContext,
  p: { employmentId: string; basicSalary: number; currency?: string; monthlyAllowance?: number; effectiveFrom: string },
  /** Optional caller transaction — pass it to make this write participate in an enclosing
   *  transaction (e.g. the performance pay-seam enact) so it commits/rolls back atomically. */
  outerTx?: Tx,
) {
  const run = async (tx: Tx) => {
    const [cur] = await tx
      .select()
      .from(compensation)
      .where(
        and(
          eq(compensation.employmentId, p.employmentId),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .limit(1);
    if (cur) {
      await tx.update(compensation).set({ validTo: p.effectiveFrom }).where(eq(compensation.id, cur.id));
    }
    const [row] = await tx
      .insert(compensation)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        basicSalary: money(p.basicSalary),
        currency: p.currency ?? 'MYR',
        monthlyAllowance: money(p.monthlyAllowance ?? 0),
        validFrom: p.effectiveFrom,
        validTo: null,
      })
      .returning({ id: compensation.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'compensation',
      aggregateId: row.id,
      eventType: 'compensation.set',
      actor: actorOf(ctx),
      payload: { employmentId: p.employmentId, basicSalary: p.basicSalary, effectiveFrom: p.effectiveFrom },
    });
    return { compensationId: row.id };
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
}

export function currentCompensation(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(compensation)
      .where(
        and(
          eq(compensation.employmentId, employmentId),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export function compensationHistory(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select()
      .from(compensation)
      .where(and(eq(compensation.employmentId, employmentId), isNull(compensation.supersededAt)))
      .orderBy(desc(compensation.validFrom)),
  );
}

/** Next per-tenant employee code. Call INSIDE an existing transaction (e.g. during hire). */
export async function nextEmployeeCode(tx: Tx, tenantId: string): Promise<string> {
  const [row] = await tx
    .insert(tenantCounter)
    .values({ tenantId, kind: 'employee_code', value: 1 })
    .onConflictDoUpdate({
      target: [tenantCounter.tenantId, tenantCounter.kind],
      set: { value: sql`${tenantCounter.value} + 1` },
    })
    .returning({ value: tenantCounter.value });
  return `EMP-${String(row.value).padStart(4, '0')}`;
}
