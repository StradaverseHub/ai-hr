/**
 * 1.2.6 EA Data Overwrite (ADR-0059) — an EA-ONLY amendment layer. Authorized HR may overwrite/amend
 * specific EA-form fields (employment income, allowances, bonus, tax deduction, statutory values) WITHOUT
 * mutating the original payroll records. The amended amount is overlaid onto the payroll-derived figure at
 * render time inside the MY pack's eaStatement(), so it affects ONLY the generated EA form — not payroll,
 * not CP8D/Form E, not any other surface.
 *
 * Substrate discipline (non-negotiable): every write appends a DomainEvent in the SAME tx via appendEvent,
 * actor via actorOf(ctx). RBAC: the service guard (isAdmin / canManagePayroll) is the PRIMARY enforcement
 * point; the table's RLS WITH CHECK can_admin_employment is the secondary SQL backstop. No approval /
 * maker-checker workflow — HR amends directly, RBAC-gated (per the approved plan).
 */
import { and, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { eaOverride } from '../db/schema';
import { canManagePayroll, isAdmin } from '../lib/authz';
import { employeeEaStatement } from './reporting';
import { countryPacks } from '../localization/registry';
import type { EaField, EaStatement } from '../localization/country-pack';

/**
 * The EA-form field vocabulary, supplied by the registered country packs (ADR-0080 D6, rung 5a —
 * `pack.eaFields`; formerly a direct localization/my import). The overwrite layer is validated before
 * the per-employment pack is resolved (employeeEaStatement does that), so the vocabulary is the union
 * across registered packs — byte-identical with MY as the only pack.
 */
export const EA_FIELDS: readonly EaField[] = countryPacks().flatMap((p) => p.eaFields);
export type { EaField } from '../localization/country-pack';

export class EaOverrideError extends Error {
  constructor(
    message: string,
    readonly code: 'forbidden' | 'invalidField' | 'invalidAmount' | 'invalidYear' | 'reasonRequired' | 'notFound',
  ) {
    super(message);
    this.name = 'EaOverrideError';
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const isField = (s: string): s is EaField => (EA_FIELDS as readonly string[]).includes(s);

/**
 * #18 — the EA statutory fields that correspond to a REMITTED figure on a monthly statutory return, so an
 * amendment must be reconciled against the year's FILED total:
 *   - `mtd`   → the CP39 / e-Data MTD (sum of payslip.statutory.pcb — the same source cp39-file.ts files)
 *   - `epf`   → the KWSP employee-share total (sum of payslip.statutory.epfEmployee)
 *   - `socso` → the PERKESO employee-share total (sum of payslip.statutory.socsoEmployee)
 *   - `eis`   → the EIS/SIP employee-share total (sum of payslip.statutory.eisEmployee)
 * For these, the payroll-DERIVED value IS the filed total (both read the stored payslip statutory scalars),
 * so divergence = amended ≠ derived/filed. Part B income fields (grossSalary/bonus/allowances/gross) carry
 * no remittance and are NOT reconciled.
 */
// 6036dab7 — `cp38` joins them: it is remitted on the SAME CP39 return as the MTD (cp39() totals both,
// localization/my/reports.ts), so an amendment to it diverges from a filed agency figure exactly as an
// `mtd` amendment does. `zakat` deliberately does NOT: zakat-via-salary is paid to a state religious
// authority, not remitted on the CP39, so there is no filed total on this system to reconcile it against
// and claiming one would be the overstatement this reconciliation exists to prevent.
const STATUTORY_FIELDS = new Set<EaField>(['mtd', 'cp38', 'epf', 'socso', 'eis']);
const isStatutoryField = (f: EaField): boolean => STATUTORY_FIELDS.has(f);
const MONEY_TOL = 0.005;

/** Service-layer write guard (the primary gate; RLS is the SQL backstop). Admin OR payroll partner. */
function assertCanAmend(ctx: SessionContext) {
  if (!isAdmin(ctx) && !canManagePayroll(ctx)) {
    throw new EaOverrideError('Not authorized to amend EA figures', 'forbidden');
  }
}

/**
 * The pure payroll-DERIVED value for one EA field (before any override). The statement already overlays
 * active overrides, so when an override for `field` exists we read its `original` (the pre-overlay derived
 * value); otherwise the statement's current field value IS the derived value. Returns null only when the
 * employment is missing (eaStatement → null).
 */
function derivedField(ea: EaStatement, field: EaField): number {
  const existing = ea.overrides.find((o) => o.field === field);
  if (existing) return existing.original;
  // 6036dab7 — NO `default:` CLAUSE, ON PURPOSE. This switch is exhaustive over EaField, so adding a box
  // to the EA vocabulary without deciding where its derived baseline comes from is a COMPILE error rather
  // than a silent `undefined` written into an amendment's audit `before`. That is what the tsc gate caught
  // when the twelve manual boxes were added, and it is why the arm below reads them off the statement
  // (where the pack has already resolved their baseline to 0) instead of hard-coding a literal here.
  switch (field) {
    case 'grossSalary':
      return ea.partB.grossSalary;
    case 'bonus':
      return ea.partB.bonus;
    case 'allowances':
      return ea.partB.allowances;
    case 'gross':
      return ea.partB.gross;
    case 'mtd':
      return ea.partD.mtd;
    case 'cp38':
      return ea.partD.cp38;
    case 'zakat':
      return ea.partD.zakat;
    case 'epf':
      return ea.partE.epf;
    case 'socso':
      return ea.partE.socso;
    case 'eis':
      return ea.partE.eis;
    case 'directorFee':
      return ea.partB.directorFee;
    case 'tipsPerquisites':
      return ea.partB.tipsPerquisites;
    case 'taxBorneByEmployer':
      return ea.partB.taxBorneByEmployer;
    case 'esos':
      return ea.partB.esos;
    case 'gratuity':
      return ea.partB.gratuity;
    case 'arrears':
      return ea.partB.arrears;
    case 'benefitsInKind':
      return ea.partB.benefitsInKind;
    case 'livingAccommodation':
      return ea.partB.livingAccommodation;
    case 'unapprovedFundRefund':
      return ea.partB.unapprovedFundRefund;
    case 'compensation':
      return ea.partB.compensation;
    case 'pension':
      return ea.partC.pension;
    case 'annuity':
      return ea.partC.annuity;
    // da4fc817 — Section D's four. `tp1Relief` has a real derived baseline (the year's approved TP1
    // declarations through `tp1CountForYear`); `donations` and `zakatOther` are 0 until HR enters one,
    // exactly like the manual Part B boxes above. All are read off the statement where the pack
    // resolved them, which is why this switch needs no change when a baseline starts being derived.
    //
    // ⚠️ r351 — `childRelief` NOW HAS A REAL DERIVED BASELINE TOO, and two consequences follow that are
    // worth stating rather than discovering. (1) The no-op clear at the foot of `setEaOverride` compares
    // the keyed amount against THIS value, so HR keying the derived figure back in deletes the override
    // — correct, and now reachable for this field. HR keying 0 to suppress the box stores an override of
    // 0, which the renderer prints as an empty rule; that is a usable escape hatch and it is deliberate.
    // (2) Any `ea_override` row for `childRelief` written BEFORE r351 recorded `original: 0`, so its
    // audit trail states a `before` that no longer matches the baseline. Those rows are not rewritten —
    // an audit trail records what was true when it was written.
    case 'tp1Relief':
      return ea.partD.tp1Relief;
    case 'donations':
      return ea.partD.donations;
    case 'zakatOther':
      return ea.partD.zakatOther;
    case 'childRelief':
      return ea.partD.childRelief;
  }
}

export type EaOverrideRow = { field: EaField; amount: number; reason: string };

/** Active overrides for (employment, year) — for the editor UI and any caller that needs the raw rows. */
export async function listEaOverrides(
  ctx: SessionContext,
  p: { employmentId: string; year: string },
): Promise<EaOverrideRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ field: eaOverride.field, amount: eaOverride.amount, reason: eaOverride.reason })
      .from(eaOverride)
      .where(and(eq(eaOverride.employmentId, p.employmentId), eq(eaOverride.year, p.year)));
    return rows.filter((r) => isField(r.field)).map((r) => ({ field: r.field as EaField, amount: round2(Number(r.amount)), reason: r.reason }));
  });
}

