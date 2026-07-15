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

// Item 354a500d — Date-of-Birth-from-IC derivation. The impl lives in the leaf module `./ic-dob` (zero server
// deps) so the 'use client' autofill wrapper can import it too; re-exported here so server callers find it
// beside normalizeIC/isValidIC. Returns ISO yyyy-mm-dd or null (bad/short IC or an unreal YYMMDD date).
export { dobFromIC } from './ic-dob';

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

// SOCSO / EIS contribution-category override (item a7271737). The category is the single per-scheme control on
// the SOCSO & EIS card; the setter derives the legacy subject_to_socso / eis_eligible booleans from it.
export const SOCSO_CATEGORIES = ['auto', 'first', 'second', 'none'] as const;
export type SocsoCategory = (typeof SOCSO_CATEGORIES)[number];
export const isSocsoCategory = (v: string): v is SocsoCategory => (SOCSO_CATEGORIES as readonly string[]).includes(v);
export const EIS_CATEGORIES = ['auto', 'none'] as const;
export type EisCategory = (typeof EIS_CATEGORIES)[number];
export const isEisCategory = (v: string): v is EisCategory => (EIS_CATEGORIES as readonly string[]).includes(v);

export type StatutoryInput = {
  personId: string;
  icNumber: string;
  epfNumber?: string;
  socsoNumber?: string;
  taxNumber?: string;
  taxCategory?: number; // PCB (MTD) category: 1 single, 2 married/spouse not working, 3 married/spouse working
  numChildren?: number;
  eisEligible?: boolean;
  /** SOCSO / EIS contribution-category override (item a7271737). The single per-scheme control on the SOCSO &
   *  EIS card. `socsoCategory`: 'auto' keeps the kernel's age/citizenship derivation; 'first'/'second' force the
   *  band; 'none' zeroes the SOCSO leg. `eisCategory`: 'auto' keeps the derivation; 'none' zeroes the EIS leg.
   *  When set, the setter derives the legacy `subjectToSocso` / `eisEligible` booleans from it (= category
   *  !== 'none') so a caller can send EITHER the category OR the boolean and stay consistent. */
  socsoCategory?: SocsoCategory | string | null;
  eisCategory?: EisCategory | string | null;
  /** SOCSO & EIS statutory controls (item 5a461b99). `subjectToSocso`/`subjectToSkbbk` gate whether that
   *  scheme is contributed at all (unchecked ⇒ zero). `employerBears*` keep the scheme computed + reported in
   *  full but fund the employee's share from employer cost instead of deducting it from net (payroll wiring). */
  subjectToSocso?: boolean;
  subjectToSkbbk?: boolean;
  employerBearsSocso?: boolean;
  employerBearsEis?: boolean;
  employerBearsSkbbk?: boolean;
  /** Item 0d9bb2da — employer bears the employee's EPF contribution. The EPF employee + employer legs are
   *  still computed + reported in full; this only funds the employee's EPF share from employer cost instead
   *  of deducting it from net (payroll wiring mirrors employer_bears_socso/eis/tax). Defaults false. */
  employerBearsEpf?: boolean;
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
  // SOCSO / EIS contribution-category override (item a7271737). The category is the single per-scheme control;
  // when a caller sends it we honour it, otherwise we DERIVE it from the legacy boolean so pre-existing callers
  // that only pass subjectToSocso / eisEligible still map onto a category ('none' <=> scheme off). We then derive
  // the legacy booleans back FROM the resolved category so the persisted row is always internally consistent and
  // every downstream reader (payroll kernel, reports) that still reads subject_to_socso / eis_eligible is unchanged.
  const socsoCatRaw =
    p.socsoCategory != null && isSocsoCategory(String(p.socsoCategory)) ? (String(p.socsoCategory) as SocsoCategory) : null;
  const eisCatRaw =
    p.eisCategory != null && isEisCategory(String(p.eisCategory)) ? (String(p.eisCategory) as EisCategory) : null;
  const socsoCategory: SocsoCategory = socsoCatRaw ?? ((p.subjectToSocso ?? true) ? 'auto' : 'none');
  const eisCategory: EisCategory = eisCatRaw ?? ((p.eisEligible ?? true) ? 'auto' : 'none');
  const subjectToSocso = socsoCategory !== 'none';
  const eisEligible = eisCategory !== 'none';
  const values = {
    icNumber: normalizeIC(p.icNumber),
    epfNumber: p.epfNumber ?? null,
    socsoNumber: p.socsoNumber ?? null,
    taxNumber: p.taxNumber ?? null,
    taxCategory,
    numChildren,
    // Item a7271737 — persisted category override + the legacy booleans DERIVED from it (kept in sync so
    // downstream readers are unchanged). eisEligible doubles as the legacy "Subject to EIS".
    eisEligible,
    socsoCategory,
    eisCategory,
    // SOCSO & EIS statutory controls (item 5a461b99). Defaults preserve existing behaviour: subject_to_socso
    // on, employer_bears_* off. subject_to_skbbk defaults to false (reporter-approved for new employees;
    // migration 0198 backfilled pre-existing rows to true) — but on the setter path we default an
    // UNSPECIFIED value to the STORED value so a plain statutory save never silently flips it (the setter
    // is a full-row overwrite). The action always sends the checkbox state, so this only guards partial callers.
    subjectToSocso,
    subjectToSkbbk: p.subjectToSkbbk ?? false,
    employerBearsSocso: p.employerBearsSocso ?? false,
    employerBearsEis: p.employerBearsEis ?? false,
    employerBearsSkbbk: p.employerBearsSkbbk ?? false,
    // Item 0d9bb2da — employer-bears-EPF flag (default off ⇒ byte-identical). The action always sends the
    // checkbox state; this guards partial callers.
    employerBearsEpf: p.employerBearsEpf ?? false,
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
        // Statutory-control flags read for the event's before/after (item 5a461b99 audit trail; item a7271737
        // adds the socso/eis category before/after so a category change is reconstructable from the log alone).
        subjectToSocso: employeeStatutoryMy.subjectToSocso,
        socsoCategory: employeeStatutoryMy.socsoCategory,
        eisCategory: employeeStatutoryMy.eisCategory,
        eisEligible: employeeStatutoryMy.eisEligible,
        subjectToSkbbk: employeeStatutoryMy.subjectToSkbbk,
        employerBearsSocso: employeeStatutoryMy.employerBearsSocso,
        employerBearsEis: employeeStatutoryMy.employerBearsEis,
        employerBearsSkbbk: employeeStatutoryMy.employerBearsSkbbk,
        employerBearsEpf: employeeStatutoryMy.employerBearsEpf,
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
                socsoCategory: existing.socsoCategory,
                eisCategory: existing.eisCategory,
                employerBearsSocso: existing.employerBearsSocso,
                employerBearsEis: existing.employerBearsEis,
                employerBearsSkbbk: existing.employerBearsSkbbk,
                // Item 0d9bb2da — EPF employer-bears before/after so a compliance auditor can reconstruct
                // who toggled it and when, from the event log alone.
                employerBearsEpf: existing.employerBearsEpf,
              }
            : null,
          after: {
            subjectToSocso: values.subjectToSocso,
            subjectToEis: values.eisEligible,
            subjectToSkbbk: values.subjectToSkbbk,
            socsoCategory: values.socsoCategory,
            eisCategory: values.eisCategory,
            employerBearsSocso: values.employerBearsSocso,
            employerBearsEis: values.employerBearsEis,
            employerBearsSkbbk: values.employerBearsSkbbk,
            employerBearsEpf: values.employerBearsEpf,
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

/** A custom-holder switch was turned on without its required value (item ef720d3a). `field` names which. */
export class IncompleteCustomHolderError extends Error {
  constructor(public field: 'name' | 'id') {
    super(
      field === 'name'
        ? 'Enter the custom holder name, or turn off "Use a custom holder name".'
        : 'Enter the custom holder identification, or turn off "Use a custom holder identification".',
    );
    this.name = 'IncompleteCustomHolderError';
  }
}

/** Just the salary-payment bank columns + the custom-payment-holder controls (item ef720d3a). Used by the
 *  dedicated Bank Information card, which saves independently of the full statutory row. */
export type BankInput = {
  personId: string;
  bankName?: string | null;
  bankAccountNo?: string | null;
  enableCustomHolderName?: boolean;
  customHolderName?: string | null;
  enableCustomHolderId?: boolean;
  customHolderId?: string | null;
};

/**
 * Partial update of ONLY the bank + custom-payment-holder columns on employee_statutory_my, leaving the rest
 * of the statutory row (IC, EPF, SOCSO/EIS, PCB, zakat, TP3) untouched — the Bank Information card was split
 * out of the single full-row statutory form (item ef720d3a), so it needs its own partial setter, exactly like
 * setTp3ProfileMY. Requires an existing statutory row (bank details have no meaning without an IC on file) —
 * throws NoStatutoryProfileError otherwise. Validates require-when-enabled for both custom-holder fields.
 * Appends an `employee.bank.updated` DomainEvent (before/after) per substrate discipline.
 */
export async function setBankProfileMY(ctx: SessionContext, p: BankInput) {
  const enableName = p.enableCustomHolderName ?? false;
  const enableId = p.enableCustomHolderId ?? false;
  const holderName = (p.customHolderName ?? '').trim() || null;
  const holderId = (p.customHolderId ?? '').trim() || null;
  // Require-when-enabled (server-side; the client mirrors this). A flag on with a blank value is rejected so
  // an incomplete payee can never reach the disbursement path.
  if (enableName && !holderName) throw new IncompleteCustomHolderError('name');
  if (enableId && !holderId) throw new IncompleteCustomHolderError('id');
  const values = {
    bankName: (p.bankName ?? '').trim() || null,
    bankAccountNo: (p.bankAccountNo ?? '').trim() || null,
    // When a switch is off we null its stored value so a disabled holder can't linger and be resolved later.
    enableCustomHolderName: enableName,
    customHolderName: enableName ? holderName : null,
    enableCustomHolderId: enableId,
    customHolderId: enableId ? holderId : null,
  };
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        id: employeeStatutoryMy.id,
        bankName: employeeStatutoryMy.bankName,
        bankAccountNo: employeeStatutoryMy.bankAccountNo,
        enableCustomHolderName: employeeStatutoryMy.enableCustomHolderName,
        customHolderName: employeeStatutoryMy.customHolderName,
        enableCustomHolderId: employeeStatutoryMy.enableCustomHolderId,
        customHolderId: employeeStatutoryMy.customHolderId,
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
      eventType: 'employee.bank.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      // before/after of only the bank + custom-holder columns so a compliance auditor can reconstruct who
      // changed the salary-payment destination (incl. a custom-holder activation) and when, from the log
      // alone. Bank account number + custom-holder ID are payee routing identifiers, not per-payslip
      // cleartext pay figures, so recording them on the event is consistent with the other statutory setters.
      payload: {
        personId: p.personId,
        before: {
          bankName: existing.bankName,
          bankAccountNo: existing.bankAccountNo,
          enableCustomHolderName: existing.enableCustomHolderName,
          customHolderName: existing.customHolderName,
          enableCustomHolderId: existing.enableCustomHolderId,
          customHolderId: existing.customHolderId,
        },
        after: values,
      },
    });
    return { id: existing.id };
  });
}

