/**
 * r293 — Redesign Custom Leave Approval Workflow.
 *   PHASE 1: the visual builder over the structure that was already there, plus the chain PREVIEW.
 *   PHASE 2: `manager_manager` — a SECOND hop up the reporting line, the first genuinely new kind.
 *   PHASE 3: `specific_employee` — the FIRST FIXED approver, and the whole item's risk.
 *   PHASE 4: ANY-ONE approval — the only change to when a step counts as SATISFIED.
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
 *   7. the PREVIEW resolves against real org data and reports exactly the steps generation writes;
 *   8. (phase 2) the second hop is dropped when it is missing and generated when it is there, is NOT
 *      clearable by the direct manager, IS clearable by the manager's manager, and is dropped rather
 *      than routed to the requester when the reporting line is a two-person cycle;
 *   9. (phase 3) THE ASYMMETRY. A dynamic level resolving to nobody is DROPPED; a fixed one is NOT,
 *      even when the person it names has left — it warns instead, because dropping would silently
 *      remove an approval an administrator deliberately configured. Plus: the id is snapshotted onto the
 *      step (never re-read from the template), the named person decides and a bystander does not, and a
 *      chain that names a different person is a DIFFERENT chain;
 *  10. (phase 4) a level may hold several approvers and any ONE of them clears it — WITHOUT changing the
 *      row count, without weakening the self-approval ban, and without changing anything at all for a
 *      level that holds one approver.
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
  levelKey,
  approversOf,
  isAnyOneLevel,
  sanitizeApprovalLevels,
  serializeApprovalLevels,
  type ApprovalLevel,
} from '../lib/leave-approval-kinds';
import {
  assignApprovalTemplate,
  createApprovalTemplate,
  listApprovalTemplates,
  updateApprovalTemplate,
} from '../core/leave-approval-template';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A FIXED level is invalid without a named approver, so the pure drop-rule cases give one. Any id will
 *  do: `applyChainDropRules` is pure and never reads the person — that is the whole point of a fixed level. */
const fixedId = (kind: string) => (isFixedLevelKind(kind) ? '00000000-0000-0000-0000-0000000000ff' : null);

/** A resolved DYNAMIC level, spelled in full so the phase-3 fields are asserted rather than ignored:
 *  a relationship-resolved level never names a person and never carries the departed-approver warning. */
