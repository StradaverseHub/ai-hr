import type { ReactNode } from 'react';
import { leaveVisual } from '@/lib/leave-visual';

/**
 * Secondary-type "Other leave" breakdown section (restored · feedback 56a0deb9).
 *
 * The grouped panels (Family & Personal / Education / Other) the pre-R54 /me Leave tab carried
 * (6d78f373, via lib/leave-groups placements) — each secondary type as a row with its visual chip,
 * the ESS-gated remaining figure, and the caller-supplied "View Breakdown" side-sheet link. The
 * markup is the old /me rendering lifted verbatim into a server-safe component so /leave can host
 * it without inlining <details>/<summary> in the page source (test/leave-request-relocation.test.ts
 * pins the page free of raw <summary> after the apply-Card relocation).
 *
 * Purely presentational: group labels + heading arrive PRE-TRANSLATED and every figure/link is
 * derived by the caller from the same reads that feed the detailed balance table — no data change.
 */
export type SecondaryLeaveGroupEntry = {
  /** Stable group key (family_personal | education | other) — the React list key. */
  group: string;
  /** Pre-translated group title (me.leaveGroups.*). */
  label: string;
  types: {
    leaveTypeId: string;
    leaveType: string;
    color: string | null;
    icon: string | null;
    code: string | null;
    /** ESS-gated remaining figure (deriveBalanceRow; null ⇒ "—" when Available is HR-hidden). */
    remaining: number | null;
    /** Pre-wired EntitlementBreakdown link (omitted when the side-sheet is ESS-disabled). */
    breakdown?: ReactNode;
  }[];
};

export function SecondaryLeaveGroups({
  heading,
  groups,
}: {
  /** Pre-translated section heading (me.otherLeaveHeading). */
  heading: string;
  groups: SecondaryLeaveGroupEntry[];
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">{heading}</h2>
      {groups.map(({ group, label, types }) => (
        <details key={group} className="group rounded-lg border border-border" open>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium">
            <span>
              {label} ({types.length})
            </span>
            <span className="text-muted-foreground transition group-open:rotate-180" aria-hidden>
              ▾
            </span>
          </summary>
          <ul className="divide-y divide-border border-t border-border">
            {types.map((b) => {
              const v = leaveVisual({ color: b.color, icon: b.icon, code: b.code });
              const Icon = v.Icon;
              return (
                <li key={b.leaveTypeId} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-2 text-sm">
                    <span className={v.hasColor ? `rounded p-0.5 ${v.chipClass}` : undefined}>
                      <Icon className="size-3.5 shrink-0" aria-hidden />
                    </span>
                    <span className="truncate font-medium text-foreground">{b.leaveType}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end">
                    <span className="tabular-nums text-sm text-foreground">
                      {b.remaining == null ? '—' : b.remaining.toFixed(2)}
                    </span>
                    {b.breakdown}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      ))}
    </div>
  );
}
