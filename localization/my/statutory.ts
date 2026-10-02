/**
 * Malaysia statutory profile (localization pack, per ADR-0008). Per-Person statutory
 * identity: IC, EPF, SOCSO, tax, EIS eligibility, bank. IC is validated + unique per tenant.
 */
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../../db/events';
import { companyStatutoryMy, domainEvent, employeeStatutoryMy, employment, person } from '../../db/schema';
import { CHILD_RELIEF_CATEGORY_KEYS, DEFAULT_MY_STATUTORY, type HrdfStatus } from './statutory-tables';
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

/** What `resolveEpfElection` persists: the lawful mode plus the four figures and the reason, every one of
 *  them nulled for a mode that does not use it. The setter is a FULL-ROW OVERWRITE, so "nulled" is the
 *  mechanism that makes changing category actually clear the previous category's figures rather than
 *  leaving them behind for a future reader to apply. */
type ResolvedEpfElection = {
  epfMode: EpfMode;
  epfEmployeeRate: string | null;
  epfEmployerRate: string | null;
  epfEmployeeAmount: string | null;
  epfEmployerAmount: string | null;
  epfManualReason: string | null;
};

/**
 * Resolve + validate the per-side EPF election (Wave 2B; item 70b14723 adds 'manual_amount').
 *
 * RATES ('voluntary_excess'): i-Topup can only RAISE a rate, never lower it below statutory; rates
 * outside [floor, 1] are rejected. Rates are kept only for 'voluntary_excess'.
 *
 * ══ AMOUNTS ('manual_amount', item 70b14723) — WHAT IS REFUSED, AND THE ONE THING THAT IS NOT ══
 *
 * REFUSED: a manual category with NO amount on either side (it elects nothing — the row would compute
 * exactly as 'auto' while the screen said a person had decided it); a negative; a non-finite figure; and a
 * blank reason. The reason is mandatory for the same purpose it is mandatory on the per-run override
 * (`saveStatutoryAdjustment`): a figure that overrules a contribution schedule has to carry somebody's
 * words or an auditor is left with an unexplained number.
 *
 * ⚠️ NOT REFUSED: AN AMOUNT BELOW THE THIRD SCHEDULE. Decided, with evidence, and it is the one decision
 * in this function worth reading twice:
 *   · the product's own precedent on the IDENTICAL figure — `saveStatutoryAdjustment` (core/payroll.ts)
 *     lets an operator type any EPF employee/employer amount for a run and refuses only a NEGATIVE. A
 *     floor here and none there would be incoherent about the same money;
 *   · a lawful below-schedule case this system cannot compute at all, which its OWN sources document
 *     already flags as unhandled: "pre-1998 legacy (5.5% / 6-6.5%) is NOT auto-applied (rare - flag if any
 *     such grandfathered member exists)" (docs/architecture/STATUTORY-SOURCES.md §2). Those legacy figures
 *     are RATES and the rate election still cannot carry them, because `voluntary_excess` is
 *     max(elected, statutory) and can only RAISE. A typed amount is the only affordance, and a floor here
 *     would close it;
 *   · the ticket asked in so many words that the automatic calculation must not override the amount.
 * The consequence is real and it is the operator's: the KWSP submission file carries the employee's TRUE
 * wage in the Upah column and this amount in the contribution column, and if the two disagree with the
 * schedule the agency is the one who notices. We have not tested KWSP's own validation and do not guess.
 *
 * ⚠️ ONE-OF-TWO IS NOT AN ERROR EITHER, and the reason is the existing model rather than leniency. The
 * ticket's three categories ARE the three combinations of (employee amount set, employer amount set) —
 * nothing stores the category — so an employee amount with a blank employer amount IS "Manual (Employee by
 * Amount)", and the employer side keeping the schedule is exactly what a blank side means. It is the same
 * rule a `voluntary_excess` row with a null employer RATE already follows, and it is why no stored row can
 * carry a category that disagrees with its own figures. The visible amount boxes are `required` in the
 * form, so the browser asks before a side is left blank by accident.
 */
function resolveEpfElection(p: {
  epfMode?: EpfMode;
  epfEmployeeRate?: number | null;
  epfEmployerRate?: number | null;
  epfEmployeeAmount?: number | null;
  epfEmployerAmount?: number | null;
  epfManualReason?: string | null;
}): ResolvedEpfElection {
  const mode: EpfMode =
    p.epfMode === 'voluntary_excess' || p.epfMode === 'exempt' || p.epfMode === 'manual_amount' ? p.epfMode : 'auto';
  const NO_AMOUNT = { epfEmployeeAmount: null, epfEmployerAmount: null, epfManualReason: null };
  if (mode === 'manual_amount') {
    const amount = (v: number | null | undefined, label: string): string | null => {
      if (v == null) return null; // null = that side keeps the rule ("a blank side stays statutory")
      const n = Number(v);
      if (!Number.isFinite(n))
        throw new InvalidEpfElectionError(`${label} EPF amount is not a number — enter a figure in ringgit or leave it blank.`);
      if (n < 0)
        throw new InvalidEpfElectionError(
          `${label} EPF amount ${n} cannot be negative. A KWSP Borang A upload file has no way to express a negative contribution.`,
        );
      return n.toFixed(2);
    };
    const employeeAmount = amount(p.epfEmployeeAmount, 'Employee');
    const employerAmount = amount(p.epfEmployerAmount, 'Employer');
    if (employeeAmount == null && employerAmount == null)
      throw new InvalidEpfElectionError(
        'A manual EPF category needs an employee amount, an employer amount, or both. Enter the figure, or choose Auto to have it calculated.',
      );
    const reason = (p.epfManualReason ?? '').trim();
    if (reason === '')
      throw new InvalidEpfElectionError('A reason is required for a manual EPF amount — say why this employee\'s EPF is a fixed figure.');
    // Rates are nulled: a manual amount and an elected rate are two different elections and a row carrying
    // both would leave the next reader to guess which one payroll honoured.
    return { epfMode: mode, epfEmployeeRate: null, epfEmployerRate: null, epfEmployeeAmount: employeeAmount, epfEmployerAmount: employerAmount, epfManualReason: reason };
  }
  if (mode !== 'voluntary_excess') return { epfMode: mode, epfEmployeeRate: null, epfEmployerRate: null, ...NO_AMOUNT };
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
    ...NO_AMOUNT,
  };
}

