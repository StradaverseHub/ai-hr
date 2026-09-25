/**
 * LHDN TP3 (1/2026) — the PREVIOUS-EMPLOYMENT record (item df35d60d; item 1bb09a73 joined it to PCB).
 *
 * ══ WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ═══════════════════════════════════════════════════
 *
 * A new employee who worked elsewhere earlier in the same year hands their new employer a TP3: who they
 * worked for, what that employment paid them, what was exempt, what EPF and zakat came off it, what PCB
 * was already deducted, and which reliefs they already claimed through that employer. This file is the
 * one service that reads and writes that record.
 *
 * ⚠️ IT NOW MOVES TAX — item 1bb09a73, and this is STAGE 2 of the boundary stage 1 wrote down.
 *
 * `core/payroll.ts` seeds the PCB accumulators from `employee_statutory_my.tp3_*` — `tp3Applies =
 * e.tp3Year === pYear`, then netRemuneration / epfClaimed / pcbPaid / zakatPaid / lp, LHDN's ∑(Y−K), K,
 * X, Z and ∑LP. ⚠️ ∑LP IS NEW IN ITEM 20837372 and it is the reason to re-read this header: stage 2 of
 * item 1bb09a73 wired three of the four variables the specification's printed page 22 names, SECTION D
 * was the missing fourth, and a new joiner who declared their previous employer's reliefs was deducted
 * MORE than they owed because ∑LP is subtracted inside P. Migration 0488 adds the column and backfills
 * it. Stage 1 wrote the form into `employee_tp3` and stopped, so the figures HR keyed off the paper form
 * reached nothing: production carried ONE `employee_tp3` row (person b57268ae) and ONE statutory row
 * with a `tp3_year` (person d4ef0b58) — two stores holding DIFFERENT PEOPLE, a form-filler contributing
 * nothing to payroll and payroll figures with no form behind them. `saveTp3` now writes both.
 *
 * ══ WHICH SIDE OWNS THE ACCUMULATOR SEED — THE DECISION STAGE 1 DEFERRED ════════════════════════════
 *
 * THE FORM OWNS IT FOR A PERSON-YEAR THAT HAS A FORM. `employee_tp3.payload` is the authoritative record
 * and the five columns become its DERIVED PROJECTION for that person; for a person with NO form they
 * stay exactly what they are today, a hand-keyed opening balance (migration / pre-system months) that
 * nothing here touches. That is the only reading that leaves one authoritative owner per fact
 * (CLAUDE.md §1) without taking the migration case away from HR.
 *
 * THE COLUMNS HOLD ONE YEAR AND THE FORM TABLE HOLDS MANY, so the projection is CONDITIONAL: a form for
 * assessment year Y writes the columns only when the stored `tp3_year` is absent or is Y or EARLIER.
 * Recording a 2025 form after 2026's figures are in place must never demote the year the PCB kernel
 * matches on — that is a statutory regression with no error message, and `test/df35d60d-tp3-form.test.ts`
 * has pinned exactly that ordering since stage 1. The save still succeeds (the form is a real record);
 * it reports `applied: false` and the screen says which year holds the columns, so nothing is silent.
 *
 * ══ THE OVERLAP IS STILL SHOWN, BECAUSE A LATER HAND EDIT IS STILL ALLOWED ══════════════════════════
 *
 * `deriveAccumulatorSeed` computes the seed from the form's own boxes — (C1 − ΣC2) − C3, C3, C5, C4(i)
 * and, since item 20837372, ∑D1…D17 — and it is the ONE place that mapping exists: the reconciliation strip on the screen and the write below
 * read the same function, so the figure an operator is shown is the figure that lands. The Payroll tab's
 * `setTp3Action` still edits the columns by hand afterwards and this file does not fight it; the strip
 * shows the difference. What is NOT tolerated is the YEAR diverging, which `core/payroll.ts` refuses at
 * the pre-processing gate rather than seeding a silent zero onto a statutory deduction.
 *
 * ══ THE TAXONOMY IS THE TP1'S, READ FOR A DIFFERENT EMPLOYER ════════════════════════════════════════
 *
 * ⚠️ AND SINCE ITEM 20837372 THAT SHARED TAXONOMY IS LOAD-BEARING ON THE MONEY PATH, not only on the
 * two screens: Section D's total becomes ∑LP, the same variable this employer's own TP1 declarations
 * feed month by month through `payslip.statutory.lp`. The specification's own definition is what makes
 * one variable carry both — printed page 11: "∑LP  Accumulated allowable deductions in the current
 * year, including from previous employment, if any".
 *
 * `TP3_SECTION_D` is the pack's `tp3Catalogue.sectionD`, which is the SAME ARRAY OBJECT as
 * `taxReliefCatalogue.items` — the seventeen reliefs the TP1 calls C1–C17 and the TP3 calls D1–D17, with
 * the same limits and the same lettered sub-lines. Section D amounts are stored in EXACTLY the shape
 * `tp1_relief.categories.items` uses, so one payload type describes both and a limit that moves moves in
 * one place. `test/df35d60d-tp3-form.test.ts` asserts the identity, so a copy fails the suite.
 *
 * TYPED STRUCTURALLY OFF THE PACK CONTRACT, never by importing the MY module — a core/ file that names a
 * pack implementation is the R55 mistake ADR-0080 rung 5a undid (the reasoning core/tax-relief.ts
 * records over TP1_ITEMS applies here verbatim).
 *
 * ══ AUTHORIZATION ═══════════════════════════════════════════════════════════════════════════════════
 *
 * READS are `app.can_see_person` (self + admin) at the database. WRITES are admin-only in BOTH places:
 * `requireAdminTarget` here and `WITH CHECK app.is_admin()` in migration 0480. HR keys this from the
 * paper form the employee hands in; an employee does not self-declare a previous employer's figures.
 */
