import { z } from 'zod';

export const ClockReviewReasons = z.array(z.enum([
  'location_missing', 'location_stale', 'location_accuracy', 'outside_site', 'no_assigned_site', 'photo_missing', 'photo_invalid',
])).max(7);
export type ClockReviewReason = z.infer<typeof ClockReviewReasons>[number];

export function readClockReviewReasons(payload: unknown): ClockReviewReason[] {
  if (!payload || typeof payload !== 'object' || !('reviewReasons' in payload)) return [];
  const parsed = ClockReviewReasons.safeParse(payload.reviewReasons);
  return parsed.success ? parsed.data : [];
}
