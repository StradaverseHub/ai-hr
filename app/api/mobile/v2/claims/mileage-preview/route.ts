/**
 * GET /api/mobile/v2/claims/mileage-preview?employmentId&claimTypeId&km&incurredOn — M11. The kernel's price for a
 * distance on THE mileage claim type (previewMileageClaim: the rule submit uses, on the caller's own grade and the
 * table in force on that date). A preview, never a reservation: submit re-prices and re-checks every limit.
 */
import { ownMileagePreview } from '@/core/mobile-claims';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { claimEmployment } from '@/lib/mobile-api/claim-routes';
import { ClaimKmInput, MileagePreviewResult } from '@/lib/mobile-api/v2/claims';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const GET = mobileRoute(MileagePreviewResult, async (s, req) => {
  const q = new URL(req.url).searchParams;
  const one = (k: string) => { const all = q.getAll(k); if (all.length !== 1) throw new MobileBadRequest(`Exactly one ${k}`); return all[0]; };
  const claimTypeId = one('claimTypeId'), km = one('km'), incurredOn = one('incurredOn');
  const date = new Date(incurredOn + 'T00:00:00Z');
  if (!UUID.test(claimTypeId) || !ClaimKmInput.safeParse(km).success || !DATE.test(incurredOn) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== incurredOn) {
    throw new MobileBadRequest('Invalid mileage preview');
  }
  return ownMileagePreview(s, await claimEmployment(s, req), { claimTypeId: claimTypeId.toLowerCase(), km: km.trim(), incurredOn });
});
