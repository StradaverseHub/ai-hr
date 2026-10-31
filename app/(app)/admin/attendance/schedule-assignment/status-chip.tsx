import type { ShiftArrangementListRow } from '@/core/shift-arrangement';

/**
 * a485afa1 rev 2 (r265) — the ONE status chip both Schedule Assignment surfaces render: the list's
 * Status column and the detail page's "In force today" block. It is a separate file because a page.tsx
 * may export nothing but its default, and the alternative — a second copy of the class map on the
 * detail page — is precisely the kind of drift the reporter was promised would not happen between two
 * views of one record. The LABEL and HINT are passed in already translated: each page keeps its own
 * literal t('statusCurrent') map so the i18n static-key guard can see every key.
 *
 * The status itself is never decided here or on either page — it is `listShiftArrangements`'s
 * answer (core/shift-arrangement.ts), which both pages read for the same employment on the same
 * `today`, so the chip on the detail page cannot disagree with the chip on the row behind it.
 */
export const STATUS_STYLE: Record<ShiftArrangementListRow['status'], string> = {
  current: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  scheduled: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  notRecorded: 'bg-muted text-muted-foreground',
};

export function StatusChip({
  status,
  label,
  hint,
}: {
  status: ShiftArrangementListRow['status'];
  label: string;
  hint: string;
}) {
  return (
    <span title={hint} className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status]}`}>
      {label}
    </span>
  );
}
