/**
 * M13 (D14) — the employee's own profile in the app: the SIMPLE personal and contact fields, change requests for
 * them, and the status of every request. v2 only. Imported by route handlers AND by the Expo app, so this file stays
 * dependency-free (zod and common.ts only, no server module, no 'server-only').
 *
 *   GET  /api/mobile/v2/profile?employmentId                                → ProfileWorkspaceResult
 *   GET  /api/mobile/v2/profile/requests?employmentId                       → ProfileRequestsResult
 *   POST /api/mobile/v2/profile/changes?employmentId {requestId, changes[]} → ProfileChangeResult
 *
 * WHICH FIELDS. Only the simple set the server defines once (core/mobile-profile.ts MOBILE_SIMPLE_PROFILE_FIELDS,
 * derived from the shared Personnel descriptors) AND that the employer's presentation policy shows. Addresses and the
 * family, bank and statutory registers are never edited here: the workspace carries server-built web paths for them.
 * A hidden field is absent from every answer, its value, baseline and choices included.
 *
 * NOTHING HERE IS A RULE. Editability, the read-only reason, whether a change applies at once or waits for approval,
 * the choices and the stale-value baseline all come from the web's own owners (core/profile-edit.ts). The app echoes
 * a field's `baseline` back as `before`; a value changed since the form loaded is refused `stale`, never overwritten.
 */
import { z } from 'zod';
import { commandOf } from './common';

const fieldId = z.string().min(1).max(200);
const label = z.string().max(300);
const instant = z.string().max(40);
const webPath = z.string().max(300).regex(/^\/(?!\/)[^\s\\]*$/);

/** Control hint only: `date` is YYYY-MM-DD, `choice` takes one of `options`. */
export const PROFILE_FIELD_KINDS = ['text', 'email', 'phone', 'date', 'choice'] as const;
export const ProfileFieldKind = z.enum(PROFILE_FIELD_KINDS);
export type ProfileFieldKind = z.infer<typeof ProfileFieldKind>;
/** `field_closed`: the employer has not opened this field for change requests; `employment_closed`: this employment cannot request changes (for example it has ended). */
export const ProfileReadOnlyReason = z.enum(['field_closed', 'employment_closed']);
export type ProfileReadOnlyReason = z.infer<typeof ProfileReadOnlyReason>;
export const ProfileOption = z.object({ value: z.string().max(400), label });
export type ProfileOption = z.infer<typeof ProfileOption>;

export const ProfileFieldV2 = z.object({
  fieldId,
  label,
  section: z.enum(['personal', 'contact']),
  kind: ProfileFieldKind,
  /** The current stored value (a choice's value, an ISO date or text); null when not recorded. */
  value: z.string().max(4000).nullable(),
  /** A choice's label for the current value, when the value is one of the options. */
  valueLabel: label.nullable(),
  /** Opaque compare-and-set evidence; sent back unchanged as `before`. */
  baseline: z.string().min(1).max(200),
  editable: z.boolean(),
  readOnlyReason: ProfileReadOnlyReason.nullable(),
  /** `immediately`: saved at once (the owner's low-risk contact fields); `after_approval`: HR decides. */
  applies: z.enum(['immediately', 'after_approval']),
  required: z.boolean(),
  options: z.array(ProfileOption).max(1000).nullable(),
  /** A request waiting for a decision names this field. */
  pending: z.boolean(),
});
export type ProfileFieldV2 = z.infer<typeof ProfileFieldV2>;

/** Server-built web paths for what the app does not edit; null when the policy hides that part. */
export const ProfileWebLinks = z.object({
  addresses: webPath.nullable(),
  family: webPath.nullable(),
  bankStatutory: webPath.nullable(),
  requests: webPath.nullable(),
});
export type ProfileWebLinks = z.infer<typeof ProfileWebLinks>;
export const ProfileWorkspaceV2 = z.object({
  employmentId: z.string().uuid(),
  fields: z.array(ProfileFieldV2).max(64),
  web: ProfileWebLinks,
});
export type ProfileWorkspaceV2 = z.infer<typeof ProfileWorkspaceV2>;

/** `not_found`: not one of the caller's own employments (or guessed); `unavailable`: the owner could not read it. */
export const ProfileReadRefusal = z.object({ outcome: z.literal('refused'), code: z.enum(['not_found', 'unavailable']) });
export type ProfileReadRefusal = z.infer<typeof ProfileReadRefusal>;
export const ProfileWorkspaceResult = z.union([z.object({ outcome: z.literal('found'), workspace: ProfileWorkspaceV2 }), ProfileReadRefusal]);
export type ProfileWorkspaceResult = z.infer<typeof ProfileWorkspaceResult>;