/** Outcome of an EA amend. For a STATUTORY field (#18) the year's filed CP39/agency total + the amend's
 *  delta + a divergence flag are surfaced (and persisted structurally on the event); non-statutory fields
 *  carry filedTotal=null, delta=0, diverges=false. */
export type SetEaOverrideResult = {
  cleared: boolean;
  /** The year's filed total from payslip.statutory.* for a statutory field; null for non-statutory. */
  filedTotal: number | null;
  /** amended − filedTotal (0 for non-statutory or a cleared no-op). */
  delta: number;
  /** true when a statutory amend diverges from the filed total beyond rounding tolerance. */
  diverges: boolean;
};

/**
 * Set (upsert) an EA-only amendment for one field. RBAC-gated (service guard + RLS WITH CHECK). Validates
 * field ∈ EA_FIELDS, amount finite ≥ 0 (zeroing a derived figure is legitimate), year `^\d{4}$`, reason
 * non-empty. If the amended value equals the derived value to 2dp it is a NO-OP CLEAR (delete any row),
 * not a redundant override. Appends `ea.override.set` (or `ea.override.cleared` on the no-op path) with the
 * derived `before` and amended `after` in the payload.
 *
 * #18 — for a STATUTORY field (mtd/epf/socso/eis) the year's FILED total (the same payslip.statutory.* the
 * CP39/KWSP/PERKESO returns file) equals the derived `before`; we compute its divergence from the amended
 * figure and persist { filedTotal, delta } STRUCTURALLY on the event (not just in the free-text reason) so an
 * LHDN/agency audit can read "derived/filed vs amended". The result surfaces it for the amend panel's warning.
 */
