'use server';

import { requireAdmin } from '@/lib/authz';
import { ENTITLEMENT_TEMPLATES, fail, failEntitlements, okEntitlements, okToast } from '@/app/admin/_redirects';
import { orgCriteriaFromFields, countOrgCriteriaTargets } from '@/core/org-criteria';
import {
  createEligibilityRule,
  createEntitlementTemplate,
  deleteEligibilityRule,
  deleteEntitlementTemplate,
  leaveTypeIdForRuleLineage,
  leaveTypeIdForTemplateLineage,
  reprojectEntitlementForLeaveTypeCohort,
  retireEligibilityRule,
  retireEntitlementTemplate,
  setLeaveTypeDefaultTemplate,
  updateEligibilityRule,
  updateEntitlementTemplate,
  type ServiceBand,
} from '@/packs/leave/service';
import type { SessionContext } from '@/db/client';

/**
 * 6e9a126e RELEASE TWO — the writes behind the Entitlement Tables + Employee Eligibility editor.
 *
 * The reporter's requested architecture is three layers and nothing else:
 *
 *     Leave Type  →  Entitlement Template  →  Employee Eligibility
 *
 * Step 1 (the named day table) and Step 2 (who gets it) are the two writes below. They land in RELEASE
 * TWO, not one: an editor that writes configuration no engine reads is worse than no editor, and until
 * this release nothing read either table.
 *
 * ⚠️ EVERY ACTION GOES THROUGH `requireAdmin()`, and the route is registered in lib/permissions.ts.
 * `test/function-access.test.ts` fails BOTH ways — a guarded page absent from REGISTERED_ROUTES, and a
 * registered route with no page on disk — so the registration is a guard, not paperwork.
 *
 * ⚠️ `redirect()` WORKS BY THROWING. Every success redirect below sits OUTSIDE the try/catch, or a
 * perfectly successful save is caught by the `catch (e)` meant for service errors and the operator lands
 * on `?error=NEXT_REDIRECT` over a row that was in fact written. 18103ba4 shipped exactly that defect on
 * the Adjustments screen; its header documents the cost.
 */

/** The bands the client editor posts as one JSON field (the existing band editors' own convention). */
function bandsFrom(fd: FormData): ServiceBand[] {
  const raw = String(fd.get('serviceBands') ?? '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A parse failure is a broken client, not a validation message the operator can act on — but it must
    // still read as a sentence rather than "Unexpected token < in JSON". `validateServiceBands` inside the
    // service will reject the empty array with the real message.
    parsed = [];
  }
  return Array.isArray(parsed) ? (parsed as ServiceBand[]) : [];
}

/**
 * ee6b7c69 — WHERE THIS SAVE CAME FROM, AND THEREFORE WHERE IT MUST RETURN TO.
 *
 * These eight actions now serve TWO mounts of the same block: the standalone Entitlement Tables screen and
 * the Entitlement step of a leave type on /admin/leave/entitlements. The embedded mount posts
 * `embeddedLeaveTypeId`; the standalone one does not. Without this the item's central promise breaks on
 * the very first save — HR types a table inside Annual Leave, presses Save, and is redirected onto the
 * separate screen the whole item exists to stop them needing. The anchor is what puts them back on the
 * SAME leave type: `LeaveTypeWorkspace` seeds its selection from items[0] and only then reads #type-<id>,
 * so a return without it lands on the first type alphabetically.
 *
 * The value is a leave type id interpolated into a fixed internal path fragment — never a caller-supplied
 * URL, so there is no redirect a hand-crafted post could open.
 */
function returnFor(fd: FormData): string {
  return String(fd.get('embeddedLeaveTypeId') ?? '').trim();
}

/** Success: back to the embedded step if that is where the form was, otherwise the standalone screen. */
function saved(fd: FormData, msg: string): never {
  const embedded = returnFor(fd);
  if (embedded) okEntitlements(msg, embedded);
  okToast(ENTITLEMENT_TEMPLATES, msg);
}

