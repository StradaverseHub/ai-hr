/**
 * f12d77e5 — Remove Grade Groups from the Leave Entitlement framework.
 * 9a65f808 (r197) — …and move the editor on again, to System Labels → Organisation.
 *
 * ⚠️ READ THIS BEFORE THE ORIGINAL HEADER BELOW: HALF OF IT IS HISTORY NOW, AND WHICH HALF MATTERS.
 *
 * f12d77e5's reasoning rested on one fact — "a grade group no longer selects an entitlement; it is purely
 * an approval-routing scope" — and that fact is what put the editor on the Leave Approval screen. 9a65f808
 * ended it: Employee Eligibility now offers a Grade Group picker, which expands to the group's member
 * grades, so a grade group is the vocabulary of BOTH the approval side and the entitlement side. Shared
 * master data maintained inside one of its two consumers is master data the other consumer's admins cannot
 * find, so the editor sits beside Job Grades on Settings → System Labels → Organisation.
 *
 * THE CASES BELOW WERE UPDATED, NOT DELETED, and the split is deliberate:
 *   - "off the Entitlement screen" (the first block) is UNTOUCHED and still exactly right. The reporter of
 *     f12d77e5 asked for that and nothing since has reversed it — the Entitlements screen gained a grade
 *     group PICKER on its eligibility rules, which is a consumer, not an editor.
 *   - "…and reachable from the Leave Approval screen" (the second block) is the half 9a65f808 reversed. It
 *     now asserts the mount is ABSENT there and PRESENT on System Labels, with the same structural rigour
 *     and the same reasons attached — a mount is not something a behaviour test can see, and "absent" is
 *     the half a careless re-add would undo.
 *   - the delete-refusal behaviour block is untouched and is MORE load-bearing than before: a grade group
 *     now scopes entitlement eligibility as well, so deleting one that rules point at was already unsafe
 *     and has gained a second way to hurt.
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
 *   2. The Promise.all arity check — app/admin/leave-config/types/page.tsx's OWN comment warns that
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
const ENTITLEMENTS = path.join(ROOT, 'app/admin/leave-config/types/page.tsx');
/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. 9a65f808's property is that the Grade Groups
 * editor does not live on the approval screen and its READS left with it; the approval screen moved to
 * `/admin/leave-config/approval-chains` and the old address is a redirect stub, which reads nothing at
 * all — so asserting the absence there would be true forever and would mean nothing.
 */
const APPROVAL = path.join(ROOT, 'app/admin/leave-config/approval-chains/page.tsx');
/** 9a65f808 — the editor's third and current home: beside Job Grades on the Organisation tab. */
const SYSTEM_LABELS = path.join(ROOT, 'app/admin/settings/system-labels/page.tsx');
/** a6fe37fc Round 5 — the screen that absorbed the shared-group editor and the half-day card. */
const COMPANY_RULES = path.join(ROOT, 'app/admin/leave-config/company-rules/page.tsx');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

const entitlementsSrc = fs.readFileSync(ENTITLEMENTS, 'utf8');
const approvalSrc = fs.readFileSync(APPROVAL, 'utf8');
const systemLabelsSrc = fs.readFileSync(SYSTEM_LABELS, 'utf8');

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
const systemLabelsCode = stripComments(systemLabelsSrc);

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
    // a6fe37fc ROUND 5 — `<LeaveSharedGroupConfig` moved to Company rules, and the assertion follows it
    // rather than being dropped. A shared leave group is a TENANT catalogue, not a property of a leave
    // type; it sat at the foot of this screen for the same reason the half-day card did — that is where
    // the code grew (IA §1.2/§2.0.3). What f12d77e5 cared about is that the editor still EXISTS on a real
    // screen after a relocation, which is exactly what is checked here.
    expect(stripComments(fs.readFileSync(COMPANY_RULES, 'utf8'))).toContain('<LeaveSharedGroupConfig');
    // ee6b7c69 renamed this slot, and the rename IS the surface change: `entitlementTablesLink` held a
    // caption and a link to a separate screen; `entitlementTablesSection` holds the tables themselves,
    // filtered to the panel's leave type. Updated rather than loosened — the guard's job is to fail if the
    // Entitlement step loses its entitlement surface, which is exactly as true of the new name.
    expect(entitlementsCode).toContain('entitlementTablesSection');
    // 10b59703 (r266) — Run earned accrual moved to Generate Entitlement; what this screen keeps is the
    // pointer to it. The assertion follows the mount rather than being dropped, for the reason above.
    expect(entitlementsCode).toContain('accrualPointer');
    expect(entitlementsCode).not.toContain('<EarnedAccrualDialog');
    expect(stripComments(fs.readFileSync(path.join(ROOT, 'app/admin/leave-config/generate/page.tsx'), 'utf8'))).toContain('<EarnedAccrualDialog');
  });

  it('the destructure and the Promise.all still have the SAME arity, in the same order', () => {
    // THE TRAP THIS EDIT WALKED INTO: this page's own comment warns that dropping a name from the
    // destructure without its element shifts every later variable by one slot — `sharedGroups` would
    // silently become the profile options, with no type error, because both sides are arrays.
    // a6fe37fc ROUND 5 — `sharedGroups` left this destructure WITH the editor it fed, which is the very
    // edit this case exists to police: drop a name without its element and every later variable shifts one
    // slot, silently, because both sides are arrays. The expected shape is updated to the four that
    // remain, and the arity + position assertions are unchanged — they are the guard.
    // 10b59703 (r266) — `grades` left this destructure WITH the accrual dialog it fed (Generate
    // Entitlement reads its own grade list), the same shape of edit as `sharedGroups` above: the expected
    // shape shrinks to the three that remain, and the arity + position assertions are unchanged.
    const { names, calls } = destructuredAwaitAll(entitlementsCode, 'const [types,');
    expect(names).toEqual(['types', 'companies', 'profileOptionsActive']);
    expect(calls).toHaveLength(names.length);
    expect(calls[0]).toMatch(/^listLeaveTypes\(/);
    expect(calls[names.indexOf('profileOptionsActive')]).toMatch(/^listAllProfileOptions\(/);
    // …and the read went to the screen that now renders the editor, rather than being lost.
    const companyRules = stripComments(fs.readFileSync(COMPANY_RULES, 'utf8'));
    expect(companyRules).toContain('listLeaveSharedGroups(');
  });
});

