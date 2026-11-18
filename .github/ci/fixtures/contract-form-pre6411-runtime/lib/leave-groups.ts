// Leave grouping visibility (feedback b653ac1b).
//
// Single source of truth for HOW leave types are arranged on the employee self-service Leave tab. Each type
// resolves to one of three placements:
//   'primary'   — a card that stands out at the top of the Leave tab
//   'secondary' — tucked into a labelled group lower down (Family & Personal / Education / Other)
//   'hidden'    — not shown to the employee at all
//
// The resolution is a thin HR-editable layer over a code-keyed DEFAULT map:
//   - HR's explicit choice (leave_type.ess_placement 'primary'|'secondary', OR visible_to_employee=false for
//     Hidden) always wins.
//   - When HR has made no choice (ess_placement NULL and visible_to_employee not false) the code-keyed
//     default applies, so the screen looks right on day one and HR only adjusts the exceptions.
//
// HIDDEN REUSES THE SINGLE VISIBILITY SWITCH. There is exactly ONE hidden mechanism in the system: the
// leave_type.visible_to_employee flag added by 7b11f1c1. "Hidden placement" == that flag being false. We do
// NOT store 'hidden' in ess_placement and there is no second hidden column — resolvePlacement reads the flag
// first. This keeps HR from ever facing two competing controls for the same concept.
//
// 464b58e6 finished that job on the SCREEN. One mechanism was still being offered through two controls: the
// Employee Visibility sub-form carried a "Visible to employee" checkbox writing this very flag, directly
// above the placement select whose "Hidden" option writes it too. The checkbox is gone and the placement
// control is the single writer; app/admin/actions.ts no longer forwards visibleToEmployee from that form.
// Nothing here changed, and nothing here should: hidden is still this flag, resolved in this function.
//
// GUARDRAIL: nothing here is ever consulted for entitlement / eligibility / accrual / workflow / payroll. It
// only decides how leave types are arranged and shown on screen (the reporter's stated scope). The planned
// cards-and-groups /me renderer (6d78f373) consumes the resolved placement; b653ac1b owns the config layer.

/** The three visible placements a leave type can resolve to on the employee Leave tab. */
export const ESS_PLACEMENTS = ['primary', 'secondary', 'hidden'] as const;
export type EssPlacement = (typeof ESS_PLACEMENTS)[number];

/** The placement values that are STORABLE in leave_type.ess_placement. 'hidden' is deliberately NOT storable
 *  — it is expressed through visible_to_employee=false (the single shared switch). A DB CHECK enforces this. */
export const STORABLE_PLACEMENTS = ['primary', 'secondary'] as const;
export type StorablePlacement = (typeof STORABLE_PLACEMENTS)[number];

/** The labelled groups a Secondary leave type falls into on the employee Leave tab. */
export const SECONDARY_GROUPS = ['family_personal', 'education', 'other'] as const;
export type SecondaryGroup = (typeof SECONDARY_GROUPS)[number];

/** Common, high-traffic leave types that default to a Primary card at the top of the tab. */
export const PRIMARY_CODES = ['ANNUAL', 'SICK', 'HOSPITALIZATION', 'EMERGENCY', 'REPLACEMENT'] as const;

