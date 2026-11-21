/** The HR date owner's calendar-day arithmetic: a sibling of ./hr-date.ts (as ./hr-date-phrase.ts is), so it can be
 * used by Employee Today without changing the owner module other services already depend on. Every value is a
 * calendar day (yyyy-mm-dd) with no time zone, so no offset can move it; "today" itself always comes from
 * todayInKualaLumpur in ./hr-date.ts. Pure and dependency-free apart from the owner's own helpers. */
import {addCalendarMonths} from './hr-date';
import {isCalendarDate} from './calendar-date';

const DAY_MS=86_400_000;
const dayNumber=(day:string):number=>{
 if(!isCalendarDate(day))throw new Error('Not a calendar day.');
 return Math.floor(Date.parse(`${day}T00:00:00Z`)/DAY_MS);
};

/** Shift a calendar day by whole days. */
export function addCalendarDays(day:string,days:number):string{
 if(!Number.isSafeInteger(days)||Math.abs(days)>366_000)throw new Error('Invalid calendar day offset.');
 const value=new Date((dayNumber(day)+days)*DAY_MS).toISOString().slice(0,10);
 if(!isCalendarDate(value))throw new Error('Calendar result is outside the supported date range.');
 return value;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function calendarDaysBetween(from:string,to:string):number{
 return dayNumber(to)-dayNumber(from);
}

/** The weekday of a calendar day, Monday = 1 … Sunday = 7 (ISO 8601). Day 0 (1970-01-01) was a Thursday. */
export function isoWeekdayOf(day:string):number{
 return ((((dayNumber(day)+3)%7)+7)%7)+1;
}

/** The calendar days of a month ('YYYY-MM'), first to last. */
export function calendarMonthDays(month:string):string[]{
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new Error('Not a calendar month.');
 const first=`${month}-01`,next=addCalendarMonths(first,1);
 return Array.from({length:calendarDaysBetween(first,next)},(_,i)=>addCalendarDays(first,i));
}
