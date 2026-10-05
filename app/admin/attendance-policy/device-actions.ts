'use server';

/**
 * Feedback 5249d43f — admin revoke for registered clocking devices (the control balancing self-service
 * registration). The page is requireAdmin-gated; the write itself is DB-gated by employee_device RLS
 * (can_see_employment), and revocation appends attendance.device.revoked.
 */
import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { revokeDevice } from '@/core/attendance-device';
import { SCHEDULE } from './schedule-panel';

// af7a8eb4 — the devices table moved onto the Company work schedule page; revoke returns to the screen the
// operator was on, not to the rule list that no longer renders the table.
// 6d091cc0 (r301) — and moved again, onto the Work Schedule & Overtime Rates card of Attendance › Schedule ›
// General. That old page is a redirect stub now, so Revoke returns to the Schedule screen itself: a PLAIN path
// (General is the default tab), because the refusal below appends `?error=` by concatenation.
const LIST = SCHEDULE;

export async function revokeDeviceAction(fd: FormData) {
  const s = await getSession();
  try {
    await revokeDevice(s, { deviceId: String(fd.get('deviceId') ?? '') });
  } catch (e) {
    redirect(`${LIST}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(LIST);
  redirect(LIST);
}
