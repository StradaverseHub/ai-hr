/** The HR date owner's rule for the days people name in a request (lib/hr-date-phrase.ts) and the dates a chat request is
 * for (core/proposals/request-dates.ts). Owner, 5 November 2026: "Fix dates first"; eval 41843568709 (emp-apply-2,
 * "annual leave next friday" on Wednesday 4 November 2026) took 6 November on one pass and 13 November on the other.
 *
 * Every expected date below is written out by hand from the calendar (November 2026 starts on a Sunday; Monday 2 to Sunday 8
 * November is one week), never computed with the code under test. "now" is supplied, at noon in Kuala Lumpur unless a case
 * is about the time zone. Pure; no database. */
import {describe,expect,it} from 'vitest';
import {findDayPhrases,resolveDayPhrase,resolveRequestDay,weekdayOfDate,WEEKDAYS} from '../lib/hr-date-phrase';
import {requestDates,requestDatesView} from '../core/proposals/request-dates';

/** Noon in Kuala Lumpur (UTC+8) on that calendar day. */
const noon=(iso:string)=>new Date(iso+'T04:00:00.000Z');
/** The one phrase in `text`, resolved: "start" or "start..end", with " or other" for each other date; "none" when no day qualifies. */
function days(text:string,now:Date,notAfterToday=false):string{
 const phrases=findDayPhrases(text);
 expect(phrases,text).toHaveLength(1);
 const resolved=resolveDayPhrase(phrases[0],{now,notAfterToday});
 if(!resolved)return 'none';
 const one=(start:string,end:string)=>start===end?start:start+'..'+end;
 return [one(resolved.startDate,resolved.endDate),...resolved.others.map(other=>one(other.startDate,other.endDate))].join(' or ');
}

describe('next <weekday>: the first such weekday strictly after today, with next week\'s when it falls this week',()=>{
 it.each([
  ['2026-11-02','monday','2026-11-06 or 2026-11-13'],['2026-11-03','tuesday','2026-11-06 or 2026-11-13'],
  ['2026-11-04','wednesday','2026-11-06 or 2026-11-13'],['2026-11-05','thursday','2026-11-06 or 2026-11-13'],
  ['2026-11-06','friday','2026-11-13'],['2026-11-07','saturday','2026-11-13'],['2026-11-08','sunday','2026-11-13'],
 ])('on %s (%s), "next friday" is %s',(today,weekday,expected)=>{
  expect(weekdayOfDate(today)).toBe(weekday);
  expect(days('annual leave next friday',noon(today))).toBe(expected);
 });
 it('reads the Malay "Jumaat depan" the same way, and "this coming Friday" as the first one with no other date',()=>{
  expect(days('cuti Jumaat depan',noon('2026-11-04'))).toBe('2026-11-06 or 2026-11-13');
  expect(days('this coming friday',noon('2026-11-04'))).toBe('2026-11-06');
  expect(days('this coming friday',noon('2026-11-06'))).toBe('2026-11-13');
  expect(days('next mon',noon('2026-11-04'))).toBe('2026-11-09');
 });
});

describe('this, last and a weekday of a named week',()=>{
 it.each([
  ['this friday','2026-11-02','2026-11-06'],['this friday','2026-11-06','2026-11-06'],['this friday','2026-11-07','2026-11-06 or 2026-11-13'],
  ['this monday','2026-11-02','2026-11-02'],['this monday','2026-11-04','2026-11-02 or 2026-11-09'],
  ['last monday','2026-11-02','2026-10-26'],['last monday','2026-11-03','2026-11-02 or 2026-10-26'],['last monday','2026-11-08','2026-11-02 or 2026-10-26'],
  ['last friday','2026-11-04','2026-10-30'],['last saturday','2026-11-05','2026-10-31'],
  ['friday next week','2026-11-04','2026-11-13'],['next week friday','2026-11-04','2026-11-13'],['friday this week','2026-11-04','2026-11-06'],
  ['friday last week','2026-11-04','2026-10-30'],['Jumaat minggu depan','2026-11-04','2026-11-13'],
  ['下周五','2026-11-04','2026-11-13'],['这周五','2026-11-04','2026-11-06'],['本周一','2026-11-04','2026-11-02'],['上周五','2026-11-04','2026-10-30'],
  ['下星期天','2026-11-04','2026-11-15'],['plan overtime for me this Saturday from 9am to 1pm','2026-11-05','2026-11-07'],
 ])('"%s" on %s is %s',(text,today,expected)=>expect(days(text,noon(today))).toBe(expected));
});

describe('today, tomorrow, yesterday and the days either side, in three languages',()=>{
 it.each([
  ['today','2026-11-04'],['tomorrow','2026-11-05'],['tmr','2026-11-05'],['yesterday','2026-11-03'],['the day after tomorrow','2026-11-06'],
  ['the day before yesterday','2026-11-02'],['hari ini','2026-11-04'],['esok','2026-11-05'],['lusa','2026-11-06'],['semalam','2026-11-03'],
  ['今天','2026-11-04'],['帮我请明天的病假','2026-11-05'],['后天','2026-11-06'],['昨天','2026-11-03'],['前天','2026-11-02'],
 ])('"%s" on Wednesday 4 November 2026 is %s',(text,expected)=>expect(days(text,noon('2026-11-04'))).toBe(expected));
});

