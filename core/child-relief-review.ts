/**
 * CHILD RELIEF REVIEW (PCB) — item 99b2d6c0, r336.
 *
 * ═══ WHAT THIS MODULE IS FOR ═══
 *
 * The five LHDN s.48 child-relief categories have been priced and wired since item d64d0df4 (ruleset
 * 2026.7): `localization/my/statutory-tables.ts` carries `childByCategory`, `pcbMonth` reads the worked
 * amount, and the per-employee grid is on the Identification & Tax card. What has been missing is not
 * arithmetic — it is SIGHT. The grid renders only after an admin picks a third option out of a dropdown
 * on one employee's Bank & Statutory tab, so nobody can answer the only question worth asking before
 * touching it: **if we moved our parents onto the category grid, whose tax would move, and by how much?**
 *
 * This module answers that question and changes NOTHING. It writes no row, appends no event and returns
 * no action. It is the report the plan promises BEFORE any mode is flipped.
 *
 * ═══ ⚠️ THE FINDING THIS REPORT EXISTS TO MAKE IMPOSSIBLE TO MISS ═══
 *
 * `childReliefAmountFor(null)` is **0**. An employee switched to 'auto_table' with no grid keyed against
 * them therefore claims **RM 0 of child relief**, not their old `children × perChild` — their chargeable
 * income RISES and their monthly PCB goes UP. That is not a bug (an empty grid is an empty claim), but it
 * is a live foot-gun on a money field, and the switch is two clicks away. `switchRM` below is computed
 * from the grid ACTUALLY STORED on the record, so a row whose grid is empty reports the drop to zero in
 * ringgit rather than an optimistic projection.
 *
 * ═══ THE THREE FIGURES, AND WHERE EACH COMES FROM ═══
 *
 *   todayRM   What PCB deducts for this person's children TODAY. Mode-dependent, and it reads through
 *             the SAME expression the kernel does: 'auto_table' ⇒ the pack prices their stored grid;
 *             every other mode ⇒ `num_children × perChild`. (core/payroll.ts:5362, core/payroll-view.ts:1487.)
 *   switchRM  What PCB would deduct if their mode were set to 'auto_table' RIGHT NOW — the same pack
 *             function over the same stored grid, with no mode gate. `switchRM === todayRM` for anyone
 *             already on the table.
 *   familyRM  What the grid WOULD price at if it were keyed from the categories the Family register
 *             already records per child. This is a SUGGESTION derived from tenant data, not a plan: it
 *             is what the categories on file say, and the row also reports how many eligible children
 *             carry no category at all, because those contribute nothing and would understate the total.
 *
 * Every amount is resolved through the country pack (`pack.payroll.childReliefAmountFor` +
 * `rules.pcb.reliefs`), never from a constant here — the kernel must not name a Malaysian relief figure
 * (ADR-0080 D6), and a second copy of a statutory number is how two screens drift.
 *
 * ═══ ⚠️ WHAT IS DELIBERATELY ABSENT ═══
 *
 * No "apply", no "switch everyone", no bulk action, no migration. Moving 70 people from flat counting
 * onto the category grid changes their PCB — it is a money migration on real payslips and a real
 * statutory return, and it is the reporter's decision to make after reading this, not a button.
 *
 * ACCESS. Admin-only at this service boundary (`assertMayReadChildReliefReview`), because the answer is a
 * cross-company list of people's tax positions. RLS is the fence: every read goes through `withTenant`,
 * so a company-scoped administrator sees only the companies they administer and the totals are the totals
 * of what they can see. ACTIVE employments only (`terminated_on IS NULL`) — the same population
 * core/duplicate-person.ts reports over, and for the same reason: a leaver's relief is not what lands in
 * the next payroll run.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { isAdmin } from '../lib/authz';
import { packFor } from '../localization/registry';
import { todayInKualaLumpur } from '../lib/hr-date';
import { company, employeeDependent, employeeStatutoryMy, employment, person } from '../db/schema';
import { CHILD_RELIEF_CATEGORIES, isChildReliefEligible } from './dependents';

export class ChildReliefReviewAccessError extends Error {
  constructor() {
    super('Not authorised to read the child relief review.');
    this.name = 'ChildReliefReviewAccessError';
  }
}

/** Admin-only, checked HERE and not only on the page: a page guard is a UX gate, not the fence. */
export function assertMayReadChildReliefReview(ctx: SessionContext): void {
  if (!isAdmin(ctx)) throw new ChildReliefReviewAccessError();
}

