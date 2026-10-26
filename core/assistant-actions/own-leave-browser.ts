/** UNMOUNTED canonical browser bindings. Authentication is the eventual route's real cookie session,
 * never a posted SessionContext. No model tool, provider or orchestration executor calls this owner.
 * Migrations/relevant writer/security/retention/experience acceptance remain required before mount. */
import { withTenant, type SessionContext } from '../../db/client';
import { createOwnLeaveBrowserHandler } from '../../lib/assistant-actions/own-leave-http';
import { confirmOwnLeaveReview, discardOwnLeaveReviewTx, prepareOwnLeaveReviewTx, reopenOwnLeaveReviewTx } from './own-leave-store';

type BrowserSession = Readonly<{ ctx: SessionContext; locale?: string }>;
export function createOwnLeaveBrowserCommandHandler(authenticate: () => Promise<BrowserSession>) {
  return createOwnLeaveBrowserHandler({
    authenticate,
    prepare: ({ ctx, locale }, packet) => withTenant(ctx, tx =>
      prepareOwnLeaveReviewTx(tx, ctx, packet.nomination, packet.selection, packet.humanText, locale)),
    reopen: ({ ctx }, actionId) => withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, actionId)),
    // Confirmation MUST own its top-level transaction directly: do not wrap this in another transaction
    // or a savepoint, and never catch/continue inside it after a partial canonical effect.
    confirm: ({ ctx, locale }, confirmation) => confirmOwnLeaveReview(ctx, confirmation, locale),
    // Private retirement remains available after a grant/pause change; SQL still owns current custody.
    discard: ({ ctx }, confirmation) => withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, confirmation)),
  });
}
