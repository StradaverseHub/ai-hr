/**
 * Typed pay-component services (Wave 3 #9, ADR-0025). Catalog management (admin), per-employment
 * recurring values (effective-dated like compensation), per-batch one-off values, plus backfill
 * helpers that seed components from the legacy compensation + payroll_input so the gated kernel path
 * is byte-identical. Every state-changing method appends a DomainEvent (substrate discipline).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  compensation,
  employment,
  employmentPayComponent,
  payComponent,
  payrollBatch,
  payrollBatchComponent,
  payrollInput,
  person,
} from '../db/schema';
import { MY_DEFAULT_PAY_COMPONENTS, BACKFILL_COMPONENT_CODES, type PayComponentSeed } from '../localization/my/pay-components';
import { parseCsvRecords } from '../lib/csv';

const money = (v: number) => Number(v).toFixed(2);

// ADR-0035 1A — constrained config vocabularies (stored as text, validated app-side).
// EA-form lines map a component to a Borang EA / C.P.8A Part B line so EA totals reconcile (#14).
export const EA_FORM_LINES = [
  'gross_salary',          // B.1(a) salary, wages, leave pay
  'bonus',                 // B.1(a) bonus / incentive (cash)
  'commission',            // B.1(a) fees, commission
  'allowance_taxable',     // B.1(a) taxable allowances
  'allowance_exempt',      // tax-exempt allowance (reported, not taxed)
  'bik',                   // B.2 benefit-in-kind / perquisite
  'vola',                  // B.3 value of living accommodation
  'esos',                  // B.1(c) ESOS / share scheme benefit
  'gratuity_compensation', // B.1(d)/B.5 gratuity / compensation for loss of employment
] as const;
export type EaFormLine = (typeof EA_FORM_LINES)[number];

// Per-component rounding of the payable amount (#15). 'none' = exact 2dp (legacy ⇒ byte-identical).
export const ROUNDING_METHODS = ['none', 'up', 'down', 'nearest'] as const;
export type RoundingMethod = (typeof ROUNDING_METHODS)[number];

const cleanEaLine = (v: unknown): string | null =>
  EA_FORM_LINES.includes(v as EaFormLine) ? (v as string) : null;
const cleanRounding = (v: unknown): RoundingMethod =>
  ROUNDING_METHODS.includes(v as RoundingMethod) ? (v as RoundingMethod) : 'none';

async function componentIdByCode(tx: Tx, tenantId: string, code: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: payComponent.id })
    .from(payComponent)
    .where(and(eq(payComponent.tenantId, tenantId), eq(payComponent.code, code)))
    .limit(1);
  return row?.id ?? null;
}

// ───────────────────────── Catalog ─────────────────────────

/** Idempotently upsert the Malaysia default catalog (by code). Admin-only via RLS. */
export function seedPayComponentCatalog(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    let created = 0;
    for (const c of MY_DEFAULT_PAY_COMPONENTS) {
      const existing = await componentIdByCode(tx, ctx.tenantId, c.code);
      if (existing) {
        await tx.update(payComponent).set(flagsOf(c)).where(eq(payComponent.id, existing));
      } else {
        await tx.insert(payComponent).values({ tenantId: ctx.tenantId, code: c.code, name: c.name, kind: c.kind, ...flagsOf(c) });
        created += 1;
      }
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'pay-component',
      aggregateId: ctx.tenantId, // catalog-level op keyed to the tenant
      eventType: 'pay-component.catalog.seeded',
      actor: actorOf(ctx),
      payload: { total: MY_DEFAULT_PAY_COMPONENTS.length, created },
    });
    return { total: MY_DEFAULT_PAY_COMPONENTS.length, created };
  });
}

const flagsOf = (c: Pick<PayComponentSeed, 'includedInEpf' | 'includedInSocsoEis' | 'includedInPcb' | 'includedInHrdfBase' | 'isNonPayable' | 'prorates'>) => ({
  includedInEpf: c.includedInEpf,
  includedInSocsoEis: c.includedInSocsoEis,
  includedInPcb: c.includedInPcb,
  includedInHrdfBase: c.includedInHrdfBase,
  isNonPayable: c.isNonPayable,
  prorates: c.prorates,
});

