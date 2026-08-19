/**
 * Self-service Personal Tax Relief — LHDN TP1 (ADR-0050, #1.1.3; per-category breakdown a2f1fa24).
 *
 * An employee declares their optional reliefs (TP1) per assessment year on /me, and HR maintains the same
 * record on /payroll/transactions/tp1 — since 7ad37961 one record per DEDUCTION MONTH. The SUM of the
 * winning APPROVED declaration per month, over the months already effective, feeds monthly PCB/MTD
 * through `prefillTp1FromSelfRelief` (core/payroll).
 *
 * ══ THE ONE RULE, AND WHY IT IS ONE (r209) ══════════════════════════════════════════════════════════
 * Which row wins a month, which months count, and what each contributes are ALL answered by
 * `tp1CountForYear` + `tp1EffectiveFromMonth` in this file. Every consumer calls them: the limit check
 * at the write, the screen's Accumulated/Remaining strip, the printed form's ACCUMULATED column, the
 * payroll feed, and the reconciliation. There is no second spelling anywhere, and there must not be one.
 *
 * That is not tidiness. In r201 there WERE two: the payroll feed filtered on `approved_month` in SQL and
 * summed `tp1_amount`; this file filtered on nothing and accumulated only C1–C17 attribution. A
 * declaration carried forward from before the 2026 form has money but no attribution, so it counted in
 * FULL on one side and ZERO on the other. HR was shown a "Remaining" figure that did not know about it,
 * keyed an increment against that figure, and the PCB came out wrong — with no error on the screen, in
 * the log, or on the payslip. The build was held for it, two fix passes patched one side each and moved
 * money the wrong way, and the rule was collapsed into one place instead. If you are about to add a
 * month predicate or a sum anywhere near TP1, put it in `tp1CountForYear` and let both sides read it.
 *
 * ⚠️ THE FEED GATE MOVED FROM `submitted` TO `approved` IN 7ad37961 (ADR-0081). Migration 0449 stamps
 * every pre-existing submitted row approved, effective from the month it was approved; without that
 * backfill, every existing employee's relief stops silently. If you are reading this because relief went
 * missing, check the backfill first.
 *
 * As of 7ad37961 the declaration is the FULL official form: seventeen numbered deduction items (C1–C17)
 * with their lettered sub-lines, the Section D rebate lines, the Section E employee declaration and the
 * Section F employer consent. The item structure and every annual limit come from the COUNTRY PACK
 * (`payroll.taxReliefCatalogue`), never from this file and never from a message catalogue.
 *
 * As of a2f1fa24 the declaration was captured as an eight-key per-category breakdown (individual, spouse,
 * children, parent, medical/insurance, lifestyle, education, other + a remarks note). THOSE ROWS ARE
 * STILL READ, STILL EDITABLE, STILL PRINTED AND STILL FEED PAYROLL — `resolveInput` branches on the
 * payload's `form` discriminator and `TP1_CATEGORY_KEYS` remains the legacy key list for exactly that.
 *
 * The authoritative `tp1Amount` REMAINS the server-computed round2 SUM of the DEDUCTION items — the
 * single number the PCB kernel consumes — so the monthly MTD math is unchanged by any of this. Section D
 * rebates are stored and printed but deliberately excluded from that sum (a rebate reduces tax, not
 * chargeable income). Legacy scalar-only rows (categories NULL) keep working: callers may still pass a
 * bare `tp1Amount` and no breakdown.
 *
 * Shape: the append-only request-row pattern (profile_change_request / resignation_request). The latest
 * row per (person, year) wins (`orderBy(desc(createdAt))`); the editable draft for a year is UPDATEd in
 * place; a submitted row is immutable, so a correction is a NEW submitted row. Per-year isolation comes
 * from the `assessmentYear` WHERE clause; history comes from never deleting + the DomainEvent log.
 *
 * `personId` is resolved from `ctx.personId` ONLY (never a form field) — RLS (`app.can_see_person`) also
 * confines every read and write to the caller's own row (self) or an admin. PDPA Layer-0 (ADR-0030): the
 * tp1.* event payloads reference the row id + year + month + changed field NAMES, never the cleartext
 * amounts. That holds for the three new decision events (tp1.approved / rejected / cancelled) too.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../db/events';
import { isAdmin } from '../lib/authz';
import {
  appUser,
  company,
  companyStatutoryMy,
  employeeStatutoryMy,
  employment,
  person,
  tp1Relief,
  TP1_CATEGORY_KEYS,
  isTp1Categories2026,
  type Tp1CategoryKey,
  type Tp1Categories,
  type Tp1Categories2026,
  type Tp1LegacyCategories,
  type Tp1ItemAmounts,
} from '../db/schema';
import { countryPacks } from '../localization/registry';

export class TaxReliefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxReliefError';
  }
}

// A non-negative finite amount under a sane annual ceiling, in a sane year range.
const TP1_MAX = 1_000_000; // generous ceiling on the SUM; per-category caps below where sourced.
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;
const REMARKS_MAX = 2000;

// Per-category caps we ACTUALLY have a sourced statutory number for — supplied by the country packs
// (ADR-0080 D6, rung 5a: `payroll.taxReliefCategoryCaps`; MY sources them from the LHDN 2026 MTD
// projection reliefs, VERIFIED in the pack's statutory tables). The pack supplies ONLY the categories
// with a genuine sourced cap. The other TP1 categories (medical/insurance, lifestyle, parent,
// education, other) have NO sourced cap in the system today; under ADR-0008 (no unsourced statutory
// number) they get the non-negative check only, and a sourced per-category cap is a DEFERRED follow-up
// (owned by the pack). TP1 declarations are person-level with no acting company, so the caps merge
// across registered packs — byte-identical with MY as the only pack; per-person pack resolution is a
// later slice. (`children` / EPF stay per-unit in the pack tables; a flat aggregate cap would be wrong.)
const SOURCED_CATEGORY_CAPS: Partial<Record<Tp1CategoryKey, number>> = Object.assign(
  {},
  ...countryPacks().map((p) => p.payroll.taxReliefCategoryCaps),
);

/**
 * The FULL TP1 catalogue — C1–C17 with their lettered sub-lines, the annual limit the agency's own form
 * prints against each, and the Section D rebate lines (7ad37961, ADR-0081). Supplied by the pack, exactly
 * like the caps above: MY ships LHDN TP1 (1/2026) from `localization/my/statutory-tables`.
 *
 * TYPED STRUCTURALLY OFF THE PACK CONTRACT, never by importing the MY module — a core/ file that names a
 * pack implementation is the R55 mistake ADR-0080 rung 5a undid, and re-making it here would put a
 * jurisdiction's table names back into the kernel's import graph.
 *
 * MERGED BY CODE ACROSS REGISTERED PACKS, first pack wins, for the same reason the caps merge: a TP1
 * declaration is PERSON-level with no acting company, so there is no company whose pack could be
 * selected. With MY as the only registered pack this is byte-identical to "the MY catalogue"; a second
 * jurisdiction makes per-person pack resolution a real question, and it is a later slice either way.
 */
type Tp1Catalogue = ReturnType<typeof countryPacks>[number]['payroll']['taxReliefCatalogue'];
export type Tp1CatalogueItem = Tp1Catalogue['items'][number];

function mergeByCode(lists: readonly (readonly Tp1CatalogueItem[])[]): readonly Tp1CatalogueItem[] {
  const byCode = new Map<string, Tp1CatalogueItem>();
  for (const list of lists) for (const item of list) if (!byCode.has(item.code)) byCode.set(item.code, item);
  return [...byCode.values()];
}

/** The numbered DEDUCTION items (C1–C17) — these, and only these, roll up into `tp1_amount`. */
export const TP1_ITEMS: readonly Tp1CatalogueItem[] = mergeByCode(
  countryPacks().map((p) => p.payroll.taxReliefCatalogue.items),
);
/**
 * Section D REBATE lines. Captured, stored and printed — and deliberately NOT summed into `tp1_amount`:
 * a rebate reduces the TAX, not the chargeable income the PCB kernel projects from. Rolling them into the
 * relief total would silently move every affected employee's monthly MTD, which is the one thing this
 * whole item promised not to do.
 */
export const TP1_REBATES: readonly Tp1CatalogueItem[] = mergeByCode(
  countryPacks().map((p) => p.payroll.taxReliefCatalogue.rebates),
);
/** The agency's own revision string for the form these items came from (printed on the generated PDF). */
export const TP1_FORM_CODE: string = countryPacks()[0]?.payroll.taxReliefCatalogue.formCode ?? 'TP1';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 1–12, or null. The official form's DEDUCTION MONTH box; null is a whole-year declaration. */
function validateMonth(raw: unknown, label: string): number | null {
  if (raw == null || raw === '') return null;
  const month = Math.trunc(Number(raw));
  if (!Number.isFinite(month) || month < 1 || month > 12) {
    throw new TaxReliefError(`${label} must be a month between 1 and 12.`);
  }
  return month;
}

