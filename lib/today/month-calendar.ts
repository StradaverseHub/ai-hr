/** Employee Today (owner decision, 11 Nov 2026: the bento one-pager): the month calendar, as data.
 *
 * Pure. Every day comes from the HR date owner (lib/hr-date.ts); the facts marked on a day are passed in by the panel,
 * which read each from its own owner (due dates from the Before payroll checklist, the cut-off from the payroll period
 * owner, paydays, holidays and the person's own leave from the Home calendar owner). Nothing here decides a date.
 * Weeks run Monday to Sunday, as the HR date owner's day phrases do (lib/hr-date-phrase.ts). */
import {calendarMonthDays,isoWeekdayOf} from '../hr-date-calendar';

/** What can be marked on a day, in the order a day shows them (the first is the day's main mark). */
export const CALENDAR_MARKS=Object.freeze(['payday','cutoff','due','fix','leave','holiday'] as const);
export type CalendarMark=(typeof CALENDAR_MARKS)[number];
export type CalendarFact=Readonly<{date:string;mark:CalendarMark}>;

export type CalendarCell=Readonly<{
 /** null: a blank before the first or after the last day of the month. */
 date:string|null;
 /** The day of the month, 1–31; 0 for a blank. */
 day:number;
 today:boolean;
 /** Before today (shown quieter). */
 past:boolean;
 /** Saturday or Sunday. */
 weekend:boolean;
 /** The marks on this day, in CALENDAR_MARKS order, each once. */
 marks:readonly CalendarMark[];
}>;
export type MonthCalendar=Readonly<{month:string;weeks:readonly (readonly CalendarCell[])[]}>;

const BLANK:CalendarCell=Object.freeze({date:null,day:0,today:false,past:false,weekend:false,marks:Object.freeze([])});

/** The month that contains `today`, Monday-first, in whole weeks, with each fact on its day. A fact outside the month
 * is left out. Deterministic: the same inputs always give the same cells, whatever order the facts arrive in. */
export function buildMonthCalendar(today:string,facts:readonly CalendarFact[]=[]):MonthCalendar{
 const month=today.slice(0,7),days=calendarMonthDays(month);
 if(!days.includes(today))throw new Error('Not a calendar day.');
 const byDay=new Map<string,Set<CalendarMark>>();
 for(const fact of facts){
  if(fact.date.slice(0,7)!==month||!(CALENDAR_MARKS as readonly string[]).includes(fact.mark))continue;
  (byDay.get(fact.date)??byDay.set(fact.date,new Set()).get(fact.date)!).add(fact.mark);
 }
 const cells:CalendarCell[]=Array.from({length:isoWeekdayOf(days[0])-1},()=>BLANK);
 for(const date of days){
  const marks=byDay.get(date),weekday=isoWeekdayOf(date);
  cells.push(Object.freeze({date,day:Number(date.slice(8,10)),today:date===today,past:date<today,weekend:weekday>=6,
   marks:Object.freeze(marks?CALENDAR_MARKS.filter(mark=>marks.has(mark)):[])}));
 }
 while(cells.length%7!==0)cells.push(BLANK);
 const weeks:(readonly CalendarCell[])[]=[];
 for(let i=0;i<cells.length;i+=7)weeks.push(Object.freeze(cells.slice(i,i+7)));
 return Object.freeze({month,weeks:Object.freeze(weeks)});
}