export const normalizeIC = (ic: string): string => ic.replace(/\D/g, '');
export const isValidIC = (ic: string): boolean => /^\d{12}$/.test(normalizeIC(ic));

// Item 354a500d — Date-of-Birth-from-IC derivation. The impl lives in the leaf module `./ic-dob` (zero server
// deps) so the 'use client' autofill wrapper can import it too; re-exported here so server callers find it
// beside normalizeIC/isValidIC. Returns ISO yyyy-mm-dd or null (bad/short IC or an unreal YYMMDD date).
export { dobFromIC } from './ic-dob';

/**
 * Item 5a461b99 / e3ce0d4d — "is this person Malaysian?" (Malaysian/Malaysia/MY/MYS, case-insensitive). The
 * single source of truth lives in the leaf `./ic-dob` module (zero db deps) so the 'use client' identity
 * wrapper can import it WITHOUT pulling `db` into the client bundle; re-exported here for the server callers
 * (defaultSocsoEisNumber below, the RSC page) that already import from statutory.ts.
 */
import { isMalaysianNationality } from './ic-dob';
export { isMalaysianNationality };

/**
 * The SOCSO & EIS Number to persist. For a Malaysian employee with a blank number, default it to the
 * (normalised) IC number — SOCSO/EIS register locals under their MyKad. Non-Malaysians and any explicitly
 * entered value are returned untouched. Used by setStatutoryAction (server-side normalisation) and mirrored
 * as the form default on the detail page.
 */
// 35b7af0a group 7 — MOVED to ./socso-eis, a db-free leaf, so the shared SOCSO/EIS field group can
// apply the same default on the CLIENT wizard as this screen applies server-side. Re-exported here so
// every existing server caller (setStatutoryAction, the Personnel RSC page) is unchanged.
export { defaultSocsoEisNumber } from './socso-eis';

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
  /** Item 35524d1f — the MyKad IC is OPTIONAL (null/blank ⇒ stored null), matching setIcProfileMY: a passport
   *  holder has none, and refusing the whole statutory row over it discarded their bank and EPF details. The
   *  key stays REQUIRED even though the value is nullable, deliberately: this setter is a full-row overwrite,
   *  so a caller that simply forgot the field would silently wipe a stored IC — a compile error is the guard.
   *  Pass the stored value on a read-modify-write; pass null only when you mean "this person has no IC". */
  icNumber: string | null;
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
  /** Item 70b14723 — 'manual_amount' uses these instead of the rates: the exact monthly EPF figure in RM,
   *  per side. A null side keeps that side on the rule ("a blank side stays statutory"), which is what makes
   *  the ticket's three named categories the three combinations of the two. `epfManualReason` is MANDATORY
   *  for the mode and nulled for every other one. Amounts below the Third Schedule are accepted and
   *  recorded — see `resolveEpfElection`. A negative is refused here rather than at file-generation time. */
  epfEmployeeAmount?: number | null;
  epfEmployerAmount?: number | null;
  epfManualReason?: string | null;
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
  // Item 35524d1f — the same rule setIcProfileMY has carried since 55865c32: a BLANK IC is accepted and
  // stored as null; any NON-blank value stays strict 12-digit MyKad. This opened with a bare
  // `if (!isValidIC(...)) throw`, which rejected '' as well, so the Create Employee wizard failed at its last
  // step for anyone who entered a bank account or an EPF number but no Identity No — a field no step marks
  // required, and one item e3ce0d4d made optional precisely so passport holders could be hired. ic_number has
  // been nullable since 0212 and its (tenant_id, ic_number) uniqueness partial since 0214, so null rows coexist.
  const icRaw = (p.icNumber ?? '').trim();
  const icNumber = icRaw ? normalizeIC(icRaw) : null;
  if (icNumber !== null && !isValidIC(icNumber)) throw new InvalidICError();
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
    icNumber,
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
    // Item 70b14723 — the typed amounts + reason. `resolveEpfElection` has already nulled whatever the
    // chosen category does not use, exactly as it already nulls the rates, so this full-row overwrite
    // CLEARS a previous category's figures instead of leaving them for a future reader to apply.
    epfEmployeeAmount: epf.epfEmployeeAmount,
    epfEmployerAmount: epf.epfEmployerAmount,
    epfManualReason: epf.epfManualReason,
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
        // Item 70b14723 — the EPF election's BEFORE side. Read here (not derived, not guessed) so the event
        // below can carry a before/after for the mode, the rates and the typed amounts together.
        epfMode: employeeStatutoryMy.epfMode,
        epfEmployeeRate: employeeStatutoryMy.epfEmployeeRate,
        epfEmployerRate: employeeStatutoryMy.epfEmployerRate,
        epfEmployeeAmount: employeeStatutoryMy.epfEmployeeAmount,
        epfEmployerAmount: employeeStatutoryMy.epfEmployerAmount,
        epfManualReason: employeeStatutoryMy.epfManualReason,
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
        // AFTER-ONLY, AND KEPT. These three were the whole EPF record on this event before item 70b14723,
        // and `test/epf-modes.test.ts` pins them as the substrate-discipline claim; a reader of the event
        // stream would break if they moved. The reconstructable before/after lives in `epfElection` below —
        // added beside them rather than replacing them, the same "retire, never delete" rule the message
        // catalogues follow.
        epfMode: epf.epfMode,
        epfEmployeeRate: epf.epfEmployeeRate,
        epfEmployerRate: epf.epfEmployerRate,
        // ── Item 70b14723 — THE EPF ELECTION, BEFORE AND AFTER ─────────────────────────────────────────
        // The three keys above are after-only, so until now "was auto, now voluntary_excess at 15%" could
        // NOT be reconstructed from the log: the event recorded where the employee ended up and nothing
        // about where they started. That was tolerable while the election was a rate; it is not once it can
        // be a ringgit figure that decides a payslip. The typed amounts and the reason therefore land in a
        // proper before/after block — the shape `statutoryControls` beside this has always had — and the
        // mode and rates come WITH them rather than being described twice in two different ways.
        // Rates are decimal strings ('0.1500'); amounts are 2dp strings ('500.00'); both null when unset.
        epfElection: {
          before: existing
            ? {
                epfMode: existing.epfMode,
                epfEmployeeRate: existing.epfEmployeeRate,
                epfEmployerRate: existing.epfEmployerRate,
                epfEmployeeAmount: existing.epfEmployeeAmount,
                epfEmployerAmount: existing.epfEmployerAmount,
                epfManualReason: existing.epfManualReason,
              }
            : null,
          after: {
            epfMode: values.epfMode,
            epfEmployeeRate: values.epfEmployeeRate,
            epfEmployerRate: values.epfEmployerRate,
            epfEmployeeAmount: values.epfEmployeeAmount,
            epfEmployerAmount: values.epfEmployerAmount,
            epfManualReason: values.epfManualReason,
          },
        },
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

