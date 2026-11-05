/** The dates a request prepared in chat is for (owner, 5 November 2026: "Fix dates first", and "Next week's Friday" for
 * the rule itself). The model passes the person's own words for a day ("next friday", "yesterday", "esok", "明天") or a
 * date (YYYY-MM-DD); the HR date owner's rule (lib/hr-date-phrase.ts) turns the words into dates in Kuala Lumpur, so the
 * same words give the same dates on every pass. When the model passed dates it worked out itself but the person's own words this turn name exactly one relative
 * day and no explicit date, the person's words decide (eval 41843568709, emp-apply-2: "next friday" was 6 November on one
 * pass and 13 November on the other). A phrase the rule finds ambiguous keeps its other dates, so the card can offer
 * them. Nothing here checks a leave or attendance rule: the owning services still decide. Pure. */
import {findDayPhrases,resolveDayPhrase,resolveRequestDay,weekdayOfDate,type DaySpan,type Weekday} from '../../lib/hr-date-phrase';

export type RequestDates=Readonly<{startDate:string;endDate:string;
 /** Other single days the person's words may mean, in the rule's order (at most two). */
 others:readonly string[];
 /** The person's phrase the dates came from, or null for a date given as a date. */
 phrase:string|null}>;
export type RequestDatesResult=Readonly<{kind:'dates';dates:RequestDates}>|Readonly<{kind:'missing';missing:'start'|'end'}>;
export type RequestDateOptions=Readonly<{now?:Date;
 /** A correction of a day already worked: only days up to today count. */
 notAfterToday?:boolean;
 /** One day only (an attendance day): a week phrase names no date. */
 singleDay?:boolean}>;

/** A date written out in the person's words ("13 November", "13/11", "2026-11-13", "11月13日"): theirs, never overruled. */
const EXPLICIT_DATE=/\d{4}-\d{2}-\d{2}|(?<!\d)\d{1,2}\s*[/.]\s*\d{1,2}(?!\d)|\d\s*月\s*\d|(?<!\d)\d{1,2}(?:st|nd|rd|th|hb)?\s+(?:of\s+)?(?:jan|feb|mar|mac|apr|may|mei|jun|jul|aug|ogos|sep|oct|okt|nov|dec|dis)[a-z]*\b|\b(?:jan|feb|mar|mac|apr|may|mei|jun|jul|aug|ogos|sep|oct|okt|nov|dec|dis)[a-z]*\.?\s+\d{1,2}(?!\d)/i;
const singles=(rows:readonly DaySpan[])=>rows.filter(row=>row.startDate===row.endDate).map(row=>row.startDate).slice(0,2);

/** The person's own words decide when they name exactly one relative day and no date, and the model's dates have the
 * same shape (one day, or a span for a week phrase). Null otherwise. */
function fromPersonWords(personWords:string|undefined,startDate:string,endDate:string,options:RequestDateOptions):RequestDates|null{
 if(typeof personWords!=='string'||EXPLICIT_DATE.test(personWords.normalize('NFKC')))return null;
 const phrases=findDayPhrases(personWords);
 if(phrases.length!==1)return null;
 const resolved=resolveDayPhrase(phrases[0],options);
 if(!resolved||(resolved.startDate===resolved.endDate)!==(startDate===endDate))return null;
 if(options.singleDay&&resolved.startDate!==resolved.endDate)return null;
 return Object.freeze({startDate:resolved.startDate,endDate:resolved.endDate,others:Object.freeze(singles(resolved.others)),phrase:resolved.phrase});
}

/** The dates for a request from the model's start and end details (either may be a date or the person's words; an empty
 * end is the start's own end) and the person's words this turn. Missing when a detail names no day. Pure. */
export function requestDates(start:string,end:string,personWords:string|undefined,options:RequestDateOptions={}):RequestDatesResult{
 const first=resolveRequestDay(start,options);
 if(!first||(options.singleDay&&first.startDate!==first.endDate))return Object.freeze({kind:'missing',missing:'start'});
 const last=end.trim()?resolveRequestDay(end,options):null;
 if(end.trim()&&!last)return Object.freeze({kind:'missing',missing:'end'});
 const endDate=last?last.endDate:first.endDate;
 // Both are dates the model worked out: the person's own words this turn decide when they name one relative day.
 if(first.phrase===null&&(last===null||last.phrase===null)){
  const words=fromPersonWords(personWords,first.startDate,endDate,options);
  if(words)return Object.freeze({kind:'dates',dates:words});
 }
 // Other dates only for one day named by one phrase: a separately named end makes the request a span of its own.
 const others=last===null||last.phrase===first.phrase&&last.startDate===first.startDate?singles(first.others):[];
 return Object.freeze({kind:'dates',dates:Object.freeze({startDate:first.startDate,endDate,others:Object.freeze(others),phrase:first.phrase})});
}

/** What a tool result tells the model about the dates: each with its weekday, so the reply names both correctly. */
export type RequestDatesView=Readonly<{startDate:string;startDay:Weekday;endDate:string;endDay:Weekday;others?:readonly Readonly<{date:string;day:Weekday}>[]}>;
export function requestDatesView(dates:Readonly<{startDate:string;endDate:string;others?:readonly string[]}>):RequestDatesView{
 const others=(dates.others??[]).map(date=>Object.freeze({date,day:weekdayOfDate(date)}));
 return Object.freeze({startDate:dates.startDate,startDay:weekdayOfDate(dates.startDate),endDate:dates.endDate,endDay:weekdayOfDate(dates.endDate),
  ...(others.length?{others:Object.freeze(others)}:{})});
}
