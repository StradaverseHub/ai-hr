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
import { childReliefGridFromFamily } from './dependents';
import type { ChildReliefGrid } from './dependents';

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

/**
 * RE-EXPORTED, NOT REDEFINED (r343). The grid shape and `childReliefGridFromFamily` moved to
 * core/dependents.ts, beside `isChildReliefEligible` — the rule they apply — because the weighted
 * qualifying-children count (`eligibleChildReliefUnits`, item 04b88724) needs them there and that module
 * cannot import this one without a cycle. Copying either would be a second walk of the Family register,
 * which is the exact duplication r340 shipped and had to undo. Every existing caller and test keeps
 * importing them from here.
 */
export type { ChildReliefGrid } from './dependents';
export { childReliefGridFromFamily };

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
  /** r343 03f89c0f — true when the child count on the tax record was TYPED ('manual' mode) rather than
   *  worked out. NOT a defect: a typed figure is legitimate and there are good reasons to keep one. */
  typedFigure: boolean;
  /** r343 03f89c0f — `numChildren − familyEligible` for a TYPED figure; null for the two auto modes,
   *  where there is nothing typed to disagree with the record.
   *
   *  ⚠️ HEAD COUNT AGAINST HEAD COUNT, both sides. `num_children` is a head count (Form E / CP8D / EA read
   *  it as one) and this counts the eligible child ROWS on the Family register, one per child, ignoring the
   *  1/4/8 s.48 weighting entirely. Comparing a head count against a weighted count would make the
   *  difference meaningless, so the screen states which one this is in its caption. Positive = typed above
   *  the record; negative = typed below it; 0 = they agree. */
  typedExcess: number | null;
  /** r343 03f89c0f — relief the Family register's HEAD COUNT supports: `familyEligible × perChild`, the
   *  same basis `todayRM` uses for anyone not on the category table, so the two are comparable. */
  recordRM: number;
  /** r343 03f89c0f — relief carried by the children the record does NOT account for: the positive part of
   *  `typedExcess × perChild`, priced by the pack. 0 for everyone whose figure is not typed above. */
  excessRM: number;
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
  /**
   * r343 03f89c0f — THE TYPED FIGURES THAT DISAGREE WITH THE FAMILY RECORD.
   *
   * A subset of `people` (same objects, so no second walk and no second arithmetic): those whose child count
   * was TYPED — every mode but the two auto ones, so a hand-edited or unrecognised stored mode is not
   * silently exonerated — and typed ABOVE the eligible children on file. It is a LIST TO LOOK AT, not an
   * error list: some of those missing children are probably real and simply never entered, which is why
   * nothing here changes anybody and there is deliberately no bulk action anywhere near it.
   *
   * ⚠️ WHICH ROWS THESE ARE IS THE WHOLE SCREEN, SO IT IS PINNED AGAINST A REAL DATABASE:
   * test/child-relief-disagreement-subset-r343.test.ts. Widening this filter to every typed figure — which
   * would put the five employees whose figures AGREE, and anyone typed BELOW their record, under a heading
   * that says "above" — left the whole related suite green when adversarial verification tried it.
   *
   * ORDER is `people`'s order (person name, then employee code, then employment id), so the list is
   * reproducible between loads.
   */
  recordDisagreement: {
    people: ChildReliefReviewPerson[];
    /** Σ of the positive `typedExcess` — children carried by a tax figure and by no Family record. */
    excessChildren: number;
    /** Σ `excessRM` — the relief those children carry, priced by the pack, never by a constant here. */
    excessReliefRM: number;
  };
};

/** Round to cents the way every other money figure in this repo is rounded before display. */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

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

/**
 * r343 03f89c0f — IS THIS PERSON'S TYPED CHILD COUNT ABOVE THE CHILDREN ON FILE, AND WHAT DOES THE GAP
 * CARRY IN RELIEF? Pure, so the whole finding is testable without a database.
 *
 * ⚠️ 'manual' IS NOT A DEFECT. A typed figure is a legitimate, deliberate entry — an employee may genuinely
 * have four children and have had only one entered into the Family register, in which case the typed figure
 * is right and the RECORD is what is incomplete. This function reports a DISAGREEMENT between two numbers,
 * and says nothing about which of them is wrong. Nothing in this module can know that.
 *
 * ⚠️ HEAD COUNT AGAINST HEAD COUNT. `numChildren` is a head count and `familyEligible` counts child rows,
 * one per child. The s.48 1/4/8 weighting is deliberately NOT applied to either side: mixing the two bases
 * would make the difference a number nobody could act on. `familyRM` on the row beside this is the weighted
 * question and is labelled as its own thing.
 *
 * The two auto modes return `typedExcess: null` — nothing was typed, so there is nothing to disagree. That
 * is what keeps them off the screen this feeds.
 */
export function childReliefRecordDisagreement(p: {
  mode: string;
  numChildren: number;
  familyEligible: number;
  perChild: number;
}): Pick<ChildReliefReviewPerson, 'typedFigure' | 'typedExcess' | 'recordRM' | 'excessRM'> {
  const typedFigure = p.mode !== 'auto' && p.mode !== 'auto_table';
  const typedExcess = typedFigure ? p.numChildren - p.familyEligible : null;
  return {
    typedFigure,
    typedExcess,
    recordRM: round2(p.familyEligible * p.perChild),
    // Only the POSITIVE gap carries unsupported relief. A figure typed BELOW the record under-claims, which
    // costs the employee rather than the revenue, and is a different conversation this screen does not open.
    excessRM: typedExcess != null && typedExcess > 0 ? round2(typedExcess * p.perChild) : 0,
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
      recordDisagreement: { people: [], excessChildren: 0, excessReliefRM: 0 },
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

    // `childAgeYears` parses a date of birth as `${dob}T00:00:00Z`, so the OTHER endpoint of the age
    // subtraction is built the same way — otherwise an eight-hour offset could flip a child's whole-year
    // age on their birthday, which is the one day the eligibility rule turns on. The DATE itself is the
    // Kuala Lumpur date (§8), not the server's.
    const asOfDate = new Date(`${asOf}T00:00:00Z`);
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
        // r343 03f89c0f — the typed-figure-against-the-record finding, on the SAME row and the same read.
        ...childReliefRecordDisagreement({
          mode: r.mode ?? 'manual',
          numChildren: r.numChildren ?? 0,
          familyEligible: derived.eligible,
          perChild: priced.perChild,
        }),
      };
      seen.set(r.personId, row);
      people.push(row);
    }

    // The version + the per-child figure shown in the caption come from the FIRST priced country present.
    // A multi-country tenant is out of scope for this screen's caption, not misreported by it: the
    // per-person figures above are each priced by their own company's pack.
    const first = packs.get(rows.find((r) => packs.has(r.country))!.country)!;
    // r343 03f89c0f — the subset, from the rows already built. The SAME objects, so the list and the table
    // above it can never report two different numbers for one person.
    const disagreeing = people.filter((x) => (x.typedExcess ?? 0) > 0);
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
      recordDisagreement: {
        people: disagreeing,
        excessChildren: disagreeing.reduce((n, x) => n + (x.typedExcess ?? 0), 0),
        excessReliefRM: round2(disagreeing.reduce((n, x) => n + x.excessRM, 0)),
      },
    };
  });
}