// ── Feedback 0df0c635 — Others Statutory card ──────────────────────────────────────────────────────────
/** Just the Others Statutory controls (feedback 0df0c635) — today only the per-employee "Subject to HRDF"
 *  checkbox. Used by the dedicated Others Statutory card on the Bank & Statutory tab, which saves
 *  independently of the full statutory row (like setTp3/setBank/setTax). */
export type OthersStatutoryInput = {
  personId: string;
  /** Tri-state stored value: explicit true/false = HR override; null clears back to "follow the company's
   *  HRDF registration default". The card's checkbox always submits an explicit true/false. */
  subjectToHrdf?: boolean | null;
};

/**
 * Feedback 0df0c635 — save ONLY the subject_to_hrdf column on employee_statutory_my, leaving the rest of
 * the statutory row (IC, EPF, SOCSO/EIS, tax, bank, TP3, zakat) untouched — the Others Statutory card is
 * its own partial-save card on the Bank & Statutory tab, exactly like setTp3ProfileMY/setBankProfileMY.
 * Requires an existing statutory row (the flag has no meaning before the identity row exists) — throws
 * NoStatutoryProfileError otherwise, so existing employee records remain unchanged until HR configures the
 * checkbox. Appends an `employee.others-statutory.updated` DomainEvent (before/after) per substrate
 * discipline, so an auditor can reconstruct who toggled HRDF subjectivity and when, from the log alone.
 */
export async function setOthersStatutoryMY(ctx: SessionContext, p: OthersStatutoryInput) {
  const subjectToHrdf = typeof p.subjectToHrdf === 'boolean' ? p.subjectToHrdf : null;
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: employeeStatutoryMy.id, subjectToHrdf: employeeStatutoryMy.subjectToHrdf })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, p.personId))
      .limit(1);
    if (!existing) throw new NoStatutoryProfileError();
    await tx
      .update(employeeStatutoryMy)
      .set({ subjectToHrdf, updatedAt: sql`now()` })
      .where(eq(employeeStatutoryMy.id, existing.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-statutory',
      aggregateId: existing.id,
      eventType: 'employee.others-statutory.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      // before/after of only the HRDF subjectivity flag — a config setting, not per-payslip cleartext pay,
      // so recording it is consistent with the sibling statutory setters (ADR-0030).
      payload: {
        personId: p.personId,
        before: { subjectToHrdf: existing.subjectToHrdf },
        after: { subjectToHrdf },
      },
    });
    return { id: existing.id };
  });
}

// ── Feedback 57840a6e — corrective step for accidental HRDF opt-outs ───────────────────────────────────
/** One row's verdict from correctAccidentalHrdfOptOutsMY. */
export type HrdfOptOutVerdict = {
  statutoryId: string;
  personId: string;
  /** reset_to_default = the No was written while the company was not_registered (the old checkbox's
   *  default capture) ⇒ provably accidental, cleared back to null. kept_explicit_no = written while the
   *  company WAS registered ⇒ HR actively unchecked a defaulted-ticked box, left alone. unclassified =
   *  no `employee.others-statutory.updated` write set it to false in the log, so nothing can be proven;
   *  reported for HR to confirm, never auto-changed. */
  verdict: 'reset_to_default' | 'kept_explicit_no' | 'unclassified';
  /** When the No was written (null when unclassified). */
  writtenAt: string | null;
  /** The company's HRDF band at that moment (null when unclassified). */
  companyHrdfStatusAtWrite: HrdfStatus | null;
};

