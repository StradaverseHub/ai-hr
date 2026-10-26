/** UNMOUNTED canonical browser bindings. Authentication is the eventual route's real cookie session,
 * never a posted SessionContext. No model tool, provider or orchestration executor calls this owner.
 * Migrations/relevant writer/security/retention/experience acceptance remain required before mount. */
import { withTenant, type SessionContext } from '../../db/client';
import { createOwnLeaveBrowserHandler } from '../../lib/assistant-actions/own-leave-http';
import { confirmOwnLeaveReview, discardOwnLeaveReviewTx, expireOwnLeaveReviewsForCallerTx, listOwnLeaveReviewsTx, prepareOwnLeaveReviewTx, reopenOwnLeaveReviewTx } from './own-leave-store';

type BrowserSession = Readonly<{ ctx: SessionContext; locale?: string }>;
export function createOwnLeaveBrowserCommandHandler(authenticate: () => Promise<BrowserSession>) {
  // Cleanup commits separately: later grant/source refusal must not retain an already expired
  // private body. It cannot execute leave, and confirmation still owns its own TOP-LEVEL transaction.
  const cleanup = ({ ctx }: BrowserSession) => withTenant(ctx, tx => expireOwnLeaveReviewsForCallerTx(tx));
  return createOwnLeaveBrowserHandler({
    authenticate: async () => {
      const session = await authenticate(), ctx = session.ctx;
      return Object.freeze({ ctx: { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) }, locale: session.locale });
    },
    list: async (session) => {
      await cleanup(session);
      return withTenant(session.ctx, tx => listOwnLeaveReviewsTx(tx, session.ctx));
    },
    prepare: async (session, packet) => {
      await cleanup(session);
      return withTenant(session.ctx, tx => prepareOwnLeaveReviewTx(tx, session.ctx, packet.nomination, packet.selection, packet.humanText, session.locale));
    },
    reopen: async (session, actionId) => {
      await cleanup(session);
      return withTenant(session.ctx, tx => reopenOwnLeaveReviewTx(tx, session.ctx, actionId));
    },
    // Confirmation MUST own its top-level transaction directly: do not wrap this in another transaction
    // or a savepoint, and never catch/continue inside it after a partial canonical effect.
    confirm: async (session, confirmation) => {
      await cleanup(session);
      return confirmOwnLeaveReview(session.ctx, confirmation, session.locale);
    },
    // Private retirement remains available after a grant/pause change; SQL still owns current custody.
    discard: async (session, confirmation) => {
      await cleanup(session);
      return withTenant(session.ctx, tx => discardOwnLeaveReviewTx(tx, confirmation));
    },
  });
}