/** Failure: the same rule. A message about a form the operator can no longer see is not a message. */
function refused(fd: FormData, e: unknown): never {
  const embedded = returnFor(fd);
  if (embedded) failEntitlements(e, embedded);
  fail(ENTITLEMENT_TEMPLATES, e);
}

/**
 * Read the criteria the form posted through the SHARED reader.
 *
 * `orgCriteriaFromFields` is the same reader the Leave Adjustments screen and the Notice Board post
 * through. That is the whole point of this item: "Finance + Executive" must select the same people
 * wherever it is typed. A hand-rolled reader here would list the field names itself, and the axis somebody
 * forgot would post fine, resolve to nothing and narrow NOBODY — silently.
 *
 * ee6b7c69's `embeddedLeaveTypeId` is invisible to it for the same reason: the reader ASKS for the axes it
 * knows by name rather than sweeping the FormData, so a field that is not an axis cannot become one.
 */
function criteriaFrom(fd: FormData) {
  return orgCriteriaFromFields(
    (name) => fd.getAll(name).map(String),
    (name) => {
      const v = fd.get(name);
      return v == null ? null : String(v);
    },
  );
}

/**
 * r209 — RECALCULATE ON SAVE. The reporter's request, in one sentence: "saving an entitlement setup should
 * recalculate the affected employees' balances straight away, so you no longer have to remember to run
 * Generate Entitlement afterwards."
 *
 * ⚠️ THE TRIGGER WAS DOCUMENTED AND NEVER WIRED. `reprojectEntitlementForLeaveTypeCohort`'s own header in
 * core/leave.ts has said since release three that it fires "when an entitlement TEMPLATE or an ELIGIBILITY
 * RULE for the type is written" — and no call site existed. Only `setLeaveTypeRulesAction` called it, and
 * only when the earning-method marker was cleared. So a table typed today and a rule renewed today changed
 * nothing on anybody's balance until somebody thought to press a button on a different screen.
 *
 * FOUR PROPERTIES, EACH LOAD-BEARING:
 *
 *  1. AFTER THE WRITE TRANSACTION HAS COMMITTED, never inside it. Each per-employee recalc opens its OWN
 *     transaction and reads the COMMITTED configuration; calling it inside the write would have every
 *     employee reproject against the configuration the save just replaced. Every caller below awaits the
 *     service first and calls this second — the same ordering `setLeaveTypeRulesAction` is pinned on.
 *  2. BEST EFFORT. The configuration is saved and must stay saved. The recalc is idempotent and self-heals
 *     on the next trigger, so a failure here must not turn a successful save into an error banner. Same
 *     disposition as the leave-type cohort catch-up next door.
 *  3. BEFORE the redirect. `saved()` throws (that is how `redirect()` works), so anything after it is
 *     unreachable — and anything inside the service try/catch would be caught by the handler meant for
 *     validation errors.
 *  4. NO OPINION IS NOT ZERO. Retiring a table is a legitimate call here: the affected employees then
 *     resolve to nothing, `composeEntitlement` returns `noOpinion`, and the kernel posts a delta of exactly
 *     0 rather than clawing days back. That guard is why this can fire on a retire at all.
 *
 * BLAST RADIUS, stated plainly: this posts recalc rows for everyone the leave type reaches, at the moment
 * the table or rule is saved. That is the point — it is the moment balances are supposed to move.
 */
async function recomputeAfterSave(s: SessionContext, leaveTypeId: string | null, trigger: string) {
  if (!leaveTypeId) return;
  try {
    await reprojectEntitlementForLeaveTypeCohort(s, { leaveTypeId, trigger });
  } catch (e) {
    console.error(`entitlement recompute after ${trigger} failed for leave type ${leaveTypeId}:`, e);
  }
}

