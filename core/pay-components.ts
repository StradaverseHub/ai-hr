/**
 * Typed pay-component services (Wave 3 #9, ADR-0025). Catalog management (admin), per-employment
 * recurring values (effective-dated like compensation), per-batch one-off values, plus backfill
 * helpers that seed components from the legacy compensation + payroll_input so the gated kernel path
 * is byte-identical. Every state-changing method appends a DomainEvent (substrate discipline).
 */
import { and, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  attendance,
  compensation,
  employment,
  employmentPayComponent,
  payComponent,
  payrollBatch,
  payrollBatchComponent,
  payrollInput,
  person,
} from '../db/schema';
import { countryPacks } from '../localization/registry';
import type { PayComponentSeed, PcbExemptionTable, PcbRemunerationType } from '../localization/country-pack';
import { parseCsvRecords } from '../lib/csv';
import {
  payRuleDependencies as payRuleDependenciesOf,
  planResolutionOrder,
  resolvePayComponentSet,
  validatePayRule,
  validatePayRuleAgainstCatalog,
  type PayRule,
  type PayRuleCatalogNode,
  type PayRuleErrorCode,
} from './pay-rule';

// ── Pack-supplied vocabulary (ADR-0080 D6, rung 5a) ──────────────────────────────────────────────
// The default catalog, the backfill-critical code roles, and the LHDN PCB classification vocabulary
// all come from the registered country packs — no direct localization/my import. The catalog and its
// classification validation are TENANT-level (there is no acting company on a catalog save), so the
// vocabulary is the union across registered packs, in registration order — byte-identical with MY as
// the only pack; per-company narrowing is a later slice (ADR-0080 §6).
const DEFAULT_PAY_COMPONENTS: PayComponentSeed[] = countryPacks().flatMap((p) => p.payComponents.defaults);
const BACKFILL_COMPONENT_CODES: { basic: string; allowance: string; overtime: string; bonus: string; claim: string } =
  Object.assign({}, ...countryPacks().map((p) => p.payComponents.backfillCodes));

/** The remuneration-type vocabulary for pay-code PCB classification (feedback 09b554e9), pack-supplied.
 *  Re-exported so service-side callers keep a single import point; the client form island imports the
 *  pack's pure statutory-tables module directly (db-free — a 5b-slice cutover). */
export const PCB_REMUNERATION_TYPES: readonly PcbRemunerationType[] = countryPacks().flatMap(
  (p) => p.payroll.pcbRemunerationTypes,
);
/** Exemption-code list valid for a remuneration type — merged across the registered packs' built-ins. */
export function pcbExemptionCodesFor(type: PcbRemunerationType): PcbExemptionTable {
  return Object.assign({}, ...countryPacks().map((p) => p.payroll.pcbExemptionCodesFor(type)));
}
export type { PcbRemunerationType } from '../localization/country-pack';

const money = (v: number) => Number(v).toFixed(2);

// Feedback 3c473773 — re-exported so callers (the maintenance form, its action, the tests) have one import
// point for the payroll-category vocabulary, mirroring PCB_REMUNERATION_TYPES above.
import { cleanDisplayCategory } from './pay-display-category';
export { PAY_DISPLAY_CATEGORIES, cleanDisplayCategory, type PayDisplayCategory } from './pay-display-category';

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

// Fixed Transaction screen (feedback b7fc8583) — the Payroll Cycle taxonomy. REUSES the existing
// payroll_run_type enum values (the product's real cycle master keyed by the multi-cycle engine); no new
// vocabulary. Stored constrained on employment_pay_component.run_type; null = unspecified.
export const FIXED_TRANSACTION_CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;
export type FixedTransactionCycle = (typeof FIXED_TRANSACTION_CYCLES)[number];
// Coerce any input to a valid cycle or null — an unknown value (URL tamper, stale form) becomes null
// (unspecified) rather than being persisted or leaking into the event payload.
const cleanCycle = (v: unknown): FixedTransactionCycle | null =>
  FIXED_TRANSACTION_CYCLES.includes(v as FixedTransactionCycle) ? (v as FixedTransactionCycle) : null;

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
    for (const c of DEFAULT_PAY_COMPONENTS) {
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
      payload: { total: DEFAULT_PAY_COMPONENTS.length, created },
    });
    return { total: DEFAULT_PAY_COMPONENTS.length, created };
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

/**
 * Recurring components for an employee, joined with the catalog (for the people page).
 *
 * 1.2.1 Fixed Transaction made this period-aware: it no longer hard-filters `isNull(validTo)`. Superseded
 * rows are still excluded (`isNull(supersededAt)` — they were replaced by a newer value), but END-DATED rows
 * (validTo set, supersededAt null) ARE returned so the UI can show them with an "ended" badge. The two
 * inactive states are now distinguished: superseded ⇒ hidden, ended ⇒ shown as ended. The UI derives
 * `active` vs `ended` from validTo against today. `prorates` (catalog) is selected so the UI can render the
 * resolved prorate (override ?? catalog).
 */
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
        validTo: employmentPayComponent.validTo,
        currency: employmentPayComponent.currency,
        prorateOverride: employmentPayComponent.prorateOverride,
        prorates: payComponent.prorates,
        remarks: employmentPayComponent.remarks,
        // Fixed Transaction screen (feedback b7fc8583) — the Payroll Cycle tag (null = unspecified).
        runType: employmentPayComponent.runType,
      })
      .from(employmentPayComponent)
      .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
      .where(
        and(
          eq(employmentPayComponent.employmentId, employmentId),
          isNull(employmentPayComponent.supersededAt),
        ),
      )
      .orderBy(payComponent.code, employmentPayComponent.validFrom),
  );
}

export function listPayComponents(ctx: SessionContext, opts: { includeArchived?: boolean } = {}) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.select().from(payComponent).where(eq(payComponent.tenantId, ctx.tenantId)).orderBy(payComponent.code);
    return opts.includeArchived ? rows : rows.filter((r) => r.archivedAt == null);
  });
}

