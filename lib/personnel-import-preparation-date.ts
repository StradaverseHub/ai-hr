/** Formatting proposals only, never HR date policy or spreadsheet-serial interpretation.
 * No raw-string Date.parse/rollover, century inference, calendar-era offset or time-zone conversion.
 */
import {isCalendarDate} from './calendar-date';
import {movementImportDate} from './movement-import-contract';
export type PersonnelDateFormatProposal=Readonly<{value:string;rule:'year_first'|'named_month'|'month_precision'}>;
const locales=['en','ms','zh','ta','th','vi'] as const;
let months:ReadonlyMap<string,number>|undefined;
const tokenKey=(value:string)=>value.normalize('NFC').toLowerCase().replace(/\s+/g,' ').trim();
function monthVocabulary(){
 if(months)return months;const possible=new Map<string,Set<number>>();
 for(const locale of locales)for(const style of ['short','long'] as const){const format=new Intl.DateTimeFormat(locale,{calendar:'gregory',numberingSystem:'latn',month:style,timeZone:'UTC'});
  for(let month=1;month<=12;month++){const value=tokenKey(format.format(new Date(Date.UTC(2000,month-1,1))));if(!value||/^\d+$/.test(value))continue;const known=possible.get(value)??new Set<number>();known.add(month);possible.set(value,known);}}
 const unique=new Map<string,number>();for(const [token,values] of possible)if(values.size===1)unique.set(token,[...values][0]);months=unique;return unique;
}
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
let namedPatterns:readonly Readonly<{month:number;dayFirst:RegExp;monthFirst:RegExp}>[]|undefined;
function namedMonthPatterns(){if(namedPatterns)return namedPatterns;namedPatterns=Object.freeze([...monthVocabulary()].map(([token,month])=>{const named=escape(token),separator=/\d/.test(token)?'[ .-]+':'[ .-]*',betweenYear=/\d/.test(token)?'[ ,.-]+':'[ ,.-]*';return Object.freeze({month,dayFirst:new RegExp(`^(\\d{1,2})${separator}${named}${betweenYear}((?!0000)\\d{4})$`,'u'),monthFirst:new RegExp(`^${named}${separator}(\\d{1,2})[ ,.-]+((?!0000)\\d{4})$`,'u')});}));return namedPatterns;}
const iso=(year:string,month:string|number,day:string)=>`${year}-${String(month).padStart(2,'0')}-${day.padStart(2,'0')}`;
export function proposePersonnelDateFormat(raw:string,precision:'day'|'month'):PersonnelDateFormatProposal|null{
 const value=raw.trim();if(!value||value.length>120)return null;
 if(precision==='month'){
  const match=/^((?!0000)\d{4})([/.])(\d{1,2})$/.exec(value);if(!match||Number(match[3])<1||Number(match[3])>12)return null;
  return Object.freeze({value:`${match[1]}-${match[3].padStart(2,'0')}`,rule:'month_precision'});
 }
 if(isCalendarDate(value))return null;
 const yearFirst=/^((?!0000)\d{4})([/.])(\d{1,2})\2(\d{1,2})$/.exec(value);
 if(yearFirst){const proposed=iso(yearFirst[1],yearFirst[3],yearFirst[4]);return isCalendarDate(proposed)?Object.freeze({value:proposed,rule:'year_first'}):null;}
 // Reuse the existing client-safe canonical DD-MMM-YYYY parser for its exact supported grammar.
 const existing=movementImportDate(value);if(existing&&existing!==value)return Object.freeze({value:existing,rule:'named_month'});
 if(!/\p{L}/u.test(value))return null;
 const normalized=tokenKey(value);
 // Cache only fixed locale vocabulary/patterns, never caller values or HR records.
 for(const {month,dayFirst,monthFirst} of namedMonthPatterns()){
  const parts=dayFirst.exec(normalized)??monthFirst.exec(normalized);if(!parts)continue;
  const proposed=iso(parts[2],month,parts[1]);if(isCalendarDate(proposed))return Object.freeze({value:proposed,rule:'named_month'});
 }
 return null;
}
