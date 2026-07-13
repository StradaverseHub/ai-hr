/**
 * Malaysia statutory profile (localization pack, per ADR-0008). Per-Person statutory
 * identity: IC, EPF, SOCSO, tax, EIS eligibility, bank. IC is validated + unique per tenant.
 */
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../../db/events';
import { employeeStatutoryMy } from '../../db/schema';
import { DEFAULT_MY_STATUTORY } from './statutory-tables';
import { MY_STATES } from './holidays';
import type { EpfMode } from './payroll';

/** 1.2.4 Zakat — the per-employee zakat-via-salary election method. */
export type ZakatMethod = 'percent_of_pcb' | 'fixed';

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

/** 1.2.4 Zakat — an invalid zakat election (bad state, method, or a missing required amount). */
export class InvalidZakatSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidZakatSetupError';
  }
}

/** Resolve + validate the per-employee zakat election (1.2.4). zakatActive is the opt-in gate; when off,
 *  every other zakat field is nulled (no election regardless of stray values). When on, the method's
 *  required amount must be present and the off-method amount is nulled. State (if given) must be a MY state.
 *  Effective dates are stored verbatim as INERT display-only metadata (no calc-path filtering). */
function resolveZakatElection(p: {
  zakatActive?: boolean;
  zakatState?: string | null;
  zakatMethod?: ZakatMethod | null;
  zakatPercent?: number | null;
  zakatFixed?: number | null;
  zakatEffectiveFrom?: string | null;
  zakatEffectiveTo?: string | null;
}): {
  zakatActive: boolean;
  zakatState: string | null;
  zakatMethod: ZakatMethod | null;
  zakatPercent: string | null;
  zakatFixed: string | null;
  zakatEffectiveFrom: string | null;
  zakatEffectiveTo: string | null;
} {
  const active = p.zakatActive === true;
  if (p.zakatState != null && p.zakatState !== '' && !(MY_STATES as readonly string[]).includes(p.zakatState))
    throw new InvalidZakatSetupError(`Unknown Malaysian state '${p.zakatState}' for zakat.`);
  const state = p.zakatState && p.zakatState !== '' ? p.zakatState : null;
  if (!active) {
    // Opt-out: keep the (validated) state + dates as harmless metadata, drop the method/amounts.
    return {
      zakatActive: false,
      zakatState: state,
      zakatMethod: null,
      zakatPercent: null,
      zakatFixed: null,
      zakatEffectiveFrom: p.zakatEffectiveFrom || null,
      zakatEffectiveTo: p.zakatEffectiveTo || null,
    };
  }
  const method = p.zakatMethod === 'percent_of_pcb' || p.zakatMethod === 'fixed' ? p.zakatMethod : null;
  if (method == null) throw new InvalidZakatSetupError('A zakat method (percent_of_pcb or fixed) is required when zakat is active.');
  const pct = p.zakatPercent == null || Number.isNaN(Number(p.zakatPercent)) ? null : Math.max(0, Number(p.zakatPercent));
  const fixed = p.zakatFixed == null || Number.isNaN(Number(p.zakatFixed)) ? null : Math.max(0, Number(p.zakatFixed));
  if (method === 'percent_of_pcb' && pct == null)
    throw new InvalidZakatSetupError('A zakat percentage is required for the percent_of_pcb method.');
  if (method === 'fixed' && fixed == null)
    throw new InvalidZakatSetupError('A fixed zakat amount is required for the fixed method.');
  return {
    zakatActive: true,
    zakatState: state,
    zakatMethod: method,
    // Persist only the field for the active method; null the other.
    zakatPercent: method === 'percent_of_pcb' ? (pct as number).toFixed(4) : null,
    zakatFixed: method === 'fixed' ? (fixed as number).toFixed(2) : null,
    zakatEffectiveFrom: p.zakatEffectiveFrom || null,
    zakatEffectiveTo: p.zakatEffectiveTo || null,
  };
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

/**
 * Item 5a461b99 — a person is "Malaysian" for the SOCSO & EIS Number default when their nationality
 * catalog value reads Malaysian/Malaysia (case-insensitive; the catalog is free-text/dropdown, so match
 * loosely). Pure helper (no 'use client') so both the RSC detail page and the server action can call it.
 */
export const isMalaysianNationality = (nationality?: string | null): boolean => {
  const n = (nationality ?? '').trim().toLowerCase();
  return n === 'malaysian' || n === 'malaysia' || n === 'my' || n === 'mys';
};

/**
 * The SOCSO & EIS Number to persist. For a Malaysian employee with a blank number, default it to the
 * (normalised) IC number — SOCSO/EIS register locals under their MyKad. Non-Malaysians and any explicitly
 * entered value are returned untouched. Used by setStatutoryAction (server-side normalisation) and mirrored
 * as the form default on the detail page.
 */
export const defaultSocsoEisNumber = (args: {
  socsoNumber?: string | null;
  icNumber?: string | null;
  nationality?: string | null;
}): string | undefined => {
  const entered = (args.socsoNumber ?? '').trim();
  if (entered) return entered;
  if (isMalaysianNationality(args.nationality) && args.icNumber) {
    const ic = normalizeIC(args.icNumber);
    if (isValidIC(ic)) return ic;
  }
  return undefined;
};

export type StatutoryInput = {
  personId: string;
  icNumber: string;
  epfNumber?: string;
  socsoNumber?: string;
  taxNumber?: string;
  taxCategory?: number; // PCB (MTD) category: 1 single, 2 married/spouse not working, 3 married/spouse working
  numChildren?: number;
  eisEligible?: boolean;
  /** SOCSO & EIS statutory controls (item 5a461b99). `subjectToSocso`/`subjectToSkbbk` gate whether that
   *  scheme is contributed at all (unchecked ⇒ zero). `employerBears*` keep the scheme computed + reported in
   *  full but fund the employee's share from employer cost instead of deducting it from net (payroll wiring). */
  subjectToSocso?: boolean;
  subjectToSkbbk?: boolean;
  employerBearsSocso?: boolean;
  employerBearsEis?: boolean;
  employerBearsSkbbk?: boolean;
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
  /** 1.2.4 Zakat election. zakatActive is the opt-in gate (false ⇒ no zakat). zakatState ∈ MY_STATES is
   *  display/metadata only. zakatMethod selects percent-of-MTD vs a fixed RM amount; the off-method amount
   *  is nulled by the setter. zakatEffectiveFrom/To are INERT display-only (no calc-path filtering). */
  zakatActive?: boolean;
  zakatState?: string | null;
  zakatMethod?: ZakatMethod | null;
  zakatPercent?: number | null;
  zakatFixed?: number | null;
  zakatEffectiveFrom?: string | null;
  zakatEffectiveTo?: string | null;
};

export async function setStatutoryProfileMY(ctx: SessionContext, p: StatutoryInput) {
  if (!isValidIC(p.icNumber)) throw new InvalidICError();
  const taxCategory = [1, 2, 3].includes(Number(p.taxCategory)) ? Number(p.taxCategory) : 1;
  const numChildren = Math.max(0, Math.floor(Number(p.numChildren) || 0));
  const money = (v: number | null | undefined) =>
    v == null || Number.isNaN(Number(v)) ? null : Number(v).toFixed(2);
  const epf = resolveEpfElection(p); // throws InvalidEpfElectionError on a below-floor election
  const zakat = resolveZakatElection(p); // throws InvalidZakatSetupError on a bad election
  const values = {
    icNumber: normalizeIC(p.icNumber),
    epfNumber: p.epfNumber ?? null,
    socsoNumber: p.socsoNumber ?? null,
    taxNumber: p.taxNumber ?? null,
    taxCategory,
    numChildren,
    eisEligible: p.eisEligible ?? true,
    // SOCSO & EIS statutory controls (item 5a461b99). Defaults preserve existing behaviour: subject_to_socso
    // on, employer_bears_* off. subject_to_skbbk defaults to false (reporter-approved for new employees;
    // migration 0198 backfilled pre-existing rows to true) — but on the setter path we default an
    // UNSPECIFIED value to the STORED value so a plain statutory save never silently flips it (the setter
    // is a full-row overwrite). The action always sends the checkbox state, so this only guards partial callers.
    subjectToSocso: p.subjectToSocso ?? true,
    subjectToSkbbk: p.subjectToSkbbk ?? false,
    employerBearsSocso: p.employerBearsSocso ?? false,
    employerBearsEis: p.employerBearsEis ?? false,
    employerBearsSkbbk: p.employerBearsSkbbk ?? false,
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
    // 1.2.4 Zakat election (resolved + validated above).
    zakatActive: zakat.zakatActive,
    zakatState: zakat.zakatState,
    zakatMethod: zakat.zakatMethod,
    zakatPercent: zakat.zakatPercent,
    zakatFixed: zakat.zakatFixed,
    zakatEffectiveFrom: zakat.zakatEffectiveFrom,
    zakatEffectiveTo: zakat.zakatEffectiveTo,
  };
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        id: employeeStatutoryMy.id,
        // Statutory-control flags read for the event's before/after (item 5a461b99 audit trail).
        subjectToSocso: employeeStatutoryMy.subjectToSocso,
        eisEligible: employeeStatutoryMy.eisEligible,
        subjectToSkbbk: employeeStatutoryMy.subjectToSkbbk,
        employerBearsSocso: employeeStatutoryMy.employerBearsSocso,
        employerBearsEis: employeeStatutoryMy.employerBearsEis,
        employerBearsSkbbk: employeeStatutoryMy.employerBearsSkbbk,
      })
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
      // Carry the resolved EPF + zakat election on the event so a mode change is reconstructable from the
      // log alone (CLAUDE.md substrate discipline). Rates are decimals (e.g. '0.1500') or null. The zakat
      // percent/fixed are config rates, not per-payslip cleartext pay (ADR-0030), so they may be recorded.
      payload: {
        personId: p.personId,
        epfMode: epf.epfMode,
        epfEmployeeRate: epf.epfEmployeeRate,
        epfEmployerRate: epf.epfEmployerRate,
        zakatActive: zakat.zakatActive,
        zakatState: zakat.zakatState,
        zakatMethod: zakat.zakatMethod,
        zakatPercent: zakat.zakatPercent,
        zakatFixed: zakat.zakatFixed,
        zakatEffectiveFrom: zakat.zakatEffectiveFrom,
        zakatEffectiveTo: zakat.zakatEffectiveTo,
        // SOCSO & EIS statutory controls (item 5a461b99) — before/after so a compliance auditor can
        // reconstruct who toggled subject-to / employer-bears and when, from the event log alone.
        statutoryControls: {
          before: existing
            ? {
                subjectToSocso: existing.subjectToSocso,
                subjectToEis: existing.eisEligible,
                subjectToSkbbk: existing.subjectToSkbbk,
                employerBearsSocso: existing.employerBearsSocso,
                employerBearsEis: existing.employerBearsEis,
                employerBearsSkbbk: existing.employerBearsSkbbk,
              }
            : null,
          after: {
            subjectToSocso: values.subjectToSocso,
            subjectToEis: values.eisEligible,
            subjectToSkbbk: values.subjectToSkbbk,
            employerBearsSocso: values.employerBearsSocso,
            employerBearsEis: values.employerBearsEis,
            employerBearsSkbbk: values.employerBearsSkbbk,
          },
        },
      },
    });
    return { id };
  });
}

