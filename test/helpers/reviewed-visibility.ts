/** 5143/5144 replaced app.can_see_employment and app.visible_employment_ids with the request-bound final-decision window.
 * Earlier applied migrations (2141, 3001, 3102) pin the reviewed bodies they were written against, so a test that
 * replays their actual bytes installs those reviewed bodies first and the current 5143 bodies afterwards. */
import {readFileSync} from 'node:fs';
function definition(file:string,head:string){
 const sql=readFileSync(file,'utf8'),start=sql.indexOf(head);
 if(start<0)throw new Error(`${head} not found in ${file}`);
 const end=sql.indexOf('$$;',start);if(end<0)throw new Error(`unterminated ${head} in ${file}`);
 return sql.slice(start,end+3)+'\n';
}
const CAN_SEE='CREATE OR REPLACE FUNCTION app.can_see_employment(emp_id uuid)',VISIBLE='CREATE OR REPLACE FUNCTION app.visible_employment_ids()';
export const REVIEWED_VISIBILITY_PREDECESSOR=definition('db/migrations/0109_hierarchy_visibility_rls.sql',CAN_SEE)+definition('db/migrations/2105_authorization_navigation_plans.sql',VISIBLE);
export const CURRENT_VISIBILITY=definition('db/migrations/5144_attendance_lane_security_review.sql',CAN_SEE)+definition('db/migrations/5144_attendance_lane_security_review.sql',VISIBLE);
/** Replay `sql` against the reviewed predecessor bodies, then reinstall the current ones in the same statement batch. */
export const againstReviewedVisibility=(sql:string)=>REVIEWED_VISIBILITY_PREDECESSOR+sql+'\n'+CURRENT_VISIBILITY;
