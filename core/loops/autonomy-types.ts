/** AI v2 Phase 2 P2-1 — the autonomy ladder's value shapes. A leaf: no imports, so db/teras-autonomy-schema.ts can type
 * its columns from here (migration 0963).
 *
 * Levels per loop per company: 0 Watch, 1 Prepare (the Phase 1 behaviour, and the level with no row), 2 Act within
 * limits, 3 Act and audit. Facts of an action are dates, clock times and closed keys only, like a case's. */
export const AUTONOMY_LEVELS=Object.freeze([0,1,2,3] as const);
export type AutonomyLevel=(typeof AUTONOMY_LEVELS)[number];
export const PREPARE_LEVEL=1 as const;
export const LEVEL_KEYS=Object.freeze(['watch','prepare','act','act_audit'] as const);
export type LevelKey=(typeof LEVEL_KEYS)[number];
export const levelKey=(level:AutonomyLevel):LevelKey=>LEVEL_KEYS[level];
export const isAutonomyLevel=(value:unknown):value is AutonomyLevel=>typeof value==='number'&&(AUTONOMY_LEVELS as readonly number[]).includes(value);

/** When the missed clock-outs loop may act, the group administrator's choice at promotion (owner, 3 November 2026):
 *  - roster_and_site_exit: the roster end and a recorded site exit agree;
 *  - roster_end: a roster end exists, there is no approved leave that day and no other clocking that day (only the one
 *    clock-in).
 * Always, whichever is chosen: a clock-in and a roster end on record, no approved leave that day, the day unchanged since
 * the card, not the sponsor's own day, and the fix never creates overtime. */
export const ACT_CONDITIONS=Object.freeze(['roster_and_site_exit','roster_end'] as const);
export type ActCondition=(typeof ACT_CONDITIONS)[number];
/** No source in the product records a site exit today; "roster end and site exit agree" therefore cannot hold, and the
 * promote page offers the roster-end condition by default. Site exit is the default wherever such data exists. */
export const SITE_EXIT_RECORDED=false;
export const UNDO_WINDOW_DAYS=Object.freeze([3,7] as const);
export type UndoWindowDays=(typeof UNDO_WINDOW_DAYS)[number];
export const MAX_ACTIONS_PER_NIGHT=200;
export type LoopLimits=Readonly<{maxActionsPerNight:number;undoDays:UndoWindowDays;condition:ActCondition}>;
/** The limits a company starts from when promoted (the approved Promote mock-up's defaults; site exit where it is
 * recorded, otherwise the roster-end condition). */
export const DEFAULT_LIMITS:LoopLimits=Object.freeze({maxActionsPerNight:50,undoDays:3,condition:SITE_EXIT_RECORDED?'roster_and_site_exit':'roster_end'});

export type LevelChangeKind='promoted'|'moved_down'|'demoted_auto'|'limits_changed';
export type LevelChangedBy='administrator'|'automatic';
export type LoopActionState='applying'|'applied'|'not_applied';
/** Why an action was not applied: a condition did not hold, the owner refused it, or the run was interrupted. */
export type LoopActionReason='condition_site_exit'|'condition_leave'|'condition_day_changed'|'condition_sponsor_self'|'condition_other_clocking'
 |'condition_inactive'|'would_create_overtime'|'approval_routed'|'owner_refused'|'payroll_closed'|'approval_pending'|'interrupted';
export const LOOP_ACTION_REASONS:readonly LoopActionReason[]=Object.freeze(['condition_site_exit','condition_leave','condition_day_changed','condition_sponsor_self',
 'condition_other_clocking','condition_inactive','would_create_overtime','approval_routed','owner_refused','payroll_closed','approval_pending','interrupted']);
export type UndoneBy='employee'|'hr';
/** One check the action evaluated, as a run's checks are recorded. */
export type LoopActionCheck=Readonly<{check:string;ruleVersion:string|null;result:'pass'|'fail'}>;
export type LoopActionFactValue=string|number|boolean|null;
export type LoopActionFacts=Readonly<Record<string,LoopActionFactValue>>;
/** A correction a person made to an automatic action, as a demotion records it. */
export type LoopCorrection=Readonly<{actionId:string;kind:'undone'|'changed';by:UndoneBy|null}>;