/**
 * 5ff7daff — THE SAME ROLE MARKER, one layer further out, and why the code map alone was not enough.
 *
 * `PRIMARY_CODES` holds the codes the PACK SEEDS. Production's catalogue was not seeded: its replacement
 * type is coded `RL` and its emergency type `EL`, neither of which is in that list — so a tenant that has
 * classified those types (`leave_type.role`) but never opened the placement control would have them fall
 * out of the Primary cards and into an "Other" group, which is exactly the "where is my replacement leave"
 * the reporter raised. `leave_type.role` is the tenant-independent answer to "what IS this type", and the
 * rest of replacement leave was moved onto it in r194 (`leaveTypeIs`, `isReplacementLeaveType`); the
 * placement rule was the last code-only reader left.
 *
 * ROLE WINS OVER THE CODE MAP, and nothing else: it is a DEFAULT, so HR's explicit `ess_placement` still
 * overrides it and `visible_to_employee=false` still hides. An UNCLASSIFIED row (role null/empty) falls
 * back to the code map, so a tenant nobody has classified behaves exactly as before.
 *
 * Only the two roles whose types are the reporter's subject are listed. The other roles (annual / sick /
 * hospitalization / maternity / paternity) are deliberately NOT here — promoting them by role would move
 * cards on tenants that never asked for it, and their seeded codes already sit in `PRIMARY_CODES`.
 *
 * The role strings are LITERALS rather than an import: this module is pulled into a client component
 * (`components/leave-type-panel.tsx`) and `core/leave.ts` imports `db/client` → postgres. Same reason, and
 * the same remedy, as `db/schema.ts`'s `LeaveTypeRoleValue`: the mirror is pinned against the real
 * `LEAVE_TYPE_ROLES` by test/leave-grouping-visibility.test.ts so it cannot drift silently.
 */
export const PRIMARY_ROLES = ['replacement', 'emergency'] as const;
export type PrimaryRole = (typeof PRIMARY_ROLES)[number];

/** Codes (exact) that default to Hidden — sensitive or rarely-used types the employee should not normally
 *  see on their dashboard. Prefix families (PROLONGED_ILLNESS_*, SUSPENSION_*) are matched separately. */
export const DEFAULT_HIDDEN_CODES = ['UNRECORDED', 'UNPAID_MEDICAL'] as const;

/** Code prefixes whose whole family defaults to Hidden. */
export const DEFAULT_HIDDEN_PREFIXES = ['PROLONGED_ILLNESS_', 'SUSPENSION_'] as const;

/** Secondary-group membership by code (used only when a type resolves to 'secondary'). Anything not listed
 *  falls into 'other'. This is a code-keyed default the renderer reads; it does not gate anything. */
const SECONDARY_GROUP_BY_CODE: Record<string, SecondaryGroup> = {
  MARRIAGE: 'family_personal',
  MATERNITY: 'family_personal',
  PATERNITY: 'family_personal',
  COMPASSIONATE: 'family_personal',
  BEREAVEMENT: 'family_personal',
  CHILDCARE: 'family_personal',
  PARENTAL: 'family_personal',
  FAMILY: 'family_personal',
  PERSONAL: 'family_personal',
  STUDY: 'education',
  EXAM: 'education',
  EXAMINATION: 'education',
  EDUCATION: 'education',
  TRAINING: 'education',
};

/** True when this code defaults to Hidden (sensitive / rarely-used), by exact code or by prefix family. */
export function isDefaultHiddenCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const c = code.toUpperCase();
  if ((DEFAULT_HIDDEN_CODES as readonly string[]).includes(c)) return true;
  return DEFAULT_HIDDEN_PREFIXES.some((p) => c.startsWith(p));
}

/** The code-keyed DEFAULT placement for a type HR has not configured. PRIMARY_CODES ⇒ 'primary';
 *  default-hidden set ⇒ 'hidden'; everything else ⇒ 'secondary'. A null/blank code ⇒ 'secondary' (a custom
 *  type with no recognised code sits in a group rather than standing out or disappearing). */
export function defaultPlacementForCode(code: string | null | undefined): EssPlacement {
  const c = (code ?? '').toUpperCase();
  if (isDefaultHiddenCode(c)) return 'hidden';
  if ((PRIMARY_CODES as readonly string[]).includes(c)) return 'primary';
  return 'secondary';
}

/**
 * The ROLE-keyed DEFAULT placement, or null when the role has no opinion (5ff7daff).
 *
 * null — not 'secondary' — is the "no opinion" answer, and the distinction is the whole point: an
 * unclassified row, or a role outside `PRIMARY_ROLES`, must fall THROUGH to the code map rather than be
 * given an answer here. Case/whitespace-tolerant because `role` is written by seeds, migrations and the
 * admin screen alike.
 */
