import * as React from 'react';
import { cn } from '@/lib/utils';
import { Kv, type KvItem } from './figures';
import { MONO_LABEL } from './classes';

/**
 * r400 — Monolith primitives: NOTE, EMPTY, PANEL (docs/design/monolith shell.css `.note`, `.empty`,
 * `.panel`; generator.py `render_section` kinds 'note' / 'empty' and the `build` panel). All text is the
 * caller's (already translated) — these components carry no strings of their own. Theme by CSS only.
 */

const TITLE = 'text-base font-semibold monolith:text-[18px] monolith:font-medium monolith:tracking-[-0.02em]';
const DETAIL = 'text-[13px] leading-normal text-muted-foreground monolith:text-mid';

/**
 * Replaces alert cards (README §4): a mono label (signal-text when it warns), one sentence, a line of detail,
 * one action. In Monolith there is no box and no tint; in Classic it keeps today's bordered note, amber when
 * it warns. `role="note"` — advisory content, not a live alert (nothing here interrupts a screen reader).
 */
export function Note({
  label,
  title,
  body,
  action,
  warn = false,
  className,
}: {
  label?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  /** A link or text button (`<Button variant="link">`, `<a>`), rendered after the detail. */
  action?: React.ReactNode;
  warn?: boolean;
  className?: string;
}) {
  return (
    <div
      role="note"
      data-warn={warn || undefined}
      className={cn(
        'flex max-w-[560px] flex-col gap-1.5 rounded-lg border p-4',
        warn ? 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10' : 'border-border bg-card',
        'monolith:rounded-none monolith:border-0 monolith:bg-transparent monolith:p-0',
        className,
      )}
    >
      {label != null && (
        <span
          className={cn(
            'text-xs font-medium',
            warn ? 'text-amber-800 dark:text-amber-300 monolith:text-signal-text' : 'text-muted-foreground monolith:text-mid',
            MONO_LABEL,
          )}
        >
          {label}
        </span>
      )}
      <span className={TITLE}>{title}</span>
      {body != null && <span className={DETAIL}>{body}</span>}
      {action != null && <span className="self-start pt-0.5">{action}</span>}
    </div>
  );
}

/** An empty state (shell.css `.empty`): a dashed faint box, a mono label, one sentence, optional detail. */
export function Empty({
  label,
  title,
  body,
  className,
}: {
  label?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-empty
      className={cn(
        'flex min-h-[120px] flex-col items-start justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-5',
        'monolith:rounded-none monolith:border-faint',
        className,
      )}
    >
      {label != null && <span className={cn('text-xs font-medium text-muted-foreground monolith:text-mid', MONO_LABEL)}>{label}</span>}
      <span className={TITLE}>{title}</span>
      {body != null && <span className={DETAIL}>{body}</span>}
    </div>
  );
}

/**
 * The right-hand detail column, 300–420px (shell.css `.panel`): kicker, a 28px title, a line of detail, a
 * two-column spec grid, actions. An <aside> — complementary to the list or form beside it — labelled by
 * its title.
 */
export function Panel({
  kicker,
  title,
  body,
  kv,
  actions,
  children,
  className,
}: {
  kicker?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  kv?: KvItem[];
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  const titleId = React.useId();
  return (
    <aside
      aria-labelledby={titleId}
      data-panel
      className={cn(
        'flex min-w-[280px] flex-[1_1_300px] flex-col gap-3.5 rounded-[1.25rem] border border-border bg-card p-4 shadow-[var(--shadow-card)]',
        'monolith:rounded-none monolith:border-0 monolith:border-t monolith:border-ink monolith:bg-transparent monolith:px-0 monolith:pt-3 monolith:pb-0 monolith:shadow-none',
        className,
      )}
    >
      <div>
        {kicker != null && <span className={cn('text-xs text-muted-foreground monolith:text-mid', MONO_LABEL)}>{kicker}</span>}
        <h2
          id={titleId}
          className="mt-1.5 text-lg font-semibold leading-tight monolith:text-[28px] monolith:font-medium monolith:leading-[1.05] monolith:tracking-[-0.03em]"
        >
          {title}
        </h2>
        {body != null && <p className="mt-1.5 text-sm leading-normal text-muted-foreground monolith:text-[14px] monolith:text-mid">{body}</p>}
      </div>
      {kv && kv.length > 0 && <Kv items={kv} cols={2} />}
      {children}
      {actions != null && <div className="flex flex-wrap items-center gap-5">{actions}</div>}
    </aside>
  );
}
