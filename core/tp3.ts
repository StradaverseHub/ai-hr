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
 * X, Z and ∑LP — AND, since item 1785b766, the per-code EXEMPTION LEDGER (`tp3_exemption_used`,
 * migration 0489), which is not a formula variable at all: it is how much of each ANNUAL PER-EMPLOYEE
 * exemption cap the previous employer already spent, so this employer's pay items draw only on the
 * headroom that is left. Before it, a July joiner who had used their whole RM6,000 travel exemption
 * elsewhere was handed a fresh RM6,000 here and too little tax was taken. ⚠️ ∑LP IS NEW IN ITEM 20837372 and it is the reason to re-read this header: stage 2 of
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
 * and the SIX columns become its DERIVED PROJECTION for that person; for a person with NO form they
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
 * `deriveAccumulatorSeed` computes the seed from the form's own boxes — C1 + Σ max(C2ₖ − limitₖ, 0) − C3, C3, C5, C4(i),
 * since item 20837372 ∑D1…D17, and since item 1785b766 the C2 sub-lines split by the PCB exemption code
 * each one draws on — and it is the ONE place that mapping exists: the reconciliation strip on the screen and the write below
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

/**
 * The EPF relief cap of the pack that owns the TP3 catalogue — LHDN's K limit (item 20837372).
 *
 * ⚠️ READ FROM THE PACK, NEVER WRITTEN HERE. `core/payroll.ts` already caps K with
 * `pack.payroll.epfReliefCap` and its comment says why ("pack-owned: cap math always matches the
 * calculator"). A second literal in this file would be the duplicate-source-of-truth CLAUDE.md §1
 * forbids, and the two copies would disagree the first time an agency moved the figure.
 *
 * NULL ⇒ no cap is sourced for this country, and none is invented — the same discipline
 * `tp3ExemptionOverLimits` applies to a sub-line whose `exemptionLimit` is null.
 *
 * EXPORTED IN r345 so the TP3 screen can print C3's cap beside the box. The screen must not carry a
 * literal 4000 and must not work the cap out a second way: this accessor and `deriveAccumulatorSeed`
 * are then provably reading one figure, which is the whole point of the item that exported it.
 */
export function tp3EpfReliefCap(): number | null {
  const owner = countryPacks().find((p) => p.payroll.tp3Catalogue != null);
  return owner?.payroll.epfReliefCap ?? null;
}

/**
 * ONE Section C line, totalled with each sub-line held to its own statutory limit (item 20837372).
 *
 * The limits are the SAME `exemptionLimit` values `tp3ExemptionOverLimits` compares against, read off
 * the same catalogue, so the warning the operator sees and the figure the calculation uses can never
 * describe different rules. A sub-line with no sourced limit contributes in full; a line with no
 * sub-lines has nothing to cap and contributes its stored amount.
 */
/**
 * ΣC2's TAXABLE EXCESS — the part of each sub-line ABOVE its own statutory exemption limit (r350).
 *
 * The mirror of `cappedLineTotal` and deliberately a SECOND walk rather than a tuple out of the first:
 * the two totals answer different questions (what is exempt / what is taxable) and are printed in
 * different places, and one of them is struck against the money while the other is not.
 *
 * ⚠️ A SUB-LINE WITH NO SOURCED LIMIT CONTRIBUTES 0, WHICH IS NOT THE SAME AS "NOTHING IS OVER".
 * C2(iii) and C2(v) carry no limit anywhere in the specification's printed-page-21 table, so no excess
 * can be PROVEN for them and none is asserted. The screen says "no limit is published" rather than
 * printing 0.00 — CLAUDE.md §8: an absent box asserts nothing, `0.00` asserts the money does not exist.
 *
 * ⚠️ THE NO-SUB-LINES BRANCH RETURNS 0 for the same reason `cappedLineTotal` returns the amount there:
 * a hand-built or legacy payload carrying an `amount` with no `subItems` behind it has nothing to apply
 * a PER-SUB limit to, so there is no excess to compute and a recomputed guess would be invented money.
 */