/**
 * 76ffdcf2 — NAME (or clear) THE DEFAULT ENTITLEMENT TABLE for this leave type.
 *
 * This is the write behind the reporter's central complaint. Until now an employee whom no benefit scheme
 * covered received NOTHING on a leave type with two or more tables, and the screens told them a scheme was
 * the reason they had no entitlement. The scheme never was the reason — but the outcome was real, and this
 * is what closes it: HR names one table as the fallback and nobody falls through.
 *
 * ⚠️ IT MOVES BALANCES, so it goes through `recomputeAfterSave` exactly as creating a rule does — same
 * ordering (after the write has committed), same best-effort disposition, same "no opinion is not zero"
 * guard on the CLEAR direction. Clearing the default puts the affected employees back to resolving
 * nothing, which `composeEntitlement` answers with a delta of exactly 0 rather than a clawback.
 *
 * An EMPTY posted value is a legitimate instruction — "no default" — not a missing field, and it is what
 * the picker's first option posts.
 */
export async function setLeaveTypeDefaultTemplateAction(formData: FormData) {
  const s = await requireAdmin();
  const leaveTypeId = String(formData.get('leaveTypeId') ?? '').trim();
  const templateLineageId = String(formData.get('defaultTemplateLineageId') ?? '').trim() || null;
  try {
    await setLeaveTypeDefaultTemplate(s, { leaveTypeId, templateLineageId });
  } catch (e) {
    refused(formData, e);
  }
  await recomputeAfterSave(s, leaveTypeId, 'leave_type_default_table');
  saved(formData, templateLineageId ? 'Saved default entitlement table' : 'Cleared default entitlement table');
}

export async function createEntitlementTemplateAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    await createEntitlementTemplate(s, {
      leaveTypeId: String(formData.get('leaveTypeId') ?? ''),
      name: String(formData.get('name') ?? ''),
      serviceBands: bandsFrom(formData),
      validFrom: String(formData.get('validFrom') ?? ''),
    });
  } catch (e) {
    refused(formData, e);
  }
  await recomputeAfterSave(s, String(formData.get('leaveTypeId') ?? ''), 'entitlement_template_created');
  saved(formData, `Saved ${String(formData.get('name') ?? '')}`);
}

/**
 * WHAT AN EDIT DOES IS DECIDED BY THE DATE IN THE BOX, not by this function — `entitlementEditMode()` in
 * `lib/entitlement-edit-mode.ts` is the one reader, and the screen's Save button labels itself from it:
 *
 *   · the date is unchanged, or the open version has not started yet ⇒ IN-PLACE UPDATE of that row,
 *     effective date included;
 *   · the version has been in force and the new date is LATER ⇒ supersede: close the open version at the
 *     new `validFrom` and insert a successor;
 *   · in force and the new date is EARLIER ⇒ refused, naming the earliest allowed date.
 *
 * ⚠️ CORRECTED (3a4efe9f, r369). This comment read "An edit CLOSES the running version and INSERTS a
 * successor, from `validFrom`. It is not an in-place UPDATE and the screen says so" — which r219 and r224
 * made untrue: in-place saving was built precisely because the supersede-always behaviour made every
 * ordinary correction mint a new version. The consequence the old sentence was reaching for is real and
 * still holds the other way round: an in-place save DOES reach backwards, and the three past-date readers —
 * the Carry Forward report, `expireCarriedLeave`'s year sweep, and the /me + admin balance breakdown — will
 * report different figures for a closed leave year afterwards. That is allowed and it is said out loud
 * before the save (`entitlementInPlaceChangesThePast` → `EntitlementSaveModeNote`), never silently.
 *
 * The LEAVE TYPE is not editable — see `updateEntitlementTemplate`'s own note. A rule pointing at "the
 * Executive ANNUAL table" that silently started handing out SICK days is not an edit anyone would spot.
 */
