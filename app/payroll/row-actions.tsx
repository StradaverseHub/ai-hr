'use client';

import { Children, useRef, useState, type ReactNode } from 'react';

/**
 * 65e2d5de — the Payroll Process list's compact row-action control.
 *
 * WHAT IT FIXES. A processed row had grown to four separate controls (View · Reprocess · Remove Employee
 * · Reset Payroll) sitting in one flex cell, and each round that added an action made the Actions column
 * wider. The table is `min-w-[64rem]` inside an `overflow-x-auto` wrapper, so the cost lands as horizontal
 * scrolling on the whole grid — the reporter's complaint. View stays permanently visible because it is the
 * one action used on every row; the rest move behind a ⋯ menu.
 *
 * IT DECIDES NOTHING ABOUT AVAILABILITY. Every visibility condition stays on the server page, written
 * exactly as it was, and the actions arrive here as ALREADY-RENDERED NODES (the `adjustmentsPanel` slot
 * convention — a server-rendered node handed to a client component, never a closure). That is deliberate:
 * this island cannot accidentally offer Reset on a closed run, because it never sees a status. It also
 * keeps the server actions and their ConfirmSubmit dialogs intact — a `<form action={resetAction}>` passed
 * as children is still the same form, with the same hidden inputs.
 *
 * A MENU OF ONE IS WORSE THAN NO MENU, so a single surviving action renders inline. `Children.toArray`
 * drops the `false` a `cond && <X/>` produces, so the count is the number of actions actually offered —
 * which is how a run with multi-cycle off (Reset only) keeps its one-click Reset.
 *
 * THE PANEL IS `position: fixed`, MEASURED FROM THE BUTTON, and that is not a style preference. The cell
 * lives inside the table's `overflow-x-auto` wrapper; per CSS, a non-visible overflow on one axis makes the
 * other axis `auto` too, so an absolutely-positioned panel would be CLIPPED by that wrapper and the menu
 * would open into a scroll region instead of over the page. Fixed coordinates escape the clip entirely.
 */
export function PayrollRowActions({
  moreLabel,
  children,
}: {
  /** Pre-translated accessible name for the ⋯ trigger (the caller does the literal t('…') lookup, so the
   *  i18n coverage check keeps seeing a static key at the call site). */
  moreLabel: string;
  /** The actions for THIS row, already rendered by the server page under their own conditions. */
  children?: ReactNode;
}) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const items = Children.toArray(children);

  if (items.length === 0) return null;
  // One action ⇒ render it as it is. Hiding a single link behind a menu costs a click and saves no width.
  if (items.length === 1) return <>{items[0]}</>;

  const toggle = () => {
    if (at) return setAt(null);
    const r = btn.current?.getBoundingClientRect();
    // jsdom (and a button that has not laid out yet) reports zeroes — the menu still opens, at 0,0.
    setAt({ top: (r?.bottom ?? 0) + 4, right: Math.max(0, window.innerWidth - (r?.right ?? 0)) });
  };

  return (
    <div className="relative inline-block">
      <button
        ref={btn}
        type="button"
        aria-label={moreLabel}
        title={moreLabel}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={toggle}
        className="rounded-md px-2 py-1 text-sm font-medium text-muted-foreground transition hover:bg-accent/60 hover:text-foreground"
      >
        ⋯
      </button>
      {at && (
        <>
          {/* Click-away. Also closes on scroll, because the panel's coordinates were measured once and a
              scrolled page would leave it floating beside nothing. */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setAt(null)}
            onWheel={() => setAt(null)}
            aria-hidden
          />
          <div
            role="menu"
            style={{ top: at.top, right: at.right }}
            className="fixed z-50 w-56 overflow-hidden rounded-lg border border-border bg-popover py-1 text-left shadow-lg"
          >
            {items.map((item, i) => (
              <div key={i} className="px-1 py-0.5 [&_a]:block [&_a]:w-full [&_button]:w-full">
                {item}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
