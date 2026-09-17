/**
 * a6fe37fc ROUND 4 — APPROVAL: the editor at its new address, and the read-only RESTORATION.
 *
 * Two things ship in this round (docs/design/a6fe37fc-migration-order.md → Round 4):
 *   1. `/admin/leave-config/approval-chains` — templates, assignment and escalation exactly as today,
 *      MOUNTING the same shared components the old approval screen mounts, **plus** a read-only list of
 *      the approval rules that are not built from a template, showing their business unit / department /
 *      position scope and their effective chain (IA §4.1).
 *   2. Tab 5 on the new leave type screen — which chain reaches this leave type, its ordered steps and
 *      the escalation, read-only, linking to Approval chains (IA §2.2).
 *
 * ⚠️ WHY A STATIC SOURCE GUARD, AGAIN: every way this round can go wrong passes `tsc`, `next build`, a
 * 200 and the rest of the suite. Same shape as test/leave-config-round3.test.ts and
 * test/leave-config-types-tabs.test.ts, which Rounds 2 and 3 wrote for the same reason.
 *
 * THE FOUR PROPERTIES IT PINS:
 *
 *   1. **THE PERMISSION EXCEPTION.** This is the ONE screen of the new module that does not hang off
 *      `leaveConfig`/`requireAdmin`. It hangs off `leaveApproval` and keeps `scopedSession`, because a
 *      company-scoped admin must keep seeing only their own companies (IA §6.4). A page registered
 *      against the wrong key would hand a company-scoped admin the whole tenant, and NOTHING else in the
 *      gate would notice: test/function-access.test.ts checks that a guarded page has *a* column, not
 *      that it has the right one.
 *   2. **THE READ-OUT IS READ-ONLY, STRUCTURALLY.** `706d34e8` removed a second EDITOR over these rows.
 *      What comes back is a read-out, and the difference has to be enforceable rather than promised: no
 *      form, no action, no write path anywhere in the file that draws it.
 *   3. **IT COMPUTES NO ROUTING OF ITS OWN** (IA §2.3 — one matcher, mounted twice). The read-out
 *      resolves through `decideApproval` over a rule set read once, and enumerates template-less rules
 *      through `listLegacyApprovalRules` — the same enumeration `scripts/convert-approval-rules.ts`
 *      counts. A second ranking, or a second `template_id is null` query, is the drift this whole item
 *      exists to remove.
 *   4. **THIS ROUND ADDS AND REMOVES NOTHING.** The old approval screen keeps every section, the menu
 *      still points at it, and the new route is deliberately off the map until Round 5.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAVE_CONFIG_MAP, leaveConfigScreenHref } from '../components/leave-config-map';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, '..', rel), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

const NEW_PAGE = 'app/admin/leave-config/approval-chains/page.tsx';
const READOUT = 'app/admin/leave-config/approval-readout.tsx';
const ROUTE = '/admin/leave-config/approval-chains';

const page = read(NEW_PAGE);
const readout = read(READOUT);
const typesPage = read('app/admin/leave-config/types/page.tsx');
const tabs = read('app/admin/leave-config/types/leave-type-tabs.tsx');
/**
 * The old screen. Round 4 left it standing; a6fe37fc ROUND 5 (cutover) emptied it into a redirect stub,
 * and the assertions below are re-pointed at that fact rather than deleted — "the editor is not
 * duplicated" is still the property, and after the cutover it is stronger, because there is exactly one
 * editor left instead of two.
 */
const oldApproval = read('app/admin/leave/approval/page.tsx');
const policySrc = read('core/leave-approval-policy.ts');
const consolidationSrc = read('core/leave-approval-consolidation.ts');