/**
 * Feature 1.2 (Transaction sub-module) — the catalog components an admin may put on a draft batch via the
 * guided single-row Individual Transaction form. Excludes archived AND the kernel's unsupported-taxable
 * class (a PCB-taxable BIK / PCB-only earning) so the picker never offers a component that
 * setPayrollBatchComponent would reject at write time (UnsupportedBatchComponentError). Same predicate the
 * CSV importer enforces — the picker is the front-line filter, the service throw is the backstop.
 */
export function listSupportedBatchComponents(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.select().from(payComponent).where(eq(payComponent.tenantId, ctx.tenantId)).orderBy(payComponent.code);
    return rows
      .filter((r) => r.archivedAt == null && !isUnsupportedTaxableComponent(r))
      .map((r) => ({ id: r.id, code: r.code, name: r.name, kind: r.kind }));
  });
}

export type PayComponentInput = {
  code: string;
  name: string;
  // Pay Items redesign (feedback 4994a48f): optional short display name ("Transport") for payslips and
  // reports later. undefined ⇒ leave the stored value untouched (existing callers that predate the field
  // must not wipe it); ''/null ⇒ stored as null. Deliberately NO uniqueness rule (house precedent:
  // department/cost_center/position/business_unit all carry the same optional label with none).
  label?: string | null;
  kind: 'allowance' | 'deduction' | 'contribution' | 'non_payable';
  includedInEpf: boolean;
  includedInSocsoEis: boolean;
  includedInPcb: boolean;
  includedInHrdfBase: boolean;
  isNonPayable: boolean;
  prorates: boolean;
  eaFormLine?: string | null;
  roundingMethod?: string;
  // Configurable pay-rule (Payroll Setup). null / undefined / { kind: 'fixed' } ⇒ legacy fixed-amount behaviour.
  rule?: PayRule | null;
  // LHDN PCB 2026 classification (feedback 09b554e9). ALL THREE undefined ⇒ "not supplied" — legacy callers
  // (seed, backfills, pre-existing tests) leave the stored classification untouched and skip the mandatory
  // validation below. The maintenance form ALWAYS supplies them, so the guard is server-authoritative for
  // every UI save. epfBonus2012 requires includedInEpf; with includedInPcb, both PCB fields are mandatory
  // and the code must belong to the selected remuneration type's list.
  epfBonus2012?: boolean;
  pcbRemunerationType?: PcbRemunerationType | null;
  pcbExemptionCode?: string | null;
  // Feedback 3c473773 — the PAYROLL CATEGORY (which box on the payslip this item prints in). undefined ⇒
  // "not supplied" ⇒ leave the stored value untouched, so the seed, the backfills and every pre-existing
  // caller keep the classification migration 0393 wrote. '' / null ⇒ stored NULL ⇒ the box is inferred, as
  // it was before 0393. An unrecognised value never persists (cleanDisplayCategory).
  displayCategory?: string | null;
};

// ── LHDN PCB 2026 classification validation (feedback 09b554e9) ──

export type PayComponentStatutoryErrorCode =
  | 'pcbRemunerationTypeRequired'
  | 'pcbExemptionTypeRequired'
  | 'pcbExemptionTypeInvalid'
  | 'epfBonusRequiresEpf';

/** Thrown when a save carries an incomplete/inconsistent statutory classification. Carries the stable error
 *  CODE so the UI maps it to a localised payComponents.errorStatutory_* message (mirrors PayRuleInvalidError). */
export class PayComponentStatutoryConfigError extends Error {
  constructor(public readonly code: PayComponentStatutoryErrorCode) {
    super(`pay-component-statutory-config:${code}`);
    this.name = 'PayComponentStatutoryConfigError';
  }
}

/** Coerce any input to a valid remuneration type or null (URL/form tamper never persists). */
const cleanRemunerationType = (v: unknown): PcbRemunerationType | null =>
  PCB_REMUNERATION_TYPES.includes(v as PcbRemunerationType) ? (v as PcbRemunerationType) : null;

/**
 * PURE classification validator (server-authoritative; the form island mirrors it client-side by
 * construction). Only enforced when the input SUPPLIES the classification fields — legacy callers that
 * predate them (seed/backfill/tests) pass undefined and keep their stored values untouched.
 */
export function validateStatutoryClassification(p: {
  includedInEpf: boolean;
  includedInPcb: boolean;
  epfBonus2012?: boolean;
  pcbRemunerationType?: PcbRemunerationType | null;
  pcbExemptionCode?: string | null;
}): { ok: true } | { ok: false; code: PayComponentStatutoryErrorCode } {
  if (p.epfBonus2012 && !p.includedInEpf) return { ok: false, code: 'epfBonusRequiresEpf' };
  const supplied = p.pcbRemunerationType !== undefined || p.pcbExemptionCode !== undefined;
  if (!supplied || !p.includedInPcb) return { ok: true };
  const remType = cleanRemunerationType(p.pcbRemunerationType);
  if (!remType) return { ok: false, code: 'pcbRemunerationTypeRequired' };
  const code = p.pcbExemptionCode ?? null;
  if (!code) return { ok: false, code: 'pcbExemptionTypeRequired' };
  if (!(code in pcbExemptionCodesFor(remType))) return { ok: false, code: 'pcbExemptionTypeInvalid' };
  return { ok: true };
}

/**
 * Thrown when an upserted component carries a structurally-invalid rule (out-of-enum kind, out-of-bounds
 * number, or a per_day/per_hour rule on a prorating component — the double-proration conflict). Carries the
 * stable error CODE so the UI maps it to a localised payRule.errors.* message (no raw English to the screen).
 * Mirrors PayComponentInUseError.
 */
