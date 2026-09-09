/**
 * a6fe37fc ROUND 4, FIX PASS — THE RESTORATION HAS TO WORK ON A **CONVERTED** TENANT.
 *
 * ═══ WHY THIS FILE EXISTS, AND WHY IT IS A DATABASE TEST RATHER THAN A SOURCE GUARD ═══
 *
 * Round 4 shipped a read-only list of the approval rules whose business unit / department / position
 * scope no screen has shown since `706d34e8` removed the Workflow Matrix (IA §4.1). It was filtered to
 * `templateId === null` — and that filter made it render NOTHING on the only data that matters:
 *
 *   · `convertLegacyApprovalRules` COPIES business_unit_id / department_id / position_id onto every row
 *     it expands and STAMPS a template_id on it (core/leave-approval-consolidation.ts).
 *   · r94 ran `scripts/convert-approval-rules.ts` on production — 51 assignments converted — after which
 *     NO active rule matched `template_id is null or leave_type_id is null` at all.
 *   · So on the customer's tenant every org-scoped rule is a converted, TEMPLATED row; the template-less
 *     list is empty by construction; and the columns that decide who approves stayed invisible.
 *
 * `test/leave-config-round4.test.ts` is a static source guard and could not have caught that: the code it
 * read was internally consistent, and the defect was in WHICH ROWS THE QUERY RETURNS. So this file plants
 * the converted shape in a real database — `template_id NOT NULL` **and** `department_id` set — and reads
 * it back through the loader the page actually calls.
 *
 * ⚠️ THE PROPERTY: a stored scope column that decides who approves is VISIBLE. Not "the query has the
 * right predicate" — the loader's returned row must carry the department's NAME.
 *
 * ⚠️ AND IT MUST NOT DRIFT FROM THE MATCHER. The effective chain of a template-driven row is its
 * template's, and only while that template is ACTIVE (`decideApproval`'s `effectiveLevels`, which reads
 * `loadApprovalRuleSet`'s active-templates-only map). The last case asserts the two agree, over the same
 * rows, rather than trusting the loader to have copied the rule correctly.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { decideApproval, loadApprovalRuleSet, type LeaveLevelKind } from '../core/leave-approval-policy';
import {
  createApprovalTemplate,
  listApprovalTemplates,
  listOrgScopedApprovalRules,
  setApprovalTemplateActive,
} from '../core/leave-approval-template';
import { loadApprovalRuleScopes } from '../app/admin/leave-config/approval-readout';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const ctx = () => adminCtx(b);
const UNKNOWN = '(unknown)';

/** The company list the page hands the loader — already trimmed to the admin's scope. */
const inScope = () => [{ id: b.companyId, name: 'Acme Sdn Bhd' }];

const templates = () => listApprovalTemplates(ctx());

/** Insert one leave_approval_policy row directly, so the exact stored SHAPE is under the test's control. */
async function insertRule(v: {
  companyId?: string;
  ruleName?: string | null;
  leaveTypeId?: string | null;
  departmentId?: string | null;
  businessUnitId?: string | null;
  positionId?: string | null;
  templateId?: string | null;
  levels?: LeaveLevelKind[];
  active?: boolean;
}) {
  const [row] = await owner.db
    .insert(schema.leaveApprovalPolicy)
    .values({
      tenantId: b.tenantId,
      companyId: v.companyId ?? b.companyId,
      ruleName: v.ruleName ?? null,
      leaveTypeId: v.leaveTypeId ?? null,
      departmentId: v.departmentId ?? null,
      businessUnitId: v.businessUnitId ?? null,
      positionId: v.positionId ?? null,
      templateId: v.templateId ?? null,
      levels: v.levels ?? [],
      active: v.active ?? true,
    })
    .returning({ id: schema.leaveApprovalPolicy.id });
  return row.id;
}

/** A template, and the id of the row it lives in. */
async function makeTemplate(name: string, levels: LeaveLevelKind[]) {
  const { id } = await createApprovalTemplate(ctx(), { name, levels });
  return id;
}

/** The exact shape `convertLegacyApprovalRules` leaves behind: a template, a leave type, and the org
 *  scope copied across from the rule it replaced. This is what production is made of. */
