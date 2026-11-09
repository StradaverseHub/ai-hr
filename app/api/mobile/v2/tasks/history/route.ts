import { z } from 'zod';
import { listApprovalHistory } from '@/core/read';
import { shapeApprovalHistoryItems } from '@/lib/approval-history';
import { isAdmin } from '@/lib/authz';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { MobileApprovalHistoryAction, MobileApprovalHistoryPage } from '@/lib/mobile-api/v2/approval-history';
import { encodeCursor, pageRequest, PageRequestRefused } from '@/lib/mobile-api/v2/common';

const cursorKey = 'approval-history';
const maxOffset = 10_000;
const cursorSchema = z.tuple([MobileApprovalHistoryAction, z.iso.datetime(), z.number().int().positive().max(maxOffset)]);

export const GET = mobileRoute(MobileApprovalHistoryPage, async (session, request) => {
  const url = new URL(request.url);
  const action = MobileApprovalHistoryAction.safeParse(url.searchParams.get('action'));
  const { limit, cursor } = pageRequest(url, cursorKey, cursorSchema);
  if (!action.success || url.searchParams.getAll('action').length !== 1 || (cursor && cursor[0] !== action.data)) {
    throw new PageRequestRefused();
  }
  // Match the web history page's admission. The canonical reader also applies its tenant and team scope.
  if (!isAdmin(session) && !(session.roles ?? []).includes('manager')) return { items: [], nextCursor: null };
  const to = cursor?.[1] ?? new Date().toISOString();
  const offset = cursor?.[2] ?? 0;
  const rows = await listApprovalHistory(session, { action: action.data, to, offset, limit: limit + 1 });
  const nextOffset = offset + limit;
  return {
    items: shapeApprovalHistoryItems(rows.slice(0, limit)),
    nextCursor: rows.length > limit && nextOffset <= maxOffset ? encodeCursor(cursorKey, [action.data, to, nextOffset]) : null,
  };
});