export class PayRuleInvalidError extends Error {
  constructor(public readonly code: PayRuleErrorCode) {
    super(`pay-rule-invalid:${code}`);
    this.name = 'PayRuleInvalidError';
  }
}

const attrsOf = (p: PayComponentInput) => ({ eaFormLine: cleanEaLine(p.eaFormLine), roundingMethod: cleanRounding(p.roundingMethod) });
// Feedback 3c473773 — payroll category storage. undefined ⇒ the field was not supplied ⇒ {} ⇒ the stored
// value survives (this is what keeps the seed and the backfills from wiping migration 0393's work). A
// supplied value is coerced to the closed vocabulary or NULL, so a tampered form never persists a box the
// kernel would not recognise.
const displayCategoryOf = (p: PayComponentInput) =>
  p.displayCategory === undefined ? {} : { displayCategory: cleanDisplayCategory(p.displayCategory) };
// LHDN PCB 2026 classification storage (feedback 09b554e9): all three undefined ⇒ "not supplied" ⇒ leave the
// stored values untouched (legacy caller). Supplied: EPF Bonus 2012 only sticks with EPF ticked, and the two
// PCB fields are cleared to null when PCB itself is unticked (an untaxed code carries no PCB classification).
const classificationOf = (p: PayComponentInput) =>
  p.epfBonus2012 === undefined && p.pcbRemunerationType === undefined && p.pcbExemptionCode === undefined
    ? {}
    : {
        epfBonus2012: (p.epfBonus2012 ?? false) && p.includedInEpf,
        pcbRemunerationType: p.includedInPcb ? cleanRemunerationType(p.pcbRemunerationType) : null,
        pcbExemptionCode: p.includedInPcb ? (p.pcbExemptionCode ?? null) : null,
      };
// Label normalisation: undefined ⇒ "not supplied" (leave as-is on update / null on insert); trimmed-blank ⇒ null.
const cleanLabel = (v: string | null | undefined): string | null | undefined =>
  v === undefined ? undefined : (v?.trim() || null);
// Normalise the rule for storage: a null / fixed rule is stored as null so an unconfigured component stays
// byte-identical to the legacy fixed-amount path (and the compat golden never sees a non-null rule column).
const ruleOf = (p: PayComponentInput): PayRule | null => (p.rule == null || p.rule.kind === 'fixed' ? null : p.rule);

/**
 * Pay Items redesign (feedback 4994a48f) — code lookup across ALL rows INCLUDING archived, for the
 * create-mode duplicate guard at the action boundary. upsertPayComponent stays upsert-by-code (the seed
 * depends on that idempotency); the CREATE form path must instead refuse a collision — one message for an
 * active hit, another for "deactivated — reactivate it instead" — because componentIdByCode has no
 * archivedAt filter and a silent upsert would overwrite a live code's entire statutory configuration.
 */
export function lookupPayComponentByCode(ctx: SessionContext, code: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: payComponent.id, code: payComponent.code, archivedAt: payComponent.archivedAt })
      .from(payComponent)
      .where(and(eq(payComponent.tenantId, ctx.tenantId), eq(payComponent.code, code)))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Pay Code maintenance split-screen (feedback 911b2886) — thrown when a CREATE collides with an existing
 * code. Carries the code plus whether the colliding row is archived, so the UI can distinguish "already
 * exists" from "exists but deactivated — reactivate it instead" (the silent black-hole case: upsert-by-code
 * would update the invisible archived row without ever clearing archivedAt). Mirrors PayComponentInUseError.
 */
export class PayComponentCodeExistsError extends Error {
  constructor(public readonly code: string, public readonly archived: boolean) {
    super(`pay-component-code-exists:${code}`);
    this.name = 'PayComponentCodeExistsError';
  }
}

/**
 * Create a NEW catalog component (feedback 911b2886). upsertPayComponent is deliberately upsert-by-code
 * (the seed depends on that idempotency) with NO uniqueness rejection — so the dedicated create screen,
 * where the catalog list is no longer visible beside the form, must refuse a collision instead of silently
 * overwriting the existing row's statutory configuration. Looks the code up across ALL rows INCLUDING
 * archived, throws PayComponentCodeExistsError on a hit, else delegates to upsertPayComponent unchanged
 * (single validation/event path — the insert branch emits pay-component.created).
 */
export async function createPayComponent(ctx: SessionContext, p: PayComponentInput) {
  const hit = await lookupPayComponentByCode(ctx, p.code);
  if (hit) throw new PayComponentCodeExistsError(p.code, hit.archivedAt != null);
  return upsertPayComponent(ctx, p);
}

// The diffable catalog fields for the trimmed audit payload (changed field NAMES only — no values:
// app/admin/audit/page.tsx never renders payloads, and free-text name/label in the immutable event
// stream would violate the payload discipline the comment below enforces).
const DIFF_FIELDS = ['name', 'label', 'kind', 'includedInEpf', 'includedInSocsoEis', 'includedInPcb', 'includedInHrdfBase', 'isNonPayable', 'prorates', 'eaFormLine', 'roundingMethod', 'rule', 'epfBonus2012', 'pcbRemunerationType', 'pcbExemptionCode', 'displayCategory'] as const;

// ── 61bf109d — dependency-graph plumbing ─────────────────────────────────────────────────────────────
// A pay item may now be a percentage of ANOTHER pay item, or a formula that reads one, so the catalog is a
// dependency graph. These two helpers are the only place that graph is loaded and its order written.

/** The tenant's catalog as the graph planner sees it (archived rows INCLUDED so a reference to a retired
 *  code is rejected as such rather than silently reading 0). */
async function catalogNodesTx(tx: Tx, tenantId: string): Promise<PayRuleCatalogNode[]> {
  const rows = await tx
    .select({ code: payComponent.code, rule: payComponent.rule, kind: payComponent.kind, archivedAt: payComponent.archivedAt })
    .from(payComponent)
    .where(eq(payComponent.tenantId, tenantId));
  return rows.map((r) => ({ code: r.code, rule: r.rule, kind: r.kind, archived: r.archivedAt != null }));
}