// ── Requests ──────────────────────────────────────────────────────────────────────────────────────

export const PROFILE_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const ProfileRequestStatus = z.enum(PROFILE_REQUEST_STATUSES);
export type ProfileRequestStatus = z.infer<typeof ProfileRequestStatus>;
export const ProfileRequestLineV2 = z.object({
  key: z.string().max(400),
  fieldId: fieldId.nullable(),
  label,
  /** What was asked for, as the web's own history displays it (masked where the web masks). */
  proposed: z.string().max(4000),
  /** Today's value of a scalar field the policy shows, as displayed; null for a register line or a field not shown. */
  current: z.string().max(4000).nullable(),
  recordKind: z.enum(['dependent', 'qualification', 'emergency']).nullable(),
  newRecord: z.boolean(),
});
export type ProfileRequestLineV2 = z.infer<typeof ProfileRequestLineV2>;
export const ProfileRequestV2 = z.object({
  id: z.string().uuid(),
  status: ProfileRequestStatus,
  submittedAt: instant,
  decidedAt: instant.nullable(),
  /** The reviewer's words. Withheld (null) by the owner when any line of the request is hidden by the policy. */
  decisionReason: z.string().max(4000).nullable(),
  lines: z.array(ProfileRequestLineV2).max(400),
});
export type ProfileRequestV2 = z.infer<typeof ProfileRequestV2>;
/**
 * Newest first. `truncated`: older requests exist beyond this list; the web history shows them. `web` null: the
 * employer's policy hides request history (the web's Others tab), so `items` is empty here too.
 */
export const PROFILE_REQUESTS_MAX = 50;
export const ProfileRequestsV2 = z.object({
  items: z.array(ProfileRequestV2).max(PROFILE_REQUESTS_MAX),
  truncated: z.boolean(),
  web: webPath.nullable(),
});
export type ProfileRequestsV2 = z.infer<typeof ProfileRequestsV2>;
export const ProfileRequestsResult = z.union([z.object({ outcome: z.literal('found'), requests: ProfileRequestsV2 }), ProfileReadRefusal]);
export type ProfileRequestsResult = z.infer<typeof ProfileRequestsResult>;

// ── The one command ──────────────────────────────────────────────────────────────────────────────

export const PROFILE_CHANGES_MAX = 32;
export const ProfileChange = z.object({ fieldId, before: z.string().min(1).max(200), value: z.string().max(4000).nullable() }).strict();
export type ProfileChange = z.infer<typeof ProfileChange>;
/** Only the CHANGED simple fields, each with the baseline it was loaded with. */
export const ProfileChangeCommand = commandOf({ changes: z.array(ProfileChange).min(1).max(PROFILE_CHANGES_MAX) });
export type ProfileChangeCommand = z.infer<typeof ProfileChangeCommand>;

/**
 * `not_found` the employment is not the caller's own; `not_simple` a field outside the app's simple set (or unknown);
 * `employment_closed` this own employment cannot request changes; `field_closed` the employer has not opened a field
 * (or hides it); `stale` a value changed since the form loaded; `invalid` the owner refused a value; `unavailable`
 * the owner could not apply it; `no_change` every value equals the current one; `request_conflict` the requestId
 * already recorded a different command. `fieldIds` names the submitted fields a refusal is about, when known.
 */
export const PROFILE_COMMAND_REFUSALS = ['not_found', 'not_simple', 'employment_closed', 'field_closed', 'stale', 'invalid', 'unavailable', 'no_change', 'request_conflict'] as const;
export type ProfileCommandRefusalCode = (typeof PROFILE_COMMAND_REFUSALS)[number];
export const ProfileCommandRefusal = z.object({
  outcome: z.literal('refused'),
  code: z.enum(PROFILE_COMMAND_REFUSALS),
  fieldIds: z.array(fieldId).max(PROFILE_CHANGES_MAX).optional(),
});
export type ProfileCommandRefusal = z.infer<typeof ProfileCommandRefusal>;
/** `saved`: applied now; `waiting`: in a request (`requestId`) for HR to decide. */
export const ProfileChangeResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('submitted'), saved: z.array(fieldId).max(PROFILE_CHANGES_MAX), waiting: z.array(fieldId).max(PROFILE_CHANGES_MAX), requestId: z.string().uuid().nullable() }),
  ProfileCommandRefusal,
]);
export type ProfileChangeResult = z.infer<typeof ProfileChangeResult>;
