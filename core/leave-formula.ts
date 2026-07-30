// Leave Entitlement Formula Management (feedback 79011509), consolidated into the Employee Leave View
// Configuration (feedback 2bc2f2a3), and reduced to the redesigned Leave Summary by feedback ed17a4f9.
//
// The CLOSED allow-list of leave-summary ITEMS an HR admin can annotate, per leave type, with a plain-language
// Description and a free-text Formula Explanation. Stored on leave_type.formula_explanations (JSONB, migration
// 0241) as { itemKey: { description?, formula? } }.
//
// This adds an EXPLANATION layer only — it never changes how any entitlement number is calculated.
//
// ed17a4f9 made the key set EXACTLY the ess-view key set, and that identity is the point of the item. Before,
// three key sets coexisted: seven legacy "§7 calculation" component keys, the ess-view keys, and the union of
// the two. HR could therefore write an explanation for a row the employee no longer saw, and the configuration
// screen listed items the summary did not render — the reporter's complaint, stated exactly. Now there is one
// list, in the summary's own order, and the two-way property (every configurable item is a summary row, every
// summary row is configurable) is pinned by test.
//
// The seven legacy keys (currentYearEntitlement, monthlyAccrued, carriedForward, carryForwardRemaining,
// carryForwardExpiry, forfeited, totalAvailable) are GONE with the Entitlement Calculation Breakdown section
// they annotated (1f6fd6d8 removed it from the employee panel). `forfeited` and `carryForwardExpiry` were
// shared with the ess-view list; `forfeited` survives as a summary item, `carryForwardExpiry` does not — the
// expiry date is now a sub-line on Brought Forward Forfeited and is explained by that item's text. Stored
// content under a removed key is IGNORED on read (resolveLeaveFormula skips unknown keys) and simply stops
// being posted by the admin form; it is not migrated onto a different row, because silently reassigning
// wording HR wrote about one figure to a different figure would be worse than losing the offer to edit it.
//
// The `result` field ("Result / Date (optional)") is removed in the same change at the reporter's explicit
// request: every item now carries Description and Formula Explanation only.
//
// Single source of truth shared by: the validation/normalisation in core/admin.ts updateLeaveType, the admin
// editor in components/leave-type-panel.tsx, the read path in core/read.ts (leaveEntitlementBreakdown), and
// the per-row hover info icons in components/leave/LeaveDetailsPanel.tsx.

import { ESS_VIEW_COMPONENT_KEYS, type EssViewComponentKey } from './ess-view';

/** Every key an explanation may be stored under — the Leave Summary items, in the summary's display order.
 *  i18n labels live under `admin.leave.essView.<key>` (the checklist's own labels), so an item can never be
 *  named one thing in the configuration and another on the summary. */
export const LEAVE_EXPLANATION_KEYS: readonly EssViewComponentKey[] = ESS_VIEW_COMPONENT_KEYS;

export type LeaveExplanationKey = EssViewComponentKey;

/** One item's HR-authored explanation. Both fields are optional free text; an all-empty entry is dropped. */
export type LeaveFormulaEntry = {
  description?: string;
  /** The reporter's "Formula Explanation" — how this line is worked out, in words. */
  formula?: string;
};

/** The two editable fields of an entry, in the order the admin form renders them. */
export const LEAVE_FORMULA_FIELDS = ['description', 'formula'] as const;

/** As stored on leave_type.formula_explanations — a partial map (missing key ⇒ no explanation). */
export type LeaveFormulaConfig = Partial<Record<LeaveExplanationKey, LeaveFormulaEntry>>;

/** As threaded to render sites — every key resolved (missing / all-empty ⇒ null = no explanation). */
export type ResolvedLeaveFormula = Record<LeaveExplanationKey, LeaveFormulaEntry | null>;

const KEY_SET: ReadonlySet<string> = new Set(LEAVE_EXPLANATION_KEYS);

/** Per-field character cap (defence-in-depth behind the textareas; the service enforces it). */
export const LEAVE_FORMULA_TEXT_MAX = 2000;

