/**
 * The Personnel employee-listing COLUMN CATALOGUE (feedback 579255c3, points 1–3 and 10).
 *
 * Pure — no React, no drizzle, no db/schema — for three reasons that all matter:
 *   1. the picker is a CLIENT island and the table is a SERVER component, and both must agree on the
 *      same catalogue without one dragging the other's dependencies into its bundle;
 *   2. the Excel export (app/admin/personnel/export/route.ts) resolves the SAME columns in the SAME
 *      order, which is the whole of point 10 — "the export should follow the selected columns";
 *   3. normalisation is the only thing standing between a tampered/legacy saved preference and a table
 *      with no columns in it, so it is unit-testable on its own.
 *
 * LABELS LIVE IN messages/*.json, NOT HERE. A key is not a label (a `labelKey` resolved against the
 * catalogue is what the reader actually sees), so this module carries only the key and every caller
 * resolves `people.list.col*` itself. That keeps the client island free of dynamic t() calls.
 */

/**
 * Every column the listing can show, in CATALOGUE order — which is also the picker's order for a user
 * who has never rearranged anything. The first six are the reporter's requested default view
 * (Emp ID | Full Name | Company | Department | Position | Status); everything after `status` is an
 * opt-in extra drawn from information Personnel already holds.
 *
 * ⚠️ EIGHT REQUESTED FIELDS ARE ABSENT ON PURPOSE — see UNAVAILABLE_EMPLOYEE_FIELDS below. They are
 * NAMED on screen rather than silently omitted (the 18103ba4 precedent). Do not add a column here for
 * one of them: there is no employee information behind it to render.
 */
export const EMPLOYEE_COLUMN_KEYS = [
  'code',
  'name',
  'company',
  'department',
  'position',
  'status',
  'jobGrade',
  'employmentType',
  'reportingTo',
  'businessUnit',
  'costCenter',
  'workLocation',
  'groupJoinDate',
  'joinDate',
  'confirmationDate',
  'email',
] as const;

export type EmployeeColumnKey = (typeof EMPLOYEE_COLUMN_KEYS)[number];

/** The default view (point 1): Emp ID, Full Name, Company, Department, Position, Status. `Hired`
 *  (Group Join Date) is deliberately NOT here — the reporter asked for it off the default listing —
 *  but it stays in the catalogue above as an optional column, so nothing is lost. */
export const DEFAULT_EMPLOYEE_COLUMNS: readonly EmployeeColumnKey[] = [
  'code',
  'name',
  'company',
  'department',
  'position',
  'status',
];

/**
 * Full Name cannot be turned off. It carries the link to the profile and the avatar, so a table without
 * it is a grid of codes with nowhere to click — the same reasoning behind the dashboard's mandatory
 * cards. Everything else, including Emp ID, is the reader's choice.
 */
export const MANDATORY_EMPLOYEE_COLUMNS: readonly EmployeeColumnKey[] = ['name'];

/**
 * The eight fields on the reporter's list that DO NOT EXIST anywhere in the system — not as employee
 * information, not as a system label, not in the employee import file. They are surfaced in the picker's
 * footnote so the answer to "where is Division?" is on the screen that raised the question, following
 * 18103ba4, which refused the same family for the same reason and named them rather than omitting them.
 *
 * ⚠️ Job Grade is NOT one of them — employment.grade_id → job_grade is real (55 grades, 21 of 40
 * employments carry one) and is a column above.
 */
export const UNAVAILABLE_EMPLOYEE_FIELDS = [
  'division',
  'section',
  'line',
  'team',
  'region',
  'base',
  'employeeCategory',
  'employeeType',
] as const;

export type UnavailableEmployeeField = (typeof UNAVAILABLE_EMPLOYEE_FIELDS)[number];

/** The saved per-user preference: which columns are shown, and the order of ALL of them. */
export type EmployeeColumnPrefs = {
  selected: EmployeeColumnKey[];
  /** Every catalogue key exactly once — the picker's row order, shown and hidden alike. */
  order: EmployeeColumnKey[];
};

const KEY_SET: ReadonlySet<string> = new Set(EMPLOYEE_COLUMN_KEYS);

export const isEmployeeColumnKey = (v: unknown): v is EmployeeColumnKey =>
  typeof v === 'string' && KEY_SET.has(v);

/** Keep only real catalogue keys, in the given order, without repeats. */
function cleanKeys(raw: unknown): EmployeeColumnKey[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<EmployeeColumnKey>();
  for (const v of raw) if (isEmployeeColumnKey(v)) seen.add(v);
  // Set preserves insertion order, which IS the caller's order.
  return [...seen];
}