import { and, eq } from 'drizzle-orm';
import { type SessionContext, type Tx } from '../db/client';
// ADR-0077 D3 SERVICE GATE — the same binding core/tax-relief.ts uses and for the same reason: a
// `layout.tsx` covers a RENDER and covers no server action, so the module check belongs on the service.
import { withPayrollTenant as withTenant } from './module-gate';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../db/events';
import { isAdmin } from '../lib/authz';
import {
  employeeStatutoryMy,
  employeeTp3,
  person,
  type Tp1ItemAmounts,
  type Tp3Payload,
  type Tp3PreviousEmployer,
} from '../db/schema';
import { countryPacks } from '../localization/registry';

/** Every refusal this service raises. Callers render `.message` — it is written to be read by HR. */
export class Tp3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Tp3Error';
  }
}

// ── The catalogue, from the pack ────────────────────────────────────────────────────────────────────

type Tp3Catalogue = NonNullable<ReturnType<typeof countryPacks>[number]['payroll']['tp3Catalogue']>;
export type Tp3MoneyLine = Tp3Catalogue['sectionC'][number];
export type Tp3ReliefItem = Tp3Catalogue['sectionD'][number];

/** The registered packs that HAVE a previous-employment form. Empty ⇒ the whole surface is absent. */
function tp3Packs(): Tp3Catalogue[] {
  return countryPacks()
    .map((p) => p.payroll.tp3Catalogue)
    .filter((c): c is Tp3Catalogue => c != null);
}

function mergeByCode<T extends { code: string }>(lists: readonly (readonly T[])[]): readonly T[] {
  const byCode = new Map<string, T>();
  for (const list of lists) for (const item of list) if (!byCode.has(item.code)) byCode.set(item.code, item);
  return [...byCode.values()];
}

/**
 * Section C — the previous employment's accumulated money lines (C1–C5). TP3's OWN, with no TP1
 * counterpart: they are what makes the form fillable, because the stored (Y−K) is not invertible.
 */
export const TP3_SECTION_C: readonly Tp3MoneyLine[] = mergeByCode(tp3Packs().map((c) => c.sectionC));
/**
 * Section D — THE SHARED RELIEF SCHEDULE. Identity-equal to `TP1_ITEMS` when one pack is registered,
 * which is the property `test/df35d60d-tp3-form.test.ts` pins.
 */
export const TP3_SECTION_D: readonly Tp3ReliefItem[] = mergeByCode(tp3Packs().map((c) => c.sectionD));
/** The agency's own revision string for the form these lines came from — printed on the PDF. */
export const TP3_FORM_CODE: string = tp3Packs()[0]?.formCode ?? 'TP3';
/** How many previous employers the printed form is RULED FOR. MY: two (A1/A2 and A3/A4). */
export const TP3_MAX_EMPLOYERS: number = tp3Packs()[0]?.maxEmployers ?? 0;

/**
 * The line number the TP3 prints against a shared-schedule item — `c1` → 1, drawn as "D1".
 *
 * DERIVED FROM POSITION IN THE SHARED SCHEDULE, never from parsing the code: an item inserted into the
 * schedule renumbers both forms together, instead of only the one whose renderer somebody remembered.
 */
export function tp3LineNumber(code: string): number | null {
  const i = TP3_SECTION_D.findIndex((x) => x.code === code);
  return i < 0 ? null : i + 1;
}

// ── Validation ──────────────────────────────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Same ceiling core/tax-relief.ts applies to a TP1 total — a typo, not a tax policy. */
const TP3_MAX_AMOUNT = 10_000_000;
const NAME_MAX = 200;
const TIN_MAX = 40;
const REMARKS_MAX = 2000;

function validateAmount(raw: unknown, label: string, cap?: number): number {
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Tp3Error(`${label} must be a number.`);
  if (n < 0) throw new Tp3Error(`${label} must not be negative.`);
  const v = round2(n);
  if (v > TP3_MAX_AMOUNT) throw new Tp3Error(`${label} is implausibly large.`);
  // A sourced sub-limit the agency's own form prints. ADR-0008: an item with no printed cap is captured
  // and never blocked — we do not invent one to have something to check.
  if (cap != null && v > cap) {
    throw new Tp3Error(`${label} must not exceed its limit of RM ${cap.toFixed(2)}.`);
  }
  return v;
}

/** 1–12, or null. The form's DEDUCTION MONTH box; null is "left blank", never January. */
function validateMonth(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const m = Math.trunc(Number(raw));
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Tp3Error('Deduction month must be between 1 and 12.');
  return m;
}

function validateYear(raw: unknown): number {
  const y = Math.trunc(Number(raw));
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new Tp3Error('Assessment year must be between 2000 and 2100.');
  return y;
}