/**
 * Recompute the whole catalog's topological rank and persist it on pay_component.resolution_order. Called
 * inside the save transaction, AFTER the row is written, so it plans the graph that will actually run.
 *
 * planResolutionOrder cannot fail here — validatePayRuleAgainstCatalog already refused every cycle on the
 * way in — but the result is checked rather than asserted: if it ever did, leaving the previous ranks in
 * place is the fail-safe outcome (the run keeps using the last order that was proven acyclic).
 */
async function recordResolutionOrderTx(tx: Tx, tenantId: string): Promise<void> {
  const rows = await tx
    .select({ id: payComponent.id, code: payComponent.code, rule: payComponent.rule, resolutionOrder: payComponent.resolutionOrder })
    .from(payComponent)
    .where(eq(payComponent.tenantId, tenantId));
  const plan = planResolutionOrder(rows.map((r) => ({ code: r.code, rule: r.rule })));
  if (!plan.ok) return;
  for (const r of rows) {
    const next = plan.order.get(r.code.trim().toUpperCase()) ?? 0;
    if (next !== r.resolutionOrder) {
      await tx.update(payComponent).set({ resolutionOrder: next }).where(eq(payComponent.id, r.id));
    }
  }
}

/** Admin upsert of a single catalog component (by code). Validates the rule against the component's
 *  proration flag before any write (throws PayRuleInvalidError on failure — same proration/sign/bounds
 *  contract the kernel and the AI validator enforce, from the one pure validatePayRule). */
export function upsertPayComponent(ctx: SessionContext, p: PayComponentInput) {
  return withTenant(ctx, async (tx) => {
    const rule = ruleOf(p);
    const v = validatePayRule(rule, p.prorates);
    if (!v.ok) throw new PayRuleInvalidError(v.code);
    // ── 61bf109d — the CATALOG-AWARE half of the guard, refused at SAVE time ────────────────────────
    // A rule may now name another pay item, so structural validity is no longer enough: the referenced
    // code must exist and be active, must not be a legislated statutory line, and the resulting graph must
    // be acyclic. Discovering a cycle mid-run would mean a half-computed payroll, so it is refused here.
    const catalog = await catalogNodesTx(tx, ctx.tenantId);
    const g = validatePayRuleAgainstCatalog({ code: p.code, rule, kind: p.kind }, catalog);
    if (!g.ok) throw new PayRuleInvalidError(g.code);
    // LHDN PCB 2026 classification guard (feedback 09b554e9) — no-op for legacy callers that don't supply
    // the fields; server-authoritative for every form save (create delegates here — single path).
    const cls = validateStatutoryClassification(p);
    if (!cls.ok) throw new PayComponentStatutoryConfigError(cls.code);
    const label = cleanLabel(p.label);
    // Full row (not just the id) so the event can carry the changed-field-name list + archived state
    // without a second SELECT.
    const [existing] = await tx
      .select()
      .from(payComponent)
      .where(and(eq(payComponent.tenantId, ctx.tenantId), eq(payComponent.code, p.code)))
      .limit(1);
    let id: string;
    let changed: string[] = [];
    if (existing) {
      const next = { name: p.name, kind: p.kind, ...flagsOf(p), ...attrsOf(p), ...classificationOf(p), ...displayCategoryOf(p), rule, ...(label !== undefined ? { label } : {}) };
      changed = DIFF_FIELDS.filter((f) => {
        if (!(f in next)) return false; // label omitted ⇒ untouched ⇒ not a change
        const a = (next as Record<string, unknown>)[f];
        const b = (existing as unknown as Record<string, unknown>)[f];
        return f === 'rule' ? JSON.stringify(a ?? null) !== JSON.stringify(b ?? null) : a !== b;
      });
      await tx.update(payComponent).set(next).where(eq(payComponent.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await tx
        .insert(payComponent)
        .values({ tenantId: ctx.tenantId, code: p.code, name: p.name, label: label ?? null, kind: p.kind, ...flagsOf(p), ...attrsOf(p), ...classificationOf(p), ...displayCategoryOf(p), rule })
        .returning({ id: payComponent.id });
      id = row.id;
    }
    // 61bf109d — RECORD the resolution order for the whole catalog now that the graph has changed. It is
    // recomputed rather than patched because one edited rule can re-rank items that were not touched, and
    // it is written INSIDE the same transaction as the rule, so the order and the rule it was derived from
    // can never disagree. Only rows whose rank actually moved are written (a catalog of fixed amounts
    // issues no UPDATE at all, so the byte-identical legacy path stays write-free).
    await recordResolutionOrderTx(tx, ctx.tenantId);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'pay-component',
      aggregateId: id,
      eventType: existing ? 'pay-component.updated' : 'pay-component.created',
      actor: actorOf(ctx),
      // No PII, no amounts, no field VALUES — the code, which rule kind (null when fixed/unconfigured),
      // which fields changed (names only) and whether the row is archived (actor/time live on the event).
      payload: { code: p.code, ruleKind: rule?.kind ?? null, changed, archived: existing ? existing.archivedAt != null : false },
    });
    return { id };
  });
}

/**
 * Soft-retire OR reinstate a component (house toggle shape — mirrors archiveDepartment / archivePosition /
 * archiveCostCenter / archiveBusinessUnit / archiveJobGrade / archiveLeaveType in core/admin.ts).
 * Archiving stops new use and preserves every historical reference; unarchiving reactivates the code.
 * Unlike leave_type, pay_component_code_uq (db/schema.ts) is NOT partial on archived_at — the code stays
 * reserved while archived — so unarchiving cannot trip a unique violation and the DuplicateError catch
 * those core/admin.ts call sites carry is unnecessary here.
 */