export function defaultPlacementForRole(role: string | null | undefined): EssPlacement | null {
  const r = (role ?? '').trim().toLowerCase();
  if (r === '') return null;
  return (PRIMARY_ROLES as readonly string[]).includes(r) ? 'primary' : null;
}

/** The DEFAULT placement for a type HR has not configured — role first, the code map as the fallback.
 *  This is the single place the two default maps are combined; `resolvePlacement` is its only caller. */
export function defaultPlacementFor(
  code: string | null | undefined,
  role?: string | null,
): EssPlacement {
  return defaultPlacementForRole(role) ?? defaultPlacementForCode(code);
}

/**
 * Resolve the effective placement of a leave type on the employee Leave tab.
 *
 * Precedence (single source of truth for hidden is the visible_to_employee flag):
 *   1. visibleToEmployee === false ⇒ 'hidden' (HR hid it via the shared switch; 7b11f1c1 also drops the row
 *      from leaveBalances, but we still resolve 'hidden' for any consumer that receives the flag directly).
 *   2. an explicit stored ess_placement ('primary' | 'secondary') ⇒ that value (HR's grouping choice wins).
 *   3. otherwise ⇒ the DEFAULT: the role map first (5ff7daff), then the code map.
 *
 * `role` is LAST and OPTIONAL so every existing three-argument call site keeps compiling and keeps its
 * exact answer — a caller that does not know the role gets the code-keyed default it always got.
 *
 * @param code               the leave type's immutable code (e.g. 'ANNUAL')
 * @param essPlacement       leave_type.ess_placement ('primary' | 'secondary' | null); 'hidden' is never
 *                           stored but is tolerated defensively (treated as hidden).
 * @param visibleToEmployee  leave_type.visible_to_employee (null ⇒ visible; false ⇒ hidden)
 * @param role               leave_type.role (null/unknown ⇒ the code map decides, as before)
 */
export function resolvePlacement(
  code: string | null | undefined,
  essPlacement: string | null | undefined,
  visibleToEmployee: boolean | null | undefined,
  role?: string | null,
): EssPlacement {
  if (visibleToEmployee === false) return 'hidden';
  if (essPlacement === 'primary' || essPlacement === 'secondary') return essPlacement;
  // Defensive: a legacy/foreign 'hidden' string is honoured as hidden even though we never store it.
  if (essPlacement === 'hidden') return 'hidden';
  return defaultPlacementFor(code, role);
}

/** The labelled Secondary group a type belongs to (only meaningful when its placement is 'secondary'). */
export function resolveSecondaryGroup(code: string | null | undefined): SecondaryGroup {
  const c = (code ?? '').toUpperCase();
  return SECONDARY_GROUP_BY_CODE[c] ?? 'other';
}

// ── SHARED LEAVE GROUPS on the employee Leave tab (feedback 46afcc48) ──────────────────────────────
//
// A SHARED LEAVE GROUP (leave_shared_group, r88) is several leave types drawing on one pooled annual
// allowance — "Special Leave: 10 days shared between six types, at most 3 in one application". Until
// 46afcc48 the group was ENFORCEMENT ONLY: it refused applications past its ceiling and appeared on no
// employee screen at all. This block is the display half, and it is display ONLY — nothing here is ever
// consulted by enforceSharedLeaveGroupLimit / enforceApplicationLengthLimit (core/leave.ts).
//
// THE GROUP'S PLACEMENT IS INDEPENDENT OF ITS MEMBERS' PLACEMENTS, in both directions. A group placed
// Primary shows as one balance at the top whether its six member types are Primary, Secondary or Hidden;
// and hiding every member changes neither the group's figure nor what the employee may apply for. That
// independence is the reporter's explicit ask (revision 2, after they contested a revision-1 plan that
// had the group fold its members in) and it is pinned by a test.