const dyn = (kind: string, kept: boolean, droppedBecause: string | null) => ({
  kind,
  employmentId: null,
  alternates: [],
  fixedApproverEnded: false,
  kept,
  droppedBecause,
});

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
      // r293 phase 2 — the second hop up the reporting line, which the system genuinely did not have.
      'manager_manager',
      'department_head',
      'business_unit_head',
      'hr_admin',
      'hr_manager',
      'payroll',
      'custom_role',
      // r293 phase 3 — the first FIXED kind. It is LAST because the order is the picker's order and a
      // named person belongs after the relationships, not among them.
      'specific_employee',
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

  it('every kind the builder offers has a LABEL and a hint in all six locales', () => {
    /* ⚠️ THE LABEL HALF WAS ADDED AFTER THE SCREEN RENDERED A RAW `specific_employee`. The page's kind →
       label map was a loose `Record<string, string>`, so the missing entry was `undefined` and everything
       stayed green; it was found by rendering the page and reading the markup with <script> stripped. The
       map is now a full `Record<LeaveLevelKind, string>` (a tsc failure) and this is the i18n half of the
       same pin — the type cannot tell whether the KEY it names actually exists in the catalogues. */
    const labelKey: Record<string, string> = {
      direct_manager: 'manager',
      manager_manager: 'managerManager',
      department_head: 'departmentHead',
      business_unit_head: 'businessUnitHead',
      hr_admin: 'hr',
      hr_manager: 'hrManager',
      payroll: 'payroll',
      custom_role: 'customRole',
      specific_employee: 'specificEmployee',
    };
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const m = JSON.parse(readFileSync(join(ROOT, `messages/${loc}.json`), 'utf8'));
      for (const kind of LEVEL_KINDS) {
        expect(m.leaveApproval[labelKey[kind]], `${loc}.leaveApproval.${labelKey[kind]}`).toBeTruthy();
      }
    }
    // And the page must actually USE them: a catalogue entry nothing reads is not a label on a screen.
    const page = readFileSync(join(ROOT, 'app/admin/leave-config/approval-chains/page.tsx'), 'utf8');
    expect(page).toContain('const kindLabels: Record<LeaveLevelKind, string>');
    for (const kind of LEVEL_KINDS) expect(page, `kindLabels is missing ${kind}`).toContain(`${kind}: t(`);
  });

  it('there is ONE kind → label mapping, and a miss shows the raw kind rather than the wrong name', () => {
    /* ⚠️ THE SECOND DEFECT THE VERIFY PASS FOUND, and the worse of the two. `step-list-editor.tsx` and
       `template-manager.tsx` each carried their own kind → label `switch` with `default: labels.manager`.
       Phase 2 taught only one of them about `manager_manager`, so the TEMPLATE LIST printed "Direct
       manager" for a Manager's-Manager level — a wrong name, which a reader believes, not a blank. Found
       by rendering the page and reading the markup; nothing in tsc, eslint or the suite saw it. */
    const editor = readFileSync(join(ROOT, 'app/admin/leave-approval/step-list-editor.tsx'), 'utf8');
    const manager = readFileSync(join(ROOT, 'app/admin/leave-approval/template-manager.tsx'), 'utf8');
    expect(editor).toContain('const KIND_LABEL_FIELD: Record<LeaveLevelKind, keyof StepListLabels>');
    for (const kind of LEVEL_KINDS) expect(editor, `KIND_LABEL_FIELD is missing ${kind}`).toContain(`${kind}: '`);
    // The other file must USE it, not re-derive it. A second `case 'hr_admin':` here is the whole defect.
    expect(manager).toContain('kindLabelOf(');
    expect(manager).not.toContain("case 'hr_admin':");
    // And the fallback must be the raw kind: a default that returns a real label makes a miss invisible.
    expect(editor).toContain("return typeof value === 'string' ? value : kind;");
  });

  it('every kind the builder offers has a resolution hint in all six locales', () => {
    const hintKey: Record<string, string> = {
      direct_manager: 'hintDirectManager',
      manager_manager: 'hintManagerManager',
      department_head: 'hintDepartmentHead',
      business_unit_head: 'hintBusinessUnitHead',
      hr_admin: 'hintHr',
      hr_manager: 'hintHrManager',
      payroll: 'hintPayroll',
      custom_role: 'hintCustomRole',
      specific_employee: 'hintSpecificEmployee',
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

  it('exactly one kind is FIXED and every other is DYNAMIC', () => {
    // Both arms spelled out rather than a filter, so the two halves cannot slide past each other.
    expect(isFixedLevelKind('specific_employee')).toBe(true);
    for (const kind of LEVEL_KINDS.filter((k) => k !== 'specific_employee')) {
      expect(isFixedLevelKind(kind), kind).toBe(false);
    }
  });
});

describe('r293 — the drop rule the builder describes is the drop rule the engine applies', () => {
  it('DROPPABLE_LEVEL_KINDS is exactly the set applyChainDropRules can drop', () => {
    // THE CROSS-FILE PIN. `DROPPABLE_LEVEL_KINDS` lives in lib/leave-approval-kinds.ts and drives what the
    // builder tells the administrator; `applyChainDropRules` lives in core/leave.ts and decides what is
    // actually written. A defect in the contract between two files has to be pinned across both.
    const nobody = {
      hasManager: false,
      managerManager: null,
      deptHead: null,
      buHead: null,
      endedFixedApprovers: [],
    };
    for (const kind of LEVEL_KINDS) {
      const [resolved] = applyChainDropRules([{ kind, employmentId: fixedId(kind), alternates: [] }], nobody);
      expect(resolved.kept, `${kind} with nobody in the relationship`).toBe(!isDroppableLevelKind(kind));
    }
    // ...and the other arm: with everybody present, nothing is dropped at all.
    const everybody = {
      hasManager: true,
      managerManager: 'm',
      deptHead: 'x',
      buHead: 'y',
      endedFixedApprovers: [],
    };
    for (const kind of LEVEL_KINDS) {
      expect(
        applyChainDropRules([{ kind, employmentId: fixedId(kind), alternates: [] }], everybody)[0].kept,
        `${kind} with the relationship filled`,
      ).toBe(true);
    }
    expect([...DROPPABLE_LEVEL_KINDS]).toEqual([
      'direct_manager',
      'manager_manager',
      'department_head',
      'business_unit_head',
    ]);
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
    expect(listed.levels.map((l) => l.kind)).toEqual(['hr_admin', 'direct_manager', 'department_head']);
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
      dyn('direct_manager', false, 'no_manager'),
      dyn('department_head', false, 'no_department_head'),
      dyn('hr_admin', true, null),
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
    expect(before!.levels[0]).toEqual(dyn('department_head', false, 'no_department_head'));

    await owner.db
      .update(schema.department)
      .set({ headEmploymentId: manager.employmentId })
      .where(eq(schema.department.id, b.deptA));

    const after = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(after!.levels[0]).toEqual(dyn('department_head', true, null));
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

describe('r293 phase 2 — manager_manager, the second hop up the reporting line', () => {
  /** The subject's manager's manager. Returns the grand-manager's context so a case can decide as them. */
  const giveManagerAManager = async (name = 'Grand Manager') => {
    const grand = await hire(name);
    await createAppUser(b.tenantId, grand.personId, 'manager');
    const [u] = await owner.db
      .select({ id: schema.appUser.id })
      .from(schema.appUser)
      .where(eq(schema.appUser.personId, grand.personId));
    await setReportingLine(ctx(), {
      subordinateEmploymentId: manager.employmentId,
      managerEmploymentId: grand.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    const grandCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: u.id,
      personId: grand.personId,
      roles: ['manager'],
    };
    return { grand, grandCtx };
  };

  it('is a DYNAMIC, DROPPABLE kind — it resolves a relationship, like every kind before it', () => {
    expect(LEVEL_KINDS).toContain('manager_manager');
    expect(isFixedLevelKind('manager_manager')).toBe(false);
    expect(isDroppableLevelKind('manager_manager')).toBe(true);
  });

  it('is DROPPED with only one hop recorded, and KEPT once the second hop exists', async () => {
    await setChain(['manager_manager', 'hr_admin']);

    // ARM A — the subject has no manager at all: there is no first hop, so there is no second one.
    const r1 = await request('2026-07-10');
    expect(await stepsFor(r1.leaveRequestId)).toEqual([{ kind: 'hr_admin', status: 'pending' }]);

    // ARM B — one hop only. The direct manager exists but reports to nobody, so the level is still
    // dropped. This is the arm that separates "second hop" from "any manager": a resolver that fell back
    // to the direct manager would pass ARM C and fail here.
    await giveSubjectAManager();
    const r2 = await request('2026-07-11');
    expect(await stepsFor(r2.leaveRequestId)).toEqual([{ kind: 'hr_admin', status: 'pending' }]);

    // ARM C — both hops recorded: the step is generated.
    await giveManagerAManager();
    const r3 = await request('2026-07-12');
    expect(await stepsFor(r3.leaveRequestId)).toEqual([
      { kind: 'manager_manager', status: 'pending' },
      { kind: 'hr_admin', status: 'pending' },
    ]);
  });

  it('routes to the manager’s manager — the DIRECT manager cannot clear it, the grand-manager can', async () => {
    await giveSubjectAManager();
    const { grandCtx } = await giveManagerAManager();
    await setChain(['manager_manager', 'hr_admin']);
    const { leaveRequestId } = await request('2026-07-13');

    // ARM A — the direct manager is refused, AND TOLD WHY IN WORDS THAT ARE TRUE. Delegating to
    // assertCanDecide about the manager means its self-ban fires here, and its message ("You cannot
    // decide your own leave request") is not true of this caller — it is not their request. Found by
    // driving the refusal on a dev server. Without this arm the kind would be an expensive alias for
    // direct_manager and every test below would still pass.
    await expect(decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' })).rejects.toThrow(
      /manager's manager or HR/,
    );

    // ARM B — the manager's manager clears it and the chain advances to HR.
    const advanced = await decideLeave(grandCtx, { leaveRequestId, decision: 'approved' });
    expect(advanced).toMatchObject({ status: 'pending', advancedTo: 'hr_admin' });
  });

  it('is dropped rather than routed to the requester when the reporting line is a two-person cycle', async () => {
    await giveSubjectAManager();

    // ARM A — THE PRODUCT ALREADY REFUSES TO CREATE THE CYCLE. `setReportingLine` rejects it outright,
    // and that is the first line of defence; asserting it here is what stops a later round from quietly
    // removing that check on the grounds that "the approval engine handles it".
    await expect(
      setReportingLine(ctx(), {
        subordinateEmploymentId: manager.employmentId,
        managerEmploymentId: subject.employmentId,
        lineType: 'administrative',
        validFrom: '2024-01-01',
      }),
    ).rejects.toThrow(/cycle/i);

    // ARM B — the engine does not RELY on that check. Written straight to the table as the migration role
    // (the only way to get the row in), because a cycle can also arrive from a restore, an import or a
    // row that predates the check — and a second hop that resolves to the requester would hand a person
    // their own approval, which is the one outcome this level must never produce.
    await owner.db.insert(schema.reportingLine).values({
      tenantId: b.tenantId,
      subordinateEmploymentId: manager.employmentId,
      managerEmploymentId: subject.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    await setChain(['manager_manager', 'hr_admin']);

    const preview = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(preview!.facts.managerManager).toBeNull();
    expect(preview!.levels[0]).toEqual(dyn('manager_manager', false, 'no_manager_manager'));

    const { leaveRequestId } = await request('2026-07-14');
    expect(await stepsFor(leaveRequestId)).toEqual([{ kind: 'hr_admin', status: 'pending' }]);
  });

  it('the preview names the second hop and reports the drop reason that belongs to it', async () => {
    await giveSubjectAManager();
    await setChain(['manager_manager', 'hr_admin']);

    const before = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(before!.levels[0]).toEqual(dyn('manager_manager', false, 'no_manager_manager'));

    const { grand } = await giveManagerAManager();
    const after = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(after!.levels[0]).toEqual(dyn('manager_manager', true, null));
    expect(after!.facts.managerManager).toBe(grand.employmentId);
  });
});

describe('r293 phase 3 — specific_employee, the first FIXED approver', () => {
  /** A named approver who is NOT in the subject's reporting line at all — the point of a fixed level. */
  let namedApprover: { personId: string; employmentId: string };
  let namedCtx: SessionContext;

  const ctxFor = async (emp: { personId: string }, role: 'employee' | 'manager' | 'hr_admin' | 'super_admin') => {
    await createAppUser(b.tenantId, emp.personId, role);
    const [u] = await owner.db
      .select({ id: schema.appUser.id })
      .from(schema.appUser)
      .where(eq(schema.appUser.personId, emp.personId));
    return { tenantId: b.tenantId, userId: u.id, personId: emp.personId, roles: [role] } as SessionContext;
  };

  /** Save a template through the SERVICE (not straight into the table) and assign it, so the whole
   *  save → sanitize → serialize → resolve → generate path is what is under test. */
  const useTemplate = async (levels: unknown[]) => {
    const { id } = await createApprovalTemplate(ctx(), { name: `T ${randomUUID().slice(0, 6)}`, description: null, levels });
    await assignApprovalTemplate(ctx(), {
      templateId: id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });
    return id;
  };

  /** End an employment the way the product does — a last working day in the past. */
  const endEmployment = (employmentId: string) =>
    owner.db
      .update(schema.employment)
      .set({ lastWorkingDate: '2025-01-31', resignationDate: '2025-01-01' })
      .where(eq(schema.employment.id, employmentId));

  beforeEach(async () => {
    namedApprover = await hire('Named Approver');
    namedCtx = await ctxFor(namedApprover, 'employee');
  });

  it('is the ONE fixed kind, and it is not droppable', () => {
    expect([...FIXED_LEVEL_KINDS]).toEqual(['specific_employee']);
    expect(isFixedLevelKind('specific_employee')).toBe(true);
    expect(isDroppableLevelKind('specific_employee')).toBe(false);
  });

  it('refuses to save a named-approver level with nobody named', async () => {
    // The level cannot be stored half-built: a fixed step with no person can neither be decided nor
    // dropped, so it would be a permanent stall written by a save that looked like it worked.
    await expect(
      createApprovalTemplate(ctx(), {
        name: 'Nobody named',
        description: null,
        levels: ['direct_manager', { kind: 'specific_employee' }],
      }),
    ).rejects.toThrow(/approver/i);

    // The other arm: the same chain WITH somebody named saves, and stores the id.
    const id = await useTemplate([
      { kind: 'direct_manager' },
      { kind: 'specific_employee', employmentId: namedApprover.employmentId },
    ]);
    expect(await storedLevels(id)).toEqual([
      // A dynamic level is still written back as a bare STRING, so every row saved before r293
      // round-trips byte-identically and the template needed no migration.
      'direct_manager',
      { kind: 'specific_employee', employmentId: namedApprover.employmentId },
    ]);
  });

  it('THE ASYMMETRY: a dynamic level resolving to nobody is dropped, a fixed one naming a LEAVER is not', async () => {
    // The subject has no manager and their department has no head — two dynamic levels that resolve to
    // nobody. The named approver has LEFT. Same chain, three levels, and they must not behave the same.
    await endEmployment(namedApprover.employmentId);
    await useTemplate([
      'direct_manager',
      'department_head',
      { kind: 'specific_employee', employmentId: namedApprover.employmentId },
    ]);

    const preview = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(preview!.levels).toEqual([
      dyn('direct_manager', false, 'no_manager'),
      dyn('department_head', false, 'no_department_head'),
      // KEPT, and broken at the same time — the state only a fixed level can be in. That pair of facts
      // IS the asymmetry: the warning exists precisely because the drop does not happen.
      {
        kind: 'specific_employee',
        employmentId: namedApprover.employmentId,
        alternates: [],
        fixedApproverEnded: true,
        kept: true,
        droppedBecause: null,
      },
    ]);
    expect(preview!.facts.endedFixedApprovers).toEqual([namedApprover.employmentId]);

    // And the engine agrees: the step is written, so the request really does stop there.
    const { leaveRequestId } = await request('2026-07-20');
    const steps = await owner.db
      .select({
        kind: schema.leaveApprovalStep.approverKind,
        approver: schema.leaveApprovalStep.approverEmploymentId,
      })
      .from(schema.leaveApprovalStep)
      .where(eq(schema.leaveApprovalStep.leaveRequestId, leaveRequestId))
      .orderBy(schema.leaveApprovalStep.stepIndex);
    expect(steps).toEqual([{ kind: 'specific_employee', approver: namedApprover.employmentId }]);
  });

  it('does NOT warn about a fixed approver who is still active — the other arm', async () => {
    await useTemplate([
      'hr_admin',
      { kind: 'specific_employee', employmentId: namedApprover.employmentId },
    ]);
    const preview = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(preview!.facts.endedFixedApprovers).toEqual([]);
    expect(preview!.levels[1]).toMatchObject({ kind: 'specific_employee', fixedApproverEnded: false, kept: true });

    // Now end them, and the SAME template starts warning without anything else changing.
    await endEmployment(namedApprover.employmentId);
    const after = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(after!.levels[1]).toMatchObject({ fixedApproverEnded: true, kept: true });
  });

  it('routes on the NAME, not on the relationship: the direct manager is refused, the named person is not', async () => {
    // ⚠️ RLS IS THE REASON THIS CASE IS SHAPED THIS WAY, and the shape is the point.
    // `leave_request` is visible to the subject, their manager chain and admins — nobody else. A named
    // approver with no reporting relationship to the subject cannot SEE the request at all and so cannot
    // reach the decide path; that is a PRE-EXISTING property of the whole approver vocabulary (the
    // decision-time note in core/leave.ts says the same of payroll partners and dept/BU heads, which is
    // why an HR admin can clear any step) and `specific_employee` inherits it rather than introducing it.
    // See the next case, which pins that limitation by itself.
    //
    // So both arms use people who CAN see the request, which is what makes the pair meaningful: the only
    // difference between them is whether the step NAMES them.
    await giveSubjectAManager();
    await useTemplate([{ kind: 'specific_employee', employmentId: manager.employmentId }, 'hr_admin']);
    const { leaveRequestId } = await request('2026-07-21');

    // ARM A — the subject's direct manager, who is NOT the named approver, is refused. They have full
    // visibility and would clear a `direct_manager` step instantly, so this can only fail if the branch
    // checks the relationship instead of the name.
    const second = await hire('Second Approver');
    const secondNamed = await useTemplate([{ kind: 'specific_employee', employmentId: second.employmentId }, 'hr_admin']);
    void secondNamed;
    const r2 = await request('2026-07-24');
    await expect(decideLeave(mgrCtx, { leaveRequestId: r2.leaveRequestId, decision: 'approved' })).rejects.toThrow(
      /named approver/i,
    );

    // ARM B — the same person, on a step that DOES name them, clears it and the chain advances.
    const advanced = await decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' });
    expect(advanced).toMatchObject({ status: 'pending', advancedTo: 'hr_admin' });
  });

  it('KNOWN LIMIT: a named approver outside the reporting line cannot see the request, so HR clears it', async () => {
    // Pinned deliberately, not hidden. RLS on leave_request is can_see_employment — subject, manager
    // chain, admins — and NOTHING about r293 widens it. A fixed approver who is a stranger to the subject
    // is therefore in exactly the position a payroll partner or an unrelated department head has always
    // been in: the authority check would pass, but the row is invisible, so the request stops until an
    // HR admin clears it. Widening RLS so that being named on a pending step confers visibility is a
    // real and separate piece of work; it was NOT done here and this case is what will fail when it is.
    await useTemplate([{ kind: 'specific_employee', employmentId: namedApprover.employmentId }, 'hr_admin']);
    const { leaveRequestId } = await request('2026-07-25');

    await expect(decideLeave(namedCtx, { leaveRequestId, decision: 'approved' })).rejects.toThrow(/not found|not visible/i);

    // The chain still completes, because an HR admin can clear any step — which is the whole reason that
    // override exists, and the reason a departed fixed approver is a stall rather than a deadlock.
    const advanced = await decideLeave(ctx(), { leaveRequestId, decision: 'approved' });
    expect(advanced).toMatchObject({ status: 'pending', advancedTo: 'hr_admin' });
  });

  it('SNAPSHOTS the named approver onto the step — re-pointing the template leaves it alone', async () => {
    // This is what migration 0467 is for. If the step went back to the template for its approver, an edit
    // would silently re-route a request that is already in flight — the one promise the plan makes about
    // template edits, and the reason the column exists at all.
    const other = await hire('Other Approver');
    const id = await useTemplate([
      { kind: 'specific_employee', employmentId: namedApprover.employmentId },
      'hr_admin',
    ]);
    const { leaveRequestId } = await request('2026-07-22');
    const approverOf = async (reqId: string) =>
      (
        await owner.db
          .select({ a: schema.leaveApprovalStep.approverEmploymentId })
          .from(schema.leaveApprovalStep)
          .where(eq(schema.leaveApprovalStep.leaveRequestId, reqId))
          .orderBy(schema.leaveApprovalStep.stepIndex)
      ).map((r) => r.a);
    expect(await approverOf(leaveRequestId)).toEqual([namedApprover.employmentId, null]);

    await updateApprovalTemplate(ctx(), id, {
      name: (await listApprovalTemplates(ctx())).find((t) => t.id === id)!.name,
      description: null,
      levels: [{ kind: 'specific_employee', employmentId: other.employmentId }, 'hr_admin'],
    });

    // ARM A — the in-flight request still names the ORIGINAL person, and is still decidable (by HR here,
    // for the RLS reason the case above pins — the point is the id on the row, not who pressed approve).
    expect(await approverOf(leaveRequestId)).toEqual([namedApprover.employmentId, null]);
    await decideLeave(ctx(), { leaveRequestId, decision: 'approved' });

    // ARM B — the edit is not inert: the next request names the new person.
    const r2 = await request('2026-07-23');
    expect(await approverOf(r2.leaveRequestId)).toEqual([other.employmentId, null]);
  });

  it('two chains naming DIFFERENT people are different chains', async () => {
    // core/leave-approval-consolidation.ts reuses an existing template when two chains "look equal", and
    // a kinds-only comparison cannot tell these apart — it would have re-pointed a converted rule at the
    // wrong approver.
    const other = await hire('Other Approver');
    const a: ApprovalLevel = { kind: 'specific_employee', employmentId: namedApprover.employmentId, alternates: [] };
    const c: ApprovalLevel = { kind: 'specific_employee', employmentId: other.employmentId, alternates: [] };
    expect(levelKey(a)).not.toBe(levelKey(c));
    // And the arm that keeps it honest: a dynamic level's key is still just its kind, so nothing about
    // the pre-r293 comparison changed for the chains that have always existed.
    expect(levelKey({ kind: 'direct_manager', employmentId: null, alternates: [] })).toBe('direct_manager');
  });

  it('a dynamic level never keeps a stray employment id', async () => {
    // An id on a level the engine never reads is a lie a later reader could believe.
    const id = await useTemplate([
      { kind: 'hr_admin', employmentId: namedApprover.employmentId },
      { kind: 'specific_employee', employmentId: namedApprover.employmentId },
    ]);
    expect(await storedLevels(id)).toEqual([
      'hr_admin',
      { kind: 'specific_employee', employmentId: namedApprover.employmentId },
    ]);
  });
});

describe('r293 phase 4 — any-one approval', () => {
  let alt: { personId: string; employmentId: string };
  let altCtx: SessionContext;

  const ctxFor = async (emp: { personId: string }, role: 'employee' | 'manager' | 'hr_admin') => {
    await createAppUser(b.tenantId, emp.personId, role);
    const [u] = await owner.db
      .select({ id: schema.appUser.id })
      .from(schema.appUser)
      .where(eq(schema.appUser.personId, emp.personId));
    return { tenantId: b.tenantId, userId: u.id, personId: emp.personId, roles: [role] } as SessionContext;
  };

  const useTemplate = async (levels: unknown[]) => {
    const { id } = await createApprovalTemplate(ctx(), {
      name: `Any ${randomUUID().slice(0, 6)}`,
      description: null,
      levels,
    });
    await assignApprovalTemplate(ctx(), {
      templateId: id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });
    return id;
  };

  const stepRows = (leaveRequestId: string) =>
    owner.db
      .select({
        i: schema.leaveApprovalStep.stepIndex,
        kind: schema.leaveApprovalStep.approverKind,
        approver: schema.leaveApprovalStep.approverEmploymentId,
        alternates: schema.leaveApprovalStep.approverAlternates,
      })
      .from(schema.leaveApprovalStep)
      .where(eq(schema.leaveApprovalStep.leaveRequestId, leaveRequestId))
      .orderBy(schema.leaveApprovalStep.stepIndex);

  beforeEach(async () => {
    alt = await hire('Alternate Approver');
    altCtx = await ctxFor(alt, 'employee');
  });

  it('a level with no alternates behaves exactly as it always has', () => {
    const plain: ApprovalLevel = { kind: 'direct_manager', employmentId: null, alternates: [] };
    expect(isAnyOneLevel(plain)).toBe(false);
    expect(approversOf(plain)).toEqual([{ kind: 'direct_manager', employmentId: null }]);
    expect(levelKey(plain)).toBe('direct_manager');
    // The stored shape is still a BARE STRING, which is why no template written before r293 moved.
    expect(serializeApprovalLevels([plain])).toEqual(['direct_manager']);
  });

  it('stores alternates on the level and reads them back', async () => {
    const id = await useTemplate([
      { kind: 'direct_manager', alternates: [{ kind: 'specific_employee', employmentId: alt.employmentId }] },
      'hr_admin',
    ]);
    expect(await storedLevels(id)).toEqual([
      {
        kind: 'direct_manager',
        employmentId: null,
        alternates: [{ kind: 'specific_employee', employmentId: alt.employmentId }],
      },
      // The level with ONE approver is still a bare string beside it.
      'hr_admin',
    ]);
    const [listed] = (await listApprovalTemplates(ctx())).filter((t) => t.id === id);
    expect(listed.levels[0].alternates).toEqual([{ kind: 'specific_employee', employmentId: alt.employmentId }]);
    expect(listed.levels[1].alternates).toEqual([]);
  });

  it('de-duplicates an alternate that repeats the primary, or itself', () => {
    // "Any one of [Sarah, Sarah]" is not a choice, and it would read as a two-approver level on every
    // screen that counts them.
    const [level] = sanitizeApprovalLevels([
      {
        kind: 'specific_employee',
        employmentId: 'e1',
        alternates: [
          { kind: 'specific_employee', employmentId: 'e1' },
          { kind: 'specific_employee', employmentId: 'e2' },
          { kind: 'specific_employee', employmentId: 'e2' },
          'hr_admin',
          'hr_admin',
        ],
      },
    ]);
    expect(level.alternates).toEqual([
      { kind: 'specific_employee', employmentId: 'e2' },
      { kind: 'hr_admin', employmentId: null },
    ]);
  });

  it('is ONE step row per level, not one per approver', async () => {
    // The row count is what every other reader of leave_approval_step is built on — decideLeave's
    // "lowest-index pending step", `stepCount` in every leave list, the escalation sweep's per-step
    // dedup. An any-one level is one DECISION, so it stays one row.
    await giveSubjectAManager();
    await useTemplate([
      { kind: 'direct_manager', alternates: [{ kind: 'specific_employee', employmentId: alt.employmentId }] },
      'hr_admin',
    ]);
    const { leaveRequestId } = await request('2026-07-30');
    const rows = await stepRows(leaveRequestId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      i: 0,
      kind: 'direct_manager',
      approver: null,
      alternates: [{ kind: 'specific_employee', employmentId: alt.employmentId }],
    });
    // NULL, not [], on the single-approver level: "no alternates" must not be two different values.
    expect(rows[1].alternates).toBeNull();
  });

  it('EITHER approver clears the level — and the level still needs ONE of them', async () => {
    await giveSubjectAManager();
    await useTemplate([
      { kind: 'direct_manager', alternates: [{ kind: 'specific_employee', employmentId: manager.employmentId }] },
      'hr_admin',
    ]);

    // ARM A — the PRIMARY approver's gate still works, unchanged.
    const r1 = await request('2026-07-31');
    expect(await decideLeave(mgrCtx, { leaveRequestId: r1.leaveRequestId, decision: 'approved' })).toMatchObject({
      status: 'pending',
      advancedTo: 'hr_admin',
    });

    // ARM B — a level whose primary resolves to NOBODY but whose alternate is a named person is NOT
    // dropped: one surviving approver is the whole point of any-one.
    const other = await hire('No Line Subject');
    await grantDays(other.employmentId);
    const preview = await previewApprovalChain(ctx(), {
      employmentId: other.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(preview!.levels[0]).toMatchObject({ kind: 'direct_manager', kept: true, droppedBecause: null });
    const r2 = await request('2026-08-01', other.employmentId);
    expect((await stepRows(r2.leaveRequestId)).map((x) => x.kind)).toEqual(['direct_manager', 'hr_admin']);
  });

  it('drops an any-one level only when EVERY approver resolves to nobody', async () => {
    // Neither a manager nor a department head exists for the subject, and the level names no person.
    await useTemplate([
      { kind: 'direct_manager', alternates: ['department_head'] },
      'hr_admin',
    ]);
    const preview = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(preview!.levels[0]).toMatchObject({ kept: false, droppedBecause: 'no_manager' });
    const { leaveRequestId } = await request('2026-08-02');
    expect((await stepRows(leaveRequestId)).map((x) => x.kind)).toEqual(['hr_admin']);

    // The other arm: give the department a head and the SAME level survives on its alternate alone.
    await owner.db
      .update(schema.department)
      .set({ headEmploymentId: manager.employmentId })
      .where(eq(schema.department.id, b.deptA));
    const after = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    expect(after!.levels[0]).toMatchObject({ kept: true, droppedBecause: null });
  });

  it('the ALTERNATE alone can clear a level whose primary gate refuses them', async () => {
    /* ⚠️ THE CASE THAT MAKES THE LOOP NON-VACUOUS, and it was added because the first attempt was not.
       Every other any-one case here happened to use a decider who ALSO passes the primary gate, so
       truncating the loop to `approvers.slice(0, 1)` left them all green. Here the primary is `payroll`
       — which the subject's plain manager is explicitly refused — and the alternate NAMES that manager.
       Only a gate that tries the second approver can accept them. */
    await giveSubjectAManager();
    await useTemplate([
      { kind: 'payroll', alternates: [{ kind: 'specific_employee', employmentId: manager.employmentId }] },
      'hr_admin',
    ]);
    const { leaveRequestId } = await request('2026-08-06');

    // The level really is a payroll level, and the manager really is refused by that gate on its own.
    const rows = await stepRows(leaveRequestId);
    expect(rows[0]).toMatchObject({ kind: 'payroll' });
    const plain = await useTemplate(['payroll', 'hr_admin']);
    void plain;
    const control = await request('2026-08-07');
    await expect(decideLeave(mgrCtx, { leaveRequestId: control.leaveRequestId, decision: 'approved' })).rejects.toThrow(
      /Payroll|HR/,
    );

    // ...and on the ANY-ONE level, the same person clears it through the alternate that names them.
    expect(await decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' })).toMatchObject({
      status: 'pending',
      advancedTo: 'hr_admin',
    });
  });

  it('does NOT let a bystander through — any-one widens the set, it does not open it', async () => {
    await giveSubjectAManager();
    await useTemplate([
      { kind: 'direct_manager', alternates: [{ kind: 'specific_employee', employmentId: manager.employmentId }] },
      'hr_admin',
    ]);
    const { leaveRequestId } = await request('2026-08-03');
    // `altCtx` is a plain employee who is neither approver. Without the loop's re-throw of the first
    // refusal this could have become a silent accept.
    await expect(decideLeave(altCtx, { leaveRequestId, decision: 'approved' })).rejects.toThrow();
  });

  it('keeps the self-approval ban: the requester cannot clear a level that names them as an alternate', async () => {
    // THE PROPERTY MOST WORTH PINNING about a loop that swallows refusals. "Manager OR the requester"
    // must not become "the requester approves their own leave".
    await giveSubjectAManager();
    const subjCtx = await ctxFor(subject, 'employee');
    await useTemplate([
      { kind: 'direct_manager', alternates: [{ kind: 'specific_employee', employmentId: subject.employmentId }] },
      'hr_admin',
    ]);
    const { leaveRequestId } = await request('2026-08-04');

    // ARM A — the subject is refused on the alternate that names them, and on the primary too.
    await expect(decideLeave(subjCtx, { leaveRequestId, decision: 'approved' })).rejects.toThrow();
    // ARM B — and the OTHER approver on the same level still clears it, which is the point of any-one.
    expect(await decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' })).toMatchObject({
      status: 'pending',
      advancedTo: 'hr_admin',
    });
  });

  it('an any-one level is a DIFFERENT chain from the same level alone', () => {
    const alone: ApprovalLevel = { kind: 'direct_manager', employmentId: null, alternates: [] };
    const withAlt: ApprovalLevel = {
      kind: 'direct_manager',
      employmentId: null,
      alternates: [{ kind: 'hr_admin', employmentId: null }],
    };
    expect(levelKey(alone)).not.toBe(levelKey(withAlt));
    expect(levelKey(withAlt)).toBe('direct_manager|hr_admin');
  });

  it('warns about a DEPARTED alternate, and still does not drop the level', async () => {
    await owner.db
      .update(schema.employment)
      .set({ resignationDate: '2025-01-01', lastWorkingDate: '2025-01-31' })
      .where(eq(schema.employment.id, alt.employmentId));
    await giveSubjectAManager();
    await useTemplate([
      { kind: 'direct_manager', alternates: [{ kind: 'specific_employee', employmentId: alt.employmentId }] },
      'hr_admin',
    ]);
    const preview = await previewApprovalChain(ctx(), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
    });
    // The warning has to reach the ALTERNATE too: a level whose second approver has left is exactly as
    // misleading as one whose first has.
    expect(preview!.facts.endedFixedApprovers).toEqual([alt.employmentId]);
    expect(preview!.levels[0]).toMatchObject({ kept: true, alternates: [{ kind: 'specific_employee', employmentId: alt.employmentId }] });
  });
});
