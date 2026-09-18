'use client';

/**
 * Client island for Attendance > Clock in/out (feedback 5249d43f; redesigned by af552c5d — the
 * phone-first circular-button screen).
 *
 * Owns ONLY presentation-side state: the per-second tick (the sole use of the client's clock — every
 * recorded/displayed punch time comes from the server via props, and the elapsed counter's BASE is
 * server-computed so a refresh never resets it), which shift option the Switch affordance is showing,
 * whether THIS browser holds a registered-device token (localStorage), and the self-service registration
 * flow. The button state derives from the last punch's direction (grey idle → red clocked-in → green
 * clocked-out); all enforcement (device gate, geofence, ordering) is server-side in core checkIn/checkOut.
 */
import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Clock3, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Card, inputCls } from '@/components/ui';
import { ClockCaptureForm, LocationNotice } from '@/components/attendance-clock-button';
import { getStoredDeviceToken, storeDeviceToken, suggestDeviceLabel } from '@/lib/device-token';
import {
  RING_CLASSES,
  completedSessions,
  elapsedDisplaySeconds,
  formatElapsed,
  latestSessionStart,
  ringState,
  showShiftSwitch,
  type ShiftOption,
} from './clock-display';
import { clockInAction, clockOutAction, registerDeviceAction } from './actions';

export type PunchEvent = { time: string; direction: 'in' | 'out' };

type Props = {
  today: string; // YYYY-MM-DD (server's day key)
  // 7ac6b4db — "18 Sep 2026, Friday", already formatted in the viewer's locale on the SERVER. The island
  // receives a finished string: `toLocaleDateString` here would format against the BROWSER's locale and
  // time zone, so a viewer in another zone could be shown yesterday's date beside today's punches.
  todayLabel: string;
  resolvedShiftStart: string | null; // today's resolved shift start (HH:MM), for the Current shift card
  events: PunchEvent[]; // today's punches, ordered first → last, SERVER-recorded times
  requireDevice: boolean; // company policy: registered device required for web clocking
  registeredDeviceCount: number; // this employee's active devices (any browser)
  deviceError: boolean; // the last punch was blocked by the device gate
  baseWorkedSeconds: number; // SERVER-computed cumulative seconds worked today, at render
  locationName: string | null; // matched approved site (latest punch), else first assigned site
  coords: { lat: number; lng: number } | null; // the latest punch's captured coordinates
  resolvedShiftEnd: string | null; // today's resolved shift end (HH:MM) — roster > default shift
  resolvedShiftCode: string | null; // its code, to preselect the matching Switch option
  shiftOptions: ShiftOption[]; // today-assignable library shifts (Switch hidden when ≤1)
};

const hhmm = (t: string) => t.slice(0, 5);

