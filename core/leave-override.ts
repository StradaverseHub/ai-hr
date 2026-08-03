/**
 * Override Leave Application (feedback 56910869) — the RULE VOCABULARY.
 *
 * THE ONE PLACE HR CONFIGURES WHAT THE SYSTEM DOES WHEN A LEAVE RULE IS NOT MET. Until this item every
 * such answer was hard-coded: an application that missed the notice period was refused, and an application
 * the balance could not cover was refused (or, if `allow_unpaid_leave` happened to be on, silently split).
 * Neither answer was HR's to change, and the two absorbed items (65f466e2 "short notice becomes Emergency"
 * and fef49b9a "insufficient balance splits into Unpaid") each asked for exactly one of them to change in
 * one fixed way. Building them as branches would have meant taking both apart again the moment a third
 * exception arrived, so they ship as the FIRST TWO RULES of this engine instead.
 *
 * ## The shape, and why it is a (trigger, action) PAIR rather than a mode per rule
 *
 * A rule is `{ trigger, action, enabled }`. The trigger is the condition the engine already detects and
 * already throws on; the action is what happens instead of the throw. Splitting the two is what lets ONE
 * leave type carry SEVERAL rules — the reporter's own example is Annual Leave that BOTH converts on short
 * notice AND splits on insufficient balance — without either rule knowing the other exists. A single
 * "override mode" column could only ever have expressed one exception per type.
 *
 * `enabled` is stored per rule rather than inferred from presence, so HR can switch a rule off and keep its
 * configuration. EVERY RULE SHIPS OFF: an unconfigured type has a NULL column, a configured-but-off rule
 * changes nothing, and `resolveLeaveOverrideRule` returns null for both. Nothing about any leave type moves
 * until somebody ticks a box — the r82 lesson (a silently-defaulted rule starts refusing real applications
 * the moment it deploys) applies with double force to a rule that CHANGES an application rather than
 * refusing it.
 *
 * ## BLOCK IS A FIRST-CLASS ACTION, NOT THE ABSENCE OF A RULE
 *
 * "Convert it to something else" is not always kinder than a clear refusal, and the two are different
 * facts. An enabled `block` rule says HR looked at this exception and chose to refuse it; no rule at all
 * says nobody has decided yet. They currently produce the same refusal, deliberately — the point is that
 * the screen can say which one it is, and that a future action (notify, escalate) has somewhere to attach.
 *
 * ## What is NOT here
 *
 * No database access, no `today`, no balance. This module is pure vocabulary + resolution so the client
 * panel, the write validator and the engine all read one definition of what a rule IS. WHEN a trigger
 * fires is the engine's business (core/leave.ts), because only the engine knows the dates, the balance and
 * the acting session.
 */

/** The conditions the engine can hand to an override rule. Each one is a place core/leave.ts ALREADY
 *  detects and throws — the rule replaces the throw, it never adds a new check.
 *   - `advance_notice_not_met`  → the LeaveAdvanceNoticeRequiredError site (65f466e2's trigger).
 *   - `insufficient_balance`    → the submit-time balance guard (fef49b9a's trigger). */
export const LEAVE_OVERRIDE_TRIGGERS = ['advance_notice_not_met', 'insufficient_balance'] as const;
export type LeaveOverrideTrigger = (typeof LEAVE_OVERRIDE_TRIGGERS)[number];

/** What happens instead of the refusal.
 *   - `convert_to_emergency` — the application is re-submitted as an Emergency Leave application. It is
 *     routed back through the ordinary engine, so the DEDUCTION SOURCE configured on Emergency Leave (the
 *     whole point of 65f466e2: Emergency is a CATEGORY, not an entitlement) resolves exactly as it does for
 *     a directly-filed Emergency application. No second deduction path is invented.
 *   - `split_unpaid`        — the part the balance cannot cover becomes unpaid days on the SAME single
 *     application, through the existing `leave_request.unpaid_days` measurement (a7fab30b). No second
 *     splitter is written.
 *   - `block`               — refuse, with today's error. */
export const LEAVE_OVERRIDE_ACTIONS = ['convert_to_emergency', 'split_unpaid', 'block'] as const;
export type LeaveOverrideAction = (typeof LEAVE_OVERRIDE_ACTIONS)[number];

/** Which actions each trigger admits. A pair outside this map is meaningless — "split the remainder into
 *  unpaid days because the notice period was missed" describes no arithmetic — so it is refused at the
 *  write boundary AND dropped on read, rather than being carried as configuration the engine ignores. */
export const LEAVE_OVERRIDE_ACTIONS_BY_TRIGGER: Record<LeaveOverrideTrigger, readonly LeaveOverrideAction[]> = {
  advance_notice_not_met: ['convert_to_emergency', 'block'],
  insufficient_balance: ['split_unpaid', 'block'],
};

/** One configured exception. Stored as an ordered array in `leave_type.override_rules` (JSONB). */
export type LeaveOverrideRule = {
  trigger: LeaveOverrideTrigger;
  action: LeaveOverrideAction;
  /** DEFAULT OFF. A rule that exists but is off is configuration, not behaviour. */
  enabled: boolean;
};

/** The actions that CHANGE an application rather than refusing it — and therefore require the employee's
 *  explicit confirmation before anything is submitted. `block` is absent on purpose: refusing needs no
 *  consent, and asking for one would be theatre. This set is the single definition the service gate, the
 *  preview and the form all read, so a new converting action cannot be added without landing here. */