/** Current (open) recurring components for an employee, joined with the catalog (for the people page). */
export function listEmploymentPayComponents(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: employmentPayComponent.id,
        componentId: payComponent.id,
        code: payComponent.code,
        name: payComponent.name,
        kind: payComponent.kind,
        amount: employmentPayComponent.amount,
        validFrom: employmentPayComponent.validFrom,
      })
      .from(employmentPayComponent)
      .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
      .where(
        and(
          eq(employmentPayComponent.employmentId, employmentId),
          isNull(employmentPayComponent.validTo),
          isNull(employmentPayComponent.supersededAt),
        ),
      )
      .orderBy(payComponent.code),
  );
}

export function listPayComponents(ctx: SessionContext, opts: { includeArchived?: boolean } = {}) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.select().from(payComponent).where(eq(payComponent.tenantId, ctx.tenantId)).orderBy(payComponent.code);
    return opts.includeArchived ? rows : rows.filter((r) => r.archivedAt == null);
  });
}

export type PayComponentInput = {
  code: string;
  name: string;
  kind: 'allowance' | 'deduction' | 'contribution' | 'non_payable';
  includedInEpf: boolean;
  includedInSocsoEis: boolean;
  includedInPcb: boolean;
  includedInHrdfBase: boolean;
  isNonPayable: boolean;
  prorates: boolean;
  eaFormLine?: string | null;
  roundingMethod?: string;
};

const attrsOf = (p: PayComponentInput) => ({ eaFormLine: cleanEaLine(p.eaFormLine), roundingMethod: cleanRounding(p.roundingMethod) });

/** Admin upsert of a single catalog component (by code). */
export function upsertPayComponent(ctx: SessionContext, p: PayComponentInput) {
  return withTenant(ctx, async (tx) => {
    const existing = await componentIdByCode(tx, ctx.tenantId, p.code);
    let id: string;
    if (existing) {
      await tx.update(payComponent).set({ name: p.name, kind: p.kind, ...flagsOf(p), ...attrsOf(p) }).where(eq(payComponent.id, existing));
      id = existing;
    } else {
      const [row] = await tx
        .insert(payComponent)
        .values({ tenantId: ctx.tenantId, code: p.code, name: p.name, kind: p.kind, ...flagsOf(p), ...attrsOf(p) })
        .returning({ id: payComponent.id });
      id = row.id;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'pay-component',
      aggregateId: id,
      eventType: existing ? 'pay-component.updated' : 'pay-component.created',
      actor: actorOf(ctx),
      payload: { code: p.code },
    });
    return { id };
  });
}

/** Soft-retire a component: stops new use, preserves every historical reference. Always safe. */
export function archivePayComponent(ctx: SessionContext, id: string) {
  return withTenant(ctx, async (tx) => {
    await tx.update(payComponent).set({ archivedAt: new Date() }).where(eq(payComponent.id, id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'pay-component',
      aggregateId: id,
      eventType: 'pay-component.archived',
      actor: actorOf(ctx),
    });
    return { id };
  });
}

/** Thrown when a hard-delete is refused because the component is referenced (#21). */
export class PayComponentInUseError extends Error {
  constructor(public readonly refs: number) {
    super('pay-component-in-use');
    this.name = 'PayComponentInUseError';
  }
}

/**
 * Hard-delete a catalog component (#21). GUARDED: refuse if referenced by any recurring per-employment
 * value OR any batch line (draft or closed) — deleting would orphan those rows / past payslips. Callers
 * should use archivePayComponent to retire an in-use component instead. RLS confines all reads/writes to
 * the tenant + admin.
 */
export function deletePayComponent(ctx: SessionContext, id: string) {
  return withTenant(ctx, async (tx) => {
    const [rec] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(employmentPayComponent)
      .where(eq(employmentPayComponent.componentId, id));
    const [bat] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollBatchComponent)
      .where(eq(payrollBatchComponent.componentId, id));
    const refs = (rec?.n ?? 0) + (bat?.n ?? 0);
    if (refs > 0) throw new PayComponentInUseError(refs);
    await tx.delete(payComponent).where(eq(payComponent.id, id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'pay-component',
      aggregateId: id,
      eventType: 'pay-component.deleted',
      actor: actorOf(ctx),
    });
    return { id };
  });
}

