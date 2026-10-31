/**
 * M13 (D14) — the employee's own profile in the app. COMPOSITION ONLY over the owners the web's /me already uses:
 *
 *   policy      readProfilePresentationPolicy — one read, passed to every owner below (as app/(app)/me/page.tsx does)
 *   workspace   readOwnProfileWorkspace — visible values, CAS baselines, editable ids (already visibility-projected)
 *   open        myOwnEmploymentSubjects({profileEdit:true}) — whether this own employment may request changes
 *   choices     listAllProfileOptions (the tenant catalogue) or personnelFieldChoices (fixed vocabularies)
 *   requests    myProfileChangeRequests — own person only, proposals projected and reasons withheld by the owner
 *   lines       profileProposalReviewLines — the web's own request/current display
 *   submit      submitOwnProfileEdit, inside the mobile command receipt's transaction (its optional existingTx)
 *
 * THE SIMPLE SET is defined ONCE, here (MOBILE_SIMPLE_PROFILE_FIELDS): editable-capable Personnel descriptors bound
 * to the Person or compliance owner, unmasked, single, text/date/choice, and not an address component. Everything
 * else (addresses, family, bank, statutory, emergency contacts, qualifications, the photo) opens on the web.
 * test/mobile-v2-profile.test.ts pins the exact membership.
 *
 * SCOPE. The employment is the caller's own: the owner refuses any other (EssProfileError 'permission') and the
 * receipt refuses a command whose employment is not the actor's (MobileCommandOwnerRequired); both are `not_found`.
 *
 * A REFUSAL ROLLS BACK. Every owner refusal is thrown inside the receipt's run; it is mapped after the receipt, so
 * nothing is recorded and a retry re-evaluates it. Only an accepted command (and `no_change`) is recorded.
 *
 * Kept free of 'server-only' and of the message catalogues: labels come through an injected resolver.
 */
import type { SessionContext } from '../db/client';
import { readOwnProfileWorkspace, submitOwnProfileEdit, type EssWorkspace } from './profile-edit';
import { readProfilePresentationPolicy, type ProfilePresentationPolicy } from './profile-edit-policy';
import { myProfileChangeRequests } from './profile';
import { listAllProfileOptions, ProfileOptionValueError } from './profile-options';
import { PersonProfileCatalogError } from './org';
import { getSetting } from './entitlements';
import { myOwnEmploymentSubjects } from './read';
import { MobileCommandOwnerRequired, withMobileCommandReceipt } from './mobile-command-receipt';
import { essEditableFields } from '../lib/personnel-ess-contract';
import { PERSONNEL_FIELDS, type PersonnelFieldDescriptor } from '../lib/personnel-field-registry';
import { personnelFieldLabel, type PersonnelLabelResolver } from '../lib/personnel-field-label';
import { personnelFieldChoices } from '../lib/personnel-import-contract';
import { profileProposalReviewLines, type ProfileProposalCurrent } from '../lib/profile-proposal-display';
import { profileHiddenTabs } from '../lib/profile-edit-policy-value';
import { EssProfileError, PERSONNEL_ESS_SECTION_LABEL_KEYS } from '../lib/personnel-ess-model';
import {
  PROFILE_CHANGES_MAX, PROFILE_REQUESTS_MAX, ProfileChangeResult, ProfileRequestStatus,
  type ProfileChangeCommand, type ProfileCommandRefusal, type ProfileFieldKind, type ProfileFieldV2, type ProfileOption,
  type ProfileReadRefusal, type ProfileRequestsResult, type ProfileRequestV2, type ProfileWebLinks, type ProfileWorkspaceResult,
} from '../lib/mobile-api/v2/profile';

/** An address component: these open on the web (D14), whatever their type. */
const ADDRESS_PART = /^(permanent|correspondence)(AddressLine\d+|Postcode|City|State|Country)$/;
const SIMPLE_TYPES: ReadonlySet<string> = new Set(['text', 'date', 'choice']);