/** The stored grid shape: per s.48 category, the count claimed at 100% and the count claimed at 50%. */
export type ChildReliefGrid = Record<string, { full: number; half: number }>;

/** One employment a reviewed person holds — the way in to the grid, which lives on their record. */
export type ChildReliefReviewJob = {
  employmentId: string;
  employeeCode: string | null;
  company: string;
};

export type ChildReliefReviewPerson = {
  personId: string;
  name: string;
  jobs: ChildReliefReviewJob[];
  /** 'manual' | 'auto' | 'auto_table' as stored; rendered through a known-value map, never raw. */
  mode: string;
  /** The whole head count on the statutory row — what Form E / CP8D / the EA statement read. */
  numChildren: number;
  /** RM the projection of P deducts for this person's children today. */
  todayRM: number;
  /** RM it would deduct if their mode were 'auto_table' right now, over the grid actually stored. */
  switchRM: number;
  /** switchRM − todayRM. Negative = LESS relief = MORE tax. */
  deltaRM: number;
  /** false ⇒ nothing is keyed, so switching now would price their children at RM 0. */
  gridKeyed: boolean;
  /** RM the Family register's recorded categories would price at, or null when it holds no child rows. */
  familyRM: number | null;
  /** Eligible child rows on the Family register (core/dependents' one eligibility rule). */
  familyEligible: number;
  /** How many of those carry a recorded relief category. The rest contribute nothing to familyRM. */
  familyCategorised: number;
};

export type ChildReliefReview = {
  /** Kuala Lumpur "today" the ruleset was resolved as of, so the reader knows which version priced this. */
  asOf: string;
  /** The ruleset version that priced every figure below — the same stamp a payslip carries. */
  statutoryVersion: string | null;
  /** The flat per-child figure the other two modes use, from the resolved ruleset. */
  perChild: number | null;
  /** The five category amounts as the resolved ruleset prices them, in canonical order. */
  categoryAmounts: { key: string; amount: number }[];
  people: ChildReliefReviewPerson[];
  /** Totals over `people` — of what this reader can see, which RLS decides. */
  totals: { people: number; children: number; todayRM: number; switchRM: number; deltaRM: number };
};

/** Round to cents the way every other money figure in this repo is rounded before display. */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The Family register → a priced grid, by the SAME eligibility rule `num_children` auto mode uses
 * (`isChildReliefEligible`: relationship 'child', not deceased, not archived, explicit per-child decision
 * wins, else student-or-under-18).
 *
 * ⚠️ A SHARE OF `null` IS COUNTED AS THE FULL 100% CLAIM. That is the LHDN default (the whole child is
 * claimed by one parent unless the parents split it) and it matches how the head count already treats a
 * 50%-shared child — as one whole child. The screen says so in its own words rather than letting a
 * derived figure look more certain than it is.
 *
 * A child with NO recorded category contributes nothing and is counted in `eligible` but not in
 * `categorised`, so the caller can say "this suggestion covers 4 of 6 children" instead of quietly
 * understating somebody's relief.
 */
export function childReliefGridFromFamily(
  rows: {
    relationship: string;
    dateOfBirth: string | null;
    isStudent: boolean | null;
    isDeceased: boolean;
    archivedAt: Date | null;
    childTaxRelief: boolean | null;
    childReliefCategory: string | null;
    childReliefPercentage: number | null;
  }[],
  asOf: Date,
): { grid: ChildReliefGrid; eligible: number; categorised: number } {
  const grid: ChildReliefGrid = {};
  let eligible = 0;
  let categorised = 0;
  for (const r of rows) {
    if (!isChildReliefEligible(r, asOf)) continue;
    eligible += 1;
    const cat = r.childReliefCategory;
    if (!cat || !(CHILD_RELIEF_CATEGORIES as readonly string[]).includes(cat)) continue;
    categorised += 1;
    const cell = (grid[cat] ??= { full: 0, half: 0 });
    // 50 is the only share that is not the whole claim; null/absent ⇒ the full claim (see the note above).
    if (r.childReliefPercentage === 50) cell.half += 1;
    else cell.full += 1;
  }
  return { grid, eligible, categorised };
}

