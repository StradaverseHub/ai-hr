/** Versioned processed-claim receipts. A review/refusal never represents an attendance punch. */
import {z} from 'zod';
import {OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT} from './mobile-offline-clock';
const uuid=z.string().uuid().transform(value=>value.toLowerCase()),sha=z.string().length(64).regex(/^[a-f0-9]{64}$/);
const instant=z.number().int().positive().max(8640000000000000);
// Owner decisions 2026-10-28 (packs/attendance/mobile-offline-adjudicator.ts): offline_disabled refuses a claim whose
// company has offline clocking off at decision time; proven_window_too_wide sends one whose server-proven interval is
// wider than the company's maximum to review; employment_inactive and overtime_settled are review reasons.
// Owner decision D16 (29 October 2026, keyless): issuer_unavailable is retired with the issuer registry. No adjudicator ever
// produced it and no receipt carries it (draft 0647 has never been applied anywhere).
export const OfflineClockReviewReason=z.enum(['continuity_unknown','time_unverifiable','outside_context_window','policy_changed','site_changed','attendance_changed','corrected_day','payroll_locked','location_required','poor_accuracy','outside_geofence','mock_reported','simulated_reported','accessory_reported','photo_required','photo_invalid','scope_changed','device_required','review_required',
 'offline_disabled','proven_window_too_wide','employment_inactive','overtime_settled']);
export const OfflineClockDecision=z.discriminatedUnion('outcome',[
 z.object({outcome:z.literal('accepted'),reason:z.literal('clock_accepted'),captureId:uuid,effectiveAt:instant}).strict(),
 z.object({outcome:z.literal('needs_review'),reason:OfflineClockReviewReason}).strict(),
 z.object({outcome:z.literal('refused'),reason:OfflineClockReviewReason}).strict(),
]);
export type OfflineClockDecision=z.infer<typeof OfflineClockDecision>;
/** Service-owned terminal refusals (owner decision 2026-10-28), never an adjudicator answer: a request ID
 * already recorded by an attendance capture is refused before policy runs. */
export const OfflineClockServiceRefusal=z.object({outcome:z.literal('refused'),reason:z.literal('request_conflict')}).strict();
export type OfflineClockDisposition=OfflineClockDecision|z.infer<typeof OfflineClockServiceRefusal>;
export const OfflineClockReceipt=z.object({version:z.literal(1),purpose:z.literal('attendance.clock.offline.receipt'),
 id:uuid,contextId:uuid,requestId:uuid,sequence:z.number().int().min(1).max(OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT),digest:sha,
 outcome:z.enum(['accepted','needs_review','refused']),reason:z.union([z.literal('clock_accepted'),OfflineClockReviewReason,OfflineClockServiceRefusal.shape.reason]),
 receivedAt:instant,effectiveMinimum:instant.nullable(),effectiveMaximum:instant.nullable(),effectiveAt:instant.nullable(),captureId:uuid.nullable(),
 photo:z.object({sha256:sha,retainedUntil:instant}).strict().nullable(),
}).strict().refine(r=>(r.effectiveMinimum===null)===(r.effectiveMaximum===null))
 .refine(r=>r.effectiveMinimum===null||r.effectiveMaximum!>=r.effectiveMinimum)
 .refine(r=>r.reason!=='request_conflict'||r.outcome==='refused')
 .refine(r=>r.outcome==='accepted'?r.reason==='clock_accepted'&&r.captureId!==null&&r.effectiveAt!==null&&r.effectiveMinimum!==null&&r.effectiveAt>=r.effectiveMinimum&&r.effectiveAt<=r.effectiveMaximum!:
  r.reason!=='clock_accepted'&&r.captureId===null&&r.effectiveAt===null);
export type OfflineClockReceipt=z.infer<typeof OfflineClockReceipt>;
