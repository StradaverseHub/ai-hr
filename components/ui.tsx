import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

// Primitives (shadcn-pattern) re-exported so pages can `import { Button } from '@/components/ui'`.
export { Button, buttonVariants } from './ui/button';
export { Input } from './ui/input';
export { Badge } from './ui/badge';
export { Card } from './ui/card';

// Legacy class strings, now token-based — kept for pages not yet migrated to primitives.
export const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';
export const btnPrimary =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition duration-150 ease-snappy hover:bg-primary/90 active:scale-[0.98] disabled:opacity-50';
export const btnGhost =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input px-3 py-1.5 text-sm font-medium transition duration-150 ease-snappy hover:bg-accent hover:text-accent-foreground active:scale-[0.98]';

// The house table look (the individual-transaction screen's convention) as shared constants, so admin tables can adopt the ONE
// standard styling instead of hand-copying the class strings — which is exactly how System Labels drifted
// out of sync in the first place. Use: wrapper div → tableWrapCls, <thead> → theadCls, each <th> → thCls,
// <tbody> → tbodyCls.
export const tableWrapCls = 'overflow-x-auto rounded-md border border-border';
export const theadCls = 'bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground';
export const thCls = 'px-3 py-2 font-medium';
export const tbodyCls = 'divide-y divide-border';

export function Field({
  label,
  children,
  className,
  required,
  requiredAriaLabel,
}: {
  label: string;
  children: ReactNode;
  /** Optional extra classes on the wrapping label (e.g. grid `col-span-full` / `justify-self-end`).
      Backward compatible — existing callers omit it and keep the original layout. */
  className?: string;
  /** Render a red asterisk after the label to mark a mandatory field. Backward compatible — omitted callers
      render exactly as before. */
  required?: boolean;
  /** Accessible label for the asterisk (localised "required"). Only used when `required`. */
  requiredAriaLabel?: string;
}) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-muted-foreground">
        {label}
        {required && (
          <span className="ml-0.5 text-destructive" aria-label={requiredAriaLabel}>
            *
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

/** Initials avatar (no photos) — the warm, consistent identity mark used everywhere. */
export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary',
        className,
      )}
    >
      {initials}
    </span>
  );
}

/** One page header for every screen: optional back-link + title + description + right-side actions. */
export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <div className="space-y-2">
      {back && (
        <Link
          href={back.href}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          ← {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  // Derived Employee Status buckets ONLY (R43 c26c3ce5; Employee Status sync 5afcda91). The obsolete
  // legacy assignment statuses (on_leave / offboarding / terminated) were removed from the vocabulary —
  // no surface renders them any more (terminated lifecycles display as the derived `resigned`). Other
  // vocabularies passing through StatusBadge (e.g. performance cycles) fall to the neutral default.
  probation: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  active: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  active_serving_notice: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  resigned: 'bg-muted text-muted-foreground',
  blacklisted: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
  // R81 (9cbf5e0d) — the sixth bucket. Orange, deliberately distinct from both the amber "serving notice"
  // (a normal, expected state) and the rose "blacklisted" (a sanction): a payroll hold is neither routine
  // nor punitive. No employee can carry it until Payroll grows a hold setting; the colour is here so the
  // vocabulary is complete on the day it does.
  withhold: 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-400',
};

/**
 * Status pill. `status` drives the colour (and the humanised fallback text); pass a translated `label` — as
 * the Employee Status call-sites do, `t('people.employeeStatus.<bucket>')` — so the visible text is localised
 * while the colour still keys off the raw bucket. Without a label it humanises the raw status (used by the
 * historical assignment table, whose stored values are display-only).
 */
export function StatusBadge({ status, label }: { status: string | null; label?: string }) {
  const cls = (status && STATUS_STYLES[status]) || 'bg-muted text-muted-foreground';
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize', cls)}>
      {label ?? (status ? status.replace(/_/g, ' ') : '—')}
    </span>
  );
}

export function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      {message}
    </div>
  );
}

export function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="border-b border-border px-4 py-3 text-sm font-medium">
      {title}
      {count !== undefined && <span className="ml-2 text-muted-foreground">({count})</span>}
    </div>
  );
}

/**
 * Role chip. Prefer passing a translated `label` (the call site does `t('role.<role>')`) so every
 * role label is a STATIC t() lookup the i18n coverage test can see. Falls back to a humanised
 * role string only when no label is given (legacy callers / unknown roles).
 */
export function RoleTag({ role, label }: { role: string; label?: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium capitalize text-primary">
      {label ?? role.replace(/_/g, ' ')}
    </span>
  );
}

/**
 * Employee ID (employee_code) rendered in the one consistent way used everywhere.
 * Centralizes the visual contract so a future styling tweak is a one-file change.
 * Renders nothing when there is no code, so callers can pass a nullable value directly.
 */
export function EmployeeCode({ code, className }: { code?: string | null; className?: string }) {
  if (!code) return null;
  return <span className={cn('font-mono text-xs text-muted-foreground', className)}>{code}</span>;
}

/**
 * Employee ID + name in the ONE consistent order used everywhere (feedback 38668d9b): the ID reads
 * FIRST, on the LEFT of the name. Use this anywhere a staff name is shown inline (cards, rows, headers).
 * When there is no code it renders just the name, so callers can pass a nullable code directly.
 * `codeClassName` tunes the ID chip (e.g. spacing); `className` styles the whole inline group.
 */
export function EmployeeName({
  code,
  name,
  className,
  codeClassName,
}: {
  code?: string | null;
  name: string;
  className?: string;
  codeClassName?: string;
}) {
  return (
    <span className={cn('inline-flex items-baseline gap-1.5', className)}>
      <EmployeeCode code={code} className={codeClassName} />
      <span>{name}</span>
    </span>
  );
}
