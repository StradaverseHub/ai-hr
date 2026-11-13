/**
 * Request parsing for the native Today routes (lib/mobile-api/v2/today.ts). Today is always about one of the caller's
 * own employments, named by the app: a missing, repeated or malformed `employmentId` is 400 before anything is read.
 * An employment that is not the caller's own and current is the Home identity owner's refusal (HomeAccessError),
 * answered as lib/mobile-api/request.ts mobileEmployment answers a foreign employment: 400 `bad_request`, no data.
 */
import type { SessionContext } from '@/db/client';
import { HomeAccessError } from '@/core/employee-home';
import { readOwnTodayV2 } from '@/core/mobile-today';
import { AuthRequiredError } from '@/lib/auth-errors';
import { MobileBadRequest } from './handler';
import { mobileLocale } from './request';
import type { TodayV2 } from './v2/today';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?employmentId=`: exactly one UUID, lower-cased. */
export function todayEmploymentId(req: Request): string {
  const all = new URL(req.url).searchParams.getAll('employmentId');
  if (all.length !== 1 || !UUID.test(all[0])) throw new MobileBadRequest('employmentId is required');
  return all[0].toLowerCase();
}

export async function ownToday(s: SessionContext, req: Request): Promise<TodayV2> {
  const employmentId = todayEmploymentId(req);
  try {
    return await readOwnTodayV2(s, employmentId, mobileLocale(req));
  } catch (error) {
    if (error instanceof HomeAccessError) {
      if (error.code === 'authentication') throw new AuthRequiredError();
      throw new MobileBadRequest('employmentId is not one of the caller’s own current employments');
    }
    throw error;
  }
}