/** A shared group's placement DEFAULT. Hidden, so an existing group is drawn nowhere until HR chooses —
 *  a new balance must never appear on every employee's screen because a release happened. Mirrors the
 *  NOT NULL DEFAULT on leave_shared_group.ess_placement (migration 0438). */
export const SHARED_GROUP_DEFAULT_PLACEMENT: EssPlacement = 'hidden';

/**
 * Resolve a shared group's stored placement.
 *
 * UNLIKE a leave type, ALL THREE values are storable for a group: a type expresses Hidden through the
 * single visible_to_employee switch it already owns (7b11f1c1), while a group has no such flag, so its
 * placement column is the one source of truth for hidden. There is therefore no code-keyed default map
 * and no flag to consult — an unreadable/absent value simply falls back to Hidden, the safe direction.
 */
export function resolveSharedGroupPlacement(value: string | null | undefined): EssPlacement {
  return (ESS_PLACEMENTS as readonly string[]).includes(value ?? '')
    ? (value as EssPlacement)
    : SHARED_GROUP_DEFAULT_PLACEMENT;
}

/**
 * THE CYCLE a shared group's usage is summed over: the CALENDAR YEAR of the application's start date.
 *
 * Stated once, here, because TWO callers need the identical window and a second spelling of it is how the
 * number the employee reads stops matching the verdict the engine gives:
 *   - `enforceSharedLeaveGroupLimit` (core/leave.ts) — the refusal, unchanged in behaviour;
 *   - `sharedLeaveGroupBalances` (core/leave-shared-group.ts) — the figure drawn on the Leave tab.
 * The calendar keying mirrors leave_year_config and is the window the group has enforced since 4c48fd1f;
 * this extraction does not change it.
 */
export function sharedGroupCycleWindow(startDate: string): { start: string; end: string } {
  const year = startDate.slice(0, 4);
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * WHAT A SHARED GROUP HAS LEFT, as the employee should read it.
 *
 * ⚠️ THIS IS NOT THE CEILING, AND DRAWING THE CEILING WOULD BE A PROMISE THE SYSTEM THEN REFUSES.
 * A group's `total_limit_days` caps what may be TAKEN across its member types; it never GRANTS anything.
 * The days themselves come from each member type's own entitlement. So two independent limits apply and
 * the employee can only draw the SMALLER:
 *
 *   1. what is left under the shared ceiling — `totalLimitDays - usedDays`, where `usedDays` is the same
 *      pending+approved sum across every member type that `enforceSharedLeaveGroupLimit` measures;
 *   2. what the member types between them actually still hold — the sum of their Available figures.
 *
 * Measured on production 2026-08-13: "Special Leave" has a 10.00 ceiling, but for at least one employee
 * the six member types carry only 9.00 between them. Showing 10.00 would invite an application the group
 * guard refuses. Showing 9.00 is the honest number, and it is the one the approved plan promises.
 *
 * NEITHER TERM IS CLAMPED AT ZERO. A member type can legitimately sit below zero (a pending request
 * against no balance), and the per-type cards on the same screen already print that negative figure via
 * deriveBalanceRow. Clamping only the pooled figure would make the group disagree with the rows it is
 * pooling. `usedDays` is likewise not clamped — it cannot exceed the ceiling in practice, because the
 * guard refuses the application that would take it there.
 */
export function sharedGroupAvailableDays(p: {
  totalLimitDays: number;
  /** Pending + approved days across ALL member types in the cycle — never filtered by visibility. */
  usedDays: number;
  /** Sum of the member types' Available figures — likewise never filtered by visibility. */
  memberAvailableSum: number;
}): number {
  const underCeiling = round2(p.totalLimitDays - p.usedDays);
  return Math.min(underCeiling, round2(p.memberAvailableSum));
}
