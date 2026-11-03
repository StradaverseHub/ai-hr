/** AI v2 W2 (slice 2) — the date and window the Leave Credit request dialog on /leave opens on, when a Leave Credit card
 * prepared in chat sends the person here to edit and submit it (core/proposals/toil-request.ts toilEditHref, which
 * validates the card for the caller first). `?credit=1&creditDate=YYYY-MM-DD&creditStart=HH:MM&creditEnd=HH:MM`.
 *
 * Shape-checked on the server and never trusted: these values only SEED the first row of the form. The form fills the
 * day type from the roster, and submitLeaveCreditRequest re-runs every check when the person submits. The date must be a
 * real calendar day not after today (the HR date owner's), the times well formed and different. No reason, no First
 * Schedule agreement and no other free text is ever read from the URL: the person types and ticks those on the form.
 * Prefixed `credit*` because the retired register owned bare `from`/`to` on this path. Pure. */
export type LeaveCreditPrefill=Readonly<{workedDate:string;claimStart:string;claimEnd:string}>;

const isCalendarDate=(value:unknown):value is string=>{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const parsed=new Date(value+'T00:00:00.000Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
};
const isClock=(value:unknown):value is string=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

/** `today` is the HR date owner's Kuala Lumpur day, as the page already resolved it. Null unless every value is well formed. */
export function leaveCreditPrefill(sp:Readonly<{credit?:unknown;creditDate?:unknown;creditStart?:unknown;creditEnd?:unknown}>,today:string):LeaveCreditPrefill|null{
 if(sp.credit!=='1'||!isCalendarDate(sp.creditDate)||sp.creditDate>today||!isClock(sp.creditStart)||!isClock(sp.creditEnd)||sp.creditStart===sp.creditEnd)return null;
 return Object.freeze({workedDate:sp.creditDate,claimStart:sp.creditStart,claimEnd:sp.creditEnd});
}
