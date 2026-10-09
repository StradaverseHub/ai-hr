'use server';

/**
 * Server actions for Attendance > Clock in/out (feedback 5249d43f). Same engine as the /me clock card —
 * core checkIn/checkOut own EVERY rule (server timestamps, duplicate/ordering refusal, geofence, the
 * registered-device gate), so behaviour is identical everywhere. The employment is ALWAYS resolved from
 * the session, never a form field (ADR-0015).
 */
import { publicErrorMessage } from '@/lib/public-error';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import {
  checkIn,
  checkOut,
  GeolocationRequiredError,
  OutsideGeofenceError,
} from '@/core/attendance';

import { timeInKualaLumpur, todayInKualaLumpur } from '@/lib/hr-date';

const PAGE = '/attendance/clock';

/** SERVER clock — the date/time the punch is recorded at. The browser's clock is display-only.
 *  Both halves are read in MYT: the date used to be toISOString() (UTC), so a punch between midnight
 *  and 08:00 MYT was stamped with YESTERDAY's date beside today's time. */
function nowParts() {
  const d = new Date();
  return { date: todayInKualaLumpur(d), time: timeInKualaLumpur(d) };
}

/** The optional hidden lat/lng fields the client-side geolocation capture writes (ADR-0070). Missing/
 *  blank/non-finite ⇒ undefined — the server decides whether that's fatal, never the client. */
function parseGeo(formData: FormData): { lat: number; lng: number } | undefined {
  const latRaw = formData.get('lat');
  const lngRaw = formData.get('lng');
  if (latRaw == null || lngRaw == null || latRaw === '' || lngRaw === '') return undefined;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { lat, lng };
}

function parseDeviceToken(formData: FormData): string | undefined {
  const v = String(formData.get('deviceToken') ?? '').trim();
  return v || undefined;
}

/** Localize the clock errors; the geofence block surfaces the DISTANCE whenever the engine measured one
 *  (OutsideGeofenceError carries the nearest site's distance + the allowed radius). */
async function localizeClockError(e: unknown): Promise<string> {
  const t = await getTranslations('attendance.clock');
  if (e instanceof OutsideGeofenceError) {
    // 1fff489c — radiusM is now nullable and travels WITH distanceM: both are null together, in the one
    // case where the employee has no assigned site at all and there is no nearest site to quote. Guarding
    // on both is what keeps the ICU {radius} argument from ever being called with null, which THROWS at
    // render behind an otherwise-healthy 200.
    return e.info.distanceM != null && e.info.radiusM != null
      ? t('outsideGeofenceDistance', { distance: e.info.distanceM, radius: e.info.radiusM })
      : t('outsideGeofence');
  }
  if (e instanceof GeolocationRequiredError) return t('locationRequired');
  return publicErrorMessage(e);
}

export async function clockInAction(_formData: FormData) {
  await getSession();
  redirect('/attendance/clock');
}

export async function clockOutAction(_formData: FormData) {
  await getSession();
  redirect('/attendance/clock');
}

// r430 — registerDeviceAction (self-service device registration) DELETED here. Its only caller was
// clock-client.tsx's Register button, which this round removes along with the rest of the device-gate UI;
// an unreferenced 'use server' export is still a live, callable RPC endpoint (the same reasoning
// app/admin/personnel/[employmentId]/actions.ts's retired setEmploymentGradeAction comment gives), so it
// is deleted rather than left unreferenced. core/attendance-device.ts's registerDevice/revokeDevice/
// listRegisteredDevices/enforceDeviceGateTx are UNCHANGED — the admin Attendance Policy screen and the
// policy-gated admin Daily path still use them.