/** A TP3 partial-save was attempted for a person with no Malaysian statutory row yet. */
export class NoStatutoryProfileError extends Error {
  constructor() {
    super('No Malaysian statutory profile yet — save the IC number on Bank & Statutory first.');
    this.name = 'NoStatutoryProfileError';
  }
}

/** Just the four TP3 opening-balance columns (ADR-0014). Used by the dedicated Payroll-tab TP3 card. */
export type Tp3Input = {
  personId: string;
  tp3Year?: number | null;
  tp3NetRemuneration?: number | null;
  tp3EpfClaimed?: number | null;
  tp3PcbPaid?: number | null;
};

/**
 * Partial update of ONLY the four TP3 opening-balance columns on employee_statutory_my, leaving the
 * rest of the statutory row (IC, EPF, SOCSO/EIS, bank, zakat election, tp3ZakatPaid) untouched. This is
 * the counterpart to setStatutoryProfileMY's full-row overwrite: item a6a47698 relocated the TP3 fields
 * onto the Payroll tab with their own save, so they can no longer ride the statutory form. Requires an
 * existing statutory row (TP3 has no meaning without an IC on file) — throws NoStatutoryProfileError
 * otherwise. Appends an `employee.tp3.updated` DomainEvent (before/after) per substrate discipline.
 */