export function archivePayComponent(ctx: SessionContext, p: { id: string; archived: boolean }) {
  return withTenant(ctx, async (tx) => {
    await tx.update(payComponent).set({ archivedAt: p.archived ? sql`now()` : null }).where(eq(payComponent.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'pay-component',
      aggregateId: p.id,
      eventType: p.archived ? 'pay-component.archived' : 'pay-component.unarchived',
      actor: actorOf(ctx),
    });
    return { id: p.id };
  });
}

/** Thrown when a hard-delete is refused because the component is referenced (#21). */
export class PayComponentInUseError extends Error {
  constructor(public readonly refs: number) {
    super('pay-component-in-use');
    this.name = 'PayComponentInUseError';
  }
}

// ── 61bf109d — "show me what this produces for a real employee, before I save" ───────────────────────
// The preview is a DRY RUN: it opens the tenant transaction read-only, writes nothing, appends no event,
// and returns a figure plus the exact inputs that figure came from. Critically it calls
// resolvePayComponentSet — the SAME function core/payroll.ts's kernel calls — rather than a parallel
// implementation, so a preview that disagrees with the run is not merely unlikely, it is unrepresentable.

/** A pickable employee for the preview selector. */
export type PayRulePreviewCandidate = { employmentId: string; name: string; basic: number };

export type PayRulePreviewResult =
  | {
      ok: true;
      /** What this pay item would resolve to for this employee, in ringgit (unrounded — the kernel applies
       *  the component's own rounding and the tenure factor afterwards). */
      amount: number;
      /** The real figures the formula read, so the admin can check the arithmetic rather than trust it. */
      scope: { basic: number; days: number; hours: number };
      /** Every OTHER pay item the rule referenced, with the amount it resolved to for this employee. */
      inputs: { code: string; amount: number }[];
    }
  | { ok: false; code: PayRuleErrorCode };

