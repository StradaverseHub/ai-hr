import { Layers } from 'lucide-react';
// The pooled figure is a day figure like every other on this page, so it prints through the one formatter
// (4a1abc4a). A private toFixed here is how the group's number and the rows it pools drift apart.
import { formatDays } from '@/lib/day-format';

/**
 * SHARED LEAVE GROUP cards on the employee Leave tab (feedback 46afcc48).
 *
 * A shared leave group is several leave types drawing on ONE pooled annual allowance — the reporter's
 * "Special Leave: 10 days shared across Caregiver, Compassionate, Examination, Graduation, Natural Disaster
 * and Study". Until this item the pot existed only in the engine: it refused applications past its ceiling
 * and appeared on no screen, so the six types read as six unrelated rows with nothing saying they share
 * anything.
 *
 * ⚠️ THE FIGURE ON THE CARD IS NOT THE CEILING. It is what is genuinely still drawable —
 * min(what is left under the shared ceiling, what the member types actually still hold) — computed by
 * `sharedGroupAvailableDays` (lib/leave-groups.ts) and handed here already resolved. On the reporter's own
 * data that is 9.00 against a 10.00 ceiling for at least one employee, because the six types do not carry
 * ten days between them. The ceiling is printed BESIDE it as context ("of 10.00 shared"), never in place of
 * it: a card promising ten days the group guard would then refuse is worse than no card.
 *
 * INDEPENDENT OF THE MEMBER TYPES' OWN PLACEMENTS, in both directions. This section is drawn wherever HR
 * placed the GROUP; each member type is still shown, grouped or hidden by its own setting; and hiding every
 * member changes neither this figure nor what the employee may apply for.
 *
 * Purely presentational and server-safe (no 'use client'): every string arrives PRE-TRANSLATED and every
 * figure is derived by the caller. Nothing here reads a balance, and there is nothing to click — a group is
 * a pooled ceiling, not a ledger, so it has no per-credit breakdown to open.
 */
export type SharedLeaveGroupEntry = {
  id: string;
  name: string;
  /** What is genuinely still drawable across the pool. */
  available: number;
  /** Pre-translated context line, e.g. "of 10.00 shared days". */
  limitLabel: string;
  /** Pre-translated per-application cap line, or null when the group has no cap. */
  capLabel: string | null;
  /** Pre-translated membership line, e.g. "Shared across: Caregiver, Compassionate, …". */
  membersLabel: string;
};

export function SharedLeaveGroupCards({
  heading,
  entries,
}: {
  /** Pre-translated section heading. */
  heading: string;
  entries: SharedLeaveGroupEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold">{heading}</h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map((g) => (
          <div
            key={g.id}
            className="flex flex-col items-start gap-2 rounded-xl bg-muted/50 p-4 text-foreground"
          >
            <Layers className="size-5 shrink-0" aria-hidden />
            <span className="text-2xl font-semibold tabular-nums">{formatDays(g.available)}</span>
            <span className="text-xs text-muted-foreground">{g.limitLabel}</span>
            <span className="line-clamp-2 text-xs font-medium">{g.name}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{g.membersLabel}</span>
            {g.capLabel && <span className="text-xs text-muted-foreground">{g.capLabel}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
