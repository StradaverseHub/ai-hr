/** WP11 (R5; ADR-0151 §4.6d): the deterministic measured-outcome rule that retires a live Assistant
 * promotion. Pure and model-free: the inputs are the ADR-0151 §4.6c outcome counts (migration 0674,
 * `app.assistant_action_outcome_summary`), never a model score, a rating or free text.
 *
 * Windows. "During" is every Assistant-prepared action created since the promotion started; "before" is
 * the same length of time immediately before it (the PR #34 before/after convention). Counts are by the
 * action's creation time and its CURRENT state.
 *
 * Measure. settled = completed + discarded + expired + refused. unsuccessful = discarded + expired + refused
 * + reversed (reversed only where the canonical record proves it; null counts as 0, never as a success).
 *
 * Rule. Regressed when BOTH windows hold at least `minimumSettledPerWindow` settled actions AND the during
 * unsuccessful rate exceeds the before rate by at least `regressionPercentagePoints`. Integer arithmetic
 * only, so the same counts always give the same answer.
 *
 * Honest scope. The counts are tenant-wide (the scheduled principal) or the administrator's scope, and are
 * not attributed to the promotion: this is a conservative non-causal brake. Retiring a promotion only
 * restores the reviewed baseline; it never changes an HR fact.
 */
import {NATIVE_OUTCOME_ACTIONS,type NativeOutcomeAction} from './module-native-outcomes';

export const PROMOTION_OUTCOME_POLICY=Object.freeze({version:1,minimumSettledPerWindow:10,regressionPercentagePoints:20} as const);
export type OutcomeCountRow=Readonly<{action_kind:string;completed:number;discarded:number;expired:number;refused:number;reversed:number|null}>;
export type OutcomeWindow=Readonly<{settled:number;unsuccessful:number}>;

/** Action kinds whose outcomes a promotion of `module` can influence. The Assistant's own promotions
 * (answer and planning strategies) shape every proposal; a specialist only its own module's actions. */
export function promotionOutcomeKinds(module:string):readonly string[]{
 const kinds=Object.keys(NATIVE_OUTCOME_ACTIONS) as NativeOutcomeAction[];
 return Object.freeze(module==='assistant'?kinds:kinds.filter(kind=>NATIVE_OUTCOME_ACTIONS[kind].module===module));
}
const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:0;
export function outcomeWindow(rows:readonly OutcomeCountRow[],kinds:readonly string[]):OutcomeWindow{
 let settled=0,unsuccessful=0;
 for(const row of rows){if(!kinds.includes(row.action_kind))continue;
  const completed=count(row.completed),discarded=count(row.discarded),expired=count(row.expired),refused=count(row.refused),reversed=Math.min(count(row.reversed),completed);
  settled+=completed+discarded+expired+refused;unsuccessful+=discarded+expired+refused+reversed;}
 return Object.freeze({settled,unsuccessful});
}
/** The earlier window as (from-before-start) minus (from-start). A row that settled between the two reads
 * can make a difference negative; it is clamped to zero rather than invented. */
export function earlierWindow(wide:OutcomeWindow,during:OutcomeWindow):OutcomeWindow{
 const settled=Math.max(0,wide.settled-during.settled);
 return Object.freeze({settled,unsuccessful:Math.min(settled,Math.max(0,wide.unsuccessful-during.unsuccessful))});
}
export function outcomeRegressed(before:OutcomeWindow,during:OutcomeWindow,policy=PROMOTION_OUTCOME_POLICY):boolean{
 const min=policy.minimumSettledPerWindow;
 if(before.settled<min||during.settled<min)return false;
 // during.u/during.s - before.u/before.s >= points/100, cross-multiplied over positive integers.
 return 100*(during.unsuccessful*before.settled-before.unsuccessful*during.settled)>=policy.regressionPercentagePoints*during.settled*before.settled;
}
