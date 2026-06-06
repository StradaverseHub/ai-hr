import type { ReactNode } from 'react';
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
  'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50';
export const btnGhost =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
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

export function RoleTag({ role }: { role: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium capitalize text-primary">
      {role.replace(/_/g, ' ')}
    </span>
  );
}