export async function updateEntitlementTemplateAction(formData: FormData) {
  const s = await requireAdmin();
  const lineageId = String(formData.get('lineageId') ?? '');
  try {
    await updateEntitlementTemplate(s, {
      lineageId,
      name: String(formData.get('name') ?? ''),
      serviceBands: bandsFrom(formData),
      validFrom: String(formData.get('validFrom') ?? ''),
    });
  } catch (e) {
    refused(formData, e);
  }
  await recomputeAfterSave(
    s,
    await leaveTypeIdForTemplateLineage(s, lineageId),
    'entitlement_template_updated',
  );
  saved(formData, `Saved ${String(formData.get('name') ?? '')}`);
}

/**
 * r210 — REMOVE A TABLE OUTRIGHT, every version of it, where nothing can be reached through it.
 *
 * ⚠️ THE LEAVE TYPE IS RESOLVED BEFORE THE DELETE, and that ordering is the whole reason this action is
 * not a copy of the retire one. `leaveTypeIdForTemplateLineage` reads the lineage's own rows; after a
 * successful delete there are none, so asking afterwards returns null and `recomputeAfterSave` silently
 * does nothing — a save that looks wired and recalculates nobody. The retire path can ask either side
 * because it only closes a row.
 *
 * The refusals (`deleteEntitlementTemplate`) are sentences an operator can act on, and `refused()` puts
 * them on the screen the delete was pressed from, where the Stop control they name sits on the same row.
 */
export async function deleteEntitlementTemplateAction(formData: FormData) {
  const s = await requireAdmin();
  const lineageId = String(formData.get('lineageId') ?? '');
  const leaveTypeId = await leaveTypeIdForTemplateLineage(s, lineageId);
  try {
    await deleteEntitlementTemplate(s, { lineageId });
  } catch (e) {
    refused(formData, e);
  }
  // A deleted table resolves to NO OPINION for the employees it reached, never to zero days — the kernel
  // posts a delta of 0 rather than clawing days back (see `recomputeAfterSave` note 4). This is also what
  // re-derives the health card: the table is gone from the next read, so it can no longer be reported as
  // a table without a rule.
  await recomputeAfterSave(s, leaveTypeId, 'entitlement_template_deleted');
  saved(formData, `Deleted ${String(formData.get('name') ?? '')}`);
}

/** Remove an eligibility rule outright. Same before-the-delete ordering, for the same reason: after the
 *  delete the rule's own rows are gone and its leave type can no longer be derived from them. */
export async function deleteEligibilityRuleAction(formData: FormData) {
  const s = await requireAdmin();
  const lineageId = String(formData.get('lineageId') ?? '');
  const leaveTypeId = await leaveTypeIdForRuleLineage(s, lineageId);
  try {
    await deleteEligibilityRule(s, { lineageId });
  } catch (e) {
    refused(formData, e);
  }
  await recomputeAfterSave(s, leaveTypeId, 'eligibility_rule_deleted');
  saved(formData, `Deleted ${String(formData.get('name') ?? '')}`);
}

/** Stop a table from a date — the reversible half. Delete is `deleteEntitlementTemplateAction` above and
 *  refuses wherever a dated reader could still reach this lineage; see `retireEntitlementTemplate`. */
export async function retireEntitlementTemplateAction(formData: FormData) {
  const s = await requireAdmin();
  const lineageId = String(formData.get('lineageId') ?? '');
  // Resolved BEFORE the retire only for symmetry of reading; the lineage's leave type is immutable, so the
  // answer is the same either side of the write.
  try {
    await retireEntitlementTemplate(s, {
      lineageId,
      validTo: String(formData.get('validTo') ?? ''),
    });
  } catch (e) {
    refused(formData, e);
  }
  await recomputeAfterSave(s, await leaveTypeIdForTemplateLineage(s, lineageId), 'entitlement_template_retired');
  saved(formData, `Stopped ${String(formData.get('name') ?? '')}`);
}

