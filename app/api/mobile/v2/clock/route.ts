import { captureNativeClockForReview, ClockConflictError, ClockIntegrityRequiredError, ClockPolicyUnavailableError, CorrectedClockConflictError, DeviceNotRegisteredError } from '@/packs/attendance/service';
import { ClockResult } from '@/lib/mobile-api/contract';
import { ClockReviewCommand } from '@/lib/mobile-api/v2/clock-review';
import { mobileForm } from '@/lib/mobile-api/body';
import { mobileRoute, MobileBadRequest, MobileServiceUnavailable } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';

export const POST = mobileRoute(ClockResult, async (session, request): Promise<ClockResult> => {
  const employmentId = await mobileEmployment(session, request);
  if (!employmentId) throw new MobileBadRequest('No own employment');
  const form = await mobileForm(request, ['command', 'photo'], 3 * 1024 * 1024);
  let command: ReturnType<typeof ClockReviewCommand.parse>;
  try { command = ClockReviewCommand.parse(JSON.parse(String(form.get('command')))); }
  catch { throw new MobileBadRequest('Invalid command'); }
  const photo = form.get('photo');
  if (photo != null && !(photo instanceof File)) throw new MobileBadRequest('Invalid photo');
  const { location, ...intent } = command;
  try {
    const receipt = await captureNativeClockForReview(session, {
      ...intent, employmentId, lat: location?.lat ?? null, lng: location?.lng ?? null, accuracy: location?.accuracy ?? null,
      sampledAt: location?.sampledAt ?? null, locationStatus: location ? 'recorded' : 'unavailable',
      ...(photo instanceof File ? { photo: Buffer.from(await photo.arrayBuffer()), mime: photo.type } : {}),
    });
    return { outcome: 'accepted', receipt };
  } catch (error) {
    if (error instanceof ClockPolicyUnavailableError) throw new MobileServiceUnavailable();
    if (error instanceof ClockIntegrityRequiredError) return { outcome: 'refused', code: 'integrity_required' };
    if (error instanceof DeviceNotRegisteredError) return { outcome: 'refused', code: 'device_required' };
    if (error instanceof CorrectedClockConflictError) return { outcome: 'refused', code: 'corrected_day' };
    if (error instanceof ClockConflictError) return { outcome: 'refused', code: 'clock_conflict' };
    throw error;
  }
});
