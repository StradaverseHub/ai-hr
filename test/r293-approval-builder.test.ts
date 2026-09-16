/**
 * r293 — Redesign Custom Leave Approval Workflow, PHASE 1: the visual builder over the structure that was
 * already there, plus the chain PREVIEW.
 *
 * ⚠️ THE REPORTER'S PREMISE WAS WRONG IN THEIR FAVOUR, and the first two cases pin the correction so a
 * future round cannot "add" what already exists. They believed approval steps were only Direct Manager and
 * HR and that levels were hard-coded to two. `leave_approval_template.levels` is jsonb — an ordered list of
 * ARBITRARY length — and `LEVEL_KINDS` has carried SEVEN kinds since the 6fadb036 gap-close.
 *
 * What this file actually guards, and why each one has BOTH arms:
 *   1. the vocabulary is the kernel's, not a copy inside the editor;
 *   2. DYNAMIC vs FIXED — every kind that exists today is dynamic, and `isFixedLevelKind` agrees with
 *      `FIXED_LEVEL_KINDS` in both directions (phase 3 adds `specific_employee` and this flips);
 *   3. the DROP RULE the builder describes is the drop rule the engine applies — pinned ACROSS the two
 *      files, because that is where it can drift;
 *   4. a reorder persists in the saved order AND the resolved chain follows it;
 *   5. a dynamic level that resolves to nobody is DROPPED and the chain carries on;
 *   6. editing a template does NOT disturb leave already in flight — asserted, not assumed;
 *   7. the PREVIEW resolves against real org data and reports exactly the steps generation writes.
 */
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { applyChainDropRules, decideLeave, previewApprovalChain, requestLeave } from '../core/leave';
import { resolveApprovalChain } from '../core/leave-approval-policy';
import {
  DROPPABLE_LEVEL_KINDS,
  FIXED_LEVEL_KINDS,
  LEVEL_KINDS,
  isDroppableLevelKind,
  isFixedLevelKind,
} from '../lib/leave-approval-kinds';
import {
  assignApprovalTemplate,
  createApprovalTemplate,
  listApprovalTemplates,
  updateApprovalTemplate,
} from '../core/leave-approval-template';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let b: Base;
let subject: { personId: string; employmentId: string };
let manager: { personId: string; employmentId: string };
let mgrCtx: SessionContext;

const ctx = () => adminCtx(b);

