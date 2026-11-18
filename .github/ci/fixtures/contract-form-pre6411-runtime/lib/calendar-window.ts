/** Strict civil-date window for bounded metadata readers. Date.parse alone normalizes February 31. */
export function calendarWindowDates(from:string,to:string,maxDays=62):string[]{
 const valid=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))
  &&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
 const span=(Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000;
 if(!valid(from)||!valid(to)||!Number.isInteger(span)||span<0||span>=maxDays)throw Error('Invalid calendar window.');
 return Array.from({length:span+1},(_,offset)=>new Date(Date.parse(from+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10));
}