describe('weeks run Monday to Sunday',()=>{
 it.each([
  ['next week','2026-11-04','2026-11-09..2026-11-15'],['next week','2026-11-08','2026-11-09..2026-11-15'],['next week','2026-11-09','2026-11-16..2026-11-22'],
  ['this week','2026-11-04','2026-11-02..2026-11-08'],['last week','2026-11-04','2026-10-26..2026-11-01'],
  ['minggu depan','2026-11-04','2026-11-09..2026-11-15'],['下周','2026-11-04','2026-11-09..2026-11-15'],['这周','2026-11-04','2026-11-02..2026-11-08'],
 ])('"%s" on %s is %s',(text,today,expected)=>expect(days(text,noon(today))).toBe(expected));
});

describe('a day of the month: the first one from today on, with the last one before today when that is in another month',()=>{
 it.each([
  ['on the 13th','2026-11-04','2026-11-13'],['the 5th','2026-11-05','2026-11-05'],['the 3rd','2026-11-04','2026-12-03 or 2026-11-03'],
  ['the 30th','2026-11-04','2026-11-30'],['the 31st','2026-11-05','2026-12-31 or 2026-10-31'],['on the 13','2026-11-04','2026-11-13'],
  ['13hb','2026-11-04','2026-11-13'],['13号','2026-11-04','2026-11-13'],['the 13th','2026-11-20','2026-12-13 or 2026-11-13'],
 ])('"%s" on %s is %s',(text,today,expected)=>expect(days(text,noon(today))).toBe(expected));
});

describe('month and year boundaries, and the leap day',()=>{
 it.each([
  ['tomorrow','2026-10-31','2026-11-01'],['next monday','2026-10-31','2026-11-02'],['yesterday','2026-11-01','2026-10-31'],
  ['tomorrow','2026-12-31','2027-01-01'],['next friday','2026-12-31','2027-01-01 or 2027-01-08'],['next week','2026-12-31','2027-01-04..2027-01-10'],
  ['last friday','2027-01-01','2026-12-25'],['the 13th','2026-12-20','2027-01-13 or 2026-12-13'],
  ['tomorrow','2028-02-28','2028-02-29'],['the 30th','2028-02-28','2028-03-30 or 2028-01-30'],['yesterday','2028-03-01','2028-02-29'],
 ])('"%s" on %s is %s',(text,today,expected)=>expect(days(text,noon(today))).toBe(expected));
});

describe('the day is Kuala Lumpur\'s, from the supplied now, never the host\'s or UTC\'s',()=>{
 it('turns over at midnight in Kuala Lumpur, eight hours before UTC does',()=>{
  // 23:59 on Wednesday 4 November in Kuala Lumpur, then 00:30 on Thursday 5 November there (still 4 November in UTC).
  expect(days('tomorrow',new Date('2026-11-04T15:59:00.000Z'))).toBe('2026-11-05');
  expect(days('tomorrow',new Date('2026-11-04T16:30:00.000Z'))).toBe('2026-11-06');
  // One second before Friday in Kuala Lumpur "next friday" is tomorrow (or next week's); at midnight it is next week's only.
  expect(days('next friday',new Date('2026-11-05T15:59:59.000Z'))).toBe('2026-11-06 or 2026-11-13');
  expect(days('next friday',new Date('2026-11-05T16:00:00.000Z'))).toBe('2026-11-13');
 });
});

describe('a day already worked: only days up to today count',()=>{
 it.each([
  ['this monday','2026-11-02'],['this friday','none'],['next friday','none'],['tomorrow','none'],['last friday','2026-10-30'],
  ['last monday','2026-11-02 or 2026-10-26'],['the 3rd','2026-11-03'],['the 30th','2026-10-30'],['yesterday','2026-11-03'],['today','2026-11-04'],
  ['this week','none'],['last week','2026-10-26..2026-11-01'],
 ])('"%s" on Wednesday 4 November 2026 is %s',(text,expected)=>expect(days(text,noon('2026-11-04'),true)).toBe(expected));
});

describe('what is not a relative day',()=>{
 it('finds nothing in a date the person wrote out, a bare weekday, or words that only look like one',()=>{
  for(const text of ['13th November','November 13th','13th of November','13hb November','11月13日','2026-11-13','13/11','on friday','Friday',
   '这周天气很好','这周末','大前天','大后天','at 6:10pm, I just forgot to tap out','the 3 days I took','the 1st half of the day',''])
   expect(findDayPhrases(text),text).toEqual([]);
 });
 it('keeps the longer phrase where two overlap, and every phrase of a longer text in order',()=>{
  expect(findDayPhrases('next week friday').map(phrase=>phrase.rule)).toEqual(['weekday_next_week']);
  expect(findDayPhrases('the day after tomorrow').map(phrase=>phrase.rule)).toEqual(['day_after_tomorrow']);
  expect(findDayPhrases('I was off yesterday and want leave next friday').map(phrase=>phrase.phrase)).toEqual(['yesterday','next friday']);
 });
 it('names the weekdays Monday first',()=>{
  expect([...WEEKDAYS]).toEqual(['monday','tuesday','wednesday','thursday','friday','saturday','sunday']);
  expect(['2026-11-02','2026-11-08','2027-01-01','2028-02-29'].map(weekdayOfDate)).toEqual(['monday','sunday','friday','tuesday']);
 });
});