// ── Item 8b5334db — Identification & Tax card ──────────────────────────────────────────────────────────
/** Tax residency status. resident ⇒ full computerised MTD; non_resident ⇒ flat 30% (spec §D.a); rep
 *  (Returning Expert Programme) + knowledge_worker (specific-region incentive, e.g. Iskandar) ⇒ flat 15%.
 *  Source: Income Tax (Exemption) orders / TalentCorp REP; both incentive schemes tax employment income at a
 *  flat 15%. The exact rate/eligibility is a government-incentive matter to confirm before go-live. */
export const TAX_RESIDENCIES = ['resident', 'non_resident', 'rep', 'knowledge_worker'] as const;
export type TaxResidency = (typeof TAX_RESIDENCIES)[number];
export const isTaxResidency = (v: string): v is TaxResidency => (TAX_RESIDENCIES as readonly string[]).includes(v);

/** How num_children is maintained. 'manual' = HR keys it; 'auto' = derived-from-family suggestion that HR
 *  confirms into num_children (never silent). Payroll always reads num_children regardless of mode. */
export const CHILD_RELIEF_MODES = ['manual', 'auto'] as const;
export type ChildReliefMode = (typeof CHILD_RELIEF_MODES)[number];
export const isChildReliefMode = (v: string): v is ChildReliefMode => (CHILD_RELIEF_MODES as readonly string[]).includes(v);