function validateYear(assessmentYear: number): number {
  const year = Math.trunc(Number(assessmentYear));
  if (!Number.isFinite(year) || year < YEAR_MIN || year > YEAR_MAX) {
    throw new TaxReliefError(`Assessment year must be between ${YEAR_MIN} and ${YEAR_MAX}.`);
  }
  return year;
}

/** A single non-negative, finite RM amount (2-dp rounded), with an optional sourced per-category cap. */
function validateAmount(raw: unknown, label: string, cap?: number): number {
  const amount = Number(raw ?? 0);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new TaxReliefError(`${label} must be a non-negative number.`);
  }
  const rounded = round2(amount);
  if (cap != null && rounded > cap) {
    throw new TaxReliefError(`${label} must not exceed the statutory cap of RM ${cap}.`);
  }
  return rounded;
}

/**
 * Normalise + validate a per-category breakdown, returning the cleaned `categories` object and the
 * server-computed `tp1Amount` roll-up (round2 sum of the numeric categories). Every category is
 * non-negative; the four we have a sourced cap for are cap-checked; the SUM is held under `TP1_MAX`.
 * The client NEVER supplies the total — it is always recomputed here.
 */
function validateCategories(raw: Partial<Record<string, unknown>>): {
  categories: Tp1LegacyCategories;
  amount: number;
} {
  const categories: Tp1LegacyCategories = {};
  let sum = 0;
  for (const key of TP1_CATEGORY_KEYS) {
    const value = validateAmount(raw[key], key, SOURCED_CATEGORY_CAPS[key]);
    categories[key] = value;
    sum += value;
  }
  const remarks = readRemarks(raw.remarks);
  if (remarks != null) categories.remarks = remarks;
  const amount = round2(sum);
  if (amount > TP1_MAX) {
    throw new TaxReliefError(`Total relief must not exceed ${TP1_MAX}.`);
  }
  return { categories, amount };
}

/**
 * Normalise + validate a TP1 (1/2026) CATALOGUE payload (7ad37961, ADR-0081): C1–C17 with their lettered
 * sub-lines, plus the Section D rebate lines. Returns the cleaned payload and the server-computed
 * `tp1Amount` roll-up.
 *
 * ── WHAT IS CAPPED HERE, AND WHAT IS NOT ─────────────────────────────────────────────────────────────
 * This function checks THIS CLAIM ON ITS OWN: every amount non-negative and 2-dp, every sub-line against
 * the "(Limited RM…)" its own form line prints, every group against the item's ANNUAL LIMIT column. What
 * it CANNOT see is the rest of the year — the accumulated check needs the person's earlier approved
 * declarations and therefore a transaction, so it lives in `assertWithinRemaining` and runs at the write.
 *
 * ADR-0008 THROUGHOUT: `limit: null` means the agency's form prints no figure against that line. Those
 * are captured, summed and printed, and nothing blocks on them. A guessed cap on live payroll is a
 * wrong-figure defect; an absent check is a missing check. We take the missing check, deliberately.
 *
 * THE ITEM TOTAL IS ALWAYS RECOMPUTED, at every level. For an item with lettered boxes the item amount is
 * the round2 sum of those boxes — a client-sent item total is ignored exactly as a client-sent grand
 * total is. `tp1Amount` stays the single number the PCB kernel consumes, so the monthly MTD arithmetic is
 * byte-identical to what it was before this catalogue existed.
 */
function validateCatalogueCategories(raw: Partial<Record<string, unknown>>): {
  categories: Tp1Categories2026;
  amount: number;
} {
  const rawItems = (raw.items ?? {}) as Record<string, { amount?: unknown; subItems?: Record<string, unknown> }>;
  const rawRebates = (raw.rebates ?? {}) as Record<string, { amount?: unknown; subItems?: Record<string, unknown> }>;

  const readGroup = (
    defs: readonly Tp1CatalogueItem[],
    source: Record<string, { amount?: unknown; subItems?: Record<string, unknown> }>,
  ): { out: Record<string, Tp1ItemAmounts>; total: number } => {
    const out: Record<string, Tp1ItemAmounts> = {};
    let total = 0;
    for (const def of defs) {
      const entry = source[def.code] ?? {};
      let amount: number;
      let subItems: Record<string, number> | undefined;
      if (def.subItems.length > 0) {
        const subs: Record<string, number> = {};
        let sum = 0;
        for (const sub of def.subItems) {
          const label = `${def.code.toUpperCase()}(${sub.code})`;
          const v = validateAmount((entry.subItems ?? {})[sub.code], label, sub.limit ?? undefined);
          if (v > 0) subs[sub.code] = v;
          sum += v;
        }
        amount = round2(sum);
        if (Object.keys(subs).length > 0) subItems = subs;
      } else {
        amount = validateAmount(entry.amount, def.code.toUpperCase());
      }
      // The group ANNUAL LIMIT column. `perSubLimit` items (C16) have none — the form gives each of their
      // bands its own limit AND its own Current/Accumulated row, so they are two claims, not a group.
      if (def.limit != null && !def.perSubLimit && amount > def.limit) {
        throw new TaxReliefError(
          `${def.code.toUpperCase()} must not exceed its annual limit of RM ${def.limit.toFixed(2)}.`,
        );
      }
      out[def.code] = subItems ? { amount, subItems } : { amount };
      total = round2(total + amount);
    }
    return { out, total };
  };

  const items = readGroup(TP1_ITEMS, rawItems);
  // Rebates are validated and stored — and their total is DISCARDED, on purpose. See TP1_REBATES.
  const rebates = readGroup(TP1_REBATES, rawRebates);

  const categories: Tp1Categories2026 = { form: 'tp1-2026', items: items.out, rebates: rebates.out };
  const remarks = readRemarks(raw.remarks);
  if (remarks != null) categories.remarks = remarks;

  const amount = round2(items.total);
  if (amount > TP1_MAX) throw new TaxReliefError(`Total relief must not exceed ${TP1_MAX}.`);
  return { categories, amount };
}

/** Optional free-text note, trimmed and length-checked. Shared by both payload shapes. */
function readRemarks(raw: unknown): string | null {
  if (raw == null || String(raw).trim() === '') return null;
  const remarks = String(raw).trim();
  if (remarks.length > REMARKS_MAX) {
    throw new TaxReliefError(`Remarks must be at most ${REMARKS_MAX} characters.`);
  }
  return remarks;
}

/**
 * ══ THE ONE RULE FOR "WHAT IS THIS PERSON'S APPROVED TP1 FOR THIS YEAR" ══════════════════════════════
 *
 * A YEAR IS A SET OF MONTH BUCKETS, AND EACH BUCKET HAS EXACTLY ONE WINNER. `tp1_relief` is append-only
 * and approval is an UPDATE, so a CORRECTION to an already-approved month is a NEW row while the
 * superseded one keeps `status = 'approved'`. Counting both rows would break two things at once:
 *
 *   · the limit check would refuse a correction BY ITS OWN PRIOR FIGURE ("RM 2,500 has already been
 *     approved, so at most RM 0.00 can be claimed now" — the row refusing itself), and
 *   · the payroll feed would DOUBLE-COUNT the corrected month and silently over-relieve.
 *
 * So approved rows collapse per `deduction_month`: newest `created_at` wins, tie-broken on id. That is
 * the SAME collapse `listTp1DeclarationsForPersonYear` shows HR, so the screen, the server's refusal,
 * the printed ACCUMULATED column and the figure `prefillTp1FromSelfRelief` feeds cannot disagree about
 * which row is the record for a month — they all call THIS function.
 *
 * `deduction_month` NULL IS ITS OWN BUCKET, not January. Every declaration written before 7ad37961 has
 * no month, and /me self-service still declares for the whole year with no month box, so folding those
 * into January would invent a month nobody keyed and would let a January increment silently supersede a
 * whole-year declaration.
 */
export function collapseTp1ApprovedByMonth<
  T extends { id: string; deductionMonth: number | null; createdAt: Date },
>(rows: readonly T[]): T[] {
  const byMonth = new Map<number, T>();
  const newestFirst = [...rows].sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      // Tie-break on id so two runs of this can never disagree about which row won on a
      // microsecond-identical created_at. Same rule, same direction, as the month list's.
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  for (const r of newestFirst) {
    const key = r.deductionMonth ?? 0; // 0 is the month-less bucket; a real month is 1–12, so no collision
    if (!byMonth.has(key)) byMonth.set(key, r);
  }
  return [...byMonth.values()];
}

