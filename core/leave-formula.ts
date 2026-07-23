// Leave Entitlement Formula Management (feedback 79011509), consolidated into the Employee Leave View
// Configuration (feedback 2bc2f2a3).
//
// The CLOSED allow-list of leave-view COMPONENTS an HR admin can annotate, per leave type, with a
// plain-language description + a free-text "formula explanation" (and an optional result/date note). Stored on
// leave_type.formula_explanations (JSONB, migration 0241) as { componentKey: { description?, formula?, result? } }.
//
// This adds an EXPLANATION layer only — it never changes how any entitlement number is calculated. The key set
// started as the seven §7 "Entitlement Calculation Breakdown" field keys (entitlement-panel-config.ts
// calcBreakdown); 2bc2f2a3 WIDENED it to also accept every ess-view component key (core/ess-view.ts), so the
// merged view-configuration screen can annotate ANY configurable item (Leave Summary, Utilization, Adjustments,
// …), not only the calculation rows. The seven legacy keys read/write identically — existing stored content
// survives verbatim. The employee panel looks an explanation up by a row's field key: for §7 rows that is the
// legacy component key; for the other sections it is the matching ess-view key. A missing key — or a null
// column — ⇒ no explanation (the info icon is hidden for that row; see feedback b8b665ff).
//
// Single source of truth shared by: the validation/normalisation in core/admin.ts updateLeaveType, the merged
// admin editor in components/leave-type-panel.tsx, the read path in core/read.ts (leaveEntitlementBreakdown),
// and the per-row hover info icons in components/leave/LeaveDetailsPanel.tsx.

import { ESS_VIEW_COMPONENT_KEYS, type EssViewComponentKey } from './ess-view';

/**
 * The seven LEGACY component keys (the §7 calcBreakdown field keys). Order here drives the admin editor's
 * calc-breakdown block order and matches the §7 field keys so the employee panel resolves an explanation by
 * field key. i18n labels live under `admin.leave.formula.component.<key>`.
 */
export const LEAVE_FORMULA_COMPONENT_KEYS = [
  'currentYearEntitlement',
  'monthlyAccrued',
  'carriedForward',
  'carryForwardRemaining',
  'carryForwardExpiry',
  'forfeited',
  'totalAvailable',
] as const;

export type LeaveFormulaComponentKey = (typeof LEAVE_FORMULA_COMPONENT_KEYS)[number];

/** Every key an explanation may be stored under: the 7 legacy §7 component keys ∪ the ess-view keys
 *  (2bc2f2a3 widening — `carryForwardExpiry` / `forfeited` appear in both lists and stay ONE key). */
export type LeaveExplanationKey = LeaveFormulaComponentKey | EssViewComponentKey;

const LEGACY_KEY_SET: ReadonlySet<string> = new Set(LEAVE_FORMULA_COMPONENT_KEYS);

/** The widened closed allow-list, legacy keys first (deduplicated against the ess-view list). */
export const LEAVE_EXPLANATION_KEYS: readonly LeaveExplanationKey[] = [
  ...LEAVE_FORMULA_COMPONENT_KEYS,
  ...ESS_VIEW_COMPONENT_KEYS.filter((k) => !LEGACY_KEY_SET.has(k)),
];

/** One component's HR-authored explanation. Every field is optional free text; an all-empty entry is dropped. */
export type LeaveFormulaEntry = {
  description?: string;
  formula?: string;
  /** Optional short result / date note (the reporter's "optional result/date free-text"). */
  result?: string;
};

/** As stored on leave_type.formula_explanations — a partial map (missing key ⇒ no explanation). */
export type LeaveFormulaConfig = Partial<Record<LeaveExplanationKey, LeaveFormulaEntry>>;

/** As threaded to render sites — every key resolved (missing / all-empty ⇒ null = no explanation). */
export type ResolvedLeaveFormula = Record<LeaveExplanationKey, LeaveFormulaEntry | null>;

const KEY_SET: ReadonlySet<string> = new Set(LEAVE_EXPLANATION_KEYS);

/** Per-field character cap (defence-in-depth behind the textareas; the service enforces it). */
export const LEAVE_FORMULA_TEXT_MAX = 2000;

/** True when `k` is a known explanation key — legacy component key OR ess-view key (used to reject unknown
 *  keys on write; 2bc2f2a3 widened the accepted set from the 7 legacy keys). */
export function isLeaveExplanationKey(k: string): k is LeaveExplanationKey {
  return KEY_SET.has(k);
}

/**
 * Validate + normalise a caller-supplied config: reject unknown keys, trim every field, drop blank fields, and
 * drop an entry whose fields are all blank. Returns null when nothing meaningful remains (⇒ clear the column,
 * so the default "no explanation" path stays clean). Throws on an over-long field or an unknown key.
 */
export function normalizeLeaveFormulaConfig(input: LeaveFormulaConfig): LeaveFormulaConfig | null {
  const out: LeaveFormulaConfig = {};
  for (const key of Object.keys(input)) {
    if (!isLeaveExplanationKey(key)) {
      throw new Error(`Unknown leave-formula component key: ${key}.`);
    }
    const raw = input[key] ?? {};
    const entry: LeaveFormulaEntry = {};
    for (const field of ['description', 'formula', 'result'] as const) {
      const trimmed = (raw[field] ?? '').trim();
      if (trimmed.length > LEAVE_FORMULA_TEXT_MAX) {
        throw new Error(`Leave-formula ${field} is too long (max ${LEAVE_FORMULA_TEXT_MAX} characters).`);
      }
      if (trimmed.length > 0) entry[field] = trimmed;
    }
    if (Object.keys(entry).length > 0) out[key] = entry;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Resolve a stored (possibly null / partial) config into an explicit per-key map. A missing key — or a null
 * config — resolves to `null` (no explanation). Unknown keys in the stored blob are ignored (reads never throw
 * on legacy data; writes are validated up front).
 */
export function resolveLeaveFormula(config: Record<string, LeaveFormulaEntry> | null | undefined): ResolvedLeaveFormula {
  const out = {} as ResolvedLeaveFormula;
  for (const key of LEAVE_EXPLANATION_KEYS) {
    const v = config?.[key];
    out[key] = v && (v.description || v.formula || v.result) ? v : null;
  }
  return out;
}
