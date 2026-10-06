/**
 * THE ONE DECLARATION OF WHAT REFERENCES A COMPANY, and what deleting the company does about each (f00bd1eb).
 *
 * ## Why this file exists
 *
 * `deleteCompany` counted THREE tables (department, employment, child company) and the panel's `inUse` asked
 * the same three. The database carries a foreign key to `company.id` from FORTY-FIVE columns (forty-eight
 * key columns on production: three of the keys are composite with `tenant_id`). Every company created on the
 * Organization screen is born with six payroll cycles, and with a TOIL policy when that module is active, so
 * a company nobody ever used — ABC Comapny on production — was offered Delete, refused by Postgres on a
 * payroll_cycle row, and the raw driver message was put in front of the administrator.
 *
 * This is core/leave-type-refs.ts's pattern, for the reason recorded there: two hand-written lists drift, so
 * there is ONE list and both the panel's answer (`companyDeleteStatus` in core/read.ts) and the delete guard
 * (`deleteCompany` in core/admin.ts) are generated from it, through the same SQL text. And the list is the
 * DATABASE's: test/company-referrers.test.ts reads the live foreign keys out of the test database and fails
 * when a new table references `company` (or one of the tables deleted with it) until somebody comes here and
 * decides what deleting a company should do about it. **Adding the row here IS the fix; do not widen the
 * test.**
 *
 * ## The dispositions
 *
 * - `employees` — REFUSES. Any employee record, former employees and unfinished drafts included. An
 *   employment that ended is still a person's employment history.
 * - `payroll`   — REFUSES. A payroll run, payslip, tax payment or statutory report, even when the employees
 *   behind it are gone: it is evidence of money paid and of filings made.
 * - `other`     — REFUSES until the link is removed: a sub-company, a user given access to the company, an
 *   invitation, a reporting-line scope, a review cycle, a module grant scoped to it.
 * - `config`    — DELETED WITH THE COMPANY, in declaration order, in the same transaction. The automatic
 *   setup (payroll cycles, TOIL policy, payslip display settings) and any other per-company setting that
 *   means nothing once the company is gone.
 * - `config-if-unreferenced` — the company's own org structure (department, position, location, cost
 *   centre, business unit). Deleted with it ONLY if nothing outside the company points at the row; a
 *   department another company's employee is assigned to refuses as `other`.
 *
 * ## The second level — what points INTO the tables deleted with the company
 *
 * The plan named the rule only for the org structure; it holds for every table deleted here, so it is
 * applied to all of them (`COMPANY_CONFIG_DEPENDENTS`). If a row OUTSIDE the company references a row the
 * company delete would remove — another company's leave approval rule naming our department, an employee of
 * another company whose default shift is ours, a holiday group holding our holiday — the delete REFUSES as
 * `other` rather than either failing on a nested foreign key or, where the key is ON DELETE SET NULL, quietly
 * changing another company's records. The only rows let go with their parent are its own parts (ON DELETE
 * CASCADE children such as a shift's OT windows).
 *
 * ## Order
 *
 * Cascaded rows are deleted in declaration order, so a table must precede any cascaded table it references
 * (company_statutory_authority before company_bank_profile, company_payroll_config before payroll_policy,
 * leave_approval_policy before department/position/business_unit, shift before attendance_rule, department
 * before business_unit). The drift test asserts this against the live keys.
 */
import type { CompanyDeleteBlock } from '../lib/company-delete';

export type CompanyRefDisposition = 'employees' | 'payroll' | 'other' | 'config' | 'config-if-unreferenced';

export type CompanyRef = {
  /** Physical table name — matched against the live schema by the drift test. */
  table: string;
  /** The column that references `company.id`. */
  column: string;
  disposition: CompanyRefDisposition;
  /**
   * `config` only: rows matching one of these conditions REFUSE with `reason` instead of being deleted.
   * `{r}` is replaced by the table's alias. Used for `usage_snapshot`, whose zero rows are setup noise and
   * whose non-zero rows are evidence.
   */
  refuseWhere?: readonly { reason: CompanyDeleteBlock; where: string }[];
  /**
   * `config` only: the app role has no DELETE on this table, so its company rows are removed by calling this
   * function (one argument, the company id; returns the row count) instead of a plain DELETE.
   */
  deleteFunction?: string;
  /** Why it carries the disposition it does — read by whoever adds the forty-sixth. */
  note: string;
};