/**
 * ══ THE ONE RULE, HALF ONE: WHEN DOES A DECLARATION START COUNTING ══════════════════════════════════
 *
 * Section F's "approved for the deduction of MONTH / YEAR" box is a declaration's EFFECTIVE-FROM month.
 * A relief approved from June must not reduce March's tax, and — the whole reason this file was reworked
 * — a declaration that predates this form is effective from the month it was APPROVED, not from January.
 *
 * WHY THAT MATTERS ENOUGH TO BE ITS OWN FUNCTION (r209, item 7ad37961). The first cut of this round
 * backfilled every pre-existing declaration with `approved_month = 1` and let each side of the system
 * decide for itself what that meant. The payroll feed SUMMED those rows in full while the limit check
 * skipped them, so an RM 9,000 legacy declaration added nothing to the "Remaining" figure HR keys
 * against and its full amount to what payroll received. Neither half was wrong on its own; the CONTRACT
 * between them was. Two agent passes patched one half each and moved money the wrong way. So the rule
 * now exists exactly once, here, and both halves call it.
 *
 * THE FALLBACKS, IN ORDER, AND WHY EACH IS THE HONEST ANSWER:
 *   approved_month   Section F said so. Always wins.
 *   deduction_month  No Section F month (a hand-inserted row that never went through the approve
 *                    action): the month it was CLAIMED for is the only month it names.
 *   1                Neither: a month-less whole-year declaration (/me self-service still writes these).
 *                    Effective all year, which is what it has always meant.
 *
 * Out-of-range values are clamped rather than trusted — `approved_month` is a smallint with no CHECK, and
 * a 0 or a 13 must not silently make a declaration effective before January or never at all.
 */
export function tp1EffectiveFromMonth(r: {
  deductionMonth: number | null;
  approvedMonth: number | null;
}): number {
  const raw = r.approvedMonth ?? r.deductionMonth ?? 1;
  const m = Math.trunc(Number(raw));
  return Number.isFinite(m) ? Math.min(12, Math.max(1, m)) : 1;
}

/**
 * ══ THE ONE RULE, HALF TWO: WHAT HAS BEEN COUNTED FOR THE YEAR ══════════════════════════════════════
 *
 * ONE reduction over a person's APPROVED declarations for one assessment year, consumed by BOTH sides:
 *
 *   · `accumulatedInTx` (the screen's Accumulated/Remaining strip, the printed ACCUMULATED column and
 *     the refusal at the write) calls it for the whole year, leaving out the bucket being keyed.
 *   · `prefillTp1FromSelfRelief` (core/payroll) calls it with `throughMonth` = the batch's month and
 *     takes `.total` — the money it feeds the PCB kernel.
 *
 * There is no second implementation of "which rows count" anywhere. That is the fix: before r209 the
 * payroll feed filtered on `approved_month` in SQL and reduced with its own `.reduce()`, while this file
 * filtered on nothing and reduced with a categories-only `accumulate()`. Same two questions, two
 * answers, no error message between them.
 *
 * ── `total` AND `items`/`subItems` ARE NOT THE SAME MONEY, ON PURPOSE ────────────────────────────────
 * `total` is every counted ringgit — the authoritative `tp1_amount` roll-up, which is what payroll takes.
 * `items`/`subItems` are the C1–C17 attribution, and a legacy eight-key or scalar-only row HAS NONE:
 * there is no honest way to split "medicalInsurance" across C4, C11 and C13, and inventing one would
 * produce a refusal citing a number nobody entered. So that money counts in `total` and appears in
 * `sources` flagged `attributed: false` — it is never silently dropped, and the screen prints it under
 * "already counted for this year" so the remaining figure is not a number HR has to trust blindly.
 *
 * ── `sources` IS THE PROVENANCE, NOT A DEBUG AID ────────────────────────────────────────────────────
 * One entry per COUNTED declaration, month order, carrying its deduction month, its Section F approved
 * month, the effective-from the rule above produced, its money and whether that money is attributed. The
 * screen renders it; the reconciliation walks it; a reader who wonders where a figure came from reads it.
 */
export type Tp1CountedSource = {
  id: string;
  /** The form's DEDUCTION MONTH box. Null on a whole-year declaration (every pre-r209 row). */
  deductionMonth: number | null;
  /** Section F's approved-for month, exactly as stored. Null on a row that never went through approval. */
  approvedMonth: number | null;
  /** `tp1EffectiveFromMonth` applied — the month this declaration starts feeding payroll. */
  effectiveFrom: number;
  /** The authoritative `tp1_amount` roll-up for this declaration. */
  amount: number;
  /** True ⇒ this row's money is also in `items`/`subItems`. False ⇒ it counts in `total` only. */
  attributed: boolean;
};

export type Tp1Accumulated = {
  /** Per item code (c1…c17, d1) — the sum of that item's `amount` across the counted rows. */
  items: Record<string, number>;
  /** Per item code, then per lettered sub-line code. */
  subItems: Record<string, Record<string, number>>;
};

export type Tp1Counted = Tp1Accumulated & {
  /** Every counted ringgit — attributed or not. THE figure `prefillTp1FromSelfRelief` feeds. */
  total: number;
  /** The part of `total` that carries no C1–C17 attribution (legacy eight-key and scalar-only rows). */
  unattributedTotal: number;
  /** Where `total` came from, one entry per counted declaration, in effective-from then month order. */
  sources: Tp1CountedSource[];
};

export type Tp1CountableRow = {
  id: string;
  deductionMonth: number | null;
  approvedMonth: number | null;
  createdAt: Date;
  tp1Amount: number | string;
  categories: Tp1Categories | null;
};

export type Tp1CountOptions = {
  /**
   * Count only declarations effective through this month (`tp1EffectiveFromMonth <= throughMonth`).
   * `null` ⇒ the whole year, which is what an ANNUAL limit check has to ask: a relief approved from June
   * still consumes 2026's allowance when HR keys March, even though payroll will not take it until June.
   */
  throughMonth: number | null;
  /**
   * Leave one deduction-month bucket out. The screen and the write pass the month being keyed, because
   * "already claimed" means the OTHER months — otherwise correcting an approved month would be refused
   * by the very figure it replaces. Absent ⇒ count every bucket, which is what payroll wants.
   * A `deductionMonth` of `null` is the month-LESS bucket and is a legitimate thing to exclude, so this
   * is an object rather than a nullable number: absence and "the null bucket" are different requests.
   */
  excluding?: { deductionMonth: number | null };
};

export function tp1CountForYear(
  approvedRows: readonly Tp1CountableRow[],
  opts: Tp1CountOptions,
): Tp1Counted {
  const through = opts.throughMonth == null ? null : Math.trunc(Number(opts.throughMonth));
  // ⚠️ NARROW TO WHAT WAS IN FORCE **BEFORE** COLLAPSING, NOT AFTER. The order of these two steps is the
  // whole correctness of this function, and getting it the other way round loses money silently.
  //
  // `collapseTp1ApprovedByMonth` is newest-wins per deduction month. Ask it first and it hands back the
  // LATEST row for March — which may be a correction whose Section F effective month is August. Filtering
  // that result by `effectiveFrom <= May` then drops it, and March contributes NOTHING to May, even though
  // the row it superseded was approved from March and was genuinely in force all along. A correction keyed
  // in August therefore reaches back and deletes the original's money from every month between.
  //
  // Concretely, and this is reachable through the shipped UI: an employee with March RM 1,000 (approved
  // from March) plus an August correction to RM 1,500 (approved from August) counted 0 through May —
  // HR opens /payroll/transactions/tp1/2026/3, submits the correction, types 8 in the free 1–12 Section F
  // box, and every batch for March–July created or reprocessed afterwards feeds 0 instead of 1,000.
  //
  // Narrowing first asks the right question — "of the declarations in force by `through`, which is newest
  // for each month" — so a later correction supersedes its predecessor only from the month it takes
  // effect, and the earlier figure keeps standing until then. r201 filtered before collapsing for exactly
  // this reason (c0fbe661: WHERE approvedMonth IS NULL OR approvedMonth <= month, then collapse and sum);
  // the r209 rework reordered them and that was the regression.
  const inForce =
    through == null ? approvedRows : approvedRows.filter((r) => tp1EffectiveFromMonth(r) <= through);
  const counted = collapseTp1ApprovedByMonth(inForce)
    .filter((r) => (opts.excluding ? r.deductionMonth !== opts.excluding.deductionMonth : true))
    .sort(
      (a, b) =>
        tp1EffectiveFromMonth(a) - tp1EffectiveFromMonth(b) ||
        (a.deductionMonth ?? 0) - (b.deductionMonth ?? 0),
    );

  const out: Tp1Counted = { items: {}, subItems: {}, total: 0, unattributedTotal: 0, sources: [] };
  for (const row of counted) {
    const amount = round2(Number(row.tp1Amount ?? 0));
    const cat = isTp1Categories2026(row.categories) ? row.categories : null;
    const attributed = cat != null;
    out.total = round2(out.total + amount);
    if (!attributed) out.unattributedTotal = round2(out.unattributedTotal + amount);
    out.sources.push({
      id: row.id,
      deductionMonth: row.deductionMonth,
      approvedMonth: row.approvedMonth,
      effectiveFrom: tp1EffectiveFromMonth(row),
      amount,
      attributed,
    });
    if (!cat) continue; // legacy row — its money is in `total`; see the note above
    for (const source of [cat.items ?? {}, cat.rebates ?? {}]) {
      for (const [code, entry] of Object.entries(source)) {
        out.items[code] = round2((out.items[code] ?? 0) + Number(entry?.amount ?? 0));
        for (const [sub, v] of Object.entries(entry?.subItems ?? {})) {
          const bucket = (out.subItems[code] ??= {});
          bucket[sub] = round2((bucket[sub] ?? 0) + Number(v ?? 0));
        }
      }
    }
  }
  return out;
}

