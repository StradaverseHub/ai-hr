/**
 * Leave module pack (ADR-0080 D8/D9/D11, retrofit ladder rung 6 — the second-largest module).
 *
 * Verifies the mechanical halves of the retrofit with behaviour unchanged:
 *   1. Registry: `packs/leave` registers a module pack the registry resolves by id.
 *   2. Navigation ownership: preserved tracker and approved My Team rows have exact labels, hrefs,
 *      icon refs and role gates. The employee's My Leave flyout remains ungated, with exact children
 *      and active predicates. Sidebar mounts them via the registry instead of duplicating destinations.
 *      The EXPECTED table pins the current approved additions and the original tracker behavior.
 *   3. Facade: `packs/leave/service` re-exports the implementation — outside callers get the exact
 *      same function references, so switching import paths cannot change behaviour.
 *   4. Boundary honesty: holidays is spine (not a satellite, not re-exported); the leave↔payroll
 *      seam took no new contract (encashment/unpaid stay inline in core/payroll.ts, allowlisted).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CalendarClock, CalendarDays, ClipboardList, CalendarRange, History, SlidersHorizontal, UserSearch } from 'lucide-react';
import { leavePack } from '../packs/leave';
import { listPacks, modulePackById, packById } from '../packs/registry';
import * as facade from '../packs/leave/service';
import * as coreLeave from '../core/leave';
import * as coreApprovalPolicy from '../core/leave-approval-policy';
import * as coreApprovalTemplate from '../core/leave-approval-template';
import * as coreCompute from '../core/leave-compute';
import * as coreEncashment from '../core/leave-encashment';
import * as coreEscalation from '../core/leave-escalation';
import * as coreFormula from '../core/leave-formula';
import * as coreImport from '../core/leave-import';
import * as coreToil from '../core/toil';
import * as coreBenefitScheme from '../core/benefit-scheme';
import * as coreLeaveCreditHistory from '../core/leave-credit-history';

describe('ADR-0080 rung 6: leave pack registration', () => {
  it('registers as a module pack the registry resolves by id', () => {
    expect(packById('leave')).toBe(leavePack);
    expect(modulePackById('leave')).toBe(leavePack);
    expect(leavePack.kind).toBe('module');
    expect(listPacks('module').map((p) => p.id)).toContain('leave');
  });

  it('declares the audited satellite tables (D11 criterion 2)', () => {
    const tables = (leavePack.satelliteTables ?? []).map((t) => t.table);
    expect(tables).toEqual([
      'leave_type',
      // 6e9a126e RELEASE THREE — `leave_policy`, `benefit_scheme` and `scheme_leave_entitlement` are GONE
      // (migration 0405 drops them), so the pack no longer claims to own them. `grade_group` and
      // `grade_group_member` STAY, permanently: leave APPROVAL routing scopes on them (205 live
      // leave_approval_policy rows), which is why they were never part of the entitlement cut. This list is
      // UPDATED, never loosened, exactly as the nav exact-set guards are.
      'grade_group',
      'grade_group_member',
      'entitlement_template',
      'entitlement_eligibility_rule',
      'entitlement_reset_archive',
      'leave_shared_group',
      'leave_shared_group_member',
      'leave_ledger',
      'leave_request',
      'leave_request_attachment',
      'leave_request_date',
      'leave_approval_step',
      'leave_cancellation_request',
      // r301 (83511d3b) — a cancellation's copied approval chain. UPDATED, not loosened: one table added.
      'leave_cancellation_step',
      'leave_approval_policy',
      'leave_approval_template',
      'toil_policy',
      'toil_accrual',
      'leave_year_config',
      'leave_entitlement_recalc_audit',
      // 93249794 — the Generate Entitlement processing log. This list is an EXACT-SET guard: it is
      // UPDATED when a row is legitimately added, never loosened, because its job is to catch a sibling
      // accidentally clipped by an edit.
      'leave_generation_run',
      'leave_generation_run_item',
      'leave_encashment_policy',
      'leave_encashment_snapshot',
    ]);
  });

  it('does not claim the shared-spine holiday tables (audited spine, ADR open decision 3)', () => {
    const tables = (leavePack.satelliteTables ?? []).map((t) => t.table);
    for (const spine of ['holiday', 'holiday_group', 'holiday_group_holiday']) {
      expect(tables, `${spine} is spine, not a leave satellite`).not.toContain(spine);
    }
  });

  it('declares its service facade path (D11 criterion 3 pointer)', () => {
    expect(leavePack.serviceFacade).toBe('packs/leave/service');
  });
});

describe('ADR-0080 rung 6: nav parity with the pre-retrofit sidebar', () => {
  // components/sidebar.tsx leave rows as of the commit before rung 6, captured VERBATIM.
  //
  // 645e67c4 SUPERSEDES HALF OF THIS, deliberately. The admin row is no longer a flat link: Leave config
  // became a collapsible NODE carrying the retired tab strip's eight destinations, which is what the
  // reporter asked for twice (this item, and 491c499f's contest in the same words). The rung-6 promise
  // that survives is the one that still matters — the rows come from the PACK and the sidebar hardcodes
  // none of them. What the node itself must contain is test/leave-flyout-nav.test.ts's job, exactly as
  // payroll's node parity lives in test/payroll-flyout-nav.test.ts rather than here.
  //
  //   top group:   ungated LEAVE_SELF_NAV, containing Overview and History in the shared flyout
  //   admin group: now LEAVE_ADMIN_NAV, a node (see below)
  //
  // a00c4f64 ADDS a Manage-group row — Team Leave Tracker, the Leave Calendar's own screen after it left
  // the Dashboard. It is listed here with NO gate on purpose: the Manage group gates per row, so an
  // ungated row is what keeps this calendar visible to every employee, which is what it was on the
  // dashboard. The `toBeUndefined()` assertions below are therefore load-bearing for this row, not
  // boilerplate — a `managerUp` creeping in here silently removes a screen from plain staff.
  const EXPECTED = [
    { group: 'manage', href: '/leave/tracker', labelKey: 'teamLeaveTracker', icon: CalendarRange, managerUp: undefined },
    // r384 adds a supervisor workspace; the existing all-employee tracker remains ungated.
    { group: 'manage', href: '/manage/my-team', labelKey: 'myTeam', icon: UserSearch, managerUp: true },
  ] as const;

  /** Every href the pack contributes, flat rows and node children alike — what the sidebar must not hardcode. */
  const ALL_HREFS = [
    '/leave',
    '/leave/tracker',
    '/manage/my-team',
    ...leavePack.navNodes!.flatMap((n) => n.children.map((c) => c.href)),
  ];

  const links = leavePack.navLinks!;

  it('carries the preserved tracker and approved My Team row in order with exact icons and gates', () => {
    expect(links).toHaveLength(EXPECTED.length);
    EXPECTED.forEach((want, i) => {
      const got = links[i];
      expect(got.group, `row ${i} group placement`).toBe(want.group);
      expect(got.href, `row ${i} href`).toBe(want.href);
      expect(got.labelKey, `${want.href} labelKey`).toBe(want.labelKey);
      expect(got.icon, `${want.href} icon ref`).toBe(want.icon);
      // The tracker stays available to ordinary staff; My Team requires supervisor authority.
      expect(got.adminOnly, `${want.href} adminOnly`).toBeUndefined();
      expect(got.managerUp, `${want.href} managerUp`).toBe(want.managerUp);
    });
  });

  // r389 (bc3e203d) — UPDATED, NOT LOOSENED: the exact set gained Leave Credit History, third, at the address
  // the old form-plus-list page held. The parent node stays ungated; the new ROW is gated on the `toil` module
  // in components/sidebar.tsx (test/r299-leave-credit-screens.test.ts pins that mapping), which is a module
  // gate, not a role flag — so the "no adminOnly / managerUp" loop below still holds for all three rows.
  it('declares exactly Request, History and Leave Credit History under the ungated My Leave flyout', () => {
    const self = leavePack.navNodes!.filter(n => n.group === 'main');
    expect(self).toHaveLength(1);
    expect(self[0].labelKey).toBe('myLeave');
    expect(self[0].icon).toBe(CalendarDays);
    expect(self[0].defaultHref, 'parent opens its flyout rather than navigating immediately').toBeUndefined();
    expect(self[0].activeMatch).toBe('children');
    expect(self[0].children.map(c => [c.href,c.labelKey,c.exactHref,c.icon])).toEqual([
      ['/leave','leaveOverview',true,CalendarDays], ['/leave/history','leaveHistory',true,History],
      ['/leave/credit','leaveCreditHistory',true,CalendarClock],
      // r404 (42e55e2b) — UPDATED, NOT LOOSENED: My Leave › Leave Details, fourth, after Leave Credit History.
      ['/leave/details','leaveDetails',true,ClipboardList],
    ]);
    expect(self[0]).not.toHaveProperty('adminOnly');
    expect(self[0]).not.toHaveProperty('managerUp');
    for (const row of self[0].children) {
      expect(row.adminOnly, 'My Leave remains employee self-service').toBeUndefined();
      expect(row.managerUp, 'My Leave remains employee self-service').toBeUndefined();
    }
  });

  it('declares the Leave config node (645e67c4 — an expandable group, not a flat row)', () => {
    const admin = leavePack.navNodes!.filter((n) => n.group === 'admin');
    expect(admin, 'exactly one admin node').toHaveLength(1);
    expect(admin[0].labelKey).toBe('leaveConfig');
    // The flat admin row it replaced must be gone, not left alongside — two entries for one
    // destination is the "two navigations at once" this conversion exists to remove.
    expect(leavePack.navLinks!.some((l) => l.group === 'admin')).toBe(false);
  });

  it('sidebar.tsx mounts pack navigation via the registry without duplicating destinations', () => {
    const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');
    // The registration moved out of the sidebar into packs/register-all.ts (ADR-0077 slice 1) so that
    // SERVER code can enumerate module packs too — a client-component side effect left listPacks()
    // empty on the server. The property under test is unchanged and still end-to-end: the pack is
    // registered, AND the sidebar pulls in the file that registers it. Asserting only the first half
    // would pass with the sidebar importing nothing at all.
    const registerAll = fs.readFileSync(path.resolve(__dirname, '../packs/register-all.ts'), 'utf8');
    expect(registerAll, 'registers the pack (static side-effect import)').toContain(`import '@/packs/leave'`);
    expect(sidebar, 'sidebar pulls in the shared pack wiring').toContain(`import '@/packs/register-all'`);
    expect(sidebar, 'resolves the rows through the registry').toContain(`modulePackById('leave')`);
    // Only the exact responsive route condition is allowed to name My Team here. Remove that
    // known expression, then every pack destination remains forbidden in the navigation source.
    const responsiveRail = "pathname === '/manage/my-team' ? 'min-[900px]:block' : 'sm:block'";
    expect(sidebar, 'the responsive exception must be the actual rail condition').toContain(responsiveRail);
    const navigationSource = sidebar.replace(responsiveRail, '');
    // Node children count too: a hardcoded child href would bypass the pack just as a hardcoded row did.
    for (const href of ALL_HREFS) {
      expect(navigationSource.includes(`'${href}'`), `${href} no longer hardcoded in sidebar.tsx`).toBe(false);
    }
  });
});