/** A tax partial-save was attempted before an IC exists (the statutory row is seeded by the IC field on the
 *  Profile tab, item 8b5334db). Distinct message so the admin knows where to set it. */
export class NoIcYetError extends Error {
  constructor() {
    super('Save the IC number on the Profile tab first, then set the tax details.');
    this.name = 'NoIcYetError';
  }
}

/**
 * Item 8b5334db — save ONLY the icNumber column on employee_statutory_my. IC was relocated from the Bank &
 * Statutory card to the Profile tab (following the R34 TP3 split precedent), so it needs its own partial setter.
 * IC is the SEED of the statutory row (it is the notNull identity), so unlike setTp3/setBank this UPSERTS: it
 * creates the row when the person has none yet. Validates the IC (12 digits) and appends `employee.ic.updated`.
 * Persisting to the SAME column keeps setStatutoryAction's IC-derived SOCSO/EIS + EPF-number defaults working.
 */
export async function setIcProfileMY(ctx: SessionContext, p: { personId: string; icNumber: string }) {
  if (!isValidIC(p.icNumber)) throw new InvalidICError();
  const ic = normalizeIC(p.icNumber);
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: employeeStatutoryMy.id, icNumber: employeeStatutoryMy.icNumber })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, p.personId))
      .limit(1);
    let id: string;
    if (existing) {
      await tx
        .update(employeeStatutoryMy)
        .set({ icNumber: ic, updatedAt: sql`now()` })
        .where(eq(employeeStatutoryMy.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await tx
        .insert(employeeStatutoryMy)
        .values({ tenantId: ctx.tenantId, personId: p.personId, icNumber: ic })
        .returning({ id: employeeStatutoryMy.id });
      id = row.id;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-statutory',
      aggregateId: id,
      eventType: 'employee.ic.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      // IC is a government identity number (like the SOCSO/bank routing identifiers already recorded on the
      // sibling statutory events); before/after so an auditor can reconstruct a correction from the log alone.
      payload: { personId: p.personId, before: { icNumber: existing?.icNumber ?? null }, after: { icNumber: ic } },
    });
    return { id };
  });
}