async function convertedShapeRule(departmentId: string, templateId: string) {
  return insertRule({
    ruleName: 'Finance sign-off',
    leaveTypeId: b.annualLeaveTypeId,
    departmentId,
    templateId,
    levels: [],
  });
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('the org-scope projection finds the rows listLegacyApprovalRules cannot', () => {
  it('returns a CONVERTED rule — template_id NOT NULL and department_id set', async () => {
    const tpl = await makeTemplate('Standard', ['direct_manager', 'hr_admin']);
    const ruleId = await convertedShapeRule(b.deptA, tpl);

    const rows = await listOrgScopedApprovalRules(ctx());
    expect(rows.map((r) => r.id)).toContain(ruleId);
    const row = rows.find((r) => r.id === ruleId)!;
    expect(row.departmentId).toBe(b.deptA);
    expect(row.templateId).toBe(tpl);
    // …and this is the row `listLegacyApprovalRules` cannot see: it carries BOTH a template and a
    // leave type, so `template_id is null or leave_type_id is null` excludes it.
    const legacy = await withTenant(ctx(), async (tx) =>
      (await import('../core/leave-approval-consolidation')).listLegacyApprovalRules(tx),
    );
    expect(
      legacy.map((r) => r.id),
      'listLegacyApprovalRules now returns converted rows — if that changed, the two reads overlap and ' +
        'the loader must still de-duplicate by rule id',
    ).not.toContain(ruleId);
  });

  it('skips an INACTIVE org-scoped rule — an archived rule routes nothing', async () => {
    const tpl = await makeTemplate('Standard', ['hr_admin']);
    const ruleId = await insertRule({
      leaveTypeId: b.annualLeaveTypeId,
      departmentId: b.deptA,
      templateId: tpl,
      active: false,
    });
    expect((await listOrgScopedApprovalRules(ctx())).map((r) => r.id)).not.toContain(ruleId);
  });

  it('skips a rule with no org scope at all — the assignment list already describes it in full', async () => {
    const tpl = await makeTemplate('Standard', ['hr_admin']);
    const ruleId = await insertRule({ leaveTypeId: b.annualLeaveTypeId, templateId: tpl });
    expect((await listOrgScopedApprovalRules(ctx())).map((r) => r.id)).not.toContain(ruleId);
  });
});

describe('the read-out shows a converted rule’s org scope (IA §4.1 — the point of the round)', () => {
  it('renders the DEPARTMENT NAME of a templated, converted rule', async () => {
    const tpl = await makeTemplate('Standard', ['direct_manager', 'hr_admin']);
    const ruleId = await convertedShapeRule(b.deptA, tpl);

    const rows = await loadApprovalRuleScopes(ctx(), inScope(), await templates(), UNKNOWN);
    const row = rows.find((r) => r.id === ruleId);
    expect(
      row,
      'the converted rule is missing from the read-out — this is the shape production is entirely made ' +
        'of, and its department decides who approves',
    ).toBeTruthy();
    // THE PROPERTY. Not the id, not the predicate: the NAME an administrator reads.
    expect(row!.department).toBe('Finance');
    expect(row!.companyName).toBe('Acme Sdn Bhd');
    expect(row!.leaveTypeName).toBe('Annual Leave');
    // The chain comes from the template, and the template is named so the row explains itself.
    expect(row!.levels).toEqual(['direct_manager', 'hr_admin']);
    expect(row!.templateName).toBe('Standard');
  });

  it('shows a business-unit and a position scope on converted rules too', async () => {
    const tpl = await makeTemplate('Standard', ['hr_admin']);
    const [bu] = await owner.db
      .insert(schema.businessUnit)
      .values({ tenantId: b.tenantId, companyId: b.companyId, code: 'BU-N', name: 'Northern Region' })
      .returning({ id: schema.businessUnit.id });
    const buRule = await insertRule({
      leaveTypeId: b.annualLeaveTypeId,
      businessUnitId: bu.id,
      templateId: tpl,
    });
    const posRule = await insertRule({
      leaveTypeId: b.annualLeaveTypeId,
      positionId: b.positionId,
      templateId: tpl,
    });

    const rows = await loadApprovalRuleScopes(ctx(), inScope(), await templates(), UNKNOWN);
    expect(rows.find((r) => r.id === buRule)?.businessUnit).toBe('Northern Region');
    expect(rows.find((r) => r.id === posRule)?.position).toBe('Executive');
  });

  it('still shows the template-LESS rules, with their own chain', async () => {
    const ruleId = await insertRule({ ruleName: 'Custom', levels: ['hr_manager', 'payroll'] });
    const rows = await loadApprovalRuleScopes(ctx(), inScope(), await templates(), UNKNOWN);
    const row = rows.find((r) => r.id === ruleId);
    expect(row).toBeTruthy();
    expect(row!.levels).toEqual(['hr_manager', 'payroll']);
    expect(row!.templateName).toBeNull();
  });

  it('lists a rule that is BOTH template-less and org-scoped exactly ONCE', async () => {
    const ruleId = await insertRule({ departmentId: b.deptA, levels: ['hr_admin'] });
    const rows = await loadApprovalRuleScopes(ctx(), inScope(), await templates(), UNKNOWN);
    expect(rows.filter((r) => r.id === ruleId)).toHaveLength(1);
    expect(rows.find((r) => r.id === ruleId)!.department).toBe('Finance');
  });

  it('omits a templated rule with no org scope — that one the assignment list DOES describe', async () => {
    const tpl = await makeTemplate('Standard', ['hr_admin']);
    const ruleId = await insertRule({ leaveTypeId: b.annualLeaveTypeId, templateId: tpl });
    const rows = await loadApprovalRuleScopes(ctx(), inScope(), await templates(), UNKNOWN);
    expect(
      rows.map((r) => r.id),
      'listing a fully-described assignment row again is the duplication 706d34e8 removed, in a new place',
    ).not.toContain(ruleId);
  });

  it('never leaves another company’s rule in the list — the company filter, on BOTH reads', async () => {
    const tpl = await makeTemplate('Standard', ['hr_admin']);
    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [otherDept] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: other.id, name: 'Beta Ops' })
      .returning({ id: schema.department.id });
    // One row per read path, both belonging to the company the admin cannot see.
    const templatedElsewhere = await insertRule({
      companyId: other.id,
      leaveTypeId: b.annualLeaveTypeId,
      departmentId: otherDept.id,
      templateId: tpl,
    });
    const untemplatedElsewhere = await insertRule({ companyId: other.id, levels: ['hr_admin'] });

    const rows = await loadApprovalRuleScopes(ctx(), inScope(), await templates(), UNKNOWN);
    expect(rows.map((r) => r.id)).not.toContain(templatedElsewhere);
    expect(rows.map((r) => r.id)).not.toContain(untemplatedElsewhere);
  });
});

