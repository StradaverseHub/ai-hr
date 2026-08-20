'use client';

import { Children, type ReactNode, useEffect, useRef, useState } from 'react';

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
 * this island cannot accidentally offer Reset on a closed run, because it never sees a status.
 *
 * 9f8cd608 — EVERY ITEM IN HERE IS A LINK TO ITS OWN SCREEN, AND THAT IS A RULE, NOT A COINCIDENCE. Reset
 * Payroll used to be handed in as a `<form>` carrying a confirmation dialog. The dialog's body is portalled
 * to the document, but its OWNER is this subtree — so the moment the panel below closed, the dialog
 * unmounted with it. And opening it EMITTED A SCROLL: measured in Chromium at 1280×720 against a real run,
 * one scroll event on `DIV.overflow-x-auto`, after which zero menus and zero dialogs were left on screen.
 * The scroll listener below closed the panel, and the dialog was created and destroyed in the same tick.
 * (Which of the dialog's side effects produces that scroll — the focus move, or react-remove-scroll's body
 * lock reflowing the page and clamping the wrapper's `scrollLeft` — was not isolated, and does not need to
 * be: this panel closes on ANY scroll from anywhere, so a dialog it owns is destroyed by its own opening
 * either way.) Reset now opens app/payroll/[batchId]/reset like its two siblings, and
 * test/payroll-reset-screen-9f8cd608.test.ts asserts the caller hands this island links only, so a
 * confirmation dialog cannot move back inside a panel that closes underneath it.
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

  // CLOSE ON ANY SCROLL OR RESIZE, from anywhere. The panel is `position: fixed` and its coordinates are
  // measured ONCE in `toggle`, so anything that moves the row under it leaves the menu nailed to the
  // viewport beside a DIFFERENT run while still carrying the original row's hrefs. Closing is the whole
  // mitigation, and it is now sufficient: since 9f8cd608 every item is a link to a screen that names the
  // company, period, cycle, payment date and headcount of the run it is about, so a mis-aimed click is
  // caught by the operator reading the screen it lands on rather than acted on silently.
  //
  // The backdrop's own onWheel cannot cover this: a wheel with the cursor over the PANEL bubbles
  // panel → wrapper → td and never reaches the backdrop, and keyboard scrolling (arrows, PageDown), touch
  // scrolling and a window resize have no backdrop event at all. Capture phase so a scrolling container
  // that stops propagation still closes it.
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [at]);

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
          {/* Click-away. The wheel handler is a belt-and-braces duplicate of the window listener above —
              it fires only for a wheel over the BACKDROP; the effect is what actually covers scrolling. */}
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
