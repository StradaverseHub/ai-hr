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
 * Resolve the effective placement of a leave type on the employee Leave tab.
 *
 * Precedence (single source of truth for hidden is the visible_to_employee flag):
 *   1. visibleToEmployee === false ⇒ 'hidden' (HR hid it via the shared switch; 7b11f1c1 also drops the row
 *      from leaveBalances, but we still resolve 'hidden' for any consumer that receives the flag directly).
 *   2. an explicit stored ess_placement ('primary' | 'secondary') ⇒ that value (HR's grouping choice wins).
 *   3. otherwise ⇒ the code-keyed default.
 *
 * @param code               the leave type's immutable code (e.g. 'ANNUAL')
 * @param essPlacement       leave_type.ess_placement ('primary' | 'secondary' | null); 'hidden' is never
 *                           stored but is tolerated defensively (treated as hidden).
 * @param visibleToEmployee  leave_type.visible_to_employee (null ⇒ visible; false ⇒ hidden)
 */
export function resolvePlacement(
  code: string | null | undefined,
  essPlacement: string | null | undefined,
  visibleToEmployee: boolean | null | undefined,
): EssPlacement {
  if (visibleToEmployee === false) return 'hidden';
  if (essPlacement === 'primary' || essPlacement === 'secondary') return essPlacement;
  // Defensive: a legacy/foreign 'hidden' string is honoured as hidden even though we never store it.
  if (essPlacement === 'hidden') return 'hidden';
  return defaultPlacementForCode(code);
}

/** The labelled Secondary group a type belongs to (only meaningful when its placement is 'secondary'). */
export function resolveSecondaryGroup(code: string | null | undefined): SecondaryGroup {
  const c = (code ?? '').toUpperCase();
  return SECONDARY_GROUP_BY_CODE[c] ?? 'other';
}
