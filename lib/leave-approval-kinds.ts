/**
 * r293 — THE APPROVER VOCABULARY, in a CLIENT-SAFE leaf.
 *
 * These constants were born in `core/leave-approval-policy.ts` and still read as if they live there: that
 * module re-exports every symbol below, so no existing import changed and the kernel remains their public
 * server-side door. They moved because the Approval Workflow BUILDER is a 'use client' component and needs
 * the same vocabulary the engine routes on — and `core/leave-approval-policy.ts` imports `db/client`,
 * `db/events` and `db/schema`, so importing it from a client component would drag the database kernel into
 * the browser bundle. The alternative, a second hand-maintained list inside the editor, is what this file
 * exists to delete: `app/admin/leave-approval/step-list-editor.tsx` carried exactly such a copy, and
 * nothing failed when the two disagreed — a kind the engine accepts but the picker never offers is
 * invisible until somebody hand-writes a template row.
 *
 * Same pattern as `lib/completed-years.ts` and `lib/payroll-permissions.ts`: pure data and pure functions,
 * no I/O, no imports.
 */

// 6fadb036 (R17 gap-close) — the reporter's full approver-step vocabulary (list C). Ordered as the
// request lists them; `hr_admin` is the internal id for the "HR" label. Each kind has a concrete
// decision-time resolver in core/leave.ts (assertCanDecideLeaveStep) and a generation-time drop rule:
//   direct_manager      → the subject's active administrative manager         (dropped when none)
//   manager_manager     → a SECOND hop up the same administrative line: the direct manager's own
//                         manager. r293 phase 2. Dropped when either hop is missing, and also when the
//                         second hop resolves back to the subject (a two-person reporting cycle would
//                         otherwise route a request to the person who raised it)                   (dropped when none)
//   department_head     → department.head_employment_id of the subject's dept (dropped when unset)
//   business_unit_head  → business_unit.head_employment_id of the subject's BU (dropped when unset)
//   hr_admin ("HR")     → hr_admin / super_admin role                          (never dropped)
//   hr_manager          → HR-tier authority (hr_admin / super_admin) — a distinct gate; a ranked
//                         hr_manager sub-role is a documented follow-up (ADR-0071 §i)                (never dropped)
//   payroll             → payroll_partner (subject's company) / super_admin    (never dropped)
//   custom_role         → an admin gate (hr_admin / super_admin); binding a specific named role per
//                         step is a documented follow-up (ADR-0071 §i custom_position guard)         (never dropped)
//   specific_employee   → a NAMED PERSON, stored as an employment id ON THE LEVEL. r293 phase 3, and the
//                         only FIXED kind: it resolves nothing, follows nothing, and can never be
//                         dropped. See FIXED_LEVEL_KINDS for why that asymmetry is the whole item's risk.
//                                                                                                    (never dropped)
export const LEVEL_KINDS = [
  'direct_manager',
  'manager_manager',
  'department_head',
  'business_unit_head',
  'hr_admin',
  'hr_manager',
  'payroll',
  'custom_role',
  'specific_employee',
] as const;
export type LeaveLevelKind = (typeof LEVEL_KINDS)[number];

/** Kinds that route to an org-chart HEAD (department / business unit). A step of these kinds is generated
 *  only when the subject's dept/BU actually has a head set — otherwise dropped (no dead step). */
export const HEAD_LEVEL_KINDS: readonly LeaveLevelKind[] = ['department_head', 'business_unit_head'];

/**
 * r293 — DYNAMIC vs FIXED, the distinction the builder puts a badge on.
 *
 * A DYNAMIC kind names a RELATIONSHIP that core/leave.ts resolves at step-generation time against the org
 * chart as it stands that moment: change an employee's manager or department and the chain follows without
 * anyone editing the template. A FIXED kind names a PERSON (an employment id stored on the level itself)
 * and follows nothing.
 *
 * That asymmetry is not cosmetic, and it is the reason the badge exists: a dynamic level that resolves to
 * nobody is DROPPED (see DROPPABLE_LEVEL_KINDS) and the request carries on down the chain, whereas a fixed
 * level has nothing to resolve and so can never be dropped — if the named person leaves, every request at
 * that level stalls until a human edits the template.
 *
 * `specific_employee` (r293 phase 3) is the only member and every other kind is dynamic;
 * `test/r293-approval-builder.test.ts` pins BOTH arms of that, so a kind added without wiring the badge,
 * the drop rule and the departed-approver warning fails rather than passing silently.
 */
export const FIXED_LEVEL_KINDS: readonly LeaveLevelKind[] = ['specific_employee'];

