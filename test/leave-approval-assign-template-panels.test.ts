/**
 * Feedback bb3938b9 — Assignment Template layout: consolidate the assignment criteria into ONE section.
 * Feedback 22de47c4 — that employee-scope criterion is the BENEFIT SCHEME, not the job grade.
 *
 * The Assign Template form offers four criteria in a single row of equally sized panels: Companies, Leave
 * Types, Benefit Schemes and Conditions (the leave-duration range the rule matrix already scopes on). The
 * last two are OPTIONAL: selecting none of a criterion means "applies to all", which writes null on that
 * dimension.
 *
 * That last sentence is the whole risk of this item — a silent change in who an existing template covers.
 * The first describe block pins it down directly: an assignment made the pre-bb3938b9 way keeps its row, its
 * ruleId and the chain its employees resolve to, before AND after a scoped assignment is added alongside it.
 *
 * 22de47c4 needed NO resolver change and no new column, which is the reason to prefer it over a
 * benefit_scheme_id on the rule: a benefit scheme IS (company, employment type, grade group), the rule matrix
 * already scopes on grade group (R41 72800eda) and employment type, and BOTH are resolved at submit time from
 * the requester's own assignment — the same two axes resolveEffectiveSchemeId matches a scheme on. So the
 * tests below assert the property the reporter actually asked for: an employee inherits the template of the
 * scheme they are in. Two refusals are pinned as well, because each one prevents a silent mis-route:
 *   - a scheme with NO grade group is refused (on a rule, a null grade group is a WILDCARD — assigning one
 *     would hand the template to the whole company instead of the ungrouped population);
 *   - a legacy grade-scoped assignment is never upserted onto or hidden; it keeps routing and stays listed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { resolveApprovalChain, setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import {
  assignApprovalTemplate,
  createApprovalTemplate,
  listTemplateAssignments,
} from '../core/leave-approval-template';
import { createBenefitScheme, createGradeGroup } from '../core/benefit-scheme';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const MANAGER = path.join(ROOT, 'app/admin/leave-approval/template-manager.tsx');
const PAGE = path.join(ROOT, 'app/admin/leave/approval/page.tsx');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

let b: Base;
let sickLeaveTypeId: string;
let gradeExec: string;
let gradeMgr: string;
/** Grade groups + the schemes over them: EXEC → "Leadership", MGR → "Management". */
let groupExec: string;
let groupMgr: string;
let schemeExec: string;
let schemeMgr: string;
/** A scheme deliberately left without a grade group — the refusal case. */
let schemeUngrouped: string;

const ctx = () => adminCtx(b);

const resolve = (
  leaveTypeId: string | null,
  attrs: {
    gradeId?: string | null;
    gradeGroupId?: string | null;
    employmentType?: 'full_time' | 'part_time' | 'contract' | 'intern' | null;
    days?: number | null;
  } = {},
) => withTenant(ctx(), (tx) => resolveApprovalChain(tx, b.companyId, leaveTypeId, attrs));