function excessLineTotal(payload: Tp3Payload, code: string): number {
  const line = TP3_SECTION_C.find((l) => l.code === code);
  const stored = (payload.sectionC ?? {})[code];
  if (line == null || line.subItems.length === 0) return 0;
  if (stored?.subItems == null) return 0;
  return round2(
    line.subItems.reduce((sum, sub) => {
      const keyed = Number(stored.subItems?.[sub.code] ?? 0);
      const limit = sub.exemptionLimit;
      return sum + (limit == null ? 0 : Math.max(keyed - limit, 0));
    }, 0),
  );
}

/**
 * ΣC2 SPLIT BY THE PCB EXEMPTION CODE EACH SUB-LINE DRAWS ON (item 1785b766) — the previous employer's
 * usage of this employee's ANNUAL, PER-EMPLOYEE exemption caps.
 *
 * ══ WHY THIS EXISTS ═════════════════════════════════════════════════════════════════════════════════
 *
 * `MY_PCB_EXEMPTION_CODES`'s own header states the grain: "Caps are ANNUAL, tracked per employee per
 * code". `core/payroll.ts` tracked them per EMPLOYER — it replays this employer's issued payslips
 * (`statutory.exemptionUsed`) and nothing else — so a person who joined in July having already spent
 * the whole RM6,000 travel exemption at their old job arrived here with a fresh RM6,000. The exemption
 * was given twice in one year and too little tax was taken. The TP3 is the record that says how much
 * was spent; this function is the mapping from its boxes onto the codes that cap them.
 *
 * ══ WHAT COUNTS AGAINST THE CAP IS THE EXEMPT PART, NOT THE KEYED AMOUNT ════════════════════════════
 *
 * `min(keyed, limit)` — the same figure `cappedLineTotal` totals, per code instead of in one sum. The
 * part ABOVE the limit was never exempt: r350 established that it is taxable and is ADDED to ∑(Y−K)
 * (`excessLineTotal`), so it is already being taxed and must not ALSO eat exemption headroom, which
 * would tax it a second time by denying this employer's own allowance.
 *
 * ══ A SUB-LINE WITH NO MAPPED CODE CONTRIBUTES NOTHING, AND THAT IS AN ANSWER ═══════════════════════
 *
 * C2(iii) and C2(v) map to no code (see `MY_TP3_2026_SECTION_C`: (iii) has no entry in the
 * specification's printed-page-21 table, (v) is a remainder over entries with different limit shapes).
 * Money keyed there spends no code's cap. Inventing a code for them — `PCB_COMPANY_PROD` is the
 * tempting one and its RM1,000 is verified against nothing — would take a real exemption away from a
 * real employee on an unverified figure.
 *
 * ⚠️ NO SUB-LINES STORED ⇒ AN EMPTY MAP, for the same reason `excessLineTotal` returns 0 there: a
 * hand-built or legacy payload carrying an `amount` with no `subItems` behind it says nothing about
 * WHICH exemption the money used, and attributing it to a code by guess would net a cap off on a guess.
 */
function exemptionUsedByCode(payload: Tp3Payload): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of TP3_SECTION_C) {
    const stored = (payload.sectionC ?? {})[line.code];
    if (stored?.subItems == null) continue;
    for (const sub of line.subItems) {
      const code = sub.exemptionCode;
      const limit = sub.exemptionLimit;
      if (code == null || limit == null) continue;
      const keyed = Number(stored.subItems?.[sub.code] ?? 0);
      const used = Math.min(keyed, limit);
      // Zero is not recorded: an absent key means "this exemption was not used", which is what the
      // payroll ledger reads a missing code as. Writing 0.00 would assert a measurement nobody made.
      if (used > 0) out[code] = round2((out[code] ?? 0) + used);
    }
  }
  return out;
}