/** THE simple set (D14). Derived from the shared descriptors; never a parallel hand list. */
export const MOBILE_SIMPLE_PROFILE_FIELDS: readonly PersonnelFieldDescriptor[] = essEditableFields().filter((field) => {
  const binding = field.ess.binding;
  return !!binding && (binding.owner === 'person' || binding.owner === 'compliance') && field.grain === 'single' && !field.ess.masked
    && SIMPLE_TYPES.has(field.type) && field.unit !== 'month' && !ADDRESS_PART.test(binding.field);
});
export const MOBILE_SIMPLE_PROFILE_FIELD_IDS: ReadonlySet<string> = new Set(MOBILE_SIMPLE_PROFILE_FIELDS.map((field) => field.id));

function kindOf(field: PersonnelFieldDescriptor): ProfileFieldKind {
  if (field.type === 'date') return 'date';
  if (field.type === 'choice') return 'choice';
  if (field.form?.widget === 'email') return 'email';
  return /phone$/i.test(field.ess.binding?.field ?? '') ? 'phone' : 'text';
}
/**
 * The web's section for a field, titled as app/(app)/me/profile-editor.tsx titles it. "Contact and permanent address" and
 * "Correspondence address" both carry "Mobile Phone Number" / "Home Phone Number" (people.detail.phone/homePhone); the
 * coarse `section` merges them, the group keeps them apart.
 */
function sectionGroup(field: PersonnelFieldDescriptor, labels: PersonnelLabelResolver): { key: string; title: string } {
  const key = PERSONNEL_ESS_SECTION_LABEL_KEYS[field.section];
  return { key: clip(field.section, 120), title: clip(key ? labels(`people.detail.${key}`, field.section) : field.section, 300) };
}
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);
const iso = (d: Date | string | null | undefined) => (d == null ? null : (d instanceof Date ? d : new Date(String(d))).toISOString());

function readRefusal(e: unknown): ProfileReadRefusal | null {
  if (e instanceof EssProfileError) return { outcome: 'refused', code: e.code === 'unavailable' ? 'unavailable' : 'not_found' };
  return null;
}

/** The policy's hidden tabs (version 4 groups), as app/(app)/me/page.tsx reads them. */
function hiddenTabs(policy: ProfilePresentationPolicy): ReadonlySet<string> {
  return new Set(profileHiddenTabs(getSetting(policy.ctx, 'ess.profile_change_fields')));
}
function webLinks(policy: ProfilePresentationPolicy, workspace: EssWorkspace): ProfileWebLinks {
  const hidden = hiddenTabs(policy), visible = policy.visible;
  const shown = (test: (field: PersonnelFieldDescriptor) => boolean) => PERSONNEL_FIELDS.some((field) => visible.has(field.id) && test(field));
  const path = (tab: string) => `/me?tab=${tab}&employmentId=${workspace.employmentId}`;
  return {
    addresses: !hidden.has('Profile') && shown((f) => f.ess.binding?.owner === 'person' && ADDRESS_PART.test(f.ess.binding.field)) ? path('profile') : null,
    family: !hidden.has('Family') && shown((f) => f.ess.binding?.owner === 'dependent') ? path('family') : null,
    bankStatutory: !hidden.has('Bank & Statutory') && workspace.statutoryAvailable && shown((f) => f.tab === 'Bank & Statutory') ? path('bankStatutory') : null,
    requests: !hidden.has('Others') ? path('others') : null,
  };
}

/** Field ids a (projected) stored proposal names: v2 scalars and register lines, or a legacy row's keys. */
function proposalFieldIds(proposed: unknown): string[] {
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) return [];
  const value = proposed as Record<string, unknown>;
  const ids = (list: unknown) => (Array.isArray(list) ? list.flatMap((item) => (item && typeof item === 'object' && typeof (item as { fieldId?: unknown }).fieldId === 'string' ? [(item as { fieldId: string }).fieldId] : [])) : []);
  if (value.v === 2) return [...ids(value.fields), ...(Array.isArray(value.registers) ? value.registers.flatMap((row) => (row && typeof row === 'object' ? ids((row as { fields?: unknown }).fields) : [])) : [])];
  return Object.keys(value).flatMap((key) => PERSONNEL_FIELDS.filter((field) => field.ess.binding?.legacyKey === key).map((field) => field.id));
}