const CONSENT_REQUIRING_ACTIONS: ReadonlySet<LeaveOverrideAction> = new Set<LeaveOverrideAction>([
  'convert_to_emergency',
  'split_unpaid',
]);

export function leaveOverrideNeedsConsent(action: LeaveOverrideAction): boolean {
  return CONSENT_REQUIRING_ACTIONS.has(action);
}

export function isLeaveOverrideTrigger(v: unknown): v is LeaveOverrideTrigger {
  return typeof v === 'string' && (LEAVE_OVERRIDE_TRIGGERS as readonly string[]).includes(v);
}

export function isLeaveOverrideAction(v: unknown): v is LeaveOverrideAction {
  return typeof v === 'string' && (LEAVE_OVERRIDE_ACTIONS as readonly string[]).includes(v);
}

/** At most one rule per (trigger, action) pair, which with the pair map above caps a type at four rules.
 *  The cap is not a storage worry — it is a guard against a write loop appending duplicates forever. */
export const LEAVE_OVERRIDE_RULES_MAX = 8;

/**
 * Read a stored `override_rules` value into rules the engine can act on.
 *
 * DEFENSIVE ON EVERY FIELD, and deliberately silent about what it drops. A JSONB column is writable by
 * hand, by a restore and by a future migration, and the failure mode of a half-understood rule is an
 * application that silently becomes something else. So anything that is not a recognised (trigger, action)
 * pair with a real boolean is simply NOT A RULE — which lands on the safe side, because absence means
 * "today's refusal", never "convert it".
 *
 * Duplicates are collapsed to the FIRST occurrence, so a hand-edited column carrying the same pair twice
 * cannot make resolution depend on which copy the reader happened to see.
 */
export function normalizeLeaveOverrideRules(v: unknown): LeaveOverrideRule[] {
  if (!Array.isArray(v)) return [];
  const out: LeaveOverrideRule[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (out.length >= LEAVE_OVERRIDE_RULES_MAX) break;
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (!isLeaveOverrideTrigger(r.trigger) || !isLeaveOverrideAction(r.action)) continue;
    if (!LEAVE_OVERRIDE_ACTIONS_BY_TRIGGER[r.trigger].includes(r.action)) continue;
    const key = `${r.trigger}:${r.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A non-boolean `enabled` reads as OFF. "Absent means on" is the one reading that could turn a rule
    // nobody configured into behaviour, so it is the one reading this must never take.
    out.push({ trigger: r.trigger, action: r.action, enabled: r.enabled === true });
  }
  return out;
}

/**
 * The ENABLED rule for a trigger, or null.
 *
 * FIRST ENABLED WINS, in stored order. Order is the HR-visible precedence: the panel writes the rules in
 * the order its rows appear, so "which one applies" is answerable by looking at the screen. A trigger with
 * two enabled actions is refused at the write boundary (`validateLeaveOverrideRules`) precisely so this
 * resolution is never the thing deciding — but it must still be TOTAL, because the column is hand-editable.
 */
export function resolveLeaveOverrideRule(
  rules: readonly LeaveOverrideRule[],
  trigger: LeaveOverrideTrigger,
): LeaveOverrideRule | null {
  return rules.find((r) => r.trigger === trigger && r.enabled) ?? null;
}

/** Any rule at all, enabled or not — the "is this type configured" question the admin screen asks. */
export function hasLeaveOverrideRules(rules: readonly LeaveOverrideRule[]): boolean {
  return rules.length > 0;
}

/** The token the employee's confirmation is expressed as, on the wire and in the audit stamp. A token
 *  names the EXACT rule consented to, so consent to a conversion can never be read as consent to a split
 *  (the failure the UnpaidConsentRequiredError precedent's single boolean would have had here, where two
 *  different rules can fire on one application). */
export function leaveOverrideConsentToken(trigger: LeaveOverrideTrigger, action: LeaveOverrideAction): string {
  return `${trigger}:${action}`;
}

/** Normalise whatever the action layer forwarded (one token, several, or nothing) into a token set. */
export function parseLeaveOverrideConsent(v: string | readonly string[] | null | undefined): Set<string> {
  if (v == null) return new Set();
  const parts = Array.isArray(v) ? v : String(v).split(',');
  return new Set(parts.map((s) => String(s).trim()).filter((s) => s !== ''));
}

/** Write-boundary validation. Returns the first problem, or null. Kept beside the vocabulary so the admin
 *  service and any future importer refuse the same shapes for the same reasons. */
export function validateLeaveOverrideRules(rules: readonly LeaveOverrideRule[]): string | null {
  if (rules.length > LEAVE_OVERRIDE_RULES_MAX) return 'Too many override rules.';
  const enabledByTrigger = new Map<LeaveOverrideTrigger, number>();
  for (const r of rules) {
    if (!LEAVE_OVERRIDE_ACTIONS_BY_TRIGGER[r.trigger]?.includes(r.action)) {
      return `Override action "${r.action}" is not available for trigger "${r.trigger}".`;
    }
    if (r.enabled) {
      const n = (enabledByTrigger.get(r.trigger) ?? 0) + 1;
      enabledByTrigger.set(r.trigger, n);
      // TWO ENABLED ACTIONS FOR ONE TRIGGER IS A CONTRADICTION, not a precedence question: "convert it"
      // and "refuse it" cannot both be what happens when the notice period is missed. Refused here so the
      // resolver above never has to pick, and so HR sees the contradiction at the moment they create it.
      if (n > 1) return `Only one action can be enabled for trigger "${r.trigger}".`;
    }
  }
  return null;
}