// ───────────────────── Per-employment recurring ─────────────────────

/** Effective-dated upsert of a recurring component value for an employee (mirrors setCompensation). */
export function setEmploymentPayComponent(
  ctx: SessionContext,
  p: { employmentId: string; componentId: string; amount: number; effectiveFrom: string },
  outerTx?: Tx,
) {
  const run = async (tx: Tx) => {
    const [cur] = await tx
      .select({ id: employmentPayComponent.id })
      .from(employmentPayComponent)
      .where(
        and(
          eq(employmentPayComponent.employmentId, p.employmentId),
          eq(employmentPayComponent.componentId, p.componentId),
          isNull(employmentPayComponent.validTo),
          isNull(employmentPayComponent.supersededAt),
        ),
      )
      .limit(1);
    if (cur) {
      await tx.update(employmentPayComponent).set({ validTo: p.effectiveFrom }).where(eq(employmentPayComponent.id, cur.id));
    }
    const [row] = await tx
      .insert(employmentPayComponent)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        componentId: p.componentId,
        amount: money(p.amount),
        validFrom: p.effectiveFrom,
        validTo: null,
      })
      .returning({ id: employmentPayComponent.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment-pay-component',
      aggregateId: row.id,
      eventType: 'employment-pay-component.set',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // ADR-0030 Layer 0: amount lives on employment_pay_component[aggregateId]; reference, not cleartext.
      payload: { employmentId: p.employmentId, componentId: p.componentId, effectiveFrom: p.effectiveFrom },
    });
    return { id: row.id };
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
}

// ───────────────────── Per-batch one-off ─────────────────────

/**
 * Thrown at WRITE time when an admin tries to put a PCB-taxable component that v1 cannot tax onto a batch
 * — a non-payable/BIK, or a PCB-only earning (neither EPF nor SOCSO). The payroll kernel fails closed on
 * the same case at generate time (UnsupportedPayComponentError, ADR-0025 §5); this guard surfaces it at
 * entry/import time so the admin is told immediately, not after a green import when payroll won't run.
 */
export class UnsupportedBatchComponentError extends Error {
  constructor(public readonly code: string) {
    super(`Pay component "${code}" is PCB-taxable but cannot be computed in this version (non-payable/PCB-only). Remove it from the batch or use a payable component.`);
    this.name = 'UnsupportedBatchComponentError';
  }
}

/** The kernel's fail-closed condition (core/payroll.ts earningsOf), evaluated on a catalog row's flags. */
const isUnsupportedTaxableComponent = (c: { includedInEpf: boolean; includedInSocsoEis: boolean; includedInPcb: boolean; isNonPayable: boolean }) =>
  c.includedInPcb && (c.isNonPayable || (!c.includedInEpf && !c.includedInSocsoEis));

