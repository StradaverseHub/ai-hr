/** AI v2 W8 — the loops' value shapes. A leaf: no imports, so db/teras-schema.ts can type its columns from here.
 *
 * A loop's facts are references, calendar dates, clock times, counts and closed-vocabulary keys only: never a name,
 * an identifier number, an amount or free text. The data stays in its native owners. */
export const LOOP_IDS=Object.freeze(['loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry'] as const);
export type LoopId=(typeof LOOP_IDS)[number];
export const isLoopId=(value:unknown):value is LoopId=>typeof value==='string'&&(LOOP_IDS as readonly string[]).includes(value);

/** Who the prepared card is for. `payroll`: the payroll administrators of a company (a company case, no employment). */
export type LoopRecipient='hr'|'payroll'|'employee';
/** open: waiting for the person; waiting: the person acted and the owner's usual approval is pending; closed. */
export type LoopCaseState='open'|'waiting'|'closed';
/** done: the post-condition was positively observed; inactive: the employment ended; superseded: the condition no
 * longer applies (an end date moved out of the window); expired: the moment passed (a cut-off, an old day). Only
 * done is credited to the loop. */
export type LoopCloseReason='done'|'inactive'|'superseded'|'expired';
/** How a done case was completed: as the card proposed, changed by the person, or completed where the card proposed
 * no value of its own (most cards ask a person to do something, they do not propose a figure or a time). */
export type LoopResolution='as_prepared'|'changed'|'completed';
export type LoopFactValue=string|number|boolean|null|readonly string[];
export type LoopFacts=Readonly<Record<string,LoopFactValue>>;
export type LoopRunStatus='ran'|'sponsor_lost'|'failed';
/** One check as the run evaluated it, with the version of the rule or row it read. */
export type LoopCheck=Readonly<{check:string;ruleVersion:string|null;result:'pass'|'fail'}>;
/** One owner read: the owner function (anchor) and how it ended. Never its data. */
export type LoopRead=Readonly<{tool:string;owner:string;status:'ok'|'failed'}>;