/**
 * Feedback 57840a6e — repair the employees the OLD Others Statutory checkbox pinned to an explicit
 * "No" by accident. The checkbox rendered from the company's HRDF band, so while the company was
 * not_registered it showed UNCHECKED, and any save of that card (for any reason) wrote an explicit
 * false. Those rows then stay excluded from the HRD Corp levy for ever — hrdfSubject() honours an
 * explicit value over the company default — which is exactly the "HRDF not generated after payroll"
 * report. The forward fix (the tri-state select) only changes FUTURE saves; the already-poisoned rows
 * need this step.
 *
 * Deliberately NOT a blanket false → null flip: once stored, `false` alone cannot distinguish a
 * deliberate HR opt-out from the accidental default capture, and a blanket flip would silently
 * re-enrol staff HR genuinely meant to exclude. The DomainEvent log is the discriminator — for each
 * false row we find the write that set it (`employee.others-statutory.updated` with after = false) and
 * reconstruct the company's HRDF band at that instant from the `company.statutory.my.*` before/after
 * trail:
 *   • written while not_registered ⇒ the accidental default capture ⇒ reset to null (follow default);
 *   • written while mandatory/optional ⇒ HR actively said No ⇒ left untouched;
 *   • no such write in the log ⇒ unclassified, reported only.
 * Read-only by default (`apply` defaults to false) so an operator reviews the verdicts first, and safe
 * to run more than once — a corrected row is null, so it is no longer a candidate.
 *
 * Audit: every reset appends `employee.others-statutory.corrected` (before/after + why), so the
 * recalculated levy on the next payroll run is traceable to this step. Note the payslip snapshot only
 * stamps hrdfSubject when the stored value is non-null (core/payroll.ts), so a corrected employee's
 * NEXT slip legitimately drops that key — expected, not a snapshot violation.
 */
export async function correctAccidentalHrdfOptOutsMY(
  ctx: SessionContext,
  p: { companyId: string; apply?: boolean },
) {
  const apply = p.apply === true;
  return withTenant(ctx, async (tx) => {
    // 1. The company's HRDF band today + every audited change to it, oldest first.
    const [coStat] = await tx
      .select({ hrdfStatus: companyStatutoryMy.hrdfStatus })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, p.companyId))
      .limit(1);
    const currentStatus: HrdfStatus = coStat?.hrdfStatus ?? 'not_registered';
    const coEvents = await tx
      .select({ payload: domainEvent.payload, sequence: domainEvent.sequence })
      .from(domainEvent)
      .where(and(eq(domainEvent.tenantId, ctx.tenantId), eq(domainEvent.aggregateType, 'company-statutory-my')))
      .orderBy(asc(domainEvent.sequence));
    const timeline = coEvents
      .map((e) => ({
        seq: e.sequence,
        pl: e.payload as { companyId?: string; before?: { hrdfStatus?: HrdfStatus }; after?: { hrdfStatus?: HrdfStatus } } | null,
      }))
      .filter((x) => x.pl?.companyId === p.companyId && x.pl?.after?.hrdfStatus !== undefined)
      .map((x) => ({ seq: x.seq, before: x.pl!.before?.hrdfStatus ?? 'not_registered', after: x.pl!.after!.hrdfStatus! }));
    /** The company's band as of event `seq`. Ordering is by the log's own monotonic sequence, not by wall
     *  clock, so two writes in the same instant can never be judged out of order: the last change at-or-
     *  before seq wins; before the first recorded change the band was that change's `before`; with no
     *  recorded change it never moved off today's. */
    const statusAt = (seq: number): HrdfStatus => {
      if (timeline.length === 0) return currentStatus;
      let seen: HrdfStatus | null = null;
      for (const c of timeline) {
        if (c.seq <= seq) seen = c.after;
        else break;
      }
      return seen ?? timeline[0].before;
    };

    // 2. Candidates: explicit-false rows belonging to someone employed by this company.
    const candidates = await tx
      .selectDistinct({ id: employeeStatutoryMy.id, personId: employeeStatutoryMy.personId })
      .from(employeeStatutoryMy)
      .innerJoin(employment, eq(employment.personId, employeeStatutoryMy.personId))
      .where(and(eq(employment.companyId, p.companyId), eq(employeeStatutoryMy.subjectToHrdf, false)));

    const verdicts: HrdfOptOutVerdict[] = [];
    for (const row of candidates) {
      // The write that set this row to false — latest first, so a No re-affirmed later is judged by the
      // most recent decision (a Yes in between would have cleared the row from the candidate list anyway).
      const writes = await tx
        .select({ payload: domainEvent.payload, occurredAt: domainEvent.occurredAt, sequence: domainEvent.sequence })
        .from(domainEvent)
        .where(
          and(
            eq(domainEvent.tenantId, ctx.tenantId),
            eq(domainEvent.aggregateType, 'employee-statutory'),
            eq(domainEvent.aggregateId, row.id),
            eq(domainEvent.eventType, 'employee.others-statutory.updated'),
          ),
        )
        .orderBy(desc(domainEvent.sequence));
      const setter = writes.find((w) => (w.payload as { after?: { subjectToHrdf?: boolean | null } } | null)?.after?.subjectToHrdf === false);
      if (!setter) {
        verdicts.push({ statutoryId: row.id, personId: row.personId, verdict: 'unclassified', writtenAt: null, companyHrdfStatusAtWrite: null });
        continue;
      }
      const bandAtWrite = statusAt(setter.sequence);
      if (bandAtWrite !== 'not_registered') {
        verdicts.push({
          statutoryId: row.id,
          personId: row.personId,
          verdict: 'kept_explicit_no',
          writtenAt: setter.occurredAt.toISOString(),
          companyHrdfStatusAtWrite: bandAtWrite,
        });
        continue;
      }
      verdicts.push({
        statutoryId: row.id,
        personId: row.personId,
        verdict: 'reset_to_default',
        writtenAt: setter.occurredAt.toISOString(),
        companyHrdfStatusAtWrite: bandAtWrite,
      });
      if (!apply) continue;
      await tx
        .update(employeeStatutoryMy)
        .set({ subjectToHrdf: null, updatedAt: sql`now()` })
        .where(eq(employeeStatutoryMy.id, row.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'employee-statutory',
        aggregateId: row.id,
        eventType: 'employee.others-statutory.corrected',
        actor: actorOf(ctx),
        subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, row.personId),
        payload: {
          personId: row.personId,
          companyId: p.companyId,
          before: { subjectToHrdf: false },
          after: { subjectToHrdf: null },
          reason: 'accidental-hrdf-opt-out',
          writtenAt: setter.occurredAt.toISOString(),
          companyHrdfStatusAtWrite: bandAtWrite,
        },
      });
    }
    return {
      apply,
      scanned: candidates.length,
      corrected: verdicts.filter((v) => v.verdict === 'reset_to_default'),
      kept: verdicts.filter((v) => v.verdict === 'kept_explicit_no'),
      unclassified: verdicts.filter((v) => v.verdict === 'unclassified'),
    };
  });
}