describe('the chain the read-out prints is the chain the MATCHER resolves', () => {
  it('agrees with decideApproval for the converted rule’s own employee', async () => {
    const tpl = await makeTemplate('Standard', ['direct_manager', 'hr_admin']);
    const ruleId = await convertedShapeRule(b.deptA, tpl);

    const rows = await loadApprovalRuleScopes(ctx(), inScope(), await templates(), UNKNOWN);
    const printed = rows.find((r) => r.id === ruleId)!.levels;

    const set = await withTenant(ctx(), (tx) => loadApprovalRuleSet(tx));
    const decided = decideApproval(set, b.companyId, b.annualLeaveTypeId, { departmentId: b.deptA });
    expect(decided.ruleId, 'the planted rule must be the one that wins for a Finance employee').toBe(ruleId);
    expect(printed, 'the read-out and the engine disagree about this rule’s chain').toEqual(decided.levels);
  });

  it('prints NO steps for a rule whose template was deactivated, exactly as the matcher resolves it', async () => {
    // Deactivated FIRST: `setApprovalTemplateActive` refuses to retire a template an active rule still
    // points at, so the row is planted afterwards — this is the degenerate state `decideApproval`
    // explicitly handles (`set.templateLevels.get(id) ?? []`), and the read-out must handle it the same.
    const tpl = await makeTemplate('Retired', ['payroll']);
    await setApprovalTemplateActive(ctx(), tpl, false);
    const ruleId = await convertedShapeRule(b.deptA, tpl);

    const rows = await loadApprovalRuleScopes(ctx(), inScope(), await templates(), UNKNOWN);
    const row = rows.find((r) => r.id === ruleId)!;
    // `loadApprovalRuleSet` reads ACTIVE templates only, so the rule resolves to nothing and the request
    // falls through to the org-wide default. Printing ['payroll'] here would tell an administrator a
    // chain applies that does not — the cell says "falls back" instead.
    expect(row.levels).toEqual([]);

    const set = await withTenant(ctx(), (tx) => loadApprovalRuleSet(tx));
    const decided = decideApproval(set, b.companyId, b.annualLeaveTypeId, { departmentId: b.deptA });
    expect(decided.ruleId, 'a rule with an empty effective chain never names itself as the winner').toBeNull();
  });

  it('keeps an ARCHIVED department’s name visible — an archived label still routes', async () => {
    const tpl = await makeTemplate('Standard', ['hr_admin']);
    const ruleId = await convertedShapeRule(b.deptA, tpl);
    await owner.db
      .update(schema.department)
      .set({ archivedAt: new Date() })
      .where(eq(schema.department.id, b.deptA));

    const rows = await loadApprovalRuleScopes(ctx(), inScope(), await templates(), UNKNOWN);
    const row = rows.find((r) => r.id === ruleId)!;
    expect(row.department, 'an archived department is still what the rule matches on').toBe('Finance');
    expect(row.department).not.toBe(UNKNOWN);
  });
});