const assignmentRows = () =>
  owner.db
    .select({
      id: schema.leaveApprovalPolicy.id,
      leaveTypeId: schema.leaveApprovalPolicy.leaveTypeId,
      gradeId: schema.leaveApprovalPolicy.gradeId,
      gradeGroupId: schema.leaveApprovalPolicy.gradeGroupId,
      minDays: schema.leaveApprovalPolicy.minDays,
      maxDays: schema.leaveApprovalPolicy.maxDays,
      businessUnitId: schema.leaveApprovalPolicy.businessUnitId,
      departmentId: schema.leaveApprovalPolicy.departmentId,
      positionId: schema.leaveApprovalPolicy.positionId,
      employmentType: schema.leaveApprovalPolicy.employmentType,
      templateId: schema.leaveApprovalPolicy.templateId,
      active: schema.leaveApprovalPolicy.active,
    })
    .from(schema.leaveApprovalPolicy)
    .where(
      and(eq(schema.leaveApprovalPolicy.active, true), eq(schema.leaveApprovalPolicy.companyId, b.companyId)),
    );

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [sick] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code: 'SICK', name: 'Sick Leave', paid: true })
    .returning({ id: schema.leaveType.id });
  sickLeaveTypeId = sick.id;
  const [ge] = await owner.db
    .insert(schema.jobGrade)
    .values({ tenantId: b.tenantId, code: 'EXEC', name: 'Executive', rank: 1 })
    .returning({ id: schema.jobGrade.id });
  const [gm] = await owner.db
    .insert(schema.jobGrade)
    .values({ tenantId: b.tenantId, code: 'MGR', name: 'Manager', rank: 2 })
    .returning({ id: schema.jobGrade.id });
  gradeExec = ge.id;
  gradeMgr = gm.id;
  groupExec = (await createGradeGroup(ctx(), { name: 'Leadership', gradeIds: [gradeExec] })).id;
  groupMgr = (await createGradeGroup(ctx(), { name: 'Management', gradeIds: [gradeMgr] })).id;
  schemeExec = (
    await createBenefitScheme(ctx(), {
      companyId: b.companyId,
      employmentType: 'full_time',
      gradeGroupId: groupExec,
      name: 'Leadership scheme',
    })
  ).id;
  schemeMgr = (
    await createBenefitScheme(ctx(), {
      companyId: b.companyId,
      employmentType: 'full_time',
      gradeGroupId: groupMgr,
      name: 'Management scheme',
    })
  ).id;
  schemeUngrouped = (
    await createBenefitScheme(ctx(), {
      companyId: b.companyId,
      employmentType: 'contract',
      gradeGroupId: null,
      name: 'Contractors',
    })
  ).id;
  await setLeaveApprovalPolicy(ctx(), {
    companyId: b.companyId,
    levels: ['direct_manager', 'hr_admin'],
  });
});
afterAll(async () => {
  await closeAll();
});