/** Just the tax columns of the Identification & Tax card (item 8b5334db). Used by the dedicated card, which
 *  saves independently of the full statutory row (like setTp3/setBank). */
export type TaxInput = {
  personId: string;
  taxNumber?: string | null;
  taxCategory?: number;
  taxResidency?: TaxResidency | string | null;
  numChildren?: number;
  childReliefMode?: ChildReliefMode | string | null;
  employerBearsTax?: boolean;
};

/**
 * Partial update of ONLY the tax columns on employee_statutory_my (taxNumber, taxCategory, taxResidency +
 * synced isResident, numChildren, childReliefMode, employerBearsTax), leaving the rest of the row (IC, EPF,
 * SOCSO/EIS, bank, TP3, zakat) untouched — the Identification & Tax card was split out of the single full-row
 * statutory form (item 8b5334db), exactly like setTp3/setBank. Requires an existing statutory row (the IC seeds
 * it on the Profile tab) — throws NoIcYetError otherwise. isResident is kept in sync as the legacy source of
 * truth (resident ⇒ true, any incentive status ⇒ false). Appends `employee.tax.updated` (before/after).
 */
export async function setTaxProfileMY(ctx: SessionContext, p: TaxInput) {
  const residency: TaxResidency =
    p.taxResidency != null && isTaxResidency(String(p.taxResidency)) ? (String(p.taxResidency) as TaxResidency) : 'resident';
  const mode: ChildReliefMode =
    p.childReliefMode != null && isChildReliefMode(String(p.childReliefMode)) ? (String(p.childReliefMode) as ChildReliefMode) : 'manual';
  const taxCategory = [1, 2, 3].includes(Number(p.taxCategory)) ? Number(p.taxCategory) : 1;
  const numChildren = Math.max(0, Math.floor(Number(p.numChildren) || 0));
  const values = {
    taxNumber: (p.taxNumber ?? '').trim() || null,
    taxCategory,
    numChildren,
    childReliefMode: mode,
    taxResidency: residency,
    // Keep the legacy boolean in sync so any caller still reading is_resident sees the right full-MTD vs
    // flat-rate intent (only 'resident' is a full-MTD resident; the three incentive statuses are not).
    isResident: residency === 'resident',
    employerBearsTax: p.employerBearsTax ?? false,
  };
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        id: employeeStatutoryMy.id,
        taxNumber: employeeStatutoryMy.taxNumber,
        taxCategory: employeeStatutoryMy.taxCategory,
        numChildren: employeeStatutoryMy.numChildren,
        childReliefMode: employeeStatutoryMy.childReliefMode,
        taxResidency: employeeStatutoryMy.taxResidency,
        isResident: employeeStatutoryMy.isResident,
        employerBearsTax: employeeStatutoryMy.employerBearsTax,
      })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, p.personId))
      .limit(1);
    if (!existing) throw new NoIcYetError();
    await tx
      .update(employeeStatutoryMy)
      .set({ ...values, updatedAt: sql`now()` })
      .where(eq(employeeStatutoryMy.id, existing.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-statutory',
      aggregateId: existing.id,
      eventType: 'employee.tax.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      // before/after of only the tax columns so a compliance auditor can reconstruct residency / relief /
      // employer-bears changes (the inputs that drive PCB) from the event log alone. These are config settings,
      // not per-payslip cleartext pay, so recording them is consistent with the other statutory setters.
      payload: {
        personId: p.personId,
        before: existing
          ? {
              taxNumber: existing.taxNumber,
              taxCategory: existing.taxCategory,
              numChildren: existing.numChildren,
              childReliefMode: existing.childReliefMode,
              taxResidency: existing.taxResidency,
              employerBearsTax: existing.employerBearsTax,
            }
          : null,
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
