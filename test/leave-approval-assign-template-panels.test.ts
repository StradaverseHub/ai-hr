/**
 * Feedback bb3938b9 — Assignment Template layout: consolidate the assignment criteria into ONE section.
 *
 * The Assign Template form used to offer two criteria (Companies, Leave Types). It now offers four in a
 * single row of equally sized panels: Companies, Leave Types, Grades and Conditions (the leave-duration
 * range the rule matrix already scopes on). Grades and Conditions are OPTIONAL: selecting none of a
 * criterion means "applies to all", which writes null on that dimension.
 *
 * That last sentence is the whole risk of this item — a silent change in who an existing template covers.
 * The first describe block pins it down directly: an assignment made the pre-bb3938b9 way keeps its row,
 * its ruleId and the chain its employees resolve to, before AND after a grade/condition-scoped assignment
 * is added alongside it. Resolution itself (ADR-0071 specificity) is untouched; a grade- or duration-scoped
 * assignment is simply a more specific rule of the kind the matrix has always supported.
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
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const MANAGER = path.join(ROOT, 'app/admin/leave-approval/template-manager.tsx');
const PAGE = path.join(ROOT, 'app/admin/leave/approval/page.tsx');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

let b: Base;
let sickLeaveTypeId: string;
let gradeExec: string;
let gradeMgr: string;

const ctx = () => adminCtx(b);

const resolve = (leaveTypeId: string | null, attrs: { gradeId?: string | null; days?: number | null } = {}) =>
  withTenant(ctx(), (tx) => resolveApprovalChain(tx, b.companyId, leaveTypeId, attrs));

const assignmentRows = () =>
  owner.db
    .select({
      id: schema.leaveApprovalPolicy.id,
      leaveTypeId: schema.leaveApprovalPolicy.leaveTypeId,
      gradeId: schema.leaveApprovalPolicy.gradeId,
      minDays: schema.leaveApprovalPolicy.minDays,
      maxDays: schema.leaveApprovalPolicy.maxDays,
      businessUnitId: schema.leaveApprovalPolicy.businessUnitId,
      departmentId: schema.leaveApprovalPolicy.departmentId,
      positionId: schema.leaveApprovalPolicy.positionId,
      employmentType: schema.leaveApprovalPolicy.employmentType,
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
  await setLeaveApprovalPolicy(ctx(), {
    companyId: b.companyId,
    enabled: true,
    levels: ['direct_manager', 'hr_admin'],
  });
});
afterAll(async () => {
  await closeAll();
});

describe('bb3938b9 — an assignment made the old way keeps covering exactly the same employees', () => {
  it('writes the identical fully-wildcard row when no grade and no condition are chosen', async () => {
    const tpl = await createApprovalTemplate(ctx(), { name: 'Standard', levels: ['hr_admin'] });
    await assignApprovalTemplate(ctx(), {
      templateId: tpl.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });

    const rows = (await assignmentRows()).filter((r) => r.leaveTypeId === b.annualLeaveTypeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].gradeId).toBeNull();
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

  it('adding a grade- and a duration-scoped assignment leaves the pre-existing one resolving unchanged', async () => {
    const wide = await createApprovalTemplate(ctx(), { name: 'Wide', levels: ['hr_admin'] });
    const { ruleIds: wideRuleIds } = await assignApprovalTemplate(ctx(), {
      templateId: wide.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });
    // The employee set the wide assignment covers, captured BEFORE the new criteria exist.
    const before = {
      noGrade: await resolve(b.annualLeaveTypeId),
      exec: await resolve(b.annualLeaveTypeId, { gradeId: gradeExec }),
      mgr: await resolve(b.annualLeaveTypeId, { gradeId: gradeMgr, days: 9 }),
    };

    const execOnly = await createApprovalTemplate(ctx(), { name: 'Exec only', levels: ['payroll'] });
    await assignApprovalTemplate(ctx(), {
      templateId: execOnly.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
      gradeIds: [gradeExec],
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
    expect(wideRow?.gradeId).toBeNull();
    expect(wideRow?.minDays).toBeNull();
    expect(await resolve(b.annualLeaveTypeId)).toEqual(before.noGrade);
    expect(await resolve(b.annualLeaveTypeId, { gradeId: gradeMgr, days: 9 })).toEqual(before.mgr);
    // ...and the carve-outs do what they say.
    expect(before.exec).toEqual(['hr_admin']);
    expect(await resolve(b.annualLeaveTypeId, { gradeId: gradeExec })).toEqual(['payroll']);
    expect(await resolve(b.annualLeaveTypeId, { gradeId: gradeMgr, days: 12 })).toEqual(['hr_manager']);
  });
});

describe('bb3938b9 — grade and condition criteria on the assignment', () => {
  it('assigns the cross product of companies × leave types × grades', async () => {
    const tpl = await createApprovalTemplate(ctx(), { name: 'Cross', levels: ['hr_admin'] });
    const { ruleIds } = await assignApprovalTemplate(ctx(), {
      templateId: tpl.id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId, sickLeaveTypeId],
      gradeIds: [gradeExec, gradeMgr],
    });
    expect(ruleIds).toHaveLength(4);

    const list = await listTemplateAssignments(ctx());
    const mine = list.filter((r) => ruleIds.includes(r.ruleId));
    expect(mine).toHaveLength(4);
    expect(new Set(mine.map((r) => `${r.leaveTypeId}|${r.gradeId}`)).size).toBe(4);
    for (const r of mine) expect(r.minDays).toBeNull();
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
    expect(row?.gradeId).toBeNull();
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
    expect(form).toContain('name="gradeIds"');
    expect(form).toContain('{labels.conditions}');
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
    expect(form.match(/labels\.panelNoneMeansAll/g) ?? []).toHaveLength(2); // grades + conditions
  });

  it('posts the condition as the min/max the assign action already reads', () => {
    const form = manager.slice(manager.indexOf('function AssignForm'));
    expect(form).toContain('name="minDays" value={minDays}');
    expect(form).toContain('name="maxDays" value={maxDays}');
    // Off by default, so an untouched form assigns unbounded exactly as before.
    expect(form).toContain('const [condOn, setCondOn] = useState(false);');
  });

  it('shows an assignment’s grade and condition in the list instead of implying it covers everyone', () => {
    const section = manager.slice(manager.indexOf('export function ApprovalAssignmentManager'));
    expect(section).toContain('{a.gradeId && <Badge variant="default">{nameOf(grades, a.gradeId)}</Badge>}');
    expect(section).toContain('{conditionText(a) && <Badge variant="default">{conditionText(a)}</Badge>}');
  });

  it('feeds the grade panel from the page’s existing job-grade list', () => {
    expect(page).toContain('grades={gradesAll.map((x) => ({ id: x.id, label: `${x.code} — ${x.name}` }))}');
    expect(page).toContain("selectGrades: t('selectGrades')");
  });
});

describe('bb3938b9 — i18n', () => {
  const dict = (loc: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
  const KEYS = [
    'selectGrades',
    'selectAll',
    'deselectAll',
    'panelNoneMeansAll',
    'panelPickAtLeastOne',
    'noGrades',
  ] as const;

  for (const loc of LOCALES) {
    it(`${loc} carries every new leaveApproval key`, () => {
      const ns = dict(loc).leaveApproval ?? {};
      for (const k of KEYS) {
        expect(typeof ns[k], `${loc}.${k}`).toBe('string');
        expect((ns[k] as string).length, `${loc}.${k}`).toBeGreaterThan(0);
      }
    });
  }
});