/** Upsert a one-off component value for an employee on a draft batch (by batch+employment+component). */
export function setPayrollBatchComponent(
  ctx: SessionContext,
  p: { batchId: string; employmentId: string; componentId: string; amount: number; notes?: string },
  outerTx?: Tx,
) {
  const run = async (tx: Tx) => {
    // Write-time guard parity with the kernel (ADR-0025 §5): reject a PCB-taxable BIK / PCB-only earning
    // here rather than letting a green write fail later at payslip generation.
    const [comp] = await tx
      .select({
        code: payComponent.code,
        includedInEpf: payComponent.includedInEpf,
        includedInSocsoEis: payComponent.includedInSocsoEis,
        includedInPcb: payComponent.includedInPcb,
        isNonPayable: payComponent.isNonPayable,
      })
      .from(payComponent)
      .where(eq(payComponent.id, p.componentId))
      .limit(1);
    if (comp && isUnsupportedTaxableComponent(comp)) throw new UnsupportedBatchComponentError(comp.code);
    const [cur] = await tx
      .select({ id: payrollBatchComponent.id })
      .from(payrollBatchComponent)
      .where(
        and(
          eq(payrollBatchComponent.batchId, p.batchId),
          eq(payrollBatchComponent.employmentId, p.employmentId),
          eq(payrollBatchComponent.componentId, p.componentId),
        ),
      )
      .limit(1);
    let id: string;
    if (cur) {
      await tx.update(payrollBatchComponent).set({ amount: money(p.amount), notes: p.notes ?? null }).where(eq(payrollBatchComponent.id, cur.id));
      id = cur.id;
    } else {
      const [row] = await tx
        .insert(payrollBatchComponent)
        .values({ tenantId: ctx.tenantId, batchId: p.batchId, employmentId: p.employmentId, componentId: p.componentId, amount: money(p.amount), notes: p.notes ?? null })
        .returning({ id: payrollBatchComponent.id });
      id = row.id;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch-component',
      aggregateId: id,
      eventType: 'payroll-batch-component.set',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // ADR-0030 Layer 0: amount lives on payroll_batch_component[aggregateId]; reference, not cleartext.
      payload: { batchId: p.batchId, componentId: p.componentId },
    });
    return { id };
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
}

// ───────────────────── Backfill (legacy → components) ─────────────────────

/** Seed BASIC + ALLOWANCE recurring components from every open compensation row. Idempotent-ish:
 *  setEmploymentPayComponent supersedes the prior open value, so re-running just re-states it. */
export function backfillEmploymentComponentsFromCompensation(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    const basicId = await componentIdByCode(tx, ctx.tenantId, BACKFILL_COMPONENT_CODES.basic);
    const allowId = await componentIdByCode(tx, ctx.tenantId, BACKFILL_COMPONENT_CODES.allowance);
    if (!basicId || !allowId) throw new Error('Pay-component catalog not seeded — run seedPayComponentCatalog first.');
    const comps = await tx
      .select()
      .from(compensation)
      .where(and(isNull(compensation.validTo), isNull(compensation.supersededAt)));
    let count = 0;
    for (const c of comps) {
      await setEmploymentPayComponent(ctx, { employmentId: c.employmentId, componentId: basicId, amount: Number(c.basicSalary), effectiveFrom: c.validFrom }, tx);
      await setEmploymentPayComponent(ctx, { employmentId: c.employmentId, componentId: allowId, amount: Number(c.monthlyAllowance ?? 0), effectiveFrom: c.validFrom }, tx);
      count += 1;
    }
    return { employments: count };
  });
}

/** Seed OVERTIME / BONUS / CLAIM one-off components for a draft batch from its payroll_input rows. */
export function backfillBatchComponentsFromInput(ctx: SessionContext, batchId: string) {
  return withTenant(ctx, async (tx) => {
    const otId = await componentIdByCode(tx, ctx.tenantId, BACKFILL_COMPONENT_CODES.overtime);
    const bonusId = await componentIdByCode(tx, ctx.tenantId, BACKFILL_COMPONENT_CODES.bonus);
    const claimId = await componentIdByCode(tx, ctx.tenantId, BACKFILL_COMPONENT_CODES.claim);
    if (!otId || !bonusId || !claimId) throw new Error('Pay-component catalog not seeded.');
    const inputs = await tx.select().from(payrollInput).where(eq(payrollInput.batchId, batchId));
    let count = 0;
    for (const i of inputs) {
      if (Number(i.overtimeAmount) > 0) await setPayrollBatchComponent(ctx, { batchId, employmentId: i.employmentId, componentId: otId, amount: Number(i.overtimeAmount) }, tx);
      if (Number(i.bonusAmount) > 0) await setPayrollBatchComponent(ctx, { batchId, employmentId: i.employmentId, componentId: bonusId, amount: Number(i.bonusAmount) }, tx);
      if (Number(i.claimAllowance) > 0) await setPayrollBatchComponent(ctx, { batchId, employmentId: i.employmentId, componentId: claimId, amount: Number(i.claimAllowance) }, tx);
      count += 1;
    }
    return { inputs: count };
  });
}

// ───────────────────── CSV import of one-off batch components (ADR-0035 1D, #12) ─────────────────────

