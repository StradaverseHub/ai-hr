/**
 * Approvals deep-link targets for the dashboard Leave Calendar (item 8cb7b089).
 *
 * A calendar pill that is waiting for the viewer's decision links straight to the matching
 * /approvals section by URL hash. Pure + DB-free: shared by the server pill mapping
 * (components/planned-absences.tsx), the approvals page's section ids, and the arrival island
 * (app/approvals/attention-on-arrival.tsx) — one constant, so the ids cannot drift apart.
 */

/** The two /approvals sections a calendar pill can deep-link to, keyed by focus kind. */
export const APPROVAL_SECTION_ID = {
  leave: 'approvals-leave',
  leaveCancellation: 'approvals-leave-cancellation',
} as const;

export type ApprovalFocus = keyof typeof APPROVAL_SECTION_ID;

/**
 * Which approvals section (if any) a calendar pill should deep-link to:
 *  - a PENDING row → the Leave Requests section. This wins even when the row ALSO carries a pending
 *    cancellation (the read layer's pending-cancellation subquery does not constrain the parent's
 *    status, so that state is representable) — the Approvals page shows such a row in the Leave
 *    Requests section, and the link must agree with the destination.
 *  - an APPROVED row with a pending cancellation → the Leave Cancellation section.
 *  - anything else → null (no affordance).
 */
export function focusForCalendarPill(l: {
  status: string;
  pendingCancellationId?: string | null;
}): ApprovalFocus | null {
  if (l.status === 'pending') return 'leave';
  if (l.status === 'approved' && l.pendingCancellationId) return 'leaveCancellation';
  return null;
}

/**
 * DOM id for a single approval row (a34eedde) — used for BOTH leave-request rows and cancellation
 * rows on /approvals. The `approval-row-` prefix cannot collide with the section ids (or any other
 * id on the page), and it namespaces getElementById lookups so a junk rowId riding in the hash is
 * harmless: the lookup simply misses and arrival degrades to section-only.
 */
export function approvalRowDomId(id: string): string {
  return `approval-row-${id}`;
}

/**
 * Composite attention hash (a34eedde), WITHOUT the leading `#`: `<sectionId>--<rowId>` when a row
 * id is present, else the bare section id. The `--` separator is unambiguous because section ids
 * only ever contain SINGLE hyphens (including `approvals-leave-cancellation`), never a double one.
 */
export function buildApprovalAttentionHash(focus: ApprovalFocus, rowId?: string | null): string {
  const sectionId = APPROVAL_SECTION_ID[focus];
  return rowId ? `${sectionId}--${rowId}` : sectionId;
}

/**
 * Parse a hash ALREADY stripped of `#` (the arrival island strips it) back into its parts. Splits
 * on the FIRST `--`; the section half must be a known section id, else null. No rowId validation:
 * a garbage rowId only ever reaches a namespaced getElementById (see approvalRowDomId), which
 * returns null and degrades to section-only attention.
 */
export function parseApprovalAttentionHash(
  raw: string,
): { sectionId: string; rowId: string | null } | null {
  const sep = raw.indexOf('--');
  const sectionId = sep === -1 ? raw : raw.slice(0, sep);
  if (!(Object.values(APPROVAL_SECTION_ID) as string[]).includes(sectionId)) return null;
  const rest = sep === -1 ? '' : raw.slice(sep + 2);
  return { sectionId, rowId: rest.length > 0 ? rest : null };
}
