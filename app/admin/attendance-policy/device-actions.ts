'use server';

/**
 * Feedback 5249d43f — admin revoke for registered clocking devices (the control balancing self-service
 * registration). The page is requireAdmin-gated; the write itself is DB-gated by employee_device RLS
 * (can_see_employment), and revocation appends attendance.device.revoked.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { revokeDevice } from '@/core/attendance-device';

// af7a8eb4 — the devices table moved onto the Company work schedule page; revoke returns to the screen the
// operator was on, not to the rule list that no longer renders the table.
const LIST = '/admin/attendance-policy/schedule';

export async function revokeDeviceAction(fd: FormData) {
  const s = await getSession();
  try {
    await revokeDevice(s, { deviceId: String(fd.get('deviceId') ?? '') });
  } catch (e) {
    redirect(`${LIST}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(LIST);
  redirect(LIST);
}