/**
 * COMMENTS ARE NOT CODE — the r134 rule. An honest header NAMES what it is not doing ("no form, no
 * action"), so an absence assertion over the raw file would report correct code as wrong.
 *
 * ⚠️ IT STRIPS THE COMMENT, NOT THE LINE, AND THE DIFFERENCE IS THE WHOLE GUARD. The repo's older helper
 * deleted every line CONTAINING `//`, which in the import ratchet only ever ADDED edges (r159 took that
 * trade deliberately). Here the assertions below are ABSENCE checks, where the same blindness REMOVES
 * evidence and fails silent: `<form action={x}> // note` stripped to the empty string satisfies both
 * "no `<form`" and "no `action={`", and a write path smuggled in behind a trailing comment would pass.
 * Only the comment is removed, and `://` is left alone so a URL in a string literal survives intact.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*$/gm, '$1');
const pageCode = stripComments(page);
const readoutCode = stripComments(readout);

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 1. The permission exception — the one thing in this round that is not like Round 3
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a6fe37fc R4 · the route is registered, and it is registered on the RIGHT screen key', () => {
  it('is a declared route, so it can be granted and revoked like any screen', () => {
    expect(
      REGISTERED_ROUTES.has(ROUTE),
      `${ROUTE} is a guarded page with no screen column — test/function-access.test.ts's ` +
        `reverse-completeness case fails on exactly this, and the route becomes one nobody can grant or revoke`,
    ).toBe(true);
  });

  it('hangs off leaveApproval / scopedSession — NOT leaveConfig / requireAdmin (IA §6.4)', () => {
    const leaveApproval = SCREENS.find((s) => s.screenKey === 'leaveApproval')!;
    const leaveConfig = SCREENS.find((s) => s.screenKey === 'leaveConfig')!;
    expect(
      leaveApproval.routes,
      'Approval chains must be registered on the leaveApproval screen key: it is the one screen of the ' +
        'new module whose guard is scopedSession, because a company-scoped admin must keep seeing only ' +
        'their own companies (IA §6.4)',
    ).toContain(ROUTE);
    expect(leaveApproval.guard).toBe('scopedSession');
    expect(
      leaveConfig.routes,
      'Approval chains on the leaveConfig key would put a requireAdmin column in front of a ' +
        'scopedSession page — "no merging of screens that are gated differently" (IA §6.4)',
    ).not.toContain(ROUTE);
    // The key itself is never renamed (lib/permissions.ts: a key "may key stored role configs").
    expect(leaveApproval.screenKey).toBe('leaveApproval');
    // a6fe37fc ROUND 5 (cutover) — the menu HAS moved, and the href moved with it. Only `href` and
    // `routes` ever move; the screen KEY above is what a stored role config is keyed on and is untouched.
    expect(leaveApproval.href).toBe(ROUTE);
    expect(leaveApproval.routes, 'the stub must have left the registry with its page').not.toContain(
      '/admin/leave/approval',
    );
  });

  it('calls the page guard the registry describes, and no other', () => {
    // function-access.test.ts finds a page by grepping for a guard call; a page whose guard disagrees
    // with its column reports access it does not enforce.
    expect(pageCode).toContain('await scopedSession()');
    expect(pageCode, 'requireAdmin() here would widen a company-scoped admin to the whole tenant').not.toContain(
      'requireAdmin',
    );
  });

  it('trims every company list it renders to the admin’s own scope', () => {
    // `leave_approval_policy` is readable TENANT-WIDE (the requester resolves their own chain in their
    // own transaction), so RLS alone does not scope this page — the company filter does. Three lists
    // hang off it: the assignment rows, the escalation rows and the new read-only rule list.
    expect(pageCode).toContain('const { s, scopeIds } = await scopedSession();');
    expect(pageCode).toContain('const companies = all.filter((c) => scopeIds.includes(c.id));');
    expect(pageCode).toContain('assignments = allAssignments.filter((a) => companyIds.includes(a.companyId))');
    // The read-out is handed the SAME already-trimmed list, never `all`.
    expect(pageCode).toContain('loadApprovalRuleScopes(s, companies, templates,');
    expect(
      /loadApprovalRuleScopes\(s,\s*all\b/.test(pageCode),
      'the read-only rule list is fed the UNTRIMMED company list — a company-scoped admin would see ' +
        'approval rules belonging to companies they do not manage',
    ).toBe(false);
    // …and the loader itself scopes by the list it is given rather than trusting the read. BOTH reads:
    // `leave_approval_policy` is readable tenant-wide, so a filter missing from either one leaks the
    // other's rows (test/leave-approval-scope-readout.test.ts proves this against a real second company).
    expect(readoutCode).toContain(
      'for (const r of legacy) if (r.templateId === null && companyName.has(r.companyId)) listed.set(r.id, r);',
    );
    expect(readoutCode).toContain(
      'for (const r of orgScoped) if (companyName.has(r.companyId)) listed.set(r.id, r);',
    );
  });

  it('IS on the leave config map now, at the new address, and the old one is off it', () => {
    // Round 4 asserted the opposite ("the menu moves at the Round 5 cutover, not now"). This IS that
    // cutover, so the case is inverted rather than dropped — both directions still fail loudly: a menu
    // that never moved, and a menu that moved while the page was still live.
    const hrefs = LEAVE_CONFIG_MAP.flatMap((g) => g.items).map((i) => i.href);
    expect(hrefs).toContain(ROUTE);
    expect(hrefs).not.toContain('/admin/leave/approval');
    expect(leaveConfigScreenHref('approvalChain')).toBe(ROUTE);
  });

  it('renders the area map, and no longer calls itself a preview', () => {
    // Without the map a leave-config screen can reach no other leave-config screen at all (r258).
    expect(page).toContain('<LeaveConfigMap current="approvalChain" />');
    // Round 4 required the preview note here because a save navigated to the screen this one replaces.
    // It IS the screen now, so the note comes off — a real screen telling the administrator it is a
    // preview is worse than no note.
    expect(page).not.toContain('<LeaveConfigPreviewNote');
    // ⚠️ STATED RATHER THAN GLOSSED: `app/admin/leave-approval/actions.ts` keeps its own private
    // `PAGE = '/admin/leave/approval'` literal. The migration order's Round 5 names the redirect
    // constants it moves (app/admin/_redirects.ts's five, and app/admin/actions.ts's LEAVE_REPLACEMENT)
    // and this one is not among them, so it was left alone deliberately. A save still ARRIVES here: the
    // old address is a stub that forwards the query string, so the ?toast= / ?error= reaches this screen
    // through one extra hop. Asserted so the hop is a known, written-down cost rather than a discovery.
    expect(read('app/admin/leave-approval/actions.ts')).toContain("const PAGE = '/admin/leave/approval';");
    const stub = read('app/admin/leave/approval/page.tsx');
    expect(stub).toContain(ROUTE);
    // ⚠️ ASSERTED AS THE LOOP, NOT AS THE TOKEN — and this is the ONE stub where that matters most.
    // The first version of this case checked for the string `URLSearchParams`, exactly the shape
    // test/leave-config-round3.test.ts already proved walk-through-able for the other nine stubs:
    // deleting the forwarding LOOP while leaving `const usp = new URLSearchParams();` behind passed
    // tsc and the whole suite. `/admin/leave/approval` is not in round3's CUTOVER table (it is Round
    // 4's screen, not Round 3's), so this file is the only place the hole can be closed.
    //
    // WHY IT IS LOAD-BEARING HERE ABOVE ALL: this is the only stub an action still redirects INTO.
    // `PAGE` above is the target of 14 redirects in app/admin/leave-approval/actions.ts — 7 success
    // `?toast=` (escalation settings saved, template duplicated / activated or deactivated / deleted,
    // default flow set or cleared, assignment added, assignment removed) and 7 `?error=` — and
    // `ToastFromQuery` in app/layout.tsx renders them from the query string ALONE. (r304 / 85875e4b took
    // the template SAVE out of this count: it returns its outcome to the template drawer instead of
    // redirecting, so its "created / updated" confirmation is a client toast now. Pinned in the
    // "wires the SAME server actions" case below.) A stub that stops
    // forwarding does not 404 and does not fail a render: it silently drops every approval-chain
    // confirmation AND every approval-chain error. That is the Phase-B #14 class this round exists to
    // prevent. All three halves are checked: the params are read, they are carried, and the query is
    // appended to the redirect.
    expect(stub, "the approval stub does not READ the incoming params — every ?toast= and ?error= from actions.ts's 14 redirect sites is dropped").toMatch(
      /for \(const \[k, v\] of Object\.entries\(sp\)\)/,
    );
    expect(stub, 'the approval stub does not carry the incoming params onto the destination').toMatch(
      /usp\.set\(k, v\)/,
    );
    expect(stub, 'the approval stub does not append the query string to the redirect').toMatch(
      /\$\{qs \? `\?\$\{qs\}` : ''\}/,
    );
    // …and the redirect it builds is the destination one, not a bare literal that ignores `qs`.
    expect(stub).toMatch(/redirect\(`\/admin\/leave-config\/approval-chains\$\{qs \? `\?\$\{qs\}` : ''\}`\)/);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 2. Mounted, never re-implemented (IA §2.3)
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a6fe37fc R4 · the approval editor is MOUNTED at the new address, not rebuilt', () => {
  it.each([
    ['the template manager', '<ApprovalTemplateManager'],
    ['the assignment manager', '<ApprovalAssignmentManager'],
    ['the per-company escalation editor', '<LeaveEscalationEditor'],
  ])('%s is mounted on the new page', (_what, mount) => {
    expect(page).toContain(mount);
  });

  it('mounts them from the SAME files the old screen mounts them from', () => {
    for (const spec of [
      "from '../../leave-approval/escalation-editor'",
      "from '../../leave-approval/template-manager'",
      "from '../../leave-approval/actions'",
    ]) {
      expect(page).toContain(spec);
    }
  });

  it('wires the SAME server actions — no new action, and none declared here', () => {
    // Round 2's rule 2, still in force for NEW actions: every save goes through an action that already
    // exists. Its "signature unchanged" half has ONE deliberate exception since r304 (board 85875e4b):
    // `saveApprovalTemplateAction` RETURNS `{ ok, … }` instead of redirecting, so the template drawer keeps
    // a refused save's edits on screen. The old screen that rule protected is a redirect stub now, and the
    // template manager is the action's only caller. Pinned both ways below, so a second signature change —
    // or this one quietly reverting to a redirect — is a visible decision rather than drift.
    expect(page.includes("'use server'"), `${NEW_PAGE} must not declare server actions`).toBe(false);
    const actions = read('app/admin/leave-approval/actions.ts');
    const fnBody = (name: string) => {
      const from = actions.indexOf(`export async function ${name}(`);
      const next = actions.indexOf('\nexport async function ', from + 1);
      return actions.slice(from, next === -1 ? undefined : next);
    };
    const save = fnBody('saveApprovalTemplateAction');
    expect(save).toContain('Promise<SaveTemplateResult>');
    expect(save, 'the template save redirects again — a refused save would lose the drawer\'s edits').not.toContain(
      'redirect(',
    );
    for (const action of [
      'duplicateApprovalTemplateAction',
      'setApprovalTemplateActiveAction',
      'deleteApprovalTemplateAction',
      'setTenantDefaultTemplateAction',
      'assignApprovalTemplateAction',
      'unassignApprovalTemplateAction',
      'saveLeaveEscalationPolicyAction',
    ]) {
      expect(fnBody(action), `${action} stopped redirecting to PAGE`).toContain('redirect(`${PAGE}?toast=');
    }
    for (const action of [
      'saveApprovalTemplateAction',
      'duplicateApprovalTemplateAction',
      'setApprovalTemplateActiveAction',
      'deleteApprovalTemplateAction',
      'setTenantDefaultTemplateAction',
      'assignApprovalTemplateAction',
      'unassignApprovalTemplateAction',
      'saveLeaveEscalationPolicyAction',
    ]) {
      expect(actions).toContain(`export async function ${action}(`);
      expect(page).toContain(action);
    }
  });

  it('keeps the assignment card’s employee scope and its conditions — nothing narrowed in the move', () => {
    expect(page).toContain('eligibilityRules={eligibilityRulesAll');
    // 22de47c4: a rule naming only invisible companies is not this admin's to assign, but `companyIds`
    // is passed to the panel UNTRIMMED — an empty list there means "every company".
    expect(page).toContain('r.companyIds.length === 0 || r.companyIds.some((c) => companyIds.includes(c))');
    expect(page).toContain('minDays: a.minDays');
    expect(page).toContain('maxDays: a.maxDays');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 3. The restoration — read-only, and structurally so
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a6fe37fc R4 · the rules whose scope or chain nothing shows get a surface back (IA §4.1)', () => {
  it('the list is on the page, and it shows the three scope columns that have been invisible', () => {
    expect(page).toContain('<ApprovalRuleScopes rows={ruleScopes} />');
    // The three dimensions `706d34e8` took the only display of. Each one is READ by `ruleMatches` and
    // decides who approves; showing them is the whole point of the round.
    for (const dim of ['businessUnit', 'department', 'position']) {
      expect(readoutCode, `the read-out no longer shows a rule's ${dim} scope`).toContain(`r.${dim}`);
    }
    // …and the two the matrix also carried, plus the day range and the employment type.
    for (const dim of ['jobGrade', 'gradeGroup', 'employmentType', 'minDays', 'maxDays']) {
      expect(readoutCode).toContain(`r.${dim}`);
    }
    // The effective chain, which is what actually answers "who approves this".
    expect(readoutCode).toContain('<ChainSteps levels={r.levels}');
  });

  it('reads the CONVERTED rows too — a template does not make an org scope visible', () => {
    // ⚠️ THE FIX THIS FILE EXISTS TO PIN. The first version filtered the whole list to
    // `templateId === null`, and `convertLegacyApprovalRules` COPIES business_unit_id / department_id /
    // position_id onto the rows it expands while STAMPING a template_id on them. r94 ran that conversion
    // on production, after which no active rule matched `template_id is null or leave_type_id is null` —
    // so the restoration rendered EMPTY on the only data it was built for, and the columns that decide
    // who approves stayed exactly as hidden as before the round.
    //
    // This case is static; test/leave-approval-scope-readout.test.ts plants the converted shape
    // (template_id NOT NULL + department_id set) in a real database and reads the department NAME back
    // out of this loader. Both are needed: the source guard cannot see which rows a query returns, and
    // the database test cannot see that the page still mounts the component.
    expect(readoutCode).toContain('listOrgScopedApprovalRules(s)');
    expect(read('core/leave-approval-template.ts')).toContain(
      'export async function listOrgScopedApprovalRules(',
    );
    // The projection's predicate names the three columns and nothing about a template — a rule that
    // narrows by department is listed WHETHER OR NOT it was built from one.
    const core = stripComments(read('core/leave-approval-template.ts'));
    const projection = core.slice(core.indexOf('export async function listOrgScopedApprovalRules('));
    for (const col of ['businessUnitId', 'departmentId', 'positionId']) {
      expect(projection.slice(0, projection.indexOf('.orderBy'))).toContain(`${col}} is not null`);
    }
    expect(
      /templateId\}\s*is (not )?null/.test(projection.slice(0, projection.indexOf('.orderBy'))),
      'the org-scope read filters on template_id — which is precisely how the converted rows went ' +
        'missing from the restoration in the first place',
    ).toBe(false);
    // Only ACTIVE rules: an archived rule routes nothing and belongs on no screen.
    expect(projection).toContain('eq(leaveApprovalPolicy.active, true)');
  });

  it('has NO write path: no form, no action, no edit affordance anywhere in the read-out', () => {
    // ⚠️ THIS IS THE CASE THAT MAKES THE RESTORATION SAFE. `706d34e8` removed a second EDITOR over these
    // rows; a read-out is only "not that editor" while it cannot write. Asserted against the file that
    // DRAWS it, with commentary stripped, because the header necessarily names what it is not doing.
    expect(readoutCode.includes("'use server'")).toBe(false);
    for (const write of [
      '<form',
      'action={',
      'saveLeaveApprovalRuleAction',
      'archiveLeaveApprovalRuleAction',
      'createLeaveApprovalRule',
      'updateLeaveApprovalRule',
      'archiveLeaveApprovalRule',
      'setLeaveApprovalPolicy',
    ]) {
      expect(
        readoutCode.includes(write),
        `${READOUT} contains \`${write}\` — a read-out that can WRITE is the duplicate editor 706d34e8 ` +
          `removed, wearing a new name. Every control that changes a chain belongs on Approval chains.`,
      ).toBe(false);
    }
    // …and the per-rule actions are still retired, so there is nothing for a later edit button to post to.
    const actions = read('app/admin/leave-approval/actions.ts');
    expect(actions).not.toContain('saveLeaveApprovalRuleAction');
    expect(actions).not.toContain('archiveLeaveApprovalRuleAction');
    // The widened read is READ-ONLY too: a projection beside `listTemplateAssignments` must not have
    // grown a write, or the "no second editor" property moves out of this file's reach.
    const projection = stripComments(read('core/leave-approval-template.ts'));
    const body = projection.slice(projection.indexOf('export async function listOrgScopedApprovalRules('));
    const fn = body.slice(0, body.indexOf('\nexport '));
    for (const write of ['tx.insert', 'tx.update', 'tx.delete', 'appendEvent']) {
      expect(fn.includes(write), `listOrgScopedApprovalRules performs a ${write}`).toBe(false);
    }
  });

  it('enumerates through the PACK SERVICES, and builds no query of its own', () => {
    // `listLegacyApprovalRules` is what scripts/convert-approval-rules.ts counts and what the migration
    // order's precondition check reads. A second `template_id is null` query here could drift from it,
    // and then the screen and the conversion script would disagree about what is left to convert.
    expect(readoutCode).toContain('listLegacyApprovalRules(tx)');
    expect(consolidationSrc).toContain('export async function listLegacyApprovalRules(');
    expect(
      readoutCode.includes("from '@/db/schema'") || readoutCode.includes("from 'drizzle-orm'"),
      'the read-out builds a query of its own instead of calling the pack service — the enumeration and ' +
        'the conversion script must read the same set',
    ).toBe(false);
  });

  it('lists a rule ONCE, and leaves the fully-described assignment rows to the assignment list', () => {
    // The two reads overlap on a rule that is both template-less AND org-scoped, so the union is keyed
    // by rule id. And a templated rule with NO org scope is still excluded: `listTemplateAssignments`
    // returns every active row that carries a template — including the null-leave-type ones, which the
    // assignment list groups under `firstLeaveTypeId === null` — with the employee scope it renders.
    // Listing those again would be the duplication 706d34e8 removed, in a new place.
    expect(readoutCode).toContain('const listed = new Map<string, OrgScopedApprovalRule>();');
    expect(readoutCode).toContain('r.templateId === null');
    expect(read('core/leave-approval-template.ts')).toContain(
      'sql`${leaveApprovalPolicy.templateId} is not null`',
    );
  });

  it('says where each listed rule’s chain comes from, and never prints a raw id in a scope cell', () => {
    // Two kinds of row share the table now, so each says which it is — reusing tab 5's vocabulary
    // rather than a second copy of it.
    expect(readoutCode).toContain("tr('sourceTemplate', { name: r.templateName })");
    // A scoping id that resolves to NO catalogue row must read as "(unknown)", not as a UUID: a raw id
    // in a scope cell reads as data corruption on the one screen whose job is to explain routing.
    expect(readoutCode).toContain('byId.get(id) ?? unknownLabel');
    expect(
      readoutCode.includes('byId.get(id) ?? id'),
      'an unresolved scoping id falls back to printing the raw UUID',
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 4. Tab 5 — the read-out Round 2 deferred
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a6fe37fc R4 · tab 5 answers its own title, read-only (IA §2.2)', () => {
  it('the tab renders the read-out, and the page supplies it', () => {
    const tab5 = tabs.slice(tabs.indexOf("{activeTab === 'approvers' && ("));
    expect(tab5).toContain('{approvalReadoutSection}');
    expect(typesPage).toContain('<LeaveTypeApprovalReadout data={approvalReadout} leaveTypeId={lt.id} />');
  });

  it('the per-date approval setting is STILL there, with its marker and its field', () => {
    // Round 2's F7. The read-out is added BESIDE it, not in place of it — and the marker is what stops
    // this form wiping the columns a neighbouring form owns.
    const tab5 = tabs.slice(tabs.indexOf("{activeTab === 'approvers' && ("));
    expect(tab5).toContain('name="partialApproval" value="1"');
    expect(tab5).toContain('name="perDateApproval"');
  });

  it('resolves through THE matcher, over a rule set read ONCE for the page', () => {
    // `decideApproval` is the ranking; `resolveApprovalDecision` is that function plus its two reads.
    // A read-out with a ranking of its own would answer differently from the engine that routes the
    // request — worse than no read-out (IA §2.3, and core/leave-approval-policy.ts's own note).
    expect(readoutCode).toContain('decideApproval(data.set, c.id, leaveTypeId)');
    expect(readoutCode).toContain('loadApprovalRuleSet(tx)');
    expect(policySrc).toContain('export function decideApproval(');
    expect(policySrc).toContain('export async function loadApprovalRuleSet(');
    // Prepared once at page level, not per leave type: a per-type read is `types × companies × 2`
    // queries on one render.
    expect(typesPage).toContain('const approvalReadout = await loadLeaveTypeApprovalReadout(s, companyOptions);');
    expect((typesPage.match(/loadLeaveTypeApprovalReadout\(/g) ?? []).length).toBe(1);
  });

  it('reports the chain, where it came from, and the escalation that chases it', () => {
    expect(readoutCode).toContain('<ChainSteps levels={decision.levels}');
    for (const key of ['sourceRule', 'sourceTemplate', 'sourceTenantDefault', 'sourceFallback']) {
      expect(readoutCode, `tab 5 no longer says where the chain came from (${key})`).toContain(`tr('${key}'`);
    }
    expect(readoutCode).toContain("tr('escalationOn'");
    expect(readoutCode).toContain("tr('escalationOff')");
    // The narrower rules are COUNTED rather than averaged into one answer — a per-employee answer needs
    // an employee, and this tab has none.
    expect(readoutCode).toContain("tr('otherRules', { n: others })");
  });

  it('only says "other rule" when a rule actually WON', () => {
    // `decision.ruleId` is null on BOTH fallback paths — no rule matched, and (less obviously) a rule
    // matched but its effective chain resolved empty, which `decideApproval` reports without naming the
    // rule (core/leave-approval-policy.ts). Calling every candidate an "other rule" there implies a
    // primary rule that does not exist, and in the second case counts the rule that DID match among the
    // others. Two situations, two sentences.
    expect(readoutCode).toContain(
      "wonByRule ? tr('otherRules', { n: others }) : tr('candidateRules', { n: others })",
    );
    expect(readoutCode).toContain('const wonByRule = decision.ruleId !== null;');
    // r293 phase 3 — the SAME decision, through the one constructor that now builds every ApprovalDecision
    // (`decision(levels, ruleId, source)`), because a level can carry a named approver and `levels` became
    // a projection of `resolvedLevels`. What this pins is unchanged and is the point: BOTH fallback paths
    // report `ruleId: null`, so tab 5 never calls a candidate an "other rule" when no rule won.
    expect(policySrc).toContain("return decision(set.tenantDefaultLevels, null, 'tenant-default');");
    expect(policySrc).toContain("return decision(FALLBACK_CHAIN, null, 'fallback');");
  });

  it('links to Approval chains through the MAP, so the link and the menu cannot disagree', () => {
    // r259 finding 3: the preview module had two navigation directions at once. One direction now, and
    // it is OUT, resolved through the map (test/leave-config-round3.test.ts walks the whole module for
    // hard-coded inward hrefs).
    expect(readoutCode).toContain("leaveConfigScreenHref('approvalChain')");
    expect(readoutCode).not.toContain("href=\"/admin/leave/approval\"");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 5. Nothing is removed this round
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a6fe37fc R5 · the editor exists at exactly ONE address, and the other one still answers', () => {
  it.each([
    ['the template manager', '<ApprovalTemplateManager'],
    ['the assignment manager', '<ApprovalAssignmentManager'],
    ['the escalation editor', '<LeaveEscalationEditor'],
    ['the area map', '<LeaveConfigMap current="approvalChain" />'],
  ])('%s is live at the new address, and nowhere else', (_what, needle) => {
    // Round 4 read "…is still live on the OLD approval screen", because that round removed nothing. The
    // cutover closes the window: each of these is on the new page and gone from the old one. Both halves
    // are asserted, so a cutover that emptied the page without the editor arriving fails here.
    expect(page, `${_what} did not arrive at ${ROUTE}`).toContain(needle);
    expect(oldApproval, `${_what} is still on the old screen — two editors over the same rows`).not.toContain(
      needle,
    );
  });

  it('the old page is a redirect stub aimed at the new address, and no bookmark 404s', () => {
    expect(oldApproval).toContain('redirect(');
    expect(oldApproval).toContain(ROUTE);
    // A stub carries no page guard — which is what lets its route leave lib/permissions.ts.
    expect(/scopedSession|requireAdmin|scopedAdmin/.test(oldApproval)).toBe(false);
    // And the nav entry the customer clicks moved with it.
    expect(read('packs/leave/index.ts')).toContain("href: '/admin/leave-config/approval-chains'");
    expect(read('packs/leave/index.ts')).not.toContain("href: '/admin/leave/approval'");
    // The OLDER stub (0d147b78, app/admin/leave-approval/page.tsx) was repointed in the same commit
    // rather than left chaining through this one.
    const olderStub = read('app/admin/leave-approval/page.tsx');
    expect(olderStub).toContain(ROUTE);
    // …and it forwards, which it did NOT until r261's verify pass. It was the one leave address of the
    // eleven that stripped the query string outright — no `searchParams` parameter, no loop, a bare
    // `redirect('/admin/leave-config/approval-chains')` — so a bookmarked link carrying `?company=`
    // opened on the wrong company and a `?toast=` was swallowed. Pinned as the loop rather than the
    // token, for the same reason the case above is: deleting the loop and leaving the declaration
    // behind passes tsc and everything else.
    expect(olderStub, 'the 0d147b78 stub does not READ the incoming params').toMatch(
      /for \(const \[k, v\] of Object\.entries\(sp\)\)/,
    );
    expect(olderStub, 'the 0d147b78 stub does not carry them onto the destination').toMatch(/usp\.set\(k, v\)/);
    expect(olderStub, 'the 0d147b78 stub does not append the query string to the redirect').toMatch(
      /\$\{qs \? `\?\$\{qs\}` : ''\}/,
    );
    // A chain of two stubs is what the repoint above removed; assert it did not come back. Over the
    // STRIPPED source — the r134 rule: this stub's header names the address it used to point at, and an
    // absence check over the raw file would report a correct, honest stub as wrong.
    expect(stripComments(olderStub), 'the 0d147b78 stub chains through the other stub again').not.toContain(
      '/admin/leave/approval',
    );
  });

  it('the read-out lands at the new address only — it was never copied onto the old screen', () => {
    // Round 4's reasoning, unchanged: two copies of the same table in front of one administrator is the
    // "two entries for one job" the map exemption existed to avoid. The stub cannot carry one either.
    expect(oldApproval).not.toContain('UntemplatedApprovalRules');
    expect(oldApproval).not.toContain('<ApprovalRuleScopes');
    // …and it IS at the new address: the IA §4.1 restoration is the one genuinely new thing Round 4
    // added, so a cutover that lost it would be a regression the stub could hide.
    expect(page).toContain('<ApprovalRuleScopes');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 6. i18n — the r127 lesson
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a6fe37fc R4 · every new label ships in all six locales with real translations', () => {
  // r127 shipped a screen rendering entirely through MISSING_MESSAGE behind a green 200: it passes tsc,
  // the suite and next build. Both new files call two namespaces each, so i18n-coverage's static-key
  // case skips them entirely and this is the pinning site.
  const NEW_KEYS = [
    'pageDescription',
    'scopesTitle',
    'scopesHint',
    'scopesReadOnly',
    'scopesEmpty',
    'colScope',
    'scopeAllEmployees',
    'scopeUnknown',
    'chainEmptyFallback',
    'readoutTitle',
    'readoutHint',
    'sourceRule',
    'sourceTemplate',
    'sourceTenantDefault',
    'sourceFallback',
    'escalationOn',
    'escalationOff',
    'otherRules',
    'candidateRules',
    'readoutManageLink',
  ] as const;

  it.each(LOCALES)('%s carries every new admin.leaveConfigApprovalChains key with real text', async (loc) => {
    const messages = (await import(`../messages/${loc}.json`)).default as Record<string, unknown>;
    const ns = (messages.admin as Record<string, Record<string, string>>).leaveConfigApprovalChains;
    expect(ns, `${loc} has no admin.leaveConfigApprovalChains namespace`).toBeTruthy();
    for (const k of NEW_KEYS) {
      expect(typeof ns[k], `${loc} · ${k}`).toBe('string');
      expect(ns[k].trim().length, `${loc} · ${k} is blank`).toBeGreaterThan(0);
    }
  });

  it('the five non-English locales are TRANSLATED, not English copied through', async () => {
    const en = (await import('../messages/en.json')).default as Record<string, unknown>;
    const enNs = (en.admin as Record<string, Record<string, string>>).leaveConfigApprovalChains;
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      const messages = (await import(`../messages/${loc}.json`)).default as Record<string, unknown>;
      const ns = (messages.admin as Record<string, Record<string, string>>).leaveConfigApprovalChains;
      for (const k of NEW_KEYS) {
        expect(ns[k], `${loc} · ${k} is the English string`).not.toBe(enNs[k]);
      }
    }
  });

  it.each(LOCALES)('%s states the two counted messages as ICU plurals', async (loc) => {
    const messages = (await import(`../messages/${loc}.json`)).default as Record<string, unknown>;
    const ns = (messages.admin as Record<string, Record<string, string>>).leaveConfigApprovalChains;
    // A bare "{n} rules" reads wrong in English at n=1 and is unformattable in the four locales whose
    // plural rules differ; next-intl throws FORMATTING_ERROR at RENDER time on a malformed one.
    for (const k of ['otherRules', 'candidateRules'] as const) {
      expect(ns[k], `${loc}.${k}`).toMatch(/\{n,\s*plural,/);
      expect(ns[k]).toContain('other {');
      expect(ns[k]).toContain('#');
    }
    expect(ns.escalationOn, `${loc}.escalationOn`).toMatch(/\{days,\s*plural,/);
    expect(ns.escalationOn).toContain('{target}');
    expect(ns.sourceTemplate, `${loc}.sourceTemplate`).toContain('{name}');
  });

  it.each(LOCALES)('%s FORMATS every new message — not just carries it (the r127 lesson, one level up)', async (loc) => {
    // A key that exists but is malformed throws FORMATTING_ERROR at RENDER time and returns a 200 with
    // the panel missing — the same failure class as MISSING_MESSAGE, and equally invisible to tsc, the
    // suite and `next build`. Regex-matching `{n, plural,` proves the shape; RUNNING the formatter
    // proves it formats. `createTranslator` is next-intl's own core, so this is the same code path the
    // server component takes.
    const { createTranslator } = await import('next-intl');
    const messages = (await import(`../messages/${loc}.json`)).default as Record<string, unknown>;
    // ⚠️ `onError` IS LOAD-BEARING. next-intl SWALLOWS a MISSING_MESSAGE or FORMATTING_ERROR by default
    // and hands back the key, so a malformed ICU string still returns a non-empty string and an
    // assertion on the output alone passes. Rethrowing is what turns the render-time failure into a
    // test-time one — which is the whole reason this case exists.
    const t = createTranslator({
      locale: loc,
      messages,
      namespace: 'admin.leaveConfigApprovalChains',
      onError: (e) => {
        throw e;
      },
    });
    const args: Record<string, Record<string, unknown>[]> = {
      sourceTemplate: [{ name: 'Standard' }],
      escalationOn: [
        { days: 1, target: 'HR' },
        { days: 3, target: 'HR' },
      ],
      otherRules: [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 5 }],
      candidateRules: [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 5 }],
    };
    for (const k of NEW_KEYS) {
      for (const bag of args[k] ?? [{}]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = (t as any)(k, bag) as string;
        expect(typeof out, `${loc} · ${k} did not format`).toBe('string');
        expect(out.trim().length, `${loc} · ${k} formatted to nothing`).toBeGreaterThan(0);
        expect(out, `${loc} · ${k} left a placeholder unformatted`).not.toMatch(/\{[a-z]+,\s*plural/i);
      }
    }
  });

  it('the empty state claims ONLY what the two reads can support (AGENTS 28)', async () => {
    // ⚠️ THE STRING THIS REPLACED SAID: "Every active approval rule is built from a template, so
    // everything that routes a request is shown above." On a fully-converted tenant — which production
    // is — that sentence was the ONLY thing the restoration ever rendered, and its second clause told an
    // administrator nothing was hidden at the exact moment the most-hidden thing was hidden. An absent
    // box asserts nothing; a sentence asserting completeness that is false is worse than the gap it
    // fills. The replacement states the predicate of the two reads and stops there.
    for (const loc of LOCALES) {
      const messages = (await import(`../messages/${loc}.json`)).default as Record<string, unknown>;
      const ns = (messages.admin as Record<string, Record<string, string>>).leaveConfigApprovalChains;
      expect(
        /everything that routes|semua yang menghalakan|已全部显示|அனைத்தும் மேலே|ทุกสิ่งที่กำหนดเส้นทาง|tất cả những gì định tuyến/.test(
          ns.scopesEmpty,
        ),
        `${loc}.scopesEmpty still claims that everything routing a request is shown`,
      ).toBe(false);
    }
    // …and it names the three columns whose absence it is actually reporting, in English at least.
    const en = (await import('../messages/en.json')).default as Record<string, unknown>;
    const ns = (en.admin as Record<string, Record<string, string>>).leaveConfigApprovalChains;
    for (const word of ['business unit', 'department', 'position']) {
      expect(ns.scopesEmpty.toLowerCase(), `en.scopesEmpty does not mention ${word}`).toContain(word);
    }
  });

  it('reuses the existing approval vocabulary rather than duplicating it in a new namespace', async () => {
    // The seven approver-role labels, the six scope dimensions and the day bounds already ship in all
    // six locales under `leaveApproval`. A second copy of any of them is a translation that can drift.
    const en = (await import('../messages/en.json')).default as Record<string, unknown>;
    const la = en.leaveApproval as Record<string, string>;
    for (const k of [
      'manager',
      'departmentHead',
      'businessUnitHead',
      'hr',
      'hrManager',
      'payroll',
      'customRole',
      'businessUnit',
      'department',
      'position',
      'jobGrade',
      'gradeGroup',
      'employmentType',
      'minDays',
      'maxDays',
      'anyScope',
      'chain',
      'company',
      'ruleName',
      'leaveType',
      'emptyScope',
      'escalationNextLevel',
    ]) {
      expect(typeof la[k], `leaveApproval.${k}`).toBe('string');
      expect(readoutCode.includes(`tr('${k}'`), `${k} was duplicated into the new namespace`).toBe(false);
    }
  });
});