// ── Item 8b5334db — Identification & Tax card ──────────────────────────────────────────────────────────
/** Tax residency status. resident ⇒ full computerised MTD; non_resident ⇒ flat 30% (spec §D.a); rep
 *  (Returning Expert Programme) + knowledge_worker (specific-region incentive, e.g. Iskandar) ⇒ flat 15%.
 *  Source: Income Tax (Exemption) orders / TalentCorp REP; both incentive schemes tax employment income at a
 *  annual incentive tax at 15% on chargeable income. HR confirms approval eligibility. */
export const TAX_RESIDENCIES = ['resident', 'non_resident', 'rep', 'knowledge_worker', 'c_suite'] as const;
export type TaxResidency = (typeof TAX_RESIDENCIES)[number];
export const isTaxResidency = (v: string): v is TaxResidency => (TAX_RESIDENCIES as readonly string[]).includes(v);

/** How the child relief is maintained.
 *  - 'manual'     — HR keys num_children; payroll applies children × perChild.
 *  - 'auto'       — num_children AND child_relief_table are both derived from the Family register on every
 *                   dependent write (syncChildReliefFromFamily). Payroll prices the DERIVED GRID when the
 *                   register can be priced by category at all — every eligible child classified — and falls
 *                   back to children × perChild when it cannot.
 *  - 'auto_table' — item d64d0df4. HR keys the LHDN s.48 CATEGORY GRID directly against the employee
 *                   (child_relief_table) and payroll works the deduction out category by category at the
 *                   official amount for each, halved for anyone recorded in the 50% column. num_children
 *                   is still maintained as the whole HEAD COUNT so Form E / CP8D / EA are unaffected.
 *                   This mode exists for the case where an employee's DECLARED relief differs from what
 *                   the Family tab holds.
 *
 *  ⚠️ THIS BLOCK USED TO END "Payroll still applies children × perChild" FOR 'auto', AND "Payroll always
 *  reads num_children as the head count regardless of mode". Both stopped being true at a5f21891 (r344),
 *  which taught the payslip, the PCB drill-down and the multicycle worksheet to price a DERIVED grid on
 *  'auto'. The sentence survived the round that falsified it, and core/dependents.ts cited THIS FILE as its
 *  authority for the claim — so one stale comment was propping up another. Corrected in r351.
 *
 *  What IS still true, and is what the citation actually needs: the three ANNUAL readers — Form E, CP8D and
 *  the EA statement — read num_children as a plain head count, which is why the derived weighting is never
 *  written to that column. The one gate every consumer asks is core/dependents.ts
 *  `pricesChildReliefFromGrid`; no consumer carries its own copy, and a test pins that. */
export const CHILD_RELIEF_MODES = ['manual', 'auto', 'auto_table'] as const;
export type ChildReliefMode = (typeof CHILD_RELIEF_MODES)[number];
export const isChildReliefMode = (v: string): v is ChildReliefMode => (CHILD_RELIEF_MODES as readonly string[]).includes(v);

/**
 * Item d64d0df4 — the stored shape of the 'auto_table' grid: per LHDN s.48 category, the count of
 * children claimed at 100% and the count claimed at 50%.
 */
export type ChildReliefTableCell = { full: number; half: number };
export type ChildReliefTable = Record<string, ChildReliefTableCell>;

/** The five LHDN s.48 categories the grid is keyed by — the SAME keys the Family register already uses
 *  per child (core/dependents.ts CHILD_RELIEF_CATEGORIES). Duplicated here rather than imported because
 *  a country pack must not depend on a core service module; the two lists are pinned equal by a test. */
export const CHILD_RELIEF_TABLE_KEYS = CHILD_RELIEF_CATEGORY_KEYS;

/**
 * Validate-and-normalise a keyed child-relief grid. Whole numbers ≥ 0 only; unknown keys are DROPPED
 * (never thrown on — a caller predating a future category must not be able to fail a save); a category
 * with nothing in it is dropped too, so an empty grid normalises to null rather than to five zero rows.
 * Returns null when there is nothing to store, which is exactly what "not configured" means on the column.
 */