export function ClockPageClient({
  today,
  todayLabel,
  resolvedShiftStart,
  events,
  requireDevice,
  registeredDeviceCount,
  deviceError,
  baseWorkedSeconds,
  locationName,
  coords,
  resolvedShiftEnd,
  resolvedShiftCode,
  shiftOptions,
}: Props) {
  const t = useTranslations('attendance.clock');
  const router = useRouter();

  // Per-second tick — client-side DISPLAY only; mounted-effect start avoids an SSR hydration mismatch.
  // mountMs anchors the elapsed counter's client delta (see elapsedDisplaySeconds — skew-tolerant).
  const [now, setNow] = React.useState<Date | null>(null);
  const mountMsRef = React.useRef(0);
  React.useEffect(() => {
    mountMsRef.current = Date.now();
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(id);
  }, []);

  // Whether THIS browser holds a device token (null until mounted — localStorage is client-only).
  const [hasToken, setHasToken] = React.useState<boolean | null>(null);
  const [label, setLabel] = React.useState('');
  React.useEffect(() => {
    setHasToken(getStoredDeviceToken() != null);
    setLabel(suggestDeviceLabel(navigator.userAgent));
  }, []);
  const [registering, startRegister] = React.useTransition();

  // Button state from the server punch trail: idle (grey) before the first clock-in of the day, 'in'
  // (red, action = Clock Out) while clocked in, 'out' (green, action = Clock In) between sessions.
  const state = ringState(events);
  const clockedIn = state === 'in';
  const sessions = completedSessions(events);
  const lastIn = latestSessionStart(events);

  // The cumulative-worked counter: server base + (while clocked in) the client-tick delta.
  const elapsedSeconds =
    now == null
      ? baseWorkedSeconds
      : elapsedDisplaySeconds(baseWorkedSeconds, clockedIn, mountMsRef.current, now.getTime());

  // Switch affordance — cycles which assignable shift's end time the info line shows. Starts on the
  // RESOLVED shift for today when it is one of the options.
  const [shiftIdx, setShiftIdx] = React.useState(() => {
    const i = shiftOptions.findIndex((o) => o.code != null && o.code === resolvedShiftCode);
    return i >= 0 ? i : 0;
  });
  const shownShiftEnd = shiftOptions.length > 0 ? shiftOptions[shiftIdx]?.end ?? null : resolvedShiftEnd;

  // Block the button only when the policy requires a device and this browser definitely has none;
  // an unknown/revoked token is still submitted and the SERVER refuses it (deviceError re-renders us).
  const mustRegister = requireDevice && hasToken === false;
  const showRegisterForm = mustRegister || deviceError || hasToken === false;

  const register = () =>
    startRegister(async () => {
      const res = await registerDeviceAction({ label });
      if (res.error || !res.deviceToken) {
        toast.error(res.error ?? t('deviceRegisterFailed'));
        return;
      }
      storeDeviceToken(res.deviceToken);
      setHasToken(true);
      toast.success(t('deviceRegisteredToast'));
      router.refresh();
    });

  return (
    <>
      {/* Header row — title left, the conditional shift Switch right (hidden unless >1 option today). */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{t('title')}</h1>
        {showShiftSwitch(shiftOptions.length) && (
          <button
            type="button"
            onClick={() => setShiftIdx((i) => (i + 1) % shiftOptions.length)}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-muted/60"
          >
            <Clock3 className="h-4 w-4" aria-hidden />
            {t('switchShift')}
          </button>
        )}
      </div>

      <Card className="p-5">
        {/* Location & date block — the matched approved work location + captured coordinates (server
            geofence resolution; street addresses need a reverse-geocoding provider we don't have). */}
        <div className="text-center">
          <div className="inline-flex max-w-full items-center justify-center gap-1.5 text-sm font-medium text-foreground">
            <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{locationName ?? t('locationUnknown')}</span>
          </div>
          {coords && (
            <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
              {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
            </p>
          )}
          <p className="mt-1 text-sm font-medium text-foreground">{todayLabel}</p>
        </div>

        {/* 7ac6b4db — CURRENT SHIFT. The employee's own words for it: which shift am I clocking against,
            and what are its hours. Every value is the one the ENGINE resolved for today (roster > default
            shift > company policy) and the same one the "This shift ends at" line below already used — not
            a second resolution that could name a different shift from the one the punch is judged against.
            When the day resolves to no shift at all (plain company policy, a rest day), it says so rather
            than printing an empty card that reads as a loading failure. */}
        <div className="mt-5 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('currentShift')}
          </div>
          {shownShiftEnd || resolvedShiftStart || resolvedShiftCode ? (
            <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              {resolvedShiftCode && (
                <span className="font-medium text-foreground">
                  {t('shiftId')} {resolvedShiftCode}
                </span>
              )}
              {resolvedShiftStart && (
                <span className="tabular-nums text-muted-foreground">
                  {t('shiftStarts')} {hhmm(resolvedShiftStart)}
                </span>
              )}
              {shownShiftEnd && (
                <span className="tabular-nums text-muted-foreground">
                  {t('shiftEnds')} {hhmm(shownShiftEnd)}
                </span>
              )}
            </div>
          ) : (
            <div className="mt-1 text-sm text-muted-foreground">{t('noShiftAssigned')}</div>
          )}
        </div>

        {/* The big circular action button — or the register-first notice when the device gate applies. */}
        <div className="mt-6">
          {mustRegister ? (
            <div className="rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              {t('deviceRequiredNotice')}
            </div>
          ) : (
            <ClockCaptureForm action={clockedIn ? clockOutAction : clockInAction}>
              {(capturing) => (
                <CircleClockButton
                  state={state}
                  capturing={capturing}
                  label={clockedIn ? t('clockOut') : t('clockIn')}
                  elapsed={formatElapsed(elapsedSeconds)}
                  timeNow={
                    now
                      ? now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
                      : '--:--'
                  }
                />
              )}
            </ClockCaptureForm>
          )}

          {/* Shift info line — informational only; the engine never auto-clocks anyone out. */}
          {shownShiftEnd && (
            <p className="mt-4 text-center text-xs text-muted-foreground">
              {t('shiftEndsAt', { time: hhmm(shownShiftEnd) })}
            </p>
          )}
          <LocationNotice />
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{t('serverTimeNote')}</p>
        </div>

        {/* Status / history row — site, the completed-session badge, and the latest session's start. */}
        <div className="mt-5 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm">
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold uppercase tracking-wide text-foreground">
              {locationName ?? '—'}
            </span>
            {sessions > 0 && (
              <span
                title={t('sessionsToday', { count: sessions })}
                className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-600 px-1 text-[11px] font-semibold tabular-nums text-white dark:bg-emerald-500"
              >
                {sessions}
              </span>
            )}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {lastIn ? t('clockedInAt', { time: lastIn }) : t('statusNotClockedIn')}
          </span>
        </div>
      </Card>

      {/* Device registration — self-service (an employee can register a replacement phone without a
          ticket). Shown when this browser has no token, or after the server refused its token. */}
      {(showRegisterForm || deviceError) && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-foreground">{t('deviceHeading')}</h2>
          {deviceError ? (
            <p className="mt-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {t('deviceBlocked')}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              {requireDevice ? t('deviceRequiredHint') : t('deviceOptionalHint')}
            </p>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('deviceLabelPlaceholder')}
              aria-label={t('deviceLabelField')}
              className={`${inputCls} sm:flex-1`}
            />
            <Button type="button" onClick={register} disabled={registering || !label.trim()}>
              {registering ? t('registering') : t('registerDevice')}
            </Button>
          </div>
          {registeredDeviceCount > 0 && (
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
              {t('otherDevicesNote', { count: registeredDeviceCount })}
            </p>
          )}
        </Card>
      )}
      {hasToken === true && !deviceError && (
        <p className="text-xs text-muted-foreground">{t('deviceRegisteredHint')}</p>
      )}

      {/* Today's log — every punch, in order, server-recorded times. Multiple in/out pairs (lunch) each
          appear as their own events. */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{t('todayLog')}</h2>
        </div>
        {events.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noPunches')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {events.map((ev, i) => (
              <li key={`${ev.time}-${ev.direction}-${i}`} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span
                  className={
                    ev.direction === 'in'
                      ? 'inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                      : 'inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
                  }
                >
                  {ev.direction === 'in' ? t('punchIn') : t('punchOut')}
                </span>
                <span className="font-medium tabular-nums text-foreground">{hhmm(ev.time)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/**
 * The circular action button (~60% of viewport width, capped): small-caps action label on top, the live
 * cumulative-worked counter in the middle, the current clock time below. Gradient + glow classes come
 * from the state-driven RING_CLASSES map (grey idle / red clocked-in / green clocked-out). Disabled —
 * with a gentle pulse, suppressed under reduced-motion — while geolocation capture or the server request
 * is in flight, so double-taps cannot create duplicate punches (the server's ordering guard remains the
 * real enforcement).
 */
function CircleClockButton({
  state,
  capturing,
  label,
  elapsed,
  timeNow,
}: {
  state: keyof typeof RING_CLASSES;
  capturing: boolean;
  label: string;
  elapsed: string;
  timeNow: string;
}) {
  const { pending } = useFormStatus();
  const busy = capturing || pending;
  return (
    <button
      type="submit"
      disabled={busy}
      aria-busy={busy}
      aria-label={label}
      className={`mx-auto flex aspect-square w-[60vw] max-w-xs flex-col items-center justify-center gap-1.5 rounded-full text-white transition-transform active:scale-[0.98] disabled:opacity-70 motion-reduce:transition-none ${RING_CLASSES[state]} ${busy ? 'animate-pulse motion-reduce:animate-none' : ''}`}
    >
      <span className="text-xs font-semibold uppercase tracking-[0.2em]">{label}</span>
      <span className="font-mono text-3xl font-bold tabular-nums sm:text-4xl">{elapsed}</span>
      <span className="text-lg font-medium tabular-nums opacity-90">{timeNow}</span>
    </button>
  );
}
