/**
 * Payslip provenance + re-run disclosure (feedback 97a9b0ab).
 *
 * THE REPORTED FAULT WAS NOT A FAULT. Two calculations of the same month showed different tax with
 * the same gross. That is legally required: Malaysian PCB is CUMULATIVE, and core/payroll.ts replays
 * the year's prior slips to rebuild the accumulators, so revising month N moves month N+1. The
 * accumulator is correct and is NOT touched here. What was missing was the ability to SAY so.
 *
 * Tests:
 *   PURE (core/payslip-recompute.ts)
 *     a. payslipProvenance reads the ruleset/pack stamp already in the statutory JSONB, and is total
 *        (null / {} / a legacy slip with no version all yield nulls rather than throwing).
 *     b. gross unchanged + a statutory line moved ⇒ needsDisclosure, and cause (b) is named when the
 *        caller found an earlier-month recomputation.
 *     c. cause (a) — the slip's own ruleset version differs — is named, and BOTH are reported when
 *        both apply.
 *     d. neither cause ⇒ empty causes (the movement came from the slip's own inputs); an unknown
 *        version on either side is reported as undecidable, never as "changed".
 *     e. a gross change clears needsDisclosure (it explains itself) without hiding the moved lines.
 *     f. THE ALLOWLIST GUARD. `statutory` also carries audit/breakdown members (pcbMeta,
 *        exemptionUsed, componentVersions, employerBorne…). Movement in those is NOT a reportable
 *        statutory line, and cent-level float dust is not a movement either.
 *
 *   DB (core/payroll-view.ts listRecomputeDisclosure)
 *     g. cause (b) is derived on TIME, not on version numbers: an earlier-month recomputation counts
 *        only when it landed AFTER this slip was last computed. One planted inside the window is
 *        reported; the identical event planted before the run was processed is not.
 *     h. the tax-year fence — a December recomputation of the PREVIOUS year never counts (the PCB
 *        accumulators reset each year).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createBatch, generatePayslips } from '../core/payroll';
import { listRecomputeDisclosure } from '../core/payroll-view';
import {
  diffPayslipVersions,
  payslipProvenance,
  STATUTORY_LINE_KEYS,
  type PayslipSnapshot,
} from '../core/payslip-recompute';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/** A payslip snapshot in the exact shape core/payroll.ts writes into result-history before/after. */
const snap = (p: {
  gross?: number;
  net?: number;
  version?: number;
  statutory?: Record<string, unknown>;
}): PayslipSnapshot => ({
  grossPay: (p.gross ?? 5000).toFixed(2),
  netPay: (p.net ?? 4000).toFixed(2),
  version: p.version ?? 1,
  statutory: { version: '2026.5', epfEmployee: 550, socsoEmployee: 24.75, pcb: 100, ...(p.statutory ?? {}) },
});

