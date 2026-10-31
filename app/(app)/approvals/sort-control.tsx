'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { inputCls } from '@/components/ui';
import { APPROVAL_SORTS, DEFAULT_APPROVAL_SORT, type ApprovalSort } from '@/lib/approvals-sort';

/**
 * Approvals sort dropdown (feedback 09cda965). Client leaf so it can navigate on change; the SERVER
 * page reads the resulting ?sort= param and orders each section in the render layer. Changing the sort
 * writes ?sort= (preserving any other params) and pushes — the queue re-renders in the chosen order and
 * the selection survives reload (bulk-approval item keys selection by request id, not row position).
 * Kept 'use client' + isolated from the pure sort helpers so the RSC-boundary guard stays satisfied.
 */
export function ApprovalsSortControl({
  value,
  labels,
}: {
  value: ApprovalSort;
  labels: { sortBy: string } & Record<ApprovalSort, string>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const onChange = (next: string) => {
    const sp = new URLSearchParams(params.toString());
    if (next === DEFAULT_APPROVAL_SORT) sp.delete('sort');
    else sp.set('sort', next);
    const qs = sp.toString();
    router.push(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="whitespace-nowrap">{labels.sortBy}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputCls} h-8 py-0 text-xs`}
        aria-label={labels.sortBy}
      >
        {APPROVAL_SORTS.map((opt) => (
          <option key={opt} value={opt}>
            {labels[opt]}
          </option>
        ))}
      </select>
    </label>
  );
}
