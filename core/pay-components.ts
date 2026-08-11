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
  payslip,
  person,
} from '../db/schema';
// 2aed39d4 — the closed-pay-run test reuses the SAME period helpers the Basic Salary card and the
// Movement correction already refuse on, rather than a fourth definition of "payroll evidence".
// core/comp.ts does not import this module, so this is not a cycle.
import { closedPeriodsTx, overlapsClosedPeriod } from './comp';
import { countryPacks } from '../localization/registry';
import type { PayComponentSeed, PcbExemptionTable, PcbRemunerationType } from '../localization/country-pack';
import { parseCsvRecords } from '../lib/csv';
// 2f889bae — date-only arithmetic, UTC by design (the repo rule: only "what date is this INSTANT" goes
// through the tenant timezone). core/roster.ts already imports from this module, so no new pack edge.
import { addDaysIso } from '../lib/roster-month';
import {
  payRuleDependencies as payRuleDependenciesOf,
  payRuleDerivesAmount,
  payRuleInputUnit,
  planResolutionOrder,
  resolvePayComponentSet,
  validatePayRule,
  validatePayRuleAgainstCatalog,
  type PayRule,
  type PayRuleCatalogNode,
  type PayRuleComponentNotice,
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

/** One row of `listEmploymentPayComponents`, which `getEmploymentPayComponent` returns exactly one of. */
export type EmploymentPayComponentRow = Awaited<ReturnType<typeof listEmploymentPayComponents>>[number];

/**
 * f3ae3245 — ONE recurring fixed item by id, for the dedicated View/Edit page.
 *
 * Same projection as `listEmploymentPayComponents` so the page and the list can never describe the same
 * row differently — one shape, narrowed to one id, rather than a second query with its own columns.
 *
 * Matched on `employmentId` as well as `id` for the same reason every write path in this file does: RLS
 * fences the TENANT, company scope is an application concern, and the caller fences that. A row that is
 * superseded (removed) reads as absent, exactly as it does in the list — a URL to a removed item must not
 * resurrect it on screen.
 *
 * Read-only: no write, no DomainEvent. Returns null rather than throwing so the page can `notFound()`.
 */
export function getEmploymentPayComponent(
  ctx: SessionContext,
  p: { id: string; employmentId: string },
): Promise<EmploymentPayComponentRow | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
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
        runType: employmentPayComponent.runType,
      })
      .from(employmentPayComponent)
      .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
      .where(
        and(
          eq(employmentPayComponent.id, p.id),
          eq(employmentPayComponent.employmentId, p.employmentId),
          isNull(employmentPayComponent.supersededAt),
        ),
      )
      .limit(1);
    return row ?? null;
  });
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
    .select({
      id: payComponent.id,
      code: payComponent.code,
      rule: payComponent.rule,
      resolutionOrder: payComponent.resolutionOrder,
      // 2da9937a — planResolutionOrder needs the kind to know which rows are fixed allowances, so that an
      // item reading the `fixed_allowances` aggregate is RECORDED above them. resolvePayComponentSet
      // re-derives that ordering anyway (a stored rank can be stale, and a one-off batch row has none), so
      // omitting this would not pay a wrong figure — it would only persist a rank that misdescribes the
      // graph, which is exactly the kind of quietly-wrong number this column exists to prevent.
      kind: payComponent.kind,
      archivedAt: payComponent.archivedAt,
    })
    .from(payComponent)
    .where(eq(payComponent.tenantId, tenantId));
  const plan = planResolutionOrder(rows.map((r) => ({ code: r.code, rule: r.rule, kind: r.kind, archived: r.archivedAt != null })));
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
      /** 2da9937a — set when the figure above is 0 because a LIVE divisor resolved to zero for this
       *  employee (a zero-hours month, no fixed allowances). `ok` is still true and the amount is still a
       *  real figure: this is the explanation, not a failure. Null when nothing divided by zero. */
      zeroDivisor?: { divisor: string; step: number } | null;
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

    let r: EmploymentRuleResolution;
    try {
      r = await resolveRuleForEmploymentTx(tx, ctx.tenantId, {
        code,
        rule: p.rule,
        // The item under edit takes the kind from the FORM, not from disk — the admin may be changing it in
        // the same edit, and the preview must answer for the rule as it is about to be saved.
        kind: p.kind,
        employmentId: p.employmentId,
        periodStart,
        periodEnd,
        catalog,
      });
    } catch {
      // PayRuleEvalError — a non-finite result from a corrupted value. Fail closed with the structural code
      // rather than showing a number that the run would refuse to write.
      return { ok: false, code: 'OUT_OF_RANGE' };
    }

    // Report only the items the rule actually READ, so the panel explains the figure instead of listing the
    // employee's whole pay structure.
    const referenced = new Set(payRuleDependenciesOf(p.rule));
    const inputs = r.resolved.filter((s) => referenced.has(s.code));

    return {
      ok: true,
      amount: r.amount,
      scope: { basic: r.basic, days: r.days, hours: r.hours },
      inputs,
      zeroDivisor: r.zeroDivisor,
    };
  });
}

/** What resolveRuleForEmploymentTx answers: the target item's figure, the scope inputs it was computed
 *  from (so a caller can SHOW the arithmetic rather than assert it), and every item in the resolved set
 *  with the value it took. */
type EmploymentRuleResolution = {
  amount: number;
  basic: number;
  /** The day and hour figures ACTUALLY used — an override, when one was supplied, rather than the period's. */
  days: number;
  hours: number;
  resolved: { code: string; amount: number }[];
  zeroDivisor: { divisor: string; step: number } | null;
};