/**
 * Section A. Blank pairs are DROPPED, not stored as empty employers — an absent box asserts nothing, and
 * a row of `{name: '', tin: ''}` would print an empty-named employer onto a statutory form.
 *
 * A TIN with no name is a REFUSAL rather than a silent drop: it is the one combination that means the
 * operator keyed something and it did not land.
 *
 * MORE THAN THE FORM IS RULED FOR IS ALSO A REFUSAL, quoting the form's own footnote. Silently keeping
 * the first two would print a TP3 that omits an employer nobody was told about.
 */
function validateEmployers(raw: unknown): Tp3PreviousEmployer[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: Tp3PreviousEmployer[] = [];
  for (const [i, e] of list.entries()) {
    const src = (e ?? {}) as { name?: unknown; tin?: unknown };
    const name = String(src.name ?? '').trim();
    const tin = String(src.tin ?? '').trim();
    if (name === '' && tin === '') continue;
    if (name === '') throw new Tp3Error(`Previous employer ${i + 1} has a tax reference number but no name.`);
    if (name.length > NAME_MAX) throw new Tp3Error(`Previous employer ${i + 1}'s name is too long.`);
    if (tin.length > TIN_MAX) throw new Tp3Error(`Previous employer ${i + 1}'s tax reference number is too long.`);
    out.push({ name, tin: tin === '' ? null : tin });
  }
  if (out.length > TP3_MAX_EMPLOYERS) {
    throw new Tp3Error(
      `Form TP3 is ruled for ${TP3_MAX_EMPLOYERS} previous employers. The form's own note says to use an additional attachment for the next employment.`,
    );
  }
  return out;
}

type RawGroup = Record<string, { amount?: unknown; subItems?: Record<string, unknown> } | undefined>;

/**
 * Read one lettered/numbered group against its catalogue definition. IDENTICAL in shape and in rules to
 * `validateCatalogueCategories` in core/tax-relief.ts, deliberately: Section D is the same taxonomy, so
 * a figure that would be refused on a TP1 is refused here, and an item's amount is ALWAYS the server's
 * sum of its sub-lines. The client never sends a total, at any level.
 */
function readGroup(
  defs: readonly { code: string; limit?: number | null; perSubLimit?: boolean; subItems: readonly { code: string; limit?: number | null }[] }[],
  source: RawGroup,
  prefix: string,
): { out: Record<string, Tp1ItemAmounts>; total: number } {
  const out: Record<string, Tp1ItemAmounts> = {};
  let total = 0;
  for (const def of defs) {
    const entry = source[def.code] ?? {};
    const label = `${prefix}${def.code.replace(/^c/, '').toUpperCase()}`;
    let amount: number;
    let subItems: Record<string, number> | undefined;
    if (def.subItems.length > 0) {
      const subs: Record<string, number> = {};
      let sum = 0;
      for (const sub of def.subItems) {
        const v = validateAmount((entry.subItems ?? {})[sub.code], `${label}(${sub.code})`, sub.limit ?? undefined);
        if (v > 0) subs[sub.code] = v;
        sum += v;
      }
      amount = round2(sum);
      if (Object.keys(subs).length > 0) subItems = subs;
    } else {
      amount = validateAmount(entry.amount, label);
    }
    // The group ANNUAL LIMIT column. A `perSubLimit` item (D16 — the two house-price bands) has none:
    // the form gives each band its own limit AND its own accumulated box, so they are two claims.
    if (def.limit != null && !def.perSubLimit && amount > def.limit) {
      throw new Tp3Error(`${label} must not exceed its annual limit of RM ${def.limit.toFixed(2)}.`);
    }
    out[def.code] = subItems ? { amount, subItems } : { amount };
    total = round2(total + amount);
  }
  return { out, total };
}

/** What a caller hands `saveTp3`. Every figure is a box on the paper form; nothing is a total. */
export type Tp3WriteInput = {
  /** Admin-only, and required: HR keys this ON BEHALF OF somebody. */
  personId: string;
  assessmentYear: number;
  deductionMonth?: number | null;
  previousEmployers?: unknown;
  sectionC?: RawGroup;
  sectionD?: RawGroup;
  declarationAccepted?: boolean;
  remarks?: unknown;
};

function readRemarks(raw: unknown): string | null {
  if (raw == null || String(raw).trim() === '') return null;
  const r = String(raw).trim();
  if (r.length > REMARKS_MAX) throw new Tp3Error(`Remarks must be at most ${REMARKS_MAX} characters.`);
  return r;
}

// ── The derived accumulator seed — the bridge, and it is read-only ──────────────────────────────────

