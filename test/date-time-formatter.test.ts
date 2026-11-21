import {expect,it} from 'vitest';
import {dateTimeFormatter} from '../lib/date-time-formatter';
it.each(['en','ms','zh','ta','th','vi'])('preserves native date output and fresh instants in %s',locale=>{
 for(const timeZone of ['UTC','Asia/Kuala_Lumpur'])for(const options of [
  {day:'numeric',month:'short',timeZone},
  {dateStyle:'medium',timeStyle:'short',timeZone},
  {weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone},
 ] as const){
  const cached=dateTimeFormatter(locale,options),native=new Intl.DateTimeFormat(locale,options);
  for(const instant of ['2026-12-31T15:59:59.999Z','2026-12-31T16:00:00Z','2024-02-29T00:00:00Z'])expect(cached.format(new Date(instant))).toBe(native.format(new Date(instant)));
 }
});
it('reuses the same locale/options without retaining the previous formatted date',()=>{
 const options={dateStyle:'medium',timeZone:'UTC'} as const;
 const first=dateTimeFormatter('en',options);
 expect(dateTimeFormatter('en',{timeZone:'UTC',dateStyle:'medium'})).toBe(first);
 expect(first.format(new Date('2026-12-31T23:59:59Z'))).not.toBe(first.format(new Date('2027-01-01T00:00:00Z')));
 expect(dateTimeFormatter('zh',options)).not.toBe(first);
});
it('bounds retained formatter configurations and preserves native invalid-option failures',()=>{
 const options={dateStyle:'medium',timeZone:'UTC'} as const;
 const first=dateTimeFormatter('en-x-oldcache',options);
 for(let n=0;n<72;n++)dateTimeFormatter('en-x-fmt'+String(n).padStart(4,'0'),options);
 expect(dateTimeFormatter('en-x-oldcache',options)).not.toBe(first);
 expect(()=>dateTimeFormatter('en',{timeZone:'Not/A_Timezone'})).toThrow(RangeError);
});