describe('ADR-0080 rung 6: service facade re-exports the implementation unchanged', () => {
  it('exposes the exact same references as the ten leave implementation modules', () => {
    // One+ representative per module; identity (toBe) proves the facade cannot change behaviour for
    // callers that switched import paths. Representatives are unique to their module (no star-export
    // ambiguity across the facade).
    expect(facade.requestLeave).toBe(coreLeave.requestLeave);
    expect(facade.decideLeave).toBe(coreLeave.decideLeave);
    expect(facade.reprojectEntitlementForEmployment).toBe(coreLeave.reprojectEntitlementForEmployment);
    expect(facade.resolveApprovalChain).toBe(coreApprovalPolicy.resolveApprovalChain);
    expect(facade.setLeaveApprovalPolicy).toBe(coreApprovalPolicy.setLeaveApprovalPolicy);
    expect(facade.listApprovalTemplates).toBe(coreApprovalTemplate.listApprovalTemplates);
    expect(facade.createApprovalTemplate).toBe(coreApprovalTemplate.createApprovalTemplate);
    // 6e9a126e RELEASE THREE — was `previewEntitlement`, which went with the leave_policy layer it
    // previewed. Repointed at `composeEntitlement`, the single composition hook that replaced it, rather
    // than dropped: core/leave-compute needs a representative here or the facade could stop re-exporting
    // the module entirely and this identity test would still pass on `carryEnabled` alone.
    expect(facade.composeEntitlement).toBe(coreCompute.composeEntitlement);
    expect(facade.carryEnabled).toBe(coreCompute.carryEnabled);
    expect(facade.encashableDaysForEmployment).toBe(coreEncashment.encashableDaysForEmployment);
    expect(facade.LeaveEncashmentError).toBe(coreEncashment.LeaveEncashmentError);
    expect(facade.sweepLeaveApprovalEscalations).toBe(coreEscalation.sweepLeaveApprovalEscalations);
    expect(facade.resolveLeaveFormula).toBe(coreFormula.resolveLeaveFormula);
    expect(facade.validateLeaveImport).toBe(coreImport.validateLeaveImport);
    expect(facade.commitLeaveImport).toBe(coreImport.commitLeaveImport);
    expect(facade.consumeReplacementLeaveTx).toBe(coreToil.consumeReplacementLeaveTx);
    // r389 — the Leave Credit History read reaches outside callers through the facade like every module here.
    expect(facade.listOwnLeaveCreditHistory).toBe(coreLeaveCreditHistory.listOwnLeaveCreditHistory);
    expect(facade.maybeAutoAccrueOnApprovalTx).toBe(coreToil.maybeAutoAccrueOnApprovalTx);
    expect(facade.listGradeGroups).toBe(coreBenefitScheme.listGradeGroups);
    expect(facade.createGradeGroup).toBe(coreBenefitScheme.createGradeGroup);
  });
});
