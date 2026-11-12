/** 96a54ed2 — attendance_on_behalf_subjects and attendance_on_behalf_approvers: the Request On Behalf and Approve On
 * Behalf pages as a person who may act on behalf may ask about them in chat
 * (core/semantic-model/entities-attendance-on-behalf.ts), served as operations_status topics of the same names.
 *
 * Authorize first, through the page's own owner: canActOnBehalf (the permission key, company by company) refuses a
 * caller who does not hold it, not_permitted, before any person is read. Then exactly the page's first list:
 * searchAttendanceOnBehalfSubjects with an empty search and page 0, run AS THE CALLER under tenant row-level security,
 * which keeps only companies where the caller holds the key and, within them, companies the caller administers as HR
 * or people beneath the caller in their own reporting line. One bounded, set-based statement (25 rows); no loop per
 * company or per person.
 *
 * Copies only the declared fields: each person's name, company, department and position, in the page's order, and
 * whether the page has more. Never an employment id or an employee code. Read only: filing and deciding on behalf stay
 * human-only actions on the pages. */
import type {SessionContext} from '../../db/client';
import {canActOnBehalf,searchAttendanceOnBehalfSubjects,type AttendanceOnBehalfPurpose} from '../../packs/attendance/service';
import {ATTENDANCE_APPROVE_ON_BEHALF_PAGE,ATTENDANCE_REQUEST_ON_BEHALF_PAGE} from '../semantic-model/entities-attendance-on-behalf';
import {provenance,refuse,type ExplainerOutcome} from './outcome';

const PAGES:Readonly<Record<AttendanceOnBehalfPurpose,string>>={request:ATTENDANCE_REQUEST_ON_BEHALF_PAGE,approve:ATTENDANCE_APPROVE_ON_BEHALF_PAGE};
const NOTES:Readonly<Record<AttendanceOnBehalfPurpose,string>>={
 request:'The first page of employees this person may file attendance requests for, read under their own access and permission. Requests are filed on the Request On Behalf page and follow each employee\'s own approval workflow.',
 approve:'The first page of designated approvers this person may decide waiting attendance requests for, read under their own access and permission. Decisions are made on the Approve On Behalf page and are recorded as made on the approver\'s behalf.',
};

export async function attendanceOnBehalfPeople(ctx:SessionContext,purpose:AttendanceOnBehalfPurpose):Promise<ExplainerOutcome>{
 if(!await canActOnBehalf(ctx,purpose))return refuse('not_permitted',purpose==='request'
  ?'Request On Behalf is available only to people who may file attendance requests for others.'
  :'Approve On Behalf is available only to people who may decide attendance requests for others.');
 const page=await searchAttendanceOnBehalfSubjects(ctx,{purpose,query:'',page:0});
 return{ok:true,
  people:page.rows.map(row=>({name:row.name,company:row.company,department:row.department,position:row.position})),
  more:page.more,
  provenance:provenance('core/attendance-on-behalf.ts#searchAttendanceOnBehalfSubjects','Not applicable: who may be listed is permission and scope, not a versioned rule.',PAGES[purpose],NOTES[purpose])};
}
