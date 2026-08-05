'use server';

import { requireAdmin } from '@/lib/authz';
import { ENTITLEMENT_TEMPLATES, fail, okToast } from '@/app/admin/_redirects';
import { orgCriteriaFromFields, countOrgCriteriaTargets } from '@/core/org-criteria';
import {
  createEligibilityRule,
  createEntitlementTemplate,
  retireEligibilityRule,
  retireEntitlementTemplate,
  updateEligibilityRule,
  updateEntitlementTemplate,
  type ServiceBand,
} from '@/packs/leave/service';

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
 * Read the criteria the form posted through the SHARED reader.
 *
 * `orgCriteriaFromFields` is the same reader the Leave Adjustments screen and the Notice Board post
 * through. That is the whole point of this item: "Finance + Executive" must select the same people
 * wherever it is typed. A hand-rolled reader here would list the field names itself, and the axis somebody
 * forgot would post fine, resolve to nothing and narrow NOBODY — silently.
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
    fail(ENTITLEMENT_TEMPLATES, e);
  }
  okToast(ENTITLEMENT_TEMPLATES, `Saved ${String(formData.get('name') ?? '')}`);
}

/**
 * An edit CLOSES the running version and INSERTS a successor, from `validFrom`. It is not an in-place
 * UPDATE and the screen says so, because the three past-date readers depend on it: overwriting the row
 * would make a closed year report today's figures.
 *
 * The LEAVE TYPE is not editable — see `updateEntitlementTemplate`'s own note. A rule pointing at "the
 * Executive ANNUAL table" that silently started handing out SICK days is not an edit anyone would spot.
 */
export async function updateEntitlementTemplateAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    await updateEntitlementTemplate(s, {
      lineageId: String(formData.get('lineageId') ?? ''),
      name: String(formData.get('name') ?? ''),
      serviceBands: bandsFrom(formData),
      validFrom: String(formData.get('validFrom') ?? ''),
    });
  } catch (e) {
    fail(ENTITLEMENT_TEMPLATES, e);
  }
  okToast(ENTITLEMENT_TEMPLATES, `Saved ${String(formData.get('name') ?? '')}`);
}

/** Stop a table from a date. There is no delete — see `retireEntitlementTemplate`. */
export async function retireEntitlementTemplateAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    await retireEntitlementTemplate(s, {
      lineageId: String(formData.get('lineageId') ?? ''),
      validTo: String(formData.get('validTo') ?? ''),
    });
  } catch (e) {
    fail(ENTITLEMENT_TEMPLATES, e);
  }
  okToast(ENTITLEMENT_TEMPLATES, `Stopped ${String(formData.get('name') ?? '')}`);
}

export async function createEligibilityRuleAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    await createEligibilityRule(s, {
      name: String(formData.get('name') ?? ''),
      templateLineageId: String(formData.get('templateLineageId') ?? ''),
      criteria: criteriaFrom(formData),
      validFrom: String(formData.get('validFrom') ?? ''),
    });
  } catch (e) {
    fail(ENTITLEMENT_TEMPLATES, e);
  }
  okToast(ENTITLEMENT_TEMPLATES, `Saved ${String(formData.get('name') ?? '')}`);
}

export async function updateEligibilityRuleAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    await updateEligibilityRule(s, {
      lineageId: String(formData.get('lineageId') ?? ''),
      name: String(formData.get('name') ?? ''),
      templateLineageId: String(formData.get('templateLineageId') ?? ''),
      criteria: criteriaFrom(formData),
      validFrom: String(formData.get('validFrom') ?? ''),
    });
  } catch (e) {
    fail(ENTITLEMENT_TEMPLATES, e);
  }
  okToast(ENTITLEMENT_TEMPLATES, `Saved ${String(formData.get('name') ?? '')}`);
}

export async function retireEligibilityRuleAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    await retireEligibilityRule(s, {
      lineageId: String(formData.get('lineageId') ?? ''),
      validTo: String(formData.get('validTo') ?? ''),
    });
  } catch (e) {
    fail(ENTITLEMENT_TEMPLATES, e);
  }
  okToast(ENTITLEMENT_TEMPLATES, `Stopped ${String(formData.get('name') ?? '')}`);
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
