/**
 * 296fc027 — Replacement Leave becomes the CONFIGURATION home. (Renamed from
 * test/leave-replacement-placeholder.test.ts, which is why this header starts by explaining what it used
 * to assert.)
 *
 * THIS FILE IS A REWRITE, NOT A DELETION, AND THE DISTINCTION MATTERS. Its previous incarnation pinned
 * app/admin/leave/replacement/page.tsx as a deliberate PLACEHOLDER — no form, no server action, no data
 * access — because 645e67c4's expected_behavior said in terms that no functional components were required
 * at that stage. That was a real decision and the assertions existed to stop it eroding silently. 296fc027
 * is the ticket that reverses it on purpose, so the assertions are reversed on purpose too, in the same
 * commit, rather than being quietly dropped and rediscovered later as an unexplained gap in coverage.
 *
 * TWO of the three original guarantees SURVIVE VERBATIM and are still asserted below:
 *   1. the page stays GUARDED and registered — an empty page was not an excuse to skip the guard, and a
 *      full one certainly is not;
 *   2. its copy still tells the truth about what already exists elsewhere — the page must not read as
 *      though replacement leave were newly invented here, because the engine, the ledger and the two
 *      statutory sweeps are all live and some of them are one screen away.
 * Only guarantee 3 ("it stays a placeholder") is inverted, and it is inverted into its exact opposite: the
 * page must NOW carry the policy form, or the move did not happen.
 *
 * THE OTHER HALF OF THE MOVE IS ASSERTED HERE TOO, and it is the half most likely to be undone by accident:
 * app/admin/toil/page.tsx must KEEP the balance ledger and the two settle-and-expire sweeps, and must keep
 * the WIND-DOWN ARGUMENT that explains why those two are deliberately not entitlement-gated. Somebody
 * tidying up "the page that lost its form" is exactly who would delete that paragraph, and the consequence
 * — a tenant whose module lapses being unable to settle a statutory convert-to-pay obligation it already
 * owes — is invisible until it is a legal problem.
 *
 * Static source assertions rather than a render: this repo's page-level coverage is source scanning (see
 * test/server-client-boundary.test.ts's header for why that is the cheapest thing that can see these
 * classes of defect at all). The BEHAVIOUR of the settings is tested against the database in
 * test/replacement-leave-controls.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { leavePack } from '../packs/leave';

import { REGISTERED_ROUTES } from '../lib/permissions';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. 296fc027's screen was ABSORBED: a replacement
 * leave policy is a COMPANY rule, not a property of a leave type, so it now shares Company rules
 * (`/admin/leave-config/company-rules`) with the half-day deduction, the encashment policy and the
 * shared leave groups (IA §2.0.3). `/admin/leave/replacement` is a redirect stub. Every property this
 * file guards — the four policy controls, the eligibility criteria, the company filter that must not
 * touch the global scope cookie — is about the EDITOR, not the address, so it follows the editor.
 */
const PAGE_REL = 'app/admin/leave-config/company-rules/page.tsx';
const TOIL_REL = 'app/admin/toil/page.tsx';
const PICKER_REL = 'components/replacement-eligibility-picker.tsx';
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

