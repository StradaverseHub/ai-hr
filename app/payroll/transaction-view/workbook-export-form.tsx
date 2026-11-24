'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';

/** Where a workbook export may send the person: the Transaction workbooks list and nothing else. */
const WORKBOOKS = '/payroll/transaction-view/workbooks';

/**
 * Queues a transaction workbook and opens the Transaction workbooks list with an ordinary in-app navigation.
 *
 * The action returns the list's address instead of calling redirect(). A redirect from a server action makes Next
 * fetch the target from its own server with the router state removed, so it renders the WHOLE tree again, app shell
 * included (about 33 database transactions, ~0.75 s on staging, 24 Nov 2026), inside the action's response.
 * router.push() sends the router state, so only the workbooks segment renders (docs/PERFORMANCE-TIMING.md).
 */
export function WorkbookExportForm({
  action, className, children,
}: { action: (formData: FormData) => Promise<string>; className?: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <form className={className} action={async (formData) => {
      const href = await action(formData);
      if (href === WORKBOOKS || href.startsWith(`${WORKBOOKS}?`)) router.push(href);
    }}>
      <Pending>{children}</Pending>
    </form>
  );
}

/** One submission at a time: a second click while the first is queuing would only meet "already running". */
function Pending({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  return <fieldset disabled={pending} aria-busy={pending} className="contents">{children}</fieldset>;
}
