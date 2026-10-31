import {withTenant,type SessionContext} from '@/db/client';
import {originalHolidayCalendarFor} from '@/core/holidays';
import {replacementHolidayCalendarContext} from '@/core/holiday-replacement-read';
export async function personalCalendarHolidayContext(s:SessionContext,employmentId:string,from:string,to:string) {
 const [originals,replacements]=await Promise.all([withTenant(s,tx=>originalHolidayCalendarFor(tx,{employmentId,startDate:from,endDate:to})),replacementHolidayCalendarContext(s,{employmentId,from,to})]);
 return{originals,replacements};
}
