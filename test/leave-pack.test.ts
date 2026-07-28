/**
 * Leave module pack (ADR-0080 D8/D9/D11, retrofit ladder rung 6 — the second-largest module).
 *
 * Verifies the mechanical halves of the retrofit with behaviour unchanged:
 *   1. Registry: `packs/leave` registers a module pack the registry resolves by id.
 *   2. Nav parity: the pack's navLinks are ROW-FOR-ROW the sidebar's pre-rung-6 leave rows — same
 *      labelKeys, hrefs, icon refs (CalendarDays for My Absence, SlidersHorizontal for the config
 *      row), same (absence of) visibility flags, same group placement — and components/sidebar.tsx
 *      mounts them via the registry instead of hardcoding them (the EXPECTED table below is the
 *      pre-change literal, captured verbatim; any drift is a rendering change by definition).
 *   3. Facade: `packs/leave/service` re-exports the implementation — outside callers get the exact
 *      same function references, so switching import paths cannot change behaviour.
 *   4. Boundary honesty: holidays is spine (not a satellite, not re-exported); the leave↔payroll
 *      seam took no new contract (encashment/unpaid stay inline in core/payroll.ts, allowlisted).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CalendarDays, SlidersHorizontal } from 'lucide-react';
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
      'leave_policy',
      'grade_group',
      'grade_group_member',
      'benefit_scheme',
      'scheme_leave_entitlement',
      'scheme_leave_combined_limit',
      'scheme_leave_combined_limit_member',
      'leave_ledger',
      'leave_request',
      'leave_request_attachment',
      'leave_request_date',
      'leave_approval_step',
      'leave_cancellation_request',
      'leave_approval_policy',
      'leave_approval_template',
      'toil_policy',
      'toil_accrual',
      'leave_year_config',
      'leave_entitlement_recalc_audit',
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
  // components/sidebar.tsx leave rows as of the commit before rung 6, captured VERBATIM. Like claims
  // this is two FLAT rows in two groups, not a collapsible node:
  //   top group:   { href: '/leave',       labelKey: 'myAbsence',  icon: CalendarDays }       (no gate)
  //   admin group: { href: '/admin/leave', labelKey: 'leaveConfig', icon: SlidersHorizontal } (no per-row
  //     gate — the Administration group is gated adminOnly wholesale, unchanged by the move).
  const EXPECTED = [
    { group: 'main', href: '/leave', labelKey: 'myAbsence', icon: CalendarDays },
    { group: 'admin', href: '/admin/leave', labelKey: 'leaveConfig', icon: SlidersHorizontal },
  ] as const;

  const links = leavePack.navLinks!;

  it('carries exactly the pre-retrofit rows, in order, with identical icon refs and gates', () => {
    expect(links).toHaveLength(EXPECTED.length);
    EXPECTED.forEach((want, i) => {
      const got = links[i];
      expect(got.group, `row ${i} group placement`).toBe(want.group);
      expect(got.href, `row ${i} href`).toBe(want.href);
      expect(got.labelKey, `${want.href} labelKey`).toBe(want.labelKey);
      expect(got.icon, `${want.href} icon ref`).toBe(want.icon);
      // Neither row carried a visibility flag pre-rung-6: /leave is every-employee self-service;
      // /admin/leave relies on the admin GROUP gate, not a per-row flag.
      expect(got.adminOnly, `${want.href} adminOnly`).toBeUndefined();
      expect(got.managerUp, `${want.href} managerUp`).toBeUndefined();
    });
  });

  it('declares no collapsible nav node (leave is flat links by design)', () => {
    expect(leavePack.navNodes).toBeUndefined();
  });

  it('sidebar.tsx mounts both rows via the registry and hardcodes neither', () => {
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
    for (const { href } of EXPECTED) {
      expect(sidebar.includes(`'${href}'`), `${href} no longer hardcoded in sidebar.tsx`).toBe(false);
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
    expect(facade.previewEntitlement).toBe(coreCompute.previewEntitlement);
    expect(facade.carryEnabled).toBe(coreCompute.carryEnabled);
    expect(facade.encashableDaysForEmployment).toBe(coreEncashment.encashableDaysForEmployment);
    expect(facade.LeaveEncashmentError).toBe(coreEncashment.LeaveEncashmentError);
    expect(facade.sweepLeaveApprovalEscalations).toBe(coreEscalation.sweepLeaveApprovalEscalations);
    expect(facade.resolveLeaveFormula).toBe(coreFormula.resolveLeaveFormula);
    expect(facade.validateLeaveImport).toBe(coreImport.validateLeaveImport);
    expect(facade.commitLeaveImport).toBe(coreImport.commitLeaveImport);
    expect(facade.consumeReplacementLeaveTx).toBe(coreToil.consumeReplacementLeaveTx);
    expect(facade.maybeAutoAccrueOnApprovalTx).toBe(coreToil.maybeAutoAccrueOnApprovalTx);
    expect(facade.listGradeGroups).toBe(coreBenefitScheme.listGradeGroups);
    expect(facade.createGradeGroup).toBe(coreBenefitScheme.createGradeGroup);
  });
});
