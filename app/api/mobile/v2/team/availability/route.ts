/**
 * GET /api/mobile/v2/team/availability?from&to — M13 (D14). Who in the caller's authorized My Team is away, for a
 * window the caller chooses (default today + 6 days, at most 31 days inclusive). Only `from` and `to` are read: no
 * caller-supplied team, company, department, employment or scope reaches the membership owner. v1 `team` unchanged.
 */
import { teamAvailabilityV2 } from '@/core/mobile-team';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { addCalendarDays, isCalendarDate, TEAM_WINDOW_DEFAULT_DAYS, TEAM_WINDOW_MAX_DAYS, TeamAvailabilityV2, windowDays } from '@/lib/mobile-api/v2/team';

export const GET = mobileRoute(TeamAvailabilityV2, async (s, req) => {
  const url = new URL(req.url);
  const one = (key: string) => {
    const all = url.searchParams.getAll(key);
    if (all.length > 1) throw new MobileBadRequest(`Repeated ${key}`);
    return all[0] ?? undefined;
  };
  const rawFrom = one('from'), rawTo = one('to');
  if (rawTo !== undefined && rawFrom === undefined) throw new MobileBadRequest('to without from');
  if ((rawFrom !== undefined && !isCalendarDate(rawFrom)) || (rawTo !== undefined && !isCalendarDate(rawTo))) throw new MobileBadRequest('Invalid date');
  const today = todayInKualaLumpur();
  const from = rawFrom ?? today;
  const to = rawTo ?? addCalendarDays(from, TEAM_WINDOW_DEFAULT_DAYS - 1);
  if (to < from || windowDays(from, to) > TEAM_WINDOW_MAX_DAYS) throw new MobileBadRequest('Window out of bounds');
  return teamAvailabilityV2(s, { from, to, today });
});