/**
 * The three figures for one person, PURE. `amountFor` is the country pack's own pricing function, passed
 * in rather than imported, so this module never names a relief amount and the test can drive it with the
 * real pack function over a supplied ruleset.
 */
export function childReliefReviewFigures(p: {
  mode: string;
  numChildren: number;
  storedGrid: unknown;
  familyGrid: ChildReliefGrid | null;
  perChild: number;
  amountFor: (table: unknown) => number;
}): Pick<ChildReliefReviewPerson, 'todayRM' | 'switchRM' | 'deltaRM' | 'gridKeyed' | 'familyRM'> {
  // The SAME gate the kernel applies (core/payroll.ts:5362). Anything but 'auto_table' keeps the
  // `children × perChild` arithmetic to the cent, which is what makes this report honest for the 70.
  const onTable = p.mode === 'auto_table';
  const gridRM = round2(p.amountFor(p.storedGrid));
  const todayRM = onTable ? gridRM : round2(p.numChildren * p.perChild);
  const switchRM = gridRM;
  return {
    todayRM,
    switchRM,
    deltaRM: round2(switchRM - todayRM),
    gridKeyed: gridStoredIsNonEmpty(p.storedGrid),
    familyRM: p.familyGrid ? round2(p.amountFor(p.familyGrid)) : null,
  };
}

/** A stored grid counts as "keyed" only when some category carries a non-zero count. */
function gridStoredIsNonEmpty(table: unknown): boolean {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return false;
  for (const cell of Object.values(table as Record<string, unknown>)) {
    if (!cell || typeof cell !== 'object') continue;
    const c = cell as { full?: unknown; half?: unknown };
    if ((typeof c.full === 'number' && c.full > 0) || (typeof c.half === 'number' && c.half > 0)) return true;
  }
  return false;
}

/**
 * THE REPORT. Read-only, admin-only, RLS-scoped.
 *
 * Who is IN it: every active employment whose person has children on their statutory row, OR is already
 * on the category table, OR has a grid stored against them. A person with no children and no grid has
 * nothing to review and is not listed — the report is about the population a switch would move.
 *
 * PERSON, NOT EMPLOYMENT, is the unit: `employee_statutory_my` is unique per person (one tax position),
 * so a person holding two jobs is ONE row listing both — counting them twice would overstate the
 * ringgit impact by exactly one person's relief, which is the whole point of the report.
 */
