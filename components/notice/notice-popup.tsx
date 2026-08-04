'use client';

import { useState } from 'react';
import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';

import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui';

type Action = (fd: FormData) => void | Promise<void>;

/**
 * 6e122302 — the after-login notice popup.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ──────────────────────────────────────────────────────────────────────
 * It is not a queue. The server hands it AT MOST ONE notice (`popupNoticeFor`), because a stack of modals
 * on someone's first screen of the day is how a communication channel becomes something people dismiss
 * without reading. Everything else waits on the dashboard card.
 *
 * It is not an acknowledgement. Closing it records `popup_dismissed_at` — popup-frequency state, nothing
 * more. There is no "I agree" button here and there must not be one until the record behind it exists.
 *
 * ── THE FREQUENCY RULE, AS THE USER EXPERIENCES IT ─────────────────────────────────────────────────────
 * 'once'                — dismissing it is final; it never reappears for this employee.
 * 'until_acknowledged'  — it comes back on every page load while the notice is live. Reserved for the
 *                         genuinely important ones, and the default is 'once' precisely because the
 *                         reappearing kind is both the most effective and the most resented.
 *
 * Both server actions are passed as props (references React can serialise), and every string arrives
 * pre-translated — this is mounted from the ROOT LAYOUT, a server component, and r124 took a tab down in
 * production by passing a translator closure across that boundary.
 */
export function NoticePopup({
  noticeId,
  title,
  body,
  href,
  readLabel,
  dismissLabel,
  dismissAction,
}: {
  noticeId: string;
  title: string;
  /** The notice's Markdown. Rendered HERE, not just linked to — a popup that shows only a headline makes
   *  the employee click through to learn anything, which is the interruption without the communication. */
  body: string;
  href: string;
  readLabel: string;
  dismissLabel: string;
  dismissAction: Action;
}) {
  // Opens on mount. `open` is local so the dialog closes instantly on dismiss rather than waiting for the
  // server round-trip — the write still happens, but the user is not held up by it.
  const [open, setOpen] = useState(true);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          {/* Radix requires a Description for the dialog's accessible name; the notice's own content is
              the description, so it is not duplicated in a hidden one. */}
          <Dialog.Description className="sr-only">{title}</Dialog.Description>
          {/* Capped and scrollable: a long policy must not push the buttons off the bottom of the screen,
              which would leave the employee with a modal they cannot dismiss. */}
          <div className="mt-3 max-h-[50vh] overflow-y-auto pr-1">
            <Markdown>{body}</Markdown>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            {/* Dismiss posts through a real form, so the record is written even if the navigation below
                never happens. Dialog.Portal reparents this content to document.body — which is why the
                form is self-contained here rather than relying on an enclosing one. */}
            <form action={dismissAction} onSubmit={() => setOpen(false)}>
              <input type="hidden" name="noticeId" value={noticeId} />
              <Button type="submit" size="sm" variant="outline">
                {dismissLabel}
              </Button>
            </form>
            {/* Reading it is the point — the link goes to the full notice, which marks it viewed. It does
                NOT dismiss the popup: a 'once' notice the employee opened will not pop up again anyway
                once they dismiss it, and one they opened but did not dismiss legitimately comes back. */}
            <Link
              href={href}
              onClick={() => setOpen(false)}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              {readLabel}
            </Link>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
