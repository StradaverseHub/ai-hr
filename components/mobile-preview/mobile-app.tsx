'use client';

/**
 * Mobile App UI/UX preview (ca2f2fef) — a purely PRESENTATIONAL, self-contained simulation of the
 * future mobile app, rendered inside a phone frame within the web system. It introduces NO business
 * logic, NO data fetching and NO writes — every screen is a static mock, so there is nothing for the
 * DomainEvents substrate to record (deliberate: this file performs zero state changes).
 *
 * i18n: all navigational chrome (feature names, screen titles, buttons, banners) is localized via the
 * `mobilePreview` namespace in all 6 locales. Pure MOCK DATA embedded in the frames (sample times,
 * amounts, dates, names) is intentionally left as plain literals — it represents illustrative content
 * for a future app, not product copy, and is invisible to the i18n coverage guard (which only checks
 * static t('…') keys). Keep this file single-namespace so test/i18n-coverage.test.ts can attribute keys.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  BatteryFull,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Paperclip,
  Receipt,
  Settings,
  Signal,
  Sparkles,
  Target,
  Wallet,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type ScreenId =
  | 'home'
  | 'attendance'
  | 'leave'
  | 'leaveHistory'
  | 'leaveBalance'
  | 'leaveCalendar'
  | 'leaveApplication'
  | 'claim'
  | 'claimApplication'
  | 'payroll'
  | 'payslip'
  | 'performance'
  | 'setting';

type Tile = { id: ScreenId; icon: LucideIcon; labelKey: string };

const TILES: readonly Tile[] = [
  { id: 'attendance', icon: Clock, labelKey: 'feature.attendance' },
  { id: 'leave', icon: CalendarDays, labelKey: 'feature.leave' },
  { id: 'claim', icon: Receipt, labelKey: 'feature.claim' },
  { id: 'payroll', icon: Wallet, labelKey: 'feature.payroll' },
  { id: 'performance', icon: Target, labelKey: 'feature.performance' },
  { id: 'setting', icon: Settings, labelKey: 'feature.setting' },
];

export function MobileApp() {
  const t = useTranslations('mobilePreview');
  const [stack, setStack] = useState<ScreenId[]>(['home']);
  const [clockedIn, setClockedIn] = useState(false);
  const current = stack[stack.length - 1];
  const go = (id: ScreenId) => setStack((s) => [...s, id]);
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  // Screen title shown in the in-frame top bar (home has no bar).
  const titleFor = (id: ScreenId): string => {
    switch (id) {
      case 'attendance':
        return t('feature.attendance');
      case 'leave':
        return t('leave.overview');
      case 'leaveHistory':
        return t('leave.history');
      case 'leaveBalance':
        return t('leave.balance');
      case 'leaveCalendar':
        return t('leave.calendar');
      case 'leaveApplication':
        return t('leave.application');
      case 'claim':
        return t('feature.claim');
      case 'claimApplication':
        return t('claim.application');
      case 'payroll':
        return t('feature.payroll');
      case 'payslip':
        return t('payslip.title');
      case 'performance':
        return t('feature.performance');
      case 'setting':
        return t('feature.setting');
      default:
        return '';
    }
  };

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Device */}
      <div className="relative h-[720px] w-[344px] rounded-[3rem] border border-border bg-card p-3 shadow-[var(--shadow-card)]">
        {/* Notch */}
        <div className="pointer-events-none absolute left-1/2 top-3 z-20 h-6 w-32 -translate-x-1/2 rounded-b-2xl bg-card" />
        <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[2.25rem] bg-background">
          {/* Status bar */}
          <div className="flex items-center justify-between px-6 pt-3 text-[11px] font-semibold text-foreground">
            <span>9:41</span>
            <div className="flex items-center gap-1.5">
              <Signal className="size-3.5" />
              <Wifi className="size-3.5" />
              <BatteryFull className="size-4" />
            </div>
          </div>

          {/* In-app top bar (not on home) */}
          {current !== 'home' && (
            <div className="flex items-center gap-2 px-4 py-3">
              <button
                type="button"
                onClick={back}
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
              >
                <ChevronLeft className="size-4" />
                {t('back')}
              </button>
              <span className="truncate text-sm font-semibold text-foreground">{titleFor(current)}</span>
            </div>
          )}

          {/* Screen body */}
          <div className="flex-1 overflow-y-auto px-5 pb-6">
            {current === 'home' && <HomeScreen t={t} go={go} />}
            {current === 'attendance' && (
              <AttendanceScreen t={t} clockedIn={clockedIn} setClockedIn={setClockedIn} />
            )}
            {current === 'leave' && <LeaveMenuScreen t={t} go={go} />}
            {current === 'leaveHistory' && <LeavePreviewHistory t={t} go={go} />}
            {current === 'leaveBalance' && <LeaveBalanceScreen t={t} />}
            {current === 'leaveCalendar' && <LeaveCalendarScreen t={t} />}
            {current === 'leaveApplication' && <LeaveApplicationScreen t={t} />}
            {current === 'claim' && <ClaimMenuScreen t={t} go={go} />}
            {current === 'claimApplication' && <ClaimApplicationScreen t={t} />}
            {current === 'payroll' && <PayrollScreen t={t} go={go} />}
            {current === 'payslip' && <PayslipScreen t={t} />}
            {current === 'performance' && <ComingSoonScreen t={t} icon={Target} />}
            {current === 'setting' && <ComingSoonScreen t={t} icon={Settings} />}
          </div>

          {/* Home indicator */}
          <div className="flex justify-center pb-2">
            <div className="h-1.5 w-32 rounded-full bg-foreground/20" />
          </div>
        </div>
      </div>
      {stack.length > 1 && (
        <button
          type="button"
          onClick={() => setStack(['home'])}
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('resetToHome')}
        </button>
      )}
    </div>
  );
}

