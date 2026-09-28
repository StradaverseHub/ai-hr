/**
 * THE SHARED LEAVE GROUP ENTRY — the shape of one pooled-allowance tile (feedback 46afcc48).
 *
 * ⚠️ r356 — THIS FILE WAS `shared-leave-group-cards.tsx` AND HELD A COMPONENT THAT NOTHING RENDERED.
 * r302 (6c9802c9) folded both placements into the one My Leave dashboard grid, and from then on the tiles
 * were drawn by `my-leave-dashboard.tsx`'s own `sharedGroups.map(...)`; r355 recorded that the component
 * was dead and left it in place. It is deleted here, the file is renamed for what it actually is, and the
 * two guards that were reading the DEAD file for "prints through the shared formatter" and "the ceiling
 * beside the figure, never in place of it" are re-pointed at the live render site — they were green over
 * a file no screen used, which is the shape of a guard that protects nothing.
 *
 * The rules below are the LIVE ones and they belong to the dashboard's tile now. They are kept here
 * because they are what this type is for.
 *
 * A shared leave group is several leave types drawing on ONE pooled annual allowance — the reporter's
 * "Special Leave: 10 days shared across Caregiver, Compassionate, Examination, Graduation, Natural Disaster
 * and Study". Until this item the pot existed only in the engine: it refused applications past its ceiling
 * and appeared on no screen, so the six types read as six unrelated rows with nothing saying they share
 * anything.
 *
 * ⚠️ THE FIGURE ON THE TILE IS NOT THE CEILING. It is what is genuinely still drawable —
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
 * EVERY STRING ARRIVES PRE-TRANSLATED and every figure is derived by the caller — that is why the fields
 * below are labels rather than ids and numbers. The tile that renders them lives inside a client island
 * now, so this is the contract that keeps the translation on the server side of it. Nothing here reads a
 * balance, and there is nothing to click: a group is a pooled ceiling, not a ledger, so it has no
 * per-credit breakdown to open.
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
  // ⚠️ r355 (8d3a7bff) — `detailsHref` / `detailsLabel` WERE HERE AND ARE GONE WITH THE PAGE THEY POINTED
  // AT. 76dbcaa1 added them for /leave/shared/[groupId]; that page is deleted, so a required field no
  // caller can fill would only break the build. app/leave/page.tsx builds these values and
  // my-leave-dashboard.tsx draws them; r356 deleted the component that used to sit below this type and
  // renamed the file, because "cards" had not been true of it since r302.
};