/** True when the kind names a specific PERSON rather than a relationship. The single owner of the
 *  Dynamic/Fixed classification — the builder badge, the preview and the drop rule all read this. */
export function isFixedLevelKind(kind: string): boolean {
  return (FIXED_LEVEL_KINDS as readonly string[]).includes(kind);
}

/**
 * r293 — the kinds whose step is DROPPED when the subject has nobody in that relationship.
 *
 * This set was previously spelled out only inside `generateApprovalSteps`'s filter in core/leave.ts, so the
 * builder had no way to tell the administrator which levels can be skipped and which always run — and r285
 * is what that costs: `department_head` and `business_unit_head` silently skipped for every request on the
 * customer's tenant because no department or BU had a head set, and no screen said so. Naming the set here
 * gives the filter and the UI one owner; `test/r293-approval-builder.test.ts` pins that this set is exactly
 * the set `applyChainDropRules` can drop, across both files.
 *
 * Role-based kinds (hr_admin / hr_manager / payroll / custom_role) are NEVER dropped: they resolve to role
 * authority at decision time, and an HR admin can clear any step, so they always have a decider.
 */
export const DROPPABLE_LEVEL_KINDS: readonly LeaveLevelKind[] = [
  'direct_manager',
  // r293 phase 2 — a second hop that does not exist is dropped for the same reason the first one is:
  // a step nobody can clear stalls the request forever.
  'manager_manager',
  ...HEAD_LEVEL_KINDS,
];

/** True when a level of this kind is skipped (rather than stalling) when it resolves to nobody. */
export function isDroppableLevelKind(kind: string): boolean {
  return (DROPPABLE_LEVEL_KINDS as readonly string[]).includes(kind);
}


/**
 * r293 phase 3 — ONE LEVEL OF A CHAIN, and the shape the jsonb column has always been able to hold.
 *
 * Every kind before `specific_employee` resolves a RELATIONSHIP at step-generation time and needs nothing
 * stored beyond its name, which is why a level was a bare string for three years. A fixed approver has no
 * relationship to resolve, so the person has to be written down: `employmentId` is that, and it is
 * non-null for exactly the fixed kinds.
 *
 * ⚠️ THE STORED SHAPE OF AN EXISTING TEMPLATE IS UNCHANGED. `serializeApprovalLevels` writes a dynamic
 * level back as a plain string and only a fixed level as an object, so every row written before r293 round
 * -trips byte-identically, every reader that only wants kinds keeps working through `sanitizeLevels`, and
 * NO MIGRATION IS NEEDED FOR THE TEMPLATE. (A migration IS needed for the generated STEP, which had
 * nowhere to record which person a fixed step belongs to — see 0467.)
 */
export type ApprovalApprover = {
  kind: LeaveLevelKind;
  /** The named approver's employment id — non-null exactly when `kind` is a FIXED kind. */
  employmentId: string | null;
};

export type ApprovalLevel = ApprovalApprover & {
  /**
   * r293 phase 4 — ANY-ONE APPROVAL. Additional approvers for THIS level, any ONE of whom may clear it
   * (the reporter's "Sarah OR Ahmad at level 2"). Empty on every level that has ever existed, and empty
   * is the sequential behaviour byte-for-byte: one approver, who must approve.
   *
   * ⚠️ THERE IS NO STORED "MODE", AND THAT IS DELIBERATE — r79 0322's lesson, in this same file's
   * neighbourhood. The per-company "Require multi-step approval" switch was deleted because the chain's
   * own LENGTH already answered it and a flag that could disagree with the chain beside it was the whole
   * defect. A template-level `mode: sequential | any_one` is the same shape of mistake: it could say
   * "any one" over levels that hold a single approver, or "sequential" over levels that hold three. The
   * ALTERNATES ARE THE ANSWER — a level with alternates is an any-one level, and a level without one is
   * not. The screen still shows the reporter the two-way choice they asked for; it derives it from the
   * levels, exactly as the multi-step checkbox now derives from the chain's length.
   */
  alternates: ApprovalApprover[];
};

/** Every approver who may clear a level, primary first. One entry unless the level is any-one. */
export function approversOf(level: ApprovalLevel): ApprovalApprover[] {
  return [{ kind: level.kind, employmentId: level.employmentId }, ...level.alternates];
}

/** True when any ONE of several approvers is enough for this level. */
export function isAnyOneLevel(level: ApprovalLevel): boolean {
  return level.alternates.length > 0;
}