export function normaliseChildReliefTable(input: unknown): ChildReliefTable | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: ChildReliefTable = {};
  for (const key of CHILD_RELIEF_TABLE_KEYS) {
    const cell = (input as Record<string, unknown>)[key];
    if (!cell || typeof cell !== 'object') continue;
    const c = cell as { full?: unknown; half?: unknown };
    const whole = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    };
    const full = whole(c.full);
    const half = whole(c.half);
    if (full === 0 && half === 0) continue;
    out[key] = { full, half };
  }
  return Object.keys(out).length > 0 ? out : null;
}

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
 * IC is a SEED of the statutory row, so unlike setTp3/setBank this UPSERTS: it creates the row when the person
 * has none yet. (It is no longer the row's notNull identity — the column has been nullable since 0212 and
 * setPassportProfileMY seeds a passport-identified row with no IC at all; that older claim has been corrected.)
 * Validates the IC (12 digits) and appends `employee.ic.updated`.
 * Persisting to the SAME column keeps setStatutoryAction's IC-derived SOCSO/EIS + EPF-number defaults working.
 *
 * Item 55865c32 — the Identity No (NRIC) field now shows for EVERY employee (the NRIC form is no longer hidden
 * for non-Malaysians), so a BLANK submit is reachable: it NO-OPS (`{ id: null }`) instead of throwing
 * InvalidICError — the NRIC is optional for a non-Malaysian who has none. Any NON-blank value stays
 * strict-MyKad: this field is specifically the Malaysian NRIC, not a free-form "other ID".
 */
export async function setIcProfileMY(
  ctx: SessionContext,
  p: { personId: string; icNumber: string; oldIcNumber?: string | null },
) {
  const ic = (p.icNumber ?? '').trim() ? normalizeIC(p.icNumber) : null;
  /**
   * e4b541c6 — the CP39's `No. K/P Lama`. FREE TEXT, and deliberately NOT put through `isValidIC`: the
   * pre-1990 card is not the 12-digit MyKad this file validates, so the validator would refuse every
   * genuine value. Trimmed, blanks become NULL, nothing else is enforced.
   */
  const oldIc = (p.oldIcNumber ?? '').trim() || null;
  // Unchanged: a blank NRIC no-ops. It now no-ops only when there is NOTHING to save — an employee with
  // no MyKad but an old card (or a correction that clears one) still has something to write.
  if (!ic && !oldIc) return { id: null };
  if (ic && !isValidIC(ic)) throw new InvalidICError();
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: employeeStatutoryMy.id, icNumber: employeeStatutoryMy.icNumber, oldIcNumber: employeeStatutoryMy.oldIcNumber })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, p.personId))
      .limit(1);
    let id: string;
    if (existing) {
      await tx
        .update(employeeStatutoryMy)
        // `ic ?? existing.icNumber` — a save that carries only the old card must not wipe the MyKad.
        .set({ icNumber: ic ?? existing.icNumber, oldIcNumber: oldIc, updatedAt: sql`now()` })
        .where(eq(employeeStatutoryMy.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await tx
        .insert(employeeStatutoryMy)
        .values({ tenantId: ctx.tenantId, personId: p.personId, icNumber: ic, oldIcNumber: oldIc })
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
      payload: {
        personId: p.personId,
        before: { icNumber: existing?.icNumber ?? null, oldIcNumber: existing?.oldIcNumber ?? null },
        after: { icNumber: ic ?? existing?.icNumber ?? null, oldIcNumber: oldIc },
      },
    });
    return { id };
  });
}

/** Item e3ce0d4d — an identity save was missing a mandatory passport field (number / issue / expiry). The
 *  trio is required for non-Malaysian employees, and required TOGETHER whenever any passport detail is
 *  entered (item 55865c32 — a partially-filled passport can never be saved); remark + issuing country are
 *  optional. Distinct message. */
export class PassportRequiredError extends Error {
  constructor() {
    super('Passport number, issue date and expiry date are required together (mandatory for a non-Malaysian employee).');
    this.name = 'PassportRequiredError';
  }
}

export type PassportInput = {
  personId: string;
  passportNumber?: string | null;
  passportIssueDate?: string | null;
  passportExpiryDate?: string | null;
  passportRemark?: string | null;
  // Item 55865c32 — the passport's issuing country (optional; free text from the international country picker).
  passportIssuingCountry?: string | null;
  /** e4b541c6 — ISO 3166-1 alpha-2 for the CP39's `Kod Negara`. Chosen by HR; never derived from the line
   *  above, which holds a nationality demonym. */
  passportIssuingCountryCode?: string | null;
};

/**
 * Item e3ce0d4d — save ONLY the passport identification columns on employee_statutory_my. The counterpart to
 * setIcProfileMY. Like the IC setter this UPSERTS (seeds the statutory row when the person has none), but
 * SKIPS the MyKad IC validation entirely and leaves ic_number null/untouched. Appends
 * `employee.passport.updated` (before/after) — passport is a government identity document, mirroring the IC
 * event's audit posture.
 *
 * Item 55865c32 — the Passport Information section now shows for EVERY employee, so requiredness is derived
 * from the person's stored nationality (SERVER-SIDE — the client's live selection is never trusted):
 *   • non-Malaysian → number + issue + expiry stay mandatory (their primary identification, as before);
 *   • Malaysian     → the passport is optional, but all-or-nothing: if ANY passport field is entered the trio
 *     must be complete (PassportRequiredError otherwise). An all-blank save CLEARS an existing passport block
 *     (audited before/after, same admin gate as every profile save) and NO-OPS (`{ id: null }`) when the
 *     person has no statutory row yet — nothing to clear, no empty row seeded.
 * Remark and issuing country are optional on every path.
 */