function cappedLineTotal(payload: Tp3Payload, code: string): number {
  const line = TP3_SECTION_C.find((l) => l.code === code);
  const stored = (payload.sectionC ?? {})[code];
  const amount = Number(stored?.amount ?? 0);
  if (line == null || line.subItems.length === 0) return amount;
  // ⚠️ NO SUB-LINES STORED ⇒ USE THE AMOUNT, NEVER A RECOMPUTED ZERO. `readGroup` above sets a
  // sub-lined item's `amount` to the SUM of its sub-lines and writes `subItems` only where one is
  // above zero, so a payload this codebase saved can never carry a non-zero `amount` here without the
  // sub-lines behind it. A hand-built or legacy payload can, and summing its absent keys would silently
  // erase the figure — which is how the first cut of this change turned a −400 keying error into +500
  // and hid it. There is nothing to apply a PER-SUB limit to in that shape, so the amount stands.
  if (stored?.subItems == null) return amount;
  return round2(
    line.subItems.reduce((sum, sub) => {
      const keyed = Number(stored.subItems?.[sub.code] ?? 0);
      const limit = sub.exemptionLimit;
      return sum + (limit == null ? keyed : Math.min(keyed, limit));
    }, 0),
  );
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
 *     netRemuneration (∑(Y − K)) = C1 + Σ max(C2ₖ − limitₖ, 0) − C3
 *     epfClaimed      (K)        = C3
 *     pcbPaid         (X)        = C5          (the form's own "excluding CP38")
 *     zakatPaid       (Z)        = C4(i)
 *
 * ═══ r350 — ΣC2 IS ADDED, NOT SUBTRACTED, AND THE REPORTER WAS RIGHT FIVE TIMES RUNNING ═══
 *
 * This line read `C1 − ΣC2 − C3` from item 1bb09a73 until r350. It was wrong, it understated every
 * TP3 employee's chargeable income by the whole of their exempt allowances, and it therefore
 * UNDER-DEDUCTED their MTD every month. The premise it rested on — "C1 is GROSS, so the exempt money is
 * in C1 and must come off" — was an ASSUMPTION about C1 that nobody had read off the form. r348 went
 * further and told the reporter their contest was mistaken ON THAT ASSUMPTION. It was not.
 *
 * WHAT THE FORM ITSELF SAYS. `bm-borang-tp3-2026.pdf` and `Borang_TP_3_2023.pdf`, BAHAGIAN C, identical
 * wording in both editions:
 *
 *     C1  "Jumlah saraan kasar bulanan dan saraan tambahan termasuk elaun / perkuisit /
 *          pemberian / Manfaat YANG DIKENAKAN CUKAI"          ← subject to tax
 *     C2  "Jumlah elaun/perkuisit/pemberian/manfaat YANG DIKECUALIKAN CUKAI"   ← exempt from tax
 *
 * C1 carries ONLY the taxable items. The exempt allowances were never in it, so subtracting them
 * removed money that was not there. This settles the UNKNOWN written down in the
 * `MY_TP3_2026_SECTION_C` header in localization/my/statutory-tables.ts, which said only the
 * `Nota Penerangan Borang TP3` could decide it — the form decides it, and the notes are still 404.
 *
 * FOUR MORE SOURCES AGREE, so this is not one reading of one caption:
 *   · the specification's OWN WORKED EXAMPLE, printed page 21 — normal 5,000 + car 800 + meal 300
 *     (exempt) + childcare 250 (exempt) = 6,350, and "To determine MTD amount, taxable income as
 *     follow: … Total taxable remuneration : RM5,800". The exempt items are simply not in it;
 *   · printed page 20 item 9 — "MTD is to be deducted from the employee's TAXABLE REMUNERATION ONLY.
 *     All the tax exemption … shall be EXCLUDED FROM THE REMUNERATION for MTD purposes. Any amount
 *     exceed the restricted amount shall be taxable.";
 *   · Form C.P.8A (EA) Pin. 2023 — Section B is headed "(EXCLUDING Tax Exempt Allowances / Perquisites
 *     / Gifts / Benefits)" and the exempt total gets its own Section F. Same architecture;
 *   · our OWN current-employment path already works this way (localization/my/reports.ts:1084-1091):
 *     the exempt portion is a memo line off the PCB exemption ledger, never a second subtraction.
 *
 * SO THE EXCESS IS ADDED. Anything above a sub-line's limit is taxable (page 20 item 9) and is
 * therefore NOT in C1, because C1 holds only taxable pay. `excessTotal` is that part and nothing else;
 * the within-limit part is genuinely exempt and contributes zero. The reporter's two worked examples,
 * now pinned in test/20837372-tp3-section-c-limits.test.ts:
 *
 *     C1 60,000, C2(i) 3,600 (limit 6,000), C3 4,000  →  60,000 + 0     − 4,000 = 56,000
 *     C1 60,000, C2(i) 7,000 (limit 6,000), C3 4,000  →  60,000 + 1,000 − 4,000 = 57,000
 *
 * NEGATIVE IS RETURNED AS NEGATIVE, not clamped to zero. A negative (Y − K) now means the EPF box alone
 * exceeds C1 plus any taxable excess, which is a keying error the operator must see — clamping it would
 * hide the one thing this function exists to surface.
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
  /**
   * ΣC2 AS IT COUNTS — each sub-line held to its own statutory limit (item 20837372). This is the
   * figure `netRemuneration` is struck against; `exemptEntered` below is what the operator keyed.
   */
  exemptTotal: number;
  /** ΣC2 exactly as keyed, so the form can print what was entered beside what counts. */
  exemptEntered: number;
  /**
   * ΣC2's TAXABLE EXCESS — Σ max(keyed − limit, 0) over the sub-lines that HAVE a sourced limit (r350).
   *
   * This is the only part of Section C2 that reaches `netRemuneration`, and it is ADDED to C1, not
   * subtracted from it. See the arithmetic note on `deriveAccumulatorSeed` below for why.
   */
  excessTotal: number;
  /**
   * ΣC2 SPLIT BY PCB EXEMPTION CODE — how much of each ANNUAL, PER-EMPLOYEE exemption cap the previous
   * employer already spent (item 1785b766). `{}` when the form claims no mapped exemption.
   *
   * ⚠️ IT IS THE OPENING BALANCE OF A LEDGER, NOT A REPORTING FIGURE. `core/payroll.ts` seeds
   * `priorUsed` from it under the SAME `tp3Applies = tp3Year === pYear` gate as the other five columns,
   * and `roomFor(code, cap) = cap − priorUsed[code] − exemptionUsed[code]` then hands this employer's
   * pay items only the REMAINING headroom. Before this existed the TP3 contributed nothing to that
   * ledger and a mid-year joiner was handed a second full set of annual exemptions.
   *
   * ⚠️ IT MUST NOT REACH THE EA FORM. `localization/my/reports.ts` builds the EA's exempt-allowances
   * figure by replaying THIS employer's payslips' `statutory.exemptionUsed`, and that is correct: the EA
   * reports what this employer paid. The previous employer's exempt money belongs on THEIR EA, and
   * adding it to ours would overstate our own. Nothing in the reports path reads this field.
   */
  exemptionUsed: Record<string, number>;
  /**
   * C3 held to the EPF relief cap — LHDN's K, which the specification DEFINES as capped. `epfClaimed`
   * above is the raw box, and it stays raw because the form prints it.
   */
  epfAllowable: number;
  /** C1 — the gross before anything comes off it. */
  gross: number;
};