/**
 * The check the reporter actually asked for: "the system stops an over-claim before payroll ever sees
 * it". Accumulated + this claim against the annual limit, per item AND per lettered sub-line, with the
 * SHORTFALL named in the message — "by RM 300.00" is actionable; "invalid" is not.
 *
 * Only lines with a sourced limit are checked (ADR-0008). A `perSubLimit` item has no group limit to
 * check and its bands are caught by the sub-line pass below, which is the same pass that catches an
 * ordinary item's "(Limited RM…)" sub-line — one rule, not two.
 */
function assertWithinRemaining(categories: Tp1Categories2026, prior: Tp1Accumulated): void {
  const check = (label: string, limit: number | null, claim: number, already: number) => {
    if (limit == null || claim <= 0) return;
    const total = round2(already + claim);
    if (total <= limit) return;
    const over = round2(total - limit);
    throw new TaxReliefError(
      `${label} exceeds its annual limit of RM ${limit.toFixed(2)} by RM ${over.toFixed(2)}. ` +
        `RM ${already.toFixed(2)} has already been approved for this assessment year, ` +
        `so at most RM ${Math.max(0, round2(limit - already)).toFixed(2)} can be claimed now.`,
    );
  };
  for (const def of [...TP1_ITEMS, ...TP1_REBATES]) {
    const entry = (categories.items[def.code] ?? categories.rebates?.[def.code]) as Tp1ItemAmounts | undefined;
    if (!entry) continue;
    if (!def.perSubLimit) {
      check(def.code.toUpperCase(), def.limit, Number(entry.amount ?? 0), prior.items[def.code] ?? 0);
    }
    for (const sub of def.subItems) {
      check(
        `${def.code.toUpperCase()}(${sub.code})`,
        sub.limit,
        Number((entry.subItems ?? {})[sub.code] ?? 0),
        prior.subItems[def.code]?.[sub.code] ?? 0,
      );
    }
  }
}

/**
 * Resolve the write input into a validated year, roll-up amount, and (optional) categories.
 * - When `categories` carries `form: 'tp1-2026'`, the CATALOGUE path runs (C1–C17 + Section D).
 * - When `categories` is the legacy eight-key object, the legacy path runs UNCHANGED. Rows written
 *   before 7ad37961 keep being readable, editable and payroll-feeding exactly as they were — this is the
 *   branch that makes that true, and it is why `TP1_CATEGORY_KEYS` is still exported from db/schema.
 * - When only a scalar `tp1Amount` is supplied (legacy / API callers), it is validated as a single amount
 *   and no `categories` breakdown is stored (row stays scalar-only, categories NULL).
 */
function resolveInput(p: Tp1WriteInput): { year: number; amount: number; categories: Tp1Categories | null } {
  const year = validateYear(p.assessmentYear);
  if (p.categories) {
    const { categories, amount } =
      (p.categories as { form?: string }).form === 'tp1-2026'
        ? validateCatalogueCategories(p.categories)
        : validateCategories(p.categories);
    return { year, amount, categories };
  }
  const amount = validateAmount(p.tp1Amount, 'Relief amount');
  if (amount > TP1_MAX) throw new TaxReliefError(`Relief amount must not exceed ${TP1_MAX}.`);
  return { year, amount, categories: null };
}

export type Tp1WriteInput = {
  assessmentYear: number;
  /** Scalar total — accepted for legacy/API callers when no `categories` breakdown is provided. */
  tp1Amount?: number;
  /** Structured breakdown: the 2026 catalogue payload (a2f1fa24 legacy shape still accepted). */
  categories?: Partial<Record<string, unknown>>;
  /** The official form's DEDUCTION MONTH (1–12). Absent ⇒ a whole-year declaration, as before. */
  deductionMonth?: number | string | null;
  /**
   * Section E — the employee declaration tick, as an EXPLICIT boolean.
   *
   * RULE 17: the transport never reads this by presence. A hidden input is ALWAYS submitted, so a form
   * that asked "did the `declarationAccepted` field arrive?" would answer yes for an unticked box. The
   * action reads the VALUE ('yes' / 'no') and passes the decision here already made.
   */
  declarationAccepted?: boolean;
};

/** Every state a TP1 record can be in (migration 0448). */
export type Tp1Status = 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled';

export type Tp1Row = {
  id: string;
  assessmentYear: number;
  status: Tp1Status;
  tp1Amount: number;
  categories: Tp1Categories | null;
  submittedAt: Date | null;
  createdAt: Date;
  /** 0449 — the form's DEDUCTION MONTH; null on every declaration written before this round. */
  deductionMonth: number | null;
  /** Section E: when the employee confirmed the declaration. */
  declaredAt: Date | null;
  /** Section F. */
  approvedBy: string | null;
  approvedAt: Date | null;
  approvedMonth: number | null;
  approvedYear: number | null;
  approverPosition: string | null;
  /**
   * Section F's "Name" box — the approver, RESOLVED THROUGH `approved_by` rather than copied onto the
   * row, so a renamed user is never two different names on two different screens (db/schema.ts says so
   * at the column, and this is the join that makes the sentence true rather than aspirational).
   *
   * NULL when nobody has approved yet, when the approving login has no person behind it (a service
   * principal), or when RLS hides that person from THIS reader — the left joins keep the declaration
   * visible either way, and the screen and the printed form both render an absent name as blank rather
   * than as a name they invented.
   */
  approvedByName: string | null;
};

/** The column list every single-row read shares, so a new column can never reach one read and not another. */
const TP1_ROW_COLUMNS = {
  id: tp1Relief.id,
  assessmentYear: tp1Relief.assessmentYear,
  status: tp1Relief.status,
  tp1Amount: tp1Relief.tp1Amount,
  categories: tp1Relief.categories,
  submittedAt: tp1Relief.submittedAt,
  createdAt: tp1Relief.createdAt,
  deductionMonth: tp1Relief.deductionMonth,
  declaredAt: tp1Relief.declaredAt,
  approvedBy: tp1Relief.approvedBy,
  approvedAt: tp1Relief.approvedAt,
  approvedMonth: tp1Relief.approvedMonth,
  approvedYear: tp1Relief.approvedYear,
  approverPosition: tp1Relief.approverPosition,
  // Section F's Name box. See Tp1Row.approvedByName — the pair of left joins below is part of this
  // column list, so `withApprover(tx.select(TP1_ROW_COLUMNS))` is the only way any read may spell it.
  // Section F's Name box — see Tp1Row.approvedByName. Every read that selects this list must chain
  //   .leftJoin(appUser, eq(appUser.id, tp1Relief.approvedBy))
  //   .leftJoin(person, eq(person.id, appUser.personId))
  // LEFT, never inner: a declaration with no approver, or one whose approver RLS hides from this
  // reader, must still come back with its own figures intact.
  approvedByName: person.fullName,
} as const;

type Tp1RowRaw = { [K in keyof typeof TP1_ROW_COLUMNS]: unknown };

const toTp1Row = (row: Tp1RowRaw): Tp1Row =>
  ({ ...row, tp1Amount: Number(row.tp1Amount), categories: row.categories ?? null }) as Tp1Row;

function requirePerson(ctx: SessionContext): string {
  if (!ctx.personId) throw new TaxReliefError('This account is not linked to an employee profile.');
  return ctx.personId;
}

/**
 * Admin-on-behalf gate (Standardize-TP1, item 0cde61f3). The `*ForPerson` entry points let an HR admin
 * open/maintain ANOTHER employee's TP1 declaration — the SAME single tp1_relief master row the employee
 * edits on /me, so there is exactly one declaration per person per year (no duplicate store). The DB is the
 * real backstop: the tp1_relief RLS policy is `app.can_see_person(person_id)` for both USING and WITH CHECK
 * (self OR admin), so a non-admin session physically cannot read or write a peer's row. This service gate
 * fails fast BEFORE the DB, and `personId` is always resolved server-side from the selected employment —
 * never a raw form field. actorOf(ctx) records the HR admin as the event actor.
 */
function requireAdminTarget(ctx: SessionContext, personId: string | null | undefined): string {
  if (!isAdmin(ctx)) {
    throw new TaxReliefError('Only an HR administrator can maintain another employee’s TP1 declaration.');
  }
  if (!personId) throw new TaxReliefError('Select an employee before maintaining a TP1 declaration.');
  return personId;
}

/** The latest TP1 row for the caller for an assessment year (RLS-scoped). Read-only, no event. */
export function getTp1(
  ctx: SessionContext,
  p: { assessmentYear: number },
): Promise<Tp1Row | null> {
  return getTp1ForPersonId(ctx, requirePerson(ctx), p.assessmentYear);
}