export const COMPANY_REFERRERS: readonly CompanyRef[] = [
  // ── employees: any row refuses ───────────────────────────────────────────────────────────────────────
  { table: 'employment', column: 'company_id', disposition: 'employees', note: 'The employment itself, terminated ones included: a former employee is still employment history.' },
  { table: 'assignment', column: 'company_id', disposition: 'employees', note: 'An employee\'s placement (department, position) over time. Exists only alongside an employment.' },
  { table: 'employee_draft', column: 'company_id', disposition: 'employees', note: 'An unfinished Create New Employee record, which may hold a reserved Employee ID. The plan counts drafts as employee records.' },
  { table: 'employee_import_run', column: 'company_id', disposition: 'employees', note: 'A bulk employee import into this company: the record of who was created and from which file.' },
  { table: 'employment_tax_scheme_my', column: 'company_id', disposition: 'employees', note: 'An employee\'s declared Malaysian tax scheme. Per employment, so it is an employee record.' },
  { table: 'employment_tax_selection_my', column: 'company_id', disposition: 'employees', note: 'An employee\'s tax-scheme selection and its provenance. Per employment.' },

  // ── payroll: any row refuses ─────────────────────────────────────────────────────────────────────────
  { table: 'payroll_batch', column: 'company_id', disposition: 'payroll', note: 'A payroll run. Its payslips hang off it, so this is where every payslip is counted.' },
  { table: 'pay_period', column: 'company_id', disposition: 'payroll', note: 'A payroll period opened or closed for the company.' },
  { table: 'pcb_payment', column: 'company_id', disposition: 'payroll', note: 'A recorded PCB tax payment to LHDN. Money that has left the company.' },
  { table: 'payroll_individual_txn', column: 'company_id', disposition: 'payroll', note: 'A one-off payroll transaction keyed for an employee.' },
  { table: 'statutory_report', column: 'company_id', disposition: 'payroll', note: 'A generated or filed statutory report (EPF, SOCSO, EIS, PCB, EA). A filing is evidence.' },
  { table: 'back_pay_run', column: 'company_id', disposition: 'payroll', note: 'A back-pay run against a past period.' },

  // ── other links: any row refuses until the link is removed ───────────────────────────────────────────
  { table: 'company', column: 'parent_company_id', disposition: 'other', note: 'A sub-company. Re-parent or delete it first; deleting a parent must never orphan a subtree.' },
  { table: 'role_assignment', column: 'company_id', disposition: 'other', note: 'A user given a role scoped to this company. Access is removed deliberately, never as a side effect.' },
  { table: 'app_invitation', column: 'company_id', disposition: 'other', note: 'An invitation to join with a role at this company — an access grant waiting to happen.' },
  { table: 'reporting_line', column: 'scope_company_id', disposition: 'other', note: 'A reporting line scoped to this company. It belongs to employments, possibly of another company.' },
  { table: 'review_cycle', column: 'company_id', disposition: 'other', note: 'A performance review cycle run for this company.' },
  { table: 'tenant_module', column: 'company_id', disposition: 'other', note: 'A module grant scoped to this company. Composite key with tenant_id. Entitlement is the platform\'s to remove.' },
  { table: 'module_change_request', column: 'company_id', disposition: 'other', note: 'A module activation request for this company. Composite key with tenant_id.' },

  // ── config: deleted with the company, in this order ──────────────────────────────────────────────────
  { table: 'company_logo', column: 'company_id', disposition: 'config', note: 'The company\'s logo image, held in its own side table.' },
  { table: 'company_statutory_my', column: 'company_id', disposition: 'config', note: 'The company\'s own EPF / SOCSO / LHDN registration numbers.' },
  { table: 'company_statutory_authority', column: 'company_id', disposition: 'config', note: 'Per-authority payment setup. Before company_bank_profile, which it references.' },
  { table: 'company_bank_profile', column: 'company_id', disposition: 'config', note: 'The company\'s disbursement bank accounts.' },
  { table: 'company_payroll_config', column: 'company_id', disposition: 'config', note: 'Cut-off and pay days. Before payroll_policy, which it references.' },
  { table: 'payroll_policy', column: 'company_id', disposition: 'config', note: 'The company\'s payroll policies.' },
  { table: 'payslip_information_setting', column: 'company_id', disposition: 'config', note: 'Payslip display settings. One row on ABC Comapny on production.' },
  { table: 'payroll_cycle', column: 'company_id', disposition: 'config', note: 'THE AUTOMATIC SETUP: createCompany seeds six. Six rows on ABC Comapny — the rows that made Delete fail.' },
  { table: 'payroll_anomaly_config', column: 'company_id', disposition: 'config', note: 'Per-company payroll anomaly detector settings.' },
  { table: 'payroll_permission_grant', column: 'company_id', disposition: 'config', note: 'Per-company payroll permission overrides. ON DELETE CASCADE already; deleted explicitly for one rule.' },
  { table: 'employee_id_config', column: 'company_id', disposition: 'config', note: 'The Employee ID running-number setup. A draft holding one of its numbers is an employee record and refuses first.' },
  { table: 'leave_approval_policy', column: 'company_id', disposition: 'config', note: 'Leave approval routing. Before department, position and business_unit, which it may name.' },
  { table: 'leave_encashment_policy', column: 'company_id', disposition: 'config', note: 'Leave encashment rules for this company. Setup only; encashment paid is payroll.' },
  { table: 'attendance_allowance_policy', column: 'company_id', disposition: 'config', note: 'Attendance allowance rules for this company. Setup only; paid allowances live in payroll.' },
  { table: 'attendance_policy', column: 'company_id', disposition: 'config', note: 'The company\'s attendance policy (grace periods, clocking rules). Setup only.' },
  { table: 'shift', column: 'company_id', disposition: 'config', note: 'Shift definitions. Before attendance_rule, which a shift references.' },
  { table: 'attendance_rule', column: 'company_id', disposition: 'config', note: 'Attendance schedule rules.' },
  { table: 'toil_policy', column: 'company_id', disposition: 'config', note: 'THE AUTOMATIC SETUP for the TOIL module (the leave credit policy). One row on ABC Comapny.' },
  { table: 'holiday', column: 'company_id', disposition: 'config', note: 'Company-specific holidays. One in a holiday group refuses (see the dependents).' },
  { table: 'label_company_assignment', column: 'company_id', disposition: 'config', note: 'Which shared system labels this company uses. Removes the link, never the label.' },
  {
    table: 'usage_snapshot',
    column: 'company_id',
    disposition: 'config',
    refuseWhere: [
      // active_users counts users through an employment at the company (core/usage-metering.ts), so both
      // figures are evidence of employees.
      { reason: 'employees', where: '{r}.active_employments > 0 or {r}.active_users > 0' },
      { reason: 'payroll', where: '{r}.payslips_generated > 0' },
    ],
    // The metering record stays SELECT-only for the app role (0313, pinned by test/module-entitlement-rls);
    // 0511's SECURITY DEFINER function removes the all-zero rows and nothing else.
    deleteFunction: 'app.delete_unused_usage_snapshots',
    note: 'Nightly platform usage. All-zero rows (five on ABC Comapny) are deleted and counted on company.deleted — the plan\'s decision; migration 0511\'s function removes exactly those. A non-zero row is evidence and refuses. Composite key with tenant_id.',
  },

  // ── config-if-unreferenced: the company's own org structure, deleted unless something outside uses it ──
  { table: 'department', column: 'company_id', disposition: 'config-if-unreferenced', note: 'Before business_unit, which a department references.' },
  { table: 'position', column: 'company_id', disposition: 'config-if-unreferenced', note: 'Positions of this company. An assignment or approval rule elsewhere naming one refuses.' },
  { table: 'location', column: 'company_id', disposition: 'config-if-unreferenced', note: 'Work locations; a clocking location may point at one.' },
  { table: 'cost_center', column: 'company_id', disposition: 'config-if-unreferenced', note: 'Cost centres of this company.' },
  { table: 'business_unit', column: 'company_id', disposition: 'config-if-unreferenced', note: 'Last: departments, assignments and approval rules reference it.' },
];