/**
 * The PCB accumulator seed, computed from the form's own boxes.
 *
 * ⚠️ THE ONE PLACE THE SECTION-LINE → PAYROLL-COLUMN MAPPING EXISTS (item 1bb09a73). The reconciliation
 * strip on the TP3 screen prints it, `saveTp3` writes it into `employee_statutory_my`, and the payroll
 * pre-processing gate re-derives it to decide whether a run is about to drop a declared figure. One
 * function, three readers: the figure the operator is shown is the figure the PCB calculation uses.
 * A second transcription of these four lines is the competing source of truth CLAUDE.md §1 forbids.
 *
 * ⚠️ READ OFF THE FORM'S OWN DEFINITION, NEVER GUESSED FROM THE COLUMN NAMES. Every line below is named
 * by `MY_TP3_2026_SECTION_C` in `localization/my/statutory-tables.ts` (C1 "is LHDN's Y before anything is
 * taken off it"; C3 "is LHDN's K"; C4(i) "Total Zakat", and its comment says why it is NOT the TP1's
 * rebate line; C5 "is LHDN's X", excluding CP38) and printed in those words on the form itself
 * (`messages/*.json` → `taxRelief.tp3.money`). C4(ii) — the Umrah / religious-travel departure levy — is
 * a RELIEF and not zakat, so it is deliberately not part of Z.
 *
 * The arithmetic is LHDN's own, and it is the arithmetic that could not be run backwards:
 *
 *     netRemuneration (∑(Y − K)) = C1 − (C2i + C2ii + C2iii + C2iv + C2v) − C3
 *     epfClaimed      (K)        = C3
 *     pcbPaid         (X)        = C5          (the form's own "excluding CP38")
 *     zakatPaid       (Z)        = C4(i)
 *
 * NEGATIVE IS RETURNED AS NEGATIVE, not clamped to zero. A negative (Y − K) means the exempt and EPF
 * boxes exceed the gross box, which is a keying error the operator must see — clamping it would hide the
 * one thing this function exists to surface.
 */
export type Tp3AccumulatorSeed = {
  netRemuneration: number;
  epfClaimed: number;
  pcbPaid: number;
  zakatPaid: number;
  /**
   * ∑LP — the total of SECTION D (D1–D17), the reliefs already claimed through the previous employer.
   *
   * ⚠️ ADDED BY ITEM 20837372, AND IT IS THE FOURTH OF THE FOUR VARIABLES THE SPECIFICATION NAMES.
   * Printed page 22 of `spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf`, item 10, verbatim: "The
   * information amount from the TP3 Form shall be treated in the formula as variable (Y–K*), X, Z and
   * ∑LP." Until this round only the first three existed here and Section D reached nothing at all.
   *
   * SUMMED FROM THE ITEM AMOUNTS, never from a client total: `readGroup` already made each item's
   * `amount` the server's own sum of its sub-lines and already refused anything over that item's
   * printed annual limit, so this total cannot exceed what Section D is allowed to carry.
   */
  lpDeclared: number;
  /** ΣC2 — shown in its own right, because it is the figure the old single column swallowed. */
  exemptTotal: number;
  /** C1 — the gross before anything comes off it. */
  gross: number;
};

export function deriveAccumulatorSeed(payload: Tp3Payload | null | undefined): Tp3AccumulatorSeed | null {
  if (!payload || payload.form !== 'tp3-2026') return null;
  const c = payload.sectionC ?? {};
  const gross = Number(c.c1?.amount ?? 0);
  const exemptTotal = Number(c.c2?.amount ?? 0);
  const epfClaimed = Number(c.c3?.amount ?? 0);
  const pcbPaid = Number(c.c5?.amount ?? 0);
  const zakatPaid = Number(c.c4?.subItems?.i ?? 0);
  // ∑LP — Section D, item 20837372. OVER THE CATALOGUE, not over the payload's own keys: a stored
  // payload written before an item left the schedule would otherwise keep contributing to a statutory
  // deduction through a line the form no longer has. TP3_SECTION_D is the same array the save validated
  // against, so what is summed here is exactly what the screen showed and the form printed.
  const lpDeclared = round2(
    TP3_SECTION_D.reduce((sum, item) => sum + Number((payload.sectionD ?? {})[item.code]?.amount ?? 0), 0),
  );
  return {
    gross,
    exemptTotal,
    epfClaimed,
    pcbPaid,
    zakatPaid,
    lpDeclared,
    netRemuneration: round2(gross - exemptTotal - epfClaimed),
  };
}

/**
 * The C2 sub-lines whose keyed figure is ABOVE the statutory exemption limit for that line (item
 * 20837372). Empty when every box is within its limit, or when no limit is sourced for it.
 *
 * ⚠️ IT REPORTS; IT NEVER CAPS AND IT NEVER REFUSES, and the reason is the form itself. TP3 Section C
 * prints ONE money column and no limit column (verified on the agency's own Exhibit 2, printed page 39,
 * and on the standalone `bm-borang-tp3-2026.pdf`), so ADR-0008's "an item with no printed cap is
 * captured and never blocked" decides it. Beyond that, the specification's printed page 20 item 9 says
 * of the exemption limits "Any amount exceed the restricted amount shall be taxable" — addressed to the
 * employer running the payroll, which for a TP3 is the PREVIOUS employer. The over-limit part is
 * therefore already sitting in C1 as taxable pay by the time the form is filled in, and capping C2 here
 * would tax the same ringgit twice. A figure over the limit means the FORM was filled wrong; the
 * operator fixes the form, and this is what tells them to.
 */
export type Tp3ExemptionOverLimit = {
  /** 'c2' — the Section C line. */
  code: string;
  /** 'i' | 'ii' | 'iv' — the roman sub-line the form prints. */
  subCode: string;
  amount: number;
  limit: number;
  /** amount − limit, the figure to name in the warning. */
  excess: number;
};