/** Admin-on-behalf read: the latest TP1 row for a SELECTED employee + year (same master row the employee
 *  reads). Admin-gated; RLS confines the read to self+admin. Read-only, no event. */
export async function getTp1ForPerson(
  ctx: SessionContext,
  p: { personId: string; assessmentYear: number },
): Promise<Tp1Row | null> {
  return getTp1ForPersonId(ctx, requireAdminTarget(ctx, p.personId), p.assessmentYear);
}

/** Internal person-keyed read shared by the self and admin entry points (identical query + shape). */
function getTp1ForPersonId(
  ctx: SessionContext,
  personId: string,
  assessmentYear: number,
): Promise<Tp1Row | null> {
  const year = Math.trunc(Number(assessmentYear));
  return withTenant(ctx, async (tx): Promise<Tp1Row | null> => {
    const [row] = await tx
      .select(TP1_ROW_COLUMNS)
      .from(tp1Relief)
      .leftJoin(appUser, eq(appUser.id, tp1Relief.approvedBy))
      .leftJoin(person, eq(person.id, appUser.personId))
      .where(and(eq(tp1Relief.personId, personId), eq(tp1Relief.assessmentYear, year)))
      .orderBy(desc(tp1Relief.createdAt))
      .limit(1);
    return row ? toTp1Row(row) : null;
  });
}

/** One TP1 row by id, for a person already resolved by the caller. Read-only, RLS-scoped, no event. */
function getTp1RowById(ctx: SessionContext, personId: string, id: string): Promise<Tp1Row | null> {
  return withTenant(ctx, async (tx): Promise<Tp1Row | null> => {
    const [row] = await tx
      .select(TP1_ROW_COLUMNS)
      .from(tp1Relief)
      .leftJoin(appUser, eq(appUser.id, tp1Relief.approvedBy))
      .leftJoin(person, eq(person.id, appUser.personId))
      .where(and(eq(tp1Relief.id, id), eq(tp1Relief.personId, personId)))
      .limit(1);
    return row ? toTp1Row(row) : null;
  });
}

/** Admin-on-behalf read of ONE declaration by id (the month form's own read). Admin-gated. */
export async function getTp1ByIdForPerson(
  ctx: SessionContext,
  p: { personId: string; id: string },
): Promise<Tp1Row | null> {
  return getTp1RowById(ctx, requireAdminTarget(ctx, p.personId), p.id);
}

/**
 * The latest APPROVED TP1 for a person + year, effective for a given deduction month — i.e. the WINNING
 * declaration for that point in the year (7ad37961; was `getLatestSubmittedTp1` before the approval gate
 * existed).
 *
 * ⚠️ THIS IS ONE ROW, NOT THE YEAR'S TOTAL. Since a year now holds up to twelve declarations and the
 * screen teaches HR to enter each month's INCREMENT, the figure `prefillTp1FromSelfRelief` feeds is the
 * SUM of the winning row per effective month (`tp1CountForYear`) — not this row. Use this to ask "is
 * there an approved declaration in force for month M, and which row is it"; never as the annual relief.
 *
 * TWO PREDICATES, AND BOTH MATTER:
 *   status = 'approved'         Section F consent gates the feed. A submitted-but-unapproved declaration
 *                               is an employee's claim, not an employer's instruction to payroll.
 *   tp1EffectiveFromMonth <= M  the form's own effective-from box. A relief approved from June must not
 *                               reduce March's tax.
 *
 * ⚠️ THE SECOND PREDICATE IS APPLIED IN TYPESCRIPT, DELIBERATELY (r209). It used to be a SQL
 * `or(isNull(approved_month), approved_month <= month)`, which is a SECOND spelling of
 * `tp1EffectiveFromMonth` — and a second spelling is how this round's defect happened in the first
 * place. The rule has exactly one home; every caller reads it from there. The row count per person-year
 * is at most twelve, so filtering after the read costs nothing.
 *
 * THE MIGRATION IS WHAT MAKES THIS SAFE ON LIVE DATA. Every declaration that existed before this round is
 * 'submitted', so this predicate would have withheld relief from all of them; 0449 stamps them approved,
 * effective from the month they were approved. If that backfill did not run, this function is where the
 * lights go out — and silently, because "no approved declaration" is indistinguishable from "nobody
 * declared anything".
 *
 * `month` is optional so a historical view can ask "what is approved for this year at all". RLS-scoped
 * (self + admin). Read-only, no event.
 */
export function getLatestApprovedTp1(
  ctx: SessionContext,
  p: { personId: string; assessmentYear: number; deductionMonth?: number },
): Promise<Tp1Row | null> {
  const year = Math.trunc(Number(p.assessmentYear));
  const month = p.deductionMonth == null ? null : Math.trunc(Number(p.deductionMonth));
  return withTenant(ctx, async (tx): Promise<Tp1Row | null> => {
    const rows = await tx
      .select(TP1_ROW_COLUMNS)
      .from(tp1Relief)
      .leftJoin(appUser, eq(appUser.id, tp1Relief.approvedBy))
      .leftJoin(person, eq(person.id, appUser.personId))
      .where(
        and(
          eq(tp1Relief.personId, p.personId),
          eq(tp1Relief.assessmentYear, year),
          eq(tp1Relief.status, 'approved'),
        ),
      )
      .orderBy(desc(tp1Relief.createdAt));
    const inForce = rows
      .map(toTp1Row)
      .filter((r) => month == null || tp1EffectiveFromMonth(r) <= month);
    return inForce[0] ?? null;
  });
}

/**
 * The ACCUMULATED column of the official form: what this person already has APPROVED this assessment
 * year, per item and per lettered sub-line, EXCLUDING the deduction month being declared. Drives the
 * limit / current / accumulated / remaining strip on the declaration screen, the ACCUMULATED column on
 * the printed form, AND the refusal at the write.
 *
 * `deductionMonth` IS REQUIRED, AND THAT IS THE POINT. Every surface has to name the month it is asking
 * about, because "already claimed" means the OTHER months: the HR month page passes its own month, the
 * PDF passes the month of the row it prints, /me passes `null` (self-service declares for the year and
 * writes a month-less row), and `submitTp1ForPersonId` passes the month it is about to write. All four
 * land in `accumulatedInTx`, so the number the screen shows as remaining IS the number the server
 * enforces — one implementation, not two that agree today.
 *
 * IT RETURNS MONEY AND PROVENANCE, NOT JUST ATTRIBUTION (r209). `total` is every counted ringgit and
 * `sources` says where each came from, so the screen can print what has already been counted for the
 * year — including the declarations carried forward from before this form, whose money reaches payroll
 * but attributes to no numbered item. That figure used to be invisible on the screen and present in the
 * payslip; see `tp1CountForYear`.
 *
 * THE LIMIT CHECK ASKS FOR THE WHOLE YEAR (`throughMonth: null`), NOT "as at this month". An annual
 * limit is annual: a relief already approved from June consumes 2026's allowance even while HR is keying
 * March, and hiding it would let the year's total exceed the limit one month at a time. The payroll feed
 * asks the SAME function for the same year with `throughMonth` set to the batch's month, because what it
 * needs is the money in force NOW. One rule, two questions, one implementation.
 */
export function getTp1AccumulatedForPerson(
  ctx: SessionContext,
  p: { personId: string; assessmentYear: number; deductionMonth: number | null },
): Promise<Tp1Counted> {
  return readAccumulated(ctx, requireAdminTarget(ctx, p.personId), p.assessmentYear, p.deductionMonth);
}

/** The employee's own view of the same figures on /me (month-less: self-service declares for the year). */
export function getTp1Accumulated(
  ctx: SessionContext,
  p: { assessmentYear: number; deductionMonth: number | null },
): Promise<Tp1Counted> {
  return readAccumulated(ctx, requirePerson(ctx), p.assessmentYear, p.deductionMonth);
}

function readAccumulated(
  ctx: SessionContext,
  personId: string,
  assessmentYear: number,
  deductionMonth: number | null,
): Promise<Tp1Counted> {
  const year = Math.trunc(Number(assessmentYear));
  return withTenant(ctx, (tx) => accumulatedInTx(tx, personId, year, deductionMonth));
}

/**
 * The APPROVED declarations of one person for one assessment year, in the shape `tp1CountForYear` reduces.
 * EVERY caller of the rule — this file's limit check, the screen, the printed form, the payroll feed and
 * the reconciliation — starts from this column list, so a column the rule needs can never reach one side
 * and not the other. The month filter is deliberately NOT in SQL: `tp1EffectiveFromMonth` is the rule and
 * it lives in TypeScript, and a WHERE clause repeating it is exactly the second implementation this round
 * exists to delete.
 */
export const TP1_COUNTABLE_COLUMNS = {
  id: tp1Relief.id,
  deductionMonth: tp1Relief.deductionMonth,
  approvedMonth: tp1Relief.approvedMonth,
  createdAt: tp1Relief.createdAt,
  tp1Amount: tp1Relief.tp1Amount,
  categories: tp1Relief.categories,
} as const;