export type ComponentImportRow = {
  line: number;
  employee: string;
  name: string | null;
  code: string;
  componentName: string | null;
  amount: number | null;
  notes: string | null;
  ok: boolean;
  error: string | null;
};
export type ComponentImportResult = { dryRun: boolean; rows: ComponentImportRow[]; valid: number; imported: number };

/**
 * Bulk-load one-off pay-component lines (allowance/deduction/OT/bonus — any catalog component) onto a DRAFT
 * batch from CSV (columns: employee[/email], component[/code], amount, notes). Reconciles employee email →
 * employment in the batch's company and component code → catalog; dry-run previews + flags every bad row,
 * commit upserts via setPayrollBatchComponent (each event-logged). The server re-reconciles on commit — the
 * client preview is never trusted. Only meaningful with TYPED_PAY_COMPONENTS_ENABLED (kernel reads these).
 */
export async function importBatchComponents(
  ctx: SessionContext,
  p: { batchId: string; csvText: string; dryRun: boolean },
): Promise<ComponentImportResult> {
  const { records } = parseCsvRecords(p.csvText);
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ id: payrollBatch.id, companyId: payrollBatch.companyId, status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('Batch not found.');
    if (batch.status !== 'draft') throw new Error('Components can only be imported into a draft batch.');

    const emps = await tx
      .select({ employmentId: employment.id, email: person.primaryEmail, name: person.fullName })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(employment.companyId, batch.companyId));
    const byEmail = new Map(emps.filter((e) => e.email).map((e) => [e.email!.toLowerCase(), e]));

    const comps = await tx
      .select({
        id: payComponent.id,
        code: payComponent.code,
        name: payComponent.name,
        includedInEpf: payComponent.includedInEpf,
        includedInSocsoEis: payComponent.includedInSocsoEis,
        includedInPcb: payComponent.includedInPcb,
        isNonPayable: payComponent.isNonPayable,
      })
      .from(payComponent)
      .where(and(eq(payComponent.tenantId, ctx.tenantId), isNull(payComponent.archivedAt)));
    const byCode = new Map(comps.map((c) => [c.code.toUpperCase(), c]));

    const rows: ComponentImportRow[] = records.map((rec, i) => {
      const employee = rec.employee || rec.email || rec.employee_email || '';
      const code = (rec.component || rec.component_code || rec.code || '').toUpperCase();
      const amountRaw = rec.amount ?? '';
      const emp = byEmail.get(employee.toLowerCase());
      const comp = byCode.get(code);
      const amount = amountRaw === '' ? NaN : Number(amountRaw);
      let error: string | null = null;
      if (!employee) error = 'Missing employee';
      else if (!emp) error = `Unknown employee: ${employee}`;
      else if (!code) error = 'Missing component';
      else if (!comp) error = `Unknown component: ${code}`;
      else if (!Number.isFinite(amount)) error = `Invalid amount: ${amountRaw}`;
      // Write-time guard parity (ADR-0025 §5): a PCB-taxable BIK / PCB-only earning is unprocessable by the
      // v1 kernel — flag it in the preview so the admin is told here, not after a green import.
      else if (isUnsupportedTaxableComponent(comp)) error = `Unsupported component: ${code} (PCB-taxable non-payable / PCB-only)`;
      return {
        line: i + 2,
        employee,
        name: emp?.name ?? null,
        code,
        componentName: comp?.name ?? null,
        amount: Number.isFinite(amount) ? amount : null,
        notes: rec.notes || null,
        ok: !error,
        error,
      };
    });

    let imported = 0;
    if (!p.dryRun) {
      for (const r of rows) {
        if (!r.ok) continue;
        const emp = byEmail.get(r.employee.toLowerCase())!;
        const comp = byCode.get(r.code)!;
        await setPayrollBatchComponent(ctx, { batchId: p.batchId, employmentId: emp.employmentId, componentId: comp.id, amount: r.amount!, notes: r.notes ?? undefined }, tx);
        imported += 1;
      }
    }
    return { dryRun: p.dryRun, rows, valid: rows.filter((r) => r.ok).length, imported };
  });
}