type Dict = Record<string, unknown>;
const load = (loc: string): Dict => JSON.parse(read(`messages/${loc}.json`));
const getPath = (obj: Dict, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

describe('296fc027 · Replacement Leave configuration page', () => {
  // ── The two guarantees carried over from the placeholder test ──────────────────────────────────────
  it('is still guarded by requireAdmin and still registered in the permission map', () => {
    expect(read(PAGE_REL)).toContain('requireAdmin()');
    expect(REGISTERED_ROUTES.has('/admin/leave-config/company-rules')).toBe(true);
    // The old address is a stub with no guard, which is why it left the registry with its page.
    expect(REGISTERED_ROUTES.has('/admin/leave/replacement')).toBe(false);
    const stub = read('app/admin/leave/replacement/page.tsx');
    expect(stub).toContain('redirect(');
    expect(stub).toContain('/admin/leave-config/company-rules');
  });

  it('BOTH routes stay registered — the move split one screen in two, it did not retire either', () => {
    // 296fc027 split CONFIGURATION from the ledger + settlement sweeps and gated them differently on
    // purpose. a6fe37fc moved the configuration half again, to Company rules; /admin/toil is untouched
    // and must stay reachable when the `toil` entitlement lapses.
    expect(REGISTERED_ROUTES.has('/admin/leave-config/company-rules')).toBe(true);
    expect(REGISTERED_ROUTES.has('/admin/toil')).toBe(true);
  });

  it('the leave fly-out still carries the replacement entry, after Payroll Related', () => {
    // 645e67c4 — this asserted against components/leave-tabs.tsx, now deleted: Leave config is a sidebar
    // fly-out. The ORDER the reporter sees is unchanged and is still worth guarding, so the same promise
    // is re-made against the pack node that actually renders it.
    const node = leavePack.navNodes!.find((n) => n.group === 'admin')!;
    const hrefs = node.children.map((c) => c.href);
    // a6fe37fc Round 5 — the ROW is now Company rules, the screen that absorbed this one, and it keeps
    // the position the reporter's team reads. The order promise is what was made and it is unchanged.
    expect(hrefs).toContain('/admin/leave-config/company-rules');
    const at = (href: string) => hrefs.indexOf(href);
    // a6fe37fc Round 5 — the Payroll Related row this position was measured against is GONE (its two
    // settings were never one subject and went to two different destinations). Measuring against a row
    // that no longer exists would make this pass on `> -1` forever, so the anchor moves to the row that
    // is now directly above: Approval chains. The promise — Company rules sits at the END of the leave
    // config menu, where Replacement Leave was put — is what is asserted, and it is asserted twice.
    expect(at('/admin/leave-config/company-rules')).toBeGreaterThan(at('/admin/leave-config/approval-chains'));
    // 5ca446db (r269) — UPDATED, NOT LOOSENED. `toBe(hrefs.length - 1)` stood here and meant "Company rules
    // is the END of the leave CONFIG menu, where Replacement Leave was put". A sixth child was added after
    // it by a later, unrelated item — Employee Leave Inquiry, whose destination (/leave/employee-balances)
    // is not a Leave Config screen at all — so the count-based spelling stopped expressing the promise. The
    // promise itself is unchanged and is restated exactly: Company rules is the LAST of the rows that open
    // a Leave Config screen. A new /admin/leave-config/* row placed after it still fails here.
    const configHrefs = hrefs.filter((h) => h.startsWith('/admin/leave-config/'));
    expect(configHrefs.at(-1)).toBe('/admin/leave-config/company-rules');
    // …and nothing but the named inquiry row sits outside that set, so the filter cannot hide a regression.
    expect(hrefs.filter((h) => !h.startsWith('/admin/leave-config/'))).toEqual(['/leave/employee-balances']);
    // f1b994e3 — `expect(at('/admin/leave/audit')).toBeGreaterThan(at('/admin/leave/replacement'))`
    // STOOD HERE. The Audit row is retired into the one central Audit Trail, so there is no longer an
    // entry after Replacement for it to sit before; the position this item actually promised (after
    // Payroll Related) is asserted above and is unchanged. test/leave-flyout-nav.test.ts owns the
    // retirement itself, including that the route still resolves as a stub.
  });

  it('the page no longer marks itself as an active tab — there is no strip to be active in', () => {
    expect(read(PAGE_REL)).not.toContain('LeaveTabs');
  });

  // ── The guarantee that INVERTS: it is no longer a placeholder ──────────────────────────────────────
  it('is NO LONGER a placeholder — it carries the policy form and posts to setToilPolicyAction', () => {
    const src = read(PAGE_REL);
    expect(src).toContain('<form action={setToilPolicyAction}');
    expect(src).toContain('listToilPolicies');
  });

  it('carries every one of the four new settings the request names', () => {
    const src = read(PAGE_REL);
    // The employee-request switch.
    expect(src).toContain('name="employeeRequestEnabled"');
    // The expiry period as a number PLUS a unit — all three fields must post, or a saved months policy
    // would silently lose its day count (see the two-column note in migration 0380).
    expect(src).toContain('name="expiryUnit"');
    expect(src).toContain('name="expiryDays"');
    expect(src).toContain('name="expiryMonths"');
    // Replacement Leave From, with its three values.
    expect(src).toContain('name="replacementLeaveFrom"');
    for (const v of ['working_hours', 'overtime', 'working_hours_and_overtime']) {
      expect(src).toContain(`value="${v}"`);
    }
    // The eligibility picker.
    expect(src).toContain('<ReplacementEligibilityPicker');
  });

  // ⚠️ 3fb1a611 (r279) INVERTED THIS TEST, and the inversion is the point of the item. It used to assert
  // that the page ADMITS Replacement Leave From is recorded only — true when written (nothing read the
  // column; the gate was the hard-coded RL_ELIGIBLE_DAY_TYPES in core/toil.ts) and the honest thing to
  // print. The setting is now enforced, so the same screen printing "changes nothing today" would be the
  // lie the original note existed to avoid. What replaces it is stronger than "no longer says recorded
  // only": the note must state the one consequence that costs money.
  it('SAYS ON SCREEN what Replacement Leave From now does — including that banking a day stops its overtime pay', () => {
    const src = read(PAGE_REL);
    expect(src).toContain("tr('leaveFromEnforced')");
    expect(src, 'the superseded note must not be rendered anywhere').not.toContain("tr('leaveFromRecordedOnly')");
    const note = String(getPath(load('en'), 'admin.replacementLeave.leaveFromEnforced'));
    expect(note, 'it must say which days it decides').toMatch(/which worked days/i);
    // The money sentence. Choosing "Working hours plus overtime" admits an ordinary working day, and a
    // banked day is struck out of the overtime prefill — the admin has to be told before they choose.
    expect(note).toMatch(/stops being paid as overtime/i);
  });

  // 1cf5b37c INVERTED THIS TEST, and the inversion is the item. It used to assert that every control
  // was disabled and no Save rendered without the add-on — which is exactly what made the reporter read
  // a finished screen as an unfinished placeholder. The screen is now always editable for an admin.
  //
  // What must NOT change is that the entitlement still decides whether anything is BANKED, so the two
  // halves are asserted separately: the page no longer disables anything, and the accrual gate is still
  // read (and still enforced inside core/toil.ts, covered by the behavioural tests in this file).
  it('is EDITABLE for an admin even when the add-on is not switched on', () => {
    const src = read(PAGE_REL);
    expect(src, 'the entitlement is still read, for the banner').toContain('isModuleEnabledOrFalse');
    expect(src, 'no control may be disabled by the entitlement any more').not.toContain('disabled={!');
    expect(src, 'Save renders unconditionally').not.toContain('&& <button className={btnPrimary}>');
  });

  it('still tells the admin that nothing accrues until the add-on is on', () => {
    const src = read(PAGE_REL);
    expect(src).toContain("{!accrualLive && (");
    const banner = String(getPath(load('en'), 'admin.replacementLeave.moduleOff'));
    // The old wording claimed the settings "cannot be changed". That is now false, and a banner that
    // contradicts the screen is worse than no banner.
    expect(banner).not.toMatch(/cannot be changed/i);
    expect(banner).toMatch(/not part of this account's plan/i);
  });

  it('no longer cross-links to the legacy Time Off In Lieu page', () => {
    const src = read(PAGE_REL);
    // The reporter asked for this submenu to be self-contained. The link the OTHER way still exists and
    // is asserted below — removing it would strand an admin on the legacy page.
    expect(src).not.toContain('href="/admin/toil"');
  });

  // ── The half of the move that is easiest to undo by accident ───────────────────────────────────────
  it('the Time Off In Lieu page KEEPS the ledger and both settlement sweeps', () => {
    const src = read(TOIL_REL);
    expect(src).toContain('replacementLeaveSummary');
    expect(src).toContain('runToilExpiryAction');
    expect(src).toContain('closeReplacementLeaveYearAction');
  });

  it('the Time Off In Lieu page NO LONGER carries the policy editor', () => {
    const src = read(TOIL_REL);
    expect(src).not.toContain('setToilPolicyAction');
    expect(src).not.toContain('name="accrualBasis"');
    expect(src).not.toContain('name="allowFirstScheduleEligible"');
  });

  it('the WIND-DOWN ARGUMENT survives intact on the Time Off In Lieu page', () => {
    // The two sweeps are deliberately NOT entitlement-gated: a lapsed module must not strand a settlement
    // the employer already owes, and for a First-Schedule-eligible employee that debt is statutory. The
    // page is their only caller (there is no cron), so if this reasoning is deleted the next editor has
    // no way to know that re-gating the UI silently re-gates the obligation.
    const src = read(TOIL_REL);
    expect(src).toMatch(/wind-down|wind down/i);
    expect(src).toMatch(/statutory/i);
    expect(src).toMatch(/not entitlement-gated/i);
    // showSettlement is the mechanism: an outstanding liability keeps the settlement card reachable even
    // with the module off.
    expect(src).toContain('const showSettlement = moduleOn || outstanding');
  });

  // 1cf5b37c MADE THIS ONE-DIRECTIONAL, deliberately. The reporter asked for the Leave Config submenu
  // to be self-contained and told us to leave the legacy module alone, so the link from the new screen
  // to /admin/toil is gone. The link the other way MUST survive: an admin who lands on the legacy page
  // still has to be told where configuration went, which is the half that stops a move reading as a
  // deletion. Asserting the removal here as well as in the 1cf5b37c block above is deliberate — this is
  // the test that would otherwise be "fixed" by putting the link back.
  it('the legacy page still links HERE, and this page no longer links back', () => {
    // The link moved WITH the screen (a6fe37fc Round 5). Left at the old address it would still arrive,
    // through the stub — but a link whose whole job is to say "configuration is over there" should name
    // where it actually is.
    expect(read(TOIL_REL)).toContain('href="/admin/leave-config/company-rules"');
    expect(read(PAGE_REL)).not.toContain('href="/admin/toil"');
  });

  // ── 20e759a0 · the company filter's two easiest mistakes ───────────────────────────────────────────
  // The filter's BEHAVIOUR is tested for real in test/replacement-leave-controls.test.ts (the resolver
  // and the save round-trip). These two are source assertions because what they guard is a swap a tidy-up
  // would make on sight, and neither swap changes a type, breaks a build, or fails any behavioural test.
  it('narrows this page WITHOUT touching the global company-scope cookie', () => {
    const src = read(PAGE_REL);
    // The selection is a URL parameter. `getScopeIds` is still read — it stays the OUTER bound — but the
    // page must never WRITE `company_scope`, which would silently re-scope Roster, Payroll and the rest.
    expect(src).toContain('resolveCompanyFilter');
    expect(src, 'the global scope is still the outer bound').toContain('getScopeIds');
    // Matched against CODE with comments stripped, for the same reason the `.raw` test below does it: the
    // page explains this trap in a comment that NAMES the cookie, and a naive negative match would force
    // the next author to delete the warning to make the test pass — precisely backwards.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code, 'writing the global scope cookie from this page re-scopes every other screen').not.toContain(
      'company_scope',
    );
  });

  it('the companyIds ELIGIBILITY criterion still offers the FULL in-scope list, not the filtered one', () => {
    // "Who may SUBMIT a request" is a different question from "which company am I configuring". Narrowing
    // this one with the page filter would delete the ability to name another in-scope company as eligible
    // — and, because the picker posts what it holds, would drop it from the criterion on the next save.
    const src = read(PAGE_REL);
    const opts = src.slice(src.indexOf('const eligibilityOptions'));
    const companyLine = opts.slice(opts.indexOf('companyIds:'), opts.indexOf('employmentTypes:'));
    expect(companyLine).toContain('visible.map(');
    expect(companyLine, 'the page-level filter must not narrow who may submit').not.toContain('shown.map(');
  });

  // ── The boundary that took a page down three rounds ago ────────────────────────────────────────────
  it('the eligibility picker receives only SERIALISABLE props from the server page', () => {
    // test/server-client-boundary.test.ts is the general guard; this is the specific one, because this is
    // the newest server→client hand-off in the tree and the failure mode (a `t` closure) throws at RENDER
    // where neither tsc nor next build nor any other test can see it.
    const page = read(PAGE_REL);
    const jsx = page.slice(page.indexOf('<ReplacementEligibilityPicker'));
    const el = jsx.slice(0, jsx.indexOf('/>') + 2);
    expect(el).not.toMatch(/=\{\s*\(/); // no arrow-function prop
    expect(el).not.toMatch(/=\{\s*function/);
    expect(el).not.toContain('={tr}');
    expect(el).not.toContain('={t}');
    // And the picker must not import the leave-pack boundary module into the client bundle — the
    // descriptor is handed to it as data instead (drizzle in a client bundle, plus ADR-0080 drift).
    expect(read(PICKER_REL)).not.toContain("from '@/core/replacement-eligibility'");
  });

  // ── Copy ───────────────────────────────────────────────────────────────────────────────────────────
  it('every locale has the configuration screen strings', () => {
    const keys = [
      // 645e67c4 — moved out of admin.leaveTabs with the strip's retirement.
      'nav.leaveReplacement',
      'admin.replacementLeave.enabledLabel',
      'admin.replacementLeave.employeeRequestLabel',
      'admin.replacementLeave.employeeRequestHint',
      'admin.replacementLeave.eligibilityTitle',
      'admin.replacementLeave.eligibilityHint',
      'admin.replacementLeave.expiryTitle',
      'admin.replacementLeave.expiryUnitDays',
      'admin.replacementLeave.expiryUnitMonths',
      'admin.replacementLeave.expiryHint',
      'admin.replacementLeave.leaveFrom',
      // 3fb1a611: leaveFromRecordedOnly is superseded by leaveFromEnforced (see the inverted test above).
      'admin.replacementLeave.leaveFromEnforced',
      // 1cf5b37c — ledgerMovedNote / ledgerMovedLink are GONE. They keyed the cross-link from this
      // screen to the legacy /admin/toil page, and the reporter asked for this submenu to be
      // self-contained. The link on /admin/toil pointing HERE stays (admin.toilPolicy.configMoved*
      // below), because an admin who lands on the legacy page still needs to be told where
      // configuration went — the removal was one-directional on purpose.
      'admin.replacementLeave.pickerSearch',
      'admin.replacementLeave.pickerSelectAll',
      'admin.replacementLeave.pickerClearAll',
      'admin.replacementLeave.critCompany',
      'admin.replacementLeave.critEmploymentType',
      'admin.replacementLeave.critDepartment',
      'admin.replacementLeave.critDivision',
      'admin.replacementLeave.critPosition',
      'admin.replacementLeave.critGrade',
      'admin.replacementLeave.critEmployeeCategory',
      'admin.replacementLeave.critEmployee',
      'admin.toilPolicy.configMovedTitle',
      'admin.toilPolicy.configMovedHint',
      'admin.toilPolicy.configMovedLink',
    ];
    const missing: string[] = [];
    for (const loc of LOCALES) {
      const d = load(loc);
      for (const k of keys) {
        const v = getPath(d, k);
        if (typeof v !== 'string' || v.trim() === '') missing.push(`${loc}:${k}`);
      }
    }
    expect(missing, `blank or absent: ${missing.join(', ')}`).toEqual([]);
  });

  it('the employee-request switch copy states the OFF behaviour, which is the enforced one', () => {
    // "When this is off, employees do not see the button AND cannot submit" is a promise about the
    // SERVER, not the UI. If the copy weakens to "the button is hidden", the guarantee has drifted.
    const hint = String(getPath(load('en'), 'admin.replacementLeave.employeeRequestHint'));
    expect(hint).toMatch(/cannot submit/i);
  });

  it('the picker count template keeps its placeholder — the client substitutes the live count', () => {
    // Resolved server-side to a plain string, so the placeholder must survive translation or the count
    // silently renders as literal text.
    for (const loc of LOCALES) {
      expect(String(getPath(load(loc), 'admin.replacementLeave.pickerSelectedCount'))).toContain('{count}');
    }
  });

  it('the count template is read with .raw — plain t() THROWS on the unprovided ICU variable', () => {
    // A regression this suite could not otherwise see, and render-verify only caught because the dev log
    // was read: next-intl refuses to format a message whose `{count}` was not supplied, so
    // `tr('pickerSelectedCount')` throws FORMATTING_ERROR at render while the page still returns 200.
    // The template is being handed to a client component that substitutes the count itself, so `.raw` is
    // the only correct read. Pinned by name so an "unnecessary .raw" cleanup fails here instead of in
    // production.
    // Matched against CODE with comments stripped. The page explains this trap in a comment that names
    // `tr('pickerSelectedCount')` as the wrong call — a naive negative match hits that prose and forces
    // the next author to delete the warning to make the test pass, which is precisely backwards.
    const code = read(PAGE_REL).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain("tr.raw('pickerSelectedCount')");
    expect(code, 'the plain t() form throws FORMATTING_ERROR at render').not.toMatch(
      /[^.]\btr\('pickerSelectedCount'\)/,
    );
  });
});
