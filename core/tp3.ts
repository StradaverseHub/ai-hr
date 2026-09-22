/**
 * LHDN TP3 (1/2026) — the PREVIOUS-EMPLOYMENT record (item df35d60d, STAGE 1).
 *
 * ══ WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ═══════════════════════════════════════════════════
 *
 * A new employee who worked elsewhere earlier in the same year hands their new employer a TP3: who they
 * worked for, what that employment paid them, what was exempt, what EPF and zakat came off it, what PCB
 * was already deducted, and which reliefs they already claimed through that employer. This file is the
 * one service that reads and writes that record.
 *
 * ⚠️ IT MOVES NO TAX, AND THAT IS THE STAGE BOUNDARY, NOT AN OVERSIGHT. `core/payroll.ts` seeds the PCB
 * accumulators from `employee_statutory_my.tp3_*` — `tp3Applies = e.tp3Year === pYear`, then
 * netRemuneration / epfClaimed / pcbPaid / zakatPaid, LHDN's ∑(Y−K), K, X and Z — and it still does,
 * unchanged, reading columns this file never writes. Stage 2 connects Section D to the computation with
 * the cross-employer limit check and decides, once and deliberately, which side owns the accumulator
 * seed. Nothing here may be wired into that path before it does.
 *
 * ══ THE OVERLAP IS REAL, SO IT IS SHOWN RATHER THAN HIDDEN ══════════════════════════════════════════
 *
 * Two stores now hold previous-employment money: the five columns (authoritative for tax) and this row
 * (authoritative for the form). `deriveAccumulatorSeed` computes what the accumulator seed WOULD be from
 * the form's own boxes — (C1 − ΣC2) − C3, C3, C5, C4(i) — and the screen prints it beside the stored
 * columns. A difference is INFORMATION, not an error: nothing here acts on it, nothing refuses a save
 * because of it, and no figure is copied from one side to the other. Making the overlap visible is what
 * keeps it from becoming the silent second source of truth CLAUDE.md §1 forbids, and it is the exact
 * bridge stage 2 formalises.
 *
 * ══ THE TAXONOMY IS THE TP1'S, READ FOR A DIFFERENT EMPLOYER ════════════════════════════════════════
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
import { type SessionContext } from '../db/client';
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
 * What the PCB accumulator seed WOULD be, computed from the form's own boxes.
 *
 * ⚠️ NOTHING CONSUMES THIS FOR TAX. It exists so the screen can print the derived figures beside the
 * stored `employee_statutory_my.tp3_*` columns and let an operator SEE whether the two agree. Stage 2
 * decides what to do about a disagreement; stage 1 refuses to decide it silently.
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
  return {
    gross,
    exemptTotal,
    epfClaimed,
    pcbPaid,
    zakatPaid,
    netRemuneration: round2(gross - exemptTotal - epfClaimed),
  };
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
 * ⚠️ THE STORED COLUMNS ARE RETURNED AS-READ AND NEVER WRITTEN BY THIS FILE. They are the PCB kernel's
 * input; this service shows them and stops there.
 */
export type Tp3Identity = {
  employee: { name: string; idNumber: string | null; tin: string | null };
  stored: {
    tp3Year: number | null;
    netRemuneration: number | null;
    epfClaimed: number | null;
    pcbPaid: number | null;
    zakatPaid: number | null;
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
      },
    };
  });
}

// ── The write ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Create or replace ONE person's TP3 for ONE assessment year.
 *
 * UPSERT ON THE GRAIN, not an append: see the header on db/schema's `employeeTp3` for why a record of
 * fact keeps its history in the event log where a declaration keeps it in rows. The unique index is what
 * makes the grain true; this is `onConflictDoUpdate` against it, so two concurrent saves cannot produce
 * two records for one year.
 *
 * ⚠️ WRITES NOTHING OUTSIDE `employee_tp3`. Not `employee_statutory_my`, not `payroll_input`, not a
 * single tax figure. Stage 1.
 */
export async function saveTp3(ctx: SessionContext, p: Tp3WriteInput): Promise<{ id: string }> {
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

    return { id: saved.id };
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
