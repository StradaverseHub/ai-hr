/**
 * 3fb1a611 (r299) · LEAVE CREDIT — THE SCREENS, THE MENU AND THE GATE.
 *
 * Source-shape and registry assertions (the house idiom for page structure; the engine is tested against the
 * database in the other r299 files), plus one resolver check of the menu gate against a real entitlement
 * snapshot. What is pinned, each a promise in the approved plan:
 *   · Leave Config › Leave Credit exists as a row after Leave Adjustments, with Credits and Rules tabs, both
 *     guarded, both registered, and the row hidden unless the tenant has the `toil` module;
 *   · without the module the pages show a notice — except the Credits tab's wind-down view, which keeps the
 *     settlement sweeps reachable while credits are outstanding;
 *   · Company rules no longer renders the replacement-leave policy (moved, not re-gated);
 *   · /admin/toil redirects to Leave Credit, forwarding its query;
 *   · Leave Adjustments leaves Replacement Leave out and points to Leave Credit;
 *   · My Leave: the request is a Leave Credit request that names the day kind, and the Apply form shows
 *     Expiring soon.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, entitledCtx, migrateTestDb, resetDb, seedBase, setModule, type Base } from './harness';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';
import { MODULE_CODES_WITH_NAV, visibleModuleCodes } from '../lib/nav-entitlements';
import { leavePack } from '../packs/leave';
import { attendancePack } from '../packs/attendance';
import { LEAVE_CONFIG_MAP } from '../components/leave-config-map';
import en from '../messages/en.json';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');

const CREDITS = 'app/admin/leave-config/leave-credit/page.tsx';
const RULES = 'app/admin/leave-config/leave-credit/rules/page.tsx';
const RULES_TAB = 'app/admin/leave-config/leave-credit/rules-tab.tsx';
const COMPANY_RULES = 'app/admin/leave-config/company-rules/page.tsx';

describe('Leave Config › Leave Credit — the row, the tabs, the registry', () => {
  const node = leavePack.navNodes!.find((n) => n.group === 'admin')!;

  it('is a row directly after Leave Adjustments, owning its Rules tab', () => {
    const labels = node.children.map((c) => c.labelKey);
    expect(labels[labels.indexOf('leaveAdjustments') + 1]).toBe('leaveCredit');
    const row = node.children.find((c) => c.labelKey === 'leaveCredit')!;
    expect(row.href).toBe('/admin/leave-config/leave-credit');
    expect(row.ownedSubpaths).toEqual(['/admin/leave-config/leave-credit/rules']);
    expect(en.nav.leaveCredit).toBe('Leave Credit');
    const group = LEAVE_CONFIG_MAP.find((g) => g.id === 'leaveCredit')!;
    expect(group.items.map((i) => i.href)).toEqual(['/admin/leave-config/leave-credit', '/admin/leave-config/leave-credit/rules']);
  });

  it('both tabs are guarded pages on the leaveConfig column; the retired toilPolicy column is gone', () => {
    for (const rel of [CREDITS, RULES]) expect(read(rel)).toContain('await requireAdmin()');
    const leaveConfig = SCREENS.find((s) => s.screenKey === 'leaveConfig')!;
    expect(leaveConfig.routes).toContain('/admin/leave-config/leave-credit');
    expect(leaveConfig.routes).toContain('/admin/leave-config/leave-credit/rules');
    expect(SCREENS.find((s) => s.screenKey === 'toilPolicy')).toBeUndefined();
    expect(REGISTERED_ROUTES.has('/admin/toil')).toBe(false);
  });
});

describe('The menu row is gated on the toil module', () => {
  let b: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  afterAll(async () => {
    await closeAll();
  });
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
  });

  it('the sidebar maps the Leave Credit row to `toil`, and the resolver offers toil only when the tenant has it', async () => {
    expect(MODULE_CODES_WITH_NAV).toContain('toil');
    // The sidebar picks the row out of the leave pack by label key (no href is hardcoded there).
    const sidebar = code(read('components/sidebar.tsx'));
    expect(sidebar).toContain("n.children.filter((c) => c.labelKey === 'leaveCredit').map((c) => [c.href, 'toil'] as const)");

    const off = await entitledCtx(b);
    expect(visibleModuleCodes(off), 'no toil row → the Leave Credit row is hidden').not.toContain('toil');
    await setModule(b.tenantId, 'toil', 'active');
    const on = await entitledCtx(b);
    expect(visibleModuleCodes(on), 'with toil the row is offered').toContain('toil');
  });

  it('/admin/toil has no menu row any more (its attendance row left with the page)', () => {
    const hrefs = [
      ...(attendancePack.navNodes ?? []).flatMap((n) => n.children.map((c) => c.href)),
      ...(attendancePack.navLinks ?? []).map((l) => l.href),
    ];
    expect(hrefs).not.toContain('/admin/toil');
  });
});

describe('The pages gate on the module — with the wind-down exception on Credits', () => {
  it('Credits: notice without the module unless credits are outstanding; Add only with the module', () => {
    const src = read(CREDITS);
    expect(src).toContain("const moduleOn = isModuleEnabledOrFalse(s, 'toil');");
    expect(src).toContain('const windDown = !moduleOn && summary.activeAccruals > 0;');
    expect(src).toContain('const showCredits = moduleOn || windDown;');
    expect(src).toMatch(/\{!showCredits \? \(\s*<Card className="p-4" data-testid="leave-credit-module-off">/);
    // + Add Leave Credit is offered only with the module (the service refuses without it regardless).
    expect(src).toMatch(/actions=\{\s*moduleOn \? \(\s*<LeaveCreditAddDialog/);
    // The sweeps are on this tab, NOT behind the module.
    expect(src).toContain('<form action={runToilExpiryAction}>');
    expect(src).toContain('<form action={closeReplacementLeaveYearAction}>');
  });

  it('Rules: the policy form only with the module', () => {
    const src = read(RULES);
    expect(src).toContain("const moduleOn = isModuleEnabledOrFalse(s, 'toil');");
    expect(src).toMatch(/\{moduleOn \? \(\s*<LeaveCreditRulesTab/);
    expect(read(RULES_TAB)).toContain('<form action={setToilPolicyAction}');
  });
});

describe('Company rules no longer renders the toil policy form', () => {
  it('no form, no picker, no policy read, no company filter, no gate left behind', () => {
    const src = read(COMPANY_RULES);
    for (const needle of [
      'setToilPolicyAction',
      '<ReplacementEligibilityPicker',
      'listToilPolicies',
      'isModuleEnabledOrFalse',
      '<CompanyFilterSelect',
      "tr('footnote')",
    ]) {
      expect(code(src), needle).not.toContain(needle);
    }
    // The encashment policy, which the reporter did not ask to move, stays.
    expect(src).toContain('<form action={setLeaveEncashmentPolicyAction}');
  });
});

describe('/admin/toil redirects to Leave Credit', () => {
  it('is an unguarded stub that forwards its query string', () => {
    const src = read('app/admin/toil/page.tsx');
    expect(src).toContain("redirect(`/admin/leave-config/leave-credit${qs ? `?${qs}` : ''}`)");
    expect(src).toMatch(/for \(const \[k, v\] of Object\.entries\(sp\)\)/);
    expect(/requireAdmin|scopedAdmin|scopedSession/.test(code(src))).toBe(false);
    // The two sweep actions return to Leave Credit, not to the stub.
    expect(read('app/admin/actions.ts')).toContain("const TOIL_POLICY = '/admin/leave-config/leave-credit';");
  });
});

describe('Leave Adjustments points Replacement Leave at Leave Credit', () => {
  it('the picker leaves the replacement type out, and a note links to Leave Credit', () => {
    const src = read('app/admin/leave-config/adjustments/page.tsx');
    // 3fb1a611 fix pass (D3) — UPDATED, NOT LOOSENED: both halves now apply only while the tenant has Leave
    // Credit (the page's quiet read of `toil`); without it the picker and the page are main's. Rendered on
    // both arms in test/r299-leave-credit-deploy-day.test.ts.
    expect(src).toContain("const leaveCreditLive = isModuleEnabledOrFalse(s, 'toil');");
    expect(src).toContain('const leftToLeaveCredit = (x: (typeof types)[number]) => leaveCreditLive && isReplacementLeaveType(x);');
    expect(src).toContain('const hasReplacementType = types.some(leftToLeaveCredit);');
    expect(src).toContain('leaveTypes={types.filter((x) => !leftToLeaveCredit(x)).map(');
    expect(src).toContain("href={leaveConfigScreenHref('leaveCredit')}");
    expect(en.admin.leave.adjustmentsReplacementNote).toMatch(/not adjusted here/);
  });
});

describe('My Leave — the Leave Credit request and the Apply form', () => {
  it('the request is presented as a Leave Credit request, names each date’s kind, and states the rule', () => {
    expect(en.replacementRequest.trigger).toBe('+ Leave Credit request');
    expect(en.replacementRequest.title).toBe('Leave Credit request');
    const dialog = read('components/leave/replacement-leave-request-dialog.tsx');
    expect(dialog).toContain("t('eligibleDaysNote')");
    expect(dialog).toContain("t('workingDayRefused')");
    expect(read('app/leave/page.tsx')).toContain('dayKindAction={leaveCreditDayKindAction}');
  });

  it('the Apply summary renders Expiring soon when (and only when) the figure is a number', () => {
    const fields = read('components/leave-duration-fields.tsx');
    expect(fields).toContain("{summary.expiringSoon != null && (");
    expect(fields).toContain("t('breakdown.field.expiringSoon')");
    expect(en.leave.breakdown.field.expiringSoon).toBe('Expiring soon');
  });
});
