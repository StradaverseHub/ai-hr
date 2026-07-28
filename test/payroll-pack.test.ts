/**
 * Payroll module pack (ADR-0080 D8/D9/D11, retrofit ladder rung 7 — THE FINAL RETROFIT, the money path).
 *
 * Verifies the mechanical halves of the retrofit with behaviour unchanged:
 *   1. Registry: `packs/payroll` registers a module pack the registry resolves by id.
 *   2. Nav parity: the pack's navLinks are ROW-FOR-ROW the sidebar's pre-rung-7 payroll row — same
 *      labelKey, href, icon ref (Wallet), same (absence of) visibility flags, same group placement —
 *      and components/sidebar.tsx mounts it via the registry instead of hardcoding it (the EXPECTED
 *      literal below is the pre-change value, captured verbatim; any drift is a rendering change).
 *   3. Facade: `packs/payroll/service` re-exports the twenty implementation modules — outside callers
 *      get the exact same function references, so switching import paths cannot change behaviour.
 *   4. Boundary honesty: comp.ts is spine (not a satellite, not re-exported); the country statutory
 *      profile/rule tables are not claimed; the leave↔payroll seams stay inline (no new contract),
 *      and payroll consumes the claims payout through the existing PayrollInputContributor contract.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Wallet } from 'lucide-react';
import { payrollPack } from '../packs/payroll';
import { listPacks, modulePackById, packById } from '../packs/registry';
import { listPayrollInputContributors, payrollInputContributorById } from '../packs/contracts';
// Side-effect: register the claims PayrollInputContributor (the rung-3 contract wiring) so the
// consumer-side seam assertion below is meaningful — vitest isolates each file's module registry,
// so a contributor only exists here if this file pulls its registration in (the D8 convention).
import '../packs/claims/payroll';
import * as facade from '../packs/payroll/service';
import * as corePayroll from '../core/payroll';
import * as coreCycle from '../core/payroll-cycle';
import * as coreConfig from '../core/payroll-config';
import * as corePolicy from '../core/payroll-policy';
import * as corePolicyConfig from '../core/payroll-policy-config';
import * as coreIndividualTxn from '../core/payroll-individual-txn';
import * as coreRunGroup from '../core/payroll-run-group';
import * as coreView from '../core/payroll-view';
import * as coreReadiness from '../core/payroll-readiness';
import * as coreHistoryImport from '../core/payroll-history-import';
import * as corePermissions from '../core/payroll-permissions-admin';
import * as corePayComponents from '../core/pay-components';
import * as corePayRule from '../core/pay-rule';
import * as corePayRuleAi from '../core/pay-rule-ai';
import * as coreCp38 from '../core/cp38';
import * as coreEaOverride from '../core/ea-override';
import * as coreTaxRelief from '../core/tax-relief';
import * as coreLoans from '../core/loans';
import * as coreLoansCompute from '../core/loans-compute';
import * as coreStatutoryAuthority from '../core/statutory-authority';

describe('ADR-0080 rung 7: payroll pack registration', () => {
  it('registers as a module pack the registry resolves by id', () => {
    expect(packById('payroll')).toBe(payrollPack);
    expect(modulePackById('payroll')).toBe(payrollPack);
    expect(payrollPack.kind).toBe('module');
    expect(listPacks('module').map((p) => p.id)).toContain('payroll');
  });

  it('declares the audited satellite tables (D11 criterion 2)', () => {
    const tables = (payrollPack.satelliteTables ?? []).map((t) => t.table);
    expect(tables).toEqual([
      'payroll_policy',
      'company_payroll_config',
      'payroll_cycle',
      'payroll_batch',
      'payslip',
      'payroll_status_history',
      'payroll_employee_result_history',
      'payroll_reprocess_job',
      'payroll_permission_grant',
      'payroll_step_up_challenge',
      'payroll_input',
      'pay_component',
      'employment_pay_component',
      'payroll_batch_component',
      'payroll_individual_txn',
      'company_statutory_authority',
      'statutory_report',
      'employee_loan',
      'loan_repayment',
    ]);
  });

  it('does not claim compensation (audited employment-spine, the rung-4/rung-6 analogue)', () => {
    const tables = (payrollPack.satelliteTables ?? []).map((t) => t.table);
    expect(tables, 'compensation is spine, not a payroll satellite').not.toContain('compensation');
  });

  it('does not claim the country statutory profile/rule tables (the COUNTRY axis, D5)', () => {
    const tables = (payrollPack.satelliteTables ?? []).map((t) => t.table);
    for (const country of [
      'employee_statutory_my',
      'company_statutory_my',
      'statutory_ruleset',
      'statutory_component_override',
      'statutory_pack',
      'statutory_signing_key',
      'statutory_pack_sync_log',
    ]) {
      expect(tables, `${country} is a country-pack satellite, not payroll-module`).not.toContain(country);
    }
  });

  it('declares its service facade path (D11 criterion 3 pointer)', () => {
    expect(payrollPack.serviceFacade).toBe('packs/payroll/service');
  });
});

describe('ADR-0080 rung 7: nav parity with the pre-retrofit sidebar', () => {
  // components/sidebar.tsx payroll row as of the commit before rung 7, captured VERBATIM. Like claims'
  // config row this is a SINGLE flat row in the Administration group, not a collapsible node:
  //   admin group: { href: '/payroll', labelKey: 'payroll', icon: Wallet } (no per-row gate — the
  //     Administration group is gated adminOnly wholesale, unchanged by the move).
  const EXPECTED = [{ group: 'admin', href: '/payroll', labelKey: 'payroll', icon: Wallet }] as const;

  const links = payrollPack.navLinks!;

  it('carries exactly the pre-retrofit row, with identical icon ref and gate', () => {
    expect(links).toHaveLength(EXPECTED.length);
    EXPECTED.forEach((want, i) => {
      const got = links[i];
      expect(got.group, `row ${i} group placement`).toBe(want.group);
      expect(got.href, `row ${i} href`).toBe(want.href);
      expect(got.labelKey, `${want.href} labelKey`).toBe(want.labelKey);
      expect(got.icon, `${want.href} icon ref`).toBe(want.icon);
      // The row relied on the admin GROUP gate, not a per-row flag — unchanged by the move.
      expect(got.adminOnly, `${want.href} adminOnly`).toBeUndefined();
      expect(got.managerUp, `${want.href} managerUp`).toBeUndefined();
    });
  });

  it('declares no collapsible nav node (payroll is a single flat link by design)', () => {
    expect(payrollPack.navNodes).toBeUndefined();
  });

  it('sidebar.tsx mounts the row via the registry and hardcodes it nowhere', () => {
    const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');
    // The registration moved out of the sidebar into packs/register-all.ts (ADR-0077 slice 1) so that
    // SERVER code can enumerate module packs too — a client-component side effect left listPacks()
    // empty on the server. The property under test is unchanged and still end-to-end: the pack is
    // registered, AND the sidebar pulls in the file that registers it. Asserting only the first half
    // would pass with the sidebar importing nothing at all.
    const registerAll = fs.readFileSync(path.resolve(__dirname, '../packs/register-all.ts'), 'utf8');
    expect(registerAll, 'registers the pack (static side-effect import)').toContain(`import '@/packs/payroll'`);
    expect(sidebar, 'sidebar pulls in the shared pack wiring').toContain(`import '@/packs/register-all'`);
    expect(sidebar, 'resolves the row through the registry').toContain(`modulePackById('payroll')`);
    expect(sidebar.includes(`'/payroll'`), `/payroll no longer hardcoded in sidebar.tsx`).toBe(false);
  });
});

describe('ADR-0080 rung 7: service facade re-exports the implementation unchanged', () => {
  it('exposes the exact same references as the twenty payroll implementation modules', () => {
    // One+ representative per module; identity (toBe) proves the facade cannot change behaviour for
    // callers that switched import paths. Representatives are single-origin (no star-export ambiguity).
    expect(facade.generatePayslips).toBe(corePayroll.generatePayslips);
    expect(facade.setPayrollInput).toBe(corePayroll.setPayrollInput);
    expect(facade.daysInMonth).toBe(corePayroll.daysInMonth);
    expect(facade.PayrollCycleDuplicateNameError).toBe(coreCycle.PayrollCycleDuplicateNameError);
    expect(facade.setPayrollConfig).toBe(coreConfig.setPayrollConfig);
    expect(facade.DuplicatePolicyNameError).toBe(corePolicy.DuplicatePolicyNameError);
    expect(facade.PAYROLL_FREQUENCIES).toBe(corePolicyConfig.PAYROLL_FREQUENCIES);
    expect(facade.calendarWindowFor).toBe(corePolicyConfig.calendarWindowFor);
    expect(facade.payslipReleaseAt).toBe(corePolicyConfig.payslipReleaseAt);
    expect(facade.isTxnKind).toBe(coreIndividualTxn.isTxnKind);
    expect(facade.overallStatusOf).toBe(coreRunGroup.overallStatusOf);
    expect(facade.listFixedTransactionsAcross).toBe(coreView.listFixedTransactionsAcross);
    expect(facade.payrollReadiness).toBe(coreReadiness.payrollReadiness);
    expect(facade.validatePayrollHistoryImport).toBe(coreHistoryImport.validatePayrollHistoryImport);
    expect(facade.listPayrollPermissionGrants).toBe(corePermissions.listPayrollPermissionGrants);
    expect(facade.setPayrollBatchComponent).toBe(corePayComponents.setPayrollBatchComponent);
    expect(facade.UnsupportedBatchComponentError).toBe(corePayComponents.UnsupportedBatchComponentError);
    expect(facade.validatePayRule).toBe(corePayRule.validatePayRule);
    expect(facade.draftPayRule).toBe(corePayRuleAi.draftPayRule);
    expect(facade.setCp38).toBe(coreCp38.setCp38);
    expect(facade.listEaOverrides).toBe(coreEaOverride.listEaOverrides);
    expect(facade.getTp1).toBe(coreTaxRelief.getTp1);
    expect(facade.createLoan).toBe(coreLoans.createLoan);
    expect(facade.toCents).toBe(coreLoansCompute.toCents);
    expect(facade.upsertCompanyStatutoryAuthority).toBe(coreStatutoryAuthority.upsertCompanyStatutoryAuthority);
  });
});

describe('ADR-0080 rung 7: the pay seams (D9) — consumer side established, leave side inline', () => {
  it('consumes the claims taxable payout through the PayrollInputContributor contract (rung 3)', () => {
    // The contract home is established and claims is registered; payroll (app/payroll/actions.ts)
    // resolves it BY ID. This rung does not change that seam — it proves the consumer side exists.
    expect(payrollInputContributorById('claims')).toBeDefined();
    expect(listPayrollInputContributors().map((c) => c.id)).toContain('claims');
  });

  it('leaves the leave→payroll effects inline: no leave contributor was registered this rung', () => {
    // Neither leave effect produces a payroll_input row (unpaid = inline generation-time reduction;
    // encashment = read-only leaverAdvisory), so the contributor contract is the wrong shape — the
    // rung-6 debt stays inline by risk choice (packs/payroll/index.ts). If a leave contributor is
    // ever registered it must come with byte-identical payroll goldens; assert its absence for now.
    expect(listPayrollInputContributors().map((c) => c.id)).not.toContain('leave');
  });
});