export async function setTp3ProfileMY(ctx: SessionContext, p: Tp3Input) {
  const money = (v: number | null | undefined) =>
    v == null || Number.isNaN(Number(v)) ? null : Number(v).toFixed(2);
  const values = {
    tp3Year: p.tp3Year ?? null,
    tp3NetRemuneration: money(p.tp3NetRemuneration),
    tp3EpfClaimed: money(p.tp3EpfClaimed),
    tp3PcbPaid: money(p.tp3PcbPaid),
  };
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        id: employeeStatutoryMy.id,
        tp3Year: employeeStatutoryMy.tp3Year,
        tp3NetRemuneration: employeeStatutoryMy.tp3NetRemuneration,
        tp3EpfClaimed: employeeStatutoryMy.tp3EpfClaimed,
        tp3PcbPaid: employeeStatutoryMy.tp3PcbPaid,
      })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, p.personId))
      .limit(1);
    if (!existing) throw new NoStatutoryProfileError();
    await tx
      .update(employeeStatutoryMy)
      .set({ ...values, updatedAt: sql`now()` })
      .where(eq(employeeStatutoryMy.id, existing.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-statutory',
      aggregateId: existing.id,
      eventType: 'employee.tp3.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      // before/after of only the four TP3 columns so a compliance auditor can reconstruct the opening
      // balances that seeded the PCB accumulators, from the event log alone. tp3* are YTD figures, not
      // per-payslip cleartext pay — recording them on the event is fine under ADR-0030.
      payload: {
        personId: p.personId,
        before: {
          tp3Year: existing.tp3Year,
          tp3NetRemuneration: existing.tp3NetRemuneration,
          tp3EpfClaimed: existing.tp3EpfClaimed,
          tp3PcbPaid: existing.tp3PcbPaid,
        },
        after: values,
      },
    });
    return { id: existing.id };
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
