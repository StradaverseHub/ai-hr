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
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. 296fc027's screen was ABSORBED into Company rules.
 *
 * 3fb1a611 (r299) — RE-POINTED AGAIN, NOT DELETED, and both halves of 296fc027's split moved:
 *   · the EDITOR left Company rules entirely for Leave Config › Leave Credit's Rules tab
 *     (`app/admin/leave-config/leave-credit/rules-tab.tsx`, mounted by that page) — PAGE_REL below;
 *   · the LEDGER summary and the two settlement sweeps left /admin/toil (a redirect stub now) for the same
 *     page's Credits tab — CREDIT_PAGE_REL below, which is also where the guard, the gate and the WIND-DOWN
 *     argument now live.
 * Every property this file guards is about the editor or the sweeps, not the address, so it follows them.
 * What 296fc027 bought by splitting the screens — configuration gated on the module, settlement not — is
 * preserved on ONE screen: the Rules tab and Add require `toil`; the sweeps stay reachable in a wind-down view.
 */
const PAGE_REL = 'app/admin/leave-config/leave-credit/rules-tab.tsx';
const RULES_PAGE_REL = 'app/admin/leave-config/leave-credit/rules/page.tsx';
const CREDIT_PAGE_REL = 'app/admin/leave-config/leave-credit/page.tsx';
const COMPANY_RULES_REL = 'app/admin/leave-config/company-rules/page.tsx';
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
    // 3fb1a611 — the form is a component; the Rules tab's PAGE mounts it and carries the guard and the route.
    expect(read(RULES_PAGE_REL)).toContain('requireAdmin()');
    expect(read(RULES_PAGE_REL)).toContain('<LeaveCreditRulesTab');
    expect(REGISTERED_ROUTES.has('/admin/leave-config/leave-credit/rules')).toBe(true);
    expect(REGISTERED_ROUTES.has('/admin/leave-config/leave-credit')).toBe(true);
    // The old address is a stub with no guard, which is why it left the registry with its page.
    expect(REGISTERED_ROUTES.has('/admin/leave/replacement')).toBe(false);
    const stub = read('app/admin/leave/replacement/page.tsx');
    expect(stub).toContain('redirect(');
    expect(stub).toContain('/admin/leave-config/leave-credit/rules');
  });

  it('3fb1a611 — the two halves 296fc027 split are the two TABS of one row, and the split in GATING survives', () => {
    // 296fc027 split CONFIGURATION from the ledger + settlement sweeps and gated them differently on purpose.
    // 3fb1a611 puts both under Leave Credit ("one screen per fact") and keeps the difference: the Rules tab
    // draws its form only when the module is on; the Credits tab (sweeps) also opens in a wind-down view.
    expect(REGISTERED_ROUTES.has('/admin/leave-config/leave-credit')).toBe(true);
    expect(REGISTERED_ROUTES.has('/admin/leave-config/leave-credit/rules')).toBe(true);
    expect(REGISTERED_ROUTES.has('/admin/toil'), '/admin/toil is a redirect stub now').toBe(false);
    expect(read(RULES_PAGE_REL)).toContain('{moduleOn ? (');
    expect(read(CREDIT_PAGE_REL)).toContain('const windDown = !moduleOn && summary.activeAccruals > 0;');
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
    // r281 (a73d1e14) — UPDATED, NOT LOOSENED, and for the same reason r269 updated it before. "Company
    // rules is the END of the leave config menu, where Replacement Leave was put" was a spelling of a
    // POSITION; a later, unrelated item added a row below it (Special Setting, holding the half-day card
    // the reporter asked to take off Company rules), drawn at the very bottom of their sketch. What this
    // case promises is where Replacement Leave's absorbing screen sits among the rows that existed when
    // it was put there, so it is restated exactly: Company rules is the last config row of the cutover
    // set, and the only row below it is the one r281 added.
    const configHrefs = hrefs.filter((h) => h.startsWith('/admin/leave-config/'));
    expect(configHrefs.at(-1)).toBe('/admin/leave-config/special-setting');
    expect(configHrefs.at(-2)).toBe('/admin/leave-config/company-rules');
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
    expect(read(RULES_PAGE_REL)).not.toContain('LeaveTabs');
  });

  // ── The guarantee that INVERTS: it is no longer a placeholder ──────────────────────────────────────
  it('is NO LONGER a placeholder — it carries the policy form and posts to setToilPolicyAction', () => {
    const src = read(PAGE_REL);
    expect(src).toContain('<form action={setToilPolicyAction}');
    expect(src).toContain('listToilPolicies');
  });

  it('3fb1a611 — Company rules carries NONE of it any more (moved, not re-gated)', () => {
    // The setting the reporter asked to remove from Company rules (8a494721) stays removed from Company rules.
    // Checked against CODE with comments stripped: the page's header explains where the section went, by name.
    const src = read(COMPANY_RULES_REL).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toContain('setToilPolicyAction');
    expect(src).not.toContain('<ReplacementEligibilityPicker');
    expect(src).not.toContain('listToilPolicies');
    expect(src).not.toContain('accrualLive');
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
    // 3fb1a611 — Replacement Leave From is NOT on the Rules tab (see the next case for why that is safe).
    expect(src).not.toContain('name="replacementLeaveFrom"');
    // The eligibility picker.
    expect(src).toContain('<ReplacementEligibilityPicker');
  });

  // 3fb1a611 (r299) — `SAYS ON SCREEN that Replacement Leave From is recorded only` STOOD HERE. The screen said
  // so because the setting changed nothing; the approved plan (gap 6) drops the control instead of captioning
  // it. UPDATED, NOT DELETED: the property that mattered — an administrator is never misled by this setting,
  // and a stored value is never silently changed — is asserted in its new form.
  it('3fb1a611 — Replacement Leave From is off the screen, and a save no longer resets what is stored', () => {
    expect(read(PAGE_REL)).not.toContain("tr('leaveFromRecordedOnly')");
    expect(read(PAGE_REL)).not.toContain('name="replacementLeaveFrom"');
    // Absent from the form ⇒ undefined in the action ⇒ not written by setToilPolicy's upsert.
    expect(read('app/admin/actions.ts')).toContain("replacementLeaveFrom: fd.has('replacementLeaveFrom')");
    expect(read('core/toil.ts')).toContain(
      '...(p.replacementLeaveFrom !== undefined ? { replacementLeaveFrom: p.replacementLeaveFrom } : {}),',
    );
  });

  // 1cf5b37c INVERTED THIS TEST, and the inversion was the item. It used to assert that every control
  // was disabled and no Save rendered without the add-on — which is exactly what made the reporter read
  // a finished screen as an unfinished placeholder. So the screen became always editable for an admin,
  // with an amber notice above it saying the module was not on.
  //
  // ⚠️ r281 (8a494721) — INVERTED AGAIN, DELIBERATELY, AND THE GUARD IS UPDATED RATHER THAN DELETED
  // BECAUSE IT PINS A DECISION BEING REVERSED. 1cf5b37c's distinction is real — editing configuration
  // cannot bank a day — and its conclusion is what changed. The reporter took the invitation the notice
  // printed and spent several days in August filling in five scopes and six named employees against a
  // module this tenant does not have; nothing was banked and nothing could have been. A notice above a
  // live form is not a gate, it is a caption on a trap. So the section is not built at all for a tenant
  // without the module, the same way the Claims screens are not.
  //
  // THREE HALVES, ASSERTED SEPARATELY, because each can be undone on its own:
  it('r281 — the whole replacement section is gated on the entitlement, not just a banner above it', () => {
    // 3fb1a611 — RE-POINTED. The section is the Rules tab of Leave Credit now; its PAGE reads the entitlement
    // and only mounts the form when the module is on. The service refuses too (setToilPolicy is gated again).
    const page = read(RULES_PAGE_REL);
    expect(page, 'the entitlement must still be read').toContain("isModuleEnabledOrFalse(s, 'toil')");
    expect(page, 'the form is mounted only with the module').toMatch(
      /\{moduleOn \? \(\s*<LeaveCreditRulesTab/,
    );
    expect(read('core/toil.ts')).toContain("assertModuleEnabled(ctx, 'toil');");
    // Nothing is DISABLED, which is 1cf5b37c's surviving half: for the tenant that HAS the module the
    // screen is fully editable, exactly as that round made it. Gated is not disabled.
    const src = read(PAGE_REL);
    expect(src, 'no control may be disabled by the entitlement').not.toContain('disabled={!');
    expect(src, 'Save renders unconditionally within the section').not.toContain('&& <button className={btnPrimary}>');
  });

  it('r281 — the "set it up here anyway" notice is gone, and its key with it', () => {
    // The banner only ever rendered when the module was ABSENT, which is precisely when there is now
    // nothing on the page to caption; and its wording ("you can set it up here now — the settings take
    // effect as soon as the add-on is switched on") was the invitation itself. There is no reachable
    // middle state to keep it for: `isModuleEnabled` answers from the tenant's entitlement snapshot, and
    // a lapsed module is absent from it rather than present-and-expired.
    const src = read(PAGE_REL);
    expect(src).not.toContain("tr('moduleOff')");
    expect(read(COMPANY_RULES_REL)).not.toContain("tr('moduleOff')");
    for (const loc of LOCALES) {
      expect(
        getPath(load(loc), 'admin.replacementLeave.moduleOff'),
        `${loc}: the banner key must be pruned with its only reader`,
      ).toBeUndefined();
      // ⚠️ A DIFFERENT KEY WITH THE SAME LEAF NAME STAYS: /admin/toil's own notice, on the screen that
      // keeps the ledger and both settlement sweeps ungated. Deleting by leaf name would have taken it.
      expect(typeof getPath(load(loc), 'admin.toilPolicy.moduleOff'), `${loc}: /admin/toil's notice`).toBe('string');
    }
  });

  it('r281 — the ENGINE is untouched: this is a tenant answer, not a deletion', () => {
    // The plan promises the feature is not removed from the product, only from this tenant's screens,
    // and that it is reversible on the day the add-on is bought. That promise is about files, so it is
    // asserted over files. This deployment serves more than one tenant on shared code.
    for (const kept of [
      'core/toil.ts',
      'core/replacement-request.ts',
      'core/replacement-eligibility.ts',
      'docs/adr/0033-leave-in-lieu-toil.md',
    ]) {
      expect(fs.existsSync(path.join(ROOT, kept)), `${kept} must survive — the engine is not deleted`).toBe(true);
    }
    // …and the configuration surface is GATED, not deleted: every control is still in this file, ready
    // for the tenant that has the module.
    const src = read(PAGE_REL);
    expect(src).toContain('<ReplacementEligibilityPicker');
    expect(src).toContain('setToilPolicyAction');
  });

  it('no longer cross-links to the legacy Time Off In Lieu page', () => {
    const src = read(PAGE_REL) + read(CREDIT_PAGE_REL);
    // The reporter asked for this submenu to be self-contained. The link the OTHER way still exists and
    // is asserted below — removing it would strand an admin on the legacy page.
    expect(src).not.toContain('href="/admin/toil"');
  });

  // ── The half of the move that is easiest to undo by accident ───────────────────────────────────────
  // 3fb1a611 — THE LEDGER AND THE SWEEPS MOVED to Leave Credit's Credits tab; /admin/toil redirects there.
  it('the Leave Credit page KEEPS the ledger and both settlement sweeps (moved from Time Off In Lieu)', () => {
    const src = read(CREDIT_PAGE_REL);
    expect(src).toContain('replacementLeaveSummary');
    expect(src).toContain('runToilExpiryAction');
    expect(src).toContain('closeReplacementLeaveYearAction');
    expect(read(TOIL_REL)).toContain("redirect(`/admin/leave-config/leave-credit");
  });

  it('neither the Leave Credit page body nor the /admin/toil stub carries the policy editor itself', () => {
    for (const rel of [TOIL_REL, CREDIT_PAGE_REL]) {
      const src = read(rel);
      expect(src).not.toContain('setToilPolicyAction');
      expect(src).not.toContain('name="accrualBasis"');
      expect(src).not.toContain('name="allowFirstScheduleEligible"');
    }
  });

  it('the WIND-DOWN ARGUMENT survives intact, on the page that now holds the sweeps', () => {
    // The two sweeps are deliberately NOT entitlement-gated: a lapsed module must not strand a settlement
    // the employer already owes, and for a First-Schedule-eligible employee that debt is statutory. The
    // page is their only caller (there is no cron), so if this reasoning is deleted the next editor has
    // no way to know that re-gating the UI silently re-gates the obligation.
    const src = read(CREDIT_PAGE_REL);
    expect(src).toMatch(/wind-down|wind down/i);
    expect(src).toMatch(/statutory/i);
    expect(src).toMatch(/not entitlement-gated/i);
    // windDown is the mechanism (3fb1a611; it was showSettlement on /admin/toil): an outstanding liability
    // keeps the Credits tab — movements, summary, sweeps — reachable even with the module off.
    expect(src).toContain('const windDown = !moduleOn && summary.activeAccruals > 0;');
    expect(src).toContain('const showCredits = moduleOn || windDown;');
  });

  // 1cf5b37c MADE THIS ONE-DIRECTIONAL, deliberately. The reporter asked for the Leave Config submenu
  // to be self-contained and told us to leave the legacy module alone, so the link from the new screen
  // to /admin/toil is gone. The link the other way MUST survive: an admin who lands on the legacy page
  // still has to be told where configuration went, which is the half that stops a move reading as a
  // deletion. Asserting the removal here as well as in the 1cf5b37c block above is deliberate — this is
  // the test that would otherwise be "fixed" by putting the link back.
  it('the legacy page still sends the administrator HERE, and this page no longer links back', () => {
    // The link moved WITH the screen (a6fe37fc Round 5). 3fb1a611 — the legacy page does more than link now:
    // it IS a redirect to the screen that holds both its ledger and the configuration.
    expect(read(TOIL_REL)).toContain("redirect(`/admin/leave-config/leave-credit");
    expect(read(PAGE_REL)).not.toContain('href="/admin/toil"');
    expect(read(CREDIT_PAGE_REL)).not.toContain('href="/admin/toil"');
  });

  // ── 20e759a0 · the company filter's two easiest mistakes ───────────────────────────────────────────
  // The filter's BEHAVIOUR is tested for real in test/replacement-leave-controls.test.ts (the resolver
  // and the save round-trip). These two are source assertions because what they guard is a swap a tidy-up
  // would make on sight, and neither swap changes a type, breaks a build, or fails any behavioural test.
  it('narrows this page WITHOUT touching the global company-scope cookie', () => {
    // 3fb1a611 — the filter is in the Rules tab; the outer bound (`getScopeIds`) is read by the page.
    const src = read(PAGE_REL) + read(RULES_PAGE_REL);
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
      // 3fb1a611 — the screen that holds the editor and the sweeps now.
      'nav.leaveCredit',
      'admin.leaveConfigMap.item.leaveCreditRules',
      'admin.leaveCredit.rulesIntro',
      'admin.leaveCredit.windDown',
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
      'admin.replacementLeave.leaveFromRecordedOnly',
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
