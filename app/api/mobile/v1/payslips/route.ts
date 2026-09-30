/**
 * GET /api/mobile/v1/payslips — the caller's RELEASED payslips, newest period first (ADR-0088 §2).
 * Read-only. Released-only is `myReleasedPayslips`'s rule, the same predicate the web's /me applies; a
 * processed-but-unclosed run, or a closed one whose release instant is still ahead, is not listed.
 * No Payroll module ⇒ `enabled: false` and nothing read, exactly as /me hides its payslip section.
 */
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { myReleasedPayslips } from '@/core/read';
import { PayslipsResponse } from '@/lib/mobile-api/contract';
import { mobileRoute } from '@/lib/mobile-api/handler';

export const GET = mobileRoute(PayslipsResponse, async (s) => {
  const enabled = isModuleEnabledOrFalse(s, 'payroll');
  if (!enabled) return { enabled, items: [] };
  const rows = await myReleasedPayslips(s);
  return {
    enabled,
    items: rows.map((r) => ({
      id: r.id,
      company: r.company,
      payPeriod: r.payPeriod,
      runType: r.runType,
      gross: String(r.gross),
      deductions: String(r.deductions),
      net: String(r.net),
    })),
  };
});