/**
 * Turn anything at all — null, a legacy value, a hand-edited jsonb, a tampered client payload — into a
 * usable {selected, order}. Never throws and never returns an empty table:
 *   • unknown / removed keys are dropped (a column deleted from the catalogue must not break a saved view);
 *   • every catalogue key appears in `order` exactly once, saved keys first, new ones appended in
 *     catalogue order so a column added in a later release shows up at a sensible place rather than first;
 *   • `selected` is re-sorted into `order`, because the table renders `order ∩ selected` and a saved
 *     selection whose sequence disagreed with the order would render in a third, arbitrary sequence;
 *   • an empty or absent selection falls back to the DEFAULT view, and the mandatory columns are forced
 *     back in — so no saved value can produce a table with no columns.
 */
export function normalizeEmployeeColumns(raw: unknown): EmployeeColumnPrefs {
  const o = (raw ?? {}) as { selected?: unknown; order?: unknown };
  const savedOrder = cleanKeys(o.order);
  const order: EmployeeColumnKey[] = [
    ...savedOrder,
    ...EMPLOYEE_COLUMN_KEYS.filter((k) => !savedOrder.includes(k)),
  ];
  const savedSelected = cleanKeys(o.selected);
  const chosen = new Set<EmployeeColumnKey>(
    savedSelected.length ? savedSelected : DEFAULT_EMPLOYEE_COLUMNS,
  );
  for (const k of MANDATORY_EMPLOYEE_COLUMNS) chosen.add(k);
  return { selected: order.filter((k) => chosen.has(k)), order };
}

/** The columns the table/export actually renders, left to right. Always at least one. */
export function resolveEmployeeColumns(raw: unknown): EmployeeColumnKey[] {
  return normalizeEmployeeColumns(raw).selected;
}

/**
 * The fields a listing row must carry for every catalogue column to have an answer. Structural on
 * purpose — it is satisfied by core/read.ts's EmployeeListRow without this pure module importing drizzle,
 * db/schema or anything else that must not reach a browser bundle.
 */
export type EmployeeColumnRow = {
  employeeCode: string | null;
  name: string;
  email: string;
  company: string;
  department: string | null;
  position: string | null;
  jobGrade: string | null;
  reportingTo: string | null;
  businessUnit: string | null;
  costCenter: string | null;
  workLocation: string | null;
  hiredOn: string;
  joinDate: string | null;
  confirmationDate: string | null;
};

/**
 * ONE column → text projection, shared by the table and the Excel export (point 10: "the export should
 * follow the same selected columns"). Two separate switch statements is how a file comes to print a
 * different Position from the screen it was exported off.
 *
 * The two values that need a translator — the derived Status badge and the Employment Type — arrive
 * PRE-RESOLVED from the caller, because this module holds no i18n and a labelKey is not a label.
 * Returns null where the employee has no answer; the caller decides between an em dash (table) and an
 * empty cell (spreadsheet).
 */
export function employeeColumnText(
  row: EmployeeColumnRow,
  key: EmployeeColumnKey,
  resolved: { status: string; employmentType: string | null },
): string | null {
  switch (key) {
    case 'code':
      return row.employeeCode;
    case 'name':
      return row.name;
    case 'company':
      return row.company;
    case 'department':
      return row.department;
    case 'position':
      return row.position;
    case 'status':
      return resolved.status;
    case 'jobGrade':
      return row.jobGrade;
    case 'employmentType':
      return resolved.employmentType;
    case 'reportingTo':
      return row.reportingTo;
    case 'businessUnit':
      return row.businessUnit;
    case 'costCenter':
      return row.costCenter;
    case 'workLocation':
      return row.workLocation;
    case 'groupJoinDate':
      return row.hiredOn;
    case 'joinDate':
      return row.joinDate;
    case 'confirmationDate':
      return row.confirmationDate;
    case 'email':
      return row.email;
  }
}

/**
 * Resolve an EXPLICIT column list (the `cols=` search param the screen hands its own Export link) against
 * the catalogue, falling back to the saved preference when the parameter is absent or carries nothing
 * usable. The export takes the screen's list rather than re-reading the preference so that the file and
 * the table can never disagree — even if the preference changed in another tab between the two requests.
 */
export function columnsFromParam(param: string | null | undefined, saved: unknown): EmployeeColumnKey[] {
  const asked = cleanKeys((param ?? '').split(',').map((s) => s.trim()));
  if (!asked.length) return resolveEmployeeColumns(saved);
  return resolveEmployeeColumns({ selected: asked, order: asked });
}