/**
 * 2da9937a — THE ONE PLACE a pay rule becomes a figure for ONE REAL EMPLOYEE outside a payroll run.
 *
 * It was previewPayRule's body. It is a named function now because the Individual Transaction screen has to
 * ask the same question — "what does this item pay this employee for these inputs?" — and the ONLY honest
 * way to answer it is with the code that already answers it for the admin preview. Two copies of this
 * assembly (whose basic, whose hours, which recurring items, in what rank) would agree on the day they were
 * written and drift silently afterwards, and the drift would be money.
 *
 * `override` is the one thing the transaction screen needs that the preview does not: a keyed quantity
 * REPLACES the period aggregate for that input. Ten hours of overtime is a statement about ten hours, not
 * about the employee's whole month of attendance. Absent ⇒ the period's own figures, which is exactly what
 * the preview passes, so the preview's numbers are unchanged by this extraction.
 *
 * Reads only; writes nothing and appends no event.
 */
async function resolveRuleForEmploymentTx(
  tx: Tx,
  tenantId: string,
  p: {
    /** The target pay code, ALREADY upper-cased. */
    code: string;
    rule: PayRule | null;
    kind: string | null | undefined;
    employmentId: string;
    periodStart: string;
    periodEnd: string;
    /** The catalog nodes, when the caller has already loaded them (previewPayRule validates against them). */
    catalog?: PayRuleCatalogNode[];
    override?: { hours?: number | null; days?: number | null };
  },
): Promise<EmploymentRuleResolution> {
  const { code, periodStart, periodEnd } = p;
  const catalog = p.catalog ?? (await catalogNodesTx(tx, tenantId));
  const periodDays = Math.round((Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000) + 1;

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
  const periodHours = Number(att?.minutes ?? 0) / 60;

  const days = p.override?.days ?? periodDays;
  const hours = p.override?.hours ?? periodHours;

  // This employee's recurring pay items in the period window (the same period-aware predicate the kernel
  // uses), so a rule that reads another pay item reads that employee's REAL value for it.
  const recurring = await tx
    .select({
      code: payComponent.code,
      amount: employmentPayComponent.amount,
      rule: payComponent.rule,
      resolutionOrder: payComponent.resolutionOrder,
      // 2da9937a — the catalog kind decides whether an item counts towards the `fixed_allowances`
      // aggregate. The KERNEL's CompRow already carries it, so without it here the preview would compute
      // the aggregate as 0 while the run computed the real sum: the preview would lie, quietly, and only
      // about formulas using the new operand. Selecting it is what keeps "same evaluator" true in fact
      // and not just in the call graph.
      kind: payComponent.kind,
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

  // Rank the graph WITH the target rule substituted — an unsaved rule can re-rank the catalog, and the
  // answer must resolve in the order the save would have recorded, not the order on disk.
  const pending: PayRuleCatalogNode[] = catalog.map((n) =>
    n.code.trim().toUpperCase() === code ? { ...n, rule: p.rule } : n,
  );
  if (!pending.some((n) => n.code.trim().toUpperCase() === code)) pending.push({ code, rule: p.rule, kind: p.kind });
  const plan = planResolutionOrder(pending);
  const rankOf = (c: string) => (plan.ok ? (plan.order.get(c.trim().toUpperCase()) ?? 0) : 0);

  // The set to resolve: the employee's real items, with the target substituted (or added at 0 if the
  // employee does not have it yet — a brand-new pay code still resolves).
  const set = recurring
    .filter((r) => r.code.trim().toUpperCase() !== code)
    .map((r) => ({ code: r.code, rule: r.rule, amount: Number(r.amount), resolutionOrder: rankOf(r.code), kind: r.kind as string | null }));
  const targetAmount = Number(recurring.find((r) => r.code.trim().toUpperCase() === code)?.amount ?? 0);
  set.push({ code, rule: p.rule, amount: targetAmount, resolutionOrder: rankOf(code), kind: p.kind as string | null });
  const targetIdx = set.length - 1;

  // BASIC is PINNED to the authoritative Personnel figure, exactly as the kernel pins it — the answer
  // must agree with the run on what `component:'BASIC'` means, not just on the arithmetic.
  const scope = { basic, daysWorked: days, hours, components: { BASIC: basic } };
  // 2da9937a — the same notices channel the run uses. On a screen it turns "RM 0.00" from a figure the
  // admin has to explain to themselves into a sentence naming the input that was zero, BEFORE a payroll
  // run has to surface it instead.
  const notices: PayRuleComponentNotice[] = [];
  const resolvedAmounts = resolvePayComponentSet(set, scope, notices);

  // Only the notice for the TARGET item — a zero divisor on some OTHER pay item is that item's problem and
  // belongs on that item's screen, not on this answer.
  const zeroDivisor = notices.find((n) => n.code === code) ?? null;
  return {
    amount: resolvedAmounts[targetIdx],
    basic,
    days,
    hours,
    resolved: set.map((s, i) => ({ code: s.code.trim().toUpperCase(), amount: resolvedAmounts[i] })),
    zeroDivisor: zeroDivisor ? { divisor: zeroDivisor.divisor, step: zeroDivisor.step } : null,
  };
}

// ── 2da9937a — a one-off transaction whose amount the PAY ITEM decides ───────────────────────────────

/**
 * Thrown when a one-off transaction names a pay item that works its amount out from a keyed quantity, and
 * that quantity is missing (or not the input the rule reads).
 *
 * It is a REFUSAL rather than a default, and the difference matters: falling back to the employee's
 * attendance total for the month would silently pay a full month of overtime for a row the operator meant
 * to be ten hours. `unit` names the input the rule needs, so the screen can say which box to fill.
 */
export class TxnQuantityRequiredError extends Error {
  constructor(public readonly unit: 'hours' | 'days') {
    super(`This pay item calculates from ${unit}; a ${unit} quantity is required.`);
    this.name = 'TxnQuantityRequiredError';
  }
}

/** What a pay item does to a one-off transaction's amount. `derived: false` is the legacy case — a null or
 *  `fixed` rule (and an unknown/archived item, which the ledger's own component guard refuses
 *  authoritatively) leaves the operator's typed amount exactly as it was. */
export type IndividualTxnAmountDerivation =
  | { derived: false }
  | {
      derived: true;
      /** The figure this item pays for these inputs, unrounded — the amount the row is written with. */
      amount: number;
      code: string;
      ruleKind: string;
      /** The input the quantity supplied (null when the rule needs nothing from the operator). */
      inputUnit: 'hours' | 'days' | null;
      /** Set when `amount` is 0 because a LIVE divisor resolved to zero for this employee — the
       *  explanation, not a failure (see PayRuleZeroDivisorNotice). */
      zeroDivisor: { divisor: string; step: number } | null;
    };

/**
 * 2da9937a — WORK OUT what a one-off transaction on this pay item pays, from the item's own rule.
 *
 * THE DEFECT THIS CLOSES. The Individual Transaction write path never consulted the picked pay item's
 * rule: it asked for an Amount and asserted it was positive, so an item configured as "RM x per hour" was
 * a box the operator had to do the arithmetic for by hand, and the configured rule never ran at all. This
 * is the resolution step that was missing — and it goes through resolveRuleForEmploymentTx, so it is the
 * same evaluator, the same scope assembly and the same recorded resolution order the payslip uses. There
 * is no second implementation to drift.
 *
 * WHAT IT DOES NOT DO. It does not touch an item with a null or `fixed` rule (byte-identical to before),
 * it does not rewrite any transaction already on file, and it is not consulted by the payroll kernel —
 * the kernel still pays a one-off row's STORED amount, which is what keeps every existing figure exactly
 * where it is. All this changes is what gets stored when a new row is keyed.
 *
 * Read-only: no write, no domain event. The caller supplies the write.
 */
export function deriveIndividualTxnAmount(
  ctx: SessionContext,
  p: {
    componentId: string;
    employmentId: string;
    /** The company the caller has already established it may act in. The employment must belong to it. */
    companyId: string;
    /** 'YYYY-MM' — the transaction's pay month, which bounds the attendance and recurring-item reads. */
    payPeriod: string;
    quantity: number | null;
    unit: string | null;
  },
): Promise<IndividualTxnAmountDerivation> {
  return withTenant(ctx, async (tx): Promise<IndividualTxnAmountDerivation> => {
    // COMPANY SCOPE IS AN APPLICATION CONCERN — RLS only isolates tenants. Without this an admin scoped to
    // one company could ask what a formula pays for an employee in another and read their basic salary
    // back out of the figure. Answering "nothing derived" rather than throwing is deliberate: the write
    // path's own C3 guard (CompanyMismatchError) is what refuses the save, and a second refusal here would
    // give one mistake two names — and tell the caller the employment exists.
    const [emp] = await tx
      .select({ companyId: employment.companyId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp || emp.companyId !== p.companyId) return { derived: false };

    const [item] = await tx
      .select({ code: payComponent.code, kind: payComponent.kind, rule: payComponent.rule, archivedAt: payComponent.archivedAt })
      .from(payComponent)
      .where(and(eq(payComponent.tenantId, ctx.tenantId), eq(payComponent.id, p.componentId)))
      .limit(1);
    // An unknown or archived item is not this function's refusal to make: the ledger's assertTxnComponents
    // rejects both with InvalidTxnComponentError, and inventing a second error here would give the same
    // mistake two names. Report "nothing derived" and let the write path refuse.
    if (!item || item.archivedAt != null) return { derived: false };
    const rule = item.rule as PayRule | null;
    if (!payRuleDerivesAmount(rule)) return { derived: false };

    const inputUnit = payRuleInputUnit(rule);
    if (inputUnit != null && (p.unit !== inputUnit || p.quantity == null || !(p.quantity > 0))) {
      throw new TxnQuantityRequiredError(inputUnit);
    }

    const [year, month1] = p.payPeriod.split('-').map(Number);
    const periodStart = `${p.payPeriod}-01`;
    // Date.UTC with day 0 of the NEXT month is the last day of this one — leap years included.
    const periodEnd = new Date(Date.UTC(year, month1, 0)).toISOString().slice(0, 10);

    const r = await resolveRuleForEmploymentTx(tx, ctx.tenantId, {
      code: item.code.trim().toUpperCase(),
      rule,
      kind: item.kind,
      employmentId: p.employmentId,
      periodStart,
      periodEnd,
      override:
        inputUnit === 'hours'
          ? { hours: p.quantity }
          : inputUnit === 'days'
            ? { days: p.quantity }
            : undefined,
    });
    return {
      derived: true,
      amount: r.amount,
      code: item.code.trim().toUpperCase(),
      ruleKind: rule!.kind,
      inputUnit,
      zeroDivisor: r.zeroDivisor,
    };
  });
}

// ── 2da9937a — the worked overtime examples the reporter asked for ───────────────────────────────────

/** One overtime item to create, as a MULTIPLE of the reference item's hourly rate. */
export type OvertimeMultiplierSeed = { code: string; name: string; multiplier: number };

/** Overtime 2.0 and Overtime 3.0, alongside the Overtime 1.5 the tenant already configured. */
export const OVERTIME_MULTIPLIER_SEEDS: readonly OvertimeMultiplierSeed[] = [
  { code: 'OT2_0', name: 'Overtime 2.0', multiplier: 2 },
  { code: 'OT3_0', name: 'Overtime 3.0', multiplier: 3 },
];

/** Thrown when the reference overtime item cannot be used as the model for the new ones. `not_found` = no
 *  such code in this tenant's catalog; `archived` = the code exists but has been deliberately switched
 *  off, so its rate is a RETIRED figure nobody has stood behind since — scaling live items off it would
 *  propagate a rate the tenant has already withdrawn; `not_per_hour` = it exists but does not carry a
 *  per-hour rate, so there is no hourly figure to scale and GUESSING one would seed a wrong rate into
 *  payroll. */
export class OvertimeReferenceUnusableError extends Error {
  constructor(public readonly reason: 'not_found' | 'archived' | 'not_per_hour') {
    super(`The reference overtime pay item is unusable (${reason}).`);
    this.name = 'OvertimeReferenceUnusableError';
  }
}

/**
 * 2da9937a — create Overtime 2.0 and Overtime 3.0 from the tenant's existing Overtime 1.5.
 *
 * THE RATE IS DERIVED, NOT ASSUMED. The reference item already carries this tenant's own per-hour figure at
 * 1.5×, so the plain hourly rate is that figure divided by 1.5, and 2.0× / 3.0× are multiples of it. A
 * hard-coded rate would be a number nobody in this codebase is entitled to choose; a rate scaled from the
 * one the tenant configured is the same money they already agreed to, at the multiplier they asked for.
 *
 * IT GOES THROUGH upsertPayComponent — the writer the admin screen uses — rather than an INSERT, so the
 * new items pass the same rule validation (structural + catalog-aware), get their resolution order
 * recorded, and append the same `pay-component.created` event an admin's own save would. A raw insert
 * would produce rows that no audit trail explains and that the graph planner has never seen.
 *
 * EVERY STATUTORY FLAG IS COPIED FROM THE REFERENCE. Overtime's EPF / SOCSO / PCB / HRDF treatment is a
 * legal matter this function has no view on; the tenant already settled it on Overtime 1.5, and 2.0× of
 * the same payment is treated the same way. Copying is the only answer that cannot be wrong here.
 *
 * IDEMPOTENT BY SKIPPING, NOT BY OVERWRITING. `upsertPayComponent` is upsert-by-code, so a re-run would
 * silently reset a rate an admin had since corrected. An existing code (archived or not) is reported as
 * skipped and left exactly as it is.
 */
export function seedOvertimeMultipliers(
  ctx: SessionContext,
  p: {
    /** The already-configured overtime item to model the new ones on. */
    fromCode?: string;
    /** The multiplier that reference item's rate already encodes. */
    fromMultiplier?: number;
    seeds?: readonly OvertimeMultiplierSeed[];
  } = {},
): Promise<{ created: string[]; skipped: string[]; hourlyRate: number }> {
  const fromCode = (p.fromCode ?? 'OT1_5').trim().toUpperCase();
  const fromMultiplier = p.fromMultiplier ?? 1.5;
  const seeds = p.seeds ?? OVERTIME_MULTIPLIER_SEEDS;
  return withTenant(ctx, async (tx) => {
    const [ref] = await tx
      .select()
      .from(payComponent)
      .where(and(eq(payComponent.tenantId, ctx.tenantId), eq(payComponent.code, fromCode)))
      .limit(1);
    if (!ref) throw new OvertimeReferenceUnusableError('not_found');
    // AN ARCHIVED REFERENCE IS REFUSED, AND THIS CHECK MUST STAY ABOVE THE not_per_hour ONE. The lookup
    // above filters tenant + code only, so before this guard an archived-but-per_hour reference SUCCEEDED
    // and seeded OT2_0 / OT3_0 scaled off a rate the tenant had deliberately switched off — a silent wrong
    // outcome, not merely a mislabelled error. Ordering is load-bearing for the other half: placed after
    // the cast, an archived item carrying a fixed or absent rule would report `not_per_hour` and the real
    // cause (it is switched off) would be lost to whoever reads the message.
    if (ref.archivedAt != null) throw new OvertimeReferenceUnusableError('archived');
    const refRule = ref.rule as PayRule | null;
    if (refRule == null || refRule.kind !== 'per_hour') throw new OvertimeReferenceUnusableError('not_per_hour');
    // Four decimals, not two: the plain hourly rate is an INTERMEDIATE (RM 16.50 at 1.5× is RM 11.00 here,
    // but RM 16.35 is RM 10.90), and rounding it to cents before multiplying would shift the 2.0× and 3.0×
    // rates by more than the rounding itself.
    const hourlyRate = Math.round((refRule.rate / fromMultiplier) * 1e4) / 1e4;

    const created: string[] = [];
    const skipped: string[] = [];
    for (const seed of seeds) {
      const code = seed.code.trim().toUpperCase();
      const [existing] = await tx
        .select({ id: payComponent.id })
        .from(payComponent)
        .where(and(eq(payComponent.tenantId, ctx.tenantId), eq(payComponent.code, code)))
        .limit(1);
      if (existing) {
        skipped.push(code);
        continue;
      }
      await upsertPayComponent(ctx, {
        code,
        name: seed.name,
        kind: ref.kind as PayComponentInput['kind'],
        includedInEpf: ref.includedInEpf,
        includedInSocsoEis: ref.includedInSocsoEis,
        includedInPcb: ref.includedInPcb,
        includedInHrdfBase: ref.includedInHrdfBase,
        isNonPayable: ref.isNonPayable,
        prorates: ref.prorates,
        eaFormLine: ref.eaFormLine,
        roundingMethod: ref.roundingMethod ?? undefined,
        // THE LHDN CLASSIFICATION IS COPIED ONLY WHEN THE REFERENCE HAS ONE. Passing an explicit null
        // reads as "supplied" (classificationOf), which turns on the mandatory-classification guard — and
        // a PCB-taxable overtime item whose tenant has not filled that in yet would then be refused a seed
        // because of a field the item it is copying leaves blank. Undefined is "not supplied", the legacy
        // caller's semantics, which is exactly what this is.
        ...(ref.pcbRemunerationType != null || ref.pcbExemptionCode != null || ref.epfBonus2012
          ? {
              epfBonus2012: ref.epfBonus2012,
              pcbRemunerationType: ref.pcbRemunerationType as PcbRemunerationType | null,
              pcbExemptionCode: ref.pcbExemptionCode,
            }
          : {}),
        // The payslip box this prints in — Overtime, not Bonus. Copied for the same reason the flags are.
        displayCategory: ref.displayCategory,
        rule: { kind: 'per_hour', rate: Math.round(hourlyRate * seed.multiplier * 1e4) / 1e4 },
      });
      created.push(code);
    }
    return { created, skipped, hourlyRate };
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
 * 2aed39d4 — thrown at WRITE time when the window being written would COVER A DAY that a live row for the
 * same employment + pay item already covers, and the clash cannot be resolved by versioning.
 *
 * WHY THIS IS AN APPLICATION ERROR AND NOT JUST A CONSTRAINT. Migration 0426 adds
 * `employment_pay_component_no_overlap` (EXCLUDE USING gist, inclusive-inclusive daterange, WHERE
 * superseded_at IS NULL) as the BACKSTOP. But a raw Postgres 23P01 reaching the screen would be worse
 * than today's silent duplicate: there is no precedent in this repo for mapping one, and the operator
 * would see "conflicting key value violates exclusion constraint". So the app refuses FIRST, with the
 * clashing row's own code and dates in the message, and the constraint exists to catch anything that
 * ever reaches the table by another route.
 *
 * WHAT `run_type` (Payroll Cycle) HAS TO DO WITH IT: NOTHING, DELIBERATELY. The reporting ticket asked
 * for the key to be employee + pay item + period + Payroll Cycle. It is employee + pay item + period.
 * The kernel (core/payroll.ts) selects on employment, component and the date window ONLY and pays every
 * returned row its FULL amount — it never reads run_type — so two rows differing only by cycle both pay,
 * in every run. Including the cycle in the key would have LEGALISED 2 of the 10 clashes measured on
 * production. The cost is stated in the approved plan: a Regular and a Bonus line for the same item
 * cannot be held over the same dates.
 */
export class FixedTransactionOverlapError extends Error {
  constructor(
    public readonly code: string,
    public readonly validFrom: string,
    public readonly validTo: string | null,
  ) {
    super(
      `Pay item "${code}" already has a record covering ${validFrom} to ${validTo ?? 'open'} for this employee. End that record first, or choose dates that do not overlap it.`,
    );
    this.name = 'FixedTransactionOverlapError';
  }
}

/**
 * 2aed39d4 — thrown when a restatement is dated BEFORE the start of the row it would have to close.
 *
 * Split out of FixedTransactionDateError, which it used to share. That class means "the end date is
 * before the start date", and the UI resolved it through `payroll.transactions.fixed.dateError` — "End
 * date cannot be before the start date" — which names the wrong field entirely: nothing is wrong with
 * the end date here, the START date is behind an existing record. Carries the blocking row's code and
 * dates so the message can name it.
 */
export class FixedTransactionBackwardsError extends Error {
  constructor(
    public readonly code: string,
    public readonly validFrom: string,
    public readonly validTo: string | null,
  ) {
    super(
      `Pay item "${code}" already starts on ${validFrom}. A new value must take effect on or after that date — restating it from an earlier date would rewrite history.`,
    );
    this.name = 'FixedTransactionBackwardsError';
  }
}

/**
 * Effective-dated upsert of a recurring component value for an employee (mirrors setCompensation).
 *
 * 1.2.1 Fixed Transaction extends this with an optional effective END date (written to `validTo` of the new
 * row), a store-only `currency`, a per-employee `prorateOverride` (null = inherit the catalog flag), and
 * free-text `remarks`. The kernel and `listEmploymentPayComponents` are period-aware (they bound by valid_from
 * /valid_to), so setting `effectiveTo` auto-deactivates the item once the period passes its end — no separate
 * "deactivate" path is needed.
 *
 * ── HOW A CLASH WITH AN EXISTING ROW IS RESOLVED (2aed39d4 rewrote this whole paragraph) ─────────────
 *
 * The previous doc block here said the `cur` lookup matched the OPEN row only, that an end-dated row was
 * therefore left alone "(intended: the old item ended, a new one begins)", and that the one ambiguous
 * case was "handled by the supersession close below". ALL THREE CLAIMS WERE WRONG BY THE TIME THEY WERE
 * READ, and the third had never been true:
 *   • the close is at `effectiveFrom - 1`, not at `effectiveFrom` (34cc8137 fixed that, and the old text
 *     was left describing the overpaying version);
 *   • leaving an end-dated row alone is only "intended" when the windows do not TOUCH. When they do, the
 *     kernel pays BOTH rows in full for every month both cover. That is the defect this item exists to
 *     close: X000001 carried three HANDPHONE ALLOWANCE rows all running 2026-07-01..2026-07-01, and a
 *     re-run of July would have paid 400.00 where the issued payslip paid 100.00;
 *   • the "ambiguous case" it claimed to handle — an end-dated row whose validTo is after the new
 *     effectiveFrom — was NEVER MATCHED AT ALL, because the lookup required `validTo IS NULL`.
 *
 * The lookup is now every LIVE row (supersededAt IS NULL) of the same employment + component whose
 * INCLUSIVE window touches the new one. `validTo` is INCLUSIVE here — see the long note at the close
 * below — so "touches" means `validFrom <= newTo` AND `(validTo IS NULL OR validTo >= newFrom)`, which is
 * exactly the predicate the kernel selects on and exactly the daterange the 0426 constraint indexes.
 *
 * Each clashing row is then resolved by ONE of three rules:
 *   1. it is the row this write is a NEW VERSION OF (`replacesId`, passed only by
 *      updateEmploymentPayComponent) or it is the OPEN row → version it: supersede if the new value
 *      starts on its own start date (a zero-day row is never closed into an inverted window), else close
 *      it the day before the new start. This is the reporter's expected-behaviour point 3 and it is what
 *      34cc8137 shipped for the open row; it now applies to an ended row being edited as well, which is
 *      what stops Save on an already-ended record from adding a copy of it.
 *   2. the new value starts BEFORE that row starts → FixedTransactionBackwardsError. There is no
 *      truncation that fixes this: closing at `effectiveFrom - 1` would write an end date before the
 *      row's own start, which is how production came to carry an inverted row.
 *   3. anything else — i.e. some OTHER live end-dated row that the new window runs into →
 *      FixedTransactionOverlapError, naming that row. This is the reporter's expected-behaviour point 2
 *      verbatim ("existing 01/01/2026-31/12/2026, new start 01/06/2026 must not be allowed").
 *
 * Refusals are raised BEFORE any write (both passes run over the scan result first), so a rejected save
 * leaves the table exactly as it found it.
 *
 * ── CLOSED PAY RUNS ──
 * A write whose window touches a month a CLOSED run already paid is refused (FixedTransactionPaidError).
 * Processed-but-not-closed is deliberately allowed — see archiveEmploymentPayComponent.
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
    // 2aed39d4 — the id of the row this write is a NEW VERSION OF. Passed ONLY by
    // updateEmploymentPayComponent, which knows which row the admin opened. That row is versioned
    // (closed or superseded) instead of being reported as a clash, which is what makes Save on an
    // already-ended record CHANGE it rather than add a copy of it. Every other live row that the new
    // window runs into is still refused.
    replacesId?: string;
    // 2aed39d4 — backfill-only opt-out of the overlap refusal: SUPERSEDE every live row this write
    // overlaps instead of refusing. Only backfillEmploymentComponentsFromCompensation passes this. It
    // re-states BASIC/ALLOWANCE from the compensation record, which is the system of record for both, so
    // "replace whatever pay-component rows sit in the way" is exactly its documented intent
    // ("re-running just re-states it") — and it is the only shape that keeps the backfill runnable now
    // that overlaps are refused. Every UI path inherits the refusal.
    supersedeOverlaps?: boolean;
    // 2aed39d4 — backfill-only opt-out of the CLOSED-run refusal. Kept as its own flag rather than folded
    // into supersedeOverlaps so each opt-out is named for exactly what it waives and both are greppable.
    // The backfill mirrors compensation from that row's OWN validFrom, which on a long-serving employee
    // is years back and will cover closed months on any tenant that has ever closed a run — so without
    // this the housekeeping helper could not run at all. It is not a hole in the rule: the amount it
    // writes comes from `compensation`, which enforces its own closed-period guard on the way in
    // (core/comp.ts), so nothing a closed run relied on can be changed THROUGH here that was not already
    // allowed to change. ONLY the backfill passes it.
    allowClosedPeriod?: boolean;
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
    // 2aed39d4 — a change whose window touches a month a CLOSED run already paid is refused. Removal
    // uses the identical test (archiveEmploymentPayComponent); PROCESSED-but-open is deliberately fine.
    if (!p.allowClosedPeriod) {
      await assertNoClosedRunCovers(tx, {
        employmentId: p.employmentId,
        componentId: p.componentId,
        validFrom: p.effectiveFrom,
        validTo: effectiveTo,
      });
    }
    // 2aed39d4 — EVERY live row of this employment+component whose INCLUSIVE window touches the new one,
    // not just the open row. The old lookup required `validTo IS NULL`, so a live END-DATED row was
    // invisible to the writer and a second set inserted a duplicate over the top of it. See the long
    // note on this function for the three resolution rules.
    const clashes = await tx
      .select({
        id: employmentPayComponent.id,
        validFrom: employmentPayComponent.validFrom,
        validTo: employmentPayComponent.validTo,
        code: payComponent.code,
      })
      .from(employmentPayComponent)
      .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
      .where(
        and(
          eq(employmentPayComponent.employmentId, p.employmentId),
          eq(employmentPayComponent.componentId, p.componentId),
          isNull(employmentPayComponent.supersededAt),
          lte(employmentPayComponent.validFrom, effectiveTo ?? '9999-12-31'),
          or(isNull(employmentPayComponent.validTo), gte(employmentPayComponent.validTo, p.effectiveFrom)),
        ),
      )
      .orderBy(employmentPayComponent.validFrom);

    // PASS 1 — REFUSE BEFORE WRITING ANYTHING. Both refusals are raised over the whole scan first, so a
    // rejected save cannot leave a half-versioned row behind (the old code closed `cur` and only then
    // discovered the insert was bad).
    if (!p.supersedeOverlaps) {
      for (const c of clashes) {
        // The row being edited and the open row are versionable (pass 2). Any OTHER live end-dated row
        // the window runs into is the reporter's point 2 and is refused outright.
        const versionable = c.id === p.replacesId || c.validTo == null;
        if (!versionable) throw new FixedTransactionOverlapError(c.code, c.validFrom, c.validTo);
      }
      for (const c of clashes) {
        // Closing at effectiveFrom-1 would write an end date before the row's own start. Before the
        // 34cc8137 guard this wrote an inverted row silently; production still carries one.
        //
        // EXCEPT for the row being edited. Moving THAT row's own start date earlier is a correction of
        // the record the admin has open — the ticket's Edit function asks for exactly that — and it
        // rewrites nothing, because the row is superseded outright rather than closed into an inverted
        // window (pass 2). The refusal is for a restatement that would have to reach BACKWARDS THROUGH A
        // ROW THE ADMIN IS NOT LOOKING AT, which is a different act with a different blast radius.
        if (c.id !== p.replacesId && p.effectiveFrom < c.validFrom) {
          throw new FixedTransactionBackwardsError(c.code, c.validFrom, c.validTo);
        }
      }
    }

    // PASS 2 — resolve each clash. Nothing below can throw.
    for (const c of clashes) {
      // 2f889bae — CLOSE THE PRIOR ROW THE DAY BEFORE THE NEW ONE STARTS, NOT ON IT.
      //
      // This used to set validTo = effectiveFrom and the comment claimed "so there is no double-count".
      // That was false, and it had already overpaid on issued payslips. `validTo` is INCLUSIVE for pay
      // components — the kernel selects validFrom <= periodEnd AND (validTo IS NULL OR validTo >=
      // periodStart) and pays each returned row its FULL amount for the period — so closing ON the new
      // start date leaves BOTH rows inside the month that contains it, and the item pays twice.
      //
      // WHY NOT FIX THE KERNEL INSTEAD: flipping that gte to gt would silently change what every EXISTING
      // end-dated row pays in its final month. This changes only new writes.
      //
      // WHY compensation GETS AWAY WITH THE SAME LINE (core/comp.ts): its kernel reads a single open row
      // and its compensation_no_overlap EXCLUDE constraint uses a HALF-OPEN daterange, so valid_to is
      // exclusive there. Same writer shape, opposite boundary semantics — do not "align" one to the other
      // without changing the reader that goes with it. Migration 0426 makes that asymmetry explicit: the
      // pay-component constraint is the same shape with '[]' bounds instead of '[)'.
      if (p.effectiveFrom <= c.validFrom) {
        // Superseded, not closed: the row would cover zero days (a same-start restatement replaces it
        // outright), or — supersedeOverlaps only — the backfill is re-stating over the top of it.
        await tx
          .update(employmentPayComponent)
          .set({ supersededAt: sql`now()` })
          .where(eq(employmentPayComponent.id, c.id));
      } else {
        await tx
          .update(employmentPayComponent)
          .set({ validTo: addDaysIso(p.effectiveFrom, -1) })
          .where(eq(employmentPayComponent.id, c.id));
      }
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
 * prior row at that date (no double-count across the supersession close) and inherits every guard
 * (FixedTransactionDateError / UnsupportedFixedCurrencyError / FixedTransactionAmountError). The `id`
 * identifies WHICH row the admin is editing; we resolve its `componentId`/`employmentId` from the row itself
 * so a tampered componentId can't retarget the write, then apply the new amount/dates/cycle/remarks as a
 * fresh version. Event: `employment-pay-component.set` is appended by the underlying `set` (the versioned
 * write IS a set); no separate `.updated` event is needed and none is fabricated.
 *
 * 2aed39d4 — THE ONE-CLICK DUPLICATE THIS CLOSES. `[id]/page.tsx` renders the Edit form for an ENDED row
 * too (the `ended` flag only hides the Stop card), with the dates defaulted from the row. Save then went
 * through a `set` whose prior-row lookup required `validTo IS NULL` — so for an employee with no OPEN row
 * for that item nothing was found, and Save INSERTED A CLONE with the identical window. That is how
 * X000001 came to hold three HANDPHONE ALLOWANCE rows all running 2026-07-01..2026-07-01, two of them
 * written two minutes apart. The row's own id is now passed as `replacesId`, so the `set` treats it as
 * the row being versioned rather than as an unrelated clash: Save CHANGES the record instead of copying
 * it, and any OTHER live row the new window runs into is still refused.
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
        // 2aed39d4 — THE row the admin opened. Without this an edit of an ended row reads as a clash
        // with itself and is either refused or cloned; with it, the row is versioned.
        replacesId: p.id,
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
 * Thrown when a recurring fixed item is changed or removed in a way that would affect a month a CLOSED
 * pay run has already paid. `payPeriod` is that closed month, so the message can be specific.
 *
 * ── 2aed39d4 REVERSED WHAT THIS MEANS. READ THIS BEFORE RE-TIGHTENING IT. ──
 *
 * f1123afd introduced this error to refuse removal as soon as any PROCESSED payslip carried the item.
 * The reporter's expected-behaviour point 7 asks for the opposite, explicitly and with a worked example:
 * HR discovers a wrong fixed transaction AFTER payroll has been processed, deletes it, and reprocesses.
 * Their table is unambiguous — Processed/Not Closed: View Y, Edit Y, Delete Y, Reprocess Y; Closed:
 * View only, "unless the payroll is reopened/unlocked according to the payroll control". So the test is
 * now the BATCH STATUS, not the payslip's line evidence.
 *
 * WHY THE OLD TEST HAD TO GO RATHER THAN BE KEPT ALONGSIDE. It was never a rule, it was a coin flip.
 * There is no payslip LINE table; the per-item detail lives in `payslip.statutory.componentLines` /
 * `recordLines`, which the kernel only started stamping on 2026-08-01 (feedback 862ed0ad). Slips older
 * than that carry no line list at all, so the guard could not see them and ALLOWED the removal. Roughly
 * half the live items a processed payslip covered were therefore removable and half were not, with
 * nothing on screen to say which — X000001's three A0027 rows were all undeletable (the July slip
 * itemises A0027) while an adjacent employee's identical row was not. "Processed" is now uniformly
 * allowed and "closed" uniformly refused, which is both the reporter's rule and a rule at all.
 *
 * Nothing is closed on production today (22 batches, all `processed`, none carrying `closed_at`,
 * re-measured 2026-08-11), so this rule has no effect on existing data — which is exactly why it is
 * covered by tests rather than by observation.
 *
 * The right action when a run IS closed is `endEmploymentPayComponent` — end it from a date, which stops
 * future payment and leaves what was already paid intact. The refusal message names it.
 */
export class FixedTransactionPaidError extends Error {
  constructor(
    public readonly code: string,
    public readonly payPeriod: string,
  ) {
    super(
      `Pay run ${payPeriod} is closed, so pay item "${code}" can no longer be changed or removed for that period. Reopen the run, or end the item from a date instead.`,
    );
    this.name = 'FixedTransactionPaidError';
  }
}

/**
 * 2aed39d4 — is any CLOSED pay run's period inside this row's window? If so the row is frozen for that
 * period: changing or removing it would alter what a closed run relied on.
 *
 * ONE DEFINITION OF "PAYROLL EVIDENCE", NOT A FOURTH. The period helpers are `closedPeriodsTx` and
 * `overlapsClosedPeriod` from core/comp.ts — the same pair the Basic Salary card uses to decide which
 * compensation rows are deletable, and the same pair a Movement correction refuses on. Writing a fourth
 * period helper here is how two rules that are supposed to agree start disagreeing.
 *
 * ⚠️ THE BOUNDARY CONVERSION IS LOAD-BEARING. `overlapsClosedPeriod(periods, from, to)` treats `to` as
 * EXCLUSIVE — it was written for `compensation`, whose valid_to is exclusive. `employment_pay_component`
 * valid_to is INCLUSIVE (the kernel selects `validTo >= periodStart` and pays the row in full for that
 * month; migration 0426's daterange uses '[]' bounds for the same reason). So the inclusive end date is
 * converted with `addDaysIso(validTo, 1)` on the way in. Passing validTo straight through would let a
 * row whose LAST paid month is a closed month slip past the guard.
 *
 * WHAT THIS REPLACED, AND WHY THE OLD ONE IS GONE RATHER THAN KEPT: see FixedTransactionPaidError. The
 * previous test read `payslip.statutory.componentLines` — line evidence the kernel only began stamping
 * on 2026-08-01 — so it refused on about half the live items a processed payslip covered and allowed the
 * rest, with nothing on screen to say which. There is still no payslip LINE table and no stored link
 * from a payslip to the `employment_pay_component.id` that produced the money; the batch's status and
 * period are the only facts about a run that are recorded for every run, which is why the rule is built
 * on them.
 *
 * Read-only, and cheap: one indexed lookup over one employee's payslips.
 */
async function closedRunCovering(
  tx: Tx,
  p: { employmentId: string; validFrom: string; validTo: string | null },
): Promise<string | null> {
  const closed = await closedPeriodsTx(tx, p.employmentId);
  if (closed.length === 0) return null;
  // Inclusive validTo -> exclusive `to`. See the warning above.
  const exclusiveTo = p.validTo == null ? null : addDaysIso(p.validTo, 1);
  if (!overlapsClosedPeriod(closed, p.validFrom, exclusiveTo)) return null;
  // Name the EARLIEST closed period the window covers, so the message is stable rather than dependent on
  // the order the periods came back in.
  const hit = closed
    .filter((period) => overlapsClosedPeriod([period], p.validFrom, exclusiveTo))
    .sort()[0];
  return hit ?? null;
}

/**
 * 2aed39d4 — the write-side half of the same rule, shared by setEmploymentPayComponent (and therefore by
 * updateEmploymentPayComponent, which delegates to it). Resolves the pay item's code only when it is
 * about to throw, so the common path stays one query.
 */
async function assertNoClosedRunCovers(
  tx: Tx,
  p: { employmentId: string; componentId: string; validFrom: string; validTo: string | null },
): Promise<void> {
  const period = await closedRunCovering(tx, p);
  if (period == null) return;
  const [c] = await tx
    .select({ code: payComponent.code })
    .from(payComponent)
    .where(eq(payComponent.id, p.componentId))
    .limit(1);
  throw new FixedTransactionPaidError(c?.code ?? 'component', period);
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
      .select({
        id: employmentPayComponent.id,
        code: payComponent.code,
        name: payComponent.name,
        validFrom: employmentPayComponent.validFrom,
        validTo: employmentPayComponent.validTo,
      })
      .from(employmentPayComponent)
      .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
      .where(
        and(
          eq(employmentPayComponent.id, p.id),
          eq(employmentPayComponent.employmentId, p.employmentId),
          isNull(employmentPayComponent.supersededAt),
        ),
      )
      .limit(1);
    if (!row) throw new FixedTransactionNotFoundError();
    // 2aed39d4 — REFUSE only when a CLOSED run covers this row's window. A run that is merely PROCESSED
    // is deliberately NOT a refusal: the reporter's expected-behaviour point 7 asks for exactly the
    // sequence "payroll processed -> HR finds the wrong item -> delete -> reprocess", and this used to
    // refuse it (unevenly — see FixedTransactionPaidError). Refused BEFORE any write.
    const closedPeriod = await closedRunCovering(tx, {
      employmentId: p.employmentId,
      validFrom: row.validFrom,
      validTo: row.validTo,
    });
    if (closedPeriod) throw new FixedTransactionPaidError(row.code, closedPeriod);
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
 *  LACKING classification (legacy rows keep the legacy fail-closed behaviour).
 *
 *  EXPORTED for f35f758a note 8, so the pay item MASTER SAVE (app/admin/pay-components/actions.ts) runs
 *  the same predicate the batch picker, `setPayrollBatchComponent` and the CSV importer already run.
 *  Exported rather than copied deliberately: a second hand-written copy of a fail-closed rule is how the
 *  entry gate and the kernel start disagreeing about which pay codes are allowed to exist. STATE-BASED —
 *  it reads the row being saved, so an already-bad row can still be edited back into a good one. */
export const isUnsupportedTaxableComponent = (c: { includedInEpf: boolean; includedInSocsoEis: boolean; includedInPcb: boolean; isNonPayable: boolean; pcbRemunerationType?: string | null }) =>
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

/** Seed BASIC + ALLOWANCE recurring components from every open compensation row. Idempotent:
 *  setEmploymentPayComponent supersedes whatever live rows the compensation window overlaps, so
 *  re-running just re-states it.
 *  Feedback 64fb5e48 — OPTIONAL housekeeping only: the payroll engine now always pays basic from the
 *  Personnel compensation record, so BASIC component amounts no longer drive pay (a divergent one only
 *  surfaces as the staleBasicComponent warning in the pre-processing checks, and a missing one is not a
 *  gap at all). Kept for tenants that want the BASIC line mirrored into the typed component tables.
 *
 *  2aed39d4 — WHY THIS PASSES THREE EXPLICIT OPT-OUTS, AND WHY SKIPPING ANY OF THEM BREAKS IT.
 *  This helper re-states BASIC and ALLOWANCE from each open compensation row at THAT ROW'S OWN
 *  validFrom, which is routinely years behind whatever the pay-component table now holds. It is not a
 *  hypothetical: it PRODUCED one of the ten overlaps measured on production (EMP-0001 BASIC 3000.00
 *  ending 2026-08-01 sitting alongside BASIC 6800.00 starting 2026-08-01), and 34cc8137's
 *  backwards-restatement guard had already put it one run away from throwing before this item existed.
 *    • allowZeroAmount   — a zero-allowance compensation line is a legitimate 0-amount row.
 *    • supersedeOverlaps — re-state over whatever sits in the way instead of refusing. Compensation is
 *      the system of record for both codes, so replacing the pay-component mirror is the whole point.
 *    • allowClosedPeriod — the window reaches back over closed months by construction.
 *  Each is named for exactly what it waives; none of them is inherited by any UI path. */
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
      await setEmploymentPayComponent(ctx, { employmentId: c.employmentId, componentId: basicId, amount: Number(c.basicSalary), effectiveFrom: c.validFrom, allowZeroAmount: true, supersedeOverlaps: true, allowClosedPeriod: true }, tx);
      await setEmploymentPayComponent(ctx, { employmentId: c.employmentId, componentId: allowId, amount: Number(c.monthlyAllowance ?? 0), effectiveFrom: c.validFrom, allowZeroAmount: true, supersedeOverlaps: true, allowClosedPeriod: true }, tx);
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
