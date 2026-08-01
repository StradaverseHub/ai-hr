/**
 * Claims module pack (ADR-0080 D8/D9/D11, retrofit ladder rung 3).
 *
 * Verifies the four mechanical halves of the retrofit with behaviour unchanged:
 *   1. Registry: `packs/claims` registers a module pack the registry resolves by id.
 *   2. Nav parity: the pack's navLinks are ROW-FOR-ROW the sidebar's pre-rung-3 claims rows —
 *      same labelKeys, hrefs, icon refs (the shared Receipt), same (absence of) visibility flags,
 *      same group placement — and components/sidebar.tsx mounts them via the registry instead of
 *      hardcoding them (the EXPECTED table below is the pre-change literal, captured verbatim;
 *      any drift is a rendering change by definition).
 *   3. Facade: `packs/claims/service` re-exports the implementation — outside callers get the
 *      exact same function references, so switching import paths cannot change behaviour.
 *   4. The PayrollInputContributor kernel contract (D9, the ladder's first): the claims
 *      contributor resolves through packs/contracts.ts and produces EXACTLY what
 *      prefillClaimsForBatch produced — same payroll_input row, same reservation, same events,
 *      same processed payslip figures (the byte-identical bar) — proven against a live batch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Receipt } from 'lucide-react';
import { claimsPack } from '../packs/claims';
import { listPacks, modulePackById, packById } from '../packs/registry';
import {
  claimsPayrollInputContributor,
} from '../packs/claims/payroll';
import {
  listPayrollInputContributors,
  payrollInputContributorById,
} from '../packs/contracts';
import * as facade from '../packs/claims/service';
import * as coreClaims from '../core/claims';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips } from '../core/payroll';
import { hireEmployee } from '../core/org';
import { closeAll, entitledCtx, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// The kernel judges these dates in MYT (bb4f2265); a fixture built in UTC disagrees with it
// between 00:00 and 08:00 MYT, which is a test that fails only at night.
import { todayInKualaLumpur } from '../lib/hr-date';

describe('ADR-0080 rung 3: claims pack registration', () => {
  it('registers as a module pack the registry resolves by id', () => {
    expect(packById('claims')).toBe(claimsPack);
    expect(modulePackById('claims')).toBe(claimsPack);
    expect(claimsPack.kind).toBe('module');
    expect(listPacks('module').map((p) => p.id)).toContain('claims');
  });

  it('declares the audited satellite tables (D11 criterion 2)', () => {
    const tables = (claimsPack.satelliteTables ?? []).map((t) => t.table);
    expect(tables).toEqual([
      'claim_type',
      'claim_item',
      'claim_policy',
      'claim_request',
      'claim_attachment',
    ]);
  });

  it('declares its service facade path (D11 criterion 3 pointer)', () => {
    expect(claimsPack.serviceFacade).toBe('packs/claims/service');
  });
});

describe('ADR-0080 rung 3: nav parity with the pre-retrofit sidebar', () => {
  // components/sidebar.tsx claims rows as of the commit before rung 3, captured VERBATIM. Unlike
  // attendance this is two FLAT rows in two groups, not a collapsible node:
  //   top group:   { href: '/claims',       labelKey: 'claims',       icon: Receipt }  (no gate)
  //   admin group: { href: '/admin/claims', labelKey: 'claimsConfig', icon: Receipt }  (no per-row
  //     gate — the Administration group is gated adminOnly wholesale, unchanged by the move).
  const EXPECTED = [
    { group: 'main', href: '/claims', labelKey: 'claims', icon: Receipt },
    { group: 'admin', href: '/admin/claims', labelKey: 'claimsConfig', icon: Receipt },
  ] as const;

  const links = claimsPack.navLinks!;

  it('carries exactly the pre-retrofit rows, in order, with identical icon refs and gates', () => {
    expect(links).toHaveLength(EXPECTED.length);
    EXPECTED.forEach((want, i) => {
      const got = links[i];
      expect(got.group, `row ${i} group placement`).toBe(want.group);
      expect(got.href, `row ${i} href`).toBe(want.href);
      expect(got.labelKey, `${want.href} labelKey`).toBe(want.labelKey);
      expect(got.icon, `${want.href} icon ref`).toBe(want.icon);
      // Neither row carried a visibility flag pre-rung-3: /claims is every-employee self-service;
      // /admin/claims relies on the admin GROUP gate, not a per-row flag.
      expect(got.adminOnly, `${want.href} adminOnly`).toBeUndefined();
      expect(got.managerUp, `${want.href} managerUp`).toBeUndefined();
    });
  });

  it('declares no collapsible nav node (claims is flat links by design)', () => {
    expect(claimsPack.navNodes).toBeUndefined();
  });

  it('sidebar.tsx mounts both rows via the registry and hardcodes neither', () => {
    const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');
    // The registration moved out of the sidebar into packs/register-all.ts (ADR-0077 slice 1) so that
    // SERVER code can enumerate module packs too — a client-component side effect left listPacks()
    // empty on the server. The property under test is unchanged and still end-to-end: the pack is
    // registered, AND the sidebar pulls in the file that registers it. Asserting only the first half
    // would pass with the sidebar importing nothing at all.
    const registerAll = fs.readFileSync(path.resolve(__dirname, '../packs/register-all.ts'), 'utf8');
    expect(registerAll, 'registers the pack (static side-effect import)').toContain(`import '@/packs/claims'`);
    expect(sidebar, 'sidebar pulls in the shared pack wiring').toContain(`import '@/packs/register-all'`);
    expect(sidebar, 'resolves the rows through the registry').toContain(`modulePackById('claims')`);
    for (const { href } of EXPECTED) {
      expect(sidebar.includes(`'${href}'`), `${href} no longer hardcoded in sidebar.tsx`).toBe(false);
    }
  });
});

describe('ADR-0080 rung 3: service facade re-exports the implementation unchanged', () => {
  it('exposes the exact same function references as core/claims', () => {
    // Representatives across the module's slices (catalog, policy, lifecycle, attachments, payout);
    // identity (toBe) proves the facade cannot change behaviour for callers that switched paths.
    expect(facade.listClaimTypes).toBe(coreClaims.listClaimTypes);
    expect(facade.createClaimType).toBe(coreClaims.createClaimType);
    expect(facade.setClaimPolicy).toBe(coreClaims.setClaimPolicy);
    expect(facade.listClaimLimits).toBe(coreClaims.listClaimLimits);
    expect(facade.getEmployeeClaimTypes).toBe(coreClaims.getEmployeeClaimTypes);
    expect(facade.submitClaim).toBe(coreClaims.submitClaim);
    expect(facade.submitClaimWithAttachment).toBe(coreClaims.submitClaimWithAttachment);
    expect(facade.decideClaim).toBe(coreClaims.decideClaim);
    expect(facade.cancelClaim).toBe(coreClaims.cancelClaim);
    expect(facade.getClaimAttachment).toBe(coreClaims.getClaimAttachment);
    expect(facade.listClaimsForEmployment).toBe(coreClaims.listClaimsForEmployment);
    expect(facade.listPendingClaims).toBe(coreClaims.listPendingClaims);
    expect(facade.prefillClaimsForBatch).toBe(coreClaims.prefillClaimsForBatch);
    expect(facade.listReimbursementsDue).toBe(coreClaims.listReimbursementsDue);
    expect(facade.reimbursementCsv).toBe(coreClaims.reimbursementCsv);
    expect(facade.markReimbursementsPaid).toBe(coreClaims.markReimbursementsPaid);
    expect(facade.ClaimError).toBe(coreClaims.ClaimError);
  });
});

describe('ADR-0080 rung 3 (D9): the claims PayrollInputContributor kernel contract', () => {
  it('registers through the kernel contract home and resolves by id', () => {
    expect(payrollInputContributorById('claims')).toBe(claimsPayrollInputContributor);
    expect(claimsPayrollInputContributor.id).toBe('claims');
    expect(listPayrollInputContributors().map((c) => c.id)).toContain('claims');
  });

  it('the payroll surface consumes the contract, not core/claims (the seam moved)', () => {
    const actions = fs.readFileSync(path.resolve(__dirname, '../app/payroll/actions.ts'), 'utf8');
    expect(actions.includes(`@/core/claims`), 'app/payroll/actions.ts no longer imports core/claims').toBe(false);
    expect(actions, 'registers the contributor (static side-effect import)').toContain(`import '@/packs/claims/payroll'`);
    expect(actions, 'resolves the contributor through the kernel contract home').toContain(
      `payrollInputContributorById('claims')`,
    );
  });

  // The byte-identical bar: driving the SAME prefill through the contract produces exactly what
  // test/claims-payout.test.ts proves for prefillClaimsForBatch — same contribution figures (only
  // the contract's vocabulary differs: sourceCount ≙ claims), same payroll_input row, same batch
  // reservation + events, and the SAME processed payslip down to the statutory figures.
  //
  // ADR-0077 slice 3 — WHY THIS BLOCK DRIVES `entitledCtx` AND NOT `adminCtx`. The equivalence pinned
  // here is against the LEGACY payroll kernel: a taxable claim reaches the payslip through the
  // compensation + payroll_input fold (core/payroll.ts `earningsOf`, its `!typedComponents` branch).
  // With `typed_pay_components` ON the kernel reads the component tables as the earnings source and
  // never consults `payroll_input.claim_allowance` at all, so the 300 would silently vanish from the
  // slip. Until slice 3 `adminCtx` was `entitlementsExempt: 'harness'` and answered TRUE for every
  // catalogued module — it would have run this block on the typed path, i.e. the OPPOSITE kernel from
  // the one test/claims-payout.test.ts pins these very figures against. `entitledCtx` resolves a REAL
  // snapshot from the tenant's rows instead, and seedBase seeds no `typed_pay_components` row
  // (test/env.ts deletes
  // TYPED_PAY_COMPONENTS_ENABLED, so it is not in this process's parity set); a missing row is disabled
  // (C7), which is exactly the state this block ran in before the flip.
  describe('contribute() is prefillClaimsForBatch behind the contract (live-batch equivalence)', () => {
    let base: Base;
    beforeAll(async () => {
      await migrateTestDb();
    });
    beforeEach(async () => {
      await resetDb();
      base = await seedBase();
    });
    afterAll(async () => {
      await closeAll();
    });

    const hire = (ctx: SessionContext, name: string) =>
      hireEmployee(ctx, {
        person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });

    // Inside the 45-day receipt window (same helper rationale as test/claims-payout.test.ts).
    const recent = (daysBack = 5): string =>
      new Date(new Date(`${todayInKualaLumpur()}T00:00:00Z`).getTime() - daysBack * 86400000)
        .toISOString()
        .slice(0, 10);

    it('queues an approved taxable claim identically to the pre-contract path', async () => {
      // Real snapshot, resolved after seedBase and before any grant: `typed_pay_components` has no row,
      // so the kernel below takes the legacy compensation + payroll_input path (see the block comment).
      const a = await entitledCtx(base);
      const e = await hire(a, 'Contract');
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
      const { id: typeId } = await coreClaims.createClaimType(a, { code: 'PHONE', name: 'Phone allowance', defaultTaxable: true, requiresReceipt: false });
      const { id } = await coreClaims.submitClaim(a, { employmentId: e.employmentId, claimTypeId: typeId, amount: 300, incurredOn: recent() });
      await coreClaims.decideClaim(a, { claimRequestId: id, decision: 'approve' });

      const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
      const res = await payrollInputContributorById('claims')!.contribute(a, { batchId });
      // The contract's report is the implementation's report, renamed: claims → sourceCount.
      expect(res).toEqual({ applied: 1, sourceCount: 1, total: 300 });

      // Same payroll_input row as the direct path writes.
      const [input] = await owner.db
        .select({ claimAllowance: schema.payrollInput.claimAllowance })
        .from(schema.payrollInput)
        .where(eq(schema.payrollInput.batchId, batchId));
      expect(Number(input.claimAllowance)).toBeCloseTo(300, 2);

      // Same reservation + audit event.
      const [linked] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, id));
      expect(linked.payrollBatchId).toBe(batchId);
      expect(await eventTypesFor(base.tenantId, id)).toContain('claim-request.queued-for-payroll');

      // Idempotence carries through the contract unchanged.
      expect(await payrollInputContributorById('claims')!.contribute(a, { batchId })).toEqual({
        applied: 0,
        sourceCount: 0,
        total: 0,
      });

      // And processing yields the exact payslip test/claims-payout.test.ts pins for the direct
      // path: gross = 4000 + 300, EPF employee = ceil(4300 × 0.11) = 473, claim marked paid.
      await generatePayslips(a, { batchId });
      const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
      expect(Number(ps.allowance)).toBeCloseTo(300, 2);
      expect(Number(ps.grossPay)).toBeCloseTo(4300, 2);
      expect((ps.statutory as Record<string, number>).epfEmployee).toBe(473);
      const [paid] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, id));
      expect(paid.status).toBe('paid');
      expect(await eventTypesFor(base.tenantId, id)).toContain('claim-request.paid');
    });
  });
});
