/**
 * GET /api/mobile/v2/payslips/{id} — M09. One of the caller's own released payslips, as the web statement shows it
 * (myPayslipDocument → payslipPresentationRows), amounts as two-place decimal strings with the company's currency.
 * Not own, not released, another tenant's or company's, or a guessed id: `not_found`, the same answer for each.
 */
import { mobileRoute } from '@/lib/mobile-api/handler';
import { payslipDetailV2, payslipIdOf } from '@/lib/mobile-api/pay-routes';
import { PayslipDetailResult } from '@/lib/mobile-api/v2/pay';

export const GET = mobileRoute(PayslipDetailResult, async (s, req) => payslipDetailV2(s, payslipIdOf(req)));
