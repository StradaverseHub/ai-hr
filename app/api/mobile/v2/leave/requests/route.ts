/**
 * GET /api/mobile/v2/leave/requests?employmentId&status&from&to&cursor&limit — M07. The caller's own requests on
 * one of their own employments, newest leave start first, keyset-paged (lib/mobile-api/v2/common.ts), with the
 * per-status counts the filter chips show. `from`/`to` are the web history's overlap window.
 */
import { ownLeaveRequestsPage } from '@/core/mobile-leave-history';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { pageRequest } from '@/lib/mobile-api/v2/common';
import { LEAVE_REQUESTS_CURSOR, LeaveRequestsCursor, LeaveRequestStatus, LeaveRequestsPageV2 } from '@/lib/mobile-api/v2/leave';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const calendarDay = (v: string) => ISO.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export const GET = mobileRoute(LeaveRequestsPageV2, async (s, req) => {
  const url = new URL(req.url);
  const one = (key: string) => {
    const all = url.searchParams.getAll(key);
    if (all.length > 1) throw new MobileBadRequest(`Repeated ${key}`);
    return all[0] ?? undefined;
  };
  const rawStatus = one('status'), from = one('from'), to = one('to');
  const status = rawStatus === undefined ? undefined : LeaveRequestStatus.safeParse(rawStatus);
  if (status && !status.success) throw new MobileBadRequest('Invalid status');
  if ((from !== undefined && !calendarDay(from)) || (to !== undefined && !calendarDay(to)) || (from && to && from > to)) throw new MobileBadRequest('Invalid window');
  const { limit, cursor } = pageRequest(url, LEAVE_REQUESTS_CURSOR, LeaveRequestsCursor);
  const employmentId = await mobileEmployment(s, req);
  if (!employmentId) return { employmentId: null, items: [], nextCursor: null, counts: { pending: 0, approved: 0, rejected: 0, cancelled: 0 } };
  return ownLeaveRequestsPage(s, employmentId, { status: status?.data, from, to, limit, cursor });
});
