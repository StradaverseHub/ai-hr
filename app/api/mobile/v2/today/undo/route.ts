/**
 * POST /api/mobile/v2/today/undo {actionId, confirm: true} — Undo on the person's own autoFixed reminder, through the
 * loop's undo owner (core/loops/undo.ts), which re-reads the action as the caller and undoes only their own, within its
 * window. Anything but an explicit `confirm: true` is refused by the contract (400) before the owner runs.
 */
import { undoOwnLoopActionV2 } from '@/core/mobile-today';
import { mobileInput } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { LoopUndoCommandV2, LoopUndoResultV2 } from '@/lib/mobile-api/v2/today';

export const POST = mobileRoute(LoopUndoResultV2, async (s, req) => {
  const command = LoopUndoCommandV2.safeParse(await mobileInput(req));
  if (!command.success) throw new MobileBadRequest('Invalid command');
  return undoOwnLoopActionV2(s, command.data);
});
