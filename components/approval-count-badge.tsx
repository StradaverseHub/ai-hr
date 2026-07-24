'use client';

import { cn } from '@/lib/utils';

/**
 * Pending-approval count badge for the "Approval Items" rail row (feedback 836118c4).
 *
 * Purely presentational — the number is computed server-side in app/layout.tsx as
 * `listPendingTasks(...).length` (the SAME user-scoped queue the bell's Task tab renders) and threaded
 * through <Sidebar approvalCount>. Nothing is queried here.
 *
 * Deliberately a standalone module rather than a local const inside components/sidebar.tsx: the sidebar
 * pulls next/navigation + the pack registry at module load and cannot be imported by a node test, whereas
 * this file's only dependency is `cn`, so the hide-at-zero / 9+ / placement branches get real unit
 * coverage (test/approval-items-nav.test.ts).
 *
 * Visual tokens are the bell's corner-dot set verbatim (components/notification-center.tsx) so the two
 * pending-work indicators read as one thing: amber pill, 9+ cap past nine.
 */
export function ApprovalCountBadge({ count, collapsed }: { count: number; collapsed: boolean }) {
  // Hide at zero — an empty queue should look empty, not like a "0" someone has to parse.
  if (count <= 0) return null;
  return (
    <span
      // aria-hidden: the count already reaches assistive tech through the row's aria-label
      // (nav.approvalsCount), so announcing the bare glyph again would just be noise — and "9+"
      // is meaningless read aloud.
      aria-hidden
      className={cn(
        'inline-flex min-w-[15px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-[15px] text-white',
        // Collapsed rail: a bubble pinned over the size-11 icon square (the row is `relative`).
        // Expanded rail: a trailing pill pushed to the far edge of the row.
        collapsed ? 'absolute right-1 top-1' : 'ml-auto',
      )}
    >
      {count > 9 ? '9+' : count}
    </span>
  );
}
