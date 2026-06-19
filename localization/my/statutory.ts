/**
 * Malaysia statutory profile (localization pack, per ADR-0008). Per-Person statutory
 * identity: IC, EPF, SOCSO, tax, EIS eligibility, bank. IC is validated + unique per tenant.
 */
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../../db/events';
import { employeeStatutoryMy } from '../../db/schema';
import { DEFAULT_MY_STATUTORY } from './statutory-tables';
import type { EpfMode } from './payroll';

export class InvalidICError extends Error {
  constructor() {
    super('Invalid Malaysian IC number (expected 12 digits)');
    this.name = 'InvalidICError';
  }
}

/** An i-Topup election tried to set a rate below the statutory Third Schedule floor, or out of range. */
export class InvalidEpfElectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEpfElectionError';
  }
}

const EPF_EMPLOYEE_FLOOR = DEFAULT_MY_STATUTORY.epf.employeeRate; // 11%
// Lowest statutory employer rate (12% for wages > RM5,000); the calculator bumps ≤RM5,000 to 13%.
const EPF_EMPLOYER_FLOOR = Math.min(
  DEFAULT_MY_STATUTORY.epf.employerRateLow,
  DEFAULT_MY_STATUTORY.epf.employerRateHigh,
);

/** Resolve + validate the per-side EPF election (Wave 2B). i-Topup can only RAISE a rate, never
 *  lower it below statutory; rates outside [floor, 1] are rejected. Rates are kept only for
 *  'voluntary_excess'; 'auto'/'exempt' carry no rates. */
function resolveEpfElection(p: {
  epfMode?: EpfMode;
  epfEmployeeRate?: number | null;
  epfEmployerRate?: number | null;
}): { epfMode: EpfMode; epfEmployeeRate: string | null; epfEmployerRate: string | null } {
  const mode: EpfMode =
    p.epfMode === 'voluntary_excess' || p.epfMode === 'exempt' ? p.epfMode : 'auto';
  if (mode !== 'voluntary_excess') return { epfMode: mode, epfEmployeeRate: null, epfEmployerRate: null };
  const side = (rate: number | null | undefined, floor: number, label: string): string | null => {
    if (rate == null || Number.isNaN(Number(rate))) return null; // null = that side stays statutory
    const r = Number(rate);
    if (r < floor || r > 1)
      throw new InvalidEpfElectionError(
        `${label} EPF rate ${(r * 100).toFixed(2)}% must be at or above the statutory ${(floor * 100).toFixed(0)}% and at most 100% (i-Topup can only raise the rate).`,
      );
    return r.toFixed(4);
  };
  return {
    epfMode: mode,
    epfEmployeeRate: side(p.epfEmployeeRate, EPF_EMPLOYEE_FLOOR, 'Employee'),
    epfEmployerRate: side(p.epfEmployerRate, EPF_EMPLOYER_FLOOR, 'Employer'),
  };
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
  /** Tax residency — non-residents pay flat 30% MTD (LHDN spec §D.a). Defaults to resident. */
  isResident?: boolean;
  /** EPF citizenship status — selects the Third Schedule rule (Part A / Part E / non-citizen 2%/2%).
   *  Defaults to 'citizen'. (Distinct from tax residency: a non-citizen can be tax-resident.) */
  epfCitizenship?: 'citizen' | 'pr' | 'non_citizen';
  /** EPF contribution mode (Wave 2B). 'voluntary_excess' uses the elected per-side rates (decimals,
   *  e.g. 0.15); a null rate keeps that side statutory. 'exempt' zeroes both (exempt employees only). */
  epfMode?: EpfMode;
  epfEmployeeRate?: number | null;
  epfEmployerRate?: number | null;
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
  const epf = resolveEpfElection(p); // throws InvalidEpfElectionError on a below-floor election
  const values = {
    icNumber: normalizeIC(p.icNumber),
    epfNumber: p.epfNumber ?? null,
    socsoNumber: p.socsoNumber ?? null,
    taxNumber: p.taxNumber ?? null,
    taxCategory,
    numChildren,
    eisEligible: p.eisEligible ?? true,
    isResident: p.isResident ?? true,
    epfCitizenship: p.epfCitizenship ?? 'citizen',
    epfMode: epf.epfMode,
    epfEmployeeRate: epf.epfEmployeeRate,
    epfEmployerRate: epf.epfEmployerRate,
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
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
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