/** Employees who can be previewed against: active employments with a compensation record, newest first. */
export function listPayRulePreviewCandidates(ctx: SessionContext, limit = 50) {
  return withTenant(ctx, async (tx): Promise<PayRulePreviewCandidate[]> => {
    const rows = await tx
      .select({
        employmentId: employment.id,
        firstName: person.firstName,
        lastName: person.lastName,
        basic: compensation.basicSalary,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(
        compensation,
        and(eq(compensation.employmentId, employment.id), isNull(compensation.validTo), isNull(compensation.supersededAt)),
      )
      .where(and(eq(employment.tenantId, ctx.tenantId), isNull(employment.terminatedOn)))
      .orderBy(desc(employment.hiredOn))
      .limit(limit);
    return rows.map((r) => ({
      employmentId: r.employmentId,
      name: `${r.firstName} ${r.lastName}`.trim(),
      basic: Number(r.basic ?? 0),
    }));
  });
}

/**
 * Evaluate a CANDIDATE rule (not yet saved) for one real employee over one period.
 *
 * It runs the SAME two guards the save path runs — structural validatePayRule, then the catalog-aware
 * validatePayRuleAgainstCatalog — so the preview cannot show a figure for a rule that Save would reject;
 * the admin sees the rejection at the same moment either way.
 *
 * `days` is the period's calendar day count and `hours` the employee's actual attendance total for the
 * period (the same aggregate over attendance.worked_minutes the kernel takes).
 *
 * KNOWN, DELIBERATE DIVERGENCE — read before trusting this for a mid-period joiner. The kernel's scope uses
 * `daysWorked = prorationFactor × daysInMonth`, i.e. the EA-1955 tenure factor is baked into the day count;
 * this preview uses the FULL period (factor 1), and it does not apply the component's rounding either. For a
 * full-tenure employee — the ordinary case — preview and run therefore agree exactly. For a joiner/leaver
 * whose rule reads `days`, the preview is the full-period figure and the run will be the prorated one.
 * That is why the returned `scope` reports the day count it used and the panel is labelled "for a FULL
 * period, before proration and rounding": the difference is stated on screen rather than hidden. Replicating
 * prorationFactor here would mean re-resolving the employee's payroll policy, which is the parallel
 * implementation this design is trying to avoid — the ARITHMETIC is shared, and the period scaling is
 * declared. The returned `scope` makes every input visible so the number is checkable rather than magic.
 */
export function previewPayRule(
  ctx: SessionContext,
  p: {
    code: string;
    rule: PayRule | null;
    kind: PayComponentInput['kind'];
    prorates: boolean;
    employmentId: string;
    /** Defaults to the current calendar month. */
    periodStart?: string;
    periodEnd?: string;
  },
) {
  return withTenant(ctx, async (tx): Promise<PayRulePreviewResult> => {
    const code = p.code.trim().toUpperCase();
    const structural = validatePayRule(p.rule, p.prorates);
    if (!structural.ok) return { ok: false, code: structural.code };
    const catalog = await catalogNodesTx(tx, ctx.tenantId);
    const graph = validatePayRuleAgainstCatalog({ code, rule: p.rule, kind: p.kind }, catalog);
    if (!graph.ok) return { ok: false, code: graph.code };

    const now = new Date();
    const periodStart = p.periodStart ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const periodEnd = p.periodEnd ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const days = Math.round((Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000) + 1;

    // The employee's authoritative basic — the Personnel compensation record, exactly what the kernel's
    // `rscope.basic` reads (feedback 64fb5e48: Personnel is the ONLY basic source).
    const [comp] = await tx
      .select({ basic: compensation.basicSalary })
      .from(compensation)
      .where(
        and(
          eq(compensation.employmentId, p.employmentId),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .limit(1);
    const basic = Number(comp?.basic ?? 0);

    // The employee's actual worked hours for the period — same aggregate the kernel takes.
    const [att] = await tx
      .select({ minutes: sql<string>`coalesce(sum(${attendance.workedMinutes}), 0)` })
      .from(attendance)
      .where(
        and(
          eq(attendance.employmentId, p.employmentId),
          gte(attendance.attendanceDate, periodStart),
          lte(attendance.attendanceDate, periodEnd),
        ),
      );
    const hours = Number(att?.minutes ?? 0) / 60;

    // This employee's recurring pay items in the period window (the same period-aware predicate the kernel
    // uses), so a rule that reads another pay item reads that employee's REAL value for it.
    const recurring = await tx
      .select({
        code: payComponent.code,
        amount: employmentPayComponent.amount,
        rule: payComponent.rule,
        resolutionOrder: payComponent.resolutionOrder,
      })
      .from(employmentPayComponent)
      .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
      .where(
        and(
          eq(employmentPayComponent.employmentId, p.employmentId),
          lte(employmentPayComponent.validFrom, periodEnd),
          or(isNull(employmentPayComponent.validTo), gte(employmentPayComponent.validTo, periodStart)),
          isNull(employmentPayComponent.supersededAt),
        ),
      );

    // Rank the graph WITH the candidate rule substituted — an unsaved rule can re-rank the catalog, and the
    // preview must resolve in the order the save would have recorded, not the order on disk.
    const pending: PayRuleCatalogNode[] = catalog.map((n) =>
      n.code.trim().toUpperCase() === code ? { ...n, rule: p.rule } : n,
    );
    if (!pending.some((n) => n.code.trim().toUpperCase() === code)) pending.push({ code, rule: p.rule, kind: p.kind });
    const plan = planResolutionOrder(pending);
    const rankOf = (c: string) => (plan.ok ? (plan.order.get(c.trim().toUpperCase()) ?? 0) : 0);

    // The set to resolve: the employee's real items, with the item under edit substituted (or added at 0 if
    // the employee does not have it yet — a brand-new pay code still previews).
    const set = recurring
      .filter((r) => r.code.trim().toUpperCase() !== code)
      .map((r) => ({ code: r.code, rule: r.rule, amount: Number(r.amount), resolutionOrder: rankOf(r.code) }));
    const targetAmount = Number(recurring.find((r) => r.code.trim().toUpperCase() === code)?.amount ?? 0);
    set.push({ code, rule: p.rule, amount: targetAmount, resolutionOrder: rankOf(code) });
    const targetIdx = set.length - 1;

    // BASIC is PINNED to the authoritative Personnel figure, exactly as the kernel pins it — the preview
    // must agree with the run on what `component:'BASIC'` means, not just on the arithmetic.
    const scope = { basic, daysWorked: days, hours, components: { BASIC: basic } };
    let resolved: number[];
    try {
      resolved = resolvePayComponentSet(set, scope);
    } catch {
      // PayRuleEvalError — a non-finite result from a corrupted value. Fail closed with the structural code
      // rather than showing a number that the run would refuse to write.
      return { ok: false, code: 'OUT_OF_RANGE' };
    }

    // Report only the items the rule actually READ, so the panel explains the figure instead of listing the
    // employee's whole pay structure.
    const referenced = new Set(payRuleDependenciesOf(p.rule));
    const inputs = set
      .map((s, i) => ({ code: s.code.trim().toUpperCase(), amount: resolved[i] }))
      .filter((s) => referenced.has(s.code));

    return { ok: true, amount: resolved[targetIdx], scope: { basic, days, hours }, inputs };
  });
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

/**
 * 1.2.1 Fixed Transaction — thrown at WRITE time when the effective end-date precedes the effective start
 * (`effectiveTo < effectiveFrom`). The start<=end rule is enforced here rather than as a DB CHECK because
 * valid_from/valid_to carry supersession-chain semantics (a naive CHECK can be violated on a legitimate
 * supersession insert). The UI surfaces the message inline.
 */
export class FixedTransactionDateError extends Error {
  constructor() {
    super('fixed-transaction-date-invalid');
    this.name = 'FixedTransactionDateError';
  }
}

/**
 * 1.2.1 Fixed Transaction — thrown at WRITE time when a non-MYR currency is supplied. The kernel is MYR-only
 * and does no FX conversion, so a non-MYR amount could never be paid correctly. This single write-time guard
 * (parity with setPayrollBatchComponent's UnsupportedBatchComponentError) tells the admin at entry; there is
 * deliberately NO second kernel-side throw (a MYR-default UI can't produce a non-MYR value).
 */
export class UnsupportedFixedCurrencyError extends Error {
  constructor(public readonly currency: string) {
    super(`Currency "${currency}" is not supported — payroll is computed in MYR only.`);
    this.name = 'UnsupportedFixedCurrencyError';
  }
}

/**
 * Fixed Transaction screen (feedback b7fc8583) — thrown at WRITE time when the amount is not strictly
 * positive (<= 0). The invariant is enforced on the aggregate (setEmploymentPayComponent) so BOTH UI write
 * paths (the new Fixed Transaction screen AND the people-detail editor, which previously coerced a bad input
 * to 0 and silently wrote it) inherit the guard. The backfill helpers legitimately seed a 0-amount row for a
 * zero-allowance compensation line — they opt out explicitly via `allowZeroAmount: true`, and only they do.
 */
export class FixedTransactionAmountError extends Error {
  constructor() {
    super('fixed-transaction-amount-invalid');
    this.name = 'FixedTransactionAmountError';
  }
}

/**
 * Effective-dated upsert of a recurring component value for an employee (mirrors setCompensation).
 *
 * 1.2.1 Fixed Transaction extends this with an optional effective END date (written to `validTo` of the new
 * open row), a store-only `currency`, a per-employee `prorateOverride` (null = inherit the catalog flag), and
 * free-text `remarks`. The kernel and `listEmploymentPayComponents` are period-aware (they bound by valid_from
 * /valid_to), so setting `effectiveTo` auto-deactivates the item once the period passes its end — no separate
 * "deactivate" path is needed.
 *
 * Supersession-vs-end-date: the `cur` lookup matches the OPEN row by `isNull(validTo) AND isNull(supersededAt)`.
 * An item that was end-dated (validTo set, supersededAt null) is therefore NOT matched as `cur`, so a later
 * `set` for the same component does NOT find/overwrite it — it inserts a fresh open row and leaves a gap
 * (intended: the old item ended, a new one begins). The one ambiguous case — superseding an item whose validTo
 * is AFTER the new effectiveFrom — is handled by the supersession close below (validTo = effectiveFrom), which
 * truncates the old window correctly (no double-count, no gap-bug). Both are asserted in tests.
 */
export function setEmploymentPayComponent(
  ctx: SessionContext,
  p: {
    employmentId: string;
    componentId: string;
    amount: number;
    effectiveFrom: string;
    effectiveTo?: string | null;
    currency?: string;
    prorateOverride?: boolean | null;
    remarks?: string | null;
    // Fixed Transaction screen (feedback b7fc8583) — the Payroll Cycle tag. Cleaned to one of
    // regular/off_cycle/bonus/adjustment or null (unspecified). Stored + event-logged; the kernel ignores it.
    runType?: FixedTransactionCycle | null;
    // Backfill-only opt-out of the amount>0 guard: the compensation backfill legitimately seeds a 0-amount
    // row for a zero-allowance line. ONLY the backfill call sites pass this true; every UI path inherits the guard.
    allowZeroAmount?: boolean;
  },
  outerTx?: Tx,
) {
  // start<=end validation (before any write). effectiveTo is an inclusive end-date on the same axis as
  // effectiveFrom; ISO 'YYYY-MM-DD' strings compare chronologically.
  const effectiveTo = p.effectiveTo ?? null;
  // Currency guard — single write-time site, MYR-only kernel.
  const currency = p.currency ?? 'MYR';
  // Cycle tag — cleaned to the enum or null; never trust a raw form/URL value.
  const runType = cleanCycle(p.runType);
  const run = async (tx: Tx) => {
    // Validate inside the returned promise (not at call time) so the function ALWAYS returns a promise — a
    // bad value rejects rather than throwing synchronously, giving callers (and `.rejects` in tests) a single
    // uniform contract. Both checks still run before any write.
    if (effectiveTo != null && effectiveTo < p.effectiveFrom) throw new FixedTransactionDateError();
    if (currency !== 'MYR') throw new UnsupportedFixedCurrencyError(currency);
    // Amount>0 invariant on the aggregate — inherited by every UI write path. The backfill opts out for its
    // legitimate zero-allowance seed rows only (allowZeroAmount).
    if (!p.allowZeroAmount && !(p.amount > 0)) throw new FixedTransactionAmountError();
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
      // Close the prior OPEN row at the new effectiveFrom. This truncates a window that ran past the new
      // start (the supersession case the panel flagged) so there is no double-count.
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
        validTo: effectiveTo,
        currency,
        prorateOverride: p.prorateOverride ?? null,
        remarks: p.remarks ?? null,
        runType,
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
      // effectiveTo / currency / prorateOverride / runType are non-PII references/flags (not in the banned
      // set). runType is a constrained enum (cleaned above) so it is safe in the immutable log — unlike the
      // free-text `remarks`, which stays deliberately EXCLUDED here (PDPA Layer-0).
      payload: { employmentId: p.employmentId, componentId: p.componentId, effectiveFrom: p.effectiveFrom, effectiveTo, currency, prorateOverride: p.prorateOverride ?? null, runType },
    });
    return { id: row.id };
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
}

/**
 * Thrown when an edit/stop/archive targets a row that does not exist (or is not visible to the caller's
 * tenant/scope — RLS confines the read, so a foreign id simply comes back empty). Surfaces a friendly
 * "not found" rather than a silent no-op so a URL-tampered / stale id can be mapped to a localised message.
 */
export class FixedTransactionNotFoundError extends Error {
  constructor() {
    super('fixed-transaction-not-found');
    this.name = 'FixedTransactionNotFoundError';
  }
}

/**
 * Enhancement of Individual/Fixed Transaction (feedback 1e2704f2) — EDIT an existing recurring fixed pay
 * value by VERSIONING (the aggregate is an effective-dated, supersede-on-write log; this is the system's
 * design rule per ticket point #8 "overwrite OR version" — we version to preserve history and avoid
 * double-pay). The edit re-invokes the existing `set` path from a new `effectiveFrom`, which auto-closes the
 * prior OPEN row at that date (no double-count across the supersession close) and inherits every guard
 * (FixedTransactionDateError / UnsupportedFixedCurrencyError / FixedTransactionAmountError). The `id`
 * identifies WHICH row the admin is editing; we resolve its `componentId`/`employmentId` from the row itself
 * so a tampered componentId can't retarget the write, then apply the new amount/dates/cycle/remarks as a
 * fresh version. Event: `employment-pay-component.set` is appended by the underlying `set` (the versioned
 * write IS a set); no separate `.updated` event is needed and none is fabricated.
 */
export function updateEmploymentPayComponent(
  ctx: SessionContext,
  p: {
    id: string;
    employmentId: string;
    amount: number;
    effectiveFrom: string;
    effectiveTo?: string | null;
    runType?: FixedTransactionCycle | null;
    remarks?: string | null;
    prorateOverride?: boolean | null;
  },
) {
  return withTenant(ctx, async (tx) => {
    // Load the target row (RLS-confined to the tenant). Match the caller-supplied employmentId so the edit
    // can only touch a row the admin is actually looking at; a foreign/stale id yields no row.
    const [row] = await tx
      .select({ componentId: employmentPayComponent.componentId, currency: employmentPayComponent.currency })
      .from(employmentPayComponent)
      .where(
        and(
          eq(employmentPayComponent.id, p.id),
          eq(employmentPayComponent.employmentId, p.employmentId),
        ),
      )
      .limit(1);
    if (!row) throw new FixedTransactionNotFoundError();
    // Version via the existing set path (auto-closes the prior open row at effectiveFrom, appends its event,
    // re-runs the date/currency/amount guards). We pass the row's own currency through so an edit on a legacy
    // MYR row stays MYR (the UI is MYR-only; this just avoids re-defaulting).
    return setEmploymentPayComponent(
      ctx,
      {
        employmentId: p.employmentId,
        componentId: row.componentId,
        amount: p.amount,
        effectiveFrom: p.effectiveFrom,
        effectiveTo: p.effectiveTo ?? null,
        currency: row.currency,
        prorateOverride: p.prorateOverride ?? null,
        remarks: p.remarks ?? null,
        runType: p.runType ?? null,
      },
      tx,
    );
  });
}

/**
 * Enhancement (feedback 1e2704f2) — STOP a recurring fixed item from a date: set its inclusive `validTo` to
 * the last month it should pay. The row survives, keeps paying THROUGH `validTo`, and drops out of the kernel
 * afterward (the kernel selects on `validFrom <= periodEnd AND (validTo IS NULL OR validTo >= periodStart)
 * AND supersededAt IS NULL` — core/payroll.ts). It still appears in the list marked "Ended"
 * (listEmploymentPayComponents filters only supersededAt). Guards effectiveTo >= the row's validFrom.
 */
export function endEmploymentPayComponent(
  ctx: SessionContext,
  p: { id: string; employmentId: string; effectiveTo: string },
) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ validFrom: employmentPayComponent.validFrom })
      .from(employmentPayComponent)
      .where(
        and(
          eq(employmentPayComponent.id, p.id),
          eq(employmentPayComponent.employmentId, p.employmentId),
          isNull(employmentPayComponent.supersededAt),
        ),
      )
      .limit(1);
    if (!row) throw new FixedTransactionNotFoundError();
    // Inclusive end-date must not precede the start (same axis, ISO strings compare chronologically).
    if (p.effectiveTo < row.validFrom) throw new FixedTransactionDateError();
    await tx
      .update(employmentPayComponent)
      .set({ validTo: p.effectiveTo })
      .where(eq(employmentPayComponent.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment-pay-component',
      aggregateId: p.id,
      eventType: 'employment-pay-component.ended',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // effectiveTo is a non-PII date reference (mirrors the `set` payload); no amount, no free-text remarks.
      payload: { employmentId: p.employmentId, effectiveTo: p.effectiveTo },
    });
    return { id: p.id };
  });
}

