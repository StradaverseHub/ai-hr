/**
 * 72b100cd — THE EMPLOYER'S PCB PAYMENTS, as PCB 2(II) reports them.
 *
 * The form's section 2 asks, for each month of a year, for the receipt / bank slip / transaction number
 * and the receipt date — separately for MTD and for CP38. Nothing in this system held those: they are
 * what LHDN gives the employer when the employer PAYS, and the only acknowledgement field there was sits
 * on the CP39 return, one per company and period, for the lodgement rather than the payment.
 *
 * ⚠️ EVERYTHING HERE IS KEYED BY A HUMAN. There is no derivation in this file and there must never be
 * one. A receipt number cannot be computed, and a form that guessed one would be a false statement to a
 * tax authority. A month with no record is reported as ABSENT, and the renderer prints an empty box —
 * never 0.00, because an absent box asserts nothing while a zero asserts the money does not exist
 * (CLAUDE.md §8).
 *
 * substrate: read + write, domain event on write.
 */
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { pcbPayment } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import { actorOf, appendEvent } from '../db/events';

export type PcbPaymentKind = 'mtd' | 'cp38';

export type PcbPaymentRow = {
  periodKey: string;
  kind: PcbPaymentKind;
  receiptRef: string;
  paidOn: string;
};

export class PcbPaymentError extends Error {}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Every payment reference this company recorded for the months of one year.
 *
 * Keyed 'YYYY-MM|kind' so the renderer can ask for one box and get either a row or nothing. It returns a
 * Map rather than an array because the form is RULED: twelve months times two streams, and the question
 * it asks per box is "is there one", not "which of these matches".
 */
export async function pcbPaymentsForYear(
  ctx: SessionContext,
  p: { companyId: string; year: number },
): Promise<Map<string, PcbPaymentRow>> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        periodKey: pcbPayment.periodKey,
        kind: pcbPayment.kind,
        receiptRef: pcbPayment.receiptRef,
        paidOn: pcbPayment.paidOn,
      })
      .from(pcbPayment)
      .where(
        and(
          eq(pcbPayment.companyId, p.companyId),
          sql`${pcbPayment.periodKey} LIKE ${`${p.year}-%`}`,
        ),
      )
      // r331 — ORDERED, although the caller is handed a Map. A Map iterates in INSERTION order, so
      // without this the order of `[...map.keys()]` is the planner's and an assertion over it is a
      // coin toss that happens to pass (CLAUDE.md §8: any asserted array from a query needs ORDER BY).
      // The receipts screen does not depend on it — it derives its twelve months from the year and
      // looks each one up — but a Map handed out in an arbitrary order is a trap for the next reader.
      .orderBy(pcbPayment.periodKey, pcbPayment.kind);
    return new Map(rows.map((r) => [`${r.periodKey}|${r.kind}`, r as PcbPaymentRow]));
  });
}

/**
 * Record (or correct) the payment reference for one company, month and stream.
 *
 * AN UPSERT, DELIBERATELY. The form has one box per month per stream, so a second reference for the same
 * box could never be printed; re-keying is a CORRECTION of what was recorded, not a second payment. The
 * unique index makes that true in the database as well as here.
 */
export async function recordPcbPayment(
  ctx: SessionContext,
  p: { companyId: string; periodKey: string; kind: PcbPaymentKind; receiptRef: string; paidOn?: string },
) {
  const receiptRef = p.receiptRef.trim();
  // The same floor statutory_report.ack_ref sets and for the same reason: without a reference, "paid" is
  // an unevidenced click. There is deliberately no FORMAT check — this repo cannot verify LHDN's shape,
  // and policing one would be inventing third-party behaviour.
  if (receiptRef === '') throw new PcbPaymentError('A receipt or transaction number is required.');
  if (!PERIOD_RE.test(p.periodKey)) throw new PcbPaymentError(`Not a month: ${p.periodKey}`);
  if (p.kind !== 'mtd' && p.kind !== 'cp38') throw new PcbPaymentError(`Not a payment kind: ${p.kind}`);
  const paidOn = p.paidOn ?? todayInKualaLumpur();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new PcbPaymentError(`Not a date: ${paidOn}`);

  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(pcbPayment)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        periodKey: p.periodKey,
        kind: p.kind,
        receiptRef,
        paidOn,
        recordedBy: ctx.userId ?? null,
      })
      .onConflictDoUpdate({
        target: [pcbPayment.companyId, pcbPayment.periodKey, pcbPayment.kind],
        set: { receiptRef, paidOn, recordedBy: ctx.userId ?? null, updatedAt: new Date() },
      })
      .returning({ id: pcbPayment.id });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'pcb-payment',
      aggregateId: row.id,
      eventType: 'pcb-payment.recorded',
      actor: actorOf(ctx),
      // The reference itself is NOT in the payload. It is a third party's identifier for a tax payment
      // and the row already holds it; an event stream is read far more widely than the table is.
      payload: { companyId: p.companyId, periodKey: p.periodKey, kind: p.kind, paidOn },
    });
    return row;
  });
}
