/** Explicit read owner for Assistant tools. No provider, action or unscoped query API is exposed. */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { AiAllowanceError, AiGatewayError } from '../lib/ai/types';
import { assertAiPrincipalTx } from './ai-principal';
import { assertMayUseAssistant } from './assistant-grant';
import { assertModuleEnabled, resolveEntitlementsTx } from './entitlements';
import { assertAiActionUnpausedTx } from './ai-governance';
import * as reads from './read';
import { ownClaimStatuses } from '../packs/claims/service';
import { createModuleAgentReaders } from './module-agent-readers';

const unavailable = (): never => { throw new AiGatewayError('Assistant data access could not be confirmed.'); };
const principalKey = (ctx: SessionContext) => JSON.stringify([ctx.tenantId, ctx.userId, ctx.personId ?? null, ctx.roles ?? null, ctx.grants ?? null]);
const owners = new WeakMap<object, { active: boolean; principal: string; tx: Tx }>();

function createReads(ctx: SessionContext, tx: Tx, active: () => boolean) {
  const checked = async <T>(read: () => Promise<T>): Promise<T> => {
    if (!active()) return unavailable();
    const result = await read();
    if (!active()) return unavailable();
    return result;
  };
  return Object.freeze({
    ...createModuleAgentReaders(ctx, tx, active),
    myEmployment: (selected?: { employmentId: string }) => checked(() => reads.myEmployment(ctx, selected, tx)),
    myEmployments: (opts?: { profileEdit?: boolean }) => checked(() => reads.myEmployments(ctx, opts, tx)),
    myEmploymentIdsAll: () => checked(() => reads.myEmploymentIdsAll(ctx, tx)),
    employeeDetail: (id: string) => checked(() => reads.employeeDetail(ctx, id, undefined, tx)),
    leaveBalances: (id: string, locale?: string, opts?: reads.LeaveBalanceReadOptions) => checked(() => reads.leaveBalances(ctx, id, locale, opts, tx)),
    leaveEntitlementBreakdown: (id: string, typeId: string, asOf: string, locale?: string, opts?: { derivation?: boolean }) => checked(() => reads.leaveEntitlementBreakdown(ctx, id, typeId, asOf, locale, opts, tx)),
    leaveRequestsFor: (id: string, locale?: string) => checked(() => reads.leaveRequestsFor(ctx, id, locale, tx)),
    reportingLinesFor: (id: string) => checked(() => reads.reportingLinesFor(ctx, id, tx)),
    myPayslips: (ids: string[], ownOnly = false) => checked(() => reads.myPayslips(ctx, ids, ownOnly, tx)),
    plannedAbsences: (companies: string[] | undefined, range: { from: string; to: string }, today?: string, opts?: { personIds?: string[] }) => checked(() => reads.plannedAbsences(ctx, companies, range, today, opts, tx)),
    awayTodayCount: (companies: string[] | undefined, today: string, exclude?: string | null) => checked(() => reads.awayTodayCount(ctx, companies, today, exclude, tx)),
    subordinateLeaveSummary: (id: string, today: string, locale?: string) => checked(() => reads.subordinateLeaveSummary(ctx, id, today, locale, tx)),
    upcomingHolidays: (opts: { from: string; limit?: number }) => checked(() => reads.upcomingHolidays(ctx, opts, tx)),
    holidayDatesForEmployment: (range: { employmentId: string; from: string; to: string }) => checked(() => reads.holidayDatesForEmployment(ctx, range, tx)),
    ownClaimStatuses: (limit: number) => checked(() => ownClaimStatuses(ctx, limit, tx)),
  });
}
/** Closed canonical methods only: no transaction handle, session constructor or effect function. */
export type AssistantReadSession = ReturnType<typeof createReads>;

async function guard(tx: Tx, ctx: SessionContext, module: string | null) {
  await assertAiPrincipalTx(tx, ctx);
  const fresh = { ...ctx, entitlements: await resolveEntitlementsTx(tx, ctx.tenantId) };
  await assertMayUseAssistant(fresh, tx);
  if (module !== null) assertModuleEnabled(fresh, module);
  await assertAiActionUnpausedTx(tx, fresh, 'hr_assistant');
  return fresh;
}

/** Outer batches own one Read Committed/read-only transaction. A nested tool explicitly receives
 * the same opaque method set; no ambient context or nested transaction auto-joining exists.
 * Private ownership rejects forged, cross-principal or escaped sessions. Network calls must remain
 * outside this callback. This is a read prerequisite, not historical-answer or effect authority.
 */
export async function withAssistantRead<T>(ctx: SessionContext, module: string | null,
  consume: (session: AssistantReadSession) => Promise<T>, existing?: AssistantReadSession): Promise<T> {
  const captured = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  try {
    if (existing) {
      const owner = owners.get(existing);
      if (!owner?.active || owner.principal !== principalKey(captured)) return unavailable();
      await guard(owner.tx, captured, module);
      return await consume(existing);
    }
    return await withTenant(captured, async tx => {
      // Session setup performs SELECT/set_config only; this is still before any write.
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      const fresh = await guard(tx, captured, module);
      const owner = { active: true, principal: principalKey(captured), tx };
      const session = createReads(fresh, tx, () => owner.active);
      owners.set(session, owner);
      try { return await consume(session); }
      finally { owner.active = false; }
    });
  } catch (error) {
    if (error instanceof AiAllowanceError) throw error;
    return unavailable();
  }
}

/** Explicit carrier-mode prerequisite. Only canonical named readers leave this boundary;
 * the transaction remains private to the trusted source/admission owner.
 */
async function withBoundAssistantReadsTx<T>(ctx: SessionContext, tx: Tx, modeExpected: 'on' | 'off',
  consume: (session: AssistantReadSession) => Promise<T>): Promise<T> {
  const captured = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  try {
    const [mode] = await tx.execute<{ readonly: string }>(sql`select current_setting('transaction_read_only') as readonly`);
    if (mode?.readonly !== modeExpected) return unavailable();
    const fresh = await guard(tx, captured, null);
    const owner = { active: true, principal: principalKey(captured), tx };
    const session = createReads(fresh, tx, () => owner.active);
    owners.set(session, owner);
    try { return await consume(session); }
    finally { owner.active = false; }
  } catch (error) {
    if (error instanceof AiAllowanceError) throw error;
    return unavailable();
  }
}

/** Historical/source read owners must already own an actual READ ONLY transaction. */
export function withAssistantReadTx<T>(ctx: SessionContext, tx: Tx,
  consume: (session: AssistantReadSession) => Promise<T>): Promise<T> {
  return withBoundAssistantReadsTx(ctx, tx, 'on', consume);
}

/** Canonical provider admission must write only its own reservation after source checks. Its trusted
 * owner explicitly supplies that write-mode transaction; tools still receive only named read methods.
 * This path does NOT promise transaction-level READ ONLY. It grants no model or effect capability.
 */
export function withAssistantAdmissionReadsTx<T>(ctx: SessionContext, tx: Tx,
  consume: (session: AssistantReadSession) => Promise<T>): Promise<T> {
  return withBoundAssistantReadsTx(ctx, tx, 'off', consume);
}

/** A trusted governed read job may reserve its bounded promotion permit in its own write-mode
 * transaction. Its consumers still receive only current-principal canonical readers, whose lifetime
 * ends with this callback. This is neither provider admission nor a model effect capability.
 */
export function withAssistantJobReadsTx<T>(ctx: SessionContext, tx: Tx,
  consume: (session: AssistantReadSession) => Promise<T>): Promise<T> {
  return withBoundAssistantReadsTx(ctx, tx, 'off', consume);
}
