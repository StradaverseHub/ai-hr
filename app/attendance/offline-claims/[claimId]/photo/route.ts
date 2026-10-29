import { getSession } from '@/lib/session';
import { OfflineClaimReviewError, readOfflineClaimPhotoForReview } from '@/packs/attendance/mobile-offline-claim-review';

/**
 * The retained photo of one held offline punch, for the HR review panel on Attendance › Application History. Bytes
 * leave the server only here, never in the list payload. Each successful GET is one audited photo read
 * (mobile.offline.photo.reviewed), so the response is never cached anywhere.
 *
 * NO PAGE GUARD beyond the session, on purpose: readOfflineClaimPhotoForReview is the gate (attendance-correction
 * authority over the claim's employment, not a group admin, photo unexpired; RLS agrees). Every refusal answers 404,
 * never 403, so a caller cannot learn that a claim or its photo exists.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  const { claimId } = await params;
  const s = await getSession();
  let photo: Awaited<ReturnType<typeof readOfflineClaimPhotoForReview>>;
  try {
    photo = await readOfflineClaimPhotoForReview(s, claimId);
  } catch (error) {
    if (error instanceof OfflineClaimReviewError) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    throw error;
  }
  const bytes = new Uint8Array(photo.bytes);
  return new Response(bytes, {
    headers: {
      'Content-Type': photo.mimeType,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': 'inline; filename="offline-punch-photo"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