export async function childReliefReview(ctx: SessionContext): Promise<ChildReliefReview> {
  assertMayReadChildReliefReview(ctx);
  const asOf = todayInKualaLumpur();
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        employmentId: employment.id,
        personId: employment.personId,
        employeeCode: employment.employeeCode,
        companyName: company.legalName,
        country: company.country,
        fullName: person.fullName,
        mode: employeeStatutoryMy.childReliefMode,
        numChildren: employeeStatutoryMy.numChildren,
        childReliefTable: employeeStatutoryMy.childReliefTable,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .innerJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(
        and(
          isNull(employment.terminatedOn),
          or(
            gt(employeeStatutoryMy.numChildren, 0),
            eq(employeeStatutoryMy.childReliefMode, 'auto_table'),
            isNotNull(employeeStatutoryMy.childReliefTable),
          ),
        ),
      )
      // ORDER BY so the list is reproducible between loads (CLAUDE.md §8: any asserted array needs one).
      .orderBy(asc(person.fullName), asc(employment.employeeCode), asc(employment.id));

    const empty: ChildReliefReview = {
      asOf,
      statutoryVersion: null,
      perChild: null,
      categoryAmounts: [],
      people: [],
      totals: { people: 0, children: 0, todayRM: 0, switchRM: 0, deltaRM: 0 },
    };
    if (rows.length === 0) return empty;

    // The ruleset is resolved ONCE per country present in the shortlist. Every figure below is priced by
    // the pack, so a tenant whose country has no pack (or no PCB slice) simply reports no figures rather
    // than falling back to a number this module invented.
    const countries = [...new Set(rows.map((r) => r.country))];
    const packs = new Map<
      string,
      { perChild: number; version: string | null; amountFor: (t: unknown) => number; amounts: { key: string; amount: number }[] }
    >();
    for (const country of countries) {
      const pack = packFor(country);
      if (!pack?.payroll?.childReliefAmountFor) continue;
      const rules = await pack.payroll.loadRuleset(tx, { asOf });
      const reliefs = rules.pcb?.reliefs;
      if (!reliefs) continue;
      const amountFor = (t: unknown) => pack.payroll.childReliefAmountFor!(t, reliefs);
      const byCategory = reliefs.childByCategory ?? {};
      packs.set(country, {
        perChild: reliefs.perChild,
        version: rules.version ?? null,
        amountFor,
        // Canonical order comes from the pack's own key list when it publishes one; otherwise the map's.
        amounts: Object.keys(byCategory).map((key) => ({ key, amount: byCategory[key] })),
      });
    }
    if (packs.size === 0) return empty;

    const personIds = [...new Set(rows.map((r) => r.personId))];
    const dependents = await tx
      .select({
        personId: employeeDependent.personId,
        relationship: employeeDependent.relationship,
        dateOfBirth: employeeDependent.dateOfBirth,
        isStudent: employeeDependent.isStudent,
        isDeceased: employeeDependent.isDeceased,
        archivedAt: employeeDependent.archivedAt,
        childTaxRelief: employeeDependent.childTaxRelief,
        childReliefCategory: employeeDependent.childReliefCategory,
        childReliefPercentage: employeeDependent.childReliefPercentage,
      })
      .from(employeeDependent)
      .where(inArray(employeeDependent.personId, personIds));
    const familyBy = new Map<string, typeof dependents>();
    for (const d of dependents) {
      const list = familyBy.get(d.personId) ?? [];
      list.push(d);
      familyBy.set(d.personId, list);
    }

    const asOfDate = new Date(`${asOf}T00:00:00+08:00`);
    const people: ChildReliefReviewPerson[] = [];
    const seen = new Map<string, ChildReliefReviewPerson>();
    for (const r of rows) {
      const priced = packs.get(r.country);
      if (!priced) continue;
      const existing = seen.get(r.personId);
      if (existing) {
        existing.jobs.push({ employmentId: r.employmentId, employeeCode: r.employeeCode, company: r.companyName });
        continue;
      }
      const family = familyBy.get(r.personId) ?? [];
      const derived = childReliefGridFromFamily(family, asOfDate);
      const figures = childReliefReviewFigures({
        mode: r.mode ?? 'manual',
        numChildren: r.numChildren ?? 0,
        storedGrid: r.childReliefTable,
        familyGrid: derived.eligible > 0 ? derived.grid : null,
        perChild: priced.perChild,
        amountFor: priced.amountFor,
      });
      const row: ChildReliefReviewPerson = {
        personId: r.personId,
        name: r.fullName,
        jobs: [{ employmentId: r.employmentId, employeeCode: r.employeeCode, company: r.companyName }],
        mode: r.mode ?? 'manual',
        numChildren: r.numChildren ?? 0,
        familyEligible: derived.eligible,
        familyCategorised: derived.categorised,
        ...figures,
      };
      seen.set(r.personId, row);
      people.push(row);
    }

    // The version + the per-child figure shown in the caption come from the FIRST priced country present.
    // A multi-country tenant is out of scope for this screen's caption, not misreported by it: the
    // per-person figures above are each priced by their own company's pack.
    const first = packs.get(rows.find((r) => packs.has(r.country))!.country)!;
    return {
      asOf,
      statutoryVersion: first.version,
      perChild: first.perChild,
      categoryAmounts: first.amounts,
      people,
      totals: {
        people: people.length,
        children: people.reduce((n, p) => n + p.numChildren, 0),
        todayRM: round2(people.reduce((n, p) => n + p.todayRM, 0)),
        switchRM: round2(people.reduce((n, p) => n + p.switchRM, 0)),
        deltaRM: round2(people.reduce((n, p) => n + p.deltaRM, 0)),
      },
    };
  });
}
