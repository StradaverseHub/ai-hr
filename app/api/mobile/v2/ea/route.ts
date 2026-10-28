/**
 * GET /api/mobile/v2/ea — M09. The caller's own EA sources (employment, employer, year, availability) from the web's
 * own owner (myEaSources): every employment of the login, as /me/ea lists them. `enabled: false` when the Payroll
 * module is off.
 */
import { eaSourcesV2 } from '@/core/mobile-pay';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { EaSourcesV2 } from '@/lib/mobile-api/v2/pay';

export const GET = mobileRoute(EaSourcesV2, async (s) => eaSourcesV2(s));