export function deriveAccumulatorSeed(payload: Tp3Payload | null | undefined): Tp3AccumulatorSeed | null {
  if (!payload || payload.form !== 'tp3-2026') return null;
  const c = payload.sectionC ?? {};
  const gross = Number(c.c1?.amount ?? 0);
  // ⚠️ CAPPED, AND THIS IS THE ITEM (20837372). Until this round both lines below went into
  // `netRemuneration` exactly as keyed, so a box over its statutory limit reduced taxable pay by the
  // whole of itself. The specification's printed page 20 item 9 says the opposite of that: "Any amount
  // exceed the restricted amount shall be taxable." See the note on `tp3ExemptionOverLimits` for why
  // the earlier reading of this file was wrong.
  const exemptEntered = Number(c.c2?.amount ?? 0);
  const exemptTotal = cappedLineTotal(payload, 'c2');
  const excessTotal = excessLineTotal(payload, 'c2');
  // Item 1785b766 — the same capped money as `exemptTotal`, split by the exemption code each sub-line
  // draws on, so this employer's ledger opens where the previous employer left it. See the accessor.
  const exemptionUsed = exemptionUsedByCode(payload);
  const epfClaimed = Number(c.c3?.amount ?? 0);
  const epfCap = tp3EpfReliefCap();
  const epfAllowable = epfCap == null ? epfClaimed : Math.min(epfClaimed, epfCap);
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
    exemptEntered,
    excessTotal,
    exemptionUsed,
    epfClaimed,
    epfAllowable,
    pcbPaid,
    zakatPaid,
    lpDeclared,
    // ∑(Y−K) IS STRUCK AGAINST THE ALLOWABLE FIGURES, NOT THE KEYED ONES. K is defined as capped, so
    // (Y−K) must subtract the capped K — `core/payroll.ts` already caps K itself, and until this round
    // the two disagreed about the same box: on the one production form C3 was 8,979 against a 4,000
    // cap, so K was 4,000 while this subtracted 8,979 and understated accumulated pay by 4,979.
    netRemuneration: round2(gross + excessTotal - epfAllowable),
  };
}

