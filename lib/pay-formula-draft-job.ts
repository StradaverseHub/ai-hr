/** Shared, dependency-free shapes of the background AI Formula Generator (core/pay-formula-ai-job.ts, migration 5130).
 *  The screen imports these; the server owns every value. */
import type {PayFormulaDraft} from './pay-formula-ai';

/** Closed, plain reasons a background draft ends without a result. No provider or source text is carried. */
export const PAY_FORMULA_DRAFT_FAILURE_REASONS=['timeout','provider_unavailable','invalid_draft','paused','daily_limit','monthly_limit',
 'concurrent_limit','review_required','unavailable','access_changed','failed'] as const;
export type PayFormulaDraftFailureReason=typeof PAY_FORMULA_DRAFT_FAILURE_REASONS[number];
/** `interrupted`: the generation was still marked running past its deadline (the web process stopped). */
export type PayFormulaDraftJobReason=PayFormulaDraftFailureReason|'interrupted';
export type PayFormulaDraftJobView=Readonly<{
 id:string;state:'running'|'succeeded'|'failed';reason:PayFormulaDraftJobReason|null;timeoutSeconds:number;startedAt:string;
 result:PayFormulaDraft|null;
}>;
/** started: a new generation runs. resumed: the same request is already running for this login. busy: a different
 *  request of this login is still running (one provider call per login at a time). */
export type PayFormulaDraftJobStart=Readonly<{outcome:'started'|'resumed'|'busy';job:PayFormulaDraftJobView}>;
