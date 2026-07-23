'use client';

/**
 * Client island for Attendance > Clock in/out (feedback 5249d43f).
 *
 * Owns ONLY presentation-side state: the live ticking clock (the sole use of the client's clock — every
 * recorded/displayed punch time comes from the server via props), whether THIS browser holds a
 * registered-device token (localStorage), and the self-service registration flow. The button state
 * derives from the last punch's direction; all enforcement (device gate, geofence, ordering) is
 * server-side in core checkIn/checkOut.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button, Card, inputCls } from '@/components/ui';
import { AttendanceClockButton, LocationNotice } from '@/components/attendance-clock-button';
import { getStoredDeviceToken, storeDeviceToken, suggestDeviceLabel } from '@/lib/device-token';
import { clockInAction, clockOutAction, registerDeviceAction } from './actions';

export type PunchEvent = { time: string; direction: 'in' | 'out' };

type Props = {
  today: string; // YYYY-MM-DD (server's day key)
  events: PunchEvent[]; // today's punches, ordered first → last, SERVER-recorded times
  requireDevice: boolean; // company policy: registered device required for web clocking
  registeredDeviceCount: number; // this employee's active devices (any browser)
  deviceError: boolean; // the last punch was blocked by the device gate
};

const hhmm = (t: string) => t.slice(0, 5);

export function ClockPageClient({ today, events, requireDevice, registeredDeviceCount, deviceError }: Props) {
  const t = useTranslations('attendance.clock');
  const router = useRouter();

  // Live clock — client-side DISPLAY only; mounted-effect start avoids an SSR hydration mismatch.
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
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

  const last = events[events.length - 1] ?? null;
  const clockedIn = last?.direction === 'in';

  // Current session: the LAST in-punch and, when closed, the out-punch that follows it.
  let sessionIn: string | null = null;
  let sessionOut: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].direction === 'in') {
      sessionIn = events[i].time;
      sessionOut = events[i + 1]?.direction === 'out' ? events[i + 1].time : null;
      break;
    }
  }

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
      <Card className="p-5">
        {/* Live clock — the one client-clock display; recorded times are always the server's. */}
        <div className="text-center">
          <div className="font-mono text-4xl font-semibold tabular-nums text-foreground">
            {now ? now.toLocaleTimeString([], { hour12: false }) : '--:--:--'}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{today}</p>
        </div>

        <div className="mt-5 rounded-lg border border-border bg-muted/30 p-3 text-center text-sm">
          {clockedIn && sessionIn ? (
            <span className="font-medium text-emerald-600 dark:text-emerald-400">
              {t('statusClockedIn', { time: hhmm(sessionIn) })}
            </span>
          ) : events.length > 0 ? (
            <span className="font-medium text-foreground">{t('statusClockedOut')}</span>
          ) : (
            <span className="text-muted-foreground">{t('statusNotClockedIn')}</span>
          )}
          {sessionIn && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('sessionCheckIn')} <span className="font-medium tabular-nums text-foreground">{hhmm(sessionIn)}</span>
              {' · '}
              {t('sessionCheckOut')}{' '}
              <span className="font-medium tabular-nums text-foreground">{sessionOut ? hhmm(sessionOut) : '—'}</span>
            </p>
          )}
        </div>

        <div className="mt-4">
          {mustRegister ? (
            <div className="rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              {t('deviceRequiredNotice')}
            </div>
          ) : (
            <AttendanceClockButton
              action={clockedIn ? clockOutAction : clockInAction}
              label={clockedIn ? t('clockOut') : t('clockIn')}
              variant={clockedIn ? 'secondary' : 'default'}
            />
          )}
          <LocationNotice />
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{t('serverTimeNote')}</p>
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