async function choicesFor(ctx: SessionContext, fields: readonly PersonnelFieldDescriptor[], labels: PersonnelLabelResolver): Promise<Map<string, ProfileOption[]>> {
  const out = new Map<string, ProfileOption[]>();
  const choiceFields = fields.filter((field) => field.type === 'choice');
  const catalog: Readonly<Record<string, readonly { value: string; label: string }[] | undefined>> =
    choiceFields.some((field) => field.allowedValuesOwner?.startsWith('profile_option:')) ? await listAllProfileOptions(ctx, { activeOnly: true }) : {};
  for (const field of choiceFields) {
    const category = field.allowedValuesOwner?.startsWith('profile_option:') ? field.allowedValuesOwner.slice('profile_option:'.length) : null;
    const rows: readonly { value: string; label: string }[] = category && Object.hasOwn(catalog, category) ? catalog[category] ?? [] : [];
    const options: ProfileOption[] = category
      ? rows.map((row) => ({ value: row.value, label: row.label }))
      : personnelFieldChoices(field).map((choice) => ({ value: choice.value, label: labels(choice.labelKey, choice.value) }));
    out.set(field.id, options.slice(0, 1000).map((o) => ({ value: clip(o.value, 400), label: clip(o.label, 300) })));
  }
  return out;
}

async function loadOwn(ctx: SessionContext, employmentId: string): Promise<{ policy: ProfilePresentationPolicy; workspace: EssWorkspace } | ProfileReadRefusal> {
  const policy = await readProfilePresentationPolicy(ctx);
  try { return { policy, workspace: await readOwnProfileWorkspace(ctx, { employmentId }, policy) }; }
  catch (e) { const refusal = readRefusal(e); if (refusal) return refusal; throw e; }
}

/** The simple fields of the caller's own employment, as the web's editor would offer them. */
export async function ownProfileWorkspaceV2(ctx: SessionContext, employmentId: string, labels: PersonnelLabelResolver): Promise<ProfileWorkspaceResult> {
  const own = await loadOwn(ctx, employmentId);
  if ('outcome' in own) return own;
  const { policy, workspace } = own;
  const visible = new Set(workspace.visible ?? []), editable = new Set(workspace.editable);
  const shown = MOBILE_SIMPLE_PROFILE_FIELDS.filter((field) => visible.has(field.id) && workspace.baselines[field.id] !== undefined);
  const historyShown = !hiddenTabs(policy).has('Others');
  const [open, choices, requests] = await Promise.all([
    myOwnEmploymentSubjects(policy.ctx, { profileEdit: true }),
    choicesFor(policy.ctx, shown, labels),
    historyShown ? myProfileChangeRequests(policy.ctx, PROFILE_REQUESTS_MAX, policy) : Promise.resolve([] as Awaited<ReturnType<typeof myProfileChangeRequests>>),
  ]);
  const employmentOpen = open.some((row) => row.employmentId === workspace.employmentId);
  const pending = new Set(requests.filter((row) => row.status === 'pending').flatMap((row) => proposalFieldIds(row.proposed)));
  const fields = shown.map((field): ProfileFieldV2 => {
    const raw = workspace.values[field.id];
    const value = typeof raw === 'string' ? raw : raw == null ? null : String(raw);
    const options = choices.get(field.id) ?? null;
    const mayEdit = employmentOpen && editable.has(field.id) && !workspace.fieldReadOnlyReasons?.[field.id];
    return {
      fieldId: field.id,
      label: clip(personnelFieldLabel(field, labels), 300),
      section: field.section === 'Personal details' ? 'personal' : 'contact',
      group: sectionGroup(field, labels),
      kind: kindOf(field),
      value,
      valueLabel: value === null ? null : options?.find((o) => o.value === value)?.label ?? null,
      baseline: workspace.baselines[field.id],
      editable: mayEdit,
      readOnlyReason: mayEdit ? null : employmentOpen ? 'field_closed' : 'employment_closed',
      applies: field.ess.edit === 'immediate' ? 'immediately' : 'after_approval',
      required: Boolean(field.form?.required?.record),
      options,
      pending: pending.has(field.id),
    };
  });
  return { outcome: 'found', workspace: { employmentId: workspace.employmentId, fields, web: webLinks(policy, workspace) } };
}

