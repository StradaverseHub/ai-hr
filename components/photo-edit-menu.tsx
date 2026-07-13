'use client';

/**
 * Profile-photo edit menu (feedback dc23d3b6).
 *
 * Presentation-only client island: the admin photo controls (Upload/Replace form + Remove form) used
 * to sit permanently under the avatar, which cluttered the profile header. This island hides them
 * behind a small pencil/Edit trigger; clicking it opens a popover holding the exact same forms.
 *
 * RSC boundary: the Server Component page BUILDS both <form>s (with their server-action bindings) and
 * passes them in as `children` — this island only toggles their visibility. Nothing exported here is a
 * plain function called from the page (it's rendered as JSX), so the rsc-boundary-guard stays green.
 * `label`/`hint` arrive PRE-TRANSLATED as props (no t() here) so the i18n static-key check keeps
 * meaning and the component stays page-agnostic.
 *
 * Popover structure (trigger + fixed click-catcher backdrop + absolute panel with starting:* enter
 * transition) mirrors components/company-switcher.tsx for visual consistency.
 */

import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';

export function PhotoEditMenu({
  label,
  hint,
  children,
}: {
  /** Accessible label / tooltip for the pencil trigger, e.g. "Edit photo". */
  label: string;
  /** Small helper line (format + size limit) shown at the bottom of the menu. */
  hint: string;
  /** The upload/replace + remove <form>s, built by the server page. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={cn(
          'flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition duration-150 ease-snappy hover:bg-muted active:scale-[0.98]',
          open && 'bg-muted',
        )}
      >
        <Pencil className="size-3.5" />
        <span>{label}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-1/2 z-50 mt-1.5 flex w-56 -translate-x-1/2 flex-col items-center gap-2 rounded-lg border border-border bg-popover p-3 text-popover-foreground opacity-100 shadow-lg transition duration-150 ease-snappy starting:scale-95 starting:opacity-0">
            {children}
            <p className="text-center text-[11px] text-muted-foreground">{hint}</p>
          </div>
        </>
      )}
    </div>
  );
}
