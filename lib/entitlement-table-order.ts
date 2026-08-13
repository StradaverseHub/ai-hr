/**
 * 3214cb11 / 813fd22a — THE ORDER ENTITLEMENT TABLES ARE LISTED IN.
 *
 * Both items report the same fault from two surfaces: `listEntitlementTemplates` ordered by
 * `asc(name)`, so the sixteen Annual Leave tables came out interleaved — a RETIREE table first, the
 * SPECIAL ones scattered through the plain CONTRACT ones, all four PERMANENT ones stranded last, and
 * "GRADE H" behind "GRADE 20 - 23" because "H" sorts after "2". The Entitlement Tables list and the
 * "Choose an entitlement table" select are fed by ONE page-level read, so one ordering fixes both.
 *
 * ⚠️ THE ORDER IS DERIVED FROM THE NAME, NOT STORED AND NOT HARDCODED. A literal list of the sixteen
 * strings would not generalise to the other nine leave types that also have tables, would silently drop
 * a renamed table to the bottom, and would need maintaining by hand forever. Every rank below is read
 * out of the name, so a table created later with a matching name lands in the right place on its own.
 *
 * The key is (family, variant, grade, name). Sorting is presentation only — no stored value moves.
 *
 * ── WHY THE VARIANT RANK READS THE TRAILING MARKER, AND ONLY THE TRAILING MARKER ──────────────────────
 * This is the one rule with a real trap in it, and production contains BOTH sides of it:
 *
 *   "CONTRACT - GRADE H (SPECIAL)"  → the variant is a trailing PARENTHETICAL  → SPECIAL block
 *   "CONTRACT - SPECIAL"            → the variant is a trailing BARE token     → SPECIAL block
 *   "CONTRACT - SPECIAL (40 AL)"    → SPECIAL is NOT the trailing marker       → plain CONTRACT block
 *
 * The third is the reporter's position 8: they deliberately put "CONTRACT - SPECIAL (40 AL)" among the
 * plain Contract tables, not with the (SPECIAL) ones. Reading a bare "SPECIAL" ANYWHERE in the name
 * would move it into the SPECIAL block and break the order they asked for. Reading only a trailing
 * PARENTHETICAL — which is what the approved plan literally specified — gets that case right but then
 * ranks "CONTRACT - SPECIAL" and "CONTRACT - RETIREE" as equals, and the alphabetical tiebreak puts
 * RETIREE FIRST. That is the order the other nine leave types would have been given, and it is the
 * opposite of what those same plans state their test should assert. So: check the trailing
 * parenthetical FIRST, and fall back to a trailing bare token only when there is no parenthetical at
 * all. Both production shapes then land where the reporter put them.
 *
 * Matching is case-insensitive and tolerant of spacing, because these names are free text typed by HR.
 */

/** Family rank — the leading token. Anything unrecognised sorts after everything that is recognised. */
const FAMILY_OTHER = 9;
/** Grade rank for a name carrying no GRADE token at all: last within its own family+variant block. */
const GRADE_NONE = 999;

export type EntitlementTableSortKey = {
  /** PERMANENT 1 · CONTRACT 2 · PART TIME(R) 3 · anything else 9. */
  family: number;
  /** plain 0 · (SPECIAL) or trailing SPECIAL 1 · (RETIREE) or trailing RETIREE 2. */
  variant: number;
  /** GRADE H 0 · the first number in the GRADE token otherwise · 999 when there is no GRADE token. */
  grade: number;
  /** The normalised name, for the alphabetical tiebreak between two otherwise equal keys. */
  name: string;
};

/** Upper-cased, whitespace-collapsed. Every rank below is matched against this, never the raw name. */
const normalise = (name: string): string => name.toUpperCase().replace(/\s+/g, ' ').trim();

function familyRank(n: string): number {
  if (/^PERMANENT\b/.test(n)) return 1;
  if (/^CONTRACT\b/.test(n)) return 2;
  // "PART TIMER" is the stored name; the reporter wrote "PART TIME". Both rank the same — we are not
  // renaming anything, only making sure either spelling lands last among the recognised families.
  if (/^PART TIMER?\b/.test(n)) return 3;
  return FAMILY_OTHER;
}

function variantRank(n: string): number {
  // A TRAILING parenthetical wins outright — see the header note. "(40 AL)" is a parenthetical that is
  // not a variant, and that is exactly what keeps "CONTRACT - SPECIAL (40 AL)" in the plain block.
  const paren = /\(([^()]*)\)$/.exec(n);
  if (paren) {
    const inner = paren[1].trim();
    if (inner === 'SPECIAL') return 1;
    if (inner === 'RETIREE') return 2;
    return 0;
  }
  // No parenthetical at all ⇒ a bare trailing token is the marker ("CONTRACT - SPECIAL").
  if (/\bSPECIAL$/.test(n)) return 1;
  if (/\bRETIREE$/.test(n)) return 2;
  return 0;
}

function gradeRank(n: string): number {
  const m = /\bGRADE\b(.*)$/.exec(n);
  if (!m) return GRADE_NONE;
  // Drop a trailing variant parenthetical before reading digits, so "(40 AL)" or a future "(2 DAYS)"
  // cannot be mistaken for the grade. The variant it carries was already read by variantRank.
  const rest = m[1].replace(/\([^()]*\)$/, '');
  // "GRADE H" and "GRADE H - 18" both LEAD their block — this is the whole "H sorts after 2" complaint.
  if (/^\s*H\b/.test(rest)) return 0;
  const num = /(\d+)/.exec(rest);
  return num ? Number(num[1]) : GRADE_NONE;
}

/** The sort key for one entitlement table name. Pure; exported for the tests and for reuse. */
export function entitlementTableSortKey(name: string): EntitlementTableSortKey {
  const n = normalise(name);
  return { family: familyRank(n), variant: variantRank(n), grade: gradeRank(n), name: n };
}

/**
 * Compare two entitlement table names. Family, then variant, then grade, then alphabetically —
 * the last so two tables the rule cannot tell apart still have a stable, predictable order.
 */
export function compareEntitlementTableNames(a: string, b: string): number {
  const ka = entitlementTableSortKey(a);
  const kb = entitlementTableSortKey(b);
  return (
    ka.family - kb.family ||
    ka.variant - kb.variant ||
    ka.grade - kb.grade ||
    ka.name.localeCompare(kb.name)
  );
}

/**
 * The comparator `listEntitlementTemplates` sorts with: the name order above, then `validFrom`
 * ascending so the versions of ONE lineage stay in date order under their shared name. Every reader
 * of that function inherits this — the standalone Entitlement Tables screen, each leave type's
 * Entitlement step, and the eligibility rule's template select — so there is no second sort to drift.
 */
export function compareEntitlementTables(
  a: { name: string; validFrom: string },
  b: { name: string; validFrom: string },
): number {
  return compareEntitlementTableNames(a.name, b.name) || a.validFrom.localeCompare(b.validFrom);
}
