/**
 * f12d77e5 — Remove Grade Groups from the Leave Entitlement framework.
 *
 * THE DEFECT THIS PINS IS A MISREADING, NOT A BUG: "remove grade groups from entitlement" reads like
 * "delete grade groups", and deleting them is silently destructive. 205 of the tenant's 261
 * `leave_approval_policy` rows carry a non-null `grade_group_id`, and core/leave-approval-policy.ts
 * treats a NULL group as a WILDCARD rather than a non-match — so a cleared group does not clear its
 * rules, it widens each one from the grades it names to EVERY employee, with no error and nothing on
 * screen to say so. Leave starts routing to the wrong approvers and the screen still looks correct.
 *
 * So the change is a MOVE: the editor comes off Settings → Leave → Entitlements (where it sat only
 * because 6e9a126e release three deleted the BenefitSchemeConfig workbench out from under it) and goes
 * onto Settings → Leave → Approval, the screen whose rules are built on grade groups. The backend half
 * of the reporter's request was already true before this change — `entitlement_eligibility_rule.criteria`
 * scopes by individual `gradeIds`, never by a GROUP — so nothing about entitlement or eligibility moves.
 *
 * WHAT EACH GROUP OF CASES IS FOR:
 *   1. Static source — the editor is ABSENT from Entitlements and PRESENT on Approval. A mount is not
 *      something a behaviour test can see, and "absent" is the half a careless re-add would undo.
 *   2. The Promise.all arity check — app/admin/leave/entitlements/page.tsx's OWN comment warns that
 *      removing a name from the destructure without its element (or the reverse) shifts every later
 *      variable by one slot, giving each one somebody else's value with no type error. That trap was
 *      live in this exact edit, so it is pinned rather than trusted.
 *   3. Locale — the card's strings live in the `admin.benefitScheme` namespace, which the moved
 *      component reads for itself. A move that orphaned those keys would pass tsc, the suite and
 *      `next build` and then throw MISSING_MESSAGE at render.
 *   4. Behaviour — the guard that makes the move safe to ship: `deleteGradeGroup` REFUSES while any
 *      approval rule references the group. Asserted with the refusal's own wording, and then asserted
 *      to SUCCEED once no rule points at it, so a fixture that died before reaching the guard cannot
 *      masquerade as the guard working.
 */
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createGradeGroup, deleteGradeGroup, listGradeGroups } from '../core/benefit-scheme';
import { createLeaveApprovalRule } from '../core/leave-approval-policy';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const ENTITLEMENTS = path.join(ROOT, 'app/admin/leave/entitlements/page.tsx');
const APPROVAL = path.join(ROOT, 'app/admin/leave/approval/page.tsx');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

const entitlementsSrc = fs.readFileSync(ENTITLEMENTS, 'utf8');
const approvalSrc = fs.readFileSync(APPROVAL, 'utf8');

/**
 * COMMENTS ARE NOT CODE (the r134 rule). A removal has to be able to explain itself, and an honest
 * explanation NAMES what it removed — both pages now carry a note saying exactly where `GradeGroupConfig`
 * and `listGradeGroups` went. A bare-substring absence check over the raw file would report correct code
 * as wrong, which is worse than no guard, so absence is asserted against comment-stripped source.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');
const entitlementsCode = stripComments(entitlementsSrc);
const approvalCode = stripComments(approvalSrc);

/**
 * The top-level elements of the first `[...]` at or after `from`, split on depth-1 commas. Used on
 * comment-stripped source, so a comma or an unbalanced bracket inside prose cannot skew the count.
 */
