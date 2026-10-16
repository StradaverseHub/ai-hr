import type {LeaveCreditFormulaReason} from './leave-credit-claim-review';
/** A canonical read refusal is settled business state, not an absent fact or transport failure. */
export type LeaveCreditDayFactsUnavailable={state:'unavailable';reason:LeaveCreditFormulaReason};
export type LeaveCreditDayFactsResult<T>=T|LeaveCreditDayFactsUnavailable|null;
export function isLeaveCreditDayFactsUnavailable(value:unknown):value is LeaveCreditDayFactsUnavailable {
 if(!value||typeof value!=='object'||!('state' in value)||value.state!=='unavailable'||!('reason' in value))return false;
 return value.reason==='cashConflict'||value.reason==='stale'||value.reason==='fractional'||value.reason==='unavailable';
}