describe('97a9b0ab — payslip provenance + re-run diff (pure)', () => {
  it('a. payslipProvenance reads the stamp already in the statutory JSONB, and is total', () => {
    expect(payslipProvenance({ version: '2026.5', packVersion: '2026.01.01', signedKeyId: 'key-1' })).toEqual({
      rulesetVersion: '2026.5',
      packVersion: '2026.01.01',
      signedKeyId: 'key-1',
    });
    // A company computing from the BUILT-IN ruleset resolves source !== 'pack', so core/payroll.ts
    // stamps no pack members. That is the normal case today, and it must read as "no pack", not throw.
    expect(payslipProvenance({ version: '2026.4' })).toEqual({
      rulesetVersion: '2026.4',
      packVersion: null,
      signedKeyId: null,
    });
    for (const empty of [null, undefined, {}]) {
      expect(payslipProvenance(empty)).toEqual({ rulesetVersion: null, packVersion: null, signedKeyId: null });
    }
  });

  it('b. gross unchanged + a statutory line moved ⇒ disclosure, with the cumulative-PCB cause named', () => {
    const d = diffPayslipVersions(
      snap({ statutory: { pcb: 100 } }),
      snap({ version: 2, statutory: { pcb: 137.55 } }),
      { priorMonthsRecomputed: true },
    );
    expect(d.grossChanged).toBe(false);
    expect(d.needsDisclosure).toBe(true);
    expect(d.moved).toEqual([{ key: 'pcb', before: 100, after: 137.55, delta: 37.55 }]);
    expect(d.causes).toEqual(['prior_months_recomputed']);
    expect(d.versionBefore).toBe(1);
    expect(d.versionAfter).toBe(2);
  });

  it('c. a differing ruleset version is named, and BOTH causes are reported when both apply', () => {
    const onlyVersion = diffPayslipVersions(
      snap({ statutory: { version: '2026.4', pcb: 100 } }),
      snap({ version: 2, statutory: { version: '2026.5', pcb: 110 } }),
    );
    expect(onlyVersion.rulesetChanged).toBe(true);
    expect(onlyVersion.rulesetUnknown).toBe(false);
    expect(onlyVersion.before.rulesetVersion).toBe('2026.4');
    expect(onlyVersion.after.rulesetVersion).toBe('2026.5');
    expect(onlyVersion.causes).toEqual(['ruleset_version']);

    const both = diffPayslipVersions(
      snap({ statutory: { version: '2026.4', pcb: 100 } }),
      snap({ version: 2, statutory: { version: '2026.5', pcb: 110 } }),
      { priorMonthsRecomputed: true },
    );
    expect(both.causes).toEqual(['ruleset_version', 'prior_months_recomputed']);
  });

  it('d. no cause ⇒ empty causes; an unstamped version is undecidable, never "changed"', () => {
    const own = diffPayslipVersions(snap({ statutory: { pcb: 100 } }), snap({ version: 2, statutory: { pcb: 90 } }));
    expect(own.moved).toHaveLength(1);
    expect(own.causes).toEqual([]);
    expect(own.rulesetChanged).toBe(false);
    expect(own.rulesetUnknown).toBe(false);

    // A slip predating the version stamp. "Absent" must not be read as a different version.
    const unknown = diffPayslipVersions(
      { grossPay: '5000.00', netPay: '4000.00', version: 1, statutory: { pcb: 100 } },
      snap({ version: 2, statutory: { pcb: 110 } }),
    );
    expect(unknown.rulesetUnknown).toBe(true);
    expect(unknown.rulesetChanged).toBe(false);
    expect(unknown.causes).toEqual([]);
  });

  it('e. a gross change clears needsDisclosure but still lists what moved', () => {
    const d = diffPayslipVersions(
      snap({ gross: 5000, statutory: { pcb: 100 } }),
      snap({ gross: 6000, version: 2, statutory: { pcb: 190 } }),
    );
    expect(d.grossChanged).toBe(true);
    expect(d.needsDisclosure).toBe(false);
    expect(d.moved.map((m) => m.key)).toEqual(['pcb']);
  });

  it('f. only real statutory MONEY lines count as a movement — audit members and cent dust do not', () => {
    // pcbMeta / exemptionUsed / componentVersions all legitimately differ between two calculations of
    // the same figures. Reporting them as "a statutory line moved" would cry wolf on every reprocess.
    const noise = diffPayslipVersions(
      snap({ statutory: { pcb: 100, pcbMeta: { pcbPaid: 300 }, exemptionUsed: { PCB_LIFESTYLE: 10 } } }),
      snap({
        version: 2,
        statutory: { pcb: 100, pcbMeta: { pcbPaid: 450 }, exemptionUsed: { PCB_LIFESTYLE: 25 }, componentVersions: { epf: '2026.5' } },
      }),
    );
    expect(noise.moved).toEqual([]);
    expect(noise.needsDisclosure).toBe(false);

    // Sub-cent float dust is not a movement (both sides round to cents, as core/payroll.ts does).
    expect(
      diffPayslipVersions(snap({ statutory: { pcb: 100.0 } }), snap({ statutory: { pcb: 100.0004 } })).moved,
    ).toEqual([]);

    // …but a line that was ABSENT and is now present IS one: cp38 is only stamped when non-zero.
    const appeared = diffPayslipVersions(snap({}), snap({ version: 2, statutory: { cp38: 250 } }));
    expect(appeared.moved).toEqual([{ key: 'cp38', before: 0, after: 250, delta: 250 }]);

    // Guard the allowlist itself: it is the set of reportable lines, not "every numeric key".
    expect([...STATUTORY_LINE_KEYS]).toContain('pcb');
    expect([...STATUTORY_LINE_KEYS]).not.toContain('pcbMeta');
    expect([...STATUTORY_LINE_KEYS]).not.toContain('exemptionUsed');
  });
});

