'use server';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { HolidayCalendarAssignmentError, saveEmploymentHolidayCalendarAssignment } from '@/core/holiday-calendar-assignment';
import type { HolidayCalendarSelection } from '@/core/org';

export async function saveHolidayCalendarAssignmentAction(form:FormData) {
  const session=await requireAdmin();
  const text=(name:string)=>String(form.get(name)??'').trim();
  const employmentId=text('employmentId'),choice=text('calendar');
  let selection:HolidayCalendarSelection;
  if(choice==='')selection={kind:'none'};
  else if(choice.startsWith('state:'))selection={kind:'state',state:choice.slice(6)};
  else if(choice.startsWith('group:'))selection={kind:'group',groupId:choice.slice(6)};
  else return {ok:false as const,error:'calendar' as const};
  try {
    const result=await saveEmploymentHolidayCalendarAssignment(session,{employmentId,replacesId:text('replacesId')||null,
      startDate:text('startDate'),endDate:text('endDate')||null,selection});
    for(const path of [`/admin/personnel/${employmentId}`,'/roster','/attendance/my-roster','/attendance/my-records','/leave'])revalidatePath(path);
    revalidatePath('/payroll/[batchId]','page');
    return {ok:true as const,updated:result.updated,reviewDates:result.reviewDates};
  }catch(error){
    if(error instanceof HolidayCalendarAssignmentError)return {ok:false as const,error:error.code};
    console.error('Dated holiday calendar save failed',error);
    return {ok:false as const,error:'failed' as const};
  }
}
