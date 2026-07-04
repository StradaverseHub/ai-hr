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

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
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
  active: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  on_leave: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  probation: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  offboarding: 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-400',
  terminated: 'bg-muted text-muted-foreground',
};

export function StatusBadge({ status }: { status: string | null }) {
  const cls = (status && STATUS_STYLES[status]) || 'bg-muted text-muted-foreground';
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize', cls)}>
      {status ? status.replace(/_/g, ' ') : '—'}
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