export async function setPassportProfileMY(ctx: SessionContext, p: PassportInput) {
  const number = (p.passportNumber ?? '').trim() || null;
  const issue = (p.passportIssueDate ?? '').trim() || null;
  const expiry = (p.passportExpiryDate ?? '').trim() || null;
  const remark = (p.passportRemark ?? '').trim() || null;
  const issuingCountry = (p.passportIssuingCountry ?? '').trim() || null;
  // e4b541c6 — the ISO alpha-2 the CP39's `Kod Negara` column wants. Uppercased because the column is a
  // CODE and a lowercase one would not match a statutory list; NOT derived from `issuingCountry`, which
  // holds a nationality demonym (see db/schema.ts and migration 0450).
  const issuingCountryCode = ((p.passportIssuingCountryCode ?? '').trim() || null)?.toUpperCase() ?? null;
  const anyFieldPresent = Boolean(number || issue || expiry || remark || issuingCountry || issuingCountryCode);
  const trioComplete = Boolean(number && issue && expiry);
  const values = {
    passportNumber: number,
    passportIssueDate: issue,
    passportExpiryDate: expiry,
    passportRemark: remark,
    passportIssuingCountry: issuingCountry,
    passportIssuingCountryCode: issuingCountryCode,
  };
  return withTenant(ctx, async (tx) => {
    // Nationality is derived from the person RECORD inside the same RLS tx — never from the caller.
    const [subject] = await tx
      .select({ nationality: person.nationality })
      .from(person)
      .where(eq(person.id, p.personId))
      .limit(1);
    const isMY = isMalaysianNationality(subject?.nationality);
    // Non-Malaysian primary identification: the trio is always mandatory. Malaysian: mandatory only when a
    // partial passport was entered (all-or-nothing). No MyKad IC validation runs on this path.
    if (!trioComplete && (!isMY || anyFieldPresent)) throw new PassportRequiredError();
    const [existing] = await tx
      .select({
        id: employeeStatutoryMy.id,
        passportNumber: employeeStatutoryMy.passportNumber,
        passportIssueDate: employeeStatutoryMy.passportIssueDate,
        passportExpiryDate: employeeStatutoryMy.passportExpiryDate,
        passportRemark: employeeStatutoryMy.passportRemark,
        passportIssuingCountry: employeeStatutoryMy.passportIssuingCountry,
        passportIssuingCountryCode: employeeStatutoryMy.passportIssuingCountryCode,
      })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, p.personId))
      .limit(1);
    // All-blank Malaysian save with no statutory row: nothing to clear — don't seed an empty row.
    if (!existing && !anyFieldPresent) return { id: null as string | null };
    let id: string;
    if (existing) {
      await tx
        .update(employeeStatutoryMy)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(employeeStatutoryMy.id, existing.id));
      id = existing.id;
    } else {
      // Seed the row with the passport identity and NO IC (ic_number stays null — the partial ic_uq lets many
      // rows coexist with a null IC).
      const [row] = await tx
        .insert(employeeStatutoryMy)
        .values({ tenantId: ctx.tenantId, personId: p.personId, ...values })
        .returning({ id: employeeStatutoryMy.id });
      id = row.id;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-statutory',
      aggregateId: id,
      eventType: 'employee.passport.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      // Passport is a government identity document — before/after so an auditor can reconstruct a correction
      // from the log alone, exactly like the sibling employee.ic.updated event.
      payload: {
        personId: p.personId,
        before: existing
          ? {
              passportNumber: existing.passportNumber,
              passportIssueDate: existing.passportIssueDate,
              passportExpiryDate: existing.passportExpiryDate,
              passportRemark: existing.passportRemark,
              passportIssuingCountry: existing.passportIssuingCountry,
              passportIssuingCountryCode: existing.passportIssuingCountryCode,
            }
          : null,
        after: values,
      },
    });
    return { id: id as string | null };
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
  /**
   * Item d64d0df4 — the employee is a registered disabled individual (OKU), which entitles them to a
   * FURTHER annual deduction in the PCB projection. This is the employee's CIRCUMSTANCE (tenant data);
   * the deduction AMOUNT is statutory and lives in the country pack's ruleset, never on this row.
   * Undefined ⇒ false, so a partial write cannot silently claim a relief nobody asked for.
   */
  disabledIndividual?: boolean;
  /**
   * Item d64d0df4 — the employee's SPOUSE is a registered disabled individual (OKU), entitling the
   * EMPLOYEE to a further deduction on top of the spouse deduction. Same separation as the field above:
   * the circumstance is tenant data, the AMOUNT is statutory and lives in the country pack's ruleset.
   * Like the spouse deduction it only moves the figure for tax category 2 (married, spouse not working).
   * Undefined ⇒ false, so a partial write cannot silently claim a relief nobody asked for.
   */
  disabledSpouse?: boolean;
  /**
   * Item d64d0df4 — the LHDN s.48 category grid, read by payroll ONLY in 'auto_table' mode. Passed
   * through `normaliseChildReliefTable` (whole numbers ≥ 0, unknown keys dropped, empty ⇒ null).
   * Undefined ⇒ null, matching the column's "not configured" state.
   */
  childReliefTable?: unknown;
  /**
   * R46 47146ea3 — write PROVENANCE, stamped onto the `employee.tax.updated` event payload so an auditor can
   * tell a machine-driven write from a human one. Absent (the default) ⇒ a human saved the Identity & Tax
   * form. 'auto_child_relief' ⇒ the num_children figure was derived from the Family/dependents register and
   * written without a human confirming it. This distinction is the whole reason the item was allowed to
   * relax the benefits-vs-tax firewall: the wall is replaced by traceability, so it must never be optional
   * on the automatic path. Does NOT change what is written — only how the event is labelled.
   */
  provenance?: TaxWriteProvenance;
};

