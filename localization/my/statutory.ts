/**
 * Malaysia statutory profile (localization pack, per ADR-0008). Per-Person statutory
 * identity: IC, EPF, SOCSO, tax, EIS eligibility, bank. IC is validated + unique per tenant.
 */
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { employeeStatutoryMy } from '../../db/schema';

export class InvalidICError extends Error {
  constructor() {
    super('Invalid Malaysian IC number (expected 12 digits)');
    this.name = 'InvalidICError';
  }
}

export const normalizeIC = (ic: string): string => ic.replace(/\D/g, '');
export const isValidIC = (ic: string): boolean => /^\d{12}$/.test(normalizeIC(ic));

export type StatutoryInput = {
  personId: string;
  icNumber: string;
  epfNumber?: string;
  socsoNumber?: string;
  taxNumber?: string;
  taxCategory?: number; // PCB (MTD) category: 1 single, 2 married/spouse not working, 3 married/spouse working
  numChildren?: number;
  eisEligible?: boolean;
  bankName?: string;
  bankAccountNo?: string;
  /** TP3 / opening balances for the PCB accumulators (ADR-0014) — YTD figures from a previous
   *  employer (or pre-migration months), applied only when tp3Year matches the pay year. */
  tp3Year?: number | null;
  tp3NetRemuneration?: number | null;
  tp3EpfClaimed?: number | null;
  tp3PcbPaid?: number | null;
  tp3ZakatPaid?: number | null;
};

export async function setStatutoryProfileMY(ctx: SessionContext, p: StatutoryInput) {
  if (!isValidIC(p.icNumber)) throw new InvalidICError();
  const taxCategory = [1, 2, 3].includes(Number(p.taxCategory)) ? Number(p.taxCategory) : 1;
  const numChildren = Math.max(0, Math.floor(Number(p.numChildren) || 0));
  const money = (v: number | null | undefined) =>
    v == null || Number.isNaN(Number(v)) ? null : Number(v).toFixed(2);
  const values = {
    icNumber: normalizeIC(p.icNumber),
    epfNumber: p.epfNumber ?? null,
    socsoNumber: p.socsoNumber ?? null,
    taxNumber: p.taxNumber ?? null,
    taxCategory,
    numChildren,
    eisEligible: p.eisEligible ?? true,
    bankName: p.bankName ?? null,
    bankAccountNo: p.bankAccountNo ?? null,
    tp3Year: p.tp3Year ?? null,
    tp3NetRemuneration: money(p.tp3NetRemuneration),
    tp3EpfClaimed: money(p.tp3EpfClaimed),
    tp3PcbPaid: money(p.tp3PcbPaid),
    tp3ZakatPaid: money(p.tp3ZakatPaid),
  };
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: employeeStatutoryMy.id })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, p.personId))
      .limit(1);
    let id: string;
    if (existing) {
      await tx
        .update(employeeStatutoryMy)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(employeeStatutoryMy.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await tx
        .insert(employeeStatutoryMy)
        .values({ tenantId: ctx.tenantId, personId: p.personId, ...values })
        .returning({ id: employeeStatutoryMy.id });
      id = row.id;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-statutory-my',
      aggregateId: id,
      eventType: existing ? 'statutory.my.updated' : 'statutory.my.created',
      actor: actorOf(ctx),
      payload: { personId: p.personId },
    });
    return { id };
  });
}

export function getStatutoryProfileMY(ctx: SessionContext, personId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, personId))
      .limit(1);
    return row ?? null;
  });
}