/** A foreign key INTO one of the tables deleted with the company. */
export type CompanyConfigDependent = {
  table: string;
  column: string;
  /** The cascaded table it references (by `id`). */
  references: string;
  /**
   * `part`   — an ON DELETE CASCADE child that is part of the parent row (a shift's OT windows). Goes with it.
   * `blocks` — a row here pointing at one of the company's rows refuses the delete as `other`, unless the row
   *            is itself one of the company's own rows being deleted.
   */
  effect: 'part' | 'blocks';
  note: string;
};

export const COMPANY_CONFIG_DEPENDENTS: readonly CompanyConfigDependent[] = [
  { table: 'shift_ot_window', column: 'shift_id', references: 'shift', effect: 'part', note: 'A shift\'s clock-time OT windows. ON DELETE CASCADE.' },
  { table: 'attendance_rule_ot_row', column: 'rule_id', references: 'attendance_rule', effect: 'part', note: 'A rule\'s OT rows. ON DELETE CASCADE.' },
  { table: 'holiday_group_holiday', column: 'holiday_id', references: 'holiday', effect: 'blocks', note: 'ON DELETE CASCADE, but a holiday group may serve another company: removing our holiday from it would change their calendar. Refuses.' },
  { table: 'company_statutory_authority', column: 'bank_profile_id', references: 'company_bank_profile', effect: 'blocks', note: 'ON DELETE SET NULL. Another company paying from our account would silently lose it.' },
  { table: 'company_payroll_config', column: 'default_payroll_policy_id', references: 'payroll_policy', effect: 'blocks', note: 'Another company defaulting to our payroll policy.' },
  { table: 'employment', column: 'payroll_policy_id', references: 'payroll_policy', effect: 'blocks', note: 'ON DELETE SET NULL. Another company\'s employee on our payroll policy.' },
  { table: 'employment', column: 'attendance_rule_id', references: 'attendance_rule', effect: 'blocks', note: 'ON DELETE SET NULL. Another company\'s employee on our attendance rule.' },
  { table: 'employment', column: 'default_shift_id', references: 'shift', effect: 'blocks', note: 'ON DELETE SET NULL. Another company\'s employee on our shift.' },
  { table: 'shift', column: 'rule_id', references: 'attendance_rule', effect: 'blocks', note: 'Another company\'s shift built on our attendance rule.' },
  { table: 'employment_shift_arrangement', column: 'shift_id', references: 'shift', effect: 'blocks', note: 'Someone\'s dated shift arrangement on our shift.' },
  { table: 'roster_assignment', column: 'shift_id', references: 'shift', effect: 'blocks', note: 'A rostered day on our shift.' },
  { table: 'toil_accrual', column: 'policy_id', references: 'toil_policy', effect: 'blocks', note: 'TOIL accrued under our policy: leave somebody earned.' },
  { table: 'payroll_batch', column: 'payroll_cycle_id', references: 'payroll_cycle', effect: 'blocks', note: 'A payroll run on our cycle. Our own runs refuse as payroll first.' },
  { table: 'payroll_individual_txn', column: 'intended_cycle_id', references: 'payroll_cycle', effect: 'blocks', note: 'A transaction aimed at our cycle.' },
  { table: 'employment_pay_component', column: 'payroll_cycle_id', references: 'payroll_cycle', effect: 'blocks', note: 'r392 (4fffe638, 0514): a fixed transaction linked to our cycle. Refuses, like an individual transaction aimed at it.' },
  { table: 'employee_draft', column: 'reserved_config_id', references: 'employee_id_config', effect: 'blocks', note: 'ON DELETE SET NULL. A draft holding a number from our running-number setup.' },
  { table: 'leave_approval_policy', column: 'department_id', references: 'department', effect: 'blocks', note: 'Another company\'s (or a tenant-wide) approval rule naming our department.' },
  { table: 'leave_approval_policy', column: 'position_id', references: 'position', effect: 'blocks', note: 'An approval rule outside the company naming our position.' },
  { table: 'leave_approval_policy', column: 'business_unit_id', references: 'business_unit', effect: 'blocks', note: 'An approval rule outside the company naming our business unit.' },
  { table: 'department', column: 'parent_department_id', references: 'department', effect: 'blocks', note: 'Another company\'s department nested under ours.' },
  { table: 'department', column: 'business_unit_id', references: 'business_unit', effect: 'blocks', note: 'Another company\'s department in our business unit.' },
  { table: 'assignment', column: 'department_id', references: 'department', effect: 'blocks', note: 'Somebody assigned to our department. Our own employees refuse as employees first.' },
  { table: 'assignment', column: 'position_id', references: 'position', effect: 'blocks', note: 'Somebody in our position.' },
  { table: 'assignment', column: 'location_id', references: 'location', effect: 'blocks', note: 'Somebody working at our location.' },
  { table: 'assignment', column: 'cost_center_id', references: 'cost_center', effect: 'blocks', note: 'Somebody charged to our cost centre.' },
  { table: 'assignment', column: 'business_unit_id', references: 'business_unit', effect: 'blocks', note: 'Somebody in our business unit.' },
  { table: 'clocking_location', column: 'location_id', references: 'location', effect: 'blocks', note: 'A clocking geofence on our location.' },
  { table: 'reporting_line', column: 'scope_department_id', references: 'department', effect: 'blocks', note: 'A reporting line scoped to our department.' },
  { table: 'reporting_line', column: 'scope_business_unit_id', references: 'business_unit', effect: 'blocks', note: 'A reporting line scoped to our business unit.' },
];

