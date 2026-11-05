/**
 * The HR date owner's rule for the days people name in a request ("annual leave next friday", "I forgot to clock out
 * yesterday", "帮我请明天的病假"). A sibling of ./hr-date.ts, which it reads "today" from: every date here is a calendar day
 * in the company's time zone (Asia/Kuala_Lumpur), worked out from a supplied "now", never from the host's clock or the
 * model. Pure and dependency-free.
 *
 * THE RULES (weeks run Monday to Sunday):
 *  - today, tomorrow, yesterday (also "the day after tomorrow", "the day before yesterday"): that many days from today.
 *  - next <weekday>: the first such weekday strictly after today. When that day falls in the current week, the same
 *    weekday of next week is returned as the other date the person may have meant (on Wednesday 4 November 2026, "next
 *    Friday" is Friday 6 November, or Friday 13 November).
 *  - this coming <weekday>: the first such weekday strictly after today, with no other date.
 *  - this <weekday>: that weekday in the current week. When it is already past, the same weekday of next week is the
 *    other date.
 *  - last <weekday>: the last such weekday strictly before today. When that day falls in the current week, the same
 *    weekday of last week is the other date.
 *  - <weekday> next week, <weekday> this week, <weekday> last week (and 下周五, Jumaat minggu depan): that weekday of
 *    that week, with no other date.
 *  - next week, this week, last week: Monday to Sunday of that week.
 *  - on the 13th (13hb, 13号): the first day numbered 13 from today on, today included. When that is not in the current
 *    month, the last one before today is the other date (on 20 November, "the 13th" is 13 December, or 13 November).
 *  - With `notAfterToday` (a correction of a day already worked), only days up to today count: a day-of-month phrase is
 *    the last such day up to today, and a phrase whose days are all after today names no date.
 * Malay (hari ini, esok, lusa, semalam, Jumaat depan/ini/lepas, minggu depan, 13hb) and Chinese (今天, 明天, 后天, 昨天,
 * 前天, 这周五, 下周五, 上周五, 下周, 13号) say the same things; a bare weekday, or a day with a month ("13 November"), is not
 * a relative phrase and is left to the person's own date.
 */
import {todayInKualaLumpur} from './hr-date';

const DAY_MS=86_400_000;
const dayNumber=(iso:string)=>Math.floor(Date.parse(iso+'T00:00:00.000Z')/DAY_MS);
const isoOf=(day:number)=>new Date(day*DAY_MS).toISOString().slice(0,10);
/** 0 = Monday … 6 = Sunday. Day 0 (1970-01-01) was a Thursday. */
const weekdayOf=(day:number)=>(((day+3)%7)+7)%7;
const mondayOf=(day:number)=>day-weekdayOf(day);
const daysInMonth=(year:number,month:number)=>new Date(Date.UTC(year,month+1,0)).getUTCDate();

/** The weekdays, Monday first, as the rules and the card name them. */
export const WEEKDAYS=['monday','tuesday','wednesday','thursday','friday','saturday','sunday'] as const;
export type Weekday=typeof WEEKDAYS[number];
/** The weekday of a calendar day (YYYY-MM-DD). */
export const weekdayOfDate=(iso:string):Weekday=>WEEKDAYS[weekdayOf(dayNumber(iso))];

export type DayPhraseRule='today'|'tomorrow'|'day_after_tomorrow'|'yesterday'|'day_before_yesterday'
 |'this_weekday'|'next_weekday'|'coming_weekday'|'last_weekday'|'weekday_this_week'|'weekday_next_week'|'weekday_last_week'
 |'this_week'|'next_week'|'last_week'|'day_of_month';
/** One phrase found in a text: what it says, before any date is worked out. */
export type DayPhrase=Readonly<{phrase:string;rule:DayPhraseRule;weekday?:number;dayOfMonth?:number}>;
export type DaySpan=Readonly<{startDate:string;endDate:string}>;
/** The days a phrase names: the chosen span, and the other spans the person may have meant (most phrases: none). */
export type DayResolution=DaySpan&Readonly<{phrase:string;rule:DayPhraseRule;others:readonly DaySpan[]}>;
export type DayPhraseOptions=Readonly<{now?:Date;notAfterToday?:boolean}>;

