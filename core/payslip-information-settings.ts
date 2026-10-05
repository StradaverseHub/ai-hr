import { and, eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { company, payslipInformationSetting } from '../db/schema';
import { appendEvent, actorOf } from '../db/events';
import { canManagePayroll } from '../lib/authz';
import { PAYSLIP_INFORMATION_FIELDS, payslipInformationFields } from './payslip-information';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getPayslipInformationSettings(ctx: SessionContext, companyId: string) {
  if (!canManagePayroll(ctx, companyId)) throw new Error('Forbidden');
  return withTenant(ctx, async tx => {
    const [owned] = await tx.select({id: company.id}).from(company)
      .where(and(eq(company.id, companyId), eq(company.tenantId, ctx.tenantId)));
    if (!owned) throw new Error('Forbidden');
    const [row] = await tx.select().from(payslipInformationSetting).where(eq(payslipInformationSetting.companyId, companyId));
    return payslipInformationFields(row?.fields);
  });
}

/**
 * r389 (23bd49d9) — `fields` is saved in the order given: it is the payslip's reading order. It is no longer
 * re-sorted into the catalogue order, and a list naming a field twice is refused rather than silently
 * collapsed, because a client that sends a duplicate has lost track of its own order.
 */
export async function setPayslipInformationSettings(ctx: SessionContext, companyId: string, fields: string[]) {
  if (!canManagePayroll(ctx, companyId)) throw new Error('Forbidden');
  if (fields.some(k => !(PAYSLIP_INFORMATION_FIELDS as readonly string[]).includes(k))) throw new Error('Unknown payslip field');
  if (new Set(fields).size !== fields.length) throw new Error('Duplicate payslip field');
  const ordered = [...fields];
  return withTenant(ctx, async tx => {
    const [owned] = await tx.select({id: company.id}).from(company)
      .where(and(eq(company.id, companyId), eq(company.tenantId, ctx.tenantId)));
    if (!owned) throw new Error('Forbidden');
    await tx.insert(payslipInformationSetting).values({tenantId: ctx.tenantId, companyId, fields: ordered})
      .onConflictDoUpdate({target: payslipInformationSetting.companyId, set: {fields: ordered}});
    await appendEvent(tx, {tenantId: ctx.tenantId, aggregateType: 'company', aggregateId: companyId,
      eventType: 'payslip-information.changed', actor: actorOf(ctx), payload: {fields: ordered}});
    return ordered;
  });
}

/** Why a copy was refused, as a code the action can put into the reader's language. */
export type PayslipInformationCopyRefusal =
  | {code: 'payslipCopyNoTargets'}
  /** `companyName` is null when the id is not a company of this tenant: a foreign name is never revealed. */
  | {code: 'payslipCopyTargetForbidden'; companyName: string | null};

function refusal(r: PayslipInformationCopyRefusal, message: string): Error {
  return Object.assign(new Error(message), r);
}

export function payslipInformationCopyRefusal(e: unknown): PayslipInformationCopyRefusal | null {
  const code = (e as {code?: unknown} | null)?.code;
  if (code === 'payslipCopyNoTargets') return {code};
  if (code === 'payslipCopyTargetForbidden') {
    const name = (e as {companyName?: unknown}).companyName;
    return {code, companyName: typeof name === 'string' ? name : null};
  }
  return null;
}

/**
 * r389 (23bd49d9) — Copy to Companies. The source company's SAVED setting (not whatever is on the screen) is
 * written to every target in one transaction, and each target is an ordinary independent row afterwards:
 * nothing links it back to the source.
 *
 * Targets are de-duplicated and the source is dropped from them. The copy is all-or-nothing: if any target
 * is outside what the caller may manage — another company's payroll partner, an id from another tenant, an
 * id that is not a company — the whole copy is refused before anything is written, naming the first such
 * target in the order given (by name only when it is a company of this tenant). RLS's WITH CHECK on
 * payslip_information_setting refuses the same writes independently, inside the same transaction.
 *
 * Events: one `payslip-information.changed` per target (its new fields, what it showed before, and where they
 * were copied from) and one `payslip-information.copied` on the source naming the targets.
 */
export async function copyPayslipInformationSettings(ctx: SessionContext, sourceCompanyId: string, targetCompanyIds: readonly string[]) {
  if (!canManagePayroll(ctx, sourceCompanyId)) throw new Error('Forbidden');
  const targets = [...new Set(targetCompanyIds.map(String))].filter(id => id !== sourceCompanyId);
  if (targets.length === 0) throw refusal({code: 'payslipCopyNoTargets'}, 'Choose at least one other company to copy to');
  return withTenant(ctx, async tx => {
    const [owned] = await tx.select({id: company.id}).from(company)
      .where(and(eq(company.id, sourceCompanyId), eq(company.tenantId, ctx.tenantId)));
    if (!owned) throw new Error('Forbidden');
    const wellFormed = targets.filter(id => UUID_RE.test(id));
    const known = wellFormed.length === 0 ? [] : await tx.select({id: company.id, name: company.legalName}).from(company)
      .where(and(inArray(company.id, wellFormed), eq(company.tenantId, ctx.tenantId)));
    const nameOf = new Map(known.map(c => [c.id, c.name]));
    for (const id of targets) {
      if (nameOf.has(id) && canManagePayroll(ctx, id)) continue;
      const companyName = nameOf.get(id) ?? null;
      throw refusal({code: 'payslipCopyTargetForbidden', companyName},
        `You cannot manage payroll for ${companyName ?? 'one of the selected companies'}; nothing was copied`);
    }
    const [source] = await tx.select({fields: payslipInformationSetting.fields}).from(payslipInformationSetting)
      .where(eq(payslipInformationSetting.companyId, sourceCompanyId));
    const fields = [...payslipInformationFields(source?.fields)];
    const prior = await tx.select({companyId: payslipInformationSetting.companyId, fields: payslipInformationSetting.fields})
      .from(payslipInformationSetting).where(inArray(payslipInformationSetting.companyId, targets));
    const priorOf = new Map(prior.map(r => [r.companyId, r.fields]));
    for (const id of targets) {
      // `before` is what that company's payslips showed: its saved list, or the defaults when it had none.
      const before = [...payslipInformationFields(priorOf.get(id))];
      await tx.insert(payslipInformationSetting).values({tenantId: ctx.tenantId, companyId: id, fields})
        .onConflictDoUpdate({target: payslipInformationSetting.companyId, set: {fields}});
      await appendEvent(tx, {tenantId: ctx.tenantId, aggregateType: 'company', aggregateId: id,
        eventType: 'payslip-information.changed', actor: actorOf(ctx),
        payload: {fields, before, copiedFromCompanyId: sourceCompanyId}});
    }
    await appendEvent(tx, {tenantId: ctx.tenantId, aggregateType: 'company', aggregateId: sourceCompanyId,
      eventType: 'payslip-information.copied', actor: actorOf(ctx), payload: {fields, targetCompanyIds: targets}});
    return {fields, targetCompanyIds: targets};
  });
}
