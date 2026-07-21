/**
 * Approval activity history — the shared, db-free vocabulary between the read model
 * (core/read.ts listApprovalHistory → app.approval_history), the bell's History tab
 * (components/notification-center.tsx, a client component) and the /approvals/history page.
 *
 * Keep this module free of DB imports: the client bell component imports it, so anything that pulls in
 * db/client here would break the RSC boundary at `next build`.
 */

/** The area filter vocabulary — the delegation-scope modules (lib/delegation-scope) plus the request
 *  flows that have no delegation scope yet (travel / resignation / profile / probation review). */
export const APPROVAL_HISTORY_MODULES = [
  'leave',
  'attendance',
  'claims',
  'travel',
  'resignation',
  'profile',
  'review',
] as const;
export type ApprovalHistoryModule = (typeof APPROVAL_HISTORY_MODULES)[number];

export function isApprovalHistoryModule(v: string): v is ApprovalHistoryModule {
  return (APPROVAL_HISTORY_MODULES as readonly string[]).includes(v);
}

/** aggregate_type → module label key. Note leave CANCELLATIONS live on their own aggregate. */
export const moduleOfAggregate: Record<string, ApprovalHistoryModule> = {
  'leave-request': 'leave',
  'leave-cancellation-request': 'leave',
  'attendance-correction': 'attendance',
  'claim-request': 'claims',
  'travel-request': 'travel',
  resignation: 'resignation',
  'profile-change': 'profile',
  'employment-review': 'review',
};

/** module → the aggregate-type set passed to the SQL read function's p_aggregate_types filter. */
export const aggregateTypesOfModule: Record<ApprovalHistoryModule, string[]> = {
  leave: ['leave-request', 'leave-cancellation-request'],
  attendance: ['attendance-correction'],
  claims: ['claim-request'],
  travel: ['travel-request'],
  resignation: ['resignation'],
  profile: ['profile-change'],
  review: ['employment-review'],
};

/** The coarse action FILTER vocabulary (step + per-day rows group by their outcome; employment-review
 *  decisions — confirm/extend/terminate — fall under `other`). */
export const APPROVAL_HISTORY_ACTIONS = ['approved', 'rejected', 'other'] as const;
export type ApprovalHistoryAction = (typeof APPROVAL_HISTORY_ACTIONS)[number];

export function isApprovalHistoryAction(v: string): v is ApprovalHistoryAction {
  return (APPROVAL_HISTORY_ACTIONS as readonly string[]).includes(v);
}

/** The per-row action LABEL key (i18n: approvalHistory.actionLabel.*). */
export type ApprovalHistoryActionKey =
  | 'approved'
  | 'rejected'
  | 'stepApproved'
  | 'perDayDecision'
  | 'confirmed'
  | 'extended'
  | 'terminated';

/** Derive the display-label key for one history row. resignation.ACCEPTED reads as Approved;
 *  employment-review.decided maps its ReviewDecision (confirm/extend/terminate) to its own label. */
export function actionKeyOf(eventType: string, payload: unknown): ApprovalHistoryActionKey {
  if (eventType === 'leave-request.step.approved') return 'stepApproved';
  if (eventType === 'leave-request.date.decided') return 'perDayDecision';
  if (eventType === 'employment-review.decided') {
    const d = (payload as { decision?: string } | null)?.decision;
    if (d === 'extend') return 'extended';
    if (d === 'terminate') return 'terminated';
    return 'confirmed';
  }
  if (eventType.endsWith('.rejected')) return 'rejected';
  return 'approved'; // *.approved + resignation.accepted
}

/** The serializable row the server layer hands to the (client) bell tab and the history page. */
export type ApprovalHistoryItem = {
  id: string;
  moduleKey: ApprovalHistoryModule;
  actionKey: ApprovalHistoryActionKey;
  subjectName: string | null;
  deciderName: string | null;
  isAuto: boolean;
  onBehalfOfName: string | null;
  /** ISO timestamp (serializable across the RSC boundary). */
  occurredAt: string;
};

/** The structural input shape (what listApprovalHistory returns) — kept structural so this module
 *  needs no import from core/read. */
type RawApprovalHistoryRow = {
  id: string;
  aggregateType: string;
  eventType: string;
  occurredAt: Date;
  subjectName: string | null;
  deciderName: string | null;
  isAuto: boolean;
  onBehalfOfName: string | null;
  payload: unknown;
};

export function shapeApprovalHistoryItems(rows: RawApprovalHistoryRow[]): ApprovalHistoryItem[] {
  return rows.map((r) => ({
    id: r.id,
    moduleKey: moduleOfAggregate[r.aggregateType] ?? 'leave',
    actionKey: actionKeyOf(r.eventType, r.payload),
    subjectName: r.subjectName,
    deciderName: r.deciderName,
    isAuto: r.isAuto,
    onBehalfOfName: r.onBehalfOfName,
    occurredAt: r.occurredAt.toISOString(),
  }));
}
