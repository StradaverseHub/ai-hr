/** AI v2 Phase 2, P2-6 — the learning loops' closed vocabularies. A leaf: no imports, so db/teras-learning-schema.ts can
 * type its columns from here without a cycle.
 *
 * Every value a learning row holds is one of these names, a count, a calendar date or a reference. The only words are an
 * eval candidate's question and expectation, an administrator's own, redacted before they are written (./redact.ts). No
 * words from anyone's chat are stored (AI v2 Phase 2 hardening: gaps keep no examples). Mirrored by the CHECK constraints of migration 0972; test/learning-loops-rules.test.ts pins the copy. */

/** What a person did with AI Centre's work. */
export const SIGNAL_KINDS=Object.freeze(['card_confirmed','card_edited','card_discarded','recommendation_rejected','answer_helpful','answer_unhelpful'] as const);
export type SignalKind=(typeof SIGNAL_KINDS)[number];
/** The signals an administrator reviews as corrections (a confirmed card and a helpful answer need no correction). */
export const CORRECTION_KINDS:readonly SignalKind[]=Object.freeze(['card_edited','card_discarded','recommendation_rejected','answer_unhelpful']);
export const CARD_SIGNALS=Object.freeze(['card_confirmed','card_edited','card_discarded'] as const);
export type CardSignal=(typeof CARD_SIGNALS)[number];
export const isCardSignal=(value:unknown):value is CardSignal=>typeof value==='string'&&(CARD_SIGNALS as readonly string[]).includes(value);

/** A "Not helpful" mark's optional reason (one tap on the reply). */
export const ANSWER_REASONS=Object.freeze(['wrong','not_what_asked','missing_something'] as const);
export type AnswerReason=(typeof ANSWER_REASONS)[number];
export const isAnswerReason=(value:unknown):value is AnswerReason=>typeof value==='string'&&(ANSWER_REASONS as readonly string[]).includes(value);

/** The role band a signal, a gap or a candidate is recorded under: the eval set's own roles
 * (core/improvement/smart-eval-score.ts SmartEvalRole). Never a person. */
export const LEARNING_ROLES=Object.freeze(['employee','manager','hr_admin','payroll','group_admin'] as const);
export type LearningRole=(typeof LEARNING_ROLES)[number];
export const LEARNING_LOCALES=Object.freeze(['en','ms','zh','vi','ta','th'] as const);
export type LearningLocale=(typeof LEARNING_LOCALES)[number];
export const isLearningLocale=(value:unknown):value is LearningLocale=>typeof value==='string'&&(LEARNING_LOCALES as readonly string[]).includes(value);

/** Why AI Centre could not answer or do something.
 * - not_supported: the person asked what they can do, or whether they can do something, and the honest answer was no;
 * - no_route: they asked for something to be done and no prepared action matched (suggest_action no_match / not_available);
 * - cannot_answer: any other honest gap. */
export const GAP_KINDS=Object.freeze(['not_supported','no_route','cannot_answer'] as const);
export type GapKind=(typeof GAP_KINDS)[number];
export const GAP_STATUSES=Object.freeze(['open','planned','wont_do','duplicate'] as const);
export type GapStatus=(typeof GAP_STATUSES)[number];
export const isGapStatus=(value:unknown):value is GapStatus=>typeof value==='string'&&(GAP_STATUSES as readonly string[]).includes(value);
/** An intent: `<kind>:<area>`, where the area is a product area (core/semantic-model/entities-catalogue.ts CAPABILITY_AREAS). */
export const INTENT_KEY=/^(cannot_answer|no_route|not_supported):[a-z_]{1,40}$/;
export const isIntentKey=(value:unknown):value is string=>typeof value==='string'&&INTENT_KEY.test(value);

export const REVIEW_DECISIONS=Object.freeze(['dismissed','reopened','promoted'] as const);
export type ReviewDecision=(typeof REVIEW_DECISIONS)[number];

/** An eval candidate's kind and factor: the eval set's own (core/improvement/smart-eval-score.ts). */
export const EVAL_KINDS=Object.freeze(['answer','do','clarify','guide','honest_gap','refuse'] as const);
export type EvalKind=(typeof EVAL_KINDS)[number];
export const EVAL_FACTORS=Object.freeze(['facts','capability','doing','privacy_wording','brevity','language','safety'] as const);
export type EvalFactor=(typeof EVAL_FACTORS)[number];
export const CANDIDATE_STATES=Object.freeze(['draft','approved','exported','withdrawn'] as const);
export type CandidateState=(typeof CANDIDATE_STATES)[number];

/** The page's periods: the HR capacity ledger's own (core/capacity/types.ts). */
export const QUALITY_PERIODS=Object.freeze(['last30','quarter','year'] as const);
export type QualityPeriod=(typeof QUALITY_PERIODS)[number];
export const isQualityPeriod=(value:unknown):value is QualityPeriod=>typeof value==='string'&&(QUALITY_PERIODS as readonly string[]).includes(value);

/** The longest question and expectation a candidate keeps (migration 0972 checks the same). */
export const QUESTION_MAX_CHARS=600;
export const EXPECTATION_MAX_CHARS=1200;
/** What a candidate defaults to, from the signal it comes from. */
export function candidateDefaults(kind:SignalKind|'gap'):Readonly<{kind:EvalKind;factor:EvalFactor}>{
 if(kind==='gap')return {kind:'honest_gap',factor:'capability'};
 if(kind==='card_edited'||kind==='card_discarded')return {kind:'do',factor:'doing'};
 return {kind:'answer',factor:'facts'};
}
