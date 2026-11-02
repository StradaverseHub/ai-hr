/** Issue 10 — the end date and duration the Request Leave dialog on /leave opens on, beside its existing `?start=` and
 * `?applyType=` seeds. A leave application card prepared in chat sends the person here to edit and submit it
 * (core/proposals/leave-apply.ts leaveApplyEditHref, which validates the card for the caller first).
 *
 * Shape-checked on the server and never trusted: these values only SEED the form's controls. The form keeps every
 * control live, falls back to a full day when the selected type does not allow the duration, and requestLeave
 * re-runs every check when the person submits. Prefixed `apply*` like `applyType`: the retired register owned bare
 * `from`/`to`/`type` on this path. No reason or other free text is ever read from the URL. Pure. */
export const LEAVE_APPLY_PREFILL_DURATIONS=['full_day','half_day_am','half_day_pm'] as const;
export type LeaveApplyPrefillDuration=typeof LEAVE_APPLY_PREFILL_DURATIONS[number];

const isCalendarDate=(value:unknown):value is string=>{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const parsed=new Date(value+'T00:00:00.000Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
};

/** `start` is the dialog's start date as already chosen (the page's own `?start=` or today). A half day is one date,
 * so its end is the start; an end before the start, or not a calendar date, is the start. */
export function leaveApplyPrefill(sp:Readonly<{applyEnd?:unknown;applyDuration?:unknown}>,start:string):Readonly<{endDefault:string;durationDefault:LeaveApplyPrefillDuration}>{
 const duration=typeof sp.applyDuration==='string'&&(LEAVE_APPLY_PREFILL_DURATIONS as readonly string[]).includes(sp.applyDuration)?sp.applyDuration as LeaveApplyPrefillDuration:'full_day';
 const end=duration==='full_day'&&isCalendarDate(sp.applyEnd)&&sp.applyEnd>=start?sp.applyEnd:start;
 return Object.freeze({endDefault:end,durationDefault:duration});
}
