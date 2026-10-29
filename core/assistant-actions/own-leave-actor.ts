/** Current human actor reads for this one action. Not a confirmation capability or AI pause check. */
import type { SessionContext, Tx } from '../../db/client';
import {isAiPrincipalCurrentTx} from '../ai-principal';
import { mayUseAssistant } from '../assistant-grant';
import { resolveEntitlementsTx } from '../entitlements';

/** Keep the supplied authority narrow: never replace claimed grants with a more privileged principal.
 * The shared principal proof refuses stale roles/scopes; the explicit person predicate additionally
 * refuses a relinked login. Refresh module/settings reads in the same transaction, without retaining
 * a failed old entitlement resolution. Access writers participating in the existing tenant lock
 * cannot change that identity proof until this transaction ends. Refuse an older repeatable-read
 * snapshot: this read must take a new statement snapshot after acquiring the access lock.
 *
 * Canonical Assistant grant/revoke writers now join this Access lock. Module, leave-policy and
 * balance writers still need their own participating dependency interval; this does not check AI
 * pauses or prove all storage writers participate. The command must close those dependencies. No nested
 * transaction, provider call, model admission, action record or domain event is created here. */
export async function readOwnLeaveActorTx(tx: Tx, ctx: SessionContext): Promise<SessionContext | null> {
  if (!ctx.userId || !ctx.personId || ctx.entitlementsExempt !== undefined
    || ctx.statutoryOverride !== undefined) return null;
  // The caller can retain and mutate its context while this function awaits the lock or SQL.
  // Bind every later read and the returned context to the same initial identity/carriers.
  ctx = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  if(!await isAiPrincipalCurrentTx(tx,ctx))return null;
  const fresh: SessionContext = { ...ctx, entitlementsError: undefined,
    entitlements: await resolveEntitlementsTx(tx, ctx.tenantId) };
  return (await mayUseAssistant(fresh, tx)).allowed ? fresh : null;
}