export function tp3ExemptionOverLimits(payload: Tp3Payload | null | undefined): Tp3ExemptionOverLimit[] {
  if (!payload || payload.form !== 'tp3-2026') return [];
  const out: Tp3ExemptionOverLimit[] = [];
  for (const line of TP3_SECTION_C) {
    const stored = (payload.sectionC ?? {})[line.code];
    for (const sub of line.subItems) {
      const limit = sub.exemptionLimit;
      if (limit == null) continue; // no sourced limit — nothing to compare against, and none is invented
      const amount = Number(stored?.subItems?.[sub.code] ?? 0);
      if (amount > limit) out.push({ code: line.code, subCode: sub.code, amount, limit, excess: round2(amount - limit) });
    }
  }
  return out;
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────────

export type Tp3Record = {
  id: string;
  personId: string;
  assessmentYear: number;
  deductionMonth: number | null;
  previousEmployers: Tp3PreviousEmployer[];
  payload: Tp3Payload | null;
  declaredAt: Date | null;
  remarks: string | null;
  updatedAt: Date;
};

function requireAdminTarget(ctx: SessionContext, personId: string | null | undefined): string {
  if (!isAdmin(ctx)) throw new Tp3Error('Only an administrator can maintain a TP3 record.');
  const id = personId ?? null;
  if (!id) throw new Tp3Error('No employee selected.');
  return id;
}

/**
 * ONE person's TP3 for ONE assessment year, or null.
 *
 * Reachable by the employee for their OWN row (RLS is `app.can_see_person`), which is why this takes no
 * admin check: the database decides who a row is visible to, and a self-read of one's own TP3 is exactly
 * what `/me` would need. Writes are admin-only in both places.
 */
export function getTp3ForPersonYear(
  ctx: SessionContext,
  p: { personId: string; assessmentYear: number },
): Promise<Tp3Record | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(employeeTp3)
      .where(and(eq(employeeTp3.personId, p.personId), eq(employeeTp3.assessmentYear, p.assessmentYear)))
      .limit(1);
    return row ? toRecord(row) : null;
  });
}

type Row = typeof employeeTp3.$inferSelect;
const toRecord = (r: Row): Tp3Record => ({
  id: r.id,
  personId: r.personId,
  assessmentYear: r.assessmentYear,
  deductionMonth: r.deductionMonth,
  previousEmployers: r.previousEmployers ?? [],
  payload: r.payload,
  declaredAt: r.declaredAt,
  remarks: r.remarks,
  updatedAt: r.updatedAt,
});

/**
 * Every assessment year this person has a TP3 record for, newest first.
 *
 * ORDERED IN THE QUERY. An asserted array from a query needs an ORDER BY (CLAUDE.md §8), and "the years
 * with a record" is read straight into a selector.
 */
export function listTp3YearsForPerson(ctx: SessionContext, p: { personId: string }): Promise<number[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ y: employeeTp3.assessmentYear })
      .from(employeeTp3)
      .where(eq(employeeTp3.personId, p.personId))
      .orderBy(employeeTp3.assessmentYear);
    return rows.map((r) => r.y).sort((a, b) => b - a);
  });
}

/**
 * The B1–B3 identity the form prints, and the five stored accumulator columns the screen reconciles
 * against. ONE read rather than two, because the screen always wants both together.
 *
 * ⚠️ THE STORED COLUMNS ARE RETURNED AS-READ. They are the PCB kernel's input, and since item 1bb09a73
 * `saveTp3` PROJECTS this form's Section C onto them (see the file header) — so the strip that renders
 * this now shows, for the form's own year, what the tax calculation will actually use. It still reads
 * them rather than re-deriving them, which is what makes a later hand edit visible instead of hidden.
 */
export type Tp3Identity = {
  employee: { name: string; idNumber: string | null; tin: string | null };
  stored: {
    tp3Year: number | null;
    netRemuneration: number | null;
    epfClaimed: number | null;
    pcbPaid: number | null;
    zakatPaid: number | null;
    /** ∑LP — Section D's projection (item 20837372). Null = none recorded, which the kernel reads as 0. */
    lp: number | null;
  };
};

export function getTp3Identity(ctx: SessionContext, p: { personId: string }): Promise<Tp3Identity> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        name: person.fullName,
        ic: employeeStatutoryMy.icNumber,
        passport: employeeStatutoryMy.passportNumber,
        tin: employeeStatutoryMy.taxNumber,
        tp3Year: employeeStatutoryMy.tp3Year,
        net: employeeStatutoryMy.tp3NetRemuneration,
        epf: employeeStatutoryMy.tp3EpfClaimed,
        pcb: employeeStatutoryMy.tp3PcbPaid,
        zakat: employeeStatutoryMy.tp3ZakatPaid,
        lp: employeeStatutoryMy.tp3Lp,
      })
      .from(person)
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, person.id))
      .where(eq(person.id, p.personId))
      .limit(1);
    const num = (v: string | null | undefined) => (v == null ? null : Number(v));
    return {
      employee: {
        name: row?.name ?? '',
        // IC first, passport second — the form's own box is "Identity Card/Passport Number", and a
        // Malaysian is identified by the IC. Null when neither is on file: the printed box stays blank,
        // because an absent box asserts nothing and an invented identity number is not an option.
        idNumber: row?.ic ?? row?.passport ?? null,
        tin: row?.tin ?? null,
      },
      stored: {
        tp3Year: row?.tp3Year ?? null,
        netRemuneration: num(row?.net),
        epfClaimed: num(row?.epf),
        pcbPaid: num(row?.pcb),
        zakatPaid: num(row?.zakat),
        lp: num(row?.lp),
      },
    };
  });
}