type T = ReturnType<typeof useTranslations<'mobilePreview'>>;

function HomeScreen({ t, go }: { t: T; go: (id: ScreenId) => void }) {
  return (
    <div className="pt-2">
      <div className="mb-5">
        <p className="text-xs text-muted-foreground">{t('home.greeting')}</p>
        <p className="text-lg font-semibold text-foreground">Aisyah Rahman</p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {TILES.map((tile) => {
          const Icon = tile.icon;
          return (
            <button
              key={tile.id}
              type="button"
              onClick={() => go(tile.id)}
              className="flex aspect-square flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-card p-2 text-center shadow-[var(--shadow-card)] transition active:scale-95"
            >
              <span className="grid size-11 place-items-center rounded-2xl bg-primary/10 text-primary">
                <Icon className="size-5" />
              </span>
              <span className="text-[11px] font-medium leading-tight text-foreground">{t(tile.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AttendanceScreen({
  t,
  clockedIn,
  setClockedIn,
}: {
  t: T;
  clockedIn: boolean;
  setClockedIn: (v: boolean) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 pt-6">
      <div className="text-center">
        <p className="text-xs text-muted-foreground">
          {clockedIn ? t('attendance.statusIn') : t('attendance.statusOut')}
        </p>
        <p className="text-3xl font-semibold tabular-nums text-foreground">
          {clockedIn ? '09:02' : '08:58'}
        </p>
      </div>
      <div className="w-full space-y-3">
        <button
          type="button"
          onClick={() => setClockedIn(true)}
          disabled={clockedIn}
          className="w-full rounded-2xl bg-primary py-4 text-base font-semibold text-primary-foreground shadow-[var(--shadow-card)] transition active:scale-[0.98] disabled:opacity-40"
        >
          {t('attendance.clockIn')}
        </button>
        <button
          type="button"
          onClick={() => setClockedIn(false)}
          disabled={!clockedIn}
          className="w-full rounded-2xl border border-border bg-card py-4 text-base font-semibold text-foreground transition active:scale-[0.98] disabled:opacity-40"
        >
          {t('attendance.clockOut')}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{t('attendance.hint')}</p>
    </div>
  );
}

function MenuRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-2xl border border-border bg-card px-4 py-4 text-left text-sm font-medium text-foreground shadow-[var(--shadow-card)] transition active:scale-[0.99]"
    >
      {label}
      <ChevronRight className="size-4 text-muted-foreground" />
    </button>
  );
}

function LeavePreviewNav({t, go, history = false}: {t:T;go:(id:ScreenId)=>void;history?:boolean}) {
  return <nav aria-label={t('feature.leave')} className="space-y-1"><div className="font-semibold">{t('feature.leave')} ▾</div><div className="flex gap-2"><button className={`min-h-11 rounded-lg px-3 ${!history ? 'bg-primary/10 font-semibold' : ''}`} onClick={() => go('leave')}>{t('leave.overview')}</button><button className={`min-h-11 rounded-lg px-3 ${history ? 'bg-primary/10 font-semibold' : ''}`} onClick={() => go('leaveHistory')}>{t('leave.history')}</button></div></nav>;
}

function LeaveMenuScreen({ t, go }: { t: T; go: (id: ScreenId) => void }) {
  return <div className="space-y-3 pt-2"><LeavePreviewNav t={t} go={go} /><MenuRow label={t('leave.balance')} onClick={() => go('leaveBalance')} /><MenuRow label={t('leave.calendar')} onClick={() => go('leaveCalendar')} /><MenuRow label={t('leave.application')} onClick={() => go('leaveApplication')} /></div>;
}

function LeavePreviewHistory({t,go}: {t:T;go:(id:ScreenId)=>void}) {
  return <div className="space-y-4 pt-2"><LeavePreviewNav t={t} go={go} history /><p className="text-xs text-muted-foreground">{t('leave.historySample')}</p><div className="flex flex-wrap gap-2">{['pending','approved','rejected','cancelled'].map((status) => <span key={status} className="rounded-full border border-border px-2 py-1 text-xs">{t(`leave.historyStatus.${status}`)} —</span>)}</div><div className="rounded-lg border border-border p-3">—</div></div>;
}

function LeaveBalanceScreen({ t }: { t: T }) {
  const rows: Array<[string, string]> = [
    [t('leaveBalance.annual'), '12.0'],
    [t('leaveBalance.sick'), '14.0'],
    [t('leaveBalance.unpaid'), '0.0'],
  ];
  return (
    <div className="space-y-3 pt-2">
      {rows.map(([label, days]) => (
        <div
          key={label}
          className="flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-4 shadow-[var(--shadow-card)]"
        >
          <span className="text-sm font-medium text-foreground">{label}</span>
          <span className="text-sm font-semibold text-primary">
            {days} {t('leaveBalance.daysUnit')}
          </span>
        </div>
      ))}
    </div>
  );
}

function LeaveCalendarScreen({ t }: { t: T }) {
  const marked = new Set([9, 10, 22]);
  return (
    <div className="pt-2">
      <p className="mb-3 text-center text-sm font-semibold text-foreground">July 2026</p>
      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
          <div
            key={d}
            className={cn(
              'grid aspect-square place-items-center rounded-lg text-[11px]',
              marked.has(d)
                ? 'bg-primary text-primary-foreground font-semibold'
                : 'bg-card text-muted-foreground',
            )}
          >
            {d}
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-block size-3 rounded-full bg-primary" />
        {t('leaveCalendar.legend')}
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="mb-1 block text-xs font-medium text-muted-foreground">{children}</label>;
}

function FakeInput({ value }: { value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-3 text-sm text-foreground">{value}</div>
  );
}

function LeaveApplicationScreen({ t }: { t: T }) {
  return (
    <div className="space-y-4 pt-2">
      <div>
        <FieldLabel>{t('leaveApp.type')}</FieldLabel>
        <FakeInput value="Annual Leave" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>{t('leaveApp.from')}</FieldLabel>
          <FakeInput value="14 Jul" />
        </div>
        <div>
          <FieldLabel>{t('leaveApp.to')}</FieldLabel>
          <FakeInput value="15 Jul" />
        </div>
      </div>
      <div>
        <FieldLabel>{t('leaveApp.reason')}</FieldLabel>
        <FakeInput value="Family matters" />
      </div>
      <button
        type="button"
        className="w-full rounded-2xl bg-primary py-3.5 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-card)] transition active:scale-[0.98]"
      >
        {t('leaveApp.submit')}
      </button>
    </div>
  );
}

function ClaimMenuScreen({ t, go }: { t: T; go: (id: ScreenId) => void }) {
  return (
    <div className="space-y-3 pt-2">
      <MenuRow label={t('claim.application')} onClick={() => go('claimApplication')} />
    </div>
  );
}

function ClaimApplicationScreen({ t }: { t: T }) {
  return (
    <div className="space-y-4 pt-2">
      <div>
        <FieldLabel>{t('claimApp.type')}</FieldLabel>
        <FakeInput value="Medical" />
      </div>
      <div>
        <FieldLabel>{t('claimApp.amount')}</FieldLabel>
        <FakeInput value="RM 250.00" />
      </div>
      <div>
        <FieldLabel>{t('claimApp.receipt')}</FieldLabel>
        <div className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-card px-3 py-3 text-sm text-muted-foreground">
          <Paperclip className="size-4" />
          {t('claimApp.attach')}
        </div>
      </div>
      <button
        type="button"
        className="w-full rounded-2xl bg-primary py-3.5 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-card)] transition active:scale-[0.98]"
      >
        {t('claimApp.submit')}
      </button>
    </div>
  );
}

function PayrollScreen({ t, go }: { t: T; go: (id: ScreenId) => void }) {
  const months = ['June 2026', 'May 2026', 'April 2026'];
  return (
    <div className="space-y-4 pt-2">
      <div className="rounded-2xl bg-primary p-4 text-primary-foreground shadow-[var(--shadow-card)]">
        <p className="text-xs opacity-80">{t('payroll.latest')}</p>
        <p className="mt-1 text-2xl font-semibold">RM 5,842.30</p>
        <button
          type="button"
          onClick={() => go('payslip')}
          className="mt-3 rounded-full bg-primary-foreground/20 px-3 py-1.5 text-xs font-medium"
        >
          {t('payroll.viewPayslip')}
        </button>
      </div>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('payroll.history')}
      </p>
      <div className="space-y-2">
        {months.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => go('payslip')}
            className="flex w-full items-center justify-between rounded-2xl border border-border bg-card px-4 py-3 text-left shadow-[var(--shadow-card)] transition active:scale-[0.99]"
          >
            <span className="text-sm font-medium text-foreground">{m}</span>
            <span className="text-sm text-muted-foreground">RM 5,842.30</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PayslipScreen({ t }: { t: T }) {
  const earnings: Array<[string, string]> = [
    [t('payslip.basic'), 'RM 6,500.00'],
    [t('payslip.allowance'), 'RM 400.00'],
  ];
  const deductions: Array<[string, string]> = [
    [t('payslip.epf'), 'RM 715.00'],
    [t('payslip.socso'), 'RM 24.75'],
    [t('payslip.pcb'), 'RM 318.00'],
  ];
  return (
    <div className="space-y-4 pt-2">
      <p className="text-xs text-muted-foreground">June 2026</p>
      <section className="rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('payslip.earnings')}
        </p>
        {earnings.map(([label, amt]) => (
          <div key={label} className="flex justify-between py-1 text-sm">
            <span className="text-foreground">{label}</span>
            <span className="tabular-nums text-foreground">{amt}</span>
          </div>
        ))}
      </section>
      <section className="rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('payslip.deductions')}
        </p>
        {deductions.map(([label, amt]) => (
          <div key={label} className="flex justify-between py-1 text-sm">
            <span className="text-foreground">{label}</span>
            <span className="tabular-nums text-foreground">{amt}</span>
          </div>
        ))}
      </section>
      <div className="flex items-center justify-between rounded-2xl bg-primary px-4 py-3 text-primary-foreground">
        <span className="text-sm font-medium">{t('payslip.net')}</span>
        <span className="text-lg font-semibold tabular-nums">RM 5,842.30</span>
      </div>
    </div>
  );
}

function ComingSoonScreen({ t, icon: Icon }: { t: T; icon: LucideIcon }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 pt-10 text-center">
      <span className="grid size-16 place-items-center rounded-3xl bg-primary/10 text-primary">
        <Icon className="size-7" />
      </span>
      <div className="flex items-center gap-1.5 text-lg font-semibold text-foreground">
        <Sparkles className="size-4 text-primary" />
        {t('comingSoon.title')}
      </div>
      <p className="max-w-[220px] text-sm text-muted-foreground">{t('comingSoon.body')}</p>
    </div>
  );
}