const hire = (name: string) =>
  hireEmployee(ctx(), {
    person: { fullName: name, primaryEmail: `r293_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

/** The company-default rule (all dimensions wildcard) — the same door test/leave-approval-vocabulary uses. */
const setChain = (levels: string[]) =>
  owner.db.insert(schema.leaveApprovalPolicy).values({ tenantId: b.tenantId, companyId: b.companyId, levels });

/** Read the request's materialised chain back out of the database, in step order. */
const stepsFor = (leaveRequestId: string) =>
  owner.db
    .select({ kind: schema.leaveApprovalStep.approverKind, status: schema.leaveApprovalStep.status })
    .from(schema.leaveApprovalStep)
    .where(eq(schema.leaveApprovalStep.leaveRequestId, leaveRequestId))
    .orderBy(schema.leaveApprovalStep.stepIndex);

/** Read a template's `levels` back out of the jsonb column — not out of the service's return value. */
const storedLevels = async (templateId: string) => {
  const [row] = await owner.db
    .select({ levels: schema.leaveApprovalTemplate.levels })
    .from(schema.leaveApprovalTemplate)
    .where(eq(schema.leaveApprovalTemplate.id, templateId));
  return row.levels as string[];
};

const request = (start: string, employmentId = subject.employmentId) =>
  requestLeave(ctx(), { employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: start, endDate: start });

const grantDays = (employmentId: string) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'accrual',
    days: '20.00',
    effectiveOn: '2026-01-01',
  });

beforeAll(async () => {
  await migrateTestDb();
});

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  subject = await hire('Subject');
  manager = await hire('Manager');
  await createAppUser(b.tenantId, manager.personId, 'manager');
  const uM = (
    await owner.db
      .select({ id: schema.appUser.id })
      .from(schema.appUser)
      .where(eq(schema.appUser.personId, manager.personId))
  )[0].id;
  mgrCtx = { tenantId: b.tenantId, userId: uM, personId: manager.personId, roles: ['manager'] };
  await grantDays(subject.employmentId);
});

afterAll(async () => {
  await closeAll();
});

/** The subject's administrative reporting line — set per case, because half these cases are about its
 *  ABSENCE. `beforeEach` deliberately does NOT create one. */
const giveSubjectAManager = () =>
  setReportingLine(ctx(), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: manager.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });

describe('r293 — the vocabulary the builder offers is the kernel’s, not a copy', () => {
  it('carries SEVEN kinds of arbitrary-length chain, correcting the reporter’s two-kind premise', () => {
    // The premise the plan corrects: "approval steps are represented only as predefined options such as
    // Direct Manager and HR". Both arms: the four the reporter did not know about are present, and the
    // list is exactly these seven (a kind added without wiring the picker, hints and resolver fails here).
    expect([...LEVEL_KINDS]).toEqual([
      'direct_manager',
      'department_head',
      'business_unit_head',
      'hr_admin',
      'hr_manager',
      'payroll',
      'custom_role',
    ]);
    expect(LEVEL_KINDS.length).toBeGreaterThan(2);
  });

  it('the builder imports LEVEL_KINDS instead of re-listing the kinds', () => {
    const src = readFileSync(join(ROOT, 'app/admin/leave-approval/step-list-editor.tsx'), 'utf8');
    expect(src).toContain("from '@/lib/leave-approval-kinds'");
    // The arm that matters: no second hand-kept list. Before r293 this file declared its own KIND_OPTIONS
    // array of seven string literals, and nothing failed when it fell behind the kernel const.
    expect(src).not.toMatch(/'department_head',\s*\n\s*'business_unit_head'/);
  });

  it('every kind the builder offers has a resolution hint in all six locales', () => {
    const hintKey: Record<string, string> = {
      direct_manager: 'hintDirectManager',
      department_head: 'hintDepartmentHead',
      business_unit_head: 'hintBusinessUnitHead',
      hr_admin: 'hintHr',
      hr_manager: 'hintHrManager',
      payroll: 'hintPayroll',
      custom_role: 'hintCustomRole',
    };
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const m = JSON.parse(readFileSync(join(ROOT, `messages/${loc}.json`), 'utf8'));
      for (const kind of LEVEL_KINDS) {
        expect(m.leaveApproval[hintKey[kind]], `${loc}.leaveApproval.${hintKey[kind]}`).toBeTruthy();
      }
    }
  });
});

describe('r293 — DYNAMIC vs FIXED, both arms', () => {
  it('flags exactly the fixed kinds and no others', () => {
    // BOTH ARMS IN ONE: the kinds the classifier calls fixed are exactly FIXED_LEVEL_KINDS, and every
    // other kind is NOT flagged. Empty today (phase 1 introduces no fixed kind); phase 3's
    // `specific_employee` makes the left side non-empty and this same line keeps both halves honest.
    expect(LEVEL_KINDS.filter(isFixedLevelKind)).toEqual([...FIXED_LEVEL_KINDS]);
    expect(LEVEL_KINDS.filter((k) => !isFixedLevelKind(k))).toEqual(
      LEVEL_KINDS.filter((k) => !(FIXED_LEVEL_KINDS as readonly string[]).includes(k)),
    );
  });

  it('every approver kind that exists today is DYNAMIC — a relationship, not a person', () => {
    for (const kind of LEVEL_KINDS) expect(isFixedLevelKind(kind), kind).toBe(false);
  });
});

describe('r293 — the drop rule the builder describes is the drop rule the engine applies', () => {
  it('DROPPABLE_LEVEL_KINDS is exactly the set applyChainDropRules can drop', () => {
    // THE CROSS-FILE PIN. `DROPPABLE_LEVEL_KINDS` lives in lib/leave-approval-kinds.ts and drives what the
    // builder tells the administrator; `applyChainDropRules` lives in core/leave.ts and decides what is
    // actually written. A defect in the contract between two files has to be pinned across both.
    const nobody = { hasManager: false, deptHead: null, buHead: null };
    for (const kind of LEVEL_KINDS) {
      const [resolved] = applyChainDropRules([kind], nobody);
      expect(resolved.kept, `${kind} with nobody in the relationship`).toBe(!isDroppableLevelKind(kind));
    }
    // ...and the other arm: with everybody present, nothing is dropped at all.
    const everybody = { hasManager: true, deptHead: 'x', buHead: 'y' };
    for (const kind of LEVEL_KINDS) {
      expect(applyChainDropRules([kind], everybody)[0].kept, `${kind} with the relationship filled`).toBe(true);
    }
    expect([...DROPPABLE_LEVEL_KINDS]).toEqual(['direct_manager', 'department_head', 'business_unit_head']);
  });

  it('a dynamic level that resolves to nobody is DROPPED and the chain carries on; a filled one is not', async () => {
    await setChain(['direct_manager', 'hr_admin']);

    // ARM A — no reporting line: the manager level is DROPPED and the request carries on to HR rather
    // than stalling on a step nobody can clear.
    const r1 = await request('2026-07-01');
    expect(await stepsFor(r1.leaveRequestId)).toEqual([{ kind: 'hr_admin', status: 'pending' }]);

    // ARM B — the same template, the same chain, a manager now recorded: the level is NOT dropped.
    await giveSubjectAManager();
    const r2 = await request('2026-07-02');
    expect(await stepsFor(r2.leaveRequestId)).toEqual([
      { kind: 'direct_manager', status: 'pending' },
      { kind: 'hr_admin', status: 'pending' },
    ]);
  });
});

describe('r293 — reordering levels', () => {
  it('persists in the SAVED order and the RESOLVED chain follows it', async () => {
    const { id } = await createApprovalTemplate(ctx(), {
      name: 'Three levels',
      description: null,
      levels: ['direct_manager', 'department_head', 'hr_admin'],
    });
    await assignApprovalTemplate(ctx(), {
      templateId: id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });

    // ARM 1 — what the database holds, read out of the jsonb column itself rather than out of the
    // service's return value (CLAUDE.md §8: save it and read the row back out).
    expect(await storedLevels(id)).toEqual(['direct_manager', 'department_head', 'hr_admin']);
    // ARM 2 — what resolution does with it.
    const before = await withTenant(ctx(), (tx) => resolveApprovalChain(tx, b.companyId, b.annualLeaveTypeId));
    expect(before).toEqual(['direct_manager', 'department_head', 'hr_admin']);

    // Reorder — exactly what a drag lands as: the same three kinds, a different order.
    await updateApprovalTemplate(ctx(), id, {
      name: 'Three levels',
      description: null,
      levels: ['hr_admin', 'direct_manager', 'department_head'],
    });

    expect(await storedLevels(id)).toEqual(['hr_admin', 'direct_manager', 'department_head']);
    const after = await withTenant(ctx(), (tx) => resolveApprovalChain(tx, b.companyId, b.annualLeaveTypeId));
    expect(after).toEqual(['hr_admin', 'direct_manager', 'department_head']);

    // And the list the screen renders agrees with both.
    const [listed] = await listApprovalTemplates(ctx());
    expect(listed.levels).toEqual(['hr_admin', 'direct_manager', 'department_head']);
  });

  it('a reordered template routes a NEW request in the new order', async () => {
    await giveSubjectAManager();
    const { id } = await createApprovalTemplate(ctx(), {
      name: 'Manager then HR',
      description: null,
      levels: ['direct_manager', 'hr_admin'],
    });
    await assignApprovalTemplate(ctx(), {
      templateId: id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });
    const r1 = await request('2026-08-03');
    expect((await stepsFor(r1.leaveRequestId)).map((x) => x.kind)).toEqual(['direct_manager', 'hr_admin']);

    await updateApprovalTemplate(ctx(), id, {
      name: 'Manager then HR',
      description: null,
      levels: ['hr_admin', 'direct_manager'],
    });
    const r2 = await request('2026-08-04');
    expect((await stepsFor(r2.leaveRequestId)).map((x) => x.kind)).toEqual(['hr_admin', 'direct_manager']);
  });
});

describe('r293 — editing a template does not disturb leave already in flight', () => {
  it('a request sitting at level 2 keeps its chain when the template is rewritten under it', async () => {
    await giveSubjectAManager();
    const { id } = await createApprovalTemplate(ctx(), {
      name: 'In flight',
      description: null,
      levels: ['direct_manager', 'hr_manager', 'hr_admin'],
    });
    await assignApprovalTemplate(ctx(), {
      templateId: id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });

    const { leaveRequestId } = await request('2026-09-07');
    // Clear level 1 so the request is genuinely sitting AT level 2 when the edit lands — the plan promises
    // the reporter this case by name, so it is the case the guard runs.
    const advanced = await decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' });
    expect(advanced).toMatchObject({ status: 'pending', advancedTo: 'hr_manager' });
    const inFlightBefore = await stepsFor(leaveRequestId);
    expect(inFlightBefore).toEqual([
      { kind: 'direct_manager', status: 'approved' },
      { kind: 'hr_manager', status: 'pending' },
      { kind: 'hr_admin', status: 'pending' },
    ]);

    // Rewrite the template completely: different kinds, different length, different order.
    await updateApprovalTemplate(ctx(), id, {
      name: 'In flight',
      description: null,
      levels: ['payroll', 'direct_manager'],
    });

    // ARM A — the in-flight request's materialised chain is byte-for-byte what it was, including the
    // decision already taken at level 1 and the level it is waiting on.
    expect(await stepsFor(leaveRequestId)).toEqual(inFlightBefore);

    // ARM B — and the edit is not inert: the NEXT request runs the new chain. Without this arm the case
    // would pass just as well if updateApprovalTemplate did nothing at all.
    const r2 = await request('2026-09-08');
    expect((await stepsFor(r2.leaveRequestId)).map((x) => x.kind)).toEqual(['payroll', 'direct_manager']);
  });
});

describe('r293 — the preview resolves against real org data', () => {
  it('reports the SAME steps the engine goes on to generate, drops included', async () => {
    // deptA has no head, and the subject has no reporting line: two of the three levels will be dropped.
    await setChain(['direct_manager', 'department_head', 'hr_admin']);

    const preview = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(preview).not.toBeNull();
    expect(preview!.levels).toEqual([
      { kind: 'direct_manager', kept: false, droppedBecause: 'no_manager' },
      { kind: 'department_head', kept: false, droppedBecause: 'no_department_head' },
      { kind: 'hr_admin', kept: true, droppedBecause: null },
    ]);

    // THE POINT OF THE PREVIEW: submit for real and the generated rows are exactly the kept levels. A
    // preview that agreed with itself but not with the engine would be worse than no preview.
    const { leaveRequestId } = await request('2026-10-05');
    expect((await stepsFor(leaveRequestId)).map((x) => x.kind)).toEqual(
      preview!.levels.filter((l) => l.kept).map((l) => l.kind),
    );
  });

  it('stops reporting a drop the moment the org data fills the relationship — the r285 case', async () => {
    // r285: department_head and business_unit_head were silently skipped for EVERY request because no
    // department had a head set, and no screen could show it. Both arms of exactly that.
    await setChain(['department_head', 'hr_admin']);

    const before = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(before!.levels[0]).toEqual({
      kind: 'department_head',
      kept: false,
      droppedBecause: 'no_department_head',
    });

    await owner.db
      .update(schema.department)
      .set({ headEmploymentId: manager.employmentId })
      .where(eq(schema.department.id, b.deptA));

    const after = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(after!.levels[0]).toEqual({ kind: 'department_head', kept: true, droppedBecause: null });
    expect(after!.facts.deptHead).toBe(manager.employmentId);
  });

  it('names WHERE the chain came from, so a template nobody assigned cannot masquerade as one in use', async () => {
    // No rule, no tenant default → the built-in chain, and the preview says so rather than implying a
    // template is running.
    const fallback = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(fallback!.source).toBe('fallback');
    expect(fallback!.ruleId).toBeNull();

    const { id } = await createApprovalTemplate(ctx(), {
      name: 'Assigned',
      description: null,
      levels: ['hr_manager', 'hr_admin'],
    });
    await assignApprovalTemplate(ctx(), {
      templateId: id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });
    const viaRule = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(viaRule!.source).toBe('rule');
    expect(viaRule!.ruleId).not.toBeNull();
    expect(viaRule!.levels.map((l) => l.kind)).toEqual(['hr_manager', 'hr_admin']);
  });
});