/** True when `k` is a known Leave Summary item key (used to reject unknown keys on write). */
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
    for (const field of LEAVE_FORMULA_FIELDS) {
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
 * on legacy data; writes are validated up front), which is what makes ed17a4f9's key-set reduction safe for
 * every tenant that had already written explanations under the retired keys.
 */
export function resolveLeaveFormula(config: Record<string, LeaveFormulaEntry> | null | undefined): ResolvedLeaveFormula {
  const out = {} as ResolvedLeaveFormula;
  for (const key of LEAVE_EXPLANATION_KEYS) {
    const v = config?.[key];
    out[key] = v && (v.description || v.formula) ? v : null;
  }
  return out;
}

/**
 * Smart content reuse (ed17a4f9 §4) — the explanation wording a NOT-YET-CONFIGURED leave type should be
 * PRE-FILLED with, taken from the first leave type that already has a saved configuration.
 *
 * The reporter's problem is concrete: a tenant with 30–60 leave types has HR retyping the same nine
 * descriptions for each one. Their stated rule is that the first configured leave type acts as the template.
 *
 * Three properties of this function are load-bearing and all three are the reporter's own words:
 *   • It is a READ-SIDE default only. Nothing is written. The values arrive as form defaults, HR reviews and
 *     edits them, and they persist only when Save is pressed — leaving the page stores nothing. That is why
 *     this is a pure function and not a backfill: a backfill would COPY one type's wording onto every other
 *     type in the database, which is precisely the "do not overwrite" rule inverted.
 *   • It never overwrites. `existing` non-empty ⇒ return it untouched, so a type that already carries its own
 *     wording keeps it exactly.
 *   • It is per-ITEM, not all-or-nothing. A type configured for some items and not others gets its own text
 *     for the items it has and the template's for the rest, so partially-configured types are completed
 *     rather than left half-done.
 *
 * `candidates` is every leave type's stored config; the FIRST one carrying any content wins, so the caller
 * controls "first" by the order it passes them (the admin list is alphabetical by display name).
 */
export function leaveFormulaTemplateFrom(
  candidates: readonly (Record<string, LeaveFormulaEntry> | null | undefined)[],
): LeaveFormulaConfig | null {
  // Trim before deciding. `normalizeLeaveFormulaConfig` already trims on WRITE, so a whitespace-only value
  // should not exist — but a seed, a hand-written row or a pre-normalisation record can carry one, and a
  // blank-looking template is the worst possible default: it would pre-fill every other leave type with
  // spaces that read as "already written" and suppress the real wording. Cheap to be defensive; the price of
  // being wrong is silent.
  const trimmedEntry = (e: LeaveFormulaEntry | null): LeaveFormulaEntry | null => {
    if (!e) return null;
    const out: LeaveFormulaEntry = {};
    for (const f of LEAVE_FORMULA_FIELDS) {
      const v = (e[f] ?? '').trim();
      if (v) out[f] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  };
  for (const c of candidates) {
    const resolved = resolveLeaveFormula(c);
    const out: LeaveFormulaConfig = {};
    for (const k of LEAVE_EXPLANATION_KEYS) {
      const v = trimmedEntry(resolved[k]);
      if (v) out[k] = v;
    }
    if (Object.keys(out).length > 0) return out;
  }
  return null;
}

/** Apply the template to one leave type's stored config: per item, keep what exists, fill in what does not.
 *  Returns the map the admin form should render as its default values. */
export function applyLeaveFormulaTemplate(
  existing: Record<string, LeaveFormulaEntry> | null | undefined,
  template: LeaveFormulaConfig | null,
): ResolvedLeaveFormula {
  const own = resolveLeaveFormula(existing);
  if (!template) return own;
  const out = {} as ResolvedLeaveFormula;
  for (const key of LEAVE_EXPLANATION_KEYS) {
    out[key] = own[key] ?? template[key] ?? null;
  }
  return out;
}
