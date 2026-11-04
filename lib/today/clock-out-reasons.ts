/** AI v2 W8 — the missed clock-out card's reasons and Confirm outcome, shared by the client card
 * (components/today/clock-out-loop-card.tsx) and its owner (core/loops/clock-out-confirm.ts). Pure and client-safe. */

/** The reasons the card offers, in the order it shows them; "other" is typed by the person. */
export const CLOCK_OUT_REASONS=['forgot','device','other'] as const;
export type ClockOutReason=typeof CLOCK_OUT_REASONS[number];
/** The longest reason the person may type (the correction's own limit, core/proposals/attendance-request.ts ownReason). */
export const CLOCK_OUT_OTHER_MAX=500;

export type ClockOutRefusal='not_confirmed'|'invalid'|'retired'|'changed'|'unavailable'|'expired'|'access';
export type ClockOutConfirmResult=Readonly<{kind:'submitted'}>|Readonly<{kind:'refused';reason:ClockOutRefusal}>;

/** The person's reason as text: the label of the option they picked, in their language, or the words they typed for
 * "Other". Null for anything else (no choice, an unknown option, an empty or overlong "Other"). */
export function clockOutReasonText(choice:unknown,other:unknown,labels:Readonly<Record<Exclude<ClockOutReason,'other'>,string>>):string|null{
 if(choice==='forgot'||choice==='device')return labels[choice];
 if(choice!=='other'||typeof other!=='string')return null;
 const typed=other.normalize('NFKC').replace(/\s+/g,' ').trim();
 return typed.length>0&&typed.length<=CLOCK_OUT_OTHER_MAX?typed:null;
}