/**
 * Read a stored `levels` jsonb (or a posted form value) into levels the engine can route on.
 *
 * Tolerant in one direction only. An unknown kind is dropped, as it always was. A FIXED level with no
 * employment id is ALSO dropped rather than kept as a half-level: a named-person step with nobody named
 * cannot be resolved, cannot be decided and cannot be dropped at generation time, so it would be a
 * permanent stall written by a save that looked like it worked. A dynamic level carrying a stray
 * employment id has it cleared — the id would be unreachable and a later reader might believe it.
 */
export function sanitizeApprovalLevels(raw: unknown): ApprovalLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: ApprovalLevel[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const a = sanitizeApprover(entry);
      if (a) out.push({ ...a, alternates: [] });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const primary = sanitizeApprover(entry);
      if (!primary) continue;
      const rawAlt = (entry as { alternates?: unknown }).alternates;
      // r293 phase 4 — an alternate is an approver by the SAME rules as the primary (unknown kinds and
      // named-nobody levels are dropped), and DE-DUPLICATED against the primary and each other: the same
      // person twice is not a choice, and "any one of [Sarah, Sarah]" would read as a two-approver level
      // on every screen that counts them.
      const alternates: ApprovalApprover[] = [];
      if (Array.isArray(rawAlt)) {
        const seen = new Set([approverKey(primary)]);
        for (const raw of rawAlt) {
          const a = sanitizeApprover(raw);
          if (!a) continue;
          const key = approverKey(a);
          if (seen.has(key)) continue;
          seen.add(key);
          alternates.push(a);
        }
      }
      out.push({ ...primary, alternates });
    }
  }
  return out;
}

/** One approver, from a bare kind string or a `{ kind, employmentId }` object. Null when unusable. */
function sanitizeApprover(entry: unknown): ApprovalApprover | null {
  if (typeof entry === 'string') {
    if (!(LEVEL_KINDS as readonly string[]).includes(entry) || isFixedLevelKind(entry)) return null;
    return { kind: entry as LeaveLevelKind, employmentId: null };
  }
  if (!entry || typeof entry !== 'object') return null;
  const kind = (entry as { kind?: unknown }).kind;
  const employmentId = (entry as { employmentId?: unknown }).employmentId;
  if (typeof kind !== 'string' || !(LEVEL_KINDS as readonly string[]).includes(kind)) return null;
  if (isFixedLevelKind(kind)) {
    if (typeof employmentId !== 'string' || employmentId.trim() === '') return null;
    return { kind: kind as LeaveLevelKind, employmentId: employmentId.trim() };
  }
  return { kind: kind as LeaveLevelKind, employmentId: null };
}

/** An approver's identity — the key both de-duplication and chain comparison are built on. */
export function approverKey(a: ApprovalApprover): string {
  return a.employmentId ? `${a.kind}:${a.employmentId}` : a.kind;
}

/** The value to store in the jsonb column. Dynamic levels stay bare strings so pre-r293 rows round-trip
 *  byte-identically and no migration is needed for the template itself. */
export function serializeApprovalLevels(levels: readonly ApprovalLevel[]): unknown[] {
  return levels.map((l) => {
    // Still a bare STRING for the plain, single, relationship-resolved level — which is every level in
    // every template written before r293 — so those rows round-trip byte-identically and neither phase
    // needed a migration on the template.
    if (!l.employmentId && l.alternates.length === 0) return l.kind;
    const base: Record<string, unknown> = { kind: l.kind, employmentId: l.employmentId };
    if (l.alternates.length) {
      base.alternates = l.alternates.map((a) => (a.employmentId ? { kind: a.kind, employmentId: a.employmentId } : a.kind));
    }
    return base;
  });
}

/** A level's full IDENTITY, for comparing two chains. Two `specific_employee` levels naming different
 *  people are DIFFERENT chains, which `sanitizeLevels`'s kinds-only view cannot see — and
 *  core/leave-approval-consolidation.ts reuses an existing template when two chains look equal. */
export function levelKey(level: ApprovalLevel): string {
  // r293 phase 4 — the alternates are part of the identity: "Direct manager" and "Direct manager OR
  // Sarah" are different levels, and a comparison that could not tell them apart would let
  // core/leave-approval-consolidation.ts reuse one template for the other.
  return approversOf(level).map(approverKey).join('|');
}

/** The kind sequence alone — every reader that routes on WHO APPROVES rather than on WHICH PERSON.
 *  Deliberately a projection of `sanitizeApprovalLevels` and not a second parse of the same jsonb. */
export function sanitizeLevels(raw: unknown): LeaveLevelKind[] {
  return sanitizeApprovalLevels(raw).map((l) => l.kind);
}