/**
 * The C2 sub-lines whose keyed figure is ABOVE the statutory exemption limit for that line (item
 * 20837372). Empty when every box is within its limit, or when no limit is sourced for it.
 *
 * ⚠️ IT REPORTS; IT NEVER REFUSES. TP3 Section C prints ONE money column and no limit column (verified
 * on the agency's own Exhibit 2, printed page 39, and on the standalone `bm-borang-tp3-2026.pdf`), so
 * ADR-0008's "an item with no printed cap is captured and never blocked" decides the INPUT: the form
 * stores exactly what the operator keyed, and this function's job is to tell them when a box looks
 * wrong. That is unchanged.
 *
 * ⚠️⚠️ THIS COMMENT HAS BEEN WRONG TWICE AND BOTH VERSIONS ARE RECORDED RATHER THAN DELETED.
 *
 * (1) Before r345 it argued the excess needed no treatment at all, because it "is therefore already
 *     sitting in C1 as taxable pay by the time the form is filled in".
 * (2) r345 replaced that with "C1 is GROSS … so the excess is in C1 either way", and had the capping
 *     SUBTRACT less from C1.
 *
 * Both rested on the same unread assumption about what C1 contains. C1 contains only the TAXABLE items
 * — the form says so in its own caption, "…YANG DIKENAKAN CUKAI" — so the excess is NOT in C1 and
 * cannot be reached by subtracting less. r350 adds it: `deriveAccumulatorSeed` now computes
 * `C1 + Σ max(keyed − limit, 0) − C3`. The full evidence is on that function.
 *
 * ⚠️ AN OVER-LIMIT BOX IS NO LONGER A KEYING ERROR. This function used to end by saying a figure over
 * the limit "usually means the FORM was filled wrong". It does not. The previous employer is entitled
 * to pay more than the exempt limit; the part above it is simply taxable, and from r350 it IS taxed.
 * This still reports — the operator should see which boxes are over and by how much — but the warning
 * now explains a tax consequence rather than accusing the form of being mis-keyed.
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
 * The B1–B3 identity the form prints, and the five stored MONEY columns the screen reconciles
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
 * What the save did to the figures the payroll run reads — SIX since item 1785b766 added the per-code
 * exemption ledger's opening balance. Returned so the caller can SAY so: a
 * projection that quietly did not happen is the defect this item exists to remove, one level up.
 */