// ── The write ───────────────────────────────────────────────────────────────────────────────────────

/**
 * What the save did to the four figures the payroll run reads. Returned so the caller can SAY so: a
 * projection that quietly did not happen is the defect this item exists to remove, one level up.
 */
export type Tp3SeedOutcome =
  /** The four columns and `tp3_year` now hold this form's figures. */
  | { applied: true; seed: Tp3AccumulatorSeed }
  /** A LATER assessment year holds the columns; this form is recorded and the columns are untouched. */
  | { applied: false; reason: 'laterYearHoldsColumns'; heldBy: number }
  /** The person has no `employee_statutory_my` row, and this form asserts no money to put in one. */
  | { applied: false; reason: 'noStatutoryProfile' };

/**
 * `employee_statutory_my` is UNIQUE ON `person_id` (`employee_statutory_my_person_uq`), so the four
 * figures are a PERSON-level fact and always have been — `core/payroll.ts` joins
 * employment → person → this row, and a person holding two concurrent employments already seeds both
 * runs from the one row. This projection inherits that grain and changes nothing about it; it is stated
 * here because writing the columns from a person-keyed form makes it look like a new decision. It is
 * not, and a per-employment previous-employment balance would need a new column before it could be one.
 */
async function projectSeedOntoStatutory(
  tx: Tx,
  ctx: SessionContext,
  p: { personId: string; assessmentYear: number; seed: Tp3AccumulatorSeed },
): Promise<Tp3SeedOutcome> {
  const [stat] = await tx
    .select({
      id: employeeStatutoryMy.id,
      tp3Year: employeeStatutoryMy.tp3Year,
      net: employeeStatutoryMy.tp3NetRemuneration,
      epf: employeeStatutoryMy.tp3EpfClaimed,
      pcb: employeeStatutoryMy.tp3PcbPaid,
      zakat: employeeStatutoryMy.tp3ZakatPaid,
      lp: employeeStatutoryMy.tp3Lp,
    })
    .from(employeeStatutoryMy)
    .where(eq(employeeStatutoryMy.personId, p.personId))
    .limit(1);

  // NO ROW TO PROJECT INTO. Refusing (and rolling the form back with it) rather than creating a bare one:
  // an `employee_statutory_my` row is what `preProcessChecksTx` reads as "this employee HAS a statutory
  // profile", so inserting an empty one here would silence a real readiness warning on the payroll run.
  // A form whose money cannot reach the calculation must not save quietly — that is the whole defect.
  throwIfNowhereToLand(stat, p.seed);
  if (!stat) return { applied: false, reason: 'noStatutoryProfile' };

  // A LATER year holds the columns. See the file header: demoting `tp3_year` is a statutory regression
  // with no error message, so the form is kept and the projection is REPORTED as not applied.
  if (stat.tp3Year != null && stat.tp3Year > p.assessmentYear) {
    return { applied: false, reason: 'laterYearHoldsColumns', heldBy: stat.tp3Year };
  }

  const money = (n: number) => n.toFixed(2);
  const after = {
    tp3Year: p.assessmentYear,
    tp3NetRemuneration: money(p.seed.netRemuneration),
    tp3EpfClaimed: money(p.seed.epfClaimed),
    tp3PcbPaid: money(p.seed.pcbPaid),
    tp3ZakatPaid: money(p.seed.zakatPaid),
    // ∑LP — Section D (item 20837372). Written in the SAME statement as the other four and governed by
    // the SAME `tp3_year`, so the five can never describe different forms.
    tp3Lp: money(p.seed.lpDeclared),
  };
  await tx
    .update(employeeStatutoryMy)
    .set({ ...after, updatedAt: new Date() })
    .where(eq(employeeStatutoryMy.id, stat.id));

  // THE SAME EVENT TYPE THE HAND PATH EMITS (`setTp3ProfileMY`), on the same aggregate, so an auditor
  // reconstructing the opening balances that seeded a PCB figure reads ONE stream and does not have to
  // know which screen moved them. `source` is what distinguishes the two.
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'employee-statutory',
    aggregateId: stat.id,
    eventType: 'employee.tp3.updated',
    actor: actorOf(ctx),
    subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
    payload: {
      personId: p.personId,
      source: 'tp3-form',
      assessmentYear: p.assessmentYear,
      before: {
        tp3Year: stat.tp3Year,
        tp3NetRemuneration: stat.net,
        tp3EpfClaimed: stat.epf,
        tp3PcbPaid: stat.pcb,
        tp3ZakatPaid: stat.zakat,
        tp3Lp: stat.lp,
      },
      after,
    },
  });
  return { applied: true, seed: p.seed };
}

/**
 * Withdraw the projection this year's form put onto the statutory row. See `deleteTp3`'s header for why
 * the year equality is the test for "these figures came from that form", and why a different year is
 * left alone.
 */
