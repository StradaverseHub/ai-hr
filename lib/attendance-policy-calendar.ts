/** Shared shape, not an authorization or immutable calculation receipt. The canonical Attendance
 * reader supplies these facts; consumers must record and revalidate their complete source inputs. */
import type {AttendancePolicyDayClass} from './attendance-group-policy';
export type PolicyMoneyDay='workday'|'rest_day'|'holiday';
export const ATTENDANCE_POLICY_MONEY_DAY:Record<AttendancePolicyDayClass,PolicyMoneyDay>={
  normal:'workday',off:'workday',rest:'rest_day',publicHoliday:'holiday',replacementHoliday:'holiday',
};
export type PolicyCalendarProof={date:string}&({
  state:'known';dayClass:AttendancePolicyDayClass;moneyDay:PolicyMoneyDay;
  references:string[];
}|{state:'unknown';reason:'calendarUnavailable'|'holidayDesignationUnavailable'});