/** The WHERE every counted read shares: this person, this assessment year, approved only. */
export const tp1CountableWhere = (personId: string, assessmentYear: number) =>
  and(
    eq(tp1Relief.personId, personId),
    eq(tp1Relief.assessmentYear, assessmentYear),
    eq(tp1Relief.status, 'approved'),
  );

/**
 * THE function — the read every surface and the write itself go through. Kept `tx`-shaped so the refusal
 * inside `submitTp1ForPersonId` runs the identical query in its own transaction rather than a
 * second implementation that drifts.
 */
async function accumulatedInTx(
  tx: Tx,
  personId: string,
  assessmentYear: number,
  deductionMonth: number | null,
): Promise<Tp1Counted> {
  const rows = await tx
    .select(TP1_COUNTABLE_COLUMNS)
    .from(tp1Relief)
    .where(tp1CountableWhere(personId, assessmentYear));
  const month = deductionMonth == null ? null : Math.trunc(Number(deductionMonth));
  return tp1CountForYear(rows, { throughMonth: null, excluding: { deductionMonth: month } });
}

/**
 * ══ THE RECONCILIATION THE PLAN PROMISED ════════════════════════════════════════════════════════════
 *
 * For one person and one assessment year: month by month, what the SCREEN accounts for and what the
 * PAYROLL FEED takes. Both come from `tp1CountForYear` over the same rows, which is the point — before
 * r209 they came from two implementations that disagreed by the whole of every legacy declaration, and
 * nothing anywhere compared them.
 *
 * `agrees` is therefore true by construction TODAY, and that is the guard, not a weakness: the day
 * somebody re-forks one of the two paths this read starts reporting `false`, and the round's
 * reconciliation test (test/tp1-counted-contract.test.ts) drives the REAL payroll write against these
 * figures so the equality is proved end to end rather than asserted in prose.
 *
 * Admin-gated and RLS-scoped like every other read here. No event: it is a read.
 */
export type Tp1MonthReconciliation = {
  month: number;
  /** Money the screen accounts for as in force by this month (`sources` with effectiveFrom <= month). */
  counted: number;
  /** Money `prefillTp1FromSelfRelief` feeds a batch for this month. */
  fed: number;
  agrees: boolean;
};

export type Tp1Reconciliation = {
  personId: string;
  assessmentYear: number;
  months: Tp1MonthReconciliation[];
  /** Every counted declaration for the year, whatever month it becomes effective. */
  sources: Tp1CountedSource[];
  /** The part of the year's money that carries no C1–C17 attribution. */
  unattributedTotal: number;
  /** True when every month agrees — the release gate the plan promised. */
  agrees: boolean;
};

export function reconcileTp1ForYear(
  ctx: SessionContext,
  p: { personId: string; assessmentYear: number },
): Promise<Tp1Reconciliation> {
  const personId = requireAdminTarget(ctx, p.personId);
  const year = Math.trunc(Number(p.assessmentYear));
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select(TP1_COUNTABLE_COLUMNS)
      .from(tp1Relief)
      .where(tp1CountableWhere(personId, year));
    const whole = tp1CountForYear(rows, { throughMonth: null });
    const months: Tp1MonthReconciliation[] = [];
    for (let month = 1; month <= 12; month++) {
      const counted = round2(
        whole.sources.filter((s) => s.effectiveFrom <= month).reduce((sum, s) => sum + s.amount, 0),
      );
      const fed = tp1CountForYear(rows, { throughMonth: month }).total;
      months.push({ month, counted, fed, agrees: counted === fed });
    }
    return {
      personId,
      assessmentYear: year,
      months,
      sources: whole.sources,
      unattributedTotal: whole.unattributedTotal,
      agrees: months.every((m) => m.agrees),
    };
  });
}

/**
 * One row per ASSESSMENT YEAR for a selected employee — the TP1 Relief screen's "Transaction history"
 * (feedback 3e3d3fb2). Admin-gated (requireAdminTarget); RLS confines the read to self+admin.
 *
 * WHAT A ROW IS, AND WHY IT IS NOT ONE PER tp1_relief ROW. `tp1_relief` is APPEND-ONLY: a correction
 * INSERTs another submitted row and the LATEST one wins (submitTp1ForPersonId, and the
 * `orderBy(desc(createdAt)).limit(1)` in getTp1ForPersonId that every read goes through). The superseded
 * rows are version history, not records — listing them would show HR three "2026" lines of which only one
 * is the declaration, and clicking any of them would open the same single per-year form. So this collapses
 * to the winning row per year and reports how many versions sit behind it (`versions`), which is the fact
 * a reader actually wants from the older rows.
 *
 * THE LATEST-WINS RULE IS COPIED, NOT REINVENTED: newest `created_at` within the year, tie-broken on `id`
 * so two runs of this list can never disagree about which row won. (getTp1ForPersonId does not tie-break —
 * on the microsecond-identical created_at that would need, Postgres picks; the tie-break here only makes
 * THIS list deterministic, it cannot make the pair disagree in any case that is not already arbitrary.)
 *
 * `tp1_relief` HAS NO updated_at COLUMN — a draft is UPDATEd in place, so "last saved" for a draft is its
 * created_at (when the draft was started) and for a submitted row its submitted_at. Both are returned; the
 * screen decides. Adding an updated_at is a migration, deliberately not taken for a UI change.
 *
 * Read-only, no domain event (pure SELECT).
 */
export type Tp1DeclarationSummary = {
  id: string;
  assessmentYear: number;
  status: Tp1Status;
  /** The authoritative server-computed annual total on the winning row. */
  tp1Amount: number;
  submittedAt: Date | null;
  createdAt: Date;
  /** How many append-only rows exist for this year, the winning one included (1 ⇒ no corrections). */
  versions: number;
};

export async function listTp1DeclarationsForPerson(
  ctx: SessionContext,
  p: { personId: string },
): Promise<Tp1DeclarationSummary[]> {
  const personId = requireAdminTarget(ctx, p.personId);
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: tp1Relief.id,
        assessmentYear: tp1Relief.assessmentYear,
        status: tp1Relief.status,
        tp1Amount: tp1Relief.tp1Amount,
        submittedAt: tp1Relief.submittedAt,
        createdAt: tp1Relief.createdAt,
      })
      .from(tp1Relief)
      .where(eq(tp1Relief.personId, personId))
      .orderBy(desc(tp1Relief.assessmentYear), desc(tp1Relief.createdAt), desc(tp1Relief.id));
    const byYear = new Map<number, Tp1DeclarationSummary>();
    for (const r of rows) {
      const won = byYear.get(r.assessmentYear);
      if (won) {
        won.versions += 1; // an older, superseded row — counted, never listed
        continue;
      }
      byYear.set(r.assessmentYear, { ...r, tp1Amount: Number(r.tp1Amount), versions: 1 });
    }
    return [...byYear.values()];
  });
}

/**
 * ONE ROW PER DEDUCTION MONTH for a selected employee within ONE assessment year — the TP1 Relief
 * screen's record list as the reporter sketched it (January / February / March, with a status, the
 * current relief and a View or Edit).
 *
 * ── THIS DELIBERATELY REVERSES HALF OF THE 3e3d3fb2 RULE, AND KEEPS THE OTHER HALF ──────────────────
 * `listTp1DeclarationsForPerson` above collapses to ONE ROW PER ASSESSMENT YEAR, and its header explains
 * why: `tp1_relief` is append-only, so listing every row would show HR three "2026" lines of which only
 * one is the declaration. That reasoning was correct for a world with one declaration per year, and item
 * 7ad37961 changes that world: the official form has a DEDUCTION MONTH box, so a year legitimately holds
 * up to twelve declarations and collapsing them would hide eleven real records.
 *
 * WHAT IS KEPT, UNCHANGED, IS THE PART THAT WAS NEVER ABOUT YEARS: a CORRECTION must not produce two
 * competing lines for the same month. So this collapses per MONTH — newest created_at wins within the
 * month, tie-broken on id so two runs can never disagree — and reports the superseded rows as `versions`.
 * That is the same rule, applied at the grain the form actually has.
 *
 * ROWS WITH NO MONTH ARE NOT INVENTED INTO ONE. Every declaration written before this round has
 * `deduction_month` NULL: it was a whole-year declaration and was never keyed against a month. They
 * collapse into a single month-less line (sorted last) that the screen labels for what it is. Stamping
 * them "January" would be writing a fact about a statutory record that nobody entered.
 *
 * Admin-gated (requireAdminTarget); RLS confines the read to self + admin. Read-only, no event.
 */
export type Tp1MonthDeclaration = Tp1DeclarationSummary & {
  /** 1–12, or null for a pre-7ad37961 whole-year declaration. */
  deductionMonth: number | null;
  approvedAt: Date | null;
  approvedMonth: number | null;
};

