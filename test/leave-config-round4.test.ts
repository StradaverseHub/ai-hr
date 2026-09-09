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
/** The old screen, which this round must leave standing. Read, never written. */
const oldApproval = read('app/admin/leave/approval/page.tsx');
const policySrc = read('core/leave-approval-policy.ts');
const consolidationSrc = read('core/leave-approval-consolidation.ts');

/**
 * COMMENTS ARE NOT CODE — the r134 rule. An honest header NAMES what it is not doing ("no form, no
 * action"), so an absence assertion over the raw file would report correct code as wrong.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');
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
    // …and the menu has NOT moved: the old screen is still what leaveApproval points at.
    expect(leaveApproval.href).toBe('/admin/leave/approval');
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
    expect(pageCode).toContain('loadUntemplatedApprovalRules(s, companies)');
    expect(
      /loadUntemplatedApprovalRules\(s,\s*all\)/.test(pageCode),
      'the read-only rule list is fed the UNTRIMMED company list — a company-scoped admin would see ' +
        'approval rules belonging to companies they do not manage',
    ).toBe(false);
    // …and the loader itself scopes by the list it is given rather than trusting the read.
    expect(readoutCode).toContain('legacy.filter((r) => r.templateId === null && companyName.has(r.companyId))');
  });

  it('is NOT on the leave config map — the menu moves at the Round 5 cutover, not now', () => {
    const hrefs = LEAVE_CONFIG_MAP.flatMap((g) => g.items).map((i) => i.href);
    expect(hrefs).not.toContain(ROUTE);
    // …and the old screen is still the one the map names.
    expect(hrefs).toContain('/admin/leave/approval');
    expect(leaveConfigScreenHref('approvalChain')).toBe('/admin/leave/approval');
  });

  it('renders the area map and the preview note, like every other screen in the module', () => {
    // Without the map a leave-config screen can reach no other leave-config screen at all (r258).
    expect(page).toContain('<LeaveConfigMap current="approvalChain" />');
    // This screen SAVES — and every approval action redirects to `/admin/leave/approval`, so a save made
    // here navigates to the old screen. The note is what makes that a known window rather than a bug.
    expect(page).toContain('<LeaveConfigPreviewNote />');
    expect(read('app/admin/leave-approval/actions.ts')).toContain(
      "const PAGE = '/admin/leave/approval';",
    );
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
    // Round 2's rule 2, still in force: every save goes through an action that already exists, with its
    // signature unchanged, which is what keeps the OLD screen working while both are live.
    expect(page.includes("'use server'"), `${NEW_PAGE} must not declare server actions`).toBe(false);
    const actions = read('app/admin/leave-approval/actions.ts');
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

describe('a6fe37fc R4 · the rules NOT built from a template get a surface back (IA §4.1)', () => {
  it('the list is on the page, and it shows the three scope columns that have been invisible', () => {
    expect(page).toContain('<UntemplatedApprovalRules rows={untemplated} />');
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
  });

  it('enumerates through the ONE legacy enumeration, and queries nothing itself', () => {
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

  it('shows only the rows NO surface can show — a templated wildcard rule is NOT listed twice', () => {
    // `listLegacyApprovalRules` returns two kinds: `no-template` and `any-leave-type`. A row WITH a
    // template but a null leave type is already on screen — `listTemplateAssignments` returns every
    // active row that carries a template, including those, and the assignment list groups them with
    // `firstLeaveTypeId === null`. Listing them again here would be the duplication 706d34e8 removed.
    expect(readoutCode).toContain('r.templateId === null');
    expect(read('core/leave-approval-template.ts')).toContain(
      'sql`${leaveApprovalPolicy.templateId} is not null`',
    );
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

describe('a6fe37fc R4 · this round adds and removes NOTHING', () => {
  it.each([
    ['the template manager', '<ApprovalTemplateManager'],
    ['the assignment manager', '<ApprovalAssignmentManager'],
    ['the escalation editor', '<LeaveEscalationEditor'],
    ['the area map', '<LeaveConfigMap current="approvalChain" />'],
  ])('%s is still live on the old approval screen', (_what, needle) => {
    expect(oldApproval).toContain(needle);
  });

  it('the old page is untouched by this round — still a full screen, not a stub', () => {
    expect(oldApproval.includes('redirect('), 'the old approval page became a stub — that is Round 5').toBe(
      false,
    );
    expect(oldApproval.length).toBeGreaterThan(500);
    // And its nav entry is still the one the customer clicks.
    expect(read('packs/leave/index.ts')).toContain("href: '/admin/leave/approval'");
  });

  it('the old screen does NOT gain the read-out — the restoration lands at the new address only', () => {
    // Adding it to both would put two copies of the same table in front of the administrator during the
    // Rounds 4–5 window, which is the "two entries for one job" the map exemption exists to avoid.
    expect(oldApproval).not.toContain('UntemplatedApprovalRules');
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
    'untemplatedTitle',
    'untemplatedHint',
    'untemplatedReadOnly',
    'untemplatedEmpty',
    'colScope',
    'scopeAllEmployees',
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
    expect(ns.otherRules, `${loc}.otherRules`).toMatch(/\{n,\s*plural,/);
    expect(ns.otherRules).toContain('other {');
    expect(ns.otherRules).toContain('#');
    expect(ns.escalationOn, `${loc}.escalationOn`).toMatch(/\{days,\s*plural,/);
    expect(ns.escalationOn).toContain('{target}');
    expect(ns.sourceTemplate, `${loc}.sourceTemplate`).toContain('{name}');
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