describe('bb3938b9 — an assignment made the old way keeps covering exactly the same employees', () => {
  it('writes the identical fully-wildcard row when no scheme and no condition are chosen', async () => {
    const tpl = await createApprovalTemplate(ctx(), { name: 'Standard', levels: ['hr_admin'] });
    await assignApprovalTemplate(ctx(), {
      templateId: tpl.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });

    const rows = (await assignmentRows()).filter((r) => r.leaveTypeId === b.annualLeaveTypeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].gradeId).toBeNull();
    expect(rows[0].gradeGroupId).toBeNull();
    expect(rows[0].minDays).toBeNull();
    expect(rows[0].maxDays).toBeNull();
    expect(rows[0].businessUnitId).toBeNull();
    expect(rows[0].departmentId).toBeNull();
    expect(rows[0].positionId).toBeNull();
    expect(rows[0].employmentType).toBeNull();
  });

  it('re-assigning the same combination upserts the SAME row — it never forks a duplicate', async () => {
    const a = await createApprovalTemplate(ctx(), { name: 'A', levels: ['hr_admin'] });
    const c = await createApprovalTemplate(ctx(), { name: 'C', levels: ['payroll'] });
    const first = await assignApprovalTemplate(ctx(), {
      templateId: a.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });
    const second = await assignApprovalTemplate(ctx(), {
      templateId: c.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });

    expect(second.ruleIds).toEqual(first.ruleIds);
    expect((await assignmentRows()).filter((r) => r.leaveTypeId === b.annualLeaveTypeId)).toHaveLength(1);
    expect(await resolve(b.annualLeaveTypeId)).toEqual(['payroll']);
  });

  it('re-assigning the same scheme upserts that scheme’s row, not a second one', async () => {
    const a = await createApprovalTemplate(ctx(), { name: 'A', levels: ['hr_admin'] });
    const c = await createApprovalTemplate(ctx(), { name: 'C', levels: ['payroll'] });
    const p = {
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
      benefitSchemeIds: [schemeExec],
    };
    const first = await assignApprovalTemplate(ctx(), { ...p, templateId: a.id });
    const second = await assignApprovalTemplate(ctx(), { ...p, templateId: c.id });
    expect(second.ruleIds).toEqual(first.ruleIds);
    expect(
      (await assignmentRows()).filter((r) => r.leaveTypeId === b.annualLeaveTypeId && r.gradeGroupId === groupExec),
    ).toHaveLength(1);
  });

  it('adding a scheme- and a duration-scoped assignment leaves the pre-existing one resolving unchanged', async () => {
    const wide = await createApprovalTemplate(ctx(), { name: 'Wide', levels: ['hr_admin'] });
    const { ruleIds: wideRuleIds } = await assignApprovalTemplate(ctx(), {
      templateId: wide.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });
    // The employee set the wide assignment covers, captured BEFORE the new criteria exist.
    const before = {
      noScheme: await resolve(b.annualLeaveTypeId),
      exec: await resolve(b.annualLeaveTypeId, { gradeGroupId: groupExec, employmentType: 'full_time' }),
      mgr: await resolve(b.annualLeaveTypeId, { gradeGroupId: groupMgr, employmentType: 'full_time', days: 9 }),
    };

    const execOnly = await createApprovalTemplate(ctx(), { name: 'Exec only', levels: ['payroll'] });
    await assignApprovalTemplate(ctx(), {
      templateId: execOnly.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
      benefitSchemeIds: [schemeExec],
    });
    const longLeave = await createApprovalTemplate(ctx(), { name: 'Long leave', levels: ['hr_manager'] });
    await assignApprovalTemplate(ctx(), {
      templateId: longLeave.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
      minDays: 10,
    });

    // The original row is still there, still the same rule, still the same chain for everyone it covered
    // except the employees the NEW, more specific assignments deliberately carve out.
    const wideRow = (await assignmentRows()).find((r) => r.id === wideRuleIds[0]);
    expect(wideRow).toBeDefined();
    expect(wideRow?.gradeGroupId).toBeNull();
    expect(wideRow?.minDays).toBeNull();
    expect(await resolve(b.annualLeaveTypeId)).toEqual(before.noScheme);
    expect(await resolve(b.annualLeaveTypeId, { gradeGroupId: groupMgr, employmentType: 'full_time', days: 9 })).toEqual(
      before.mgr,
    );
    // ...and the carve-outs do what they say.
    expect(before.exec).toEqual(['hr_admin']);
    expect(await resolve(b.annualLeaveTypeId, { gradeGroupId: groupExec, employmentType: 'full_time' })).toEqual([
      'payroll',
    ]);
    expect(
      await resolve(b.annualLeaveTypeId, { gradeGroupId: groupMgr, employmentType: 'full_time', days: 12 }),
    ).toEqual(['hr_manager']);
  });
});