const EN_DAY='(monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)';
const MS_DAY='(isnin|selasa|rabu|khamis|jumaat|jumat|sabtu|ahad)';
const ZH_UNIT='(?:周|週|星期|礼拜|禮拜)';
const ZH_DAY='([一二三四五六日]|天(?![气氣]))';
const MONTH_WORD='(?:jan|january|januari|feb|february|februari|mar|march|mac|apr|april|may|mei|jun|june|jul|july|julai|aug|august|ogos|sep|sept|september|oct|october|oktober|okt|nov|november|dec|december|disember|dis)';
const weekdayIndex=(word:string):number=>{
 const w=word.toLowerCase();
 if(/^mon|^isnin/.test(w)||w==='一')return 0;if(/^tue|^selasa/.test(w)||w==='二')return 1;if(/^wed|^rabu/.test(w)||w==='三')return 2;
 if(/^thu|^khamis/.test(w)||w==='四')return 3;if(/^fri|^juma/.test(w)||w==='五')return 4;if(/^sat|^sabtu/.test(w)||w==='六')return 5;return 6;
};
const relation=(word:string):'this'|'next'|'last'|'coming'=>{
 const w=word.replace(/\s+/g,' ');
 if(/coming/.test(w))return 'coming';
 if(/^(next|depan|hadapan|下)/.test(w))return 'next';
 if(/^(last|previous|past|lepas|lalu|yang lepas|yang lalu|上)/.test(w))return 'last';
 return 'this';
};
type Matcher=Readonly<{pattern:RegExp;read:(match:RegExpExecArray)=>Omit<DayPhrase,'phrase'>|null}>;
const fixed=(rule:DayPhraseRule)=>()=>({rule});
const weekRule=(which:string)=>{const r=relation(which);return r==='next'||r==='coming'?'next_week' as const:r==='last'?'last_week' as const:'this_week' as const;};
const weekdayOfWeek=(which:string,day:string)=>{const r=relation(which);
 return{rule:r==='next'||r==='coming'?'weekday_next_week' as const:r==='last'?'weekday_last_week' as const:'weekday_this_week' as const,weekday:weekdayIndex(day)};};
const weekdayRelative=(which:string,day:string)=>{const r=relation(which);
 return{rule:r==='coming'?'coming_weekday' as const:r==='next'?'next_weekday' as const:r==='last'?'last_weekday' as const:'this_weekday' as const,weekday:weekdayIndex(day)};};
