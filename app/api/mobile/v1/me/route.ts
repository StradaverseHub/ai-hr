/**
 * GET /api/mobile/v1/me — who the signed-in employee is, which employments they can act as, and which
 * modules their tenant holds (ADR-0088 §1–§2). Read-only.
 *
 * Built from `myEmployments`, which also returns basic salary and allowance; the mapping below names the
 * five fields the app needs and `MeResponse` strips anything else, so neither figure can reach the phone.
 */
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { myEmployment, myEmployments, myPersonName } from '@/core/read';
import { MOBILE_API_VERSION, MeResponse } from '@/lib/mobile-api/contract';
import { mobileRoute } from '@/lib/mobile-api/handler';

export const GET = mobileRoute(MeResponse, async (s) => {
  const [primary, name, employments] = await Promise.all([myEmployment(s), myPersonName(s), myEmployments(s)]);
  return {
    apiVersion: MOBILE_API_VERSION,
    person: { name: name ?? primary?.name ?? null, email: primary?.email ?? null },
    employments: employments.map((e) => ({
      employmentId: e.employmentId,
      company: e.company,
      department: e.department ?? null,
      position: e.position ?? null,
      hiredOn: e.hiredOn ?? null,
    })),
    roles: s.roles ?? [],
    modules: {
      payroll: isModuleEnabledOrFalse(s, 'payroll'),
      notifications: isModuleEnabledOrFalse(s, 'notifications'),
    },
  };
});