/** The caller's own change requests, newest first, as the web's "My change requests" shows them. */
export async function ownProfileRequestsV2(ctx: SessionContext, employmentId: string, labels: PersonnelLabelResolver): Promise<ProfileRequestsResult> {
  const own = await loadOwn(ctx, employmentId);
  if ('outcome' in own) return own;
  const { policy, workspace } = own;
  const web = webLinks(policy, workspace).requests;
  // The web shows request history only under the Others tab; a policy that hides it hides it here too.
  if (web === null) return { outcome: 'found', requests: { items: [], truncated: false, web: null } };
  const rows = await myProfileChangeRequests(policy.ctx, PROFILE_REQUESTS_MAX + 1, policy);
  // Today's values: only what the workspace already projected for this caller (masked where the owner masks).
  const current: ProfileProposalCurrent = {};
  for (const [id, value] of Object.entries(workspace.values)) {
    current[id] = { value, recordName: null, state: 'existing' };
    const legacyKey = PERSONNEL_FIELDS.find((field) => field.id === id)?.ess.binding?.legacyKey;
    if (legacyKey) current[legacyKey] = { value, recordName: null, state: 'existing' };
  }
  const items = rows.slice(0, PROFILE_REQUESTS_MAX).flatMap((row): ProfileRequestV2[] => {
    const status = ProfileRequestStatus.safeParse(row.status);
    if (!status.success) return [];
    const lines = profileProposalReviewLines(row.proposed, current, labels, { mask: true }).slice(0, 400).map((line) => ({
      key: clip(line.key, 400), fieldId: line.fieldId, label: clip(line.label, 300), proposed: clip(line.value, 4000),
      current: Object.hasOwn(current, line.key) ? clip(line.currentValue, 4000) : null,
      recordKind: line.recordKind, newRecord: line.newRecord,
    }));
    return [{ id: row.id, status: status.data, submittedAt: iso(row.createdAt)!, decidedAt: iso(row.decidedAt), decisionReason: row.decisionReason == null ? null : clip(row.decisionReason, 4000), lines }];
  });
  return { outcome: 'found', requests: { items, truncated: rows.length > PROFILE_REQUESTS_MAX, web } };
}

function commandRefusal(e: unknown): ProfileCommandRefusal | null {
  if (e instanceof MobileCommandOwnerRequired) return { outcome: 'refused', code: 'not_found' };
  if (e instanceof EssProfileError) {
    const code = e.code === 'permission' ? 'employment_closed' : e.code === 'fieldClosed' ? 'field_closed' : e.code === 'stale' ? 'stale' : e.code === 'unavailable' ? 'unavailable' : 'invalid';
    const fieldIds = e.fieldIds.slice(0, PROFILE_CHANGES_MAX);
    return fieldIds.length ? { outcome: 'refused', code, fieldIds } : { outcome: 'refused', code };
  }
  if (e instanceof PersonProfileCatalogError || e instanceof ProfileOptionValueError) return { outcome: 'refused', code: 'invalid' };
  return null;
}

/**
 * Submit ONLY changed simple fields through the web's own owner, in the mobile command receipt. A field outside the
 * simple set is refused before anything runs; the owner re-checks policy, visibility, options and every baseline.
 */
export async function submitOwnProfileChangeV2(ctx: SessionContext, employmentId: string, command: ProfileChangeCommand): Promise<ProfileChangeResult> {
  const outside = command.changes.filter((change) => !MOBILE_SIMPLE_PROFILE_FIELD_IDS.has(change.fieldId)).map((change) => change.fieldId);
  if (outside.length) return { outcome: 'refused', code: 'not_simple', fieldIds: outside.slice(0, PROFILE_CHANGES_MAX) };
  const changes = [...command.changes].sort((a, b) => (a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0)).map((c) => ({ fieldId: c.fieldId, before: c.before, value: c.value }));
  const subject = employmentId.toLowerCase();
  try {
    return await withMobileCommandReceipt(ctx, {
      kind: 'profile.change', requestId: command.requestId, intent: { employmentId: subject, changes }, actorEmploymentId: subject, response: ProfileChangeResult,
    }, async (tx) => {
      const out = await submitOwnProfileEdit(ctx, { employmentId: subject, proposal: { v: 2, fields: changes, registers: [] } }, tx);
      if (!out.saved.length && !out.waiting.length) return { outcome: 'refused' as const, code: 'no_change' as const };
      return { outcome: 'submitted' as const, saved: out.saved, waiting: out.waiting, requestId: out.requestId };
    });
  } catch (e) {
    const refusal = commandRefusal(e);
    if (refusal) return refusal;
    throw e;
  }
}