/**
 * Enhancement (feedback 1e2704f2) — REMOVE/ARCHIVE (void) a recurring fixed item: set `supersededAt = now()`.
 * The kernel then excludes it ENTIRELY (its select requires supersededAt IS NULL) and
 * listEmploymentPayComponents drops it from the screen — the true "delete/archive ⇒ no longer used in
 * payroll, no longer shown" semantics (ticket point #11). No hard delete: the row is preserved for audit /
 * replay, consistent with the effective-dated log design.
 */
export function archiveEmploymentPayComponent(
  ctx: SessionContext,
  p: { id: string; employmentId: string },
) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: employmentPayComponent.id })
      .from(employmentPayComponent)
      .where(
        and(
          eq(employmentPayComponent.id, p.id),
          eq(employmentPayComponent.employmentId, p.employmentId),
          isNull(employmentPayComponent.supersededAt),
        ),
      )
      .limit(1);
    if (!row) throw new FixedTransactionNotFoundError();
    await tx
      .update(employmentPayComponent)
      .set({ supersededAt: new Date() })
      .where(eq(employmentPayComponent.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment-pay-component',
      aggregateId: p.id,
      eventType: 'employment-pay-component.archived',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { employmentId: p.employmentId },
    });
    return { id: p.id };
  });
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