/** The tables whose company rows are deleted with the company, in deletion order. */
export const cascadedReferrers = (): CompanyRef[] =>
  COMPANY_REFERRERS.filter((r) => r.disposition === 'config' || r.disposition === 'config-if-unreferenced');

const isCascadedTable = (table: string) => cascadedReferrers().some((r) => r.table === table);
const cascadedColumn = (table: string) => cascadedReferrers().find((r) => r.table === table)!.column;

/**
 * The refusal reason for the company identified by `idExpr`, as one SQL `case` expression: `'employees'`,
 * `'payroll'`, `'other'`, or NULL when the delete will succeed.
 *
 * THE ONLY PLACE THE ANSWER IS COMPUTED. `companyDeleteStatus` (what the panel shows) and `deleteCompany`
 * (what the server does) both run this text, so the panel cannot offer a confirmation the delete then
 * refuses, which is the reported fault. `idExpr` is a raw column reference (`company.id`), never input; the
 * tables and columns come from the declarations above. Callers bind the id itself as a parameter.
 */
export function companyDeleteBlockSqlText(idExpr: string): string {
  // Every identifier double-quoted: `position` is an SQL keyword, and quoting all of them is cheaper than
  // remembering which.
  const q = (name: string) => `"${name}"`;
  const groups: Record<CompanyDeleteBlock, string[]> = { employees: [], payroll: [], other: [] };
  COMPANY_REFERRERS.forEach((r, i) => {
    const a = `cr${i}`;
    const from = `from ${q(r.table)} ${a} where ${a}.${q(r.column)} = ${idExpr}`;
    if (r.disposition === 'employees' || r.disposition === 'payroll' || r.disposition === 'other') {
      groups[r.disposition].push(`exists (select 1 ${from})`);
    }
    for (const w of r.refuseWhere ?? []) {
      groups[w.reason].push(`exists (select 1 ${from} and (${w.where.split('{r}').join(a)}))`);
    }
  });
  COMPANY_CONFIG_DEPENDENTS.forEach((d, i) => {
    if (d.effect !== 'blocks') return;
    const dep = `cd${i}`;
    const own = `co${i}`;
    // Our row being referenced, by a row that is not itself one of ours being deleted with us.
    const outside = isCascadedTable(d.table)
      ? ` and ${dep}.${q(cascadedColumn(d.table))} is distinct from ${idExpr}`
      : '';
    groups.other.push(
      `exists (select 1 from ${q(d.table)} ${dep} join ${q(d.references)} ${own} on ${own}.id = ${dep}.${q(d.column)} ` +
        `where ${own}.${q(cascadedColumn(d.references))} = ${idExpr}${outside})`,
    );
  });
  const when = (reason: CompanyDeleteBlock) => `when ${groups[reason].join(' or ')} then '${reason}'`;
  return `case ${when('employees')} ${when('payroll')} ${when('other')} else null end`;
}
