/** Independent support reads for the HR employee record. Keep batches small: the page
 * and its shared shell use the same database pool. Owners still enforce their own RLS. */
import type {SessionContext} from '../db/client';
import {isAdmin} from '../lib/authz';
import {directSuperiorHistoryFor, getCompanyCurrency} from './read';
import {listHolidayGroups, listPositions, listBusinessUnits} from './admin';
import {employmentHolidayCalendarHistory} from './holiday-calendar-assignment';
import {employmentScheduleGroupId} from './roster';
import {listAttendanceRules} from '../packs/attendance/service';
import {listLocations} from './location';
import {listDependents} from './dependents';
import {listQualifications} from './qualifications';
import {listEmergencyContacts} from './emergency-contacts';

export async function personnelDetailSupport(ctx: SessionContext, subject: {
  employmentId: string; personId: string; companyId: string;
}) {
  const admin = isAdmin(ctx);
  const {employmentId, personId, companyId} = subject;
  const [holidayGroups, holidayCalendarRows, scheduleGroupCurrentId, attendanceRules] = await Promise.all([
    admin ? listHolidayGroups(ctx) : Promise.resolve([]),
    admin ? employmentHolidayCalendarHistory(ctx, employmentId) : Promise.resolve([]),
    admin ? employmentScheduleGroupId(ctx, employmentId) : Promise.resolve(null),
    admin ? listAttendanceRules(ctx) : Promise.resolve([]),
  ]);
  const [positions, businessUnits, locations, defaultSalaryCurrency] = await Promise.all([
    admin ? listPositions(ctx, {companyIds: [companyId]}) : Promise.resolve([]),
    admin ? listBusinessUnits(ctx, {companyIds: [companyId]}) : Promise.resolve([]),
    admin ? listLocations(ctx, [companyId]) : Promise.resolve([]),
    admin ? getCompanyCurrency(ctx, companyId) : Promise.resolve('MYR'),
  ]);
  const [dependents, qualifications, emergencyContacts, superiorHistory] = await Promise.all([
    admin ? listDependents(ctx, {personId}) : Promise.resolve([]),
    admin ? listQualifications(ctx, {employmentId}) : Promise.resolve([]),
    admin ? listEmergencyContacts(ctx, {personId}) : Promise.resolve([]),
    admin ? directSuperiorHistoryFor(ctx, employmentId) : Promise.resolve([]),
  ]);
  return {holidayGroups, holidayCalendarRows, scheduleGroupCurrentId, attendanceRules,
    positions, businessUnits, locations, defaultSalaryCurrency, dependents, qualifications,
    emergencyContacts, superiorHistory};
}