describe('97a9b0ab — listRecomputeDisclosure (DB)', () => {
  let base: Base;
  let icSeq = 0;

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

  async function hire(name: string) {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 5000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `9003030${String(10000 + icSeq++).slice(-5)}` });
    return e;
  }

  /** Plant a recomputation event at a controlled instant (owner client — fixture insert, bypasses RLS). */
  const plant = (p: {
    batchId: string;
    employmentId: string;
    at: Date;
    before: PayslipSnapshot;
    after: PayslipSnapshot;
  }) =>
    owner.db.insert(schema.payrollEmployeeResultHistory).values({
      tenantId: base.tenantId,
      batchId: p.batchId,
      employmentId: p.employmentId,
      action: 'reprocess',
      actorType: 'user',
      actorId: null,
      versionBefore: 1,
      versionAfter: 2,
      before: p.before,
      after: p.after,
      createdAt: p.at,
    });

  it('g. an earlier month counts as a cause only when it was recomputed AFTER this slip was last computed', async () => {
    const a = adminCtx(base);
    const e1 = await hire('Cumulative One');
    const apr = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await generatePayslips(a, { batchId: apr.batchId });
    const may = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: may.batchId }); // → processed; this is T_prev for the first event

    const mayEventAt = new Date(Date.now() + 120_000);
    await plant({
      batchId: may.batchId,
      employmentId: e1.employmentId,
      at: mayEventAt,
      before: snap({ statutory: { pcb: 100 } }),
      after: snap({ version: 2, statutory: { pcb: 137.55 } }),
    });
    // April recomputed INSIDE the window (after May was processed, before the May event).
    await plant({
      batchId: apr.batchId,
      employmentId: e1.employmentId,
      at: new Date(Date.now() + 60_000),
      before: snap({ statutory: { pcb: 90 } }),
      after: snap({ version: 2, statutory: { pcb: 60 } }),
    });

    const inside = await listRecomputeDisclosure(a, { batchId: may.batchId });
    expect(inside).toHaveLength(1);
    expect(inside[0].employmentId).toBe(e1.employmentId);
    expect(inside[0].priorMonths).toEqual(['2026-04']);
    expect(inside[0].diff.needsDisclosure).toBe(true);
    expect(inside[0].diff.moved).toEqual([{ key: 'pcb', before: 100, after: 137.55, delta: 37.55 }]);
    // Same ruleset version on both sides ⇒ the ONLY cause named is the cumulative replay.
    expect(inside[0].diff.causes).toEqual(['prior_months_recomputed']);

    // Move that same April recomputation to BEFORE the May run was processed: it can no longer explain
    // anything (May already replayed the revised April), so the cause must disappear.
    await owner.db
      .update(schema.payrollEmployeeResultHistory)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(schema.payrollEmployeeResultHistory.batchId, apr.batchId));

    const outside = await listRecomputeDisclosure(a, { batchId: may.batchId });
    expect(outside).toHaveLength(1);
    expect(outside[0].priorMonths).toEqual([]);
    expect(outside[0].diff.causes).toEqual([]); // ⇒ the UI says "this payslip's own inputs"
    expect(outside[0].diff.needsDisclosure).toBe(true); // the movement is still disclosed
  });

  it('h. a recomputation in the PREVIOUS tax year is never a cause — PCB accumulators reset each year', async () => {
    const a = adminCtx(base);
    const e1 = await hire('Year Fence');
    // A prior-YEAR run for the same company. It needs no payslips: the fence is on pay_period alone.
    const dec = await createBatch(a, { companyId: base.companyId, payPeriod: '2025-12' });
    const jan = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: jan.batchId });

    await plant({
      batchId: jan.batchId,
      employmentId: e1.employmentId,
      at: new Date(Date.now() + 120_000),
      before: snap({ statutory: { pcb: 100 } }),
      after: snap({ version: 2, statutory: { pcb: 118 } }),
    });
    await plant({
      batchId: dec.batchId,
      employmentId: e1.employmentId,
      at: new Date(Date.now() + 60_000), // inside the window in TIME, but the wrong tax year
      before: snap({ statutory: { pcb: 90 } }),
      after: snap({ version: 2, statutory: { pcb: 60 } }),
    });

    const rows = await listRecomputeDisclosure(a, { batchId: jan.batchId });
    expect(rows).toHaveLength(1);
    expect(rows[0].priorMonths).toEqual([]);
    expect(rows[0].diff.causes).toEqual([]);
  });
});