export async function listTp1DeclarationsForPersonYear(
  ctx: SessionContext,
  p: { personId: string; assessmentYear: number },
): Promise<Tp1MonthDeclaration[]> {
  const personId = requireAdminTarget(ctx, p.personId);
  const year = validateYear(p.assessmentYear);
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: tp1Relief.id,
        assessmentYear: tp1Relief.assessmentYear,
        status: tp1Relief.status,
        tp1Amount: tp1Relief.tp1Amount,
        submittedAt: tp1Relief.submittedAt,
        createdAt: tp1Relief.createdAt,
        deductionMonth: tp1Relief.deductionMonth,
        approvedAt: tp1Relief.approvedAt,
        approvedMonth: tp1Relief.approvedMonth,
      })
      .from(tp1Relief)
      .where(and(eq(tp1Relief.personId, personId), eq(tp1Relief.assessmentYear, year)))
      .orderBy(desc(tp1Relief.createdAt), desc(tp1Relief.id));
    const byMonth = new Map<number, Tp1MonthDeclaration>();
    for (const r of rows) {
      // 0 is the bucket for a month-less legacy row: a real month is 1–12, so it cannot collide.
      const key = r.deductionMonth ?? 0;
      const won = byMonth.get(key);
      if (won) {
        won.versions += 1; // an older, superseded row for the SAME month — counted, never listed
        continue;
      }
      byMonth.set(key, { ...r, tp1Amount: Number(r.tp1Amount), versions: 1 });
    }
    // January first, and the month-less legacy line last rather than ahead of January.
    return [...byMonth.values()].sort((a, b) => (a.deductionMonth ?? 99) - (b.deductionMonth ?? 99));
  });
}

/**
 * SECTIONS A AND B of the official form, read from the records that already hold them (7ad37961).
 *
 * "These should normally be system-populated rather than manually re-keyed" is the reporter's own
 * sentence, and it is the whole design of these two sections: A1/A2 come from the employing company's
 * Malaysian statutory record, B1/B2/B3 from the person and their statutory profile. The screen renders
 * them READ-ONLY. Nobody types a tax number onto a form when the system already knows it, and nobody
 * gets to type a DIFFERENT one.
 *
 * EVERY FIELD IS NULLABLE and an absent value renders as an em dash rather than a blank that looks
 * filled. A2 in particular: `myinvois_tin` is the TIN the form asks for and `lhdn_employer_no` is the
 * "E" number, which is NOT the same identifier — so the TIN falls back to nothing rather than to the E
 * number. Printing an E number in a TIN box is a wrong-figure defect on a statutory form.
 *
 * B2 is "Identity Card/Passport Number": the IC when there is one, otherwise the passport, which is the
 * order the form's own slash implies and the order every other MY statutory read in this repo uses.
 *
 * RLS-scoped through withTenant; the caller has already resolved and scope-guarded the employment.
 * Read-only, no event.
 */
export type Tp1FormIdentity = {
  employer: { name: string; tin: string | null } | null;
  employee: { name: string; idNumber: string | null; tin: string | null };
};

export function getTp1FormIdentity(
  ctx: SessionContext,
  p: { personId: string; companyId?: string | null },
): Promise<Tp1FormIdentity> {
  return withTenant(ctx, async (tx): Promise<Tp1FormIdentity> => {
    // The HR screen already knows which employment the reader selected and passes its company. The
    // employee's own screen does not, so the company is resolved from their employment here rather than
    // making /me guess — and a person with no employment simply has no Section A, which is the honest
    // answer for an account not linked to one.
    const companyId =
      p.companyId ??
      (
        await tx
          .select({ companyId: employment.companyId })
          .from(employment)
          .where(eq(employment.personId, p.personId))
          .orderBy(desc(employment.hiredOn))
          .limit(1)
      )[0]?.companyId ??
      null;
    const [[co], [ident], [who]] = await Promise.all([
      companyId
        ? tx
        // A1 is the EMPLOYER'S NAME on a statutory form, so it is the LEGAL name, never a trading
        // short name. `company.legal_name` is the only name this table holds and it is the right one.
            .select({ name: company.legalName, tin: companyStatutoryMy.myinvoisTin })
            .from(company)
            .leftJoin(companyStatutoryMy, eq(companyStatutoryMy.companyId, company.id))
            .where(eq(company.id, companyId))
            .limit(1)
        : Promise.resolve([]),
      tx
        .select({
          ic: employeeStatutoryMy.icNumber,
          passport: employeeStatutoryMy.passportNumber,
          taxNumber: employeeStatutoryMy.taxNumber,
        })
        .from(employeeStatutoryMy)
        .where(eq(employeeStatutoryMy.personId, p.personId))
        .limit(1),
      tx.select({ fullName: person.fullName }).from(person).where(eq(person.id, p.personId)).limit(1),
    ]);
    return {
      employer: co ? { name: co.name, tin: co.tin ?? null } : null,
      employee: {
        name: who?.fullName ?? '',
        idNumber: ident?.ic?.trim() || ident?.passport?.trim() || null,
        tin: ident?.taxNumber?.trim() || null,
      },
    };
  });
}

/** Distinct assessment years the caller has TP1 rows for (drives the year selector + historical view). */
export function listTp1Years(ctx: SessionContext): Promise<number[]> {
  return listTp1YearsForPersonId(ctx, requirePerson(ctx));
}

/** Admin-on-behalf: distinct assessment years a SELECTED employee has TP1 rows for. Admin-gated. */
export async function listTp1YearsForPerson(ctx: SessionContext, p: { personId: string }): Promise<number[]> {
  return listTp1YearsForPersonId(ctx, requireAdminTarget(ctx, p.personId));
}

function listTp1YearsForPersonId(ctx: SessionContext, personId: string): Promise<number[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .selectDistinct({ year: tp1Relief.assessmentYear })
      .from(tp1Relief)
      .where(eq(tp1Relief.personId, personId))
      .orderBy(desc(tp1Relief.assessmentYear));
    return rows.map((r) => r.year);
  });
}

/**
 * Save the single editable DRAFT for an assessment year: UPDATE the open draft if present, else INSERT.
 * A submitted row is never touched here (a submitted year is corrected via `submitTp1`).
 */
export function saveTp1Draft(ctx: SessionContext, p: Tp1WriteInput): Promise<{ id: string }> {
  return saveTp1DraftForPersonId(ctx, requirePerson(ctx), p);
}

/** Admin-on-behalf draft save: UPSERT the SELECTED employee's editable draft for a year. Admin-gated;
 *  writes the SAME master row the employee edits; HR is recorded as the event actor. */
export async function saveTp1DraftForPerson(
  ctx: SessionContext,
  p: { personId: string } & Tp1WriteInput,
): Promise<{ id: string }> {
  return saveTp1DraftForPersonId(ctx, requireAdminTarget(ctx, p.personId), p);
}

async function saveTp1DraftForPersonId(
  ctx: SessionContext,
  personId: string,
  p: Tp1WriteInput,
): Promise<{ id: string }> {
  const { year, amount, categories } = resolveInput(p);
  const deductionMonth = validateMonth(p.deductionMonth, 'Deduction month');
  // PDPA Layer-0: list the changed FIELD names only — never the cleartext amounts.
  const fields = categories ? ['tp1Amount', 'categories'] : ['tp1Amount'];
  if (deductionMonth != null) fields.push('deductionMonth');
  return withTenant(ctx, async (tx) => {
    // THE OPEN DRAFT IS NOW PER (YEAR, MONTH), not per year. With a deduction month on the record, one
    // draft per year would make keying February overwrite the January draft — a data-loss bug that no
    // type check can see. A month-less save keeps the old behaviour and reuses the month-less draft.
    const [draft] = await tx
      .select({ id: tp1Relief.id })
      .from(tp1Relief)
      .where(
        and(
          eq(tp1Relief.personId, personId),
          eq(tp1Relief.assessmentYear, year),
          eq(tp1Relief.status, 'draft'),
          deductionMonth == null
            ? isNull(tp1Relief.deductionMonth)
            : eq(tp1Relief.deductionMonth, deductionMonth),
        ),
      )
      .orderBy(desc(tp1Relief.createdAt))
      .limit(1);
    let id: string;
    if (draft) {
      await tx
        .update(tp1Relief)
        .set({ tp1Amount: amount.toFixed(2), categories, deductionMonth })
        .where(eq(tp1Relief.id, draft.id));
      id = draft.id;
    } else {
      const [row] = await tx
        .insert(tp1Relief)
        .values({
          tenantId: ctx.tenantId,
          personId,
          assessmentYear: year,
          status: 'draft',
          tp1Amount: amount.toFixed(2),
          categories,
          deductionMonth,
        })
        .returning({ id: tp1Relief.id });
      id = row.id;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'tp1-relief',
      aggregateId: id,
      eventType: 'tp1.draft.saved',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, personId),
      // PDPA Layer-0 (ADR-0030): reference the row + year + field NAMES, NEVER the cleartext amounts — the
      // event is subject-readable, so the amounts must live only on the RLS-protected tp1_relief row.
      payload: { tp1ReliefId: id, assessmentYear: year, deductionMonth, fields },
    });
    return { id };
  });
}

