/**
 * r388 — THE REFERENCE A REDACTED DATABASE ERROR CARRIES: `DB-<kind letter>-<six hex>`, e.g. `DB-P-7F3A2C`,
 * or `DB-<kind letter><reason code>-<six hex>`, e.g. `DB-VDO-7F3A2C`, when lib/public-error.ts could tell
 * WHICH rule refused the change (a date that ends a record before it starts, a required field left empty).
 * The reason travels inside the reference for the same reason the kind does: the banner can explain the
 * specific problem in the viewer's language without a second query parameter, and references written
 * before reasons existed still parse.
 *
 * lib/public-error.ts writes it into the English sentence that goes into `?error=` (so a page that prints the
 * raw param still shows something readable), and ErrorBanner / ToastFromQuery parse it back to show the same
 * sentence in the viewer's language. The kind travels inside the reference so the two never need a second
 * query parameter. Pure and tiny: imported by client components.
 */

export const DATABASE_ERROR_KINDS = {
  S: 'system',
  P: 'permission',
  D: 'duplicate',
  L: 'linked',
  V: 'invalidValue',
  R: 'rule',
  B: 'busy',
  N: 'nricDuplicate',
} as const;

export type DatabaseErrorKind = (typeof DATABASE_ERROR_KINDS)[keyof typeof DATABASE_ERROR_KINDS];

const LETTER_OF = Object.fromEntries(
  Object.entries(DATABASE_ERROR_KINDS).map(([letter, kind]) => [kind, letter]),
) as Record<DatabaseErrorKind, string>;

export function formatDatabaseErrorRef(kind: DatabaseErrorKind, id: string): string {
  return `DB-${LETTER_OF[kind]}-${id}`;
}

/**
 * The specific explanations, by two-letter code. A code is part of every reference already shown to a user
 * and written to a server log, so codes are never reused or renumbered; add new ones at the end.
 * Each reason belongs to exactly one kind, which is the sentence a viewer falls back to when their
 * client predates the reason.
 */
export const DATABASE_ERROR_REASONS = {
  DO: { reason: 'dateOrder', kind: 'invalidValue' },
  RQ: { reason: 'required', kind: 'invalidValue' },
  TL: { reason: 'textTooLong', kind: 'invalidValue' },
  NR: { reason: 'numberOutOfRange', kind: 'invalidValue' },
  DT: { reason: 'invalidDate', kind: 'invalidValue' },
  FM: { reason: 'wrongFormat', kind: 'invalidValue' },
  CH: { reason: 'choiceNotAllowed', kind: 'invalidValue' },
  OV: { reason: 'overlap', kind: 'duplicate' },
  MR: { reason: 'missingReference', kind: 'linked' },
  IU: { reason: 'inUse', kind: 'linked' },
  CP: { reason: 'closedPayroll', kind: 'rule' },
  LK: { reason: 'locked', kind: 'rule' },
  ST: { reason: 'changedMeanwhile', kind: 'rule' },
  SC: { reason: 'outsideScope', kind: 'permission' },
} as const satisfies Record<string, { reason: string; kind: DatabaseErrorKind }>;

export type DatabaseErrorReasonCode = keyof typeof DATABASE_ERROR_REASONS;
export type DatabaseErrorReason = (typeof DATABASE_ERROR_REASONS)[DatabaseErrorReasonCode]['reason'];

const CODE_OF = Object.fromEntries(
  Object.entries(DATABASE_ERROR_REASONS).map(([code, { reason }]) => [reason, code]),
) as Record<DatabaseErrorReason, DatabaseErrorReasonCode>;

/** The reference for a refusal whose specific rule is known; the kind is the reason's own. */
export function formatDatabaseErrorReasonRef(reason: DatabaseErrorReason, id: string): string {
  const code = CODE_OF[reason];
  return `DB-${LETTER_OF[DATABASE_ERROR_REASONS[code].kind]}${code}-${id}`;
}

const REF = /\bDB-([SPDLVRBN])([A-Z]{2})?-([0-9A-F]{6})\b/;

/** The kind, the specific reason when the reference carries one, and the full reference inside a message,
 *  or null when the message is not a redacted database error. An unknown reason code (a newer server than
 *  this client) is dropped, so the viewer still gets the kind's sentence. */
export function parseDatabaseErrorRef(
  message: string | null | undefined,
): { kind: DatabaseErrorKind; reason?: DatabaseErrorReason; ref: string } | null {
  const m = REF.exec(message ?? '');
  if (!m) return null;
  const kind = DATABASE_ERROR_KINDS[m[1] as keyof typeof DATABASE_ERROR_KINDS];
  const known = m[2] ? DATABASE_ERROR_REASONS[m[2] as DatabaseErrorReasonCode] : undefined;
  return known && known.kind === kind ? { kind, reason: known.reason, ref: m[0] } : { kind, ref: m[0] };
}