function topLevelElements(src: string, from: number): string[] {
  const open = src.indexOf('[', from);
  const out: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') {
      depth--;
      if (depth === 0) {
        out.push(src.slice(start, i));
        break;
      }
    } else if (ch === ',' && depth === 1) {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The `const [a, b, …] = await Promise.all([…])` pair at `anchor`, as (names, calls). */
function destructuredAwaitAll(src: string, anchor: string): { names: string[]; calls: string[] } {
  const at = src.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  const names = topLevelElements(src, at);
  const allAt = src.indexOf('Promise.all(', at);
  expect(allAt, `no Promise.all after ${anchor}`).toBeGreaterThan(-1);
  return { names, calls: topLevelElements(src, allAt) };
}

describe('f12d77e5 · the Grade Groups editor is off the Entitlement screen', () => {
  it('the Entitlements page neither imports nor renders GradeGroupConfig', () => {
    expect(entitlementsCode).not.toContain('<GradeGroupConfig');
    expect(entitlementsSrc).not.toMatch(/^import .*grade-group-config'/m);
  });

  it('and stopped READING for it — the list and all three writes are gone, not merely unrendered', () => {
    // The e4238594 precedent: an unmounted embed's data prep left behind is a query per render for a
    // surface nobody sees. `listGradeGroups` here would also re-attach entitlement to grade groups on the
    // one page the reporter asked to have them off.
    for (const gone of [
      'listGradeGroups',
      'createGradeGroupAction',
      'updateGradeGroupAction',
      'deleteGradeGroupAction',
      'gradeGroupProps',
    ]) {
      expect(entitlementsCode, `${gone} must be gone from the page's CODE`).not.toContain(gone);
    }
  });

  it('KEEPS the entitlement surfaces the item does not touch', () => {
    // Stated positively so an over-eager follow-up cleanup fails here rather than in production. The item
    // removed one card; entitlement configuration itself is untouched by design.
    expect(entitlementsCode).toContain('<LeaveTypeWorkspace');
    expect(entitlementsCode).toContain('<LeaveSharedGroupConfig');
    // ee6b7c69 renamed this slot, and the rename IS the surface change: `entitlementTablesLink` held a
    // caption and a link to a separate screen; `entitlementTablesSection` holds the tables themselves,
    // filtered to the panel's leave type. Updated rather than loosened — the guard's job is to fail if the
    // Entitlement step loses its entitlement surface, which is exactly as true of the new name.
    expect(entitlementsCode).toContain('entitlementTablesSection');
    expect(entitlementsCode).toContain('<EarnedAccrualDialog');
  });

  it('the destructure and the Promise.all still have the SAME arity, in the same order', () => {
    // THE TRAP THIS EDIT WALKED INTO: this page's own comment warns that dropping a name from the
    // destructure without its element shifts every later variable by one slot — `sharedGroups` would
    // silently become the profile options, with no type error, because both sides are arrays.
    const { names, calls } = destructuredAwaitAll(entitlementsCode, 'const [types,');
    expect(names).toEqual(['types', 'companies', 'grades', 'sharedGroups', 'profileOptionsActive']);
    expect(calls).toHaveLength(names.length);
    expect(calls[0]).toMatch(/^listLeaveTypes\(/);
    expect(calls[names.indexOf('sharedGroups')]).toMatch(/^listLeaveSharedGroups\(/);
    expect(calls[names.indexOf('profileOptionsActive')]).toMatch(/^listAllProfileOptions\(/);
  });
});

describe('f12d77e5 · …and reachable from the Leave Approval screen, which is where it is used', () => {
  it('the Approval page imports the editor and mounts it', () => {
    expect(approvalSrc).toMatch(/^import \{ GradeGroupConfig \} from '@\/components\/leave\/grade-group-config';$/m);
    expect(approvalCode).toContain('<GradeGroupConfig');
    // The component file itself must still exist — a mount pointing at a deleted file is a build error,
    // but the deletion is the mistake this item exists to prevent, so it is named.
    expect(fs.existsSync(path.join(ROOT, 'components/leave/grade-group-config.tsx'))).toBe(true);
  });

  it('it reads the groups and wires all three writes — a read-only card would be a dead end', () => {
    const { names, calls } = destructuredAwaitAll(approvalCode, 'const [leaveTypesAll,');
    expect(names).toContain('gradeGroups');
    expect(calls).toHaveLength(names.length);
    expect(calls[names.indexOf('gradeGroups')]).toContain('listGradeGroups(s)');
    for (const action of ['createGradeGroupAction', 'updateGradeGroupAction', 'deleteGradeGroupAction']) {
      expect(approvalCode, `${action} must be wired on the approval page`).toContain(action);
    }
  });

  it('the card is gated on isAdmin — the move must not widen who can see it', () => {
    // lib/permissions.ts registers this route with guard `scopedSession`, which all seven roles satisfy;
    // the page the card came from was `requireAdmin`. Without this gate, relocating the mount would hand
    // every employee a tenant-wide grade-group listing they could not previously reach.
    expect(approvalCode).toContain('isAdmin(s)');
    expect(approvalCode).toMatch(/canEditGradeGroups\s*&&/);
    // …and a non-admin must not even pay for the read.
    expect(approvalCode).toMatch(/canEditGradeGroups\s*\?\s*listGradeGroups\(s\)/);
  });

  it('the three writes RETURN to the approval screen — a redirect left behind is a bug, not a detail', () => {
    // A save that worked and then dropped the admin on /admin/leave/entitlements would land them on the
    // one screen this item exists to take grade groups off, with no card there to show the result. Worse
    // on failure: `fail()` carries the message in `?error=`, so deleteGradeGroup's refusal would have
    // been rendered on a page with no grade-group form while the Approval screen reloaded unchanged.
    const actionsSrc = fs.readFileSync(path.join(ROOT, 'app/admin/actions.ts'), 'utf8');
    const block = actionsSrc.slice(
      actionsSrc.indexOf('export async function createGradeGroupAction'),
      actionsSrc.indexOf('// SHARED LEAVE GROUPS'),
    );
    expect(block, 'the three grade-group actions must be findable as one block').not.toBe('');
    expect(stripComments(block)).not.toContain('ENTITLEMENTS');
    // ok() on the happy path and fail() on the error path, for each of the three.
    expect(stripComments(block).match(/ok\(LEAVE_APPROVAL\)/g) ?? []).toHaveLength(3);
    expect(stripComments(block).match(/fail\(LEAVE_APPROVAL, e\)/g) ?? []).toHaveLength(3);
    // …and the constant is the route this page actually lives at.
    expect(fs.readFileSync(path.join(ROOT, 'app/admin/_redirects.ts'), 'utf8')).toContain(
      "export const LEAVE_APPROVAL = '/admin/leave/approval';",
    );
  });

  it('the grades offered as members are the ACTIVE list', () => {
    // `listJobGrades` excludes archived unless asked — and it must not be asked here. The membership form
    // posts only the boxes it renders, so an archived grade shown nowhere is dropped from the group on the
    // next save. The Entitlements page filtered by hand for the same reason.
    expect(approvalCode).toContain('listJobGrades(s)');
    expect(approvalCode).not.toContain('listJobGrades(s, { includeArchived: true })');
  });
});

describe('f12d77e5 · the moved card still has its strings, in all six locales', () => {
  it('every admin.benefitScheme key the editor reads resolves everywhere', () => {
    // A moved mount that orphaned these would pass tsc, the suite and `next build`, then throw
    // MISSING_MESSAGE at render — the exact class of defect a 200 does not catch.
    const used = [
      'groupsTitle', // the card heading, read by the page
      // …and the rest, read by components/leave/grade-group-config.tsx itself.
      'groupsHelp',
      'noGroups',
      'archived',
      'memberCount',
      'groupNameLabel',
      'groupNamePlaceholder',
      'membersLabel',
      'noGrades',
      'save',
      'delete',
      'addGroup',
    ];
    for (const loc of LOCALES) {
      const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
      const ns = dict?.admin?.benefitScheme ?? {};
      for (const key of used) {
        expect(typeof ns[key], `messages/${loc}.json → admin.benefitScheme.${key}`).toBe('string');
      }
    }
  });
});

describe('f12d77e5 · what makes the move safe: a referenced grade group cannot be deleted', () => {
  let b: Base;
  const ctx = () => adminCtx(b);

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

  it('refuses the delete while an approval rule scopes by the group, then allows it once none does', async () => {
    const [grade] = await owner.db
      .insert(schema.jobGrade)
      .values({ tenantId: b.tenantId, code: 'EXEC', name: 'Executive', rank: 1 })
      .returning({ id: schema.jobGrade.id });
    const group = await createGradeGroup(ctx(), { name: 'Grade 16-19', gradeIds: [grade.id] });
    const rule = await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      gradeGroupId: group.id,
      levels: ['department_head', 'hr_admin'],
    });

    // THE REFUSAL, asserted on its own wording — not merely on "it threw". A fixture that died before
    // reaching the guard would also throw, and would prove nothing about the guard.
    await expect(deleteGradeGroup(ctx(), { id: group.id })).rejects.toThrow(
      /used by one or more leave approval rules/i,
    );
    // …and the group is still there, still holding its grade. This is the 205-rules case: had the delete
    // gone through, the FK is ON DELETE SET NULL and a NULL grade_group_id is a WILDCARD in
    // core/leave-approval-policy.ts — the rule would have widened from "Executive" to every employee.
    const after = await listGradeGroups(ctx());
    expect(after.map((g) => g.name)).toContain('Grade 16-19');
    expect(after.find((g) => g.name === 'Grade 16-19')?.gradeIds).toEqual([grade.id]);

    // The other half: with no rule pointing at it the SAME call succeeds, which is what proves the
    // refusal above came from the guard and not from a broken fixture. Deleted at the row level because
    // the guard counts rows, archived or not — archiving a rule does not release its group.
    await owner.db.delete(schema.leaveApprovalPolicy).where(eq(schema.leaveApprovalPolicy.id, rule.id));
    await deleteGradeGroup(ctx(), { id: group.id });
    expect((await listGradeGroups(ctx())).map((g) => g.name)).not.toContain('Grade 16-19');
  });

  it('listGradeGroups still resolves a scoped group, so the moved card is not an empty screen', async () => {
    // The card's whole job is listing what the rules on the same page point at. Trivial-looking, but it
    // is the one read that moved between pages, and an empty list would look exactly like "no groups yet".
    const [g1] = await owner.db
      .insert(schema.jobGrade)
      .values({ tenantId: b.tenantId, code: 'G16', name: 'Grade 16', rank: 1 })
      .returning({ id: schema.jobGrade.id });
    const [g2] = await owner.db
      .insert(schema.jobGrade)
      .values({ tenantId: b.tenantId, code: 'G17', name: 'Grade 17', rank: 2 })
      .returning({ id: schema.jobGrade.id });
    const band = await createGradeGroup(ctx(), { name: 'Senior band', gradeIds: [g1.id, g2.id] });
    await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      gradeGroupId: band.id,
      levels: ['hr_admin'],
    });

    const rows = await listGradeGroups(ctx());
    const senior = rows.find((g) => g.id === band.id);
    expect(senior, 'the group a live approval rule scopes by must be listed').toBeDefined();
    expect(senior!.gradeIds.slice().sort()).toEqual([g1.id, g2.id].slice().sort());
    expect(senior!.archived).toBe(false);
  });
});