export async function createEligibilityRuleAction(formData: FormData) {
  const s = await requireAdmin();
  const templateLineageId = String(formData.get('templateLineageId') ?? '');
  try {
    await createEligibilityRule(s, {
      name: String(formData.get('name') ?? ''),
      templateLineageId,
      criteria: criteriaFrom(formData),
      validFrom: String(formData.get('validFrom') ?? ''),
    });
  } catch (e) {
    refused(formData, e);
  }
  // THE ONE THAT MATTERS MOST. A rule is what connects an employee to a table at all, so writing one is
  // exactly the moment a population goes from resolving nothing to resolving days — and, until r209, the
  // moment when nothing whatsoever happened to their balances.
  await recomputeAfterSave(s, await leaveTypeIdForTemplateLineage(s, templateLineageId), 'eligibility_rule_created');
  saved(formData, `Saved ${String(formData.get('name') ?? '')}`);
}

export async function updateEligibilityRuleAction(formData: FormData) {
  const s = await requireAdmin();
  const templateLineageId = String(formData.get('templateLineageId') ?? '');
  try {
    await updateEligibilityRule(s, {
      lineageId: String(formData.get('lineageId') ?? ''),
      name: String(formData.get('name') ?? ''),
      templateLineageId,
      criteria: criteriaFrom(formData),
      validFrom: String(formData.get('validFrom') ?? ''),
    });
  } catch (e) {
    refused(formData, e);
  }
  // Read off the POSTED template, not the rule's previous one: an edit may have re-pointed the rule at a
  // different table, and the type that needs recomputing is the one it points at NOW.
  await recomputeAfterSave(s, await leaveTypeIdForTemplateLineage(s, templateLineageId), 'eligibility_rule_updated');
  saved(formData, `Saved ${String(formData.get('name') ?? '')}`);
}

export async function retireEligibilityRuleAction(formData: FormData) {
  const s = await requireAdmin();
  const lineageId = String(formData.get('lineageId') ?? '');
  // The retire form posts no template, so the leave type is derived from the rule's own lineage.
  const leaveTypeId = await leaveTypeIdForRuleLineage(s, lineageId);
  try {
    await retireEligibilityRule(s, { lineageId, validTo: String(formData.get('validTo') ?? '') });
  } catch (e) {
    refused(formData, e);
  }
  await recomputeAfterSave(s, leaveTypeId, 'eligibility_rule_retired');
  saved(formData, `Stopped ${String(formData.get('name') ?? '')}`);
}

/**
 * HOW MANY EMPLOYEES DOES THIS RULE REACH, as at a date. READ-ONLY — no event, no row.
 *
 * ⚠️ THE SCREEN IS REQUIRED TO SHOW THIS BEFORE IT LETS ANYBODY SAVE. An EMPTY criteria object is legal
 * and means EVERYONE — that is `core/org-criteria.ts`'s own semantics and it is how a tenant expresses "one
 * default table". It is also how somebody assigns the entire organisation to a table by accident. The
 * resolver deliberately does not second-guess an explicit request, so this count is the thing that stops
 * "no restrictions" becoming an accidental whole-company assignment, exactly as it does on the Notice Board
 * and the Leave Adjustments screen.
 *
 * The criteria are normalised through the SAME `orgCriteriaFromFields` the save goes through rather than
 * trusted as posted: a count computed from a differently-parsed object than the one the write will use is
 * worse than no count at all.
 */
export async function countEligibilityTargetsAction(p: {
  criteria: Record<string, string[] | string>;
  asOf: string;
}) {
  const s = await requireAdmin();
  const raw = p.criteria ?? {};
  const criteria = orgCriteriaFromFields(
    (name) => {
      const v = raw[name];
      return Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
    },
    (name) => {
      const v = raw[name];
      return Array.isArray(v) ? (v[0] ?? null) : v == null ? null : String(v);
    },
  );
  return countOrgCriteriaTargets(s, { criteria, asOf: p.asOf });
}
