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

const PAGE_REL = 'app/admin/leave/replacement/page.tsx';
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
    expect(REGISTERED_ROUTES.has('/admin/leave/replacement')).toBe(true);
  });

  it('BOTH routes stay registered — the move split one screen in two, it did not retire either', () => {
    expect(REGISTERED_ROUTES.has('/admin/leave/replacement')).toBe(true);
    expect(REGISTERED_ROUTES.has('/admin/toil')).toBe(true);
  });

  it('the leave fly-out still carries the replacement entry, between Payroll Related and Audit', () => {
    // 645e67c4 — this asserted against components/leave-tabs.tsx, now deleted: Leave config is a sidebar
    // fly-out. The ORDER the reporter sees is unchanged and is still worth guarding, so the same promise
    // is re-made against the pack node that actually renders it.
    const node = leavePack.navNodes!.find((n) => n.group === 'admin')!;
    const hrefs = node.children.map((c) => c.href);
    expect(hrefs).toContain('/admin/leave/replacement');
    const at = (href: string) => hrefs.indexOf(href);
    expect(at('/admin/leave/replacement')).toBeGreaterThan(at('/admin/leave/payroll'));
    expect(at('/admin/leave/audit')).toBeGreaterThan(at('/admin/leave/replacement'));
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

  it('SAYS ON SCREEN that Replacement Leave From is recorded only', () => {
    // The request is explicit that this setting changes nothing today and that the page must say so, or
    // an admin will configure it and expect overtime to start being validated against it. Assert both
    // that the page renders the note and that the note actually makes the claim.
    expect(read(PAGE_REL)).toContain("tr('leaveFromRecordedOnly')");
    const note = String(getPath(load('en'), 'admin.replacementLeave.leaveFromRecordedOnly'));
    expect(note).toMatch(/recorded only/i);
    expect(note).toMatch(/changes nothing today/i);
  });

  it('stays READ-ONLY rather than hidden when the add-on is not switched on', () => {
    const src = read(PAGE_REL);
    // Replacement leave is a chargeable add-on: the page must remain VISIBLE (so an admin can review what
    // is configured) with every control disabled and no Save button. Hiding it would contradict the
    // moduleOff banner and strand an admin who has to reason about an outstanding liability.
    expect(src).toContain('isModuleEnabledOrFalse');
    expect(src).toContain('disabled={!moduleOn}');
    expect(src).toContain('{moduleOn && <button');
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

  it('the two screens cross-link BOTH ways, so neither reads as a deleted feature', () => {
    expect(read(PAGE_REL)).toContain('href="/admin/toil"');
    expect(read(TOIL_REL)).toContain('href="/admin/leave/replacement"');
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
      'admin.replacementLeave.leaveFromRecordedOnly',
      'admin.replacementLeave.ledgerMovedNote',
      'admin.replacementLeave.ledgerMovedLink',
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