describe('9a65f808 · …off the Leave Approval screen too, now that BOTH sides use grade groups', () => {
  it('the Approval page no longer imports or mounts the editor', () => {
    // f12d77e5 asserted the OPPOSITE here, and it was right while a grade group was only an approval
    // scope. The case is inverted rather than deleted: the mount having a single home is the property
    // worth guarding, and "it came back to a second screen" is exactly how two editors over one table
    // start drifting.
    expect(approvalCode).not.toContain('<GradeGroupConfig');
    expect(approvalSrc).not.toMatch(/^import .*grade-group-config'/m);
  });

  it('and stopped READING and GATING for it — the query and the isAdmin gate went with the card', () => {
    // The e4238594 precedent again: an unmounted card's data prep left behind is a query per render for a
    // surface nobody sees. `canEditGradeGroups` is the other half — a gate with nothing to gate reads as
    // a card that is merely hidden, which is the opposite of what happened.
    for (const gone of ['listGradeGroups', 'canEditGradeGroups', 'createGradeGroupAction']) {
      expect(approvalCode, `${gone} must be gone from the approval page's CODE`).not.toContain(gone);
    }
  });

  it('the destructure and the Promise.all still have the SAME arity, in the same order', () => {
    // The f12d77e5 trap, in the opposite direction: this removal drops the LAST name, and dropping the
    // element without the name (or the reverse) silently hands `eligibilityRulesAll` the grade groups.
    const { names, calls } = destructuredAwaitAll(approvalCode, 'const [leaveTypesAll,');
    expect(names).toEqual(['leaveTypesAll', 'gradesAll', 'eligibilityRulesAll']);
    expect(calls).toHaveLength(names.length);
    expect(calls[names.indexOf('gradesAll')]).toMatch(/^listJobGrades\(/);
    expect(calls[names.indexOf('eligibilityRulesAll')]).toMatch(/^listEligibilityRuleScopes\(/);
  });

  it('KEEPS the approval surfaces the item does not touch', () => {
    // Stated positively so an over-eager follow-up cleanup fails here rather than in production: the item
    // removed one card, and approval routing is untouched by design.
    expect(approvalCode).toContain('<ApprovalTemplateManager');
    expect(approvalCode).toContain('<ApprovalAssignmentManager');
    expect(approvalCode).toContain('<LeaveEscalationEditor');
  });
});

describe('9a65f808 · …and maintained on System Labels → Organisation, beside Job Grades', () => {
  it('the System Labels page imports the editor and mounts it', () => {
    expect(systemLabelsSrc).toMatch(/^import \{ GradeGroupConfig \} from '@\/components\/leave\/grade-group-config';$/m);
    expect(systemLabelsCode).toContain('<GradeGroupConfig');
    // The component file itself must still exist — a mount pointing at a deleted file is a build error,
    // but the deletion is the mistake this item exists to prevent, so it is named.
    expect(fs.existsSync(path.join(ROOT, 'components/leave/grade-group-config.tsx'))).toBe(true);
    // …and it is reachable: a body with no rail entry is a component that is mounted and unreachable.
    expect(systemLabelsCode).toContain('gradeGroupsSlot={gradeGroupsSlot}');
    expect(systemLabelsCode).toContain('gradeGroupsLabel=');
  });

  it('it reads the groups and wires all three writes — a read-only card would be a dead end', () => {
    const { names, calls } = destructuredAwaitAll(systemLabelsCode, 'const [companies,');
    expect(names).toContain('gradeGroups');
    expect(calls).toHaveLength(names.length);
    expect(calls[names.indexOf('gradeGroups')]).toContain('listGradeGroups(s)');
    for (const action of ['createGradeGroupAction', 'updateGradeGroupAction', 'deleteGradeGroupAction']) {
      expect(systemLabelsCode, `${action} must be wired on the System Labels page`).toContain(action);
    }
  });

  it('the read goes through the leave pack FACADE, not core/benefit-scheme', () => {
    // `listGradeGroups` lives in a guarded leave-pack boundary module (test/leave-pack-drift.test.ts), and
    // this page is not one of the pack's own routes. Importing the facade is the sanctioned path; the
    // alternative is an entry on an audited debt list documented to only ever shrink. Pinned here as well
    // as by the ratchet because the ratchet's message is about a list, not about this decision.
    expect(systemLabelsSrc).toMatch(/^import \{ listGradeGroups \} from '@\/packs\/leave\/service';$/m);
    expect(systemLabelsSrc).not.toMatch(/^import .*core\/benefit-scheme'/m);
  });

  it('the page guard is scopedAdmin — the move must not widen who can maintain a grade group', () => {
    // The card's previous home was `scopedSession` (all seven roles reach it by URL) and it carried its
    // own `isAdmin(s)` gate for exactly that reason. This page needs no such gate because its OWN guard is
    // admin-only, and lib/permissions.ts must agree — the registry is what drives the users/roles matrix,
    // so a page whose guard and registration disagree misreports who can reach a screen.
    expect(systemLabelsCode).toContain('scopedAdmin()');
    const permissions = fs.readFileSync(path.join(ROOT, 'lib/permissions.ts'), 'utf8');
    const entry = permissions.slice(permissions.indexOf("screenKey: 'systemLabels'"));
    expect(entry.slice(0, entry.indexOf('}'))).toContain("guard: 'scopedAdmin'");
  });

  it('the three writes RETURN to the System Labels screen — a redirect left behind is a bug', () => {
    // A save that worked and then dropped the admin on another screen would show no result. Worse on
    // failure: `fail()` carries the message in `?error=`, so deleteGradeGroup's refusal would be rendered
    // on a page with no grade-group form while the screen the admin is looking at reloads unchanged.
    const actionsSrc = fs.readFileSync(path.join(ROOT, 'app/admin/actions.ts'), 'utf8');
    const block = actionsSrc.slice(
      actionsSrc.indexOf('export async function createGradeGroupAction'),
      actionsSrc.indexOf('// SHARED LEAVE GROUPS'),
    );
    expect(block, 'the three grade-group actions must be findable as one block').not.toBe('');
    expect(stripComments(block)).not.toContain('ENTITLEMENTS');
    // ok() on the happy path and fail() on the error path, for each of the three.
    expect(stripComments(block).match(/ok\(SYSTEM_LABELS\)/g) ?? []).toHaveLength(3);
    expect(stripComments(block).match(/fail\(SYSTEM_LABELS, e\)/g) ?? []).toHaveLength(3);
    // …and the constant is the route this page actually lives at. `LEAVE_APPROVAL` was removed with the
    // card: these three were its only callers, and an exported redirect nobody redirects to is a stale
    // statement about where a screen lives.
    const redirects = fs.readFileSync(path.join(ROOT, 'app/admin/_redirects.ts'), 'utf8');
    expect(redirects).toContain("export const SYSTEM_LABELS = '/admin/settings/system-labels';");
    expect(redirects).not.toContain('export const LEAVE_APPROVAL');
  });

  it('the grades offered as members are the ACTIVE list', () => {
    // The membership form posts only the boxes it renders, so an archived grade shown nowhere is dropped
    // from the group on the next save. Both previous homes filtered for this reason — and here the filter
    // MUST be explicit, because this page loads grades with includeArchived for the Grades GRID beside it
    // (that grid has to be able to show and restore an archived row). Inheriting that list would be the
    // silent data loss the two earlier screens avoided by accident of their own narrower read.
    expect(systemLabelsCode).toContain('listJobGrades(s, { includeArchived: true })');
    expect(systemLabelsCode).toMatch(/grades\.filter\(\(g\) => g\.archivedAt == null\)\.map/);
  });
});

describe('f12d77e5 · the moved card still has its strings, in all six locales', () => {
  it('every admin.benefitScheme key the editor reads resolves everywhere', () => {
    // 9a65f808 — unchanged by the second move for the same reason it survived the first: the card reads
    // its OWN namespace, and the page reads only `groupsTitle` from it for the rail entry. A move that
    // minted a fresh copy of these twelve strings would be twelve strings to keep in step in six files.
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