describe('22de47c4 — an employee inherits the template of the benefit scheme they are in', () => {
  it('assigns to the scheme’s grade group + employment type, the two axes a scheme IS', async () => {
    const tpl = await createApprovalTemplate(ctx(), { name: 'Leadership flow', levels: ['payroll'] });
    const { ruleIds } = await assignApprovalTemplate(ctx(), {
      templateId: tpl.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
      benefitSchemeIds: [schemeExec],
    });
    const row = (await assignmentRows()).find((r) => r.id === ruleIds[0]);
    expect(row?.gradeGroupId).toBe(groupExec);
    expect(row?.employmentType).toBe('full_time');
    // No individual grade is written — the dependency on grade selection is gone.
    expect(row?.gradeId).toBeNull();
  });

  it('routes an employee of that scheme, and NOT an employee of another scheme or employment type', async () => {
    const leadership = await createApprovalTemplate(ctx(), { name: 'Leadership flow', levels: ['payroll'] });
    await assignApprovalTemplate(ctx(), {
      templateId: leadership.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
      benefitSchemeIds: [schemeExec],
    });
    // In the scheme (its grade group AND its employment type) ⇒ the assigned chain.
    expect(await resolve(b.annualLeaveTypeId, { gradeGroupId: groupExec, employmentType: 'full_time' })).toEqual([
      'payroll',
    ]);
    // Same grade group but a different employment type is a DIFFERENT scheme ⇒ untouched.
    expect(await resolve(b.annualLeaveTypeId, { gradeGroupId: groupExec, employmentType: 'contract' })).toEqual([
      'direct_manager',
      'hr_admin',
    ]);
    // Another grade group ⇒ untouched.
    expect(await resolve(b.annualLeaveTypeId, { gradeGroupId: groupMgr, employmentType: 'full_time' })).toEqual([
      'direct_manager',
      'hr_admin',
    ]);
  });

  it('assigns the cross product of companies × leave types × schemes', async () => {
    const tpl = await createApprovalTemplate(ctx(), { name: 'Cross', levels: ['hr_admin'] });
    const { ruleIds } = await assignApprovalTemplate(ctx(), {
      templateId: tpl.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId, sickLeaveTypeId],
      benefitSchemeIds: [schemeExec, schemeMgr],
    });
    expect(ruleIds).toHaveLength(4);

    const list = await listTemplateAssignments(ctx());
    const mine = list.filter((r) => ruleIds.includes(r.ruleId));
    expect(mine).toHaveLength(4);
    expect(new Set(mine.map((r) => `${r.leaveTypeId}|${r.gradeGroupId}`)).size).toBe(4);
    for (const r of mine) expect(r.minDays).toBeNull();
  });

  it('refuses a scheme with no grade group instead of widening it to the whole company', async () => {
    // On a rule a null grade group is a WILDCARD, so writing this scheme's scope would hand the template to
    // every contract employee, not the ungrouped ones the scheme covers.
    const tpl = await createApprovalTemplate(ctx(), { name: 'Contractors', levels: ['hr_admin'] });
    await expect(
      assignApprovalTemplate(ctx(), {
        templateId: tpl.id,
        companyIds: [b.companyId],
        leaveTypeIds: [b.annualLeaveTypeId],
        benefitSchemeIds: [schemeUngrouped],
      }),
    ).rejects.toThrow(/grade group/i);
    // Nothing was written on the way to the refusal.
    expect((await assignmentRows()).filter((r) => r.templateId === tpl.id)).toHaveLength(0);
  });

  it('a legacy grade-scoped assignment is never upserted onto — it stays listed, and keeps routing', async () => {
    // The shape a pre-22de47c4 assignment left behind.
    const legacyTpl = await createApprovalTemplate(ctx(), { name: 'Legacy', levels: ['payroll'] });
    const [legacy] = await owner.db
      .insert(schema.leaveApprovalPolicy)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        leaveTypeId: b.annualLeaveTypeId,
        gradeId: gradeExec,
        templateId: legacyTpl.id,
        levels: [],
        active: true,
      })
      .returning({ id: schema.leaveApprovalPolicy.id });

    const fresh = await createApprovalTemplate(ctx(), { name: 'Fresh', levels: ['hr_manager'] });
    const { ruleIds } = await assignApprovalTemplate(ctx(), {
      templateId: fresh.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
      benefitSchemeIds: [schemeExec],
    });
    expect(ruleIds).not.toContain(legacy.id);

    const rows = await assignmentRows();
    const legacyRow = rows.find((r) => r.id === legacy.id);
    expect(legacyRow?.templateId, 'the legacy row was not repointed').toBe(legacyTpl.id);
    expect(legacyRow?.gradeId).toBe(gradeExec);
    // It is still LISTED, so an administrator can see and re-assign it rather than being routed by config
    // they cannot find.
    expect((await listTemplateAssignments(ctx())).map((r) => r.ruleId)).toContain(legacy.id);
    // …and it still ROUTES wherever the new scheme assignment does not reach. An EXEC-graded CONTRACT
    // employee is outside the (Leadership × permanent) scheme, so the legacy row is still their chain.
    expect(
      await resolve(b.annualLeaveTypeId, { gradeId: gradeExec, gradeGroupId: groupExec, employmentType: 'contract' }),
    ).toEqual(['payroll']);
    // Where BOTH cover the same employee the scheme assignment wins, because grade group + employment type
    // is two constraints against the legacy row's one (ADR-0071 specificity, unchanged). Pinned on purpose:
    // it is the precedence an administrator gets when they re-assign by scheme, and it must not be an
    // accident of ordering.
    expect(
      await resolve(b.annualLeaveTypeId, { gradeId: gradeExec, gradeGroupId: groupExec, employmentType: 'full_time' }),
    ).toEqual(['hr_manager']);
  });

  it('surfaces the condition bounds through listTemplateAssignments so the list can show the scope', async () => {
    const tpl = await createApprovalTemplate(ctx(), { name: 'Between', levels: ['hr_admin'] });
    const { ruleIds } = await assignApprovalTemplate(ctx(), {
      templateId: tpl.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
      minDays: 3,
      maxDays: 7,
    });
    const row = (await listTemplateAssignments(ctx())).find((r) => r.ruleId === ruleIds[0]);
    expect(row?.minDays).toBe(3);
    expect(row?.maxDays).toBe(7);
    expect(row?.gradeGroupId).toBeNull();
    expect(row?.employmentType).toBeNull();
  });

  it('a duration-scoped assignment applies only inside its range', async () => {
    const base = await createApprovalTemplate(ctx(), { name: 'Base', levels: ['hr_admin'] });
    const long = await createApprovalTemplate(ctx(), { name: 'Long', levels: ['payroll'] });
    await assignApprovalTemplate(ctx(), {
      templateId: base.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });
    await assignApprovalTemplate(ctx(), {
      templateId: long.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
      minDays: 5,
    });
    expect(await resolve(b.annualLeaveTypeId, { days: 2 })).toEqual(['hr_admin']);
    expect(await resolve(b.annualLeaveTypeId, { days: 6 })).toEqual(['payroll']);
  });

  it('rejects a condition range that starts after it ends, and a negative bound', async () => {
    const tpl = await createApprovalTemplate(ctx(), { name: 'Bad', levels: ['hr_admin'] });
    const p = { templateId: tpl.id, companyIds: [b.companyId], leaveTypeIds: [b.annualLeaveTypeId] };
    await expect(assignApprovalTemplate(ctx(), { ...p, minDays: 9, maxDays: 2 })).rejects.toThrow(
      /starts after it ends/i,
    );
    await expect(assignApprovalTemplate(ctx(), { ...p, minDays: -1 })).rejects.toThrow(/0 or more/i);
  });
});

