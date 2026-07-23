'use client';

/**
 * ADR-0070 — self-service clock-in/out with browser geolocation capture. Extracted from
 * app/me/attendance-clock.tsx (feedback 5249d43f) so the /me clock card and the dedicated
 * Attendance > Clock in/out page share ONE capture path instead of forking it. On click, tries
 * navigator.geolocation.getCurrentPosition (enableHighAccuracy, ~10s timeout); on success the lat/lng
 * hidden fields are filled before submit, on denial/timeout the form submits WITHOUT them — the SERVER
 * decides whether that's fatal (only when geofencing is ON for this employee) or harmless (OFF).
 * Geolocation needs a secure context (HTTPS or localhost) — see HOSTING.md.
 *
 * Feedback 5249d43f: every submit also carries this browser's registered-device token (localStorage —
 * lib/device-token.ts) in a hidden field. The SERVER decides whether a token is required
 * (attendance_policy.require_registered_device) — never the client; with the policy OFF the field is
 * simply ignored.
 */
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { getStoredDeviceToken } from '@/lib/device-token';

type Props = {
  action: (formData: FormData) => void;
  label: string;
  variant?: 'default' | 'secondary';
};

export function AttendanceClockButton({ action, label, variant = 'default' }: Props) {
  const t = useTranslations('me');
  const [capturing, setCapturing] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);
  const latRef = React.useRef<HTMLInputElement>(null);
  const lngRef = React.useRef<HTMLInputElement>(null);
  const tokenRef = React.useRef<HTMLInputElement>(null);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    // The device token rides along on EVERY submit path (first submit AND the requestSubmit re-entry).
    if (tokenRef.current) tokenRef.current.value = getStoredDeviceToken() ?? '';
    // Already have coordinates (a prior geolocation call filled the hidden fields) — let the form submit
    // through normally, or this is the fallback after denial/timeout (also lets it through).
    if (latRef.current?.value || !('geolocation' in navigator)) return;
    e.preventDefault();
    setCapturing(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (latRef.current) latRef.current.value = String(pos.coords.latitude);
        if (lngRef.current) lngRef.current.value = String(pos.coords.longitude);
        setCapturing(false);
        formRef.current?.requestSubmit();
      },
      () => {
        // Denied or failed — submit WITHOUT coordinates. The server decides: blocks only if this
        // employee's geofencing is ON; otherwise the punch proceeds with null coordinates.
        setCapturing(false);
        formRef.current?.requestSubmit();
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  };

  return (
    <form ref={formRef} action={action} onSubmit={onSubmit}>
      <input ref={latRef} type="hidden" name="lat" />
      <input ref={lngRef} type="hidden" name="lng" />
      <input ref={tokenRef} type="hidden" name="deviceToken" />
      <Button type="submit" variant={variant} className="w-full" disabled={capturing}>
        {capturing ? t('capturingLocation') : label}
      </Button>
    </form>
  );
}

/** Small, always-visible transparency notice on the clock card (PDPA — ADR-0070 §7, one step beyond the
 *  literal ask, reviewer may strike). */
export function LocationNotice() {
  const t = useTranslations('me');
  return <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{t('locationNotice')}</p>;
}