const monthDay=(value:string)=>{const n=Number(value);return Number.isInteger(n)&&n>=1&&n<=31?{rule:'day_of_month' as const,dayOfMonth:n}:null;};
/** A day number next to a month word is a date the person gave ("13th November"), not a relative phrase. */
const NOT_A_MONTH_AFTER=`(?![\\s,]*(?:of\\s+)?${MONTH_WORD}\\b)(?![\\s]*[/.-]\\s*\\d)(?!\\s+half\\b)`;
const MATCHERS:readonly Matcher[]=[
 // English.
 {pattern:/\b(?:the\s+)?day\s+after\s+(?:tomorrow|tmrw?)\b/g,read:fixed('day_after_tomorrow')},
 {pattern:/\b(?:the\s+)?day\s+before\s+yesterday\b/g,read:fixed('day_before_yesterday')},
 {pattern:/\btoday\b/g,read:fixed('today')},
 {pattern:/\b(?:tomorrow|tmrw?|tomoro|tomorow)\b/g,read:fixed('tomorrow')},
 {pattern:/\b(?:yesterday|ytd|yday)\b/g,read:fixed('yesterday')},
 {pattern:new RegExp(`\\b(this\\s+coming|coming|this|next|last|previous|past)\\s+${EN_DAY}\\b`,'g'),read:m=>weekdayRelative(m[1],m[2])},
 {pattern:new RegExp(`\\b${EN_DAY}\\s+(?:of\\s+)?(this|next|last|the\\s+coming|coming)\\s+week\\b`,'g'),read:m=>weekdayOfWeek(m[2],m[1])},
 {pattern:new RegExp(`\\b(this|next|last|the\\s+coming|coming)\\s+week(?:'s)?\\s+${EN_DAY}\\b`,'g'),read:m=>weekdayOfWeek(m[1],m[2])},
 {pattern:/\b(this|next|last|previous|the\s+coming|coming)\s+week\b/g,read:m=>({rule:weekRule(m[1])})},
 {pattern:new RegExp(`(?<!${MONTH_WORD}\\.?\\s{0,3})\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)\\b${NOT_A_MONTH_AFTER}`,'g'),read:m=>monthDay(m[1])},
 {pattern:new RegExp(`\\bon\\s+the\\s+(\\d{1,2})\\b${NOT_A_MONTH_AFTER}`,'g'),read:m=>monthDay(m[1])},
 // Malay.
 {pattern:/\bhari\s+ini\b/g,read:fixed('today')},
 {pattern:/\b(?:esok|besok)\b/g,read:fixed('tomorrow')},
 {pattern:/\blusa\b/g,read:fixed('day_after_tomorrow')},
 {pattern:/\b(?:semalam|smlm)\b/g,read:fixed('yesterday')},
 {pattern:new RegExp(`\\b(?:hari\\s+)?${MS_DAY}\\s+minggu\\s+(ini|depan|hadapan|lepas|lalu)\\b`,'g'),read:m=>weekdayOfWeek(m[2],m[1])},
 {pattern:new RegExp(`\\b(?:hari\\s+)?${MS_DAY}\\s+(ini|depan|hadapan|yang\\s+lepas|yang\\s+lalu|lepas|lalu)\\b`,'g'),read:m=>weekdayRelative(m[2],m[1])},
 {pattern:/\bminggu\s+(ini|depan|hadapan|lepas|lalu)\b/g,read:m=>({rule:weekRule(m[1])})},
 {pattern:new RegExp(`\\b(?:pada\\s+)?(\\d{1,2})\\s*(?:hb|haribulan|hari\\s+bulan)\\b${NOT_A_MONTH_AFTER}`,'g'),read:m=>monthDay(m[1])},
 // Chinese.
 {pattern:/(?<!大)(?:今天|今日)/g,read:fixed('today')},
 {pattern:/(?:明天|明日)/g,read:fixed('tomorrow')},
 {pattern:/(?<!大)(?:后天|後天)/g,read:fixed('day_after_tomorrow')},
 {pattern:/(?:昨天|昨日)/g,read:fixed('yesterday')},
 {pattern:/(?<!大)前天/g,read:fixed('day_before_yesterday')},
 {pattern:new RegExp(`(这个|這個|这|這|本|下个|下個|下|上个|上個|上)${ZH_UNIT}${ZH_DAY}`,'g'),read:m=>weekdayOfWeek(m[1],m[2])},
 {pattern:new RegExp(`(这个|這個|这|這|本|下个|下個|下|上个|上個|上)${ZH_UNIT}(?![一二三四五六日天末])`,'g'),read:m=>({rule:weekRule(m[1])})},
 {pattern:/(?<![\d月]\s*)(?<!\d)(\d{1,2})\s*(?:号|號|日)(?!\d)/g,read:m=>monthDay(m[1])},
];

/** Every relative day phrase in a text, in order, without overlaps (the longest wins where two start together). Pure. */
export function findDayPhrases(text:string):DayPhrase[]{
 if(typeof text!=='string'||!text.trim())return [];
 const words=text.normalize('NFKC').toLowerCase();
 const found:{start:number;end:number;phrase:DayPhrase}[]=[];
 for(const matcher of MATCHERS){
  matcher.pattern.lastIndex=0;
  for(let match=matcher.pattern.exec(words);match;match=matcher.pattern.exec(words)){
   const read=matcher.read(match);
   if(read)found.push({start:match.index,end:match.index+match[0].length,phrase:Object.freeze({phrase:match[0].trim(),...read})});
   if(match[0].length===0)matcher.pattern.lastIndex++;
  }
 }
 found.sort((a,b)=>a.start-b.start||(b.end-b.start)-(a.end-a.start));
 const kept:typeof found=[];
 for(const item of found){
  const clash=kept.findIndex(other=>item.start<other.end&&other.start<item.end);
  if(clash<0){kept.push(item);continue;}
  // A longer phrase covering a shorter one replaces it ("next week friday" over "next week").
  if(item.end-item.start>kept[clash].end-kept[clash].start)kept[clash]=item;
 }
 return kept.sort((a,b)=>a.start-b.start).map(item=>item.phrase);
}

