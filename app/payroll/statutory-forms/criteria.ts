/**
 * r256 (item 858a1128) — WHAT A STATUTORY FORM HAS TO BE TOLD BEFORE IT CAN BE PRODUCED.
 *
 * ONE module, three readers: the directory (which decides whether a card opens a criteria step or goes
 * straight through), the criteria step itself (which draws exactly the boxes named here), and
 * test/statutory-forms-criteria-858a1128.test.ts (which checks the answer for every entry the pack
 * actually registers). The defect this shape exists to prevent lives in the CONTRACT between those files
 * — a directory that sent a form to a step which then asked for the wrong thing would be tsc-clean and
 * green on any test of either half — so the rule is written once and read three times.
 *
 * IT IS DERIVED FROM THE DESTINATION, NEVER FROM THE FORM'S NAME OR ID. A catalog href declares its own
 * placeholders, so Form TP1 (`?year={year}`) asks for a year and not a company, the two C.P.8A (EA) rows
 * ask for a company and a year and NEVER a month, and a monthly report asks for all three. That is the
 * reporter's complaint answered at its root: the EA stopped asking for a Payroll Month because the thing
 * it opens does not take one, not because a screen was taught to special-case it.
 */

/** The three things a destination can ask to have chosen, in the order they are drawn. */
export type CriterionKind = 'company' | 'year' | 'month';

const PLACEHOLDER: Record<string, CriterionKind> = {
  '{companyId}': 'company',
  '{year}': 'year',
  '{month}': 'month',
};

/**
 * Does this href need something chosen before it can be opened at all?
 *
 * The ONE test that decides whether a shelf card goes through the criteria step. An entry with no
 * placeholder (the CP22 worklist anchor) is one press, exactly as it always was.
 */
export const TEMPLATED = /\{(?:companyId|year|month)\}/;

/** The criteria step for one catalog entry, addressed by the entry's own id. */
export const criteriaHref = (formId: string) =>
  `/payroll/statutory-forms/open?form=${encodeURIComponent(formId)}`;

export type ParsedDestination = {
  /** The form's `action` — the path with every parameter stripped off. */
  action: string;
  /** The boxes to draw, in href order. `field` is the DESTINATION's own parameter name. */
  criteria: { kind: CriterionKind; field: string }[];
  /** Everything that is not a placeholder, carried through unchanged (the EA rows' `lang=en`). */
  hidden: { name: string; value: string }[];
};

/**
 * Split a catalog href into its action, the criteria it needs, and the parameters that ride along.
 *
 * The FIELD NAME is the destination's, never the placeholder's: `?year={year}` asks for a year and posts
 * it back as `year`, and a destination that later spelled it `taxYear` would keep working without this
 * module being touched.
 */
export function parseDestination(href: string): ParsedDestination {
  const [action, query = ''] = href.split('?');
  const criteria: { kind: CriterionKind; field: string }[] = [];
  const hidden: { name: string; value: string }[] = [];
  for (const pair of query.split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    const kind = PLACEHOLDER[value];
    if (kind) criteria.push({ kind, field: name });
    else hidden.push({ name, value: decodeURIComponent(value) });
  }
  return { action, criteria, hidden };
}

/**
 * The criteria a generatable REPORT takes. It has no href — it is addressed by its own id and reads plain
 * search params, the exact shape `[formId]` has read since 6babf4f6 and the shape every existing bookmark
 * carries.
 *
 * `periodKind` is the ONLY input, and it is the same field `[formId]` uses to decide whether to draw a
 * month select beside the figures — so the step and the screen it opens cannot disagree about what the
 * form covers.
 */
export function reportDestination(
  reportId: string,
  periodKind: 'month' | 'year' | 'event',
): ParsedDestination {
  return {
    action: `/payroll/statutory-forms/${encodeURIComponent(reportId)}`,
    criteria: [
      { kind: 'company', field: 'companyId' },
      { kind: 'year', field: 'year' },
      // A month UNLESS the form is filed for a year — the same `periodKind === 'year'` test `[formId]`
      // applies, written the same way round, so a `periodKind` this catalog does not use today cannot make
      // the two disagree by one of them defaulting to "monthly" and the other to "annual".
      ...(periodKind === 'year' ? [] : [{ kind: 'month' as const, field: 'month' }]),
    ],
    hidden: [],
  };
}
