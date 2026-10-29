/**
 * GET /api/mobile/v2/payslips?cursor&limit — M09. The caller's own RELEASED payslips across every employment of
 * the login, current and past (D1), from the web's own reader (myReleasedPayslipRuns). Identity and context only —
 * employer, period, cycle, run, employee code — and NO amount. `enabled: false` when the Payroll module is off.
 */
import { payslipIndexV2 } from '@/core/mobile-pay';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { pageRequest } from '@/lib/mobile-api/v2/common';
import { PAYSLIPS_CURSOR, PayslipIndexV2, PayslipsCursor } from '@/lib/mobile-api/v2/pay';

export const GET = mobileRoute(PayslipIndexV2, async (s, req) => payslipIndexV2(s, pageRequest(new URL(req.url), PAYSLIPS_CURSOR, PayslipsCursor)));