describe('one detail as the model passed it',()=>{
 const now=noon('2026-11-04');
 it('takes a real date as given, and the person\'s words for one day through the rule',()=>{
  expect(resolveRequestDay('2026-11-13',{now})).toEqual({startDate:'2026-11-13',endDate:'2026-11-13',others:[],phrase:null});
  expect(resolveRequestDay('next friday',{now})).toEqual({startDate:'2026-11-06',endDate:'2026-11-06',others:[{startDate:'2026-11-13',endDate:'2026-11-13'}],phrase:'next friday'});
  expect(resolveRequestDay('Next Friday',{now})).toMatchObject({startDate:'2026-11-06'});
 });
 it('names no date for a non-date, a written-out date, or two phrases at once, so the person is asked',()=>{
  for(const value of ['2026-02-30','Friday 13 November','sometime','tomorrow or next friday','',undefined,42])expect(resolveRequestDay(value,{now}),String(value)).toBeNull();
  expect(resolveRequestDay('tomorrow',{now,notAfterToday:true})).toBeNull();
 });
});

describe('the dates a chat request is for',()=>{
 const now=noon('2026-11-04');
 it('works out the person\'s phrase, keeping the other date it may mean',()=>{
  expect(requestDates('next friday','','annual leave next friday',{now})).toEqual({kind:'dates',dates:{startDate:'2026-11-06',endDate:'2026-11-06',others:['2026-11-13'],phrase:'next friday'}});
  expect(requestDates('next week','','leave next week please',{now})).toEqual({kind:'dates',dates:{startDate:'2026-11-09',endDate:'2026-11-15',others:[],phrase:'next week'}});
 });
 it('lets the person\'s own words decide over dates the model worked out, both passes alike',()=>{
  // The two passes of eval 41843568709: whichever date the model chose, the person's words give the same answer.
  for(const modelDate of ['2026-11-06','2026-11-13'])
   expect(requestDates(modelDate,'','annual leave next friday',{now})).toEqual({kind:'dates',dates:{startDate:'2026-11-06',endDate:'2026-11-06',others:['2026-11-13'],phrase:'next friday'}});
  expect(requestDates('2026-11-09','2026-11-13','leave next week',{now})).toMatchObject({dates:{startDate:'2026-11-09',endDate:'2026-11-15',phrase:'next week'}});
 });
 it('keeps the model\'s dates when the person wrote a date, named two days, or asked for a different shape',()=>{
  expect(requestDates('2026-11-13','','annual leave on 13 November',{now})).toEqual({kind:'dates',dates:{startDate:'2026-11-13',endDate:'2026-11-13',others:[],phrase:null}});
  expect(requestDates('2026-11-05','2026-11-06','leave tomorrow and the day after tomorrow',{now})).toMatchObject({dates:{startDate:'2026-11-05',endDate:'2026-11-06',phrase:null}});
  expect(requestDates('2026-11-09','2026-11-11','annual leave next friday',{now})).toMatchObject({dates:{startDate:'2026-11-09',endDate:'2026-11-11',phrase:null}});
  expect(requestDates('2026-11-13','',undefined,{now})).toMatchObject({dates:{startDate:'2026-11-13',phrase:null}});
 });
 it('drops the other date when the end is named separately, and says which detail is missing',()=>{
  expect(requestDates('next friday','2026-11-10','next friday to tuesday',{now})).toEqual({kind:'dates',dates:{startDate:'2026-11-06',endDate:'2026-11-10',others:[],phrase:'next friday'}});
  expect(requestDates('next friday','sometime','',{now})).toEqual({kind:'missing',missing:'end'});
  expect(requestDates('soon','','soon',{now})).toEqual({kind:'missing',missing:'start'});
  expect(requestDates('next week','','next week',{now,singleDay:true})).toEqual({kind:'missing',missing:'start'});
  expect(requestDates('tomorrow','','I forgot to clock out tomorrow',{now,notAfterToday:true,singleDay:true})).toEqual({kind:'missing',missing:'start'});
 });
 it('tells the model each date with its weekday',()=>{
  expect(requestDatesView({startDate:'2026-11-06',endDate:'2026-11-06',others:['2026-11-13']})).toEqual({startDate:'2026-11-06',startDay:'friday',endDate:'2026-11-06',endDay:'friday',others:[{date:'2026-11-13',day:'friday'}]});
  expect(requestDatesView({startDate:'2026-11-09',endDate:'2026-11-15'})).toEqual({startDate:'2026-11-09',startDay:'monday',endDate:'2026-11-15',endDay:'sunday'});
 });
});