/**
 * Submit a TP1 declaration for an assessment year: INSERT a new SUBMITTED row (a correction is just another
 * append — latest-submitted wins). Never closes/supersedes a prior row.
 */
export function submitTp1(ctx: SessionContext, p: Tp1WriteInput): Promise<{ id: string }> {
  return submitTp1ForPersonId(ctx, requirePerson(ctx), p);
}

/** Admin-on-behalf submit: INSERT a SUBMITTED correction for the SELECTED employee (latest-submitted
 *  wins, history kept). Admin-gated; writes the SAME master row the employee reads; HR is the actor. */
export async function submitTp1ForPerson(
  ctx: SessionContext,
  p: { personId: string } & Tp1WriteInput,
): Promise<{ id: string }> {
  return submitTp1ForPersonId(ctx, requireAdminTarget(ctx, p.personId), p);
}

async function submitTp1ForPersonId(
  ctx: SessionContext,
  personId: string,
  p: Tp1WriteInput,
): Promise<{ id: string }> {
  const { year, amount, categories } = resolveInput(p);
  const deductionMonth = validateMonth(p.deductionMonth, 'Deduction month');
  const fields = categories ? ['tp1Amount', 'categories'] : ['tp1Amount'];
  if (deductionMonth != null) fields.push('deductionMonth');
  // Section E. The declaration is what makes a submission a DECLARATION — the paper form carries the
  // s.113(1)(b) acknowledgement above the signature, and submitting without it would file an unsigned
  // statutory form. The 2026 catalogue shape requires it; a legacy scalar/eight-key caller (the API path
  // and every pre-7ad37961 test fixture) submits as it always did, because demanding a tick from a
  // caller that has no form to tick it on would break the shape this round promised to keep working.
  const isCatalogue = isTp1Categories2026(categories);
  if (isCatalogue && p.declarationAccepted !== true) {
    throw new TaxReliefError('Tick the employee declaration (Section E) before submitting this TP1.');
  }
  return withTenant(ctx, async (tx) => {
    // The accumulated check runs INSIDE the write transaction, against this person's already-approved
    // rows for the year. Doing it here rather than in the action is what makes "an over-limit claim
    // across two declarations in one year is refused on the second" true for every caller, screen or
    // not. (Two simultaneous submissions could still each read the same accumulation and both pass —
    // the same serialization gap core/claims.ts closes with an advisory lock. It is NOT closed here:
    // TP1 is a per-person self-declaration with no concurrent writer in any shipped flow, and adding a
    // lock this round would be an unexercised code path on the payroll write path. Recorded, not hidden.)
    if (isCatalogue) {
      // THE SAME FUNCTION THE SCREEN CALLS, with the month this row is about to be written against — so
      // a correction to an already-approved month is measured against the REST of the year and not
      // against the figure it is replacing, and so the strip and this refusal can never disagree.
      assertWithinRemaining(categories, await accumulatedInTx(tx, personId, year, deductionMonth));
    }
    const [row] = await tx
      .insert(tp1Relief)
      .values({
        tenantId: ctx.tenantId,
        personId,
        assessmentYear: year,
        status: 'submitted',
        tp1Amount: amount.toFixed(2),
        categories,
        submittedAt: sql`now()`,
        deductionMonth,
        // Server-stamped, never client-supplied: a declaration date the browser could set is not
        // evidence of anything.
        declaredAt: isCatalogue ? sql`now()` : null,
      })
      .returning({ id: tp1Relief.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'tp1-relief',
      aggregateId: row.id,
      eventType: 'tp1.submitted',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, personId),
      // PDPA Layer-0: reference the field NAMES only — the amounts live on the RLS-protected row.
      payload: { tp1ReliefId: row.id, assessmentYear: year, deductionMonth, fields },
    });
    return { id: row.id };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SECTION F — EMPLOYER CONSENT (7ad37961, ADR-0081)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
//
// Approve / reject / cancel a submitted declaration. ADMIN ONLY, through the SAME `requireAdminTarget`
// gate the on-behalf writers use — an employee cannot approve their own claim, which is the entire point
// of the section, and the tp1_relief RLS policy is the backstop underneath it.
//
// APPROVAL IS AN UPDATE, NOT AN APPEND, and that is the one place this file departs from the append-only
// shape. A decision is a fact ABOUT a row, not a new declaration: appending an approved COPY would put
// two rows in the same month, and the month list would then have to decide which is the record — which
// is exactly the ambiguity the append-only latest-wins rule exists to avoid for CLAIMS. The history is
// not lost: every decision appends a DomainEvent carrying who, when and which fields.
//
// PDPA Layer-0 (ADR-0030): the payloads carry the row id, year, month and the changed FIELD NAMES. Never
// an amount — the event log is subject-readable and the figures live only on the RLS-protected row.

export type Tp1DecisionInput = {
  personId: string;
  /** The declaration being decided. Resolved against the person, so an id from another person 404s. */
  id: string;
  /** Section F "approved for the deduction of MONTH / YEAR". Approve only. */
  approvedMonth?: number | string | null;
  approvedYear?: number | string | null;
  /** Section F "Position" — a fact about the moment of approval, so it is stored, not derived. */
  approverPosition?: string | null;
};

/** Section F: the employer consents, and the declaration starts feeding payroll from `approvedMonth`. */
export async function approveTp1ForPerson(ctx: SessionContext, p: Tp1DecisionInput): Promise<{ id: string }> {
  const personId = requireAdminTarget(ctx, p.personId);
  const current = await getTp1RowById(ctx, personId, p.id);
  if (!current) throw new TaxReliefError('That TP1 declaration was not found.');
  if (current.status !== 'submitted') {
    throw new TaxReliefError('Only a submitted TP1 declaration can be approved.');
  }
  const approvedMonth = validateMonth(p.approvedMonth ?? current.deductionMonth ?? 1, 'Approved month') ?? 1;
  const approvedYear = validateYear(Number(p.approvedYear ?? current.assessmentYear));
  const position = p.approverPosition == null ? null : String(p.approverPosition).trim().slice(0, 200) || null;
  return decide(ctx, personId, current, 'approved', 'tp1.approved', {
    approvedBy: ctx.userId ?? null,
    approvedAt: sql`now()`,
    approvedMonth,
    approvedYear,
    approverPosition: position,
  });
}

/** Section F refused. The row stops being a candidate for the payroll feed; nothing is deleted. */
export async function rejectTp1ForPerson(ctx: SessionContext, p: Tp1DecisionInput): Promise<{ id: string }> {
  const personId = requireAdminTarget(ctx, p.personId);
  const current = await getTp1RowById(ctx, personId, p.id);
  if (!current) throw new TaxReliefError('That TP1 declaration was not found.');
  if (current.status !== 'submitted') {
    throw new TaxReliefError('Only a submitted TP1 declaration can be rejected.');
  }
  return decide(ctx, personId, current, 'rejected', 'tp1.rejected', {
    approvedBy: ctx.userId ?? null,
    approvedAt: sql`now()`,
  });
}

/**
 * Withdraw a declaration. Unlike reject, an ALREADY APPROVED row may be cancelled — that is the whole
 * use: a relief approved in error is stopped from feeding the next run. A cancelled row keeps its
 * approval stamps, because "who approved this, and when, before it was cancelled" is the audit question.
 */
export async function cancelTp1ForPerson(ctx: SessionContext, p: Tp1DecisionInput): Promise<{ id: string }> {
  const personId = requireAdminTarget(ctx, p.personId);
  const current = await getTp1RowById(ctx, personId, p.id);
  if (!current) throw new TaxReliefError('That TP1 declaration was not found.');
  if (current.status !== 'submitted' && current.status !== 'approved') {
    throw new TaxReliefError('Only a submitted or approved TP1 declaration can be cancelled.');
  }
  return decide(ctx, personId, current, 'cancelled', 'tp1.cancelled', {});
}

/** The one write + event both decisions share, so a new stamp can never reach one path and not another. */
async function decide(
  ctx: SessionContext,
  personId: string,
  current: Tp1Row,
  status: Tp1Status,
  eventType: 'tp1.approved' | 'tp1.rejected' | 'tp1.cancelled',
  stamps: Record<string, unknown>,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    await tx
      .update(tp1Relief)
      .set({ status, ...stamps })
      .where(and(eq(tp1Relief.id, current.id), eq(tp1Relief.personId, personId)));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'tp1-relief',
      aggregateId: current.id,
      eventType,
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, personId),
      // Field NAMES only — never an amount (ADR-0030 Layer-0).
      payload: {
        tp1ReliefId: current.id,
        assessmentYear: current.assessmentYear,
        deductionMonth: current.deductionMonth,
        fields: ['status', ...Object.keys(stamps)],
      },
    });
    return { id: current.id };
  });
}
