/** AI v2 Phase 1 — the inline Confirm, Edit and Discard of a card prepared in chat (approved mock-ups Ask.dc.html and
 * TodayEmployee.dc.html: "Confirm and submit", "Edit", "Discard").
 *
 * Pure and shared by the server reply (components/ai-centre/conversation-reply.tsx) and the client buttons
 * (components/ai-centre/proposal-card-actions.tsx). Which server action a card posts to is decided by its action id
 * here; the posted proposal is only data, verified again for the caller inside the owner, and nothing is submitted
 * unless the person presses Confirm (the owners refuse anything but `confirm: true`). Every other card keeps its one
 * link to the review page. */

/** The three owners whose cards confirm in place: the leave application (app/assistant/leave-apply-proposal-actions.ts),
 * the own attendance requests (attendance-request-proposal-actions.ts) and the own claims and profile changes
 * (own-change-proposal-actions.ts). */
export type InlineProposalKind = 'leave' | 'attendance' | 'own_change';

const INLINE: Readonly<Record<string, InlineProposalKind>> = Object.freeze({
  'leave.apply': 'leave',
  'attendance.correction.request': 'attendance',
  'attendance.overtime.request': 'attendance',
  'claims.submit': 'own_change',
  'claims.cancel': 'own_change',
  'ess.profile.request': 'own_change',
});

export function inlineProposalKind(action: string): InlineProposalKind | null {
  return Object.hasOwn(INLINE, action) ? INLINE[action] : null;
}

/** What the three Confirm actions can answer, as one shape (each owner's own result type is a subset of it). */
export type InlineConfirmResult =
  | Readonly<{ kind: 'submitted'; action?: string }>
  | Readonly<{ kind: 'use_form'; href: string }>
  | Readonly<{ kind: 'draft_saved'; href: string }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'requested' }>
  | Readonly<{ kind: 'refused'; reason: string; message?: string; href?: string }>;
export type InlineEditResult = Readonly<{ ok: true; href: string }> | Readonly<{ ok: false; reason: string }>;

export type InlineDoneKey = 'leaveSubmitted' | 'attendanceSubmitted' | 'claimSubmitted' | 'claimDraftSaved' | 'claimCancelled' | 'profileRequested';
export type InlineRefusalKey = 'expired' | 'invalid' | 'access' | 'retired' | 'unavailable';

/** The words the buttons show, resolved on the server in the person's language. */
export type InlineProposalCopy = Readonly<{
  confirm: string; confirming: string; edit: string; opening: string; discard: string; actionsLabel: string;
  confirmedBy: string; openClaims: string; fixIt: string; error: string;
  done: Readonly<Record<InlineDoneKey, string>>;
  refused: Readonly<Record<InlineRefusalKey, string>>;
}>;

/** Which sentence a successful Confirm shows. `use_form` and `refused` are not outcomes: the form opens, or the
 * refusal is shown in place. */
export function inlineDoneKey(kind: InlineProposalKind, result: InlineConfirmResult): InlineDoneKey | null {
  switch (result.kind) {
    case 'submitted': return kind === 'leave' ? 'leaveSubmitted' : kind === 'attendance' ? 'attendanceSubmitted' : 'claimSubmitted';
    case 'draft_saved': return 'claimDraftSaved';
    case 'cancelled': return 'claimCancelled';
    case 'requested': return 'profileRequested';
    default: return null;
  }
}

/** The plain sentence for an owner's refusal code, when the owner gave no sentence of its own. */
export function inlineRefusalKey(reason: string): InlineRefusalKey {
  switch (reason) {
    case 'expired': return 'expired';
    case 'authority_mismatch': case 'authority_unsupported': return 'access';
    case 'retired': return 'retired';
    case 'malformed': case 'signature': case 'not_yet_valid': case 'wrong_action': case 'not_confirmed': return 'invalid';
    default: return 'unavailable';
  }
}

/** Only a path inside the product is followed or linked; anything else is dropped. */
export function internalHref(href: unknown): string | null {
  return typeof href === 'string' && /^\/(?![/\\])/.test(href) && !/[\s\\]/.test(href) ? href : null;
}
