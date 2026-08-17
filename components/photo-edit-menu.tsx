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
 *
 * CLOSING UNMOUNTS THE CHILDREN — that is deliberate (a stale <form> must not keep a half-filled file
 * input alive off-screen), but it means any state a CALLER derives from those children dies with them.
 * `onClose` exists for exactly that: it fires on every close path (trigger toggle AND backdrop click), so
 * a caller holding, say, a preview of the file the user just picked can drop it instead of leaving the
 * reader staring at an unsaved preview whose submit button no longer exists (3c2f55d7 rev 2).
 */

import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';

export function PhotoEditMenu({
  label,
  hint,
  onClose,
  children,
}: {
  /** Accessible label / tooltip for the pencil trigger, e.g. "Edit photo". */
  label: string;
  /** Small helper line (format + size limit) shown at the bottom of the menu. */
  hint: string;
  /** Fired whenever the popover closes (trigger toggle or backdrop click) — the children have just been
   *  unmounted, so anything the caller derived from them must be dropped here. */
  onClose?: () => void;
  /** The upload/replace + remove <form>s, built by the server page. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
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
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="absolute left-1/2 z-50 mt-1.5 flex w-56 -translate-x-1/2 flex-col items-center gap-2 rounded-lg border border-border bg-popover p-3 text-popover-foreground opacity-100 shadow-lg transition duration-150 ease-snappy starting:scale-95 starting:opacity-0">
            {children}
            <p className="text-center text-[11px] text-muted-foreground">{hint}</p>
          </div>
        </>
      )}
    </div>
  );
}