describe('bb3938b9 — the Assign Template form is one row of four consistent panels', () => {
  const manager = fs.readFileSync(MANAGER, 'utf8');
  const page = fs.readFileSync(PAGE, 'utf8');

  it('lays the four criteria out in a single row that wraps rather than squeezing', () => {
    expect(manager).toContain('sm:grid-cols-2 xl:grid-cols-4');
  });

  it('renders all four criteria, each as a panel of the same fixed height', () => {
    const form = manager.slice(manager.indexOf('function AssignForm'));
    expect(form).toContain('name="companyIds"');
    expect(form).toContain('name="leaveTypeIds"');
    expect(form).toContain('name="benefitSchemeIds"');
    expect(form).toContain('{labels.conditions}');
    // The grade panel is gone, not merely relabelled — that dependency is what the item removes.
    expect(form.includes('name="gradeIds"')).toBe(false);
    // Every panel body is h-48 — equal height regardless of how many options it holds.
    expect(manager.match(/className="h-48 /g) ?? []).toHaveLength(2); // CriteriaPanel + the Conditions panel
  });

  it('gives every list panel a Select all / Deselect all control', () => {
    const panel = manager.slice(manager.indexOf('function CriteriaPanel'), manager.indexOf('function AssignForm'));
    expect(panel).toContain('allSelected ? labels.deselectAll : labels.selectAll');
    expect(panel).toContain('setSelected(allSelected ? [] : options.map((o) => o.id))');
  });

  it('says "none = all" ONLY under the optional criteria — companies and leave types are required', () => {
    const form = manager.slice(manager.indexOf('function AssignForm'));
    // Two required panels, two optional ones; the wrong footnote here would promise a scope we reject.
    expect(form.match(/hint=\{labels\.panelPickAtLeastOne\}/g) ?? []).toHaveLength(2);
    expect(form.match(/labels\.panelNoneMeansAll/g) ?? []).toHaveLength(2); // schemes + conditions
  });

  it('posts the condition as the min/max the assign action already reads', () => {
    const form = manager.slice(manager.indexOf('function AssignForm'));
    expect(form).toContain('name="minDays" value={minDays}');
    expect(form).toContain('name="maxDays" value={maxDays}');
    // Off by default, so an untouched form assigns unbounded exactly as before.
    expect(form).toContain('const [condOn, setCondOn] = useState(false);');
  });

  it('narrows the scheme list to the chosen companies, and flags a scheme with no grade group', () => {
    const form = manager.slice(manager.indexOf('function AssignForm'));
    expect(form).toContain('schemes.filter((s) => selectedCompanies.includes(s.companyId))');
    expect(form).toContain('labels.schemeNoGradeGroup');
    // The refusal is pre-empted in the form as well as enforced in the service.
    expect(form).toContain('disabled={pickedUngrouped.length > 0}');
  });

  it('shows an assignment’s scheme, its legacy grade scope and its condition, never implying "everyone"', () => {
    const section = manager.slice(manager.indexOf('export function ApprovalAssignmentManager'));
    expect(section).toContain('{schemeText(a)!.label}');
    expect(section).toContain('{nameOf(grades, a.gradeId)}');
    expect(section).toContain('{labels.legacyGradeScope}');
    expect(section).toContain('{conditionText(a) && <Badge variant="default">{conditionText(a)}</Badge>}');
    // A scope that resolves to no scheme is CALLED OUT rather than shown as unscoped — an assignment whose
    // target cannot be named has to fail at configuration time, not at approval time.
    expect(section).toContain('labels.schemeScopeUnknown');
  });

  it('feeds the scheme panel from the page’s ACTIVE, in-scope benefit schemes', () => {
    expect(page).toContain('listBenefitSchemes(s)');
    expect(page).toContain("sc.status === 'active' && companyIds.includes(sc.companyId)");
    expect(page).toContain("selectBenefitSchemes: t('selectBenefitSchemes')");
    // The assignment rows carry the two dimensions the badge matches a scheme back on.
    expect(page).toContain('gradeGroupId: a.gradeGroupId,');
    expect(page).toContain('employmentType: a.employmentType,');
  });
});

describe('22de47c4 — i18n', () => {
  const dict = (loc: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
  const KEYS = [
    'selectBenefitSchemes',
    'noBenefitSchemes',
    'schemeNoGradeGroup',
    'legacyGradeScope',
    'schemeScopeUnknown',
    'selectAll',
    'deselectAll',
    'panelNoneMeansAll',
    'panelPickAtLeastOne',
  ] as const;
  // The grade-panel strings retire with the panel — a leftover would be a label no screen shows.
  const RETIRED = ['selectGrades', 'noGrades'] as const;

  for (const loc of LOCALES) {
    it(`${loc} carries every leaveApproval panel key`, () => {
      const ns = dict(loc).leaveApproval ?? {};
      for (const k of KEYS) {
        expect(typeof ns[k], `${loc}.${k}`).toBe('string');
        expect((ns[k] as string).length, `${loc}.${k}`).toBeGreaterThan(0);
      }
      for (const k of RETIRED) expect(ns[k], `${loc}.${k} retired`).toBeUndefined();
    });
  }
});