export type Tp3SeedOutcome =
  /** The six projected columns and `tp3_year` now hold this form's figures. */
  | { applied: true; seed: Tp3AccumulatorSeed }
  /** A LATER assessment year holds the columns; this form is recorded and the columns are untouched. */
  | { applied: false; reason: 'laterYearHoldsColumns'; heldBy: number }
  /** The person has no `employee_statutory_my` row, and this form asserts no money to put in one. */
  | { applied: false; reason: 'noStatutoryProfile' };

/**
 * `employee_statutory_my` is UNIQUE ON `person_id` (`employee_statutory_my_person_uq`), so the projected
 * figures are a PERSON-level fact and always have been — `core/payroll.ts` joins
 * employment → person → this row, and a person holding two concurrent employments already seeds both
 * runs from the one row. This projection inherits that grain and changes nothing about it; it is stated
 * here because writing the columns from a person-keyed form makes it look like a new decision. It is
 * not, and a per-employment previous-employment balance would need a new column before it could be one.
 */
/**
 * Re-derive every stored TP3 projection from the form it came from (item 20837372, r342).
 *
 * ⚠️ WHY A RESYNC IS OWED AT ALL. `employee_statutory_my`'s TP3 columns are a PROJECTION, written
 * only when the form is saved. r342 changed the arithmetic that produces them — Section C is now
 * counted to its statutory limits — so every row stored before this round holds a figure derived by the
 * old rule and will keep seeding PCB with it until somebody re-saves that form. On the reporter's
 * system that is one row, and it is wrong by RM4,979.
 *
 * ⚠️ IT REUSES `projectSeedOntoStatutory`, WHICH IS THE POINT. A script that wrote the six columns
 * itself would be a second author of the same projection, and the two would drift the first time one of
 * them changed. This walks the forms and hands each freshly-derived seed to the SAME function the save
 * path uses, so the resynced row is byte-identical to what a re-save would have produced — including
 * the `laterYearHoldsColumns` refusal and the missing-profile refusal, which are reported, not
 * overridden.
 *
 * Returns one outcome per form so the caller can print what moved and what did not. CLAUDE.md §6:
 * `deploy.sh` runs migrations, not scripts — this must be run on the box and its rows verified.
 */