async function clearProjectionForYear(
  tx: Tx,
  ctx: SessionContext,
  p: { personId: string; assessmentYear: number },
): Promise<void> {
  const [stat] = await tx
    .select({
      id: employeeStatutoryMy.id,
      tp3Year: employeeStatutoryMy.tp3Year,
      net: employeeStatutoryMy.tp3NetRemuneration,
      epf: employeeStatutoryMy.tp3EpfClaimed,
      pcb: employeeStatutoryMy.tp3PcbPaid,
      zakat: employeeStatutoryMy.tp3ZakatPaid,
      lp: employeeStatutoryMy.tp3Lp,
    })
    .from(employeeStatutoryMy)
    .where(eq(employeeStatutoryMy.personId, p.personId))
    .limit(1);
  if (!stat || stat.tp3Year !== p.assessmentYear) return;
  const after = {
    tp3Year: null,
    tp3NetRemuneration: null,
    tp3EpfClaimed: null,
    tp3PcbPaid: null,
    tp3ZakatPaid: null,
    // ∑LP is withdrawn with the rest (item 20837372). Leaving it behind would keep LOWERING the monthly
    // deduction from a Section D on a form that no longer exists — the same half of the production
    // defect this function was written for, pointing the other way.
    tp3Lp: null,
  };
  await tx
    .update(employeeStatutoryMy)
    .set({ ...after, updatedAt: new Date() })
    .where(eq(employeeStatutoryMy.id, stat.id));
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'employee-statutory',
    aggregateId: stat.id,
    eventType: 'employee.tp3.updated',
    actor: actorOf(ctx),
    subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
    payload: {
      personId: p.personId,
      source: 'tp3-form-deleted',
      assessmentYear: p.assessmentYear,
      before: {
        tp3Year: stat.tp3Year,
        tp3NetRemuneration: stat.net,
        tp3EpfClaimed: stat.epf,
        tp3PcbPaid: stat.pcb,
        tp3ZakatPaid: stat.zakat,
        tp3Lp: stat.lp,
      },
      after,
    },
  });
}

/**
 * Does this form assert any money at all? An all-blank Section C AND Section D carries nothing to lose.
 *
 * ⚠️ SECTION D COUNTS SINCE ITEM 20837372. It did not before, because it reached nothing; now it lowers
 * the monthly deduction, so a form carrying ONLY Section D has money that must land somewhere. Saving
 * it against a person with no statutory profile would recreate exactly the defect item 1bb09a73 closed
 * — a form whose figures reach no calculation — in the one section that used to be harmless.
 */
const seedCarriesMoney = (s: Tp3AccumulatorSeed) =>
  s.gross !== 0 ||
  s.exemptTotal !== 0 ||
  s.epfClaimed !== 0 ||
  s.pcbPaid !== 0 ||
  s.zakatPaid !== 0 ||
  s.lpDeclared !== 0;

function throwIfNowhereToLand(stat: unknown, seed: Tp3AccumulatorSeed): void {
  if (stat == null && seedCarriesMoney(seed)) {
    throw new Tp3Error(
      'This Form TP3 records previous-employment pay, but the employee has no Malaysian statutory profile for the tax calculation to read it from. Save the employee’s identity card number on Bank & Statutory first, then save the form again.',
    );
  }
}

/**
 * Create or replace ONE person's TP3 for ONE assessment year, AND project its Section C figures onto the
 * four `employee_statutory_my` columns the payroll run reads (item 1bb09a73).
 *
 * UPSERT ON THE GRAIN, not an append: see the header on db/schema's `employeeTp3` for why a record of
 * fact keeps its history in the event log where a declaration keeps it in rows. The unique index is what
 * makes the grain true; this is `onConflictDoUpdate` against it, so two concurrent saves cannot produce
 * two records for one year.
 *
 * ONE TRANSACTION covers the form row, the projection and both events: a form that saved while its
 * figures did not reach payroll is precisely the state this item was raised about, and a partial commit
 * would recreate it.
 */