export async function setEaOverride(
  ctx: SessionContext,
  p: { employmentId: string; year: string; field: string; amount: number; reason: string },
): Promise<SetEaOverrideResult> {
  assertCanAmend(ctx);
  if (!isField(p.field)) throw new EaOverrideError(`Unknown EA field: ${p.field}`, 'invalidField');
  if (!/^\d{4}$/.test(p.year)) throw new EaOverrideError(`Invalid year: ${p.year}`, 'invalidYear');
  const reason = (p.reason ?? '').trim();
  if (!reason) throw new EaOverrideError('A reason is required', 'reasonRequired');
  if (!Number.isFinite(p.amount) || p.amount < 0) {
    throw new EaOverrideError('Amount must be a number ≥ 0', 'invalidAmount');
  }
  const amount = round2(p.amount);
  const field = p.field;

  // The pre-overlay derived baseline drives both the no-op-clear check and the audit `before`.
  const ea = await employeeEaStatement(ctx, { employmentId: p.employmentId, year: p.year });
  if (!ea) throw new EaOverrideError('Employment not found', 'notFound');
  const before = derivedField(ea, field);

  // #18 — for a statutory field, the year's FILED total IS the derived baseline (both read the stored
  // payslip statutory scalars — the same source CP39/KWSP/PERKESO files). Compute its divergence so the
  // event carries the structured { filedTotal, delta } trail and the caller can warn.
  const isStatutory = isStatutoryField(field);
  const filedTotal = isStatutory ? round2(before) : null;
  const delta = filedTotal !== null ? round2(amount - filedTotal) : 0;
  const diverges = filedTotal !== null && Math.abs(delta) > MONEY_TOL;
  /** Structured CP39/agency reconciliation, persisted on the event payload — statutory fields only. */
  const recon = filedTotal !== null ? { filedTotal, delta } : {};

  return withTenant(ctx, async (tx) => {
    // No-op: amended == derived ⇒ drop any existing override rather than persist a redundant one.
    if (round2(before) === amount) {
      const deleted = await tx
        .delete(eaOverride)
        .where(and(eq(eaOverride.employmentId, p.employmentId), eq(eaOverride.year, p.year), eq(eaOverride.field, field)))
        .returning({ id: eaOverride.id });
      if (deleted.length > 0) {
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'ea-override',
          aggregateId: deleted[0].id,
          eventType: 'ea.override.cleared',
          actor: actorOf(ctx),
          subjectEmploymentId: p.employmentId,
          payload: { field, before, after: before, reason },
        });
      }
      // amended == filed ⇒ delta 0, no divergence (a no-op clear is reconciled by definition).
      return { cleared: true, filedTotal, delta: 0, diverges: false };
    }

    const [row] = await tx
      .insert(eaOverride)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        year: p.year,
        field,
        amount: amount.toFixed(2),
        reason,
        createdByUserId: ctx.userId ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [eaOverride.tenantId, eaOverride.employmentId, eaOverride.year, eaOverride.field],
        set: { amount: amount.toFixed(2), reason, createdByUserId: ctx.userId ?? null, updatedAt: new Date() },
      })
      .returning({ id: eaOverride.id });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'ea-override',
      aggregateId: row.id,
      eventType: 'ea.override.set',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // #18 — { filedTotal, delta } is spread for statutory fields (auditable "filed CP39 vs amended").
      payload: { field, before, after: amount, reason, ...recon },
    });
    return { cleared: false, filedTotal, delta, diverges };
  });
}

/**
 * Hard-clear (reset to derived) one EA field's amendment. Admin-guarded; a hard DELETE — the immutable
 * event log preserves the trail. Appends `ea.override.cleared` with the prior amended value as `before`.
 * No-op (returns cleared:false) when no override exists.
 */
export async function clearEaOverride(
  ctx: SessionContext,
  p: { employmentId: string; year: string; field: string },
): Promise<{ cleared: boolean }> {
  assertCanAmend(ctx);
  if (!isField(p.field)) throw new EaOverrideError(`Unknown EA field: ${p.field}`, 'invalidField');
  if (!/^\d{4}$/.test(p.year)) throw new EaOverrideError(`Invalid year: ${p.year}`, 'invalidYear');
  const field = p.field;

  return withTenant(ctx, async (tx) => {
    const [prior] = await tx
      .select({ id: eaOverride.id, amount: eaOverride.amount })
      .from(eaOverride)
      .where(and(eq(eaOverride.employmentId, p.employmentId), eq(eaOverride.year, p.year), eq(eaOverride.field, field)))
      .limit(1);
    if (!prior) return { cleared: false };
    await tx.delete(eaOverride).where(eq(eaOverride.id, prior.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'ea-override',
      aggregateId: prior.id,
      eventType: 'ea.override.cleared',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { field, before: round2(Number(prior.amount)) },
    });
    return { cleared: true };
  });
}