export async function resyncTp3Projections(
  ctx: SessionContext,
  opts: { dryRun?: boolean } = {},
): Promise<{ personId: string; assessmentYear: number; before: number | null; after: number; outcome: Tp3SeedOutcome }[]> {
  return withTenant(ctx, async (tx) => {
    const forms = await tx
      .select({ personId: employeeTp3.personId, assessmentYear: employeeTp3.assessmentYear, payload: employeeTp3.payload })
      .from(employeeTp3)
      .orderBy(employeeTp3.personId, employeeTp3.assessmentYear);
    const out: { personId: string; assessmentYear: number; before: number | null; after: number; outcome: Tp3SeedOutcome }[] = [];
    for (const f of forms) {
      const seed = deriveAccumulatorSeed(f.payload as Tp3Payload | null);
      if (seed == null) continue;
      const [stat] = await tx
        .select({ net: employeeStatutoryMy.tp3NetRemuneration })
        .from(employeeStatutoryMy)
        .where(eq(employeeStatutoryMy.personId, f.personId))
        .limit(1);
      const before = stat?.net == null ? null : Number(stat.net);
      const outcome = opts.dryRun
        ? ({ applied: false, reason: 'dryRun' } as unknown as Tp3SeedOutcome)
        : await projectSeedOntoStatutory(tx, ctx, { personId: f.personId, assessmentYear: f.assessmentYear, seed });
      out.push({ personId: f.personId, assessmentYear: f.assessmentYear, before, after: seed.netRemuneration, outcome });
    }
    return out;
  });
}

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
      exemptionUsed: employeeStatutoryMy.tp3ExemptionUsed,
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
    // the SAME `tp3_year`, so they can never describe different forms.
    tp3Lp: money(p.seed.lpDeclared),
    // ── THE PER-CODE EXEMPTION LEDGER'S OPENING BALANCE (item 1785b766) ─────────────────────────────
    //
    // SIXTH, IN THE SAME STATEMENT, UNDER THE SAME `tp3_year`, for the reason the ∑LP comment above
    // gives: six figures describing one form must be written once or they can describe two.
    //
    // ⚠️ AND THIS IS WHY POINTS 5, 9 AND 10 OF THE REPORTER'S EXPECTED FUNCTION NEED NO MECHANISM.
    // "Amending the form recalculates", "reprocessing must not double-count" and "a cancelled form stops
    // counting" all fall out of the SHAPE of this write and are not implemented anywhere:
    //
    //   · there is exactly ONE `employee_tp3` row per person per year (`employee_tp3_person_year_uq`), so
    //     there is one payload to derive from and no history to sum;
    //   · this column is DERIVED from that payload and REWRITTEN WHOLE on every save. It is not a ledger
    //     that is appended to, so amending C2(i) from 2,000 to 2,500 REPLACES 2,000 with 2,500 — it can
    //     never accumulate to 4,500. `test/1785b766-tp3-exemption-headroom.test.ts` pins that number;
    //   · a payroll run READS this column and writes nothing back to it, so running the same month five
    //     times consumes the previous employer's exemption exactly once;
    //   · deleting the form clears it through `clearProjectionForYear`, by the same single path.
    //
    // A future reader looking for a reconciliation or de-duplication step should stop here: adding one
    // would be a second author of a derived figure, which is the drift this whole item exists to remove.
    //
    // EMPTY ⇒ NULL, not `{}`. "No mapped exemption on this form" and "no form" must read identically in
    // `core/payroll.ts`, and null is what the column already means everywhere else.
    tp3ExemptionUsed: Object.keys(p.seed.exemptionUsed).length ? p.seed.exemptionUsed : null,
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
        tp3ExemptionUsed: stat.exemptionUsed,
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
      exemptionUsed: employeeStatutoryMy.tp3ExemptionUsed,
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
    // The per-code exemption ledger's opening balance goes with them (item 1785b766). Left behind it
    // would keep DENYING this employer's own exemption headroom on the strength of a form that no longer
    // exists — the reporter's Expected Function point 10, and it needs no mechanism beyond this line
    // because the column is derived from the deleted row and is written whole, never appended to.
    tp3ExemptionUsed: null,
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
        tp3ExemptionUsed: stat.exemptionUsed,
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
// ⚠️ `exemptionUsed` IS DELIBERATELY NOT TESTED HERE, and it is not an omission: every ringgit in that
// map is part of `exemptTotal` by construction (it is the same `min(keyed, limit)` money, split by code),
// so a non-empty map already implies `exemptTotal !== 0`. Adding it would be a second test of one fact.
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
      'This Form TP3 records previous-employment pay or reliefs, but the employee has no Malaysian statutory profile for the tax calculation to read it from. Save the employee’s identity card number on Bank & Statutory first, then save the form again.',
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

    // ── The projection onto the figures the payroll run reads (item 1bb09a73; six of them since 1785b766) ──
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
 * ⚠️ IT ALSO CLEARS THE PROJECTION IT PUT THERE (item 1bb09a73), and only that one: the six columns are
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