const span=(start:number,end=start):DaySpan=>Object.freeze({startDate:isoOf(start),endDate:isoOf(end)});
/** The days one phrase names, from today in Kuala Lumpur. Null when no day qualifies (with notAfterToday). Pure. */
export function resolveDayPhrase(phrase:DayPhrase,options:DayPhraseOptions={}):DayResolution|null{
 const today=dayNumber(todayInKualaLumpur(options.now??new Date())),monday=mondayOf(today),weekday=today-monday;
 let chosen:DaySpan,others:DaySpan[]=[];
 const target=phrase.weekday??0;
 switch(phrase.rule){
  case 'today':chosen=span(today);break;
  case 'tomorrow':chosen=span(today+1);break;
  case 'day_after_tomorrow':chosen=span(today+2);break;
  case 'yesterday':chosen=span(today-1);break;
  case 'day_before_yesterday':chosen=span(today-2);break;
  case 'this_weekday':{const day=monday+target;chosen=span(day);if(day<today)others=[span(day+7)];break;}
  case 'next_weekday':case 'coming_weekday':{const day=today+(((target-weekday+7)%7)||7);chosen=span(day);
   if(phrase.rule==='next_weekday'&&day<monday+7)others=[span(day+7)];break;}
  case 'last_weekday':{const day=today-(((weekday-target+7)%7)||7);chosen=span(day);if(day>=monday)others=[span(day-7)];break;}
  case 'weekday_this_week':chosen=span(monday+target);break;
  case 'weekday_next_week':chosen=span(monday+7+target);break;
  case 'weekday_last_week':chosen=span(monday-7+target);break;
  case 'this_week':chosen=span(monday,monday+6);break;
  case 'next_week':chosen=span(monday+7,monday+13);break;
  case 'last_week':chosen=span(monday-7,monday-1);break;
  case 'day_of_month':{
   const n=phrase.dayOfMonth??0,[year,month]=isoOf(today).split('-').map(Number);
   // The months around today that have a day numbered n, as day numbers, earliest first.
   const days:number[]=[];
   for(let offset=-13;offset<=13;offset++){const y=year+Math.floor((month-1+offset)/12),m=(((month-1+offset)%12)+12)%12;
    if(n<=daysInMonth(y,m))days.push(Math.floor(Date.UTC(y,m,n)/DAY_MS));}
   const past=days.filter(day=>day<=today).at(-1),coming=days.find(day=>day>=today);
   if(options.notAfterToday)return past===undefined?null:Object.freeze({...span(past),phrase:phrase.phrase,rule:phrase.rule,others:Object.freeze([])});
   if(coming===undefined)return null;
   chosen=span(coming);
   const before=days.filter(day=>day<today).at(-1);
   if(isoOf(coming).slice(0,7)!==isoOf(today).slice(0,7)&&before!==undefined)others=[span(before)];
   break;
  }
  default:return null;
 }
 if(options.notAfterToday){
  const latest=isoOf(today),fits=(row:DaySpan)=>row.endDate<=latest;
  const candidates=[chosen,...others].filter(fits);
  if(!candidates.length)return null;
  [chosen,...others]=candidates;
 }
 return Object.freeze({...chosen,phrase:phrase.phrase,rule:phrase.rule,others:Object.freeze(others)});
}

const ISO=/^\d{4}-\d{2}-\d{2}$/;
const realDay=(value:string)=>ISO.test(value)&&isoOf(dayNumber(value))===value;
/**
 * One detail of a request as the model passed it: a date (YYYY-MM-DD, taken as given) or the person's own words for the
 * day, which must hold exactly one relative phrase. Null when it is neither, so the person is asked. Pure.
 */
export function resolveRequestDay(value:unknown,options:DayPhraseOptions={}):(DaySpan&Readonly<{others:readonly DaySpan[];phrase:string|null}>)|null{
 if(typeof value!=='string'||!value.trim())return null;
 const given=value.trim();
 if(ISO.test(given))return realDay(given)?Object.freeze({startDate:given,endDate:given,others:Object.freeze([]),phrase:null}):null;
 const phrases=findDayPhrases(given);
 if(phrases.length!==1)return null;
 const resolved=resolveDayPhrase(phrases[0],options);
 return resolved?Object.freeze({startDate:resolved.startDate,endDate:resolved.endDate,others:resolved.others,phrase:resolved.phrase}):null;
}