export async function saveTp3(ctx: SessionContext, p: Tp3WriteInput): Promise<{ id: string; seed: Tp3SeedOutcome }> {
  const personId = requireAdminTarget(ctx, p.personId);
  const assessmentYear = validateYear(p.assessmentYear);
  const deductionMonth = validateMonth(p.deductionMonth);
  const previousEmployers = validateEmployers(p.previousEmployers);
  const sectionC = readGroup(
    // Section C lines carry no printed annual limit — the form's Section C has no limit column at all.
    TP3_SECTION_C.map((l) => ({ code: l.code, limit: null, subItems: l.subItems.map((s) => ({ code: s.code, limit: null })) })),
    p.sectionC ?? {},
    'C',
  );
  const sectionD = readGroup(TP3_SECTION_D, p.sectionD ?? {}, 'D');
  const remarks = readRemarks(p.remarks);

  const payload: Tp3Payload = { form: 'tp3-2026', sectionC: sectionC.out, sectionD: sectionD.out };
  if (remarks != null) payload.remarks = remarks;

  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select()
      .from(employeeTp3)
      .where(and(eq(employeeTp3.personId, personId), eq(employeeTp3.assessmentYear, assessmentYear)))
      .limit(1);

    // Section E. The tick is an explicit VALUE read by the form reader (never by presence), and the
    // TIMESTAMP is the server's. Unticking CLEARS it: a declaration that was withdrawn must not keep
    // printing a date under the acknowledgement.
    const declaredAt = p.declarationAccepted ? (existing?.declaredAt ?? new Date()) : null;

    const values = {
      tenantId: ctx.tenantId,
      personId,
      assessmentYear,
      deductionMonth,
      previousEmployers,
      payload,
      declaredAt,
      remarks,
    };

    const [saved] = await tx
      .insert(employeeTp3)
      .values(values)
      .onConflictDoUpdate({
        target: [employeeTp3.tenantId, employeeTp3.personId, employeeTp3.assessmentYear],
        set: {
          deductionMonth,
          previousEmployers,
          payload,
          declaredAt,
          remarks,
          updatedAt: new Date(),
        },
      })
      .returning({ id: employeeTp3.id });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-tp3',
      aggregateId: saved.id,
      eventType: 'employee.tp3form.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, personId),
      // BEFORE/AFTER OF THE WHOLE RECORD. These are a PREVIOUS employer's accumulated year-to-date
      // figures, not this employer's per-payslip cleartext pay, so they sit on the event under the same
      // reading of ADR-0030 that `employee.tp3.updated` already relies on — and a compliance auditor
      // reconstructing a filed TP3 needs exactly this.
      payload: {
        personId,
        assessmentYear,
        before: existing
          ? {
              deductionMonth: existing.deductionMonth,
              previousEmployers: existing.previousEmployers,
              payload: existing.payload,
              declaredAt: existing.declaredAt?.toISOString() ?? null,
            }
          : null,
        after: {
          deductionMonth,
          previousEmployers,
          payload,
          declaredAt: declaredAt?.toISOString() ?? null,
        },
      },
    });

    // ── The projection onto the four figures the payroll run reads (item 1bb09a73) ──────────────────
    //
    // AFTER the form row and INSIDE the same transaction. `deriveAccumulatorSeed` cannot return null
    // here — the payload is built two lines above with `form: 'tp3-2026'` — but the non-null assertion
    // is a `??` fallback rather than a `!`, so a future payload revision that this function does not yet
    // understand raises rather than silently seeding zeros onto a statutory deduction.
    const seed = deriveAccumulatorSeed(payload);
    if (!seed) throw new Tp3Error('This Form TP3 could not be read for the tax calculation.');
    // A NEGATIVE ∑(Y−K) is a keying error, and it is the one `deriveAccumulatorSeed` deliberately does
    // not clamp (see its header). Clamping it to zero here would understate previous-employment income
    // and under-deduct PCB; writing it through would put a negative accumulator into LHDN's formula.
    // Both are wrong figures on a statutory deduction, so the save refuses and names the boxes.
    if (seed.netRemuneration < 0) {
      throw new Tp3Error(
        'Section C does not add up: the tax-exempt amounts (C2) plus the EPF contributions (C3) are more than the total remuneration (C1). Check those boxes before saving.',
      );
    }
    const outcome = await projectSeedOntoStatutory(tx, ctx, { personId, assessmentYear, seed });

    return { id: saved.id, seed: outcome };
  });
}

/**
 * Remove ONE person's TP3 record for ONE year.
 *
 * A HARD DELETE, unlike `cancelTp1ForPerson`'s status write, and the difference is what the two records
 * ARE. A TP1 is the employee's own filed declaration and a cancelled one is still a fact about what they
 * declared. A TP3 keyed against the wrong person or the wrong year is a data-entry mistake with no
 * statutory meaning of its own — the paper form the employee handed in is the record, and the employer
 * keeps it for seven years as the form's own note says. The event log carries the before-image.
 *
 * ⚠️ IT ALSO CLEARS THE PROJECTION IT PUT THERE (item 1bb09a73), and only that one: the four columns are
 * cleared when `tp3_year` equals the year being deleted, and left alone otherwise. Since `saveTp3` for
 * year Y sets `tp3_year = Y`, that equality is what says "these figures came from the form now being
 * withdrawn". Leaving them behind would leave payroll seeding from a form that no longer exists, which
 * is the half of the production defect that had figures with no form behind them. A hand-keyed opening
 * balance for a DIFFERENT year is untouched, and the before-image is on the event either way.
 */
export async function deleteTp3(ctx: SessionContext, p: { personId: string; assessmentYear: number }): Promise<void> {
  const personId = requireAdminTarget(ctx, p.personId);
  const assessmentYear = validateYear(p.assessmentYear);
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select()
      .from(employeeTp3)
      .where(and(eq(employeeTp3.personId, personId), eq(employeeTp3.assessmentYear, assessmentYear)))
      .limit(1);
    if (!existing) return;
    await tx.delete(employeeTp3).where(eq(employeeTp3.id, existing.id));
    await clearProjectionForYear(tx, ctx, { personId, assessmentYear });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-tp3',
      aggregateId: existing.id,
      eventType: 'employee.tp3form.deleted',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, personId),
      payload: {
        personId,
        assessmentYear,
        before: {
          deductionMonth: existing.deductionMonth,
          previousEmployers: existing.previousEmployers,
          payload: existing.payload,
          declaredAt: existing.declaredAt?.toISOString() ?? null,
        },
      },
    });
  });
}