/** R46 47146ea3 — who/what moved a tax figure. See TaxInput.provenance. */
export type TaxWriteProvenance = 'auto_child_relief';

/**
 * Partial update of ONLY the tax columns on employee_statutory_my (taxNumber, taxCategory, taxResidency +
 * synced isResident, numChildren, childReliefMode, employerBearsTax), leaving the rest of the row (IC, EPF,
 * SOCSO/EIS, bank, TP3, zakat) untouched — the Identification & Tax card was split out of the single full-row
 * statutory form (item 8b5334db), exactly like setTp3/setBank. Requires an existing statutory row (the IC seeds
 * it on the Profile tab) — throws NoIcYetError otherwise. isResident is kept in sync as the legacy source of
 * truth (all resident and approved resident incentive schemes ⇒ true; non-resident ⇒ false). Appends `employee.tax.updated` (before/after).
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
    // Approved incentive categories are resident. Explicit scheme owns their annual tax method.
    isResident: residency !== 'non_resident',
    employerBearsTax: p.employerBearsTax ?? false,
    // Item d64d0df4 — defaults to false, matching the column default, so an employee nobody has flagged
    // keeps today's PCB exactly and a caller that predates this field cannot claim the relief by omission.
    disabledIndividual: p.disabledIndividual ?? false,
    // Item d64d0df4 — both default to the "nothing claimed" state, matching the column defaults, so a
    // caller that predates these fields (the new-hire wizard, the bulk import, the zakat election path)
    // cannot claim a relief by omission and every existing employee keeps today's PCB exactly.
    disabledSpouse: p.disabledSpouse ?? false,
    childReliefTable: normaliseChildReliefTable(p.childReliefTable),
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
        disabledIndividual: employeeStatutoryMy.disabledIndividual,
        disabledSpouse: employeeStatutoryMy.disabledSpouse,
        childReliefTable: employeeStatutoryMy.childReliefTable,
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
              // d64d0df4 — a relief claim is exactly the kind of PCB input a compliance auditor has to be
              // able to reconstruct: it moves the employee's tax and it is a claim about a person.
              disabledIndividual: existing.disabledIndividual,
              // d64d0df4 — same reasoning: both are relief CLAIMS that move the employee's tax, so an
              // auditor has to be able to reconstruct them from the event log alone.
              disabledSpouse: existing.disabledSpouse,
              childReliefTable: existing.childReliefTable,
            }
          : null,
        after: values,
        // R46 47146ea3 — provenance. `auto: true` + a reason code ONLY on machine-driven writes; a human
        // save leaves both absent, so existing events and their readers are unchanged.
        ...(p.provenance ? { auto: true, provenance: p.provenance } : {}),
      },
    });
    return { id: existing.id };
  });
}

/**
 * 7ee14bbc — WHO ELSE IN THIS COMPANY IS FILED UNDER THE SAME INCOME TAX REFERENCE NUMBER.
 *
 * THE SAME WARNING AS THE CP39 PREVIEW'S, AT THE POINT THE NUMBER IS TYPED. The approved plan asks for
 * both halves in as many words — "a warning on the preview screen, before you print, when two employees
 * share a tax reference number" and "the same warning where the number is entered, so a duplicate is
 * caught at the point of typing rather than at filing time". Only the first half existed, so a duplicate
 * keyed today was discovered on the CP39 at filing time, which is the failure the second half names.
 * On the reporter's own records five numbers are each filed against two or three different people.
 *
 * ⚠️ OTHER PEOPLE, NOT OTHER EMPLOYMENTS. The row is keyed on `person_id`
 * (`employee_statutory_my_person_uq`), so one person holding two concurrent employments in this company
 * has ONE tax record, not two — `ne(person_id)` is what keeps this from reporting somebody as sharing a
 * number with themselves, which is exactly the false alarm the preview banner had to be fixed for.
 *
 * ADVISORY, and it can only ever be advisory: it is a read. The save is not gated on it — LHDN, not us,
 * decides whose number is right, and a screen that refused the save would leave HR unable to record
 * what the employee's own EA form says while a support ticket is open.
 *
 * SCOPED TO ONE COMPANY because that is the scope of the CP39 this warning exists to protect, and RLS
 * scopes the whole query to the tenant on top of it. A blank number is not a duplicate (that is the
 * missing-number gate's business) and returns [] without querying.
 */
export function taxNumberSharedWithMY(
  ctx: SessionContext,
  p: { personId: string; companyId: string; taxNumber: string | null | undefined },
): Promise<string[]> {
  const wanted = (p.taxNumber ?? '').trim();
  if (!wanted) return Promise.resolve([]);
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .selectDistinct({ personId: person.id, name: person.fullName })
      .from(employeeStatutoryMy)
      .innerJoin(person, eq(person.id, employeeStatutoryMy.personId))
      .innerJoin(employment, eq(employment.personId, employeeStatutoryMy.personId))
      .where(
        and(
          eq(employment.companyId, p.companyId),
          ne(employeeStatutoryMy.personId, p.personId),
          // Trimmed and case-folded on BOTH sides: `sg90010101` and `SG90010101 ` are one number to
          // LHDN, and a comparison that missed that would miss the pair it was written to catch. Same
          // rule as `duplicateCp39TaxNumbers`, which is what makes the two warnings agree.
          eq(sql`upper(trim(${employeeStatutoryMy.taxNumber}))`, wanted.toUpperCase()),
        ),
      )
      .orderBy(asc(person.fullName));
    return rows.map((r) => r.name);
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