/** The kernel's fail-closed condition (core/payroll.ts earningsOf), evaluated on a catalog row's flags.
 *  Feedback 09b554e9: a pay code carrying a DECLARED pcb_remuneration_type is no longer "unsupported" —
 *  the kernel routes it by the declared classification, so the guard only fires for PCB-ticked codes
 *  LACKING classification (legacy rows keep the legacy fail-closed behaviour). */
const isUnsupportedTaxableComponent = (c: { includedInEpf: boolean; includedInSocsoEis: boolean; includedInPcb: boolean; isNonPayable: boolean; pcbRemunerationType?: string | null }) =>
  c.includedInPcb && c.pcbRemunerationType == null && (c.isNonPayable || (!c.includedInEpf && !c.includedInSocsoEis));

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
        pcbRemunerationType: payComponent.pcbRemunerationType,
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
 *  setEmploymentPayComponent supersedes the prior open value, so re-running just re-states it.
 *  Feedback 64fb5e48 — OPTIONAL housekeeping only: the payroll engine now always pays basic from the
 *  Personnel compensation record, so BASIC component amounts no longer drive pay (a divergent one only
 *  surfaces as the staleBasicComponent warning in the pre-processing checks, and a missing one is not a
 *  gap at all). Kept for tenants that want the BASIC line mirrored into the typed component tables. */
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
      // allowZeroAmount: a compensation line may legitimately have basic 0 or a zero allowance; the backfill
      // must seed those 0-amount rows so the typed path stays byte-identical. Only the backfill opts out.
      await setEmploymentPayComponent(ctx, { employmentId: c.employmentId, componentId: basicId, amount: Number(c.basicSalary), effectiveFrom: c.validFrom, allowZeroAmount: true }, tx);
      await setEmploymentPayComponent(ctx, { employmentId: c.employmentId, componentId: allowId, amount: Number(c.monthlyAllowance ?? 0), effectiveFrom: c.validFrom, allowZeroAmount: true }, tx);
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
        pcbRemunerationType: payComponent.pcbRemunerationType,
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
